from __future__ import annotations

import hashlib
from pathlib import Path

from docatlas_dsh_sidecar.document_rpc import IngestRequest
from docatlas_dsh_sidecar.document_service import DocumentService
from docatlas_dsh_sidecar.ingest import DocumentIndexStore
from docatlas_dsh_sidecar.protocol import capabilities_result, handle_request
from docatlas_dsh_sidecar.schema_validation import validate_contract_shape


def _service_and_ingest(tmp_path: Path) -> tuple[DocumentService, IngestRequest]:
    sources = tmp_path / "sources"
    sources.mkdir()
    source = sources / "report.md"
    source.write_text(
        "# Revenue\n\nRevenue increased because cloud subscriptions expanded across all regions.",
        encoding="utf-8",
    )
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    request: IngestRequest = {
        "schemaVersion": 1,
        "requestType": "ingest",
        "idempotencyKey": "idempotency:protocol",
        "revision": {
            "schemaVersion": 1,
            "documentId": "doc:protocol",
            "revisionId": "rev:protocol:1",
            "contentHash": digest,
            "byteLength": len(content),
            "mediaType": "text/markdown",
            "displayName": "report.md",
            "origin": {"kind": "upload"},
            "ingestedAt": "2026-08-30T05:00:00Z",
            "pageCount": 1,
            "status": "active",
        },
        "sourceBinding": {
            "schemaVersion": 1,
            "bindingId": "binding:protocol",
            "rootId": "root:protocol",
            "relativePath": "report.md",
            "expectedContentHash": digest,
            "byteLength": len(content),
            "mediaType": "text/markdown",
        },
        "requestedRepresentationKinds": ["derived-markdown"],
        "options": {"forceRebuild": False, "allowOcr": False},
    }
    return DocumentService(
        DocumentIndexStore({"root:protocol": sources}, tmp_path / "cache")
    ), request


def _call(service: DocumentService, request_id: str, method: str, params: dict) -> dict:
    response = handle_request(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, service
    )
    assert validate_contract_shape("sidecar-envelope", response) == []
    return response


def test_document_service_capabilities_are_configuration_gated(tmp_path: Path) -> None:
    service, _ = _service_and_ingest(tmp_path)
    enabled = capabilities_result(service)
    assert enabled["methods"] == [
        "health",
        "capabilities",
        "ingest",
        "search",
        "read",
        "resolve",
    ]
    assert enabled["readModes"] == [
        "locate",
        "blocks",
        "expand",
        "sequential",
        "visual",
        "page",
    ]
    assert enabled["providerCapabilities"] == ["pdf", "markdown", "page-image"]
    assert enabled["limits"]["maxConcurrentRead"] == 1
    assert capabilities_result()["methods"] == ["health", "capabilities"]


def test_json_rpc_ingest_search_read_resolve_chain(tmp_path: Path) -> None:
    service, ingest = _service_and_ingest(tmp_path)
    ingest_response = _call(service, "ingest-1", "ingest", ingest)
    ingest_result = ingest_response["result"]
    representation = ingest_result["representations"][-1]
    source = {
        "documentId": "doc:protocol",
        "revisionId": "rev:protocol:1",
        "representationId": representation["representationId"],
    }
    search_response = _call(
        service,
        "search-1",
        "search",
        {
            "schemaVersion": 1,
            "requestType": "search",
            "scopeVersionId": "scope:protocol:1",
            "sources": [source],
            "query": "subscriptions",
            "strategy": "fts",
            "limits": {"maxItems": 5, "maxChars": 1000},
        },
    )
    block_id = search_response["result"]["candidates"][0]["blockIds"][0]
    read_response = _call(
        service,
        "read-1",
        "read",
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "blocks",
            "source": source,
            "limits": {"maxItems": 5, "maxChars": 1000},
            "blockIds": [block_id],
        },
    )
    locator = read_response["result"]["items"][0]["locator"]
    resolve_response = _call(
        service,
        "resolve-1",
        "resolve",
        {
            "schemaVersion": 1,
            "requestType": "resolve",
            "locator": locator,
            "allowCandidates": True,
            "maxCandidates": 5,
        },
    )
    assert resolve_response["result"]["status"] == "resolved"


def test_document_errors_use_canonical_protocol_error(tmp_path: Path) -> None:
    service, ingest = _service_and_ingest(tmp_path)
    ingested = service.ingest(ingest)
    response = _call(
        service,
        "read-visual",
        "read",
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "visual",
            "source": {
                "documentId": "doc:protocol",
                "revisionId": "rev:protocol:1",
                "representationId": ingested["representations"][-1]["representationId"],
            },
            "limits": {"maxItems": 1, "maxChars": 1},
            "figureId": "figure:not-indexed",
        },
    )
    assert response["error"]["data"]["code"] == "unavailable"
    disabled = handle_request(
        {"jsonrpc": "2.0", "id": "disabled", "method": "ingest", "params": {}}
    )
    assert disabled["error"]["code"] == -32601
