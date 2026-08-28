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
import shutil
import sys
import textwrap
import time
import unicodedata
from pathlib import Path
from typing import Any, TextIO

from .callbacks import LoopCallbacks

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


class PlainRenderer:
    """Render AgentLoop events as a lightweight terminal tree."""

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
        self._turn_num: int | None = None
        self._turn_started = 0.0
        self._answer_open = False

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

    def _width(self) -> int:
        return max(50, min(120, shutil.get_terminal_size(fallback=(92, 24)).columns))

    def _wrapped_rows(self, text: str, *, indent: int = 3) -> list[str]:
        width = max(24, self._width() - indent - 3)
        rows: list[str] = []
        for source_line in _sanitize_text(text, multiline=True).splitlines() or [""]:
            rows.extend(textwrap.wrap(source_line, width=width) or [""])
        return rows

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

        self._write(
            f"\n{self._style(self.top, self._CYAN)} {self._style('DocAtlas', self._BOLD)}\n"
        )
        self._write(f"{self.pipe}  session   {_sanitize_text(self.session.session_id)}\n")
        if getattr(self.session, "doc_env", None) is not None:
            doc_id = getattr(self.session.doc_env, "doc_id", None)
            pdf_path = getattr(self.session.doc_env, "pdf_path", None)
            doc_map = getattr(self.session.doc_env, "doc_map", None)
            if isinstance(doc_map, dict) and len(doc_map) > 1:
                names = ", ".join(str(name) for name in doc_map)
                self._write(
                    f"{self.pipe}  documents {len(doc_map)} {self.dot} {_sanitize_text(names)}\n"
                )
            else:
                document = doc_id or (Path(pdf_path).name if pdf_path else None)
                if document:
                    self._write(f"{self.pipe}  document  {_sanitize_text(document)}\n")
        if self.skills:
            skill_names = " ".join(_sanitize_text(skill) for skill in self.skills)
            self._write(f"{self.pipe}  skills    {skill_names}\n")
        self._write(f"{self.pipe}  state     {path}\n")
        self._write(f"{self._style(self.bottom, self._CYAN)} {self._style('Ready', self._GREEN)}\n")

    def on_turn_start(self, turn_num: int) -> None:
        if self._turn_num is not None:
            self._close_turn()
        self._turn_num = turn_num
        self._turn_started = time.monotonic()
        self._write(
            f"\n{self._style(self.top, self._CYAN)} {self._style(f'Turn {turn_num}', self._BOLD)}\n"
        )
        self._write(f"{self.pipe}  {self._style(self.wait, self._YELLOW)} Waiting for model...\n")

    def on_reasoning(self, summary: str) -> None:
        if not self.show_reasoning:
            return
        self._write(f"{self._style(self.branch, self._CYAN)} Reasoning summary\n")
        all_rows = self._wrapped_rows(summary)
        rows = all_rows[:10]
        for row in rows:
            self._write(f"{self.pipe}  {self._style(row, self._DIM)}\n")
        if len(all_rows) > len(rows):
            self._write(f"{self.pipe}  {self._style('...', self._DIM)}\n")

    def on_tool_call(self, call_id: str, name: str, args: dict) -> None:
        del call_id
        label = _sanitize_text(name.replace("_", " ").title())
        self._write(f"{self._style(self.branch, self._CYAN)} {self._style(label, self._BOLD)}\n")
        for key, value in args.items():
            if value is None or value is False or value == "" or value == [] or value == {}:
                continue
            if name == "read" and key == "zoom" and value == 1:
                continue
            if name == "note" and key == "side_effect_policy" and value == "auto":
                continue
            safe_key = _sanitize_text(key)
            self._write(
                f"{self.pipe}  {self._style(safe_key, self._DIM)}  "
                f"{_format_value(safe_key, value)}\n"
            )
        self._write(f"{self.pipe}  {self._style(self.wait, self._YELLOW)} Running...\n")

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
        del call_id, name
        symbol = self._style(self.ok, self._GREEN) if ok else self._style(self.fail, self._RED)
        status = "Completed" if ok else "Failed"
        extras = [f"{elapsed:.1f}s"]
        if img_count:
            extras.append(f"{img_count} image{'s' if img_count != 1 else ''}")
        detail = f" {self.dot} ".join(extras)
        self._write(f"{self.pipe}  {symbol} {status} {self.dot} {detail}\n")
        if not ok and text:
            first_line = _sanitize_text(text).removeprefix("[error]").strip()
            if first_line:
                self._write(f"{self.pipe}    {self._style(first_line[:120], self._RED)}\n")

    def _close_turn(self) -> None:
        if self._turn_num is None:
            return
        elapsed = max(0.0, time.monotonic() - self._turn_started)
        self._write(
            f"{self._style(self.bottom, self._CYAN)} "
            f"Turn {self._turn_num} complete {self.dot} {elapsed:.1f}s\n"
        )
        self._turn_num = None

    def on_turn_end(self, turn_event: Any) -> None:
        archived = getattr(turn_event, "archived_count", 0)
        if archived:
            self._write(f"{self.pipe}  archived {archived} tool output(s)\n")
        self._close_turn()
        if hasattr(self.session, "refresh_from_disk"):
            try:
                self.session.refresh_from_disk()
            except Exception:  # noqa: BLE001
                # Rendering remains best-effort; AgentLoop also protects callbacks.
                logger.debug("Could not refresh renderer session state", exc_info=True)

    def begin_answer(self) -> None:
        if not (self.is_tty and self.answer_is_tty):
            return
        self._write(f"\n{self._style(self.top, self._GREEN)} {self._style('Answer', self._BOLD)}\n")
        self._answer_open = True

    def print_answer(self, answer: str) -> bool:
        """Write a bordered answer in a TTY; return False for pipe-safe fallback."""
        if not (self.is_tty and self.answer_is_tty):
            return False
        self.begin_answer()
        safe_answer = _sanitize_text(answer, multiline=True).rstrip()
        for line in safe_answer.splitlines() or [""]:
            self.answer_stream.write(f"{self.pipe}  {line}\n")
        self.answer_stream.flush()
        return True

    def end_answer(self) -> None:
        if not self._answer_open:
            return
        self._write(f"{self._style(self.bottom, self._GREEN)}\n")
        self._answer_open = False

    def abort(self, message: str = "Interrupted") -> None:
        """Close any live panels before the process exits early."""
        if self._turn_num is not None:
            self._write(
                f"{self.pipe}  {self._style(self.fail, self._RED)} {_sanitize_text(message)}\n"
            )
            self._close_turn()
        self.end_answer()

    def print_stats(self, result: Any) -> None:
        """Print a compact run summary after the answer."""
        self._close_turn()
        self.end_answer()
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

        title = "Run failed" if error else "Run complete"
        title_color = self._RED if error else self._GREEN
        self._write(f"\n{self._style(self.top, title_color)} {self._style(title, self._BOLD)}\n")
        turn_text = f"{len(turns)} {'turn' if len(turns) == 1 else 'turns'}"
        tool_text = f"{len(tools)} {'tool' if len(tools) == 1 else 'tools'}"
        if failed:
            tool_text += f" ({failed} failed)"
        self._write(f"{self.pipe}  {turn_text} {self.dot} {tool_text} {self.dot} {elapsed:.1f}s\n")
        self._write(
            f"{self.pipe}  tokens  {inp:,} in {self.dot} {out:,} out "
            f"{self.dot} {reasoning:,} reasoning\n"
        )
        self._write(f"{self.pipe}  session {path}\n")
        if error:
            self._write(f"{self.pipe}  {self._style(_sanitize_text(error), self._RED)}\n")
        self._write(f"{self._style(self.bottom, title_color)}\n")


__all__ = ["PlainRenderer", "safe_display_path", "sanitize_terminal_text"]
