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
from docatlas.remote_pdf import DownloadedPDF
from docatlas.skills._common.note_store import NoteStore
from docatlas.ui.app import (
    DocAtlasTUI,
    TUIConsole,
    TUIOptions,
    _at_path_completions,
    install_at_completion,
)
from docatlas.ui.path_picker import CtrlCInterrupt, EscapeInterrupt
from docatlas.workspace import DocumentWorkspace, PreprocessStage


def _pdf(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-tui-fixture")
    return path


def _console(*answers: str) -> tuple[TUIConsole, io.StringIO]:
    iterator = iter(answers)
    stream = io.StringIO()
    return TUIConsole(stream=stream, input_fn=lambda _: next(iterator)), stream


class _TTYStringIO(io.StringIO):
    def isatty(self) -> bool:
        return True


def test_console_starts_at_top_of_fresh_visible_viewport(monkeypatch) -> None:
    monkeypatch.setenv("TERM", "xterm-256color")
    output = _TTYStringIO()
    console = TUIConsole(stream=output)

    console.start_viewport()

    assert output.getvalue() == "\x1b[2J\x1b[H"


def test_chat_prompt_uses_uniform_ask_background(tmp_path: Path, monkeypatch) -> None:
    del tmp_path
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.setenv("DOCATLAS_THEME", "dark")
    monkeypatch.delenv("NO_COLOR", raising=False)
    master, slave = pty.openpty()
    input_stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = _TTYStringIO()
    console = TUIConsole(stream=output, input_stream=input_stream)
    DocAtlasTUI(TUIOptions(), console=console)
    monkeypatch.setattr(
        "docatlas.ui.path_picker._terminal_size",
        lambda stream: os.terminal_size((32, 10)),
    )
    values: list[str] = []
    errors: list[BaseException] = []

    def target() -> None:
        try:
            values.append(console.prompt("", use_history=True))
        except BaseException as exc:  # noqa: BLE001 - captured for PTY assertion
            errors.append(exc)

    thread = threading.Thread(target=target)
    thread.start()
    time.sleep(0.05)
    question = "a deliberately long user question for wrapping"
    os.write(master, question.encode() + b"\r")
    thread.join(timeout=2)
    input_stream.close()
    os.close(master)

    assert not thread.is_alive()
    assert errors == []
    assert values == [question]
    assert "\x1b[48;2;30;38;48m" in output.getvalue()
    assert "\x1b[0m\n\x1b[48;2;30;38;48m" in output.getvalue()
    assert output.getvalue().rfind("\x1b[0m") > output.getvalue().rfind("\x1b[48;2;30;38;48m")


def test_at_completion_lists_only_directories_and_pdfs(tmp_path: Path) -> None:
    _pdf(tmp_path / "report.pdf")
    (tmp_path / "ignore.txt").write_text("ignore")
    (tmp_path / "reports").mkdir()

    assert _at_path_completions("@rep", cwd=tmp_path) == ["@report.pdf", "@reports/"]


def test_console_wraps_errors_on_narrow_terminals(monkeypatch) -> None:
    console, output = _console()
    monkeypatch.setattr(
        "docatlas.ui.app.terminal_size",
        lambda stream: os.terminal_size((28, 10)),
    )

    console.error("Unknown command with a deliberately long explanatory message")

    lines = output.getvalue().splitlines()
    assert len(lines) > 1
    assert all(len(line) <= 27 for line in lines)
    assert all(line.startswith("|") for line in lines)

    output.seek(0)
    output.truncate(0)
    DocAtlasTUI(TUIOptions(), console=console)._command_hint()
    hint_lines = output.getvalue().splitlines()
    assert len(hint_lines) > 1
    assert all(len(line) <= 27 and line.startswith("  ") for line in hint_lines)


def test_readline_fallback_completes_commands(monkeypatch) -> None:
    class FakeReadline:
        completer = None
        line = "/ov"

        @classmethod
        def set_completer_delims(cls, value: str) -> None:
            assert value == " \t\n"

        @classmethod
        def set_completer(cls, value) -> None:
            cls.completer = value

        @classmethod
        def parse_and_bind(cls, value: str) -> None:
            assert value == "tab: complete"

        @classmethod
        def get_line_buffer(cls) -> str:
            return cls.line

        @classmethod
        def get_begidx(cls) -> int:
            return 0

    monkeypatch.setattr("docatlas.ui.app.readline", FakeReadline)

    install_at_completion()

    assert FakeReadline.completer is not None
    assert FakeReadline.completer("/ov", 0) == "/overview "
    assert FakeReadline.completer("/ov", 1) is None


def test_document_input_can_mix_at_paths_and_pdf_urls() -> None:
    console, _ = _console()
    app = DocAtlasTUI(TUIOptions(), console=console)

    assert app._paths_from_line("@local.pdf https://example.com/remote.pdf?signature=value") == [
        "local.pdf",
        "https://example.com/remote.pdf?signature=value",
    ]


def test_unknown_command_is_not_sent_to_agent_and_suggests_match(
    tmp_path: Path, monkeypatch
) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    console, output = _console("/ovrview", "/quit")
    app = DocAtlasTUI(TUIOptions(), console=console)
    runtime, renderer = _runtime_without_calls()
    monkeypatch.setattr(app, "_create_runtime", lambda workspace, config: (runtime, renderer))

    action, _, _ = app._chat(workspace, HarnessConfig())

    assert action == "quit"
    assert "Unknown command /ovrview; did you mean /overview?" in output.getvalue()


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


def test_initial_selector_downloads_remote_pdf_without_exposing_query(
    tmp_path: Path, monkeypatch
) -> None:
    document = _pdf(tmp_path / "annual-report.pdf")
    calls: list[tuple[Path, str]] = []

    class FakeDownloader:
        def __init__(self, cache_root: Path) -> None:
            self.cache_root = cache_root

        def download(self, url: str) -> DownloadedPDF:
            calls.append((self.cache_root, url))
            return DownloadedPDF(
                path=document,
                display_url="https://example.com/annual-report.pdf",
                size=document.stat().st_size,
                from_cache=False,
            )

    monkeypatch.setattr("docatlas.ui.app.RemotePDFDownloader", FakeDownloader)
    console, output = _console("https://example.com/annual-report.pdf?token=secret")
    app = DocAtlasTUI(
        TUIOptions(assume_yes=True, workspace_root=str(tmp_path / "workspaces")),
        console=console,
    )

    selected = app._select_documents()

    assert selected == [document.resolve()]
    assert calls == [
        (
            (tmp_path / "workspaces" / "_downloads").resolve(),
            "https://example.com/annual-report.pdf?token=secret",
        )
    ]
    assert "annual-report.pdf" in output.getvalue()
    assert "token=secret" not in output.getvalue()


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
        with pytest.raises(EscapeInterrupt):
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
    console, output = _console("first question", "follow-up question", "/quit")
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
    assert "Ask #" not in output.getvalue()


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
    assert renderer.aborted == ["Request interrupted"]


def _runtime_without_calls() -> tuple[SimpleNamespace, SimpleNamespace]:
    notes = NoteStore(question="What changed?")
    notes.add_analysis(
        found="Revenue increased on Page 2.",
        evidence=[{"type": "text", "source": "Page 2", "content": "Revenue increased."}],
    )

    class FakeSession:
        session_id = "session-test"
        created_at = "2026-08-29T00:00:00+00:00"
        tree = []
        workspace = {
            "conversation": [
                {"role": "user", "text": "What changed?"},
                {"role": "assistant", "text": "Revenue increased."},
            ]
        }

        def __init__(self) -> None:
            self.notes = notes

        def refresh_from_disk(self) -> None:
            return None

        def save(self) -> None:
            return None

    class NoCallLoop:
        def run(self, message: str, *, continue_conversation: bool = False) -> AgentResult:
            raise AssertionError("overview must not enter the agent loop")

    class FakeRenderer:
        def abort(self, message: str = "Interrupted") -> None:
            return None

    return SimpleNamespace(session=FakeSession(), loop=NoCallLoop()), FakeRenderer()


def test_overview_is_a_local_tui_command_and_can_export(tmp_path: Path, monkeypatch) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    console, output = _console("/overview", "/overview export", "/quit")
    app = DocAtlasTUI(TUIOptions(), console=console)
    runtime, renderer = _runtime_without_calls()
    monkeypatch.setattr(app, "_create_runtime", lambda workspace, config: (runtime, renderer))

    action, replacement, force = app._chat(workspace, HarnessConfig())

    assert (action, replacement, force) == ("quit", None, False)
    assert "DocAtlas / Overview" in output.getvalue()
    assert "Overview exported" in output.getvalue()
    assert (workspace.root / "overview.md").is_file()


def test_two_consecutive_ctrl_c_interrupts_exit_chat(tmp_path: Path, monkeypatch) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    values = iter([CtrlCInterrupt(), CtrlCInterrupt()])
    output = io.StringIO()

    def input_fn(prompt: str) -> str:
        del prompt
        value = next(values)
        raise value

    console = TUIConsole(stream=output, input_fn=input_fn)
    app = DocAtlasTUI(TUIOptions(), console=console)
    runtime, renderer = _runtime_without_calls()
    monkeypatch.setattr(app, "_create_runtime", lambda workspace, config: (runtime, renderer))

    action, replacement, force = app._chat(workspace, HarnessConfig())

    assert (action, replacement, force) == ("quit", None, False)
    assert "press Ctrl+C again within 2s" in output.getvalue()
    assert "Exiting DocAtlas" in output.getvalue()


def test_double_ctrl_c_exit_window_expires(monkeypatch) -> None:
    console, output = _console()
    app = DocAtlasTUI(TUIOptions(), console=console)
    timestamps = iter([10.0, 12.1, 13.0])
    monkeypatch.setattr("docatlas.ui.app.time.monotonic", lambda: next(timestamps))

    assert app._ctrl_c_requests_exit("Cancelled") is False
    assert app._ctrl_c_requests_exit("Cancelled") is False
    assert app._ctrl_c_requests_exit("Cancelled") is True
    assert output.getvalue().count("press Ctrl+C again within 2s") == 2


def test_escape_does_not_arm_double_ctrl_c_exit(tmp_path: Path, monkeypatch) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    values = iter([EscapeInterrupt(), CtrlCInterrupt(), "/quit"])
    output = io.StringIO()

    def input_fn(prompt: str) -> str:
        del prompt
        value = next(values)
        if isinstance(value, BaseException):
            raise value
        return value

    console = TUIConsole(stream=output, input_fn=input_fn)
    app = DocAtlasTUI(TUIOptions(), console=console)
    runtime, renderer = _runtime_without_calls()
    monkeypatch.setattr(app, "_create_runtime", lambda workspace, config: (runtime, renderer))

    action, replacement, force = app._chat(workspace, HarnessConfig())

    assert (action, replacement, force) == ("quit", None, False)
    assert output.getvalue().count("press Ctrl+C again within 2s") == 1
    assert "Exiting DocAtlas" not in output.getvalue()
