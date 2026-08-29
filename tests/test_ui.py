from __future__ import annotations

import io
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import TextIO, cast

from docatlas.__main__ import _chat_result_payload, _read_message, build_parser, cmd_tui
from docatlas.agent.trace import AgentResult, ToolCallEvent, TurnEvent
from docatlas.ui.plain_renderer import PlainRenderer, safe_display_path, sanitize_terminal_text
from docatlas.ui.terminal import display_width


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
    assert "Working" in rendered
    assert "Search" in rendered
    assert "Find revenue" in rendered
    assert "0.2s" in rendered
    assert "1 image" in rendered
    assert "Turn 1" not in rendered
    assert "must-not-appear" not in rendered
    assert "Find revenue\x1b[31m" not in rendered
    assert "\u202e" not in rendered
    assert str(tmp_path) not in rendered
    assert "\x1b[" in rendered
    assert "\x1b[48;2;17;23;30m" in rendered
    assert "\x1b[48;2;17;23;30m" in stdout.getvalue()
    assert "│  Supported answer." in sanitize_terminal_text(stdout.getvalue(), multiline=True)
    assert "Supported answer.\x1b[31m" not in stdout.getvalue()


def test_colored_cards_fill_wide_terminal_but_keep_readable_content_width(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setattr(
        "docatlas.ui.plain_renderer.terminal_size",
        lambda stream: os.terminal_size((180, 40)),
    )
    stream = _TTYBuffer()
    renderer = PlainRenderer(_Session(tmp_path / "session.json"), stream=stream)

    card = renderer._card_text("Working", renderer.theme.working_background)
    plain = sanitize_terminal_text(card, multiline=True)

    assert display_width(plain) == 179
    assert renderer._width() == 120
    assert renderer._canvas_width() == 179


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
    assert "[working]" in rendered
    assert "[tool 1] read | p.2 | failed | 0.1s" in rendered
    assert "missing page" in rendered
    assert "1 failed" in rendered
    assert "zoom" not in rendered
    assert "Turn 1" not in rendered
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
    renderer.on_tool_call("read-1", "read", {"pages": "1"})
    renderer.on_tool_status("read-1", "read", True, "ok", 0.1, 0)
    renderer.on_turn_end(
        TurnEvent(
            turn_num=1,
            tool_calls=[ToolCallEvent(call_id="read-1", name="read")],
        )
    )

    assert "+-- Working" in stream.getvalue()
    assert "Turn 1" not in stream.getvalue()


def test_direct_answer_erases_transient_thinking_without_empty_working_card(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("TERM", "xterm-256color")
    stream = _TTYBuffer()
    answer_stream = _TTYBuffer()
    renderer = PlainRenderer(
        _Session(tmp_path / "session.json"),
        stream=stream,
        answer_stream=answer_stream,
    )

    renderer.on_turn_start(1)
    renderer.on_turn_end(TurnEvent(turn_num=1, text_output="direct answer"))
    assert renderer.print_answer("direct answer") is True
    renderer.print_stats(
        AgentResult(
            answer="direct answer",
            turns=[TurnEvent(turn_num=1, text_output="direct answer")],
            total_elapsed_s=0.5,
        )
    )

    plain = sanitize_terminal_text(stream.getvalue(), multiline=True)
    assert "Working" not in plain
    assert "model turn" not in plain
    assert "0.5s" in plain


def test_no_color_keeps_structure_without_background_sequences(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.setenv("NO_COLOR", "1")
    stderr = _TTYBuffer()
    stdout = _TTYBuffer()
    renderer = PlainRenderer(
        _Session(tmp_path / "session.json"), stream=stderr, answer_stream=stdout
    )

    renderer.on_turn_start(1)
    renderer.on_tool_call("read-1", "read", {"pages": "6"})
    renderer.on_tool_status("read-1", "read", True, "ok", 0.2, 0)
    renderer.on_turn_end(SimpleNamespace(archived_count=0))
    renderer.print_answer("Answer")
    renderer.print_stats(_result())

    rendered = stderr.getvalue() + stdout.getvalue()
    assert "Working" in rendered
    assert "Answer" in rendered
    assert "\x1b[48;" not in rendered
    assert "\x1b[38;" not in rendered


def test_abort_closes_an_open_turn(tmp_path) -> None:
    stream = io.StringIO()
    renderer = PlainRenderer(_Session(tmp_path / "session.json"), stream=stream)

    renderer.on_turn_start(1)
    renderer.abort()

    assert "[aborted] Interrupted" in stream.getvalue()


def test_multiple_model_turns_share_one_working_card(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.delenv("NO_COLOR", raising=False)
    stream = _TTYBuffer()
    renderer = PlainRenderer(_Session(tmp_path / "session.json"), stream=stream)

    renderer.on_turn_start(1)
    renderer.on_tool_call("search-1", "search", {"query": "Find revenue changes"})
    renderer.on_tool_status("search-1", "search", True, "ok", 0.4, 0)
    renderer.on_turn_end(
        TurnEvent(
            turn_num=1,
            tool_calls=[ToolCallEvent(call_id="search-1", name="search")],
        )
    )
    renderer.on_turn_start(2)
    renderer.on_tool_call("read-1", "read", {"pages": "4-6"})
    renderer.on_tool_status("read-1", "read", True, "ok", 0.2, 0)
    renderer.on_turn_end(
        TurnEvent(
            turn_num=2,
            tool_calls=[ToolCallEvent(call_id="read-1", name="read")],
        )
    )
    renderer.on_turn_start(3)
    renderer.on_turn_end(TurnEvent(turn_num=3, text_output="answer"))

    plain = sanitize_terminal_text(stream.getvalue(), multiline=True)
    assert plain.count("Working") == 1
    assert "Search" in plain
    assert "Read" in plain
    assert "3 model turns · 2 tools" in plain
    assert "Turn 1" not in plain


def test_safe_display_path_never_exposes_external_prefix(tmp_path) -> None:
    outside = tmp_path / "private-user" / "session-id" / "session.json"
    displayed = safe_display_path(outside, base=tmp_path / "different-root")

    assert displayed == "session-id/session.json"
    assert "private-user" not in displayed


def test_session_header_lists_all_documents(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TERM", "xterm-256color")
    stream = _TTYBuffer()
    session = _Session(tmp_path / "session.json")
    session.doc_env.doc_map = {"report_2024": {}, "report_2025": {}}
    renderer = PlainRenderer(session, stream=stream)

    renderer.print_session()

    assert "documents 2 · report_2024, report_2025" in stream.getvalue()


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
    assert parser.parse_args([]).func is cmd_tui
    tui_args = parser.parse_args(
        ["tui", "@report.pdf", "--recursive", "--yes", "--max-documents", "250"]
    )
    assert tui_args.paths == ["@report.pdf"]
    assert tui_args.recursive is True
    assert tui_args.assume_yes is True
    assert tui_args.max_documents == 250
    args = parser.parse_args(["chat", "--verbose", "--format", "json"])
    assert args.verbose is True
    assert args.output_format == "json"

    monkeypatch.setattr(sys, "stdin", io.StringIO("Question from stdin\n"))
    assert _read_message(None) == "Question from stdin"
