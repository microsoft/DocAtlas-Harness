#!/usr/bin/env python3
"""Run the progressive Reader boundary against a bounded local PDF corpus.

This utility never copies source files into the repository. It hashes each immutable
input, builds indexes in a temporary cache, reads page 1, renders a bounded page PNG,
and emits a JSON report suitable for attaching to a local verification record.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import time
from pathlib import Path
from typing import Any

from docatlas_dsh_sidecar.document_service import DocumentService
from docatlas_dsh_sidecar.ingest import DocumentIndexStore, IngestFailure


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def opaque(prefix: str, value: str) -> str:
    return f"{prefix}:{hashlib.sha256(value.encode()).hexdigest()[:32]}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("roots", nargs="+", type=Path)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--max-bytes", type=int, default=64 * 1024 * 1024)
    parser.add_argument("--allow-failures", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit < 1 or args.max_pages < 1 or args.max_bytes < 1:
        raise SystemExit("limit, max-pages, and max-bytes must be positive")
    roots = [root.resolve(strict=True) for root in args.roots]
    candidates = sorted(
        (
            path
            for root in roots
            for path in root.rglob("*.pdf")
            if path.is_file() and not path.is_symlink() and path.stat().st_size <= args.max_bytes
        ),
        key=lambda path: (path.stat().st_size, str(path)),
    )[: args.limit]
    if len(candidates) < args.limit:
        raise SystemExit(f"found only {len(candidates)} eligible PDFs; requested {args.limit}")

    source_roots = {f"root:corpus:{index}": root for index, root in enumerate(roots)}
    report: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="docatlas-reader-corpus-") as cache:
        store = DocumentIndexStore(source_roots, Path(cache))
        service = DocumentService(store)
        for index, path in enumerate(candidates, start=1):
            root_index = next(i for i, root in enumerate(roots) if path.is_relative_to(root))
            root = roots[root_index]
            root_id = f"root:corpus:{root_index}"
            relative = path.relative_to(root).as_posix()
            content_hash = digest_file(path)
            byte_length = path.stat().st_size
            document_id = opaque("doc", f"{root_id}\0{relative}")
            revision_id = opaque("rev", f"{document_id}\0{content_hash}")
            started = time.monotonic()
            item: dict[str, Any] = {
                "ordinal": index,
                "name": path.name,
                "bytes": byte_length,
            }
            try:
                ingested = store.ingest(
                    {
                        "schemaVersion": 1,
                        "requestType": "ingest",
                        "idempotencyKey": opaque("idempotency", f"{document_id}\0{content_hash}"),
                        "revision": {
                            "schemaVersion": 1,
                            "documentId": document_id,
                            "revisionId": revision_id,
                            "contentHash": content_hash,
                            "byteLength": byte_length,
                            "mediaType": "application/pdf",
                            "displayName": path.name,
                            "origin": {"kind": "local-file"},
                            "ingestedAt": "2026-08-31T00:00:00Z",
                            "status": "active",
                        },
                        "sourceBinding": {
                            "schemaVersion": 1,
                            "bindingId": opaque("binding", f"{root_id}\0{relative}"),
                            "rootId": root_id,
                            "relativePath": relative,
                            "expectedContentHash": content_hash,
                            "byteLength": byte_length,
                            "mediaType": "application/pdf",
                        },
                        "requestedRepresentationKinds": ["embedded-text"],
                        "options": {
                            "forceRebuild": False,
                            "allowOcr": False,
                            "maxPages": args.max_pages,
                        },
                    }
                )
                active = ingested["representations"][-1]
                source = {
                    "documentId": document_id,
                    "revisionId": revision_id,
                    "representationId": active["representationId"],
                }
                page = service.read(
                    {
                        "schemaVersion": 1,
                        "requestType": "read",
                        "mode": "page",
                        "source": source,
                        "limits": {"maxItems": 200, "maxChars": 20_000},
                        "physicalPage": 1,
                    }
                )
                visual = service.read(
                    {
                        "schemaVersion": 1,
                        "requestType": "read",
                        "mode": "visual",
                        "source": source,
                        "limits": {"maxItems": 1, "maxChars": 1},
                        "physicalPage": 1,
                        "maxPixels": 250_000,
                    }
                )
                asset = visual["items"][0]["asset"]
                item.update(
                    {
                        "status": "ok",
                        "totalPages": ingested["index"]["totalPages"],
                        "indexedPages": ingested["index"]["indexedPages"],
                        "textQuality": page["textQuality"],
                        "pageBlocks": len(page["items"]),
                        "pageTextChars": page["pageInfo"]["usedChars"],
                        "renderPixels": asset["width"] * asset["height"],
                    }
                )
            except IngestFailure as error:
                item.update({"status": "rejected", "code": error.code})
            except Exception as error:  # pragma: no cover - diagnostic containment
                item.update({"status": "failed", "errorType": type(error).__name__})
            item["elapsedMs"] = round((time.monotonic() - started) * 1000)
            report.append(item)

    summary = {
        "schemaVersion": 1,
        "requested": args.limit,
        "completed": len(report),
        "passed": sum(item["status"] == "ok" for item in report),
        "rejected": sum(item["status"] == "rejected" for item in report),
        "failed": sum(item["status"] == "failed" for item in report),
        "items": report,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if args.allow_failures or summary["passed"] == args.limit else 1


if __name__ == "__main__":
    raise SystemExit(main())
