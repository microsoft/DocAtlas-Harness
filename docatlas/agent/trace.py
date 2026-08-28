"""Per-turn observability dataclasses.

The loop appends a `TurnEvent` per model turn. The CLI prints a compact
summary; richer consumers such as evaluation runners can read the full
structured trace off `AgentResult`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolCallEvent:
    call_id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    text_output: str = ""
    image_count: int = 0
    ok: bool = True


@dataclass
class TurnEvent:
    turn_num: int
    elapsed_s: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    reasoning_summary: str = ""
    text_output: str = ""
    tool_calls: list[ToolCallEvent] = field(default_factory=list)
    archived_count: int = 0


@dataclass
class AgentResult:
    answer: str = ""
    error: str | None = None
    turns: list[TurnEvent] = field(default_factory=list)
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_reasoning_tokens: int = 0
    total_elapsed_s: float = 0.0
