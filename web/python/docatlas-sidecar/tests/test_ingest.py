from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from docatlas_dsh_sidecar.contracts import DocumentRevision
from docatlas_dsh_sidecar.document_rpc import IngestOptions, IngestRequest
from docatlas_dsh_sidecar.ingest import DocumentIndexStore, IngestFailure
from docatlas_dsh_sidecar.schema_validation import validate_contract_shape


def _request(
    path: Path,
    relative_path: str,
    *,
    document_id: str = "doc:test",
    revision_id: str = "rev:test:1",
    media_type: str = "text/markdown",
    page_count: int | None = 1,
    idempotency_key: str = "idempotency:test:1",
    force: bool = False,
    max_pages: int | None = None,
) -> IngestRequest:
    content = path.read_bytes()
    options: IngestOptions = {"forceRebuild": force, "allowOcr": False}
    if max_pages is not None:
        options["maxPages"] = max_pages
    revision: DocumentRevision = {
        "schemaVersion": 1,
        "documentId": document_id,
        "revisionId": revision_id,
        "contentHash": hashlib.sha256(content).hexdigest(),
        "byteLength": len(content),
        "mediaType": media_type,
        "displayName": path.name,
        "origin": {"kind": "local-file"},
        "ingestedAt": "2026-08-30T03:00:00Z",
        "status": "active",
    }
    if page_count is not None:
        revision["pageCount"] = page_count
    request: IngestRequest = {
        "schemaVersion": 1,
        "requestType": "ingest",
        "idempotencyKey": idempotency_key,
        "revision": revision,
        "sourceBinding": {
            "schemaVersion": 1,
            "bindingId": f"binding:{document_id}",
            "rootId": "root:test",
            "relativePath": relative_path,
            "expectedContentHash": hashlib.sha256(content).hexdigest(),
            "byteLength": len(content),
            "mediaType": media_type,
        },
        "requestedRepresentationKinds": [
            "embedded-text" if media_type == "application/pdf" else "derived-markdown"
        ],
        "options": options,
    }
    return request


def _write_text_pdf(path: Path, page_texts: list[str]) -> None:
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
    for text in page_texts:
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    with path.open("wb") as output:
        writer.write(output)


def _block_ids(database: Path) -> list[str]:
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        return [
            row[0] for row in connection.execute("SELECT block_id FROM blocks ORDER BY ordinal")
        ]


def test_markdown_ingest_publishes_queryable_fts_and_reuses_generation(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "report.md"
    source.write_text(
        "# Revenue\n\nRevenue increased because cloud services expanded across all regions. "
        "The result exceeded the annual plan by twelve percent.\n",
        encoding="utf-8",
    )
    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache")
    request = _request(source, "report.md")

    created = store.ingest(request)

    assert created["cacheStatus"] == "created"
    assert created["index"] == {
        "status": "ready",
        "blockCount": 2,
        "indexedPages": 1,
        "totalPages": 1,
        "textQuality": "usable",
    }
    assert validate_contract_shape("sidecar-document-rpc", created) == []
    snapshot = store.current_snapshot("doc:test", "rev:test:1")
    assert snapshot is not None
    with sqlite3.connect(f"file:{snapshot.database_path}?mode=ro", uri=True) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute(
            "SELECT value FROM metadata WHERE key='representationId'"
        ).fetchone() == (created["representations"][-1]["representationId"],)
        matches = connection.execute(
            "SELECT block_id FROM blocks_fts WHERE blocks_fts MATCH 'revenue'"
        ).fetchall()
        assert len(matches) == 2
    assert str(source_root) not in json.dumps(snapshot.manifest)

    assert store.ingest(request) == created
    restarted_store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache")
    assert restarted_store.ingest(request) == created
    reused_request = _request(source, "report.md", idempotency_key="idempotency:test:2")
    reused = store.ingest(reused_request)
    assert reused["cacheStatus"] == "reused"
    reused_snapshot = store.current_snapshot("doc:test", "rev:test:1")
    assert reused_snapshot is not None
    assert reused_snapshot.generation_id == snapshot.generation_id


def test_pdf_ingest_extracts_text_and_honors_partial_page_limit(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "report.pdf"
    _write_text_pdf(
        source,
        [
            "Revenue increased by twelve percent because cloud services grew across all regions.",
            "Cash flow improved materially while operating expenses remained "
            "within the annual plan.",
        ],
    )
    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache")
    request = _request(
        source,
        "report.pdf",
        media_type="application/pdf",
        page_count=2,
        max_pages=1,
    )

    result = store.ingest(request)

    assert result["index"]["status"] == "partial"
    assert result["index"]["indexedPages"] == 1
    assert result["index"]["totalPages"] == 2
    assert result["index"]["blockCount"] == 1
    assert result["representations"][-1]["kind"] == "embedded-text"
    snapshot = store.current_snapshot("doc:test", "rev:test:1")
    assert snapshot is not None
    with sqlite3.connect(f"file:{snapshot.database_path}?mode=ro", uri=True) as connection:
        text = connection.execute("SELECT text FROM pages WHERE physical_page=1").fetchone()[0]
        assert "Revenue increased" in text

    unknown_page_count = _request(
        source,
        "report.pdf",
        revision_id="rev:test:unknown-pages",
        idempotency_key="idempotency:test:unknown-pages",
        media_type="application/pdf",
        page_count=None,
    )
    assert validate_contract_shape("sidecar-document-rpc", unknown_page_count) == []
    discovered = store.ingest(unknown_page_count)
    assert discovered["index"]["totalPages"] == 2


def test_force_rebuild_keeps_block_ids_and_switches_pointer_atomically(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "report.md"
    source.write_text("# Stable\n\n" + "stable evidence text " * 10, encoding="utf-8")
    fail_before_pointer = False

    def hook(stage: str, _path: Path) -> None:
        if fail_before_pointer and stage == "before-pointer-publish":
            raise RuntimeError("simulated crash before pointer")

    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache", publish_hook=hook)
    first = store.ingest(_request(source, "report.md"))
    first_snapshot = store.current_snapshot("doc:test", "rev:test:1")
    assert first_snapshot is not None
    first_blocks = _block_ids(first_snapshot.database_path)

    fail_before_pointer = True
    crash_request = _request(
        source,
        "report.md",
        idempotency_key="idempotency:test:force-crash",
        force=True,
    )
    with pytest.raises(RuntimeError, match="simulated crash"):
        store.ingest(crash_request)
    after_crash = store.current_snapshot("doc:test", "rev:test:1")
    assert after_crash is not None
    assert after_crash.generation_id == first_snapshot.generation_id
    assert after_crash.manifest["result"] == first

    fail_before_pointer = False
    rebuilt = store.ingest(
        _request(
            source,
            "report.md",
            idempotency_key="idempotency:test:force-success",
            force=True,
        )
    )
    rebuilt_snapshot = store.current_snapshot("doc:test", "rev:test:1")
    assert rebuilt_snapshot is not None
    assert rebuilt_snapshot.generation_id != first_snapshot.generation_id
    assert rebuilt["cacheStatus"] == "refreshed"
    assert _block_ids(rebuilt_snapshot.database_path) == first_blocks


def test_cancellation_before_pointer_never_publishes_partial_index(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "report.md"
    source.write_text("cancel safe evidence " * 10, encoding="utf-8")
    cancelled = False

    def hook(stage: str, _path: Path) -> None:
        nonlocal cancelled
        if stage == "before-pointer-publish":
            cancelled = True

    def check_cancelled() -> None:
        if cancelled:
            raise InterruptedError("ingest cancelled")

    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache", publish_hook=hook)
    with pytest.raises(InterruptedError, match="ingest cancelled"):
        store.ingest(_request(source, "report.md"), check_cancelled=check_cancelled)
    assert store.current_snapshot("doc:test", "rev:test:1") is None


def test_source_and_idempotency_conflicts_fail_closed(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    source = source_root / "report.md"
    source.write_text("trusted source text " * 10, encoding="utf-8")
    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache")
    request = _request(source, "report.md")
    store.ingest(request)

    conflict = _request(source, "report.md", force=True)
    with pytest.raises(IngestFailure) as captured:
        store.ingest(conflict)
    assert captured.value.code == "idempotency-conflict"

    changed = _request(source, "report.md", idempotency_key="idempotency:changed")
    source.write_bytes(b"x" * changed["sourceBinding"]["byteLength"])
    with pytest.raises(IngestFailure) as captured:
        store.ingest(changed)
    assert captured.value.code == "source-integrity"


def test_symlink_escape_and_index_corruption_fail_closed(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("outside data " * 10, encoding="utf-8")
    link = source_root / "link.md"
    link.symlink_to(outside)
    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache")

    with pytest.raises(IngestFailure) as captured:
        store.ingest(_request(link, "link.md"))
    assert captured.value.code == "permission-denied"

    source = source_root / "inside.md"
    source.write_text("inside data " * 10, encoding="utf-8")
    store.ingest(_request(source, "inside.md", idempotency_key="idempotency:inside"))
    snapshot = store.current_snapshot("doc:test", "rev:test:1")
    assert snapshot is not None
    with snapshot.database_path.open("ab") as stream:
        stream.write(b"corruption")
    with pytest.raises(IngestFailure) as captured:
        store.current_snapshot("doc:test", "rev:test:1")
    assert captured.value.code == "index-integrity"


def test_document_revision_identity_partitions_same_page_indexes(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source_root.mkdir()
    first_source = source_root / "a.md"
    second_source = source_root / "b.md"
    first_source.write_text("document alpha evidence " * 8, encoding="utf-8")
    second_source.write_text("document beta evidence " * 8, encoding="utf-8")
    store = DocumentIndexStore({"root:test": source_root}, tmp_path / "cache")

    store.ingest(_request(first_source, "a.md", document_id="doc:a", revision_id="rev:a:1"))
    store.ingest(
        _request(
            second_source,
            "b.md",
            document_id="doc:b",
            revision_id="rev:b:1",
            idempotency_key="idempotency:b",
        )
    )
    first = store.current_snapshot("doc:a", "rev:a:1")
    second = store.current_snapshot("doc:b", "rev:b:1")
    assert first is not None and second is not None
    assert first.directory != second.directory
    assert _block_ids(first.database_path)[0].startswith("p00001.b00001")
    assert _block_ids(second.database_path)[0].startswith("p00001.b00001")
    assert _block_ids(first.database_path) != _block_ids(second.database_path)
