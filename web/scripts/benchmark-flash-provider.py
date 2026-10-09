"""Real raw/merge-reuse/reparse comparison; timings exclude ingest, report metadata only."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import time
from pathlib import Path

from docatlas_dsh_sidecar.flash_provider import FlashProvider
from docatlas_dsh_sidecar.ingest import DocumentIndexStore
from docatlas_dsh_sidecar.tree_index import TreeBuildRequest
from docatlas_dsh_sidecar.tree_service import TreeIndexService


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", nargs="+", type=Path)
    args = parser.parse_args()
    provider = FlashProvider()
    results = []
    for path in args.pdf:
        path = path.resolve(strict=True)
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        length = path.stat().st_size
        with tempfile.TemporaryDirectory(
            prefix="docatlas-flash-benchmark-"
        ) as temporary:
            store = DocumentIndexStore(
                {"root:benchmark": path.parent}, Path(temporary) / "cache"
            )
            ingested = store.ingest(
                {
                    "schemaVersion": 1,
                    "requestType": "ingest",
                    "idempotencyKey": "idempotency:benchmark",
                    "revision": {
                        "schemaVersion": 1,
                        "documentId": "doc:benchmark",
                        "revisionId": "rev:benchmark",
                        "contentHash": digest,
                        "byteLength": length,
                        "mediaType": "application/pdf",
                        "displayName": path.name,
                        "origin": {"kind": "local-file"},
                        "ingestedAt": "2026-09-08T12:00:00Z",
                        "status": "active",
                    },
                    "sourceBinding": {
                        "schemaVersion": 1,
                        "bindingId": "binding:benchmark",
                        "rootId": "root:benchmark",
                        "relativePath": path.name,
                        "expectedContentHash": digest,
                        "byteLength": length,
                        "mediaType": "application/pdf",
                    },
                    "requestedRepresentationKinds": ["embedded-text"],
                    "options": {
                        "forceRebuild": False,
                        "allowOcr": False,
                        "maxPages": 1,
                    },
                }
            )
            service = TreeIndexService(store, provider)
            request: TreeBuildRequest = {
                "schemaVersion": 1,
                "kind": "build-tree",
                "documentId": "doc:benchmark",
                "revisionId": "rev:benchmark",
                "sourceHash": digest,
                "config": {"mode": "raw", "useEmbeddedToc": True, "workers": 1},
            }
            start = time.perf_counter()
            raw = service.build(request)
            raw_seconds = time.perf_counter() - start
            start = time.perf_counter()
            merged = service.build(
                {**request, "config": {**request["config"], "mode": "merge"}}
            )
            merge_seconds = time.perf_counter() - start
            original = next(
                item
                for item in ingested["representations"]
                if item["kind"] == "original-bytes"
            )
            asset = store.asset_store.snapshot(original["representationId"])
            assert asset is not None
            start = time.perf_counter()
            rebuilt = provider.build(
                asset.content_path, digest, merged["generationId"], merged["config"]
            )
            rebuilt_seconds = time.perf_counter() - start
            data = json.loads(
                (
                    store.cache_root
                    / "tree-generations"
                    / merged["generationId"][5:]
                    / "data.json"
                ).read_bytes()
            )
            assert (
                data == rebuilt.data and merged["optimization"] == rebuilt.optimization
            )
            results.append(
                {
                    "file": path.name,
                    "pages": raw["pageCount"],
                    "rawNodes": raw["nodeCount"],
                    "mergeNodes": merged["nodeCount"],
                    "rawSeconds": round(raw_seconds, 3),
                    "mergeFromRawSeconds": round(merge_seconds, 3),
                    "mergeReparseSeconds": round(rebuilt_seconds, 3),
                    "identicalMergeData": True,
                    "tocSource": raw["tocSource"],
                    "warnings": raw["warnings"],
                    "optimization": merged["optimization"],
                }
            )
    print(json.dumps({"provider": provider.identity, "results": results}, indent=2))


if __name__ == "__main__":
    main()
