from __future__ import annotations

import hashlib
import struct
import zlib
from pathlib import Path

import pytest
from pypdf import PdfWriter

from docatlas_dsh_sidecar.document_rpc import (
    IngestRequest,
    ReadRequest,
    SearchRequest,
    SourceIdentity,
    read_result_issues,
    resolve_result_issues,
    search_result_issues,
)
from docatlas_dsh_sidecar.document_service import DocumentService, DocumentServiceError
from docatlas_dsh_sidecar.ingest import DocumentIndexStore
from docatlas_dsh_sidecar.schema_validation import validate_contract_shape


def _ingest_request(
    source: Path, relative_path: str, document_id: str, revision_id: str, key: str
) -> IngestRequest:
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    return {
        "schemaVersion": 1,
        "requestType": "ingest",
        "idempotencyKey": key,
        "revision": {
            "schemaVersion": 1,
            "documentId": document_id,
            "revisionId": revision_id,
            "contentHash": digest,
            "byteLength": len(content),
            "mediaType": "text/markdown",
            "displayName": source.name,
            "origin": {"kind": "upload"},
            "ingestedAt": "2026-08-30T04:00:00Z",
            "pageCount": 1,
            "status": "active",
        },
        "sourceBinding": {
            "schemaVersion": 1,
            "bindingId": f"binding:{document_id}",
            "rootId": "root:test",
            "relativePath": relative_path,
            "expectedContentHash": digest,
            "byteLength": len(content),
            "mediaType": "text/markdown",
        },
        "requestedRepresentationKinds": ["derived-markdown"],
        "options": {"forceRebuild": False, "allowOcr": False},
    }


def _indexed_service(tmp_path: Path) -> tuple[DocumentService, SourceIdentity, SourceIdentity]:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    alpha = source_root / "alpha.md"
    beta = source_root / "beta.md"
    alpha.write_text(
        "# Revenue\n\nRevenue increased by twelve percent because cloud services expanded.\n\n"
        "Operating margin also improved across every reported region.",
        encoding="utf-8",
    )
    beta.write_text(
        "# Revenue Outlook\n\nRevenue growth is expected to continue as subscriptions expand.\n\n"
        "Cash flow remains resilient under the current operating plan.",
        encoding="utf-8",
    )
    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache")
    alpha_result = store.ingest(
        _ingest_request(alpha, "alpha.md", "doc:alpha", "rev:alpha:1", "idem:alpha")
    )
    beta_result = store.ingest(
        _ingest_request(beta, "beta.md", "doc:beta", "rev:beta:1", "idem:beta")
    )
    alpha_source: SourceIdentity = {
        "documentId": "doc:alpha",
        "revisionId": "rev:alpha:1",
        "representationId": alpha_result["representations"][-1]["representationId"],
    }
    beta_source: SourceIdentity = {
        "documentId": "doc:beta",
        "revisionId": "rev:beta:1",
        "representationId": beta_result["representations"][-1]["representationId"],
    }
    return DocumentService(store), alpha_source, beta_source


def _pdf_service(
    tmp_path: Path,
) -> tuple[DocumentService, DocumentIndexStore, SourceIdentity, Path]:
    source_root = tmp_path / "pdf-sources"
    source_root.mkdir()
    source = source_root / "visual.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=300)
    writer.add_blank_page(width=300, height=200)
    with source.open("wb") as stream:
        writer.write(stream)
    request = _ingest_request(source, "visual.pdf", "doc:visual", "rev:visual:1", "idem:visual")
    request["revision"]["mediaType"] = "application/pdf"
    request["revision"]["pageCount"] = 2
    request["sourceBinding"]["mediaType"] = "application/pdf"
    request["requestedRepresentationKinds"] = ["embedded-text"]
    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "pdf-cache")
    result = store.ingest(request)
    identity: SourceIdentity = {
        "documentId": result["documentId"],
        "revisionId": result["revisionId"],
        "representationId": result["representations"][-1]["representationId"],
    }
    return DocumentService(store), store, identity, source


def _decode_png(content: bytes) -> tuple[int, int, bytes]:
    assert content.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    width = height = 0
    compressed = bytearray()
    while offset < len(content):
        length = struct.unpack(">I", content[offset : offset + 4])[0]
        kind = content[offset + 4 : offset + 8]
        payload = content[offset + 8 : offset + 8 + length]
        if kind == b"IHDR":
            width, height = struct.unpack(">II", payload[:8])
        if kind == b"IDAT":
            compressed.extend(payload)
        offset += 12 + length
        if kind == b"IEND":
            break
    return width, height, zlib.decompress(compressed)


def _search_request(
    sources: list[SourceIdentity], *, max_items: int = 10, max_chars: int = 4000
) -> SearchRequest:
    return {
        "schemaVersion": 1,
        "requestType": "search",
        "scopeVersionId": "scope:test:1",
        "sources": sources,
        "query": "revenue",
        "strategy": "combined",
        "limits": {"maxItems": max_items, "maxChars": max_chars},
    }


def test_search_is_scope_aware_bounded_and_cursor_paginated(tmp_path: Path) -> None:
    service, alpha, beta = _indexed_service(tmp_path)
    request = _search_request([alpha, beta], max_items=1, max_chars=30)

    first = service.search(request)

    assert validate_contract_shape("sidecar-document-rpc", first) == []
    assert search_result_issues(first) == []
    assert first["pageInfo"]["returned"] == 1
    assert first["pageInfo"]["usedChars"] <= 30
    assert first["pageInfo"]["truncated"] is True
    assert "nextCursor" in first["pageInfo"]
    assert first["candidates"][0]["documentId"] in {"doc:alpha", "doc:beta"}

    second_request = {**request, "cursor": first["pageInfo"]["nextCursor"]}
    second = service.search(second_request)
    assert second["candidates"][0]["candidateId"] != first["candidates"][0]["candidateId"]


def test_search_treats_query_as_text_and_rejects_wrong_cursor_or_tree(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    request = _search_request([alpha])
    request["query"] = 'revenue OR "unterminated'
    assert service.search(request)["candidates"]

    request["cursor"] = "cursor:search:0000000000000000:1"
    with pytest.raises(DocumentServiceError) as captured:
        service.search(request)
    assert captured.value.code == "invalid-request"

    request.pop("cursor")
    request["strategy"] = "tree"
    with pytest.raises(DocumentServiceError) as captured:
        service.search(request)
    assert captured.value.code == "unavailable"


def test_read_locate_blocks_and_expand_return_identity_bound_locators(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    common = {
        "schemaVersion": 1,
        "requestType": "read",
        "source": alpha,
        "limits": {"maxItems": 10, "maxChars": 4000},
    }
    locate: ReadRequest = {**common, "mode": "locate", "query": "operating margin"}
    located = service.read(locate)
    assert located["items"]
    assert located["pageInfo"]["completeness"] == "candidate"
    block = located["items"][0]
    assert block["itemType"] == "block"
    assert block["locator"]["documentId"] == alpha["documentId"]
    assert block["locator"]["revisionId"] == alpha["revisionId"]
    assert block["locator"]["representationId"] == alpha["representationId"]
    assert [selector["type"] for selector in block["locator"]["selectors"]] == [
        "block",
        "text-position",
        "text-quote",
    ]
    assert read_result_issues(located) == []

    blocks: ReadRequest = {**common, "mode": "blocks", "blockIds": [block["blockId"]]}
    exact = service.read(blocks)
    assert exact["items"][0]["text"] == block["text"]
    expand: ReadRequest = {
        **common,
        "mode": "expand",
        "targetBlockId": block["blockId"],
        "before": 1,
        "after": 1,
    }
    expanded = service.read(expand)
    assert 1 <= len(expanded["items"]) <= 3


def test_page_read_is_physical_page_bound_ordered_and_bounded(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "page",
        "source": alpha,
        "limits": {"maxItems": 200, "maxChars": 40},
        "physicalPage": 1,
    }

    result = service.read(request)

    assert result["mode"] == "page"
    assert result["items"]
    assert all(item["physicalPage"] == 1 for item in result["items"])
    assert sum(len(item["text"]) for item in result["items"] if item["itemType"] == "block") <= 40
    assert result["pageInfo"]["truncated"] is True
    assert result["pageInfo"]["nextCursor"].startswith("cursor:page:")
    assert [item["locator"]["physicalPage"] for item in result["items"]] == [
        item["physicalPage"] for item in result["items"]
    ]
    assert validate_contract_shape("sidecar-document-rpc", result) == []

    resumed = service.read(
        {
            **request,
            "limits": {"maxItems": 200, "maxChars": 20_000},
            "cursor": result["pageInfo"]["nextCursor"],
        }
    )
    assert resumed["items"]
    assert result["items"][-1]["text"] + resumed["items"][0]["text"] in (
        "Revenue increased by twelve percent because cloud services expanded.",
        "Operating margin also improved across every reported region.",
    )

    with pytest.raises(DocumentServiceError) as missing:
        service.read({**request, "physicalPage": 2})
    assert missing.value.code == "not-found"


def test_page_read_preserves_an_indexed_page_with_no_text_blocks(tmp_path: Path) -> None:
    service, _, source_identity, _ = _pdf_service(tmp_path)

    result = service.read(
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "page",
            "source": source_identity,
            "limits": {"maxItems": 200, "maxChars": 20_000},
            "physicalPage": 2,
        }
    )

    assert result["items"] == []
    assert result["textQuality"] == "empty"
    assert result["pageInfo"] == {
        "schemaVersion": 1,
        "limit": 200,
        "returned": 0,
        "usedChars": 0,
        "total": 0,
        "truncated": False,
        "completeness": "complete",
    }


def test_sequential_read_cursor_resumes_inside_a_truncated_block(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    first_request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "sequential",
        "source": alpha,
        "limits": {"maxItems": 1, "maxChars": 3},
    }
    first = service.read(first_request)
    assert first["items"][0]["text"] == "Rev"
    assert first["pageInfo"]["truncated"] is True
    cursor = first["pageInfo"]["nextCursor"]

    second = service.read(
        {**first_request, "limits": {"maxItems": 1, "maxChars": 100}, "cursor": cursor}
    )
    assert first["items"][0]["text"] + second["items"][0]["text"] == "Revenue"
    assert second["items"][0]["locator"]["selectors"][-1]["type"] == "text-quote"


def test_read_fails_closed_for_missing_stale_and_unimplemented_visual(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    common = {
        "schemaVersion": 1,
        "requestType": "read",
        "source": alpha,
        "limits": {"maxItems": 1, "maxChars": 100},
    }
    with pytest.raises(DocumentServiceError) as captured:
        service.read({**common, "mode": "blocks", "blockIds": ["block:missing"]})
    assert captured.value.code == "not-found"

    stale_source = {**alpha, "representationId": "rep:stale"}
    with pytest.raises(DocumentServiceError) as captured:
        service.read({**common, "source": stale_source, "mode": "sequential"})
    assert captured.value.code == "stale"

    with pytest.raises(DocumentServiceError) as captured:
        service.read({**common, "mode": "visual", "physicalPage": 1})
    assert captured.value.code == "unavailable"


def test_visual_read_renders_bounded_immutable_png_and_reuses_asset(tmp_path: Path) -> None:
    service, store, source_identity, mutable_source = _pdf_service(tmp_path)
    mutable_source.write_bytes(b"source changed after immutable ingest")
    request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "visual",
        "source": source_identity,
        "limits": {"maxItems": 1, "maxChars": 1},
        "physicalPage": 1,
        "maxPixels": 10_000,
    }

    first = service.read(request)
    second = service.read(request)

    assert first == second
    assert first["mode"] == "visual"
    assert first["pageInfo"]["usedChars"] == 0
    assert read_result_issues(first) == []
    assert validate_contract_shape("sidecar-document-rpc", first) == []
    item = first["items"][0]
    assert item["itemType"] == "visual"
    assert item["asset"]["width"] * item["asset"]["height"] <= 10_000
    assert item["locator"]["physicalPage"] == 1
    assert item["locator"]["selectors"][0]["type"] == "bbox"
    snapshot = store.asset_store.snapshot(item["asset"]["assetId"])
    assert snapshot is not None
    content = snapshot.content_path.read_bytes()
    assert content.startswith(b"\x89PNG\r\n\x1a\n")
    width, height, pixels = _decode_png(content)
    assert (width, height) == (item["asset"]["width"], item["asset"]["height"])
    assert len(pixels) == height * (1 + width * 3)
    assert hashlib.sha256(content).hexdigest() == item["asset"]["contentHash"]
    assert len(content) == item["asset"]["byteLength"]
    assert validate_contract_shape("asset-descriptor", snapshot.descriptor) == []
    assert len([entry for entry in store.asset_store.root.iterdir() if entry.is_dir()]) == 2


def test_visual_read_rejects_missing_pages_figures_and_non_pdf_sources(tmp_path: Path) -> None:
    service, _, source_identity, _ = _pdf_service(tmp_path)
    page_request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "visual",
        "source": source_identity,
        "limits": {"maxItems": 1, "maxChars": 1},
        "physicalPage": 3,
    }
    with pytest.raises(DocumentServiceError) as missing:
        service.read(page_request)
    assert missing.value.code == "not-found"

    figure_request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "visual",
        "source": source_identity,
        "limits": {"maxItems": 1, "maxChars": 1},
        "figureId": "figure:not-indexed",
    }
    with pytest.raises(DocumentServiceError) as figure:
        service.read(figure_request)
    assert figure.value.code == "unavailable"

    markdown_root = tmp_path / "markdown"
    markdown_root.mkdir()
    markdown, markdown_source, _ = _indexed_service(markdown_root)
    markdown_request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "visual",
        "source": markdown_source,
        "limits": {"maxItems": 1, "maxChars": 1},
        "physicalPage": 1,
    }
    with pytest.raises(DocumentServiceError) as unsupported:
        markdown.read(markdown_request)
    assert unsupported.value.code == "unavailable"


def _resolve_request(locator: dict, *, allow: bool = True, maximum: int = 5) -> dict:
    return {
        "schemaVersion": 1,
        "requestType": "resolve",
        "locator": locator,
        "allowCandidates": allow,
        "maxCandidates": maximum,
    }


def test_resolve_preserves_identity_and_detects_stale_or_missing_sources(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    located = service.read(
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "locate",
            "source": alpha,
            "limits": {"maxItems": 1, "maxChars": 4000},
            "query": "operating margin",
        }
    )
    locator = located["items"][0]["locator"]
    request = _resolve_request(locator)

    resolved = service.resolve(request)

    assert resolved["status"] == "resolved"
    assert resolved["locatorId"] == locator["locatorId"]
    assert resolved["resolvedLocator"]["documentId"] == alpha["documentId"]
    assert resolve_result_issues(resolved, request) == []
    assert validate_contract_shape("sidecar-document-rpc", resolved) == []

    stale_locator = {**locator, "representationContentHash": "f" * 64}
    stale = service.resolve(_resolve_request(stale_locator))
    assert stale["status"] == "stale"
    assert "resolvedLocator" not in stale

    missing_locator = {**locator, "documentId": "doc:missing", "revisionId": "rev:missing:1"}
    missing = service.resolve(_resolve_request(missing_locator))
    assert missing["status"] == "missing"
    assert "checkedRepresentationHash" not in missing


def test_resolve_quote_reanchors_uniquely_or_returns_bounded_ambiguity(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    base = service.read(
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "sequential",
            "source": alpha,
            "limits": {"maxItems": 1, "maxChars": 100},
        }
    )["items"][0]["locator"]

    exact = "Operating margin"
    unique_locator = {
        **base,
        "locatorId": "loc:unique-quote",
        "selectors": [
            {
                "type": "text-quote",
                "exact": exact,
                "normalizedHash": hashlib.sha256(exact.encode()).hexdigest(),
            }
        ],
    }
    unique = service.resolve(_resolve_request(unique_locator))
    assert unique["status"] == "resolved"
    assert unique["exactText"] == exact
    assert unique["resolvedLocator"]["supersedesLocatorId"] == "loc:unique-quote"

    repeated = "Revenue"
    ambiguous_locator = {
        **base,
        "locatorId": "loc:ambiguous-quote",
        "selectors": [
            {
                "type": "text-quote",
                "exact": repeated,
                "normalizedHash": hashlib.sha256(repeated.encode()).hexdigest(),
            }
        ],
    }
    ambiguous = service.resolve(_resolve_request(ambiguous_locator, maximum=1))
    assert ambiguous["status"] == "ambiguous"
    assert len(ambiguous["candidates"]) == 1
    hidden = service.resolve(_resolve_request(ambiguous_locator, allow=False, maximum=0))
    assert hidden["status"] == "ambiguous"
    assert hidden["candidates"] == []


def test_resolve_position_page_only_and_missing_block_states(tmp_path: Path) -> None:
    service, alpha, _ = _indexed_service(tmp_path)
    base = service.read(
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "sequential",
            "source": alpha,
            "limits": {"maxItems": 1, "maxChars": 100},
        }
    )["items"][0]["locator"]

    position = {
        **base,
        "locatorId": "loc:position",
        "selectors": [{"type": "text-position", "start": 2, "end": 9, "unit": "unicode-scalar"}],
    }
    assert service.resolve(_resolve_request(position))["status"] == "resolved"

    page_only = {
        **base,
        "locatorId": "loc:page-only",
        "selectors": [
            {
                "type": "bbox",
                "unit": "ratio",
                "x": 0.1,
                "y": 0.1,
                "width": 0.2,
                "height": 0.2,
                "rotation": 0,
            }
        ],
    }
    assert service.resolve(_resolve_request(page_only))["status"] == "page-only"

    missing_block = {
        **base,
        "locatorId": "loc:missing-block",
        "selectors": [{"type": "block", "blockId": "block:missing"}],
    }
    assert service.resolve(_resolve_request(missing_block))["status"] == "stale"
