"""Command-line entrypoint for the DocAtlas document sidecar."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO

from .document_service import DocumentService
from .ingest import DocumentIndexStore
from .protocol import JsonValue, error_response, handle_request


def _write(stream: TextIO, value: object) -> None:
    stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    stream.write("\n")
    stream.flush()


def serve(stdin: TextIO, stdout: TextIO, document_service: DocumentService | None = None) -> None:
    """Serve JSONL requests until the Host closes stdin."""
    for raw_line in stdin:
        if raw_line.strip() == "":
            continue
        try:
            request: JsonValue = json.loads(raw_line)
        except json.JSONDecodeError:
            _write(
                stdout,
                error_response(None, -32700, "parse error", "invalid-request"),
            )
            continue
        _write(stdout, handle_request(request, document_service))


def main(argv: Sequence[str] | None = None) -> int:
    """Run a one-shot health probe or the stdio server."""
    parser = argparse.ArgumentParser(prog="docatlas-sidecar")
    parser.add_argument("--health", action="store_true", help="print one health response")
    parser.add_argument("--cache-root", help="absolute sidecar cache root")
    parser.add_argument(
        "--cache-only",
        action="store_true",
        help="read indexed documents without source-root grants",
    )
    parser.add_argument(
        "--source-root",
        action="append",
        default=[],
        metavar="ROOT_ID=ABSOLUTE_PATH",
        help="approved source root; repeat for multiple roots",
    )
    args = parser.parse_args(argv)
    if args.health:
        _write(
            sys.stdout,
            handle_request(
                {
                    "jsonrpc": "2.0",
                    "id": "health-cli",
                    "method": "health",
                    "params": {},
                }
            ),
        )
        return 0
    document_service = _document_service(parser, args.cache_root, args.source_root, args.cache_only)
    serve(sys.stdin, sys.stdout, document_service)
    return 0


def _document_service(
    parser: argparse.ArgumentParser,
    cache_root: str | None,
    raw_roots: list[str],
    cache_only: bool = False,
) -> DocumentService | None:
    if cache_root is None and not raw_roots and not cache_only:
        return None
    if cache_root is None or (not raw_roots and not cache_only) or (raw_roots and cache_only):
        parser.error("--cache-root and at least one --source-root must be provided together")
    cache_path = Path(cache_root)
    if not cache_path.is_absolute():
        parser.error("--cache-root must be absolute")
    roots: dict[str, Path] = {}
    for raw in raw_roots:
        root_id, separator, path = raw.partition("=")
        root_path = Path(path)
        if not separator or not root_id or not root_path.is_absolute():
            parser.error("--source-root must be ROOT_ID=ABSOLUTE_PATH")
        if root_id in roots:
            parser.error(f"duplicate source root id: {root_id}")
        roots[root_id] = root_path
    return DocumentService(DocumentIndexStore(roots, cache_path))


if __name__ == "__main__":
    raise SystemExit(main())
