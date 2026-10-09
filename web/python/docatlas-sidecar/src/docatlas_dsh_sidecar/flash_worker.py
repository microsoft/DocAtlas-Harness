"""Single-purpose namespace worker. No domain publication, credentials or model calls."""

from __future__ import annotations

import contextlib
import hashlib
import json
import resource
import sys
from typing import Any

from .process_security import lock_process_creation as _lock_process_creation


def _deny_external(event: str, args: tuple[object, ...]) -> None:
    del args
    if event in {
        "socket.connect",
        "socket.getaddrinfo",
        "os.fork",
        "os.posix_spawn",
        "subprocess.Popen",
    }:
        raise RuntimeError("Worker networking/process fanout is disabled")


def build(request: dict[str, Any]) -> dict[str, Any]:
    # Limits precede native PDFium import and untrusted file parsing.
    resource.setrlimit(resource.RLIMIT_AS, (request["memoryBytes"], request["memoryBytes"]))
    resource.setrlimit(resource.RLIMIT_CPU, (request["cpuSeconds"], request["cpuSeconds"]))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    _lock_process_creation()
    sys.addaudithook(_deny_external)
    from ._vendor.pageindex_flash import deterministic as opt

    path = "/input/source.pdf"
    with open(path, "rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise ValueError("invalid-pdf")
        stream.seek(0)
        if hashlib.file_digest(stream, "sha256").hexdigest() != request["sourceHash"]:
            raise ValueError("source-integrity")
    if "rawTreeHash" in request:
        with open("/input/raw.json", "rb") as raw_stream:
            raw_bytes = raw_stream.read(16 * 1024**2 + 1)
        if (
            len(raw_bytes) > 16 * 1024**2
            or hashlib.sha256(raw_bytes).hexdigest() != request["rawTreeHash"]
        ):
            raise ValueError("source-integrity")
        data = json.loads(raw_bytes)
        if data["generationId"] != request["rawGenerationId"]:
            raise ValueError("source-integrity")
        page_count = data["pageCount"]
        by_id: dict[str, dict[str, Any]] = {}
        roots: list[dict[str, Any]] = []
        for item in data["nodes"]:
            node = {
                "title": item["title"],
                "start_index": item["startPage"],
                "end_index": item["endPage"],
                "node_id": item["sourceNodeId"],
                "key_items": item["keyItems"],
            }
            by_id[item["nodeId"]] = node
            if item["parentId"] is None:
                roots.append(node)
            else:
                by_id[item["parentId"]].setdefault("nodes", []).append(node)
        result = {
            "structure": roots,
            "toc_source": request["rawTocSource"],
            "page_texts": ["readable"] if request["rawReadable"] else [],
        }
    else:
        import pypdfium2 as pdfium

        from ._vendor.pageindex_flash.flash.main import extract_toc

        try:
            pdf = pdfium.PdfDocument(path)
        except pdfium.PdfiumError:
            raise ValueError("invalid-pdf") from None
        try:
            page_count = len(pdf)
            if not 1 <= page_count <= request["maxPages"]:
                raise ValueError("resource-limit")
        finally:
            pdf.close()
        with contextlib.redirect_stdout(sys.stderr):
            result = extract_toc(path, workers=1, use_embedded_toc=request["useEmbeddedToc"])
    if not 1 <= page_count <= request["maxPages"]:
        raise ValueError("resource-limit")
    structure = result["structure"]
    before = float(opt.complexity(structure, page_count)["worst_case_search_complexity"])
    log: list[dict[str, Any]] = []
    rounds = 0
    if request["mode"] == "merge" and structure:
        frozen: set[str] = set()
        for rounds in range(1, 4):
            same = opt.merge_same_page(structure, log)
            merged = opt.merge(structure, opt.ROUTING_COST, log, frozen, False)
            if not (same or merged):
                break
        opt.relabel(structure)
    opt.strip_internal_keys(structure)
    after = float(opt.complexity(structure, page_count)["worst_case_search_complexity"])
    warnings = []
    if not structure:
        warnings.append("empty-tree")
    if not any(text.strip() for text in result.get("page_texts", [])):
        warnings.append("no-readable-text")
    return {
        "structure": structure,
        "pageCount": page_count,
        "tocSource": result.get("toc_source", "disabled"),
        "warnings": warnings,
        "optimization": {
            "mergeCount": sum(item["op"] == "merge" for item in log),
            "samePageMergeCount": sum(item["op"] == "merge_same_page" for item in log),
            "samePageDroppedCount": sum(
                item["dropped"] for item in log if item["op"] == "merge_same_page"
            ),
            "rounds": rounds,
            "costBefore": before,
            "costAfter": after,
        },
    }


def main() -> None:
    try:
        request = json.loads(sys.stdin.buffer.read(8193))
        result = build(request)
        output = json.dumps(
            {"ok": True, "result": result}, ensure_ascii=False, allow_nan=False
        ).encode()
        if len(output) > 16 * 1024 * 1024:
            raise ValueError("resource-limit")
    except BaseException as error:
        code = (
            str(error)
            if str(error) in {"invalid-pdf", "source-integrity", "resource-limit", "unavailable"}
            else "invalid-output"
        )
        if isinstance(error, MemoryError):
            code = "resource-limit"
        output = json.dumps({"ok": False, "code": code}).encode()
    sys.stdout.buffer.write(output)


if __name__ == "__main__":
    main()
