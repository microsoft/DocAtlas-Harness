from __future__ import annotations

from docatlas.ui.commands import (
    command_completions,
    command_help_lines,
    command_suggestion,
    is_known_command,
)


def test_command_completion_matches_base_prefix_and_adds_argument_space() -> None:
    matches = command_completions("/ov")

    assert [(match.value, match.insert_text) for match in matches] == [("/overview", "/overview ")]


def test_command_completion_is_contextual_for_overview_views() -> None:
    all_views = command_completions("/overview ")
    finding = command_completions("/overview f")

    assert [match.value for match in all_views] == [
        "/overview summary",
        "/overview findings",
        "/overview outline",
        "/overview history",
        "/overview export",
    ]
    assert [match.insert_text for match in finding] == ["/overview findings"]


def test_command_registry_drives_help_validation_and_typo_suggestions() -> None:
    assert is_known_command("/overview") is True
    assert is_known_command("/exit") is True
    assert is_known_command("/not-a-command") is False
    assert command_suggestion("/ovrview") == "/overview"
    assert any(line.startswith("/overview [view]") for line in command_help_lines())
    assert command_completions("ordinary question") == []
