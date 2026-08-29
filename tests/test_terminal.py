from __future__ import annotations

from docatlas.ui.terminal import display_width, terminal_theme, wrap_display


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
