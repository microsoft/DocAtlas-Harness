from __future__ import annotations

import pytest

from docatlas.llm.azure_responses import AzureResponsesBackend, _is_retryable


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
