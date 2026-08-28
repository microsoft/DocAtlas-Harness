from __future__ import annotations

import io
import os
import pty
import sys
import termios
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from docatlas.agent.trace import AgentResult
from docatlas.config import HarnessConfig
from docatlas.ui.app import DocAtlasTUI, TUIConsole, TUIOptions, _at_path_completions
from docatlas.workspace import DocumentWorkspace, PreprocessStage


def _pdf(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-tui-fixture")
    return path


def _console(*answers: str) -> tuple[TUIConsole, io.StringIO]:
    iterator = iter(answers)
    stream = io.StringIO()
    return TUIConsole(stream=stream, input_fn=lambda _: next(iterator)), stream


def test_at_completion_lists_only_directories_and_pdfs(tmp_path: Path) -> None:
    _pdf(tmp_path / "report.pdf")
    (tmp_path / "ignore.txt").write_text("ignore")
    (tmp_path / "reports").mkdir()

    assert _at_path_completions("@rep", cwd=tmp_path) == ["@report.pdf", "@reports/"]


def test_tui_rejects_noninteractive_streams() -> None:
    console, _ = _console()
    app = DocAtlasTUI(TUIOptions(), console=console)

    with pytest.raises(RuntimeError, match="requires a terminal"):
        app.run()


def test_initial_selector_accepts_at_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    document = _pdf(tmp_path / "report.pdf")
    console, _ = _console("@report.pdf")
    app = DocAtlasTUI(TUIOptions(assume_yes=True), console=console)

    selected = app._select_documents()

    assert selected == [document.resolve()]


def test_selector_accepts_multiple_pdf_mode(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    first = _pdf(tmp_path / "one.pdf")
    second = _pdf(tmp_path / "two.pdf")
    console, _ = _console("2", "@one.pdf", "@two.pdf", "")
    app = DocAtlasTUI(TUIOptions(assume_yes=True), console=console)

    selected = app._select_documents()

    assert selected == [first.resolve(), second.resolve()]


def test_selector_accepts_recursive_folder_mode(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    first = _pdf(tmp_path / "reports" / "one.pdf")
    second = _pdf(tmp_path / "reports" / "archive" / "two.pdf")
    console, _ = _console("3", "@reports", "y")
    app = DocAtlasTUI(TUIOptions(assume_yes=True), console=console)

    selected = app._select_documents()

    assert selected == [second.resolve(), first.resolve()]


def test_assume_yes_does_not_override_recursive_choice() -> None:
    console, _ = _console("n")
    app = DocAtlasTUI(TUIOptions(assume_yes=True), console=console)

    assert app._confirm("Include subfolders?", default=False) is False
    assert app._confirm("Use documents?", accept_assume_yes=True) is True


def test_preprocess_stage_reports_success_and_sanitizes_failure() -> None:
    console, stream = _console()
    success = PreprocessStage(
        title="Safe stage",
        argv=(sys.executable, "-c", "print('done')"),
    )
    console.run_stage(success)
    assert "Completed" in stream.getvalue()

    failure = PreprocessStage(
        title="Failed stage",
        argv=(sys.executable, "-c", "print('bad\\x1b[31m'); raise SystemExit(3)"),
    )
    with pytest.raises(RuntimeError, match="preprocessing failed"):
        console.run_stage(failure)
    assert "bad\x1b[31m" not in stream.getvalue()


def test_preprocess_stage_escape_interrupts_child_and_restores_terminal() -> None:
    master, slave = pty.openpty()
    input_stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = io.StringIO()
    console = TUIConsole(stream=output, input_stream=input_stream)
    stage = PreprocessStage(
        title="Slow stage",
        argv=(sys.executable, "-c", "import time; time.sleep(30)"),
    )
    before = termios.tcgetattr(input_stream.fileno())

    def interrupt() -> None:
        time.sleep(0.15)
        os.write(master, b"\x1b")

    sender = threading.Thread(target=interrupt)
    sender.start()
    started = time.monotonic()
    try:
        with pytest.raises(KeyboardInterrupt):
            console.run_stage(stage)
        after = termios.tcgetattr(input_stream.fileno())
    finally:
        sender.join(timeout=1)
        input_stream.close()
        os.close(master)

    assert time.monotonic() - started < 5
    assert after == before
    assert "Interrupted" in output.getvalue()


def test_chat_loop_reuses_agent_conversation(tmp_path: Path, monkeypatch) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    console, _ = _console("first question", "follow-up question", "/quit")
    app = DocAtlasTUI(TUIOptions(), console=console)

    class FakeSession:
        def __init__(self) -> None:
            self.notes = SimpleNamespace(question="")
            self.workspace: dict = {}

        def refresh_from_disk(self) -> None:
            return None

        def save(self) -> None:
            return None

    class FakeLoop:
        def __init__(self) -> None:
            self.calls: list[tuple[str, bool]] = []

        def run(self, message: str, *, continue_conversation: bool = False) -> AgentResult:
            self.calls.append((message, continue_conversation))
            return AgentResult(answer=f"answer {len(self.calls)}")

    class FakeRenderer:
        def print_answer(self, answer: str) -> bool:
            return True

        def print_stats(self, result: AgentResult) -> None:
            return None

        def abort(self) -> None:
            return None

    session = FakeSession()
    loop = FakeLoop()
    runtime = SimpleNamespace(session=session, loop=loop)
    monkeypatch.setattr(app, "_create_runtime", lambda workspace, config: (runtime, FakeRenderer()))

    action, replacement, force = app._chat(workspace, HarnessConfig())

    assert (action, replacement, force) == ("quit", None, False)
    assert loop.calls == [("first question", True), ("follow-up question", True)]
    assert session.workspace["conversation"] == [
        {"role": "user", "text": "first question"},
        {"role": "assistant", "text": "answer 1"},
        {"role": "user", "text": "follow-up question"},
        {"role": "assistant", "text": "answer 2"},
    ]


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("/add @two.pdf", ["one.pdf", "two.pdf"]),
        ("@two.pdf", ["one.pdf", "two.pdf"]),
        ("/new @two.pdf", ["two.pdf"]),
    ],
)
def test_chat_document_commands_replace_runtime(
    tmp_path: Path,
    monkeypatch,
    command: str,
    expected: list[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    first = _pdf(tmp_path / "one.pdf")
    _pdf(tmp_path / "two.pdf")
    workspace = DocumentWorkspace.create([first], workspace_root=tmp_path / "workspaces")
    console, _ = _console(command)
    app = DocAtlasTUI(TUIOptions(), console=console)
    monkeypatch.setattr(
        app,
        "_create_runtime",
        lambda workspace, config: (SimpleNamespace(), SimpleNamespace()),
    )

    action, replacement, force = app._chat(workspace, HarnessConfig())

    assert action == "replace"
    assert replacement is not None
    assert [path.name for path in replacement] == expected
    assert force is False


def test_interrupted_turn_returns_to_question_prompt(tmp_path: Path, monkeypatch) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    console, _ = _console("question to cancel", "/quit")
    app = DocAtlasTUI(TUIOptions(), console=console)

    class FakeSession:
        def __init__(self) -> None:
            self.notes = SimpleNamespace(question="")
            self.workspace: dict = {}

        def refresh_from_disk(self) -> None:
            return None

        def save(self) -> None:
            return None

    class InterruptedLoop:
        def run(self, message: str, *, continue_conversation: bool = False) -> AgentResult:
            raise KeyboardInterrupt

    class TrackingRenderer:
        def __init__(self) -> None:
            self.aborted: list[str] = []

        def abort(self, message: str = "Interrupted") -> None:
            self.aborted.append(message)

    renderer = TrackingRenderer()
    runtime = SimpleNamespace(session=FakeSession(), loop=InterruptedLoop())
    monkeypatch.setattr(app, "_create_runtime", lambda workspace, config: (runtime, renderer))

    action, replacement, force = app._chat(workspace, HarnessConfig())

    assert (action, replacement, force) == ("quit", None, False)
    assert renderer.aborted == ["Turn interrupted"]
