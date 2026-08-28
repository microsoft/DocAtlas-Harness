from __future__ import annotations

from docatlas.agent.dispatch import SkillResult
from docatlas.agent.loop import AgentLoop
from docatlas.llm.base import FunctionCall, NormalizedResponse


class _Backend:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create_response(self, **kwargs):
        self.calls.append(kwargs)
        if len(self.calls) == 1:
            return NormalizedResponse(
                response_id="response-1",
                text="",
                function_calls=[
                    FunctionCall(call_id="call-1", name="read", arguments_json='{"pages":"1"}')
                ],
                input_tokens=10,
                output_tokens=2,
            )
        return NormalizedResponse(
            response_id="response-2",
            text="The answer is supported by page 1.",
            input_tokens=5,
            output_tokens=8,
        )


class _Dispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def call(self, name: str, arguments: dict) -> SkillResult:
        self.calls.append((name, arguments))
        return SkillResult(skill_name=name, ok=True, text_output="[Page 1]\nEvidence")


def test_agent_loop_dispatches_tool_and_chains_response() -> None:
    backend = _Backend()
    dispatcher = _Dispatcher()
    loop = AgentLoop(
        backend=backend,
        dispatcher=dispatcher,
        tool_schemas=[{"type": "function", "name": "read", "parameters": {}}],
        system_prompt="Use evidence.",
        max_turns=3,
    )

    result = loop.run("What happened?")

    assert result.error is None
    assert result.answer == "The answer is supported by page 1."
    assert dispatcher.calls == [("read", {"pages": "1"})]
    assert backend.calls[1]["previous_response_id"] == "response-1"
    assert backend.calls[1]["input_items"][0]["type"] == "function_call_output"
    assert result.total_input_tokens == 15
    assert result.total_output_tokens == 10


def test_agent_loop_forces_answer_on_last_turn() -> None:
    backend = _Backend()
    loop = AgentLoop(
        backend=backend,
        dispatcher=_Dispatcher(),
        tool_schemas=[],
        system_prompt="Use evidence.",
        max_turns=1,
    )

    loop.run("Question")

    assert backend.calls[0]["force_no_tools"] is True
