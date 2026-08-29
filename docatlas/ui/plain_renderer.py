"""Dependency-free, pipe-safe terminal renderer for DocAtlas.

Interactive terminals receive a compact Codex-style line hierarchy with
colour, tool status, and run statistics. Redirected stderr stays ASCII-only,
and the final answer remains on stdout so shell pipelines are stable.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from .callbacks import LoopCallbacks
from .terminal import display_width, terminal_size, terminal_theme, truncate_display, wrap_display

logger = logging.getLogger(__name__)
_ANSI_ESCAPE_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
_SENSITIVE_ARG_RE = re.compile(
    r"(?:api[_-]?key|authorization|credential|password|secret|token)", re.IGNORECASE
)


def _sanitize_text(value: Any, *, multiline: bool = False) -> str:
    """Remove terminal control sequences from model- and Skill-owned text."""
    text = _ANSI_ESCAPE_RE.sub("", str(value)).replace("\r", "")
    text = "".join(
        char
        for char in text
        if (
            (multiline and char in {"\n", "\t"})
            or (ord(char) >= 32 and not 127 <= ord(char) <= 159)
        )
        and unicodedata.category(char) != "Cf"
    )
    if multiline:
        return text
    return " ".join(text.split())


sanitize_terminal_text = _sanitize_text


def _format_value(key: str, value: Any, *, limit: int = 72) -> str:
    if _SENSITIVE_ARG_RE.search(key):
        return "<redacted>"
    if isinstance(value, str):
        rendered = value
    elif (
        isinstance(value, list)
        and value
        and all(
            isinstance(item, (str, int, float)) and not isinstance(item, bool) for item in value
        )
    ):
        rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    elif isinstance(value, (list, dict)):
        count = len(value)
        rendered = f"{count} item{'s' if count != 1 else ''}"
    else:
        rendered = str(value)
    rendered = _sanitize_text(rendered)
    if len(rendered) > limit:
        rendered = rendered[: limit - 3].rstrip() + "..."
    return rendered


def _format_args(args: dict[str, Any]) -> str:
    """Backward-compatible compact representation used by external callers."""
    return ", ".join(f"{key}={_format_value(key, value)!r}" for key, value in args.items())


def safe_display_path(path: str | Path, *, base: str | Path | None = None) -> str:
    """Return a useful path without exposing a machine-specific home prefix."""
    resolved = Path(path).expanduser().resolve()
    root = Path(base).expanduser().resolve() if base is not None else Path.cwd().resolve()
    try:
        return str(resolved.relative_to(root))
    except ValueError:
        return str(Path(resolved.parent.name) / resolved.name)


def _supports_unicode(stream: TextIO) -> bool:
    encoding = getattr(stream, "encoding", None) or "utf-8"
    try:
        "╭─✓".encode(encoding)
    except (LookupError, UnicodeEncodeError):
        return False
    return True


@dataclass
class _ToolDisplay:
    index: int
    name: str
    args: dict[str, Any]
    completed: bool = False


class PlainRenderer:
    """Render one compact execution card per user request."""

    _RESET = "\x1b[0m"
    _BOLD = "\x1b[1m"
    _DIM = "\x1b[2m"
    _CYAN = "\x1b[36m"
    _GREEN = "\x1b[32m"
    _RED = "\x1b[31m"
    _YELLOW = "\x1b[33m"

    def __init__(
        self,
        session: Any,
        *,
        skills: list[str] | tuple[str, ...] = (),
        show_reasoning: bool = False,
        stream: TextIO | None = None,
        answer_stream: TextIO | None = None,
    ) -> None:
        self.session = session
        self.skills = list(skills)
        self.show_reasoning = show_reasoning
        self.stream = stream or sys.stderr
        self.answer_stream = answer_stream or sys.stdout
        self.is_tty = bool(getattr(self.stream, "isatty", lambda: False)())
        self.answer_is_tty = bool(getattr(self.answer_stream, "isatty", lambda: False)())
        self.use_unicode = (
            self.is_tty and os.getenv("TERM", "") != "dumb" and _supports_unicode(self.stream)
        )
        self.use_color = (
            self.is_tty and os.getenv("TERM", "") != "dumb" and "NO_COLOR" not in os.environ
        )
        self.theme = terminal_theme(use_color=self.use_color)
        self._answer_open = False
        self._run_active = False
        self._working_open = False
        self._working_seen = False
        self._live_line = False
        self._run_started = 0.0
        self._turn_count = 0
        self._tool_sequence = 0
        self._tool_count = 0
        self._failed_tool_count = 0
        self._archived_count = 0
        self._tools: dict[str, _ToolDisplay] = {}
        self._active_call_id: str | None = None

        if self.use_unicode:
            self.top, self.branch, self.pipe, self.bottom = "╭─", "├─", "│", "╰─"
            self.ok, self.fail, self.wait, self.dot = "✓", "✗", "◌", "·"
        else:
            self.top, self.branch, self.pipe, self.bottom = "+--", "+--", "|", "`--"
            self.ok, self.fail, self.wait, self.dot = "OK", "ERROR", "...", "|"

    def _style(self, text: str, *codes: str) -> str:
        if not self.use_color:
            return text
        return "".join(codes) + text + self._RESET

    def _write(self, text: str) -> None:
        self.stream.write(text)
        self.stream.flush()

    def _width(self, stream: TextIO | None = None) -> int:
        columns = terminal_size(stream or self.stream).columns
        return max(8, min(120, max(2, columns) - 1))

    def _background_base(self, background: str) -> str:
        return background + self.theme.primary if self.use_color else ""

    def _tone(
        self,
        text: str,
        colour: str,
        background: str,
        *,
        bold: bool = False,
    ) -> str:
        if not self.use_color:
            return text
        prefix = colour + (self.theme.bold if bold else "")
        return prefix + text + "\x1b[22m" + self._background_base(background)

    def _card_text(self, content: str, background: str, *, stream: TextIO | None = None) -> str:
        width = self._width(stream)
        plain = _ANSI_ESCAPE_RE.sub("", content)
        if display_width(plain) > width:
            content = truncate_display(plain, width)
            plain = content
        padding = max(0, width - display_width(plain)) if self.use_color else 0
        return (
            self._background_base(background)
            + content
            + (" " * padding)
            + (self.theme.reset if self.use_color else "")
        )

    def _write_card(
        self,
        content: str,
        background: str,
        *,
        stream: TextIO | None = None,
        newline: bool = True,
    ) -> None:
        target = stream or self.stream
        target.write(self._card_text(content, background, stream=target))
        if newline:
            target.write("\n")
        target.flush()

    def _write_live(self, content: str, background: str = "") -> None:
        self.stream.write("\r\x1b[2K")
        if background:
            self.stream.write(self._card_text(content, background))
        else:
            self.stream.write(content)
        self.stream.flush()
        self._live_line = True

    def _finish_live(self, content: str, background: str) -> None:
        self.stream.write("\r\x1b[2K")
        self.stream.write(self._card_text(content, background) + "\n")
        self.stream.flush()
        self._live_line = False

    def _clear_live(self) -> None:
        if not self._live_line:
            return
        self.stream.write("\r\x1b[2K")
        self.stream.flush()
        self._live_line = False

    def _reset_run(self) -> None:
        self._run_active = True
        self._working_open = False
        self._working_seen = False
        self._run_started = time.monotonic()
        self._turn_count = 0
        self._tool_sequence = 0
        self._tool_count = 0
        self._failed_tool_count = 0
        self._archived_count = 0
        self._tools = {}
        self._active_call_id = None

    def _working_header(self) -> str:
        background = self.theme.working_background
        return (
            self._tone(self.top, self.theme.accent, background)
            + " "
            + self._tone("Working", self.theme.accent, background, bold=True)
        )

    def _ensure_working(self) -> None:
        if self._working_open:
            return
        self._clear_live()
        self._write_card(self._working_header(), self.theme.working_background)
        self._working_open = True
        self._working_seen = True

    def _thinking_line(self) -> str:
        if self._working_open:
            background = self.theme.working_background
            return (
                self._tone(self.pipe, self.theme.accent, background)
                + "  "
                + self._tone(self.wait, self.theme.warning, background)
                + " "
                + self._tone("Thinking…", self.theme.muted, background)
            )
        if not self.use_color:
            return f"  {self.wait} Thinking..."
        return (
            "  "
            + self.theme.warning
            + self.wait
            + " "
            + self.theme.muted
            + "Thinking…"
            + self.theme.reset
        )

    def _compact_tool_detail(self, name: str, args: dict[str, Any]) -> str:
        normalized = name.casefold()
        if normalized in {"search", "review"}:
            query = _format_value("query", args.get("query", ""), limit=180)
            doc_id = _format_value("doc_id", args.get("doc_id", ""), limit=48)
            parts = [f"“{query}”"] if query else []
            if doc_id:
                parts.insert(0, doc_id)
            return f" {self.dot} ".join(parts)
        if normalized == "read":
            parts = []
            doc_id = _format_value("doc_id", args.get("doc_id", ""), limit=48)
            pages = _format_value("pages", args.get("pages", ""), limit=80)
            if doc_id:
                parts.append(doc_id)
            if pages:
                parts.append(f"p.{pages}")
            if args.get("with_image"):
                parts.append("page image")
            figures = args.get("figures")
            if isinstance(figures, list) and figures:
                parts.append(f"{len(figures)} figure{'s' if len(figures) != 1 else ''}")
            return f" {self.dot} ".join(parts)
        if normalized == "note":
            raw_evidence = args.get("evidence")
            evidence = raw_evidence if isinstance(raw_evidence, list) else []
            evidence_count = len(evidence)
            parts = []
            if evidence_count and isinstance(evidence[0], dict):
                source = _format_value("source", evidence[0].get("source", ""), limit=36)
                if source:
                    parts.append(source)
            if args.get("found"):
                parts.append("1 finding")
            if evidence_count:
                parts.append(
                    f"{evidence_count} evidence entr{'ies' if evidence_count != 1 else 'y'}"
                )
            if not parts and args.get("plan"):
                parts.append("next step")
            return f" {self.dot} ".join(parts)

        parts = []
        for key, value in args.items():
            if value is None or value is False or value == "" or value == [] or value == {}:
                continue
            parts.append(f"{_sanitize_text(key)}={_format_value(key, value, limit=48)}")
            if len(parts) == 2:
                break
        return f" {self.dot} ".join(parts)

    def _tool_line(
        self,
        tool: _ToolDisplay,
        *,
        ok: bool | None,
        elapsed: float = 0.0,
        img_count: int = 0,
        interrupted: bool = False,
    ) -> str:
        background = self.theme.working_background
        label = _sanitize_text(tool.name.replace("_", " ").title())
        detail = self._compact_tool_detail(tool.name, tool.args)
        if ok is None:
            symbol, symbol_colour, right = self.wait, self.theme.warning, "running"
            right_colour = self.theme.warning
        elif ok:
            symbol, symbol_colour, right = self.ok, self.theme.success, f"{elapsed:.1f}s"
            right_colour = self.theme.muted
        else:
            symbol, symbol_colour = self.fail, self.theme.danger
            right = "interrupted" if interrupted else f"failed {self.dot} {elapsed:.1f}s"
            right_colour = self.theme.danger
        if img_count:
            right += f" {self.dot} {img_count} image{'s' if img_count != 1 else ''}"

        label_padding = " " * max(1, 8 - display_width(label))
        prefix_plain = f"{self.pipe}  {tool.index:>2}  {symbol} {label}{label_padding}"
        width = self._width()
        detail_width = max(
            0,
            width - display_width(prefix_plain) - display_width(right) - 2,
        )
        detail = truncate_display(detail, detail_width) if detail_width else ""
        used_width = display_width(prefix_plain) + display_width(detail) + display_width(right)
        gap = " " * max(2, width - used_width)
        return (
            self._tone(self.pipe, self.theme.accent, background)
            + f"  {tool.index:>2}  "
            + self._tone(symbol, symbol_colour, background)
            + " "
            + self._tone(label, self.theme.primary, background, bold=True)
            + label_padding
            + self._tone(detail, self.theme.muted, background)
            + gap
            + self._tone(right, right_colour, background)
        )

    def _error_line(self, text: str) -> str:
        background = self.theme.working_background
        prefix = f"{self.pipe}      {self.fail} "
        message = truncate_display(text, max(1, self._width() - display_width(prefix)))
        return (
            self._tone(self.pipe, self.theme.accent, background)
            + "      "
            + self._tone(self.fail, self.theme.danger, background)
            + " "
            + self._tone(message, self.theme.danger, background)
        )

    def _close_working(self, *, reason: str = "") -> None:
        self._clear_live()
        if not self._working_open:
            self._run_active = False
            return
        elapsed = max(0.0, time.monotonic() - self._run_started)
        turn_label = "turn" if self._turn_count == 1 else "turns"
        tool_label = "tool" if self._tool_count == 1 else "tools"
        parts = [
            f"{self._turn_count} model {turn_label}",
            f"{self._tool_count} {tool_label}",
            f"{elapsed:.1f}s",
        ]
        if self._failed_tool_count:
            parts.append(f"{self._failed_tool_count} failed")
        if self._archived_count:
            parts.append(f"{self._archived_count} archived")
        if reason:
            parts.append(reason)
        background = self.theme.working_background
        footer = (
            self._tone(self.bottom, self.theme.accent, background)
            + " "
            + self._tone(f" {self.dot} ".join(parts), self.theme.muted, background)
        )
        self._write_card(footer, background)
        self._working_open = False
        self._run_active = False
        self._active_call_id = None

    def as_callbacks(self) -> LoopCallbacks:
        return LoopCallbacks(
            on_turn_start=self.on_turn_start,
            on_tool_call=self.on_tool_call,
            on_tool_status=self.on_tool_status,
            on_turn_end=self.on_turn_end,
            on_reasoning=self.on_reasoning,
        )

    def print_session(self) -> None:
        path = _sanitize_text(safe_display_path(self.session.path))
        if not self.is_tty:
            self._write(f"[session] {_sanitize_text(self.session.summary())} -> {path}\n")
            return

        def session_row(label: str, value: str) -> None:
            prefix = f"{self.pipe}  {label:<10}"
            available = max(1, self._width() - display_width(prefix))
            self._write(prefix + truncate_display(_sanitize_text(value), available) + "\n")

        self._write(
            f"\n{self._style(self.top, self._CYAN)} {self._style('DocAtlas', self._BOLD)}\n"
        )
        session_row("session", str(self.session.session_id))
        if getattr(self.session, "doc_env", None) is not None:
            doc_id = getattr(self.session.doc_env, "doc_id", None)
            pdf_path = getattr(self.session.doc_env, "pdf_path", None)
            doc_map = getattr(self.session.doc_env, "doc_map", None)
            if isinstance(doc_map, dict) and len(doc_map) > 1:
                names = ", ".join(str(name) for name in doc_map)
                session_row("documents", f"{len(doc_map)} {self.dot} {names}")
            else:
                document = doc_id or (Path(pdf_path).name if pdf_path else None)
                if document:
                    session_row("document", str(document))
        if self.skills:
            skill_names = " ".join(_sanitize_text(skill) for skill in self.skills)
            session_row("skills", skill_names)
        session_row("state", path)
        self._write(f"{self._style(self.bottom, self._CYAN)} {self._style('Ready', self._GREEN)}\n")

    def on_turn_start(self, turn_num: int) -> None:
        del turn_num
        if not self._run_active:
            self._reset_run()
            if not self.is_tty:
                self._write("[working]\n")
        self._turn_count += 1
        if self.is_tty:
            self._write_live(
                self._thinking_line(),
                self.theme.working_background if self._working_open else "",
            )

    def on_reasoning(self, summary: str) -> None:
        if not self.show_reasoning:
            return
        safe_summary = _sanitize_text(summary, multiline=True)
        if not self.is_tty:
            for row in wrap_display(safe_summary, 88)[:10]:
                self._write(f"[reasoning] {row}\n")
            return
        self._ensure_working()
        background = self.theme.working_background
        label = (
            self._tone(self.pipe, self.theme.accent, background)
            + "  "
            + self._tone("Reasoning", self.theme.primary, background, bold=True)
        )
        self._write_card(label, background)
        rows = wrap_display(safe_summary, max(1, self._width() - 4))
        for row in rows[:4]:
            self._write_card(
                self._tone(self.pipe, self.theme.accent, background)
                + "    "
                + self._tone(row, self.theme.muted, background),
                background,
            )
        if len(rows) > 4:
            self._write_card(
                self._tone(self.pipe, self.theme.accent, background)
                + "    "
                + self._tone("…", self.theme.muted, background),
                background,
            )

    def on_tool_call(self, call_id: str, name: str, args: dict) -> None:
        if not self._run_active:
            self._reset_run()
        tool = self._tools.get(call_id)
        if tool is None:
            self._tool_sequence += 1
            tool = _ToolDisplay(self._tool_sequence, name, dict(args))
            self._tools[call_id] = tool
        self._active_call_id = call_id
        if self.is_tty:
            self._ensure_working()
            self._write_live(self._tool_line(tool, ok=None), self.theme.working_background)

    def on_tool_result(
        self, call_id: str, name: str, text: str, elapsed: float, img_count: int
    ) -> None:
        """Compatibility entry point for callers using the original callback."""
        ok = not text.lstrip().lower().startswith("[error]")
        self.on_tool_status(call_id, name, ok, text, elapsed, img_count)

    def on_tool_status(
        self,
        call_id: str,
        name: str,
        ok: bool,
        text: str,
        elapsed: float,
        img_count: int,
    ) -> None:
        tool = self._tools.get(call_id)
        if tool is None:
            self._tool_sequence += 1
            tool = _ToolDisplay(self._tool_sequence, name, {})
            self._tools[call_id] = tool
        if tool.completed:
            return
        tool.completed = True
        self._tool_count += 1
        self._failed_tool_count += int(not ok)
        self._active_call_id = None
        if self.is_tty:
            self._ensure_working()
            self._finish_live(
                self._tool_line(tool, ok=ok, elapsed=elapsed, img_count=img_count),
                self.theme.working_background,
            )
            if not ok and text:
                first_line = _sanitize_text(text).removeprefix("[error]").strip()
                if first_line:
                    self._write_card(self._error_line(first_line), self.theme.working_background)
            return
        detail = self._compact_tool_detail(tool.name, tool.args)
        status = "ok" if ok else "failed"
        extras = f" | {detail}" if detail else ""
        self._write(f"[tool {tool.index}] {tool.name}{extras} | {status} | {elapsed:.1f}s\n")
        if not ok and text:
            first_line = _sanitize_text(text).removeprefix("[error]").strip()
            if first_line:
                self._write(f"[error] {first_line}\n")

    def on_turn_end(self, turn_event: Any) -> None:
        archived = getattr(turn_event, "archived_count", 0)
        if archived:
            self._archived_count += int(archived)
        tool_calls = getattr(turn_event, "tool_calls", [])
        if not tool_calls:
            self._clear_live()
            self._close_working()
        if hasattr(self.session, "refresh_from_disk"):
            try:
                self.session.refresh_from_disk()
            except Exception:  # noqa: BLE001
                # Rendering remains best-effort; AgentLoop also protects callbacks.
                logger.debug("Could not refresh renderer session state", exc_info=True)

    def begin_answer(self) -> None:
        if self._run_active:
            self._close_working()
        if not (self.is_tty and self.answer_is_tty):
            return
        background = self.theme.answer_background
        header = (
            self._tone(self.top, self.theme.success, background)
            + " "
            + self._tone("Answer", self.theme.success, background, bold=True)
        )
        self._write_card(header, background)
        self._answer_open = True

    def print_answer(self, answer: str) -> bool:
        """Write a bordered answer in a TTY; return False for pipe-safe fallback."""
        if not (self.is_tty and self.answer_is_tty):
            return False
        self.begin_answer()
        safe_answer = _sanitize_text(answer, multiline=True).rstrip()
        background = self.theme.answer_background
        for row in wrap_display(safe_answer, max(1, self._width(self.answer_stream) - 3)):
            content = (
                self._tone(self.pipe, self.theme.success, background)
                + "  "
                + self._tone(row, self.theme.primary, background)
            )
            self._write_card(content, background, stream=self.answer_stream)
        return True

    def end_answer(self, footer: str = "") -> None:
        if not self._answer_open:
            return
        background = self.theme.answer_background
        content = self._tone(self.bottom, self.theme.success, background)
        if footer:
            content += " " + self._tone(footer, self.theme.muted, background)
        self._write_card(content, background)
        self._answer_open = False

    def abort(self, message: str = "Interrupted") -> None:
        """Close any live panels before the process exits early."""
        safe_message = _sanitize_text(message)
        if self._working_open:
            if self._active_call_id is not None:
                tool = self._tools.get(self._active_call_id)
                if tool is not None and not tool.completed:
                    tool.completed = True
                    self._tool_count += 1
                    self._failed_tool_count += 1
                    self._finish_live(
                        self._tool_line(tool, ok=False, interrupted=True),
                        self.theme.working_background,
                    )
            else:
                self._clear_live()
                self._write_card(self._error_line(safe_message), self.theme.working_background)
            self._close_working(reason="interrupted")
        elif self._run_active or self._live_line:
            self._clear_live()
            if self.is_tty:
                symbol = self._style(self.fail, self._RED)
                self._write(f"  {symbol} {safe_message}\n")
            else:
                self._write(f"[aborted] {safe_message}\n")
            self._run_active = False
        self.end_answer()

    def print_stats(self, result: Any) -> None:
        """Print a compact run summary after the answer."""
        if self._run_active:
            self._close_working()
        turns = getattr(result, "turns", [])
        tools = [tool for turn in turns for tool in getattr(turn, "tool_calls", [])]
        failed = sum(not getattr(tool, "ok", True) for tool in tools)
        inp = getattr(result, "total_input_tokens", 0)
        out = getattr(result, "total_output_tokens", 0)
        reasoning = getattr(result, "total_reasoning_tokens", 0)
        elapsed = getattr(result, "total_elapsed_s", 0.0)
        error = getattr(result, "error", None)
        path = _sanitize_text(safe_display_path(self.session.path))

        if not self.is_tty:
            suffix = f" | {failed} failed" if failed else ""
            turn_label = "turn" if len(turns) == 1 else "turns"
            tool_label = "tool" if len(tools) == 1 else "tools"
            self._write(
                f"\n[run] {len(turns)} {turn_label} | {len(tools)} {tool_label}{suffix} | "
                f"{inp:,} input | {out:,} output | {reasoning:,} reasoning | "
                f"{elapsed:.1f}s | session={path}\n"
            )
            if error:
                self._write(f"[error] {_sanitize_text(error)}\n")
            return
        if error and self._answer_open:
            background = self.theme.answer_background
            self._write_card(
                self._tone(self.pipe, self.theme.success, background)
                + "  "
                + self._tone(_sanitize_text(error), self.theme.danger, background),
                background,
            )
        footer_parts = [] if self._working_seen else [f"{elapsed:.1f}s"]
        footer_parts.extend((f"{inp:,} in", f"{out:,} out"))
        if reasoning:
            footer_parts.append(f"{reasoning:,} reasoning")
        if failed:
            footer_parts.append(f"{failed} failed")
        footer = f" {self.dot} ".join(footer_parts)
        if self._answer_open:
            self.end_answer(footer)
        else:
            self._write(self._style(footer, self._DIM) + "\n")


__all__ = ["PlainRenderer", "safe_display_path", "sanitize_terminal_text"]
