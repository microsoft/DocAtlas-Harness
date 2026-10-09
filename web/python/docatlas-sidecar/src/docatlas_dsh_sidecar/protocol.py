"""Versioned JSON-RPC protocol owned by the document sidecar."""

from __future__ import annotations

import platform
from importlib.metadata import PackageNotFoundError, version
from typing import Final, cast

from .document_rpc import IngestRequest, ReadRequest, ResolveRequest, SearchRequest
from .document_service import DocumentService, DocumentServiceError
from .ingest import IngestFailure

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]
type JsonObject = dict[str, JsonValue]

PROTOCOL_VERSION: Final = "1.2.0"
DOCUMENT_RPC_VERSION: Final = "1.1.0"
SERVICE_NAME: Final = "docatlas-sidecar"
NEGOTIATION_METHODS: Final = ("health", "capabilities")
DOCUMENT_METHODS: Final = ("ingest", "search", "read", "resolve")


def _package_version() -> str:
    try:
        return version("docatlas-dsh-sidecar")
    except PackageNotFoundError:
        return "0.0.0"


def capabilities_result(document_service: DocumentService | None = None) -> JsonObject:
    """Describe only methods and features implemented by this process."""
    methods: list[JsonValue] = []
    methods.extend(NEGOTIATION_METHODS)
    read_modes: list[JsonValue] = []
    provider_capabilities: list[JsonValue] = []
    if document_service is not None:
        methods.extend(
            method
            for method in DOCUMENT_METHODS
            if method != "ingest" or document_service.can_ingest
        )
        read_modes.extend(("locate", "blocks", "expand", "sequential", "visual", "page"))
        provider_capabilities.extend(("pdf", "markdown", "page-image"))
    return {
        "schemaVersion": 1,
        "resultType": "capabilities",
        "protocolVersion": PROTOCOL_VERSION,
        "documentRpcVersion": DOCUMENT_RPC_VERSION,
        "service": SERVICE_NAME,
        "status": "ok",
        "methods": methods,
        "readModes": read_modes,
        "providerCapabilities": provider_capabilities,
        "limits": {
            "maxConcurrentRead": 1,
            "maxConcurrentIngest": 1,
            "maxRequestBytes": 1_048_576,
            "maxDocumentBytes": 536_870_912,
            "maxTextResultChars": 20_000,
            "maxImagePixels": 40_000_000,
        },
        "runtime": {
            "implementation": "cpython",
            "pythonVersion": platform.python_version(),
            "packageVersion": _package_version(),
        },
    }


def error_response(
    request_id: str | None,
    rpc_code: int,
    message: str,
    domain_code: str,
    *,
    retryable: bool = False,
    next_actions: list[str] | None = None,
) -> JsonObject:
    data: JsonObject = {
        "schemaVersion": 1,
        "code": domain_code,
        "message": message,
        "retryable": retryable,
    }
    if next_actions:
        serialized_actions: list[JsonValue] = []
        serialized_actions.extend(next_actions)
        data["nextActions"] = serialized_actions
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": rpc_code,
            "message": message,
            "data": data,
        },
    }


def handle_request(value: JsonValue, document_service: DocumentService | None = None) -> JsonObject:
    """Handle one parsed JSON-RPC value without retaining request state."""
    if not isinstance(value, dict):
        return error_response(None, -32600, "invalid request", "invalid-request")

    request_id = value.get("id")
    safe_id = request_id if isinstance(request_id, str) else None
    if (
        value.get("jsonrpc") != "2.0"
        or not isinstance(request_id, str)
        or request_id == ""
        or not isinstance(value.get("method"), str)
        or not set(value).issubset({"jsonrpc", "id", "method", "params"})
    ):
        return error_response(safe_id, -32600, "invalid request", "invalid-request")

    params = value.get("params", {})
    if not isinstance(params, dict):
        return error_response(request_id, -32602, "params must be an object", "invalid-params")

    method = value["method"]
    available_methods = NEGOTIATION_METHODS + (
        tuple(
            method
            for method in DOCUMENT_METHODS
            if method != "ingest" or document_service.can_ingest
        )
        if document_service is not None
        else ()
    )
    if method not in available_methods:
        return error_response(
            request_id,
            -32601,
            "method not found",
            "not-found",
            next_actions=["contact-operator"],
        )
    if method in NEGOTIATION_METHODS and params:
        return error_response(
            request_id,
            -32602,
            f"{method} params must be empty",
            "invalid-params",
        )

    if method == "capabilities":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": capabilities_result(document_service),
        }

    if method == "health":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "service": SERVICE_NAME,
                "status": "ok",
            },
        }

    if document_service is not None:
        try:
            result: object
            if method == "ingest":
                result = document_service.ingest(cast(IngestRequest, params))
            elif method == "search":
                result = document_service.search(cast(SearchRequest, params))
            elif method == "read":
                result = document_service.read(cast(ReadRequest, params))
            elif method == "resolve":
                result = document_service.resolve(cast(ResolveRequest, params))
            else:  # guarded by available_methods above
                raise AssertionError(f"unhandled document method: {method}")
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": cast(JsonObject, result),
            }
        except (IngestFailure, DocumentServiceError) as error:
            return _domain_failure(request_id, error.code, str(error))

    raise AssertionError(f"unhandled sidecar method: {method}")


def _domain_failure(request_id: str, code: str, message: str) -> JsonObject:
    mapping: dict[str, tuple[int, str, bool, list[str]]] = {
        "invalid-request": (-32602, "invalid-params", False, []),
        "permission-denied": (-32003, "permission-denied", False, ["request-access"]),
        "source-missing": (-32004, "not-found", False, []),
        "source-integrity": (-32009, "integrity-error", False, ["retry"]),
        "source-too-large": (-32010, "limit-exceeded", False, ["reduce-scope"]),
        "unsupported-media-type": (-32011, "unavailable", False, ["contact-operator"]),
        "encrypted-pdf": (-32003, "permission-denied", False, ["request-access"]),
        "index-integrity": (-32009, "integrity-error", True, ["retry"]),
        "idempotency-conflict": (-32005, "conflict", False, []),
        "not-found": (-32004, "not-found", False, []),
        "stale": (-32006, "stale", False, ["re-anchor"]),
        "unavailable": (-32011, "unavailable", True, ["retry"]),
        "limit-exceeded": (-32010, "limit-exceeded", False, ["reduce-scope"]),
        "integrity-error": (-32009, "integrity-error", True, ["retry"]),
    }
    rpc_code, domain_code, retryable, actions = mapping.get(
        code, (-32603, "internal", False, ["contact-operator"])
    )
    return error_response(
        request_id,
        rpc_code,
        message,
        domain_code,
        retryable=retryable,
        next_actions=actions,
    )
