"""Minimal Azure Responses API client for SKILL CLIs that need an aux LLM.

Reads config from environment variables. The harness dispatcher injects
these; when running a SKILL standalone you can set them in your shell / .env.

Primary:
    HARNESS_AUX_LLM_ENDPOINT        Azure endpoint URL (e.g. https://xxx.openai.azure.com)
    HARNESS_AUX_LLM_API_VERSION     API version string
    HARNESS_AUX_LLM_MODEL           deployment name
    HARNESS_AUX_LLM_API_KEY (opt)   if set, used; otherwise AzureCliCredential

Fallbacks (so a standard Azure `.env` works):
    AZURE_OPENAI_ENDPOINT
    AZURE_OPENAI_API_VERSION / AZURE_API_VERSION
    AZURE_OPENAI_DEPLOYMENT
    AZURE_OPENAI_API_KEY / OPENAI_API_KEY
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuxLLMConfig:
    endpoint: str
    api_version: str
    model: str
    api_key: str | None = None


def _env_first(*names: str, default: str | None = None) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


def load_aux_llm_config() -> AuxLLMConfig:
    endpoint = _env_first("HARNESS_AUX_LLM_ENDPOINT", "AZURE_OPENAI_ENDPOINT", default="")
    api_version = (
        _env_first(
            "HARNESS_AUX_LLM_API_VERSION",
            "AZURE_OPENAI_API_VERSION",
            "AZURE_API_VERSION",
            default="2025-04-01-preview",
        )
        or "2025-04-01-preview"
    )
    model = _env_first(
        "HARNESS_AUX_LLM_MODEL",
        "AZURE_OPENAI_DEPLOYMENT",
    )
    api_key = _env_first("HARNESS_AUX_LLM_API_KEY", "AZURE_OPENAI_API_KEY", "OPENAI_API_KEY")
    if not endpoint:
        raise RuntimeError(
            "No Azure endpoint configured. Set HARNESS_AUX_LLM_ENDPOINT or AZURE_OPENAI_ENDPOINT."
        )
    if not model:
        raise RuntimeError(
            "No aux LLM model configured. Set HARNESS_AUX_LLM_MODEL or AZURE_OPENAI_DEPLOYMENT."
        )
    return AuxLLMConfig(endpoint=endpoint, api_version=api_version, model=model, api_key=api_key)


def build_azure_client(cfg: AuxLLMConfig | None = None):
    """Return an `openai.AzureOpenAI` client built from env config.

    Prefers API-key auth if provided; falls back to AzureCliCredential.
    """
    if cfg is None:
        cfg = load_aux_llm_config()
    from openai import AzureOpenAI

    try:
        timeout = max(1.0, float(os.getenv("HARNESS_AUX_LLM_TIMEOUT_SECONDS", "120")))
    except ValueError:
        timeout = 120.0

    if cfg.api_key:
        return AzureOpenAI(
            azure_endpoint=cfg.endpoint,
            api_key=cfg.api_key,
            api_version=cfg.api_version,
            max_retries=0,
            timeout=timeout,
        )
    from azure.identity import AzureCliCredential, get_bearer_token_provider

    credential = AzureCliCredential()
    token_provider = get_bearer_token_provider(
        credential, "https://cognitiveservices.azure.com/.default"
    )
    return AzureOpenAI(
        azure_endpoint=cfg.endpoint,
        azure_ad_token_provider=token_provider,
        api_version=cfg.api_version,
        max_retries=0,
        timeout=timeout,
    )


def call_responses(
    system: str,
    user: str,
    *,
    cfg: AuxLLMConfig | None = None,
    max_output_tokens: int | None = 2000,
    reasoning_effort: str = "low",
) -> str:
    """Send a minimal two-message prompt through Azure Responses API, return text.

    Kept deliberately narrow — SKILLs that need richer interaction can call
    `build_azure_client` themselves.
    """
    cfg = cfg or load_aux_llm_config()
    client = build_azure_client(cfg)
    kwargs: dict = {
        "model": cfg.model,
        "input": [
            {"role": "developer", "content": system},
            {"role": "user", "content": user},
        ],
        "reasoning": {"effort": reasoning_effort, "summary": "auto"},
    }
    if max_output_tokens is not None:
        kwargs["max_output_tokens"] = max_output_tokens
    response = None
    for attempt in range(3):
        try:
            response = client.responses.create(**kwargs)
            break
        except Exception as exc:  # noqa: BLE001
            status = getattr(exc, "status_code", None)
            retryable = (
                isinstance(exc, (ConnectionError, TimeoutError, OSError))
                or (isinstance(status, int) and (status in {408, 409, 429} or status >= 500))
                or any(marker in type(exc).__name__.lower() for marker in ("connection", "timeout"))
            )
            if not retryable or attempt == 2:
                raise
            wait_seconds = min(4, 2**attempt)
            logger.warning(
                "Auxiliary Azure call failed; retrying in %ss (%s/3): %s",
                wait_seconds,
                attempt + 1,
                exc,
            )
            time.sleep(wait_seconds)
    if response is None:  # defensive; every failure path above raises
        raise RuntimeError("Auxiliary Azure call returned no response")
    text = ""
    for item in getattr(response, "output", []) or []:
        if getattr(item, "type", None) == "message":
            for c in getattr(item, "content", []) or []:
                t = getattr(c, "text", None)
                if t:
                    text += t
    return text


__all__ = ["AuxLLMConfig", "load_aux_llm_config", "build_azure_client", "call_responses"]
