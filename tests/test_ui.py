from __future__ import annotations

import io
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import TextIO, cast

from docatlas.__main__ import _chat_result_payload, _read_message, build_parser
from docatlas.agent.trace import AgentResult, ToolCallEvent, TurnEvent
from docatlas.ui.plain_renderer import PlainRenderer, safe_display_path


class _TTYBuffer(io.StringIO):
    def isatty(self) -> bool:
        return True


class _AsciiTTY:
    encoding = "ascii"

    def __init__(self) -> None:
        self._buffer = io.StringIO()

    def isatty(self) -> bool:
        return True

    def write(self, value: str) -> int:
        return self._buffer.write(value)

    def flush(self) -> None:
        return None

    def getvalue(self) -> str:
        return self._buffer.getvalue()


class _Session:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.session_id = "session-test"
        self.doc_env = SimpleNamespace(doc_id="sample", pdf_path="sample.pdf")

    def summary(self) -> str:
        return "session=session-test doc_id=sample notes=0 analyses=0 tree=loaded"

    def refresh_from_disk(self) -> None:
        return None


def _result(*, ok: bool = True) -> AgentResult:
    tool = ToolCallEvent(call_id="call-1", name="search", ok=ok)
    turn = TurnEvent(turn_num=1, tool_calls=[tool])
    return AgentResult(
        answer="Supported answer.",
        turns=[turn],
        total_input_tokens=1200,
        total_output_tokens=80,
        total_reasoning_tokens=20,
        total_elapsed_s=1.25,
    )


def test_tty_renderer_uses_visual_tree_and_redacts_arguments(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.delenv("NO_COLOR", raising=False)
    stderr = _TTYBuffer()
    stdout = _TTYBuffer()
    session = _Session(tmp_path / "outputs/sessions/session-test/session.json")
    renderer = PlainRenderer(
        session,
        skills=["search", "read"],
        stream=stderr,
        answer_stream=stdout,
    )

    renderer.print_session()
    renderer.on_turn_start(1)
    renderer.on_tool_call(
        "call-1",
        "search",
        {
            "query": "Find revenue\x1b[31m\u202e",
            "api_key": "must-not-appear",  # pragma: allowlist secret - redaction fixture
        },
    )
    renderer.on_tool_status("call-1", "search", True, "evidence", 0.25, 1)
    renderer.on_turn_end(SimpleNamespace(archived_count=0))
    assert renderer.print_answer("Supported answer.\x1b[31m") is True
    renderer.print_stats(_result())

    rendered = stderr.getvalue()
    assert "╭─" in rendered
    assert "├─" in rendered
    assert "✓ Completed · 0.2s · 1 image" in rendered.replace("\x1b[0m", "")
    assert "<redacted>" in rendered
    assert "must-not-appear" not in rendered
    assert "Find revenue\x1b[31m" not in rendered
    assert "\u202e" not in rendered
    assert str(tmp_path) not in rendered
    assert "\x1b[" in rendered
    assert "│  Supported answer." in stdout.getvalue()
    assert "Supported answer.\x1b[31m" not in stdout.getvalue()


def test_redirected_renderer_is_ascii_and_marks_failures(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    stream = io.StringIO()
    session = _Session(tmp_path / "outputs/sessions/session-test/session.json")
    renderer = PlainRenderer(session, stream=stream, answer_stream=io.StringIO())

    renderer.print_session()
    renderer.on_turn_start(1)
    renderer.on_tool_call("call-1", "read", {"pages": "2", "zoom": 1, "with_image": False})
    renderer.on_tool_status("call-1", "read", False, "[error] missing page", 0.1, 0)
    renderer.on_turn_end(SimpleNamespace(archived_count=0))
    renderer.print_stats(_result(ok=False))

    rendered = stream.getvalue()
    assert "+-- Turn 1" in rendered
    assert "ERROR Failed | 0.1s" in rendered
    assert "missing page" in rendered
    assert "1 failed" in rendered
    assert "zoom" not in rendered
    assert "1 tool" in rendered
    assert "1 tools" not in rendered
    assert "\x1b[" not in rendered


def test_reasoning_is_hidden_unless_explicitly_enabled(tmp_path) -> None:
    session = _Session(tmp_path / "session.json")
    hidden_stream = io.StringIO()
    PlainRenderer(session, stream=hidden_stream).on_reasoning("private summary")
    assert hidden_stream.getvalue() == ""

    visible_stream = io.StringIO()
    PlainRenderer(session, stream=visible_stream, show_reasoning=True).on_reasoning(
        "public summary"
    )
    assert "public summary" in visible_stream.getvalue()


def test_ascii_terminal_falls_back_without_unicode(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TERM", "xterm")
    stream = _AsciiTTY()
    renderer = PlainRenderer(
        _Session(tmp_path / "session.json"),
        stream=cast(TextIO, stream),
    )

    renderer.on_turn_start(1)
    renderer.on_turn_end(SimpleNamespace(archived_count=0))

    assert "+-- Turn 1" in stream.getvalue()


def test_abort_closes_an_open_turn(tmp_path) -> None:
    stream = io.StringIO()
    renderer = PlainRenderer(_Session(tmp_path / "session.json"), stream=stream)

    renderer.on_turn_start(1)
    renderer.abort()

    assert "ERROR Interrupted" in stream.getvalue()
    assert "`-- Turn 1 complete" in stream.getvalue()


def test_safe_display_path_never_exposes_external_prefix(tmp_path) -> None:
    outside = tmp_path / "private-user" / "session-id" / "session.json"
    displayed = safe_display_path(outside, base=tmp_path / "different-root")

    assert displayed == "session-id/session.json"
    assert "private-user" not in displayed


def test_json_payload_has_stable_execution_metadata(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    session = _Session(tmp_path / "outputs/sessions/session-test/session.json")

    payload = _chat_result_payload(_result(), session)

    assert payload["schema_version"] == "1"
    assert payload["answer"] == "Supported answer."
    assert payload["session"] == {
        "id": "session-test",
        "path": "outputs/sessions/session-test/session.json",
    }
    assert payload["execution"] == {
        "turns": 1,
        "tool_calls": 1,
        "failed_tool_calls": 0,
        "elapsed_seconds": 1.25,
    }
    assert payload["usage"]["input_tokens"] == 1200


def test_cli_branding_and_stdin_message(monkeypatch) -> None:
    parser = build_parser()
    assert parser.prog == "docatlas"
    args = parser.parse_args(["chat", "--verbose", "--format", "json"])
    assert args.verbose is True
    assert args.output_format == "json"

    monkeypatch.setattr(sys, "stdin", io.StringIO("Question from stdin\n"))
    assert _read_message(None) == "Question from stdin"
