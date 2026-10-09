from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from docatlas_dsh_sidecar.document_rpc import (
    IngestRequest,
    ReadRequest,
    ResolveRequest,
    SourceIdentity,
)
from docatlas_dsh_sidecar.document_service import DocumentService
from docatlas_dsh_sidecar.ingest import DocumentIndexStore, IngestFailure


def _text(value: str, x: int = 72, y: int = 720) -> str:
    escaped = value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"BT /F1 12 Tf {x} {y} Td ({escaped}) Tj ET\n"


def _write_pdf(
    path: Path,
    streams: list[str],
    *,
    sizes: list[tuple[int, int]] | None = None,
    rotations: list[int] | None = None,
    password: str | None = None,
) -> None:
    writer = PdfWriter()
    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    for index, content in enumerate(streams):
        width, height = (sizes or [(612, 792)] * len(streams))[index]
        page = writer.add_blank_page(width=width, height=height)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        stream = DecodedStreamObject()
        stream.set_data(content.encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        rotation = (rotations or [0] * len(streams))[index]
        if rotation:
            page.rotate(rotation)
    if password is not None:
        writer.encrypt(password)
    with path.open("wb") as output:
        writer.write(output)


def _request(path: Path, document_id: str, *, key: str | None = None) -> IngestRequest:
    content = path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    return {
        "schemaVersion": 1,
        "requestType": "ingest",
        "idempotencyKey": key or f"idempotency:{document_id}",
        "revision": {
            "schemaVersion": 1,
            "documentId": document_id,
            "revisionId": f"rev:{document_id}:1",
            "contentHash": digest,
            "byteLength": len(content),
            "mediaType": "application/pdf",
            "displayName": path.name,
            "origin": {"kind": "local-file"},
            "ingestedAt": "2026-08-31T00:00:00Z",
            "status": "active",
        },
        "sourceBinding": {
            "schemaVersion": 1,
            "bindingId": f"binding:{document_id}",
            "rootId": "root:matrix",
            "relativePath": path.name,
            "expectedContentHash": digest,
            "byteLength": len(content),
            "mediaType": "application/pdf",
        },
        "requestedRepresentationKinds": ["embedded-text"],
        "options": {"forceRebuild": False, "allowOcr": False},
    }


def _identity(result: dict) -> SourceIdentity:
    active = result["representations"][-1]
    return {
        "documentId": result["documentId"],
        "revisionId": result["revisionId"],
        "representationId": active["representationId"],
    }


def _read_page(service: DocumentService, source: SourceIdentity, page: int) -> dict:
    request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "page",
        "source": source,
        "limits": {"maxItems": 200, "maxChars": 20_000},
        "physicalPage": page,
    }
    return service.read(request)


def _read_visual(service: DocumentService, source: SourceIdentity, page: int) -> dict:
    request: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "visual",
        "source": source,
        "limits": {"maxItems": 1, "maxChars": 1},
        "physicalPage": page,
        "maxPixels": 50_000,
    }
    return service.read(request)


def test_reader_matrix_for_seven_renderable_pdf_classes(tmp_path: Path) -> None:
    """Exercise born-digital, multipage, rotated, columns, table, figure, and scan cases."""
    sources = tmp_path / "sources"
    sources.mkdir()
    cases = {
        "born-digital": ([_text("Born digital annual report evidence.")], {}, "Born digital"),
        "multi-page": (
            [_text("First physical page."), _text("Second physical page evidence.")],
            {},
            "Second physical page",
        ),
        "landscape-rotated": (
            [_text("Rotated landscape evidence.")],
            {"sizes": [(792, 612)], "rotations": [90]},
            "Rotated landscape",
        ),
        "multi-column": (
            [_text("Left column evidence.", 54, 720) + _text("Right column evidence.", 330, 720)],
            {},
            "Right column",
        ),
        "table": (
            [
                _text("Quarter", 72, 720)
                + _text("Revenue", 220, 720)
                + _text("Q1", 72, 690)
                + _text("120", 220, 690)
            ],
            {},
            "Revenue",
        ),
        "figure": (
            [_text("Figure 1: verified source chart.", 72, 470) + "72 520 300 160 re S\n"],
            {},
            "Figure 1",
        ),
        "scanned-no-text": (["72 520 300 160 re S\n"], {}, ""),
    }
    store = DocumentIndexStore({"root:matrix": sources}, tmp_path / "cache")
    service = DocumentService(store)

    for index, (name, (streams, options, expected)) in enumerate(cases.items(), start=1):
        path = sources / f"{name}.pdf"
        _write_pdf(path, streams, **options)
        result = store.ingest(_request(path, f"doc:matrix:{index}"))
        source = _identity(result)
        page_number = 2 if name == "multi-page" else 1
        page = _read_page(service, source, page_number)
        visual = _read_visual(service, source, page_number)

        assert all(item["physicalPage"] == page_number for item in page["items"])
        assert visual["items"][0]["physicalPage"] == page_number
        assert (
            visual["items"][0]["asset"]["width"] * visual["items"][0]["asset"]["height"] <= 50_000
        )
        joined = "\n".join(item["text"] for item in page["items"])
        if expected:
            assert expected in joined
        else:
            assert page["items"] == []
            assert page["textQuality"] == "empty"


def test_reader_matrix_rejects_encrypted_and_malformed_pdfs(tmp_path: Path) -> None:
    """Encrypted and malformed PDFs fail before any index or Reader page is exposed."""
    sources = tmp_path / "sources"
    sources.mkdir()
    encrypted = sources / "encrypted.pdf"
    _write_pdf(encrypted, [_text("Secret evidence")], password="secret")
    malformed = sources / "malformed.pdf"
    malformed.write_bytes(b"%PDF-1.7\nnot a valid cross-reference table\n")
    store = DocumentIndexStore({"root:matrix": sources}, tmp_path / "cache")

    with pytest.raises(IngestFailure) as encrypted_error:
        store.ingest(_request(encrypted, "doc:matrix:encrypted"))
    assert encrypted_error.value.code == "encrypted-pdf"
    assert store.current_snapshot("doc:matrix:encrypted", "rev:doc:matrix:encrypted:1") is None

    with pytest.raises(IngestFailure) as malformed_error:
        store.ingest(_request(malformed, "doc:matrix:malformed"))
    assert malformed_error.value.code == "source-integrity"
    assert store.current_snapshot("doc:matrix:malformed", "rev:doc:matrix:malformed:1") is None


def test_reader_matrix_never_conflates_same_page_numbers_across_documents(tmp_path: Path) -> None:
    """The tenth class is a cross-document collision with the same physical page number."""
    sources = tmp_path / "sources"
    sources.mkdir()
    alpha_path = sources / "alpha.pdf"
    beta_path = sources / "beta.pdf"
    _write_pdf(alpha_path, [_text("Alpha document evidence.")])
    _write_pdf(beta_path, [_text("Beta document evidence.")])
    store = DocumentIndexStore({"root:matrix": sources}, tmp_path / "cache")
    service = DocumentService(store)
    alpha = _identity(store.ingest(_request(alpha_path, "doc:matrix:alpha")))
    beta = _identity(store.ingest(_request(beta_path, "doc:matrix:beta")))

    alpha_page = _read_page(service, alpha, 1)
    beta_page = _read_page(service, beta, 1)

    assert "Alpha" in alpha_page["items"][0]["text"]
    assert "Beta" in beta_page["items"][0]["text"]
    assert alpha_page["items"][0]["locator"]["documentId"] == alpha["documentId"]
    assert beta_page["items"][0]["locator"]["documentId"] == beta["documentId"]
    assert (
        alpha_page["items"][0]["locator"]["locatorId"]
        != beta_page["items"][0]["locator"]["locatorId"]
    )


def test_born_digital_quote_resolves_to_original_pdf_page_geometry(tmp_path: Path) -> None:
    sources = tmp_path / "sources"
    sources.mkdir()
    source = sources / "revenue.pdf"
    _write_pdf(
        source,
        [
            _text("Quarter Revenue Growth", 72, 720)
            + _text("Q3 14.0 +7%", 72, 690)
            + _text("Q4 15.2 +9%", 72, 660)
        ],
    )
    store = DocumentIndexStore({"root:matrix": sources}, tmp_path / "cache")
    service = DocumentService(store)
    identity = _identity(store.ingest(_request(source, "doc:matrix:geometry")))
    read: ReadRequest = {
        "schemaVersion": 1,
        "requestType": "read",
        "mode": "locate",
        "source": identity,
        "limits": {"maxItems": 10, "maxChars": 4_000},
        "query": "Q4 15.2",
    }
    located = service.read(read)

    assert [item["text"] for item in located["items"]] == ["Q4 15.2 +9%"]
    request: ResolveRequest = {
        "schemaVersion": 1,
        "requestType": "resolve",
        "locator": located["items"][0]["locator"],
        "allowCandidates": True,
        "maxCandidates": 5,
    }
    resolved = service.resolve(request)

    assert resolved["status"] == "resolved"
    selectors = resolved["resolvedLocator"]["selectors"]
    boxes = [selector for selector in selectors if selector["type"] == "bbox"]
    assert len(boxes) == 1
    box = boxes[0]
    assert box["unit"] == "ratio"
    assert 0 < box["x"] < 0.5
    assert 0 < box["y"] < 1
    assert 0 < box["width"] < 0.5
    assert 0 < box["height"] < 0.1
    assert box["x"] + box["width"] <= 1
    assert box["y"] + box["height"] <= 1
