"""Construct the Azure Responses backend used by the harness."""

from __future__ import annotations

from typing import Any

from .base import LLMBackend


def make_backend(cfg: Any, *, max_output_tokens: int | None = None) -> LLMBackend:
    from .azure_responses import AzureResponsesBackend

    kwargs: dict[str, Any] = {
        "model": cfg.azure_deployment,
        "endpoint": cfg.azure_endpoint,
        "api_version": cfg.azure_api_version,
        "reasoning_effort": cfg.reasoning_effort,
        "reasoning_summary": cfg.reasoning_summary,
        "parallel_tool_calls": cfg.parallel_tool_calls,
        "timeout": cfg.llm_timeout_seconds,
    }
    if max_output_tokens is not None:
        kwargs["max_output_tokens"] = max_output_tokens
    return AzureResponsesBackend(**kwargs)
