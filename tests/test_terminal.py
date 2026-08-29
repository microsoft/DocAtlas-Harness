from __future__ import annotations

import io

from docatlas.ui.terminal import (
    KEY_CTRL_L,
    canvas_width,
    clear_viewport,
    decode_character,
    display_width,
    reserve_bottom_rows,
    terminal_theme,
    wrap_display,
)


def test_terminal_theme_supports_dark_light_auto_and_no_color(monkeypatch) -> None:
    monkeypatch.setenv("DOCATLAS_THEME", "dark")
    dark = terminal_theme(use_color=True)
    monkeypatch.setenv("DOCATLAS_THEME", "light")
    light = terminal_theme(use_color=True)
    monkeypatch.setenv("DOCATLAS_THEME", "auto")
    monkeypatch.setenv("COLORFGBG", "0;15")
    automatic = terminal_theme(use_color=True)
    no_color = terminal_theme(use_color=False)

    assert dark.name == "dark"
    assert dark.ask_background == "\x1b[48;2;30;38;48m"
    assert dark.working_background == "\x1b[48;2;17;23;30m"
    assert dark.answer_background == dark.working_background
    assert light.name == "light"
    assert light.answer_background == light.working_background
    assert automatic == light
    assert no_color.name == "none"
    assert no_color.ask_background == ""


def test_display_wrapper_preserves_wide_characters_and_width() -> None:
    rows = wrap_display("收入增长 revenue increased", 10)

    assert "".join(rows).replace(" ", "") == "收入增长revenueincreased"
    assert all(display_width(row) <= 10 for row in rows)
    assert "increased" in rows


def test_canvas_width_fills_row_without_triggering_terminal_wrap() -> None:
    assert canvas_width(160) == 159
    assert canvas_width(2) == 1
    assert canvas_width(1) == 1


def test_viewport_controls_clear_and_reserve_bottom_rows() -> None:
    stream = io.StringIO()

    clear_viewport(stream)
    reserve_bottom_rows(stream, 2)

    assert stream.getvalue() == "\x1b[2J\x1b[H\r\n\x1b[2K\n\x1b[2K\x1b[2A\r"
    assert decode_character("\x0c") == KEY_CTRL_L
