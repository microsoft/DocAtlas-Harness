from __future__ import annotations

from io import StringIO

from docatlas_dsh_sidecar.__main__ import serve
from docatlas_dsh_sidecar.protocol import (
    DOCUMENT_RPC_VERSION,
    PROTOCOL_VERSION,
    SERVICE_NAME,
    capabilities_result,
    handle_request,
)
from docatlas_dsh_sidecar.schema_validation import parse_contract, validate_contract_shape


def test_health_request() -> None:
    request = {
        "jsonrpc": "2.0",
        "id": "startup-1",
        "method": "health",
        "params": {},
    }
    assert validate_contract_shape("sidecar-envelope", request) == []
    response = handle_request(request)
    assert response == {
        "jsonrpc": "2.0",
        "id": "startup-1",
        "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "service": SERVICE_NAME,
            "status": "ok",
        },
    }
    assert validate_contract_shape("sidecar-envelope", response) == []


def test_capabilities_advertise_only_implemented_methods() -> None:
    request = {
        "jsonrpc": "2.0",
        "id": "capabilities-1",
        "method": "capabilities",
        "params": {},
    }
    response = handle_request(request)
    assert validate_contract_shape("sidecar-envelope", request) == []
    assert validate_contract_shape("sidecar-envelope", response) == []
    result = parse_contract("sidecar-capabilities", response["result"])
    assert result == capabilities_result()
    assert result["protocolVersion"] == PROTOCOL_VERSION
    assert result["documentRpcVersion"] == DOCUMENT_RPC_VERSION
    assert result["methods"] == ["health", "capabilities"]
    assert result["readModes"] == []
    assert result["providerCapabilities"] == []


def test_unknown_method_is_explicit() -> None:
    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": "request-2",
            "method": "missing",
            "params": {},
        }
    )
    assert response["error"]["code"] == -32601
    assert response["error"]["message"] == "method not found"
    assert response["error"]["data"] == {
        "schemaVersion": 1,
        "code": "not-found",
        "message": "method not found",
        "retryable": False,
        "nextActions": ["contact-operator"],
    }
    assert validate_contract_shape("sidecar-envelope", response) == []


def test_negotiation_params_must_be_empty() -> None:
    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": "request-3",
            "method": "capabilities",
            "params": {"pretend": True},
        }
    )
    assert response["error"]["code"] == -32602
    assert response["error"]["message"] == "capabilities params must be empty"
    assert response["error"]["data"]["code"] == "invalid-params"
    assert validate_contract_shape("sidecar-envelope", response) == []


def test_stdio_continues_after_parse_error() -> None:
    stdin = StringIO('{broken}\n{"jsonrpc":"2.0","id":"ok","method":"health"}\n')
    stdout = StringIO()
    serve(stdin, stdout)
    lines = stdout.getvalue().splitlines()
    assert '"code":-32700' in lines[0]
    assert '"code":"invalid-request"' in lines[0]
    assert '"id":"ok"' in lines[1]
