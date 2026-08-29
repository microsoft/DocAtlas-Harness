"""Shared terminal input and display primitives for DocAtlas's dependency-free TUI."""

from __future__ import annotations

import os
import re
import select
import shutil
import threading
import unicodedata
from collections import deque
from dataclasses import dataclass
from typing import TextIO

KEY_UP = "UP"
KEY_DOWN = "DOWN"
KEY_LEFT = "LEFT"
KEY_RIGHT = "RIGHT"
KEY_ENTER = "ENTER"
KEY_ESCAPE = "ESCAPE"
KEY_BACKSPACE = "BACKSPACE"
KEY_SPACE = "SPACE"
KEY_CTRL_C = "CTRL_C"
KEY_CTRL_D = "CTRL_D"
KEY_CTRL_A = "CTRL_A"
KEY_CTRL_E = "CTRL_E"
KEY_CTRL_U = "CTRL_U"
KEY_CTRL_W = "CTRL_W"
KEY_DELETE = "DELETE"
KEY_PAGE_UP = "PAGE_UP"
KEY_PAGE_DOWN = "PAGE_DOWN"
KEY_SHIFT_TAB = "SHIFT_TAB"

_PENDING_INPUT: dict[int, deque[int]] = {}
_PENDING_INPUT_LOCK = threading.Lock()


@dataclass(frozen=True)
class TerminalTheme:
    """ANSI palette with fixed backgrounds for the three TUI content layers."""

    name: str
    primary: str
    muted: str
    accent: str
    success: str
    warning: str
    danger: str
    ask_background: str
    working_background: str
    answer_background: str
    reset: str = "\x1b[0m"
    bold: str = "\x1b[1m"
    dim: str = "\x1b[2m"


_DARK_THEME = TerminalTheme(
    name="dark",
    primary="\x1b[38;2;235;239;243m",
    muted="\x1b[38;2;154;164;173m",
    accent="\x1b[38;2;102;217;239m",
    success="\x1b[38;2;105;219;124m",
    warning="\x1b[38;2;255;212;59m",
    danger="\x1b[38;2;255;107;107m",
    ask_background="\x1b[48;2;30;38;48m",
    working_background="\x1b[48;2;17;23;30m",
    answer_background="\x1b[48;2;17;23;30m",
)

_LIGHT_THEME = TerminalTheme(
    name="light",
    primary="\x1b[38;2;31;41;51m",
    muted="\x1b[38;2;92;103;112m",
    accent="\x1b[38;2;11;114;133m",
    success="\x1b[38;2;8;127;91m",
    warning="\x1b[38;2;156;101;0m",
    danger="\x1b[38;2;201;42;42m",
    ask_background="\x1b[48;2;232;238;242m",
    working_background="\x1b[48;2;219;228;234m",
    answer_background="\x1b[48;2;219;228;234m",
)

_NO_COLOR_THEME = TerminalTheme(
    name="none",
    primary="",
    muted="",
    accent="",
    success="",
    warning="",
    danger="",
    ask_background="",
    working_background="",
    answer_background="",
    reset="",
    bold="",
    dim="",
)


def terminal_theme(*, use_color: bool) -> TerminalTheme:
    """Choose a theme without querying or mutating the terminal."""
    if not use_color:
        return _NO_COLOR_THEME
    requested = os.getenv("DOCATLAS_THEME", "auto").strip().casefold()
    if requested == "light":
        return _LIGHT_THEME
    if requested == "dark":
        return _DARK_THEME
    color_fg_bg = os.getenv("COLORFGBG", "")
    try:
        background = int(color_fg_bg.rsplit(";", 1)[-1])
    except ValueError:
        background = 0
    return _LIGHT_THEME if background in {7, 15} else _DARK_THEME


class EscapeInterrupt(KeyboardInterrupt):
    """The user cancelled an interactive operation with Escape."""


class CtrlCInterrupt(KeyboardInterrupt):
    """The user interrupted an interactive operation with Ctrl+C."""


def queue_input(descriptor: int, payload: bytes) -> None:
    if not payload:
        return
    with _PENDING_INPUT_LOCK:
        _PENDING_INPUT.setdefault(descriptor, deque()).extend(payload)


def read_byte(descriptor: int, timeout: float | None = None) -> bytes | None:
    with _PENDING_INPUT_LOCK:
        pending = _PENDING_INPUT.get(descriptor)
        if pending:
            value = pending.popleft()
            if not pending:
                _PENDING_INPUT.pop(descriptor, None)
            return bytes([value])
    if timeout is not None:
        ready, _, _ = select.select([descriptor], [], [], timeout)
        if not ready:
            return None
    raw_value = os.read(descriptor, 1)
    return raw_value or None


def capture_typeahead(descriptor: int) -> None:
    """Preserve bytes that would otherwise be lost across termios mode changes."""
    while True:
        ready, _, _ = select.select([descriptor], [], [], 0)
        if not ready:
            return
        payload = os.read(descriptor, 4096)
        if not payload:
            return
        queue_input(descriptor, payload)


def read_terminal_key(stream: TextIO) -> str:
    """Read one logical key, including common VT escape sequences and UTF-8."""
    try:
        descriptor = stream.fileno()
    except (AttributeError, OSError):
        return decode_character(stream.read(1))

    first = read_byte(descriptor)
    if not first:
        return KEY_CTRL_D
    if first == b"\x1b":
        introducer = read_byte(descriptor, 0.04)
        if introducer is None:
            return KEY_ESCAPE
        if introducer not in {b"[", b"O"}:
            queue_input(descriptor, introducer)
            return KEY_ESCAPE
        sequence = bytearray(introducer)
        for _ in range(8):
            part = read_byte(descriptor, 0.04)
            if part is None:
                break
            sequence.extend(part)
            if 0x40 <= part[0] <= 0x7E:
                break
        encoded_sequence = bytes(sequence)
        if encoded_sequence == b"[3~":
            return KEY_DELETE
        if encoded_sequence == b"[5~":
            return KEY_PAGE_UP
        if encoded_sequence == b"[6~":
            return KEY_PAGE_DOWN
        if encoded_sequence == b"[Z":
            return KEY_SHIFT_TAB
        if encoded_sequence in {b"[H", b"OH", b"[1~", b"[7~"}:
            return KEY_CTRL_A
        if encoded_sequence in {b"[F", b"OF", b"[4~", b"[8~"}:
            return KEY_CTRL_E
        final = chr(sequence[-1]) if len(sequence) > 1 else ""
        return {
            "A": KEY_UP,
            "B": KEY_DOWN,
            "C": KEY_RIGHT,
            "D": KEY_LEFT,
        }.get(final, KEY_ESCAPE)

    first_value = first[0]
    utf8_width = 1
    if first_value & 0b11110000 == 0b11110000:
        utf8_width = 4
    elif first_value & 0b11100000 == 0b11100000:
        utf8_width = 3
    elif first_value & 0b11000000 == 0b11000000:
        utf8_width = 2
    payload = bytearray(first)
    while len(payload) < utf8_width:
        part = read_byte(descriptor)
        if not part:
            break
        payload.extend(part)
    try:
        char = payload.decode("utf-8")
    except UnicodeDecodeError:
        char = payload.decode(getattr(stream, "encoding", None) or "utf-8", errors="replace")
    return decode_character(char)


def decode_character(char: str) -> str:
    if char == "":
        return KEY_CTRL_D
    if char in {"\r", "\n"}:
        return KEY_ENTER
    if char in {"\x7f", "\b"}:
        return KEY_BACKSPACE
    if char == " ":
        return KEY_SPACE
    if char == "\x03":
        return KEY_CTRL_C
    if char == "\x04":
        return KEY_CTRL_D
    if char == "\x01":
        return KEY_CTRL_A
    if char == "\x05":
        return KEY_CTRL_E
    if char == "\x15":
        return KEY_CTRL_U
    if char == "\x17":
        return KEY_CTRL_W
    if char == "\x1b":
        return KEY_ESCAPE
    return char


def display_width(value: str) -> int:
    width = 0
    for char in value:
        if unicodedata.combining(char):
            continue
        width += 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
    return width


def wrap_display(value: str, max_width: int) -> list[str]:
    """Wrap text at words while respecting wide terminal characters."""
    max_width = max(1, max_width)
    rows: list[str] = []
    for source_line in value.splitlines() or [""]:
        initial_row_count = len(rows)
        if not source_line:
            rows.append("")
            continue
        current = ""
        for token in re.findall(r"\s+|\S+", source_line):
            if display_width(current + token) <= max_width:
                current += token
                continue
            if current.rstrip():
                rows.append(current.rstrip())
            current = token.lstrip()
            while display_width(current) > max_width:
                chunk: list[str] = []
                chunk_width = 0
                split_at = 0
                for split_at, char in enumerate(current, 1):
                    char_width = display_width(char)
                    if chunk and chunk_width + char_width > max_width:
                        split_at -= 1
                        break
                    chunk.append(char)
                    chunk_width += char_width
                rows.append("".join(chunk).rstrip())
                current = current[split_at:]
        if current.rstrip() or len(rows) == initial_row_count:
            rows.append(current.rstrip())
    return rows


def terminal_size(stream: TextIO) -> os.terminal_size:
    """Return the size of the terminal that actually owns ``stream``."""
    try:
        return os.get_terminal_size(stream.fileno())
    except (AttributeError, OSError):
        return shutil.get_terminal_size(fallback=(92, 24))


def truncate_display(value: str, max_width: int) -> str:
    if display_width(value) <= max_width:
        return value
    target = max(1, max_width - 1)
    rendered: list[str] = []
    width = 0
    for char in value:
        char_width = display_width(char)
        if width + char_width > target:
            break
        rendered.append(char)
        width += char_width
    return "".join(rendered) + "…"


def join_columns(left: str, right: str, max_width: int) -> str:
    """Fit left/right status text on one display-width-aware terminal row."""
    if not right:
        return truncate_display(left, max_width)
    right = truncate_display(right, max_width)
    right_width = display_width(right)
    left_width = max_width - right_width - 2
    if left_width < 1:
        return right
    left = truncate_display(left, left_width)
    gap = max(2, max_width - display_width(left) - right_width)
    return left + (" " * gap) + right


__all__ = [
    "CtrlCInterrupt",
    "EscapeInterrupt",
    "KEY_BACKSPACE",
    "KEY_CTRL_A",
    "KEY_CTRL_C",
    "KEY_CTRL_D",
    "KEY_CTRL_E",
    "KEY_CTRL_U",
    "KEY_CTRL_W",
    "KEY_DELETE",
    "KEY_DOWN",
    "KEY_ENTER",
    "KEY_ESCAPE",
    "KEY_LEFT",
    "KEY_PAGE_DOWN",
    "KEY_PAGE_UP",
    "KEY_RIGHT",
    "KEY_SHIFT_TAB",
    "KEY_SPACE",
    "KEY_UP",
    "TerminalTheme",
    "capture_typeahead",
    "display_width",
    "join_columns",
    "queue_input",
    "read_byte",
    "read_terminal_key",
    "terminal_size",
    "terminal_theme",
    "truncate_display",
    "wrap_display",
]
