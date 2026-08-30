"""Raw-terminal ``@`` path picker with a dependency-free navigable popup."""

from __future__ import annotations

import os
import shlex
import signal
import sys
import threading
import unicodedata
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

from ..remote_pdf import mask_url_query_values
from . import terminal as _terminal
from .commands import CommandCompletion
from .plain_renderer import sanitize_terminal_text
from .terminal import CtrlCInterrupt, EscapeInterrupt

_UP = _terminal.KEY_UP
_DOWN = _terminal.KEY_DOWN
_LEFT = _terminal.KEY_LEFT
_RIGHT = _terminal.KEY_RIGHT
_ENTER = _terminal.KEY_ENTER
_ESCAPE = _terminal.KEY_ESCAPE
_BACKSPACE = _terminal.KEY_BACKSPACE
_SPACE = _terminal.KEY_SPACE
_CTRL_C = _terminal.KEY_CTRL_C
_CTRL_D = _terminal.KEY_CTRL_D
_CTRL_A = _terminal.KEY_CTRL_A
_CTRL_E = _terminal.KEY_CTRL_E
_CTRL_L = _terminal.KEY_CTRL_L
_CTRL_U = _terminal.KEY_CTRL_U
_CTRL_W = _terminal.KEY_CTRL_W
_DELETE = _terminal.KEY_DELETE
_SHIFT_TAB = _terminal.KEY_SHIFT_TAB
_capture_typeahead = _terminal.capture_typeahead
_canvas_width = _terminal.canvas_width
_display_width = _terminal.display_width
_join_columns = _terminal.join_columns
_queue_input = _terminal.queue_input
_read_byte = _terminal.read_byte
_read_terminal_key = _terminal.read_terminal_key
_terminal_size = _terminal.terminal_size
_truncate_display = _terminal.truncate_display

_HIDDEN_DIRECTORY_NAMES = {"__pycache__", "build", "dist", "node_modules"}
_COMPOSER_BOTTOM_ROWS = 2


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
    """Render and drive an in-place navigable file list below the prompt."""

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
        allow_trigger_delete: bool = False,
    ) -> None:
        self.model = PathPickerModel(start_dir)
        self.input_stream = input_stream
        self.output_stream = output_stream
        self.use_unicode = use_unicode
        self.use_color = use_color
        self.visible_rows = max(4, visible_rows)
        self.allow_trigger_delete = allow_trigger_delete
        self.trigger_deleted = False
        self._rendered_lines: list[str] = []
        if use_unicode:
            self.horizontal = "─"
            self.pointer, self.directory = "›", "▸"
            self.unselected_file, self.selected_file = "○", "●"
        else:
            self.horizontal = "-"
            self.pointer, self.directory = ">", "+"
            self.unselected_file, self.selected_file = "o", "*"

    def _style(self, text: str, *codes: str) -> str:
        if not self.use_color:
            return text
        return "".join(codes) + text + self._RESET

    def _visible_entries(self, limit: int) -> tuple[int, list[PickerEntry]]:
        total = len(self.model.entries)
        if total <= limit:
            return 0, self.model.entries
        half = limit // 2
        start = max(0, min(self.model.index - half, total - limit))
        return start, self.model.entries[start : start + limit]

    def _lines(self) -> list[str]:
        terminal_size = _terminal_size(self.output_stream)
        # Stay one cell short of the right edge. Writing in the final column
        # enables delayed wrapping in many terminals, which makes cursor-row
        # accounting unreliable on the next redraw.
        width = _canvas_width(terminal_size.columns)
        location = sanitize_terminal_text(_display_path(self.model.current_dir))
        selected_count = len(self.model.selected)
        total = len(self.model.entries)
        position = f"{self.model.index + 1}/{total}" if total else "empty"
        status = f"{selected_count} selected · {position}" if selected_count else position
        header = _join_columns(f" @ files  {location}", status, width)
        divider = self.horizontal * width
        lines = [
            self._style(header, self._CYAN, self._BOLD),
            self._style(divider, self._CYAN, self._DIM),
        ]

        # Keep the complete popup inside the terminal whenever practical:
        # prompt + four chrome rows + entries (+ an optional error row).
        chrome_rows = 5 + int(bool(self.model.error))
        entry_limit = max(1, min(self.visible_rows, terminal_size.lines - chrome_rows))
        start, entries = self._visible_entries(entry_limit)
        if not entries:
            lines.append(_truncate_display("   No PDF files or readable directories", width))
        for offset, entry in enumerate(entries):
            absolute_index = start + offset
            pointer = self.pointer if absolute_index == self.model.index else " "
            if entry.is_directory:
                kind = self.directory
            elif entry.path in self.model.selected:
                kind = self.selected_file
            else:
                kind = self.unselected_file
            label = sanitize_terminal_text(entry.label)
            row = f" {pointer} {kind} {label}"
            row = _truncate_display(row, width)
            if absolute_index == self.model.index:
                row = self._style(row, self._CYAN, self._BOLD)
            elif entry.path in self.model.selected:
                row = self._style(row, self._GREEN)
            lines.append(row)
        if self.model.error:
            error = _truncate_display(self.model.error, max(4, width - 4))
            lines.append(self._style(_truncate_display(f" ! {error}", width), self._YELLOW))
        lines.append(self._style(divider, self._CYAN, self._DIM))
        if self.allow_trigger_delete:
            hint = (
                " Backspace/Delete removes @ · ↑↓ navigate · Enter open/select · "
                "Space mark · d done · f folder · ← parent · Esc close"
            )
        else:
            hint = " ↑↓ navigate · Enter open/select · Space mark · d done · f folder · Esc close"
        lines.append(self._style(_truncate_display(hint, width), self._DIM))
        return lines

    def _redraw(self) -> None:
        lines = self._lines()
        previous = self._rendered_lines
        if previous:
            if len(previous) > 1:
                self.output_stream.write(f"\x1b[{len(previous) - 1}A")
            self.output_stream.write("\r")

        # Redraw only changed rows, but visit the full previous/new span so a
        # shorter directory listing also erases every stale row. This mirrors
        # the previous-frame diffing used by mature TUIs without requiring a
        # full-screen or alternate-screen dependency.
        row_count = max(len(previous), len(lines))
        for index in range(row_count):
            old_line = previous[index] if index < len(previous) else None
            new_line = lines[index] if index < len(lines) else None
            if old_line != new_line:
                self.output_stream.write("\x1b[2K")
                if new_line is not None:
                    self.output_stream.write(new_line)
            if index < row_count - 1:
                self.output_stream.write("\r\n")

        if row_count > len(lines):
            self.output_stream.write(f"\x1b[{row_count - len(lines)}A")
        self._rendered_lines = lines
        self.output_stream.flush()

    def _clear(self) -> None:
        """Erase the current frame and return the cursor to the prompt."""
        for index in range(len(self._rendered_lines) - 1, -1, -1):
            self.output_stream.write("\r\x1b[2K")
            if index:
                self.output_stream.write("\x1b[1A")
        # ``run`` opens the picker exactly one row below the input prompt.
        self.output_stream.write("\x1b[1A\r\x1b[?25h")
        self._rendered_lines = []
        self.output_stream.flush()

    def run(self) -> list[Path]:
        self.output_stream.write("\x1b[?25l\r\n")
        self._redraw()
        try:
            while True:
                key = _read_terminal_key(self.input_stream)
                if key == _UP:
                    self.model.move(-1)
                elif key == _DOWN:
                    self.model.move(1)
                elif self.allow_trigger_delete and key in {_BACKSPACE, _DELETE}:
                    self.trigger_deleted = True
                    return []
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
                    raise CtrlCInterrupt
                self._redraw()
        finally:
            # Let the line editor repaint its current buffer after the picker
            # has restored the prompt row and hardware cursor.
            self._clear()


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
    interrupt_kind: str | None = None

    def watch() -> None:
        nonlocal interrupt_kind
        while not stopped.is_set():
            try:
                value = _read_byte(descriptor, 0.1)
                if value is None:
                    continue
            except OSError:
                return
            should_interrupt = value == b"\x03"
            if should_interrupt:
                interrupt_kind = "ctrl_c"
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
                interrupt_kind = "escape"
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
            try:
                yield
            except KeyboardInterrupt as exc:
                if interrupt_kind == "escape":
                    raise EscapeInterrupt from exc
                if interrupt_kind == "ctrl_c":
                    raise CtrlCInterrupt from exc
                raise
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
    input_activity: Callable[[], None] | None = None,
    canvas_style: str = "",
    composer: bool = False,
    completion_provider: Callable[[str], list[CommandCompletion]] | None = None,
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
    completion_index = 0
    completion_suppressed = False
    rendered_completion_rows = 0
    last_cursor_column = 0

    def current_canvas_width() -> int:
        return _canvas_width(_terminal_size(output_stream).columns)

    def painted_row(content: str, *, dim: bool = False) -> str:
        """Paint one full-width composer row without entering the wrap column."""
        width = current_canvas_width()
        plain = sanitize_terminal_text(content, multiline=True)
        padding = max(0, width - _display_width(plain))
        if not canvas_style:
            return content
        dim_style = "\x1b[2m" if dim and use_color else ""
        return canvas_style + dim_style + content + (" " * padding) + "\x1b[0m"

    def begin_composer() -> None:
        if not composer:
            return
        width = current_canvas_width()
        horizontal = "─" if use_unicode else "-"
        divider = horizontal * width
        if use_color:
            divider = "\x1b[2m" + divider + "\x1b[0m"
        # A leading blank row separates the previous Answer from the next Ask.
        # The shaded top row makes the editable area feel like a composer rather
        # than a one-line shell prompt.
        output_stream.write("\n" + divider + "\n" + painted_row("") + "\n")
        output_stream.flush()

    def completions() -> list[CommandCompletion]:
        if completion_provider is None or completion_suppressed or cursor != len(buffer):
            return []
        try:
            return completion_provider("".join(buffer))
        except Exception:  # noqa: BLE001 - completion must never break input
            return []

    def completion_lines(
        candidates: list[CommandCompletion], canvas_width: int
    ) -> list[tuple[str, bool]]:
        nonlocal completion_index
        if not candidates:
            completion_index = 0
            return []
        completion_index = min(completion_index, len(candidates) - 1)
        terminal_lines = _terminal_size(output_stream).lines
        chrome_rows = 5 + _COMPOSER_BOTTOM_ROWS if composer else 3
        limit = max(1, min(8, terminal_lines - chrome_rows, len(candidates)))
        start = max(0, min(completion_index - limit // 2, len(candidates) - limit))
        visible_candidates = candidates[start : start + limit]
        value_column = min(
            30,
            max(_display_width(candidate.value) for candidate in visible_candidates) + 5,
        )
        lines: list[tuple[str, bool]] = []
        for offset, candidate in enumerate(visible_candidates):
            absolute_index = start + offset
            marker = "›" if absolute_index == completion_index else " "
            left = f" {marker} {candidate.value}"
            if canvas_width < _display_width(left) + 20:
                rendered = _truncate_display(left, canvas_width)
            else:
                rendered = _truncate_display(
                    left
                    + (" " * max(2, value_column - _display_width(left)))
                    + candidate.description,
                    canvas_width,
                )
            lines.append(
                (
                    rendered,
                    absolute_index == completion_index,
                )
            )
        return lines

    def clear_completion_rows() -> None:
        nonlocal rendered_completion_rows
        if not rendered_completion_rows:
            return
        for _ in range(rendered_completion_rows):
            output_stream.write("\r\n\x1b[2K")
        output_stream.write(f"\x1b[{rendered_completion_rows}A\r")
        if last_cursor_column:
            output_stream.write(f"\x1b[{last_cursor_column}C")
        rendered_completion_rows = 0
        output_stream.flush()

    def commit_line(value: str) -> None:
        """Persist the full submitted Ask text instead of its scrolled viewport."""
        if not canvas_style and not composer:
            output_stream.write("\n")
            output_stream.flush()
            return
        canvas_width = current_canvas_width()
        prompt_width = _display_width(sanitize_terminal_text(prompt, multiline=True))
        content_width = max(1, canvas_width - prompt_width)
        rows = _terminal.wrap_display(mask_url_query_values(value), content_width) or [""]
        output_stream.write("\r\x1b[2K")
        for index, row in enumerate(rows):
            prefix = prompt if index == 0 else " " * prompt_width
            output_stream.write(painted_row(prefix + row) + "\n")
        if composer:
            # Preserve one shaded padding row and one terminal-background row
            # before Working starts. This spacing remains stable for wrapped
            # questions as well as one-line commands.
            output_stream.write(painted_row("") + "\n\n")
        output_stream.flush()

    def close_line(marker: str = "") -> None:
        """Close a cancelled composer without leaving its helper row behind."""
        clear_completion_rows()
        if marker:
            if composer and canvas_style:
                output_stream.write(canvas_style + marker + "\x1b[0m")
            else:
                output_stream.write(marker)
        output_stream.write("\n")
        if composer:
            output_stream.write(painted_row("") + "\n\n")
        output_stream.flush()

    def redraw(extra: str = "") -> None:
        nonlocal completion_index, rendered_completion_rows, last_cursor_column
        display_buffer = list(buffer)
        display_cursor = cursor
        if extra:
            display_buffer[cursor:cursor] = list(extra)
            display_cursor += len(extra)
        canvas_width = current_canvas_width()
        prompt_width = _display_width(sanitize_terminal_text(prompt, multiline=True))
        visible, cursor_column = _line_window(
            mask_url_query_values("".join(display_buffer)),
            display_cursor,
            max(8, canvas_width - prompt_width),
        )
        output_stream.write("\r\x1b[2K")
        if canvas_style:
            output_stream.write(canvas_style)
        output_stream.write(f"{prompt}{visible}")
        padding = (
            max(0, canvas_width - prompt_width - _display_width(visible)) if canvas_style else 0
        )
        if canvas_style:
            output_stream.write((" " * padding) + "\x1b[0m")
        candidates = completions() if not extra else []
        popup_lines = completion_lines(candidates, canvas_width)
        previous_rows = rendered_completion_rows
        content_rows = len(popup_lines) if popup_lines else int(composer)
        rows_below_input = content_rows + (_COMPOSER_BOTTOM_ROWS if composer else 0)
        row_count = max(previous_rows, rows_below_input)
        output_stream.write("\r")
        for index in range(row_count):
            output_stream.write("\r\n\x1b[2K")
            if index < len(popup_lines):
                line, selected = popup_lines[index]
                if canvas_style:
                    output_stream.write(canvas_style)
                if selected and use_color:
                    output_stream.write("\x1b[1m")
                output_stream.write(line)
                if canvas_style:
                    popup_padding = max(0, canvas_width - _display_width(line))
                    output_stream.write((" " * popup_padding) + "\x1b[0m")
                elif selected and use_color:
                    output_stream.write("\x1b[0m")
            elif composer and index == 0 and not popup_lines:
                hint = "  @ files · / commands · Enter send"
                hint = _truncate_display(hint, canvas_width)
                output_stream.write(painted_row(hint, dim=True))
            else:
                output_stream.write("\x1b[0m")
        if row_count:
            output_stream.write(f"\x1b[{row_count}A")
        last_cursor_column = prompt_width + cursor_column
        output_stream.write("\r")
        if last_cursor_column:
            output_stream.write(f"\x1b[{last_cursor_column}C")
        rendered_completion_rows = rows_below_input
        output_stream.flush()

    begin_composer()
    redraw()
    try:
        tty.setcbreak(descriptor)
        attributes = termios.tcgetattr(descriptor)
        attributes[3] &= ~termios.ISIG
        termios.tcsetattr(descriptor, termios.TCSANOW, attributes)
        while True:
            key = _read_terminal_key(input_stream)
            if key != _CTRL_C and input_activity is not None:
                input_activity()
            candidates = completions()
            if key == _ENTER:
                if candidates:
                    selected_completion = candidates[min(completion_index, len(candidates) - 1)]
                    current = "".join(buffer)
                    if (
                        selected_completion.value != current
                        and selected_completion.insert_text != current
                    ):
                        buffer[:] = list(selected_completion.insert_text)
                        cursor = len(buffer)
                        completion_index = 0
                        completion_suppressed = False
                        redraw()
                        continue
                clear_completion_rows()
                value = "".join(buffer).strip()
                commit_line(value)
                history_safe = mask_url_query_values(value) == value
                if (
                    history is not None
                    and history_safe
                    and value
                    and (not history or history[-1] != value)
                ):
                    history.append(value)
                return value
            if key in {"\t", _SHIFT_TAB} and candidates:
                if key == _SHIFT_TAB:
                    completion_index = (completion_index - 1) % len(candidates)
                    redraw()
                    continue
                current = "".join(buffer)
                common_prefix = os.path.commonprefix(
                    [candidate.insert_text for candidate in candidates]
                )
                if len(candidates) == 1:
                    insertion = candidates[0].insert_text
                elif len(common_prefix) > len(current):
                    insertion = common_prefix
                else:
                    insertion = candidates[completion_index].insert_text
                buffer[:] = list(insertion)
                cursor = len(buffer)
                completion_index = 0
                completion_suppressed = False
                redraw()
                continue
            if key == _UP and candidates:
                completion_index = (completion_index - 1) % len(candidates)
                redraw()
                continue
            if key == _DOWN and candidates:
                completion_index = (completion_index + 1) % len(candidates)
                redraw()
                continue
            if key == _BACKSPACE:
                if cursor:
                    del buffer[cursor - 1]
                    cursor -= 1
                completion_index = 0
                completion_suppressed = False
                redraw()
                continue
            if key == _DELETE:
                if cursor < len(buffer):
                    del buffer[cursor]
                completion_index = 0
                completion_suppressed = False
                redraw()
                continue
            if key == _LEFT:
                cursor = max(0, cursor - 1)
                completion_suppressed = False
                redraw()
                continue
            if key == _RIGHT:
                cursor = min(len(buffer), cursor + 1)
                completion_suppressed = False
                redraw()
                continue
            if key == _CTRL_A:
                cursor = 0
                completion_suppressed = False
                redraw()
                continue
            if key == _CTRL_E:
                cursor = len(buffer)
                completion_suppressed = False
                redraw()
                continue
            if key == _CTRL_L:
                clear_completion_rows()
                _terminal.clear_viewport(output_stream)
                begin_composer()
                redraw()
                continue
            if key == _CTRL_U:
                del buffer[:cursor]
                cursor = 0
                completion_index = 0
                completion_suppressed = False
                redraw()
                continue
            if key == _CTRL_W:
                while cursor and buffer[cursor - 1].isspace():
                    del buffer[cursor - 1]
                    cursor -= 1
                while cursor and not buffer[cursor - 1].isspace():
                    del buffer[cursor - 1]
                    cursor -= 1
                completion_index = 0
                completion_suppressed = False
                redraw()
                continue
            if key == _CTRL_C:
                close_line("^C")
                raise CtrlCInterrupt
            if key == _CTRL_D:
                if not buffer:
                    close_line()
                    raise EOFError
                continue
            if key == _ESCAPE:
                if candidates:
                    completion_suppressed = True
                    redraw()
                    continue
                close_line()
                raise EscapeInterrupt
            if key == _UP and history_values:
                if history_index == len(history_values):
                    draft = "".join(buffer)
                history_index = max(0, history_index - 1)
                buffer[:] = list(history_values[history_index])
                cursor = len(buffer)
                completion_index = 0
                completion_suppressed = False
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
                completion_index = 0
                completion_suppressed = False
                redraw()
                continue
            if key == _SPACE:
                buffer.insert(cursor, " ")
                cursor += 1
                completion_index = 0
                completion_suppressed = False
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
                        allow_trigger_delete=True,
                    )
                    selected_paths = picker.run()
                    if selected_paths:
                        insertion = _mention_text(selected_paths)
                        if buffer and not buffer[-1].isspace():
                            buffer.insert(cursor, " ")
                            cursor += 1
                        for char in insertion + " ":
                            buffer.insert(cursor, char)
                            cursor += 1
                    elif not picker.trigger_deleted:
                        buffer.insert(cursor, "@")
                        cursor += 1
                    completion_index = 0
                    completion_suppressed = False
                    redraw()
                    continue
                buffer.insert(cursor, key)
                cursor += 1
                completion_index = 0
                completion_suppressed = False
                redraw()
    finally:
        clear_completion_rows()
        _capture_typeahead(descriptor)
        termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)


__all__ = [
    "CtrlCInterrupt",
    "EscapeInterrupt",
    "PathPickerModel",
    "PickerEntry",
    "TerminalPathPicker",
    "read_line_with_at_picker",
    "terminal_interrupt_monitor",
]
