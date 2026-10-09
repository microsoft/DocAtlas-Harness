"""Research-only Flash bounded-worker/bookmark probe against the exact source pin.

Run with the pinned uv interpreter and explicitly pinned additional packages (see research/18).
Not imported by the product, and not a substitute for its versioned provider contract.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType
from typing import Any

from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[1]


def deny_external_execution(event: str, args: tuple[object, ...]) -> None:
    del args
    if event in {
        "socket.connect",
        "socket.getaddrinfo",
        "os.fork",
        "os.posix_spawn",
        "subprocess.Popen",
    }:
        raise RuntimeError(f"Offline, single-worker probe forbids {event}")


def inspect_tree(nodes: list[dict[str, Any]], page_count: int) -> tuple[int, int]:
    count = 0
    invalid = 0
    stack = [(node, 1, page_count, 0) for node in nodes]
    while stack:
        node, parent_start, parent_end, depth = stack.pop()
        count += 1
        if count > 20_000 or depth > 64:
            raise RuntimeError("Unbounded Flash tree")
        start, end = node.get("start_index"), node.get("end_index")
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or not parent_start <= start <= end <= parent_end
        ):
            invalid += 1
            continue
        stack.extend((child, start, end, depth + 1) for child in node.get("nodes", []))
    return count, invalid


def main() -> None:
    if sys.version_info[:3] != (3, 12, 12):
        raise RuntimeError("Use CPython 3.12.12 through uv")
    source = next(
        item
        for item in json.loads((ROOT / "sources.lock.json").read_text())["sources"]
        if item["name"] == "pageindex"
    )
    checkout = ROOT / source["path"]
    actual = subprocess.check_output(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    if actual != source["commit"]:
        raise RuntimeError("PageIndex checkout differs from source lock")
    resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    sys.addaudithook(deny_external_execution)

    # Research namespace only: avoid importing the SDK's separate chat/cloud dependency graph.
    # Calling the pinned internal extract_toc gives the workers parameter missing in its public API.
    namespace = ModuleType("pageindex")
    namespace.__path__ = [str(checkout / "pageindex")]
    sys.modules["pageindex"] = namespace
    extract_toc = importlib.import_module("pageindex.flash.main").extract_toc
    raw = base64.b64decode(
        (ROOT / "apps/web/fixtures/sample-report.pdf.base64").read_text()
    )
    if (
        hashlib.sha256(raw).hexdigest()
        != "161ea6a246e2520ec26795013d24a9deb8f60f471acd0cdf7ea273a43a6e8fb4"
    ):
        raise RuntimeError("Sample bytes changed")
    results = []
    with tempfile.TemporaryDirectory(prefix="docatlas-flash-boundary-") as temp:
        sample = Path(temp) / "sample.pdf"
        sample.write_bytes(raw)
        reader = PdfReader(sample)
        bookmarks = PdfWriter()
        for page in reader.pages:
            bookmarks.add_page(page)
        root = bookmarks.add_outline_item("Annual Widget Report 2025", 0)
        bookmarks.add_outline_item("Financial Highlights", 1, parent=root)
        bookmarks.add_outline_item("Regional Performance", 2, parent=root)
        bookmarks.add_outline_item("Roadmap", 4, parent=root)
        bookmarks.add_outline_item("Risks and Outlook", 5, parent=root)
        bookmarked = Path(temp) / "bookmarks.pdf"
        bookmarks.write(bookmarked)
        long_writer = PdfWriter()
        for index in range(65):
            long_writer.add_page(reader.pages[index % len(reader.pages)])
        long_pdf = Path(temp) / "long-65.pdf"
        long_writer.write(long_pdf)
        for name, path, embedded in [
            ("sample-raw", sample, False),
            ("sample-bookmarks", bookmarked, True),
            ("sample-ignore-bookmarks", bookmarked, False),
            ("long-single-worker", long_pdf, True),
        ]:
            started = time.perf_counter()
            result = extract_toc(str(path), workers=1, use_embedded_toc=embedded)
            elapsed = time.perf_counter() - started
            pages = len(PdfReader(path).pages)
            nodes, invalid = inspect_tree(result["structure"], pages)
            if invalid:
                raise RuntimeError(f"{name}: {invalid} invalid tree ranges")
            results.append(
                {
                    "case": name,
                    "pages": pages,
                    "nodes": nodes,
                    "invalidRanges": invalid,
                    "treeStatus": "available" if nodes else "empty",
                    "seconds": round(elapsed, 3),
                    "tocSource": result.get("toc_source"),
                    "treeHash": hashlib.sha256(
                        json.dumps(result["structure"], sort_keys=True).encode()
                    ).hexdigest(),
                }
            )
    if results[0]["nodes"] < 1 or results[1]["tocSource"] != "hybrid":
        raise RuntimeError("Sample structure/bookmark fusion did not occur")
    if results[0]["treeHash"] != results[2]["treeHash"]:
        raise RuntimeError("Ignoring bookmarks changed raw detected structure")
    print(
        json.dumps(
            {
                "sourceCommit": actual,
                "workers": 1,
                "networkAndChildSpawn": "blocked-by-audit-hook",
                "cpuLimitSeconds": 90,
                "addressSpaceLimitMiB": 2048,
                "peakRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                "results": results,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
