"""Single source of truth for interactive TUI commands and completion."""

from __future__ import annotations

import difflib
from dataclasses import dataclass


@dataclass(frozen=True)
class CommandChoice:
    value: str
    description: str


@dataclass(frozen=True)
class CommandSpec:
    name: str
    description: str
    argument_hint: str = ""
    choices: tuple[CommandChoice, ...] = ()

    @property
    def usage(self) -> str:
        return f"{self.name} {self.argument_hint}".rstrip()

    @property
    def accepts_value(self) -> bool:
        return bool(self.argument_hint or self.choices)


@dataclass(frozen=True)
class CommandCompletion:
    value: str
    insert_text: str
    description: str


COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("/add", "add local or remote PDFs", "<@path|URL>"),
    CommandSpec("/new", "replace the active document set", "<@path|URL>"),
    CommandSpec("/files", "show active documents"),
    CommandSpec(
        "/overview",
        "inspect the current session",
        "[view]",
        (
            CommandChoice("summary", "session status and recent findings"),
            CommandChoice("findings", "saved notes and evidence"),
            CommandChoice("outline", "document tree and enriched findings"),
            CommandChoice("history", "previous questions and answers"),
            CommandChoice("export", "write a private Markdown overview"),
        ),
    ),
    CommandSpec("/clear", "clear chat; keep documents and cache"),
    CommandSpec("/rebuild", "rebuild Markdown and PageIndex trees"),
    CommandSpec("/help", "show commands and keyboard shortcuts"),
    CommandSpec("/quit", "exit DocAtlas"),
)

_COMMAND_BY_NAME = {command.name: command for command in COMMANDS}
_ALIASES = {"/exit": "/quit"}


def command_completions(buffer: str) -> list[CommandCompletion]:
    """Return case-insensitive prefix matches for the current command line."""
    if not buffer.startswith("/") or "\n" in buffer:
        return []
    command, separator, remainder = buffer.partition(" ")
    command_prefix = command.casefold()
    if not separator:
        matches: list[CommandCompletion] = []
        for spec in COMMANDS:
            if not spec.name.startswith(command_prefix):
                continue
            suffix = " " if spec.accepts_value else ""
            matches.append(CommandCompletion(spec.name, spec.name + suffix, spec.description))
        return matches

    matched_spec = _COMMAND_BY_NAME.get(command_prefix)
    if matched_spec is None or not matched_spec.choices or " " in remainder.lstrip():
        return []
    value_prefix = remainder.strip().casefold()
    return [
        CommandCompletion(
            value=f"{matched_spec.name} {choice.value}",
            insert_text=f"{matched_spec.name} {choice.value}",
            description=choice.description,
        )
        for choice in matched_spec.choices
        if choice.value.startswith(value_prefix)
    ]


def is_known_command(name: str) -> bool:
    normalized = name.casefold()
    return normalized in _COMMAND_BY_NAME or normalized in _ALIASES


def command_suggestion(name: str) -> str | None:
    matches = difflib.get_close_matches(
        name.casefold(),
        [command.name for command in COMMANDS],
        n=1,
        cutoff=0.45,
    )
    return matches[0] if matches else None


def command_choice_values(name: str) -> tuple[str, ...]:
    spec = _COMMAND_BY_NAME.get(name.casefold())
    return tuple(choice.value for choice in spec.choices) if spec is not None else ()


def command_help_lines(width: int = 20) -> list[str]:
    return [f"{command.usage:<{width}} {command.description}" for command in COMMANDS]


__all__ = [
    "COMMANDS",
    "CommandChoice",
    "CommandCompletion",
    "CommandSpec",
    "command_completions",
    "command_choice_values",
    "command_help_lines",
    "command_suggestion",
    "is_known_command",
]
