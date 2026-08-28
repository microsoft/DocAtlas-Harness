"""LoopCallbacks — event hooks fired by AgentLoop for UI rendering."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


def _noop(*args: Any, **kwargs: Any) -> None:
    return None


@dataclass
class LoopCallbacks:
    on_turn_start: Callable[[int], None] = field(default=_noop)
    on_tool_call: Callable[[str, str, dict], None] = field(default=_noop)
    on_tool_result: Callable[[str, str, str, float, int], None] = field(default=_noop)
    on_turn_end: Callable[[Any], None] = field(default=_noop)
    on_answer: Callable[[str], None] = field(default=_noop)
    on_reasoning: Callable[[str], None] = field(default=_noop)
