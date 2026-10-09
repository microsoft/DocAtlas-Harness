from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter
from test_ingest import _request

from docatlas_dsh_sidecar.document_service import DocumentService
from docatlas_dsh_sidecar.flash_provider import FlashLimits, FlashProvider, TreeIndexError
from docatlas_dsh_sidecar.ingest import DocumentIndexStore
from docatlas_dsh_sidecar.tree_index import TreeBuildRequest, TreeReadRequest
from docatlas_dsh_sidecar.tree_service import TreeIndexService

pytestmark = pytest.mark.skipif(
    not Path("/usr/bin/bwrap").exists(), reason="Flash production boundary requires Linux bwrap"
)
ROOT = Path(__file__).resolve().parents[3]


def setup(
    tmp_path: Path, *, bookmark: bool = False, blank: bool = False, repeated: int = 0
) -> tuple[DocumentIndexStore, TreeBuildRequest]:
    sources = tmp_path / "sources"
    sources.mkdir()
    source = sources / "sample.pdf"
    source.write_bytes(
        base64.b64decode((ROOT / "apps/web/fixtures/sample-report.pdf.base64").read_text())
    )
    if bookmark or blank or repeated:
        writer = PdfWriter()
        if blank:
            writer.add_blank_page(612, 792)
        elif repeated:
            first = PdfReader(source).pages[0]
            for _ in range(repeated):
                writer.add_page(first)
        else:
            for page in PdfReader(source).pages:
                writer.add_page(page)
            parent = writer.add_outline_item("Annual Widget Report 2025", 0)
            for title, page in [
                ("Financial Highlights", 1),
                ("Regional Performance", 2),
                ("Roadmap", 4),
                ("Risks and Outlook", 5),
            ]:
                writer.add_outline_item(title, page, parent=parent)
        writer.write(source)
    store = DocumentIndexStore({"root:test": sources}, tmp_path / "cache")
    store.ingest(
        _request(
            source,
            "sample.pdf",
            media_type="application/pdf",
            page_count=1 if blank else repeated or 6,
            max_pages=1 if repeated else None,
        )
    )
    request: TreeBuildRequest = {
        "schemaVersion": 1,
        "kind": "build-tree",
        "documentId": "doc:test",
        "revisionId": "rev:test:1",
        "sourceHash": hashlib.sha256(source.read_bytes()).hexdigest(),
        "config": {"mode": "raw", "useEmbeddedToc": bookmark, "workers": 1},
    }
    return store, request


def test_real_raw_and_merge_publish_independent_generations(tmp_path: Path) -> None:
    store, request = setup(tmp_path, bookmark=True)
    service = DocumentService(store, flash_provider=FlashProvider())
    before = store.current_snapshot("doc:test", "rev:test:1")
    raw = service.build_tree(request)
    assert raw["status"] == "ready" and raw["tocSource"] == "hybrid"
    assert service.build_tree(request) == raw
    optimized = service.build_tree({**request, "config": {**request["config"], "mode": "merge"}})
    assert optimized["generationId"] != raw["generationId"]
    assert optimized["parentGenerationId"] == raw["generationId"]
    assert optimized["optimization"]["costAfter"] <= optimized["optimization"]["costBefore"]
    read: TreeReadRequest = {
        "schemaVersion": 1,
        "kind": "read-tree",
        "documentId": request["documentId"],
        "revisionId": request["revisionId"],
        "sourceHash": request["sourceHash"],
        "generationId": raw["generationId"],
        "offset": 0,
        "limit": 2,
    }
    page = service.read_tree(read)
    assert len(page["nodes"]) == 2 and page["nextOffset"] == 2
    assert all(node["nodeId"].startswith(raw["generationId"]) for node in page["nodes"])
    assert "bbox" not in json.dumps(page)
    provider = FlashProvider()
    assert before is not None
    asset = next(
        item
        for item in before.manifest["result"]["representations"]
        if item["kind"] == "original-bytes"
    )
    original = store.asset_store.snapshot(asset["representationId"])
    assert original is not None
    rebuilt = provider.build(
        original.content_path, request["sourceHash"], optimized["generationId"], optimized["config"]
    )
    all_merged = service.read_tree(
        {**read, "generationId": optimized["generationId"], "limit": 200}
    )
    assert all_merged["nodes"] == rebuilt.data["nodes"]
    assert optimized["optimization"] == rebuilt.optimization
    assert store.current_snapshot("doc:test", "rev:test:1") == before
    assert service.build_tree(request) == raw


def test_empty_pdf_is_explicit_empty_and_does_not_destroy_readable_index(tmp_path: Path) -> None:
    store, request = setup(tmp_path, blank=True)
    result = TreeIndexService(store, FlashProvider()).build(request)
    assert result["status"] == "empty" and result["nodeCount"] == 0
    assert "empty-tree" in result["warnings"] and "no-readable-text" in result["warnings"]
    assert store.current_snapshot("doc:test", "rev:test:1") is not None


def test_resource_cancellation_and_failure_preserve_original_index(tmp_path: Path) -> None:
    store, request = setup(tmp_path)
    before = store.current_snapshot("doc:test", "rev:test:1")
    with pytest.raises(TreeIndexError, match="publishable") as failure:
        TreeIndexService(store, FlashProvider(limits=FlashLimits(max_pages=1))).build(request)
    assert failure.value.code == "resource-limit"
    assert store.current_snapshot("doc:test", "rev:test:1") == before
    checks = 0

    def cancel() -> None:
        nonlocal checks
        checks += 1
        if checks >= 5:
            raise TreeIndexError("cancelled", "cancelled during actual worker")

    with pytest.raises(TreeIndexError, match="cancelled"):
        TreeIndexService(store, FlashProvider()).build(request, check_cancelled=cancel)
    assert not list((store.cache_root / "tree-generations").glob("*/manifest.json"))
    assert store.current_snapshot("doc:test", "rev:test:1") == before
    with pytest.raises(TreeIndexError, match="wall-time"):
        TreeIndexService(store, FlashProvider(limits=FlashLimits(wall_seconds=0.001))).build(
            request
        )


def test_source_and_cached_generation_integrity(tmp_path: Path) -> None:
    store, request = setup(tmp_path)
    service = TreeIndexService(store, FlashProvider())
    with pytest.raises(TreeIndexError, match="revision"):
        service.build({**request, "sourceHash": "f" * 64})
    raw = service.build(request)
    target = store.cache_root / "tree-generations" / raw["generationId"][5:] / "data.json"
    data = json.loads(target.read_bytes())
    data["nodes"][0]["title"] = "tampered"
    target.write_text(json.dumps(data))
    with pytest.raises(TreeIndexError, match="integrity"):
        service.build(request)


def test_installed_tree_job_entry_uses_canonical_requests_and_errors(tmp_path: Path) -> None:
    store, request = setup(tmp_path)
    args = [
        sys.executable,
        "-m",
        "docatlas_dsh_sidecar.tree_cli",
        "--cache-root",
        str(store.cache_root),
    ]
    completed = subprocess.run(
        args,
        input=json.dumps(request),
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
        cwd=tmp_path,
    )
    result = json.loads(completed.stdout)
    assert result["kind"] == "tree-generation" and result["status"] == "ready"
    failed = subprocess.run(
        args,
        input=json.dumps({**request, "sourceHash": "f" * 64}),
        text=True,
        capture_output=True,
        timeout=30,
        cwd=tmp_path,
    )
    assert failed.returncode == 1
    assert json.loads(failed.stdout)["code"] == "integrity-error"


def test_exact_deterministic_merge_retains_removed_titles() -> None:
    from docatlas_dsh_sidecar._vendor.pageindex_flash import deterministic as optimizer

    tree = [
        {
            "node_id": "0000",
            "title": "Parent",
            "start_index": 1,
            "end_index": 1,
            "nodes": [
                {"node_id": "0001", "title": "First", "start_index": 1, "end_index": 1},
                {"node_id": "0002", "title": "Second", "start_index": 1, "end_index": 1},
            ],
        }
    ]
    log: list[dict[str, object]] = []
    assert optimizer.merge_same_page(tree, log)
    assert optimizer.merge(tree, 1, log, set())
    assert "nodes" not in tree[0]
    assert any("First" in title and "Second" in title for title in tree[0]["key_items"])


def test_sixty_five_pages_run_without_process_pool_fanout(tmp_path: Path) -> None:
    store, request = setup(tmp_path, repeated=65)
    result = TreeIndexService(store, FlashProvider()).build(request)
    assert result["pageCount"] == 65
    assert result["config"]["workers"] == 1
    assert result["status"] == ("ready" if result["nodeCount"] else "empty")


def test_manifest_seal_rejects_changed_quality_metadata(tmp_path: Path) -> None:
    store, request = setup(tmp_path)
    service = TreeIndexService(store, FlashProvider())
    result = service.build(request)
    file = store.cache_root / "tree-generations" / result["generationId"][5:] / "manifest.json"
    manifest = json.loads(file.read_bytes())
    manifest["tocSource"] = "bookmarks"
    file.write_text(json.dumps(manifest))
    with pytest.raises(TreeIndexError, match="integrity"):
        service.build(request)
