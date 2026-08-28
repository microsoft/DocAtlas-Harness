"""Backend-agnostic interface for the agent loop.

The loop only knows about the abstract `LLMBackend` defined here. New
providers can implement this protocol without changing the agent loop.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class FunctionCall:
    call_id: str
    name: str
    arguments_json: str  # raw JSON string emitted by the model


@dataclass
class NormalizedResponse:
    """Backend-neutral view of a single model response."""

    response_id: str  # used for previous_response_id chaining
    text: str  # concatenated assistant message text (may be empty)
    function_calls: list[FunctionCall] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    reasoning_summary: str = ""  # optional, opaque to the loop
    raw: Any = None  # original SDK response, for trace/debug


class LLMBackend(Protocol):
    """Minimal contract the agent loop needs.

    Implementations translate between the Responses-API-style input items
    (which is the format the loop builds) and whatever their underlying
    SDK expects, then translate the response back into a NormalizedResponse.
    """

    def create_response(
        self,
        *,
        input_items: list[dict],
        tools: list[dict],
        previous_response_id: str | None,
        force_no_tools: bool = False,
    ) -> NormalizedResponse: ...
