from __future__ import annotations

import io
import os
import pty
import signal
import termios
import threading
import time
import tty
from pathlib import Path

import pytest

from docatlas.ui import path_picker as picker_module
from docatlas.ui.path_picker import PathPickerModel, TerminalPathPicker


def _pdf(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-picker-fixture")
    return path


def _index(model: PathPickerModel, label: str) -> int:
    return next(index for index, entry in enumerate(model.entries) if entry.label == label)


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
    assert "Space multi" in output.getvalue()


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
        os.write(master, b"\x1b[B\x1b[A" + "中".encode())

        assert picker_module._read_terminal_key(stream) == "DOWN"
        assert picker_module._read_terminal_key(stream) == "UP"
        assert picker_module._read_terminal_key(stream) == "中"
    finally:
        stream.close()
        os.close(master)


def _drive_line(payload: bytes) -> tuple[str | None, BaseException | None, str]:
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


def test_at_keystroke_opens_picker_and_inserts_selection() -> None:
    result, error, output = _drive_line(b"@f\r")

    assert error is None
    assert result == "@."
    assert "@ files" in output


def test_line_editor_escape_and_ctrl_c_cancel_cleanly() -> None:
    _, escape_error, _ = _drive_line(b"draft\x1b")
    _, ctrl_c_error, _ = _drive_line(b"draft\x03")

    assert isinstance(escape_error, KeyboardInterrupt)
    assert isinstance(ctrl_c_error, KeyboardInterrupt)


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
