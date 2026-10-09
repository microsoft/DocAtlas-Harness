"""One-shot internal tree job: canonical request on stdin, result or protocol-error on stdout."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import cast

from .flash_provider import FlashProvider, TreeIndexError, canonical
from .ingest import DocumentIndexStore
from .schema_validation import validate_contract_shape
from .tree_index import TreeBuildRequest, TreeReadRequest
from .tree_service import TreeIndexService


def main() -> int:
    parser = argparse.ArgumentParser(prog="docatlas-tree")
    parser.add_argument("--cache-root", type=Path, required=True)
    args = parser.parse_args()
    root: Path = args.cache_root
    if (
        not root.is_absolute()
        or not (root / "indexes").is_dir()
        or not (root / "assets").is_dir()
        or not (root / "control.sqlite3").is_file()
    ):
        parser.error("--cache-root must identify an existing document cache")
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise TreeIndexError("invalid-request", "Tree request exceeds byte limit")
        request = json.loads(raw)
        if validate_contract_shape("tree-index", request) or request["kind"] not in {
            "build-tree",
            "read-tree",
        }:
            raise TreeIndexError("invalid-request", "Expected a canonical tree request")
        service = TreeIndexService(DocumentIndexStore({}, root), FlashProvider())
        result = (
            service.build(cast(TreeBuildRequest, request))
            if request["kind"] == "build-tree"
            else service.read(cast(TreeReadRequest, request))
        )
        sys.stdout.buffer.write(canonical(result) + b"\n")
        return 0
    except Exception:
        # No PDF text, cache paths or worker stderr are forwarded by the failure channel.
        error = sys.exception()
        code = (
            error.code
            if isinstance(error, TreeIndexError)
            else "invalid-request"
            if isinstance(error, (ValueError, TypeError))
            else "internal"
        )
        public_code = {
            "resource-limit": "limit-exceeded",
            "source-integrity": "integrity-error",
            "index-integrity": "integrity-error",
            "invalid-output": "internal",
            "invalid-pdf": "invalid-params",
        }.get(code, code)
        failure = {
            "schemaVersion": 1,
            "code": public_code,
            "message": "Tree job failed; original content is unchanged",
            "retryable": False,
            "details": [{"reason": code}],
        }
        sys.stdout.buffer.write(canonical(failure) + b"\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
