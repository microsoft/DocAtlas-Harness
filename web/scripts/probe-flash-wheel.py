"""Run via uv --isolated --no-project --with WHEEL python -I; imports only installed product code."""

from __future__ import annotations

import base64
import hashlib
import json
import tempfile
from pathlib import Path

import docatlas_dsh_sidecar
from docatlas_dsh_sidecar.document_service import DocumentService
from docatlas_dsh_sidecar.flash_provider import FlashProvider
from docatlas_dsh_sidecar.ingest import DocumentIndexStore
from docatlas_dsh_sidecar.tree_service import TreeIndexService

repo = Path(__file__).resolve().parents[1]
module = Path(docatlas_dsh_sidecar.__file__).resolve()
assert not module.is_relative_to(repo), (
    "Probe must use an installed wheel outside the repository"
)
with tempfile.TemporaryDirectory(prefix="docatlas-flash-wheel-") as directory:
    root = Path(directory)
    source = root / "sample.pdf"
    content = base64.b64decode(
        (repo / "apps/web/fixtures/sample-report.pdf.base64").read_text()
    )
    source.write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    store = DocumentIndexStore({"root:wheel": root}, root / "cache")
    ingested = store.ingest(
        {
            "schemaVersion": 1,
            "requestType": "ingest",
            "idempotencyKey": "idempotency:wheel",
            "revision": {
                "schemaVersion": 1,
                "documentId": "doc:wheel",
                "revisionId": "rev:wheel",
                "contentHash": digest,
                "byteLength": len(content),
                "mediaType": "application/pdf",
                "displayName": "sample.pdf",
                "origin": {"kind": "local-file"},
                "ingestedAt": "2026-09-08T12:00:00Z",
                "status": "active",
            },
            "sourceBinding": {
                "schemaVersion": 1,
                "bindingId": "binding:wheel",
                "rootId": "root:wheel",
                "relativePath": "sample.pdf",
                "expectedContentHash": digest,
                "byteLength": len(content),
                "mediaType": "application/pdf",
            },
            "requestedRepresentationKinds": ["embedded-text"],
            "options": {"forceRebuild": False, "allowOcr": False},
        }
    )
    representation = next(
        value
        for value in ingested["representations"]
        if value["kind"] == "embedded-text"
    )
    visual = DocumentService(store).read(
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "visual",
            "source": {
                "documentId": "doc:wheel",
                "revisionId": "rev:wheel",
                "representationId": representation["representationId"],
            },
            "physicalPage": 1,
            "maxPixels": 10000,
            "limits": {"maxItems": 1, "maxChars": 1},
        }
    )
    image = visual["items"][0]
    assert image["itemType"] == "visual"
    asset = store.asset_store.snapshot(image["asset"]["assetId"])
    assert (
        asset
        and hashlib.sha256(asset.content_path.read_bytes()).hexdigest()
        == image["asset"]["contentHash"]
    )
    manifest = TreeIndexService(store, FlashProvider()).build(
        {
            "schemaVersion": 1,
            "kind": "build-tree",
            "documentId": "doc:wheel",
            "revisionId": "rev:wheel",
            "sourceHash": digest,
            "config": {"mode": "merge", "useEmbeddedToc": True, "workers": 1},
        }
    )
    assert manifest["status"] == "ready" and manifest["parentGenerationId"]
    print(
        json.dumps(
            {
                "wheelOnly": True,
                "isolatedVisual": True,
                "status": manifest["status"],
                "pages": manifest["pageCount"],
                "nodes": manifest["nodeCount"],
                "provider": manifest["provider"],
            }
        )
    )
