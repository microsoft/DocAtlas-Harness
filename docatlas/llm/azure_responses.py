"""Azure Responses API backend.

Wraps `openai.AzureOpenAI` in the `LLMBackend` protocol. Auth prefers
`AZURE_OPENAI_API_KEY` if present, otherwise falls back to
`AzureCliCredential` + a bearer-token provider.

Multi-turn chaining is server-side via `previous_response_id`. On chained
turns we send only the new input items (tool results + any image follow-up),
matching the behaviour of `ResponsesAPIAgent.run`.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from .base import FunctionCall, LLMBackend, NormalizedResponse

logger = logging.getLogger(__name__)


def _is_retryable(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status in {408, 409, 429} or status >= 500
    name = type(exc).__name__.lower()
    return isinstance(exc, (ConnectionError, TimeoutError, OSError)) or any(
        marker in name for marker in ("connection", "timeout")
    )


def _retry_after_seconds(exc: Exception) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    value = headers.get("retry-after")
    try:
        return max(0.0, float(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


def _build_azure_client(endpoint: str, api_version: str, timeout: float):
    # Imported lazily so importing this module doesn't require openai/azure-identity.
    from openai import AzureOpenAI

    api_key = os.getenv("AZURE_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if api_key:
        return AzureOpenAI(
            azure_endpoint=endpoint,
            api_key=api_key,
            api_version=api_version,
            max_retries=0,
            timeout=timeout,
        )
    from azure.identity import AzureCliCredential, get_bearer_token_provider

    credential = AzureCliCredential()
    token_provider = get_bearer_token_provider(
        credential, "https://cognitiveservices.azure.com/.default"
    )
    return AzureOpenAI(
        azure_endpoint=endpoint,
        azure_ad_token_provider=token_provider,
        api_version=api_version,
        max_retries=0,
        timeout=timeout,
    )


class AzureResponsesBackend(LLMBackend):
    """Azure Responses API implementation of LLMBackend."""

    def __init__(
        self,
        *,
        model: str,
        endpoint: str,
        api_version: str,
        reasoning_effort: str = "high",
        reasoning_summary: str = "detailed",
        parallel_tool_calls: bool = False,
        max_output_tokens: int | None = None,
        max_retries: int = 8,
        timeout: float = 120.0,
    ):
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.reasoning_summary = reasoning_summary
        self.parallel_tool_calls = parallel_tool_calls
        self.max_output_tokens = max_output_tokens
        self.max_retries = max_retries
        self._client = _build_azure_client(endpoint, api_version, timeout)

    def create_response(
        self,
        *,
        input_items: list[dict],
        tools: list[dict],
        previous_response_id: str | None,
        force_no_tools: bool = False,
    ) -> NormalizedResponse:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "input": input_items,
            "tools": tools,
            "tool_choice": "none" if force_no_tools else "auto",
            "parallel_tool_calls": self.parallel_tool_calls,
            "reasoning": {
                "effort": self.reasoning_effort,
                "summary": self.reasoning_summary,
            },
        }
        if self.max_output_tokens is not None:
            kwargs["max_output_tokens"] = self.max_output_tokens
        if previous_response_id:
            kwargs["previous_response_id"] = previous_response_id

        response = self._call_with_retry(kwargs)
        return self._normalize(response)

    def _call_with_retry(self, kwargs: dict[str, Any]):
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                return self._client.responses.create(**kwargs)
            except Exception as e:  # noqa: BLE001
                last_exc = e
                if attempt >= self.max_retries or not _is_retryable(e):
                    break
                retry_after = _retry_after_seconds(e)
                wait_s = retry_after if retry_after is not None else min(30, 2 ** (attempt - 1))
                logger.warning(
                    "Azure Responses API error (attempt %s/%s); retrying in %ss: %s",
                    attempt,
                    self.max_retries,
                    wait_s,
                    e,
                )
                time.sleep(wait_s)
        if last_exc is None:
            raise RuntimeError("Azure request loop exited without a response or exception")
        raise last_exc

    @staticmethod
    def _normalize(response: Any) -> NormalizedResponse:
        text = ""
        function_calls: list[FunctionCall] = []
        reasoning_summary = ""

        for item in getattr(response, "output", []) or []:
            itype = getattr(item, "type", None)
            if itype == "function_call":
                call_id = getattr(item, "call_id", None) or getattr(item, "id", "")
                function_calls.append(
                    FunctionCall(
                        call_id=str(call_id),
                        name=getattr(item, "name", ""),
                        arguments_json=getattr(item, "arguments", "") or "",
                    )
                )
            elif itype == "message":
                for c in getattr(item, "content", []) or []:
                    t = getattr(c, "text", None)
                    if t:
                        text += t
            elif itype == "reasoning":
                for s in getattr(item, "summary", []) or []:
                    t = getattr(s, "text", None)
                    if t:
                        reasoning_summary += t + "\n"

        usage = getattr(response, "usage", None)
        input_tokens = getattr(usage, "input_tokens", 0) if usage else 0
        output_tokens = getattr(usage, "output_tokens", 0) if usage else 0
        reasoning_tokens = 0
        if usage and getattr(usage, "output_tokens_details", None):
            reasoning_tokens = getattr(usage.output_tokens_details, "reasoning_tokens", 0) or 0

        return NormalizedResponse(
            response_id=getattr(response, "id", ""),
            text=text,
            function_calls=function_calls,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=reasoning_tokens,
            reasoning_summary=reasoning_summary,
            raw=response,
        )
