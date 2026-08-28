from __future__ import annotations

import pytest

from docatlas.llm.azure_responses import AzureResponsesBackend, _build_azure_client, _is_retryable
from docatlas.skills._common.llm_client import load_aux_llm_config


class _StatusError(RuntimeError):
    def __init__(self, status_code: int):
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


class _Responses:
    def __init__(self, error: Exception):
        self.error = error
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        raise self.error


def test_retry_classification() -> None:
    assert _is_retryable(_StatusError(429))
    assert _is_retryable(_StatusError(503))
    assert not _is_retryable(_StatusError(400))
    assert not _is_retryable(_StatusError(401))


def test_non_retryable_error_fails_immediately() -> None:
    responses = _Responses(_StatusError(400))
    backend = AzureResponsesBackend.__new__(AzureResponsesBackend)
    backend.max_retries = 8
    backend._client = type("Client", (), {"responses": responses})()

    with pytest.raises(_StatusError):
        backend._call_with_retry({})

    assert responses.calls == 1


def test_generic_openai_key_is_never_sent_to_azure(monkeypatch) -> None:
    import azure.identity
    import openai

    captured: dict = {}

    def fake_client(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "generic-key")  # pragma: allowlist secret
    monkeypatch.setattr(openai, "AzureOpenAI", fake_client)
    monkeypatch.setattr(azure.identity, "AzureCliCredential", lambda: object())
    monkeypatch.setattr(
        azure.identity,
        "get_bearer_token_provider",
        lambda credential, scope: "token-provider",
    )

    _build_azure_client("https://example.openai.azure.com", "test-version", 10)

    assert "api_key" not in captured
    assert captured["azure_ad_token_provider"] == "token-provider"


def test_aux_config_ignores_generic_openai_key(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_AUX_LLM_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("HARNESS_AUX_LLM_MODEL", "model")
    monkeypatch.delenv("HARNESS_AUX_LLM_API_KEY", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "generic-key")  # pragma: allowlist secret

    assert load_aux_llm_config().api_key is None
