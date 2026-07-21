"""Factory that picks the right LLMBackend based on HarnessConfig.backend.

Centralized so `__main__.py` (chat) and `tasks/mmlongbench/runner.py`
agree on how to instantiate the backend, including the parameter that
each backend cares about. Avoids importing the Azure SDK if we're only
running the copilot backend (and vice-versa).
"""

from __future__ import annotations

from typing import Any

from .base import LLMBackend


def make_backend(cfg: Any, *, max_output_tokens: int | None = None) -> LLMBackend:
    """Build an LLMBackend from cfg. ``max_output_tokens`` only meaningful
    for the Azure backend; the Copilot backend reads its own cap from cfg."""
    backend = (getattr(cfg, "backend", "azure") or "azure").lower()
    if backend == "copilot":
        from .copilot_chat import CopilotChatBackend
        return CopilotChatBackend(
            model=cfg.copilot_model,
            base_url=cfg.copilot_base_url,
            api_key=cfg.copilot_api_key,
            max_tokens=cfg.copilot_max_tokens,
            parallel_tool_calls=cfg.parallel_tool_calls,
            reasoning_effort=cfg.reasoning_effort,
            reasoning_summary=cfg.reasoning_summary,
        )
    if backend == "azure":
        from .azure_responses import AzureResponsesBackend
        kwargs: dict[str, Any] = {
            "model": cfg.azure_deployment,
            "endpoint": cfg.azure_endpoint,
            "api_version": cfg.azure_api_version,
            "reasoning_effort": cfg.reasoning_effort,
            "reasoning_summary": cfg.reasoning_summary,
            "parallel_tool_calls": cfg.parallel_tool_calls,
        }
        if max_output_tokens is not None:
            kwargs["max_output_tokens"] = max_output_tokens
        return AzureResponsesBackend(**kwargs)
    raise ValueError(f"unknown backend: {backend!r} (expected 'azure' or 'copilot')")
