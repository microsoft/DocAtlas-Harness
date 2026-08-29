from __future__ import annotations

import io
import os
import pty
import signal
import termios
import threading
import time
import tty
from collections.abc import Callable
from pathlib import Path

import pytest

from docatlas.ui import path_picker as picker_module
from docatlas.ui.commands import CommandCompletion, command_completions
from docatlas.ui.path_picker import PathPickerModel, TerminalPathPicker


def _pdf(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-picker-fixture")
    return path


def _index(model: PathPickerModel, label: str) -> int:
    return next(index for index, entry in enumerate(model.entries) if entry.label == label)


class _VirtualTerminal:
    """Tiny VT100 screen model for picker redraw regression tests."""

    encoding = "utf-8"

    def __init__(self, initial_line: str = "") -> None:
        self.lines: list[list[str]] = [list(initial_line)]
        self.row = 0
        self.column = len(initial_line)
        self.raw: list[str] = []

    def _ensure_row(self) -> None:
        while len(self.lines) <= self.row:
            self.lines.append([])

    def write(self, value: str) -> int:
        self.raw.append(value)
        index = 0
        while index < len(value):
            if value.startswith("\x1b[", index):
                end = index + 2
                while end < len(value) and not ("@" <= value[end] <= "~"):
                    end += 1
                if end >= len(value):
                    break
                parameters = value[index + 2 : end]
                command = value[end]
                numeric = parameters.lstrip("?").split(";", maxsplit=1)[0]
                amount = int(numeric) if numeric.isdigit() else 1
                if command == "A":
                    self.row = max(0, self.row - amount)
                elif command == "B":
                    self.row += amount
                    self._ensure_row()
                elif command == "C":
                    self.column += amount
                elif command == "D":
                    self.column = max(0, self.column - amount)
                elif command == "K" and amount == 2:
                    self.lines[self.row] = []
                    self.column = 0
                index = end + 1
                continue
            char = value[index]
            if char == "\r":
                self.column = 0
            elif char == "\n":
                self.row += 1
                self._ensure_row()
            else:
                self._ensure_row()
                line = self.lines[self.row]
                while len(line) < self.column:
                    line.append(" ")
                if self.column < len(line):
                    line[self.column] = char
                else:
                    line.append(char)
                self.column += 1
            index += 1
        return len(value)

    def flush(self) -> None:
        return

    def snapshot(self) -> str:
        rows = ["".join(line).rstrip() for line in self.lines]
        while rows and not rows[-1]:
            rows.pop()
        return "\n".join(rows)


def test_picker_model_navigates_directories_and_tracks_multiple_files(tmp_path: Path) -> None:
    first = _pdf(tmp_path / "one.pdf")
    second = _pdf(tmp_path / "two.pdf")
    nested = _pdf(tmp_path / "reports" / "nested.pdf")
    model = PathPickerModel(tmp_path)

    model.index = _index(model, "one.pdf")
    model.toggle_active()
    model.index = _index(model, "two.pdf")
    model.toggle_active()
    assert model.selected == [first.resolve(), second.resolve()]

    model.index = _index(model, "reports/")
    assert model.active is not None
    model.enter_directory(model.active.path)
    assert model.current_dir == nested.parent.resolve()
    assert any(entry.label == "nested.pdf" for entry in model.entries)
    model.go_parent()
    assert model.current_dir == tmp_path.resolve()


def test_picker_hides_terminal_control_filenames(tmp_path: Path) -> None:
    _pdf(tmp_path / "safe.pdf")
    _pdf(tmp_path / "unsafe\x1b[31m.pdf")

    model = PathPickerModel(tmp_path)

    assert any(entry.label == "safe.pdf" for entry in model.entries)
    assert not any("unsafe" in entry.label for entry in model.entries)


def test_terminal_picker_space_selects_and_enter_finishes(tmp_path: Path, monkeypatch) -> None:
    first = _pdf(tmp_path / "one.pdf")
    second = _pdf(tmp_path / "two.pdf")
    output = io.StringIO()
    picker = TerminalPathPicker(
        start_dir=tmp_path,
        input_stream=io.StringIO(),
        output_stream=output,
        use_unicode=True,
        use_color=False,
    )
    picker.model.index = _index(picker.model, "one.pdf")
    keys = iter(["SPACE", "DOWN", "ENTER"])
    monkeypatch.setattr(picker_module, "_read_terminal_key", lambda stream: next(keys))

    selected = picker.run()

    assert selected == [first.resolve(), second.resolve()]
    assert "@ files" in output.getvalue()
    assert "Space mark" in output.getvalue()


def test_terminal_picker_redraws_one_frame_in_place(tmp_path: Path, monkeypatch) -> None:
    nested = tmp_path / "data"
    _pdf(nested / "nested.pdf")
    _pdf(tmp_path / "root.pdf")
    output = _VirtualTerminal("› @")
    picker = TerminalPathPicker(
        start_dir=tmp_path,
        input_stream=io.StringIO(),
        output_stream=output,  # type: ignore[arg-type]
        use_unicode=True,
        use_color=False,
    )
    picker.model.index = _index(picker.model, "data/")
    keys = iter(["ENTER", "DOWN", "UP", "ESCAPE"])
    frames: list[str] = []

    def next_key(stream) -> str:
        del stream
        frames.append(output.snapshot())
        return next(keys)

    monkeypatch.setattr(picker_module, "_read_terminal_key", next_key)

    assert picker.run() == []
    assert len(frames) == 4
    assert all(frame.count("@ files") == 1 for frame in frames)
    assert "root.pdf" in frames[0]
    assert all("root.pdf" not in frame for frame in frames[1:])
    terminal_output = "".join(output.raw)
    assert "\x1b[s" not in terminal_output
    assert "\x1b[u" not in terminal_output
    assert output.snapshot() == "› @"


def test_terminal_picker_clears_rows_when_listing_shrinks(tmp_path: Path, monkeypatch) -> None:
    nested = tmp_path / "small"
    _pdf(nested / "only.pdf")
    for number in range(7):
        _pdf(tmp_path / f"root-only-{number}.pdf")
    output = _VirtualTerminal("› @")
    picker = TerminalPathPicker(
        start_dir=tmp_path,
        input_stream=io.StringIO(),
        output_stream=output,  # type: ignore[arg-type]
        use_unicode=True,
        use_color=False,
    )
    picker.model.index = _index(picker.model, "small/")
    keys = iter(["ENTER", "ESCAPE"])
    frames: list[str] = []

    def next_key(stream) -> str:
        del stream
        frames.append(output.snapshot())
        return next(keys)

    monkeypatch.setattr(picker_module, "_read_terminal_key", next_key)

    assert picker.run() == []
    assert any("root-only-6.pdf" in frame for frame in frames[:1])
    assert "only.pdf" in frames[1]
    assert "root-only-" not in frames[1]
    assert frames[1].count("@ files") == 1


def test_picker_layout_fits_narrow_terminal_and_chinese_names(tmp_path: Path, monkeypatch) -> None:
    directory = tmp_path / "中文资料"
    for number in range(8):
        _pdf(directory / f"第{number}份非常长的报告.pdf")
    picker = TerminalPathPicker(
        start_dir=directory,
        input_stream=io.StringIO(),
        output_stream=io.StringIO(),
        use_unicode=True,
        use_color=False,
    )
    monkeypatch.setattr(
        picker_module,
        "_terminal_size",
        lambda stream: os.terminal_size((24, 10)),
    )

    lines = picker._lines()

    assert len(lines) <= 9
    assert all(picker_module._display_width(line) <= 23 for line in lines)
    assert any("报告" in line for line in lines)


def test_picker_dividers_span_a_wide_terminal(tmp_path: Path, monkeypatch) -> None:
    _pdf(tmp_path / "report.pdf")
    picker = TerminalPathPicker(
        start_dir=tmp_path,
        input_stream=io.StringIO(),
        output_stream=io.StringIO(),
        use_unicode=True,
        use_color=False,
    )
    monkeypatch.setattr(
        picker_module,
        "_terminal_size",
        lambda stream: os.terminal_size((160, 24)),
    )

    lines = picker._lines()

    assert lines[1] == "─" * 159
    assert lines[-2] == "─" * 159


def test_terminal_picker_can_select_current_folder(tmp_path: Path, monkeypatch) -> None:
    output = io.StringIO()
    picker = TerminalPathPicker(
        start_dir=tmp_path,
        input_stream=io.StringIO(),
        output_stream=output,
        use_unicode=False,
        use_color=False,
    )
    monkeypatch.setattr(picker_module, "_read_terminal_key", lambda stream: "f")

    assert picker.run() == [tmp_path.resolve()]


def test_picker_helpers_quote_paths_and_limit_trigger_context(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    spaced = _pdf(tmp_path / "annual report.pdf")

    assert picker_module._mention_text([spaced]) == "@'annual report.pdf'"
    assert picker_module._buffer_accepts_picker("") is True
    assert picker_module._buffer_accepts_picker("@one.pdf ") is True
    assert picker_module._buffer_accepts_picker("/add ") is True
    assert picker_module._buffer_accepts_picker("email user") is False


def test_line_window_scrolls_without_exceeding_terminal_width() -> None:
    value = "前缀-" + "abcdefghij" * 5 + "-结尾"

    visible, cursor = picker_module._line_window(value, len(value), 20)
    middle_visible, middle_cursor = picker_module._line_window(value, 15, 20)

    assert picker_module._display_width(visible) <= 20
    assert visible.startswith("…")
    assert visible.endswith("结尾")
    assert cursor == picker_module._display_width(visible)
    assert picker_module._display_width(middle_visible) <= 20
    assert 0 <= middle_cursor <= picker_module._display_width(middle_visible)
    assert picker_module._truncate_display("中文路径abcdefgh", 10) == "中文路径a…"


def test_terminal_key_reader_keeps_arrow_sequences_and_unicode_intact() -> None:
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    tty.setcbreak(stream.fileno())
    try:
        os.write(master, b"\x1b[B\x1b[A\x1b[5~\x1b[6~\x1b[Z" + "中".encode())

        assert picker_module._read_terminal_key(stream) == "DOWN"
        assert picker_module._read_terminal_key(stream) == "UP"
        assert picker_module._read_terminal_key(stream) == "PAGE_UP"
        assert picker_module._read_terminal_key(stream) == "PAGE_DOWN"
        assert picker_module._read_terminal_key(stream) == "SHIFT_TAB"
        assert picker_module._read_terminal_key(stream) == "中"
    finally:
        stream.close()
        os.close(master)


def _drive_line(
    payload: bytes,
    history: list[str] | None = None,
    input_activity: Callable[[], None] | None = None,
    completion_provider: Callable[[str], list[CommandCompletion]] | None = None,
    canvas_style: str = "",
    composer: bool = False,
) -> tuple[str | None, BaseException | None, str]:
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = io.StringIO()
    result: list[str] = []
    errors: list[BaseException] = []

    def target() -> None:
        try:
            result.append(
                picker_module.read_line_with_at_picker(
                    "› Ask #5 ",
                    input_stream=stream,
                    output_stream=output,
                    use_unicode=True,
                    use_color=False,
                    history=history,
                    input_activity=input_activity,
                    completion_provider=completion_provider,
                    canvas_style=canvas_style,
                    composer=composer,
                )
            )
        except BaseException as exc:  # noqa: BLE001 - captured for the driving test
            errors.append(exc)

    thread = threading.Thread(target=target)
    thread.start()
    deadline = time.monotonic() + 1
    while "Ask #5" not in output.getvalue() and time.monotonic() < deadline:
        time.sleep(0.005)
    time.sleep(0.02)
    os.write(master, payload)
    thread.join(timeout=2)
    if thread.is_alive():
        os.close(master)
        thread.join(timeout=1)
        raise AssertionError("line editor did not finish")
    stream.close()
    os.close(master)
    return (result[0] if result else None, errors[0] if errors else None, output.getvalue())


def test_line_editor_backspace_never_erases_prompt() -> None:
    result, error, output = _drive_line(b"question" + b"\x7f" * 30 + b"x\r")

    assert error is None
    assert result == "x"
    assert "\x1b[2K› Ask #5 x" in output


def test_line_editor_handles_unicode_and_cursor_edits() -> None:
    payload = "你好吗".encode() + b"\x1b[D\x7f" + "很".encode() + b"\r"
    result, error, _ = _drive_line(payload)

    assert error is None
    assert result == "你很吗"


def test_line_editor_masks_remote_url_query_but_returns_original_value() -> None:
    history: list[str] = []
    result, error, output = _drive_line(
        b"https://example.com/report.pdf?token=do-not-echo\r",
        history,
        canvas_style="\x1b[48;2;30;38;48m",
    )

    assert error is None
    assert result == "https://example.com/report.pdf?token=do-not-echo"
    assert "do-not-echo" not in output
    assert "report.pdf?" in output
    assert history == []


def test_composer_fills_wide_terminal_and_preserves_vertical_spacing(monkeypatch) -> None:
    monkeypatch.setattr(
        picker_module,
        "_terminal_size",
        lambda stream: os.terminal_size((160, 24)),
    )
    background = "\x1b[48;2;30;38;48m"

    result, error, output = _drive_line(
        b"question\r",
        canvas_style=background,
        composer=True,
    )

    width = 159
    submitted = "› Ask #5 question"
    blank_row = background + (" " * width) + "\x1b[0m"
    assert error is None
    assert result == "question"
    assert ("─" * width) in output
    assert blank_row in output
    assert (
        background
        + submitted
        + (" " * (width - picker_module._display_width(submitted)))
        + "\x1b[0m\n"
    ) in output
    assert output.endswith(blank_row + "\n\n")


def test_composer_keeps_structure_without_color(monkeypatch) -> None:
    monkeypatch.setattr(
        picker_module,
        "_terminal_size",
        lambda stream: os.terminal_size((36, 12)),
    )

    result, error, output = _drive_line(b"hello\r", composer=True)

    assert error is None
    assert result == "hello"
    assert ("─" * 35) in output
    assert "@ files · / commands · Enter send" in output
    assert "\x1b[48;" not in output
    assert output.endswith("\n\n")


def test_composer_completion_and_cancel_restore_the_layout(monkeypatch) -> None:
    monkeypatch.setattr(
        picker_module,
        "_terminal_size",
        lambda stream: os.terminal_size((48, 12)),
    )
    background = "\x1b[48;2;30;38;48m"

    completed, completion_error, completion_output = _drive_line(
        b"/ov\tf\t\r",
        completion_provider=command_completions,
        canvas_style=background,
        composer=True,
    )
    _, cancel_error, cancel_output = _drive_line(
        b"draft\x03",
        canvas_style=background,
        composer=True,
    )

    blank_row = background + (" " * 47) + "\x1b[0m"
    assert completion_error is None
    assert completed == "/overview findings"
    assert "inspect the current session" in completion_output
    assert "saved notes and evidence" in completion_output
    assert isinstance(cancel_error, picker_module.CtrlCInterrupt)
    assert "^C" in cancel_output
    assert cancel_output.endswith(blank_row + "\n\n")


def test_line_editor_supports_shell_editing_shortcuts() -> None:
    word_result, word_error, _ = _drive_line(b"one two\x17three\r")
    clear_result, clear_error, _ = _drive_line(b"discard\x15keep\r")
    cursor_result, cursor_error, _ = _drive_line(b"abc\x01\x1b[3~\x05x\r")

    assert word_error is None
    assert word_result == "one three"
    assert clear_error is None
    assert clear_result == "keep"
    assert cursor_error is None
    assert cursor_result == "bcx"


def test_line_editor_completes_command_and_context_with_tab() -> None:
    result, error, output = _drive_line(b"/ov\tf\t\r", completion_provider=command_completions)

    assert error is None
    assert result == "/overview findings"
    assert "inspect the current session" in output
    assert "saved notes and evidence" in output

    exact, exact_error, _ = _drive_line(b"/overview\r", completion_provider=command_completions)
    assert exact_error is None
    assert exact == "/overview"


def test_line_editor_arrow_selects_completion_and_escape_closes_popup() -> None:
    selected, selected_error, _ = _drive_line(
        b"/overview \x1b[B\r\r", completion_provider=command_completions
    )
    partial, partial_error, _ = _drive_line(b"/ov\x1b\r", completion_provider=command_completions)

    assert selected_error is None
    assert selected == "/overview findings"
    assert partial_error is None
    assert partial == "/ov"


def test_command_popup_replaces_candidates_and_clears_after_submit(monkeypatch) -> None:
    monkeypatch.setattr(
        picker_module,
        "_terminal_size",
        lambda stream: os.terminal_size((48, 12)),
    )
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = _VirtualTerminal()
    result: list[str] = []
    errors: list[BaseException] = []

    def target() -> None:
        try:
            result.append(
                picker_module.read_line_with_at_picker(
                    "› ",
                    input_stream=stream,
                    output_stream=output,  # type: ignore[arg-type]
                    use_unicode=True,
                    use_color=False,
                    completion_provider=command_completions,
                )
            )
        except BaseException as exc:  # noqa: BLE001 - captured for PTY assertion
            errors.append(exc)

    def wait_for(text: str) -> None:
        deadline = time.monotonic() + 1
        while text not in output.snapshot() and time.monotonic() < deadline:
            time.sleep(0.005)
        assert text in output.snapshot()

    thread = threading.Thread(target=target)
    thread.start()
    try:
        wait_for("›")
        time.sleep(0.02)
        os.write(master, b"/")
        wait_for("/add")
        os.write(master, b"ov")
        deadline = time.monotonic() + 1
        while (
            not output.snapshot().startswith("› /ov") or "/add" in output.snapshot()
        ) and time.monotonic() < deadline:
            time.sleep(0.005)
        narrowed = output.snapshot()
        assert narrowed.startswith("› /ov")
        assert narrowed.count("/overview") == 1
        assert "/add" not in narrowed
        assert all(picker_module._display_width(line) <= 47 for line in narrowed.splitlines())
        os.write(master, b"\tf\t\r")
        thread.join(timeout=2)
        assert not thread.is_alive()
    finally:
        if thread.is_alive():
            os.close(master)
            thread.join(timeout=1)
        stream.close()
        try:
            os.close(master)
        except OSError:
            pass

    assert errors == []
    assert result == ["/overview findings"]
    assert output.snapshot() == "› /overview findings"


def test_at_keystroke_opens_picker_and_inserts_selection() -> None:
    result, error, output = _drive_line(b"@f\r")

    assert error is None
    assert result == "@."
    assert "@ files" in output


def test_pty_directory_navigation_replaces_picker_and_restores_prompt(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _pdf(tmp_path / "root-only.pdf")
    _pdf(tmp_path / "data" / "nested.pdf")
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = _VirtualTerminal()
    result: list[str] = []
    errors: list[BaseException] = []

    def target() -> None:
        try:
            result.append(
                picker_module.read_line_with_at_picker(
                    "› ",
                    input_stream=stream,
                    output_stream=output,  # type: ignore[arg-type]
                    use_unicode=True,
                    use_color=False,
                )
            )
        except BaseException as exc:  # noqa: BLE001 - captured for the PTY test
            errors.append(exc)

    def wait_for(predicate) -> None:
        deadline = time.monotonic() + 1
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.005)
        assert predicate()

    thread = threading.Thread(target=target)
    thread.start()
    try:
        wait_for(lambda: output.snapshot().startswith("›"))
        # The first paint precedes the cbreak transition by a few instructions.
        # Let the reader own the PTY before injecting the first keystroke.
        time.sleep(0.02)
        os.write(master, b"@")
        wait_for(lambda: "@ files" in output.snapshot())
        os.write(master, b"\x1b[B\r")
        wait_for(lambda: "nested.pdf" in output.snapshot())
        nested_frame = output.snapshot()
        assert nested_frame.count("@ files") == 1
        assert "root-only.pdf" not in nested_frame

        os.write(master, b"\x1b\x15done\r")
        thread.join(timeout=2)
        assert not thread.is_alive()
    finally:
        if thread.is_alive():
            os.close(master)
            thread.join(timeout=1)
        stream.close()
        try:
            os.close(master)
        except OSError:
            pass

    assert errors == []
    assert result == ["done"]
    assert "@ files" not in output.snapshot()
    assert output.snapshot().startswith("› done")


def test_line_editor_escape_and_ctrl_c_cancel_cleanly() -> None:
    _, escape_error, _ = _drive_line(b"draft\x1b")
    _, ctrl_c_error, _ = _drive_line(b"draft\x03")

    assert isinstance(escape_error, picker_module.EscapeInterrupt)
    assert isinstance(ctrl_c_error, picker_module.CtrlCInterrupt)


def test_line_editor_reports_non_ctrl_c_activity() -> None:
    activity: list[str] = []
    _, error, _ = _drive_line(b"x\x03", input_activity=lambda: activity.append("key"))

    assert isinstance(error, picker_module.CtrlCInterrupt)
    assert activity == ["key"]


def test_line_editor_ctrl_d_reports_eof() -> None:
    result, error, _ = _drive_line(b"\x04")

    assert result is None
    assert isinstance(error, EOFError)


def test_line_editor_preserves_typeahead_for_next_prompt() -> None:
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = io.StringIO()

    def send() -> None:
        time.sleep(0.03)
        os.write(master, b"first\rsecond\r")

    sender = threading.Thread(target=send)
    sender.start()
    try:
        first = picker_module.read_line_with_at_picker(
            "first> ", input_stream=stream, output_stream=output, use_color=False
        )
        second = picker_module.read_line_with_at_picker(
            "second> ", input_stream=stream, output_stream=output, use_color=False
        )
    finally:
        sender.join(timeout=1)
        stream.close()
        os.close(master)

    assert first == "first"
    assert second == "second"


def test_enter_then_escape_typeahead_reaches_turn_monitor(monkeypatch) -> None:
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = io.StringIO()
    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(os, "kill", lambda process, sig: calls.append((process, sig)))

    def send() -> None:
        time.sleep(0.03)
        os.write(master, b"run\r\x1b")

    sender = threading.Thread(target=send)
    sender.start()
    try:
        assert (
            picker_module.read_line_with_at_picker(
                "prompt> ", input_stream=stream, output_stream=output, use_color=False
            )
            == "run"
        )
        with picker_module.terminal_interrupt_monitor(stream):
            deadline = time.monotonic() + 1
            while not calls and time.monotonic() < deadline:
                time.sleep(0.01)
    finally:
        sender.join(timeout=1)
        stream.close()
        os.close(master)

    assert calls == [(os.getpid(), signal.SIGINT)]


def test_escape_preserves_immediately_following_command() -> None:
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = io.StringIO()

    def send() -> None:
        time.sleep(0.03)
        os.write(master, b"draft\x1b/quit\r")

    sender = threading.Thread(target=send)
    sender.start()
    try:
        with pytest.raises(KeyboardInterrupt):
            picker_module.read_line_with_at_picker(
                "first> ", input_stream=stream, output_stream=output, use_color=False
            )
        command = picker_module.read_line_with_at_picker(
            "second> ", input_stream=stream, output_stream=output, use_color=False
        )
    finally:
        sender.join(timeout=1)
        stream.close()
        os.close(master)

    assert command == "/quit"


def test_line_editor_up_and_down_restore_question_history() -> None:
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    output = io.StringIO()
    history = ["first question", "second question"]

    def send() -> None:
        time.sleep(0.03)
        os.write(master, b"draft\x1b[A\x1b[A\x1b[B\r")

    sender = threading.Thread(target=send)
    sender.start()
    try:
        result = picker_module.read_line_with_at_picker(
            "prompt> ",
            input_stream=stream,
            output_stream=output,
            use_color=False,
            history=history,
        )
    finally:
        sender.join(timeout=1)
        stream.close()
        os.close(master)

    assert result == "second question"
    assert history == ["first question", "second question"]


def test_turn_monitor_maps_escape_to_sigint_and_restores_terminal(
    monkeypatch,
) -> None:
    master, slave = pty.openpty()
    stream = os.fdopen(slave, "r", encoding="utf-8", closefd=True)
    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(os, "kill", lambda process, sig: calls.append((process, sig)))
    before = termios.tcgetattr(stream.fileno())
    try:
        with picker_module.terminal_interrupt_monitor(stream):
            os.write(master, b"\x1b[B")
            time.sleep(0.1)
            assert calls == []
            os.write(master, b"\x1b")
            deadline = time.monotonic() + 1
            while not calls and time.monotonic() < deadline:
                time.sleep(0.01)
        after = termios.tcgetattr(stream.fileno())
    finally:
        stream.close()
        os.close(master)

    assert after == before
    assert calls == [(os.getpid(), signal.SIGINT)]
