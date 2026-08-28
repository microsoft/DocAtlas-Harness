"""Raw-terminal ``@`` path picker with a dependency-free navigable popup."""

from __future__ import annotations

import os
import select
import shlex
import shutil
import signal
import sys
import threading
import unicodedata
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

from .plain_renderer import sanitize_terminal_text

_UP = "UP"
_DOWN = "DOWN"
_LEFT = "LEFT"
_RIGHT = "RIGHT"
_ENTER = "ENTER"
_ESCAPE = "ESCAPE"
_BACKSPACE = "BACKSPACE"
_SPACE = "SPACE"
_CTRL_C = "CTRL_C"
_CTRL_D = "CTRL_D"
_CTRL_A = "CTRL_A"
_CTRL_E = "CTRL_E"
_CTRL_U = "CTRL_U"
_CTRL_W = "CTRL_W"
_DELETE = "DELETE"
_HIDDEN_DIRECTORY_NAMES = {"__pycache__", "build", "dist", "node_modules"}
_PENDING_INPUT: dict[int, deque[int]] = {}
_PENDING_INPUT_LOCK = threading.Lock()


def _queue_input(descriptor: int, payload: bytes) -> None:
    if not payload:
        return
    with _PENDING_INPUT_LOCK:
        _PENDING_INPUT.setdefault(descriptor, deque()).extend(payload)


def _read_byte(descriptor: int, timeout: float | None = None) -> bytes | None:
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


def _capture_typeahead(descriptor: int) -> None:
    """Preserve bytes that would otherwise be lost across termios mode changes."""
    while True:
        ready, _, _ = select.select([descriptor], [], [], 0)
        if not ready:
            return
        payload = os.read(descriptor, 4096)
        if not payload:
            return
        _queue_input(descriptor, payload)


def _read_terminal_key(stream: TextIO) -> str:
    try:
        descriptor = stream.fileno()
    except (AttributeError, OSError):
        char = stream.read(1)
        return _decode_character(char)

    first = _read_byte(descriptor)
    if not first:
        return _CTRL_D
    if first == b"\x1b":
        introducer = _read_byte(descriptor, 0.04)
        if introducer is None:
            return _ESCAPE
        if introducer not in {b"[", b"O"}:
            _queue_input(descriptor, introducer)
            return _ESCAPE
        sequence = bytearray(introducer)
        for _ in range(8):
            part = _read_byte(descriptor, 0.04)
            if part is None:
                break
            sequence.extend(part)
            if 0x40 <= part[0] <= 0x7E:
                break
        encoded_sequence = bytes(sequence)
        if encoded_sequence in {b"[3~"}:
            return _DELETE
        if encoded_sequence in {b"[H", b"OH", b"[1~", b"[7~"}:
            return _CTRL_A
        if encoded_sequence in {b"[F", b"OF", b"[4~", b"[8~"}:
            return _CTRL_E
        final = chr(sequence[-1]) if len(sequence) > 1 else ""
        return {
            "A": _UP,
            "B": _DOWN,
            "C": _RIGHT,
            "D": _LEFT,
        }.get(final, _ESCAPE)

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
        part = _read_byte(descriptor)
        if not part:
            break
        payload.extend(part)
    try:
        char = payload.decode("utf-8")
    except UnicodeDecodeError:
        char = payload.decode(getattr(stream, "encoding", None) or "utf-8", errors="replace")
    return _decode_character(char)


def _decode_character(char: str) -> str:
    if char == "":
        return _CTRL_D
    if char in {"\r", "\n"}:
        return _ENTER
    if char in {"\x7f", "\b"}:
        return _BACKSPACE
    if char == " ":
        return _SPACE
    if char == "\x03":
        return _CTRL_C
    if char == "\x04":
        return _CTRL_D
    if char == "\x01":
        return _CTRL_A
    if char == "\x05":
        return _CTRL_E
    if char == "\x15":
        return _CTRL_U
    if char == "\x17":
        return _CTRL_W
    if char == "\x1b":
        return _ESCAPE
    return char


def _display_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(Path.cwd().resolve())) or "."
    except ValueError:
        try:
            return str(Path("~") / resolved.relative_to(Path.home().resolve()))
        except ValueError:
            return str(resolved)


@dataclass(frozen=True)
class PickerEntry:
    path: Path
    label: str
    is_directory: bool
    is_parent: bool = False


@dataclass
class PathPickerModel:
    """Filesystem navigation state independent of terminal rendering."""

    current_dir: Path
    selected: list[Path] = field(default_factory=list)
    index: int = 0
    error: str = ""
    entries: list[PickerEntry] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.current_dir = self.current_dir.expanduser().resolve()
        self.refresh()

    def refresh(self) -> None:
        entries: list[PickerEntry] = []
        if self.current_dir.parent != self.current_dir:
            entries.append(
                PickerEntry(
                    path=self.current_dir.parent,
                    label="../",
                    is_directory=True,
                    is_parent=True,
                )
            )
        try:
            children = sorted(
                self.current_dir.iterdir(),
                key=lambda item: (not item.is_dir(), item.name.casefold()),
            )
            self.error = ""
        except OSError as exc:
            children = []
            self.error = str(exc)
        for child in children:
            if child.name.startswith("."):
                continue
            if any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in child.name):
                continue
            if child.is_dir():
                if child.name in _HIDDEN_DIRECTORY_NAMES or child.name.endswith(".egg-info"):
                    continue
                entries.append(
                    PickerEntry(path=child.resolve(), label=f"{child.name}/", is_directory=True)
                )
            elif child.is_file() and child.suffix.lower() == ".pdf":
                entries.append(
                    PickerEntry(path=child.resolve(), label=child.name, is_directory=False)
                )
        self.entries = entries
        self.index = min(max(0, self.index), max(0, len(entries) - 1))

    @property
    def active(self) -> PickerEntry | None:
        return self.entries[self.index] if self.entries else None

    def move(self, delta: int) -> None:
        if self.entries:
            self.index = (self.index + delta) % len(self.entries)

    def enter_directory(self, path: Path) -> None:
        if path.is_dir():
            self.current_dir = path.resolve()
            self.index = 0
            self.refresh()

    def go_parent(self) -> None:
        if self.current_dir.parent != self.current_dir:
            self.enter_directory(self.current_dir.parent)

    def toggle_active(self) -> None:
        active = self.active
        if active is None or active.is_directory:
            return
        if active.path in self.selected:
            self.selected.remove(active.path)
        else:
            self.selected.append(active.path)

    def select_all_visible(self) -> None:
        visible = [entry.path for entry in self.entries if not entry.is_directory]
        if visible and all(path in self.selected for path in visible):
            self.selected = [path for path in self.selected if path not in visible]
        else:
            for path in visible:
                if path not in self.selected:
                    self.selected.append(path)


class TerminalPathPicker:
    """Render and drive a navigable file list below the active prompt."""

    _RESET = "\x1b[0m"
    _BOLD = "\x1b[1m"
    _DIM = "\x1b[2m"
    _CYAN = "\x1b[36m"
    _GREEN = "\x1b[32m"
    _YELLOW = "\x1b[33m"

    def __init__(
        self,
        *,
        start_dir: Path,
        input_stream: TextIO,
        output_stream: TextIO,
        use_unicode: bool,
        use_color: bool,
        visible_rows: int = 9,
    ) -> None:
        self.model = PathPickerModel(start_dir)
        self.input_stream = input_stream
        self.output_stream = output_stream
        self.use_unicode = use_unicode
        self.use_color = use_color
        self.visible_rows = max(4, visible_rows)
        if use_unicode:
            self.top, self.pipe, self.bottom = "╭─", "│", "╰─"
            self.pointer, self.directory, self.file = "›", "▸", "•"
        else:
            self.top, self.pipe, self.bottom = "+--", "|", "`--"
            self.pointer, self.directory, self.file = ">", "+", "-"

    def _style(self, text: str, *codes: str) -> str:
        if not self.use_color:
            return text
        return "".join(codes) + text + self._RESET

    def _visible_entries(self) -> tuple[int, list[PickerEntry]]:
        total = len(self.model.entries)
        if total <= self.visible_rows:
            return 0, self.model.entries
        half = self.visible_rows // 2
        start = max(0, min(self.model.index - half, total - self.visible_rows))
        return start, self.model.entries[start : start + self.visible_rows]

    def _lines(self) -> list[str]:
        width = max(32, min(120, shutil.get_terminal_size(fallback=(92, 24)).columns))
        location = sanitize_terminal_text(_display_path(self.model.current_dir))
        selected_count = len(self.model.selected)
        title = f"{self.top} @ files · {location}"
        if selected_count:
            title += f" · {selected_count} selected"
        lines = [self._style(_truncate_display(title, width), self._CYAN, self._BOLD)]
        start, entries = self._visible_entries()
        if not entries:
            lines.append(f"{self.pipe}    No PDF files or readable directories")
        for offset, entry in enumerate(entries):
            absolute_index = start + offset
            pointer = self.pointer if absolute_index == self.model.index else " "
            checked = "[x]" if entry.path in self.model.selected else "[ ]"
            kind = self.directory if entry.is_directory else self.file
            label = sanitize_terminal_text(entry.label)
            row = f"{self.pipe}  {pointer} {checked} {kind} {label}"
            row = _truncate_display(row, width)
            if absolute_index == self.model.index:
                row = self._style(row, self._BOLD)
            lines.append(row)
        if self.model.error:
            error = _truncate_display(self.model.error, max(4, width - 4))
            lines.append(f"{self.pipe}  {self._style(error, self._YELLOW)}")
        hint = "↑↓ move · Enter open · Space multi · d done · f folder · Esc"
        lines.append(self._style(_truncate_display(f"{self.bottom} {hint}", width), self._DIM))
        return lines

    def _redraw(self) -> None:
        self.output_stream.write("\x1b[u\x1b[J")
        self.output_stream.write("\n".join(self._lines()) + "\n")
        self.output_stream.flush()

    def run(self) -> list[Path]:
        self.output_stream.write("\n\x1b[s")
        self._redraw()
        try:
            while True:
                key = _read_terminal_key(self.input_stream)
                if key == _UP:
                    self.model.move(-1)
                elif key == _DOWN:
                    self.model.move(1)
                elif key in {_LEFT, _BACKSPACE}:
                    self.model.go_parent()
                elif key in {_RIGHT, _ENTER}:
                    active = self.model.active
                    if active is not None and active.is_directory:
                        self.model.enter_directory(active.path)
                    elif active is not None:
                        if active.path not in self.model.selected:
                            self.model.selected.append(active.path)
                        return list(self.model.selected)
                elif key == _SPACE:
                    self.model.toggle_active()
                elif key.casefold() == "a":
                    self.model.select_all_visible()
                elif key.casefold() == "d" and self.model.selected:
                    return list(self.model.selected)
                elif key.casefold() == "f":
                    return [self.model.current_dir]
                elif key in {_ESCAPE, _CTRL_D}:
                    return []
                elif key == _CTRL_C:
                    raise KeyboardInterrupt
                self._redraw()
        finally:
            # Erase the popup, move back to the prompt row, and let the line
            # editor repaint its current buffer.
            self.output_stream.write("\x1b[u\x1b[J\x1b[1A")
            self.output_stream.flush()


def _buffer_accepts_picker(buffer: str) -> bool:
    """Trigger mentions at an empty/mention-only prompt or after add/new."""
    if not buffer:
        return True
    try:
        tokens = shlex.split(buffer)
    except ValueError:
        return False
    if tokens and all(token.startswith("@") for token in tokens):
        return True
    return bool(tokens and tokens[0] in {"/add", "/new"})


def _mention_text(paths: list[Path]) -> str:
    mentions: list[str] = []
    root = Path.cwd().resolve()
    for path in paths:
        resolved = path.resolve()
        try:
            display = resolved.relative_to(root)
        except ValueError:
            display = resolved
        mentions.append("@" + shlex.quote(str(display)))
    return " ".join(mentions)


def _display_width(value: str) -> int:
    width = 0
    for char in value:
        if unicodedata.combining(char):
            continue
        width += 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
    return width


def _truncate_display(value: str, max_width: int) -> str:
    if _display_width(value) <= max_width:
        return value
    target = max(1, max_width - 1)
    rendered: list[str] = []
    width = 0
    for char in value:
        char_width = _display_width(char)
        if width + char_width > target:
            break
        rendered.append(char)
        width += char_width
    return "".join(rendered) + "…"


def _line_window(value: str, cursor: int, max_width: int) -> tuple[str, int]:
    """Return a single-line viewport and the cursor column within it."""
    max_width = max(4, max_width)
    characters = list(value)
    cursor = min(max(0, cursor), len(characters))
    widths = [
        0
        if unicodedata.combining(char)
        else (2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1)
        for char in characters
    ]
    prefixes = [0]
    for width in widths:
        prefixes.append(prefixes[-1] + width)
    if prefixes[-1] <= max_width:
        return value, prefixes[cursor]

    def viewport_width(start: int, end: int) -> int:
        return prefixes[end] - prefixes[start] + int(start > 0) + int(end < len(characters))

    start = cursor
    end = cursor
    right_target = max(1, max_width // 3)
    while end < len(characters):
        next_right_width = prefixes[end + 1] - prefixes[cursor]
        if next_right_width > right_target or viewport_width(start, end + 1) > max_width:
            break
        end += 1
    while start > 0 and viewport_width(start - 1, end) <= max_width:
        start -= 1
    while end < len(characters) and viewport_width(start, end + 1) <= max_width:
        end += 1

    left_marker = "…" if start > 0 else ""
    right_marker = "…" if end < len(characters) else ""
    visible = left_marker + "".join(characters[start:end]) + right_marker
    cursor_column = len(left_marker) + prefixes[cursor] - prefixes[start]
    return visible, cursor_column


@contextmanager
def terminal_interrupt_monitor(
    input_stream: TextIO = sys.stdin,
) -> Iterator[None]:
    """Turn Esc/Ctrl+C into SIGINT while synchronous work owns the main thread."""
    if os.name != "posix" or not input_stream.isatty():
        yield
        return

    import termios
    import tty

    descriptor = input_stream.fileno()
    previous = termios.tcgetattr(descriptor)
    stopped = threading.Event()

    def watch() -> None:
        while not stopped.is_set():
            try:
                value = _read_byte(descriptor, 0.1)
                if value is None:
                    continue
            except OSError:
                return
            should_interrupt = value == b"\x03"
            if value == b"\x1b":
                introducer = _read_byte(descriptor, 0.04)
                if introducer is not None:
                    if introducer in {b"[", b"O"}:
                        for _ in range(8):
                            final = _read_byte(descriptor, 0.02)
                            if final is None:
                                break
                            if final and 0x40 <= final[0] <= 0x7E:
                                break
                        continue
                    _queue_input(descriptor, introducer)
                should_interrupt = True
            if should_interrupt:
                stopped.set()
                os.kill(os.getpid(), signal.SIGINT)
                return

    try:
        tty.setcbreak(descriptor)
        attributes = termios.tcgetattr(descriptor)
        attributes[3] &= ~termios.ISIG
        termios.tcsetattr(descriptor, termios.TCSANOW, attributes)
        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        try:
            yield
        finally:
            stopped.set()
            watcher.join(timeout=0.3)
    finally:
        _capture_typeahead(descriptor)
        termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)


def read_line_with_at_picker(
    prompt: str,
    *,
    input_stream: TextIO = sys.stdin,
    output_stream: TextIO = sys.stderr,
    use_unicode: bool = True,
    use_color: bool = True,
    history: list[str] | None = None,
) -> str:
    """Read one editable line and open a path picker immediately on ``@``."""
    if os.name != "posix":  # pragma: no cover - Windows fallback lives in TUIConsole
        raise RuntimeError("raw terminal input is unavailable")
    import termios
    import tty

    descriptor = input_stream.fileno()
    previous = termios.tcgetattr(descriptor)
    buffer: list[str] = []
    cursor = 0
    history_values = history if history is not None else []
    history_index = len(history_values)
    draft = ""

    def redraw(extra: str = "") -> None:
        display_buffer = list(buffer)
        display_cursor = cursor
        if extra:
            display_buffer[cursor:cursor] = list(extra)
            display_cursor += len(extra)
        terminal_width = shutil.get_terminal_size(fallback=(92, 24)).columns
        prompt_width = _display_width(sanitize_terminal_text(prompt))
        visible, cursor_column = _line_window(
            "".join(display_buffer),
            display_cursor,
            max(8, terminal_width - prompt_width - 1),
        )
        output_stream.write(f"\r\x1b[2K{prompt}{visible}")
        tail_width = _display_width(visible) - cursor_column
        if tail_width:
            output_stream.write(f"\x1b[{tail_width}D")
        output_stream.flush()

    redraw()
    try:
        tty.setcbreak(descriptor)
        attributes = termios.tcgetattr(descriptor)
        attributes[3] &= ~termios.ISIG
        termios.tcsetattr(descriptor, termios.TCSANOW, attributes)
        while True:
            key = _read_terminal_key(input_stream)
            if key == _ENTER:
                output_stream.write("\n")
                output_stream.flush()
                value = "".join(buffer).strip()
                if history is not None and value and (not history or history[-1] != value):
                    history.append(value)
                return value
            if key == _BACKSPACE:
                if cursor:
                    del buffer[cursor - 1]
                    cursor -= 1
                redraw()
                continue
            if key == _DELETE:
                if cursor < len(buffer):
                    del buffer[cursor]
                redraw()
                continue
            if key == _LEFT:
                cursor = max(0, cursor - 1)
                redraw()
                continue
            if key == _RIGHT:
                cursor = min(len(buffer), cursor + 1)
                redraw()
                continue
            if key == _CTRL_A:
                cursor = 0
                redraw()
                continue
            if key == _CTRL_E:
                cursor = len(buffer)
                redraw()
                continue
            if key == _CTRL_U:
                del buffer[:cursor]
                cursor = 0
                redraw()
                continue
            if key == _CTRL_W:
                while cursor and buffer[cursor - 1].isspace():
                    del buffer[cursor - 1]
                    cursor -= 1
                while cursor and not buffer[cursor - 1].isspace():
                    del buffer[cursor - 1]
                    cursor -= 1
                redraw()
                continue
            if key == _CTRL_C:
                output_stream.write("^C\n")
                output_stream.flush()
                raise KeyboardInterrupt
            if key == _CTRL_D:
                if not buffer:
                    raise EOFError
                continue
            if key == _ESCAPE:
                output_stream.write("\n")
                output_stream.flush()
                raise KeyboardInterrupt
            if key == _UP and history_values:
                if history_index == len(history_values):
                    draft = "".join(buffer)
                history_index = max(0, history_index - 1)
                buffer[:] = list(history_values[history_index])
                cursor = len(buffer)
                redraw()
                continue
            if key == _DOWN and history_values:
                if history_index < len(history_values) - 1:
                    history_index += 1
                    buffer[:] = list(history_values[history_index])
                else:
                    history_index = len(history_values)
                    buffer[:] = list(draft)
                cursor = len(buffer)
                redraw()
                continue
            if key == _SPACE:
                buffer.insert(cursor, " ")
                cursor += 1
                redraw()
                continue
            if len(key) == 1 and key.isprintable():
                prefix = "".join(buffer[:cursor])
                if key == "@" and cursor == len(buffer) and _buffer_accepts_picker(prefix):
                    redraw("@")
                    picker = TerminalPathPicker(
                        start_dir=Path.cwd(),
                        input_stream=input_stream,
                        output_stream=output_stream,
                        use_unicode=use_unicode,
                        use_color=use_color,
                    )
                    selected = picker.run()
                    if selected:
                        insertion = _mention_text(selected)
                        if buffer and not buffer[-1].isspace():
                            buffer.insert(cursor, " ")
                            cursor += 1
                        for char in insertion + " ":
                            buffer.insert(cursor, char)
                            cursor += 1
                    else:
                        buffer.insert(cursor, "@")
                        cursor += 1
                    redraw()
                    continue
                buffer.insert(cursor, key)
                cursor += 1
                redraw()
    finally:
        _capture_typeahead(descriptor)
        termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)


__all__ = [
    "PathPickerModel",
    "PickerEntry",
    "TerminalPathPicker",
    "read_line_with_at_picker",
    "terminal_interrupt_monitor",
]
