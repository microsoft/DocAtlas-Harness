"""Build PageIndex tree structures for PDF documents.

Thin wrapper around the ``pageindex`` package that integrates tree
construction into DocAtlas's CLI and configuration system.

Usage:
    # Single PDF
    uv run --locked docatlas build-tree --pdf doc.pdf --output-dir trees/

    # Batch (all PDFs in a directory)
    uv run --locked docatlas build-tree --pdf-dir documents/ --output-dir trees/ --limit 5

    # MMLongBench convenience
    bash scripts/run_build_tree.sh --only-sampled
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Any

from ._io import atomic_write_json


def _ensure_pageindex():
    """Verify that the release's pinned PageIndex snapshot is importable."""
    try:
        import docatlas._vendor.pageindex  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "Cannot import the vendored PageIndex snapshot from docatlas/_vendor/pageindex. "
            "Reinstall DocAtlas from a complete source or wheel distribution."
        ) from exc


# ---------------------------------------------------------------------------
# Document discovery
# ---------------------------------------------------------------------------


def _discover_documents(args: argparse.Namespace) -> list[dict]:
    """Build a list of ``{doc_id, pdf_path, sampled}`` dicts."""
    # Single PDF mode
    if getattr(args, "pdf", None):
        p = os.path.abspath(args.pdf)
        if not os.path.isfile(p):
            return []
        return [{"doc_id": os.path.basename(p), "pdf_path": p, "sampled": True}]

    # Batch directory mode
    pdf_dir = getattr(args, "pdf_dir", None)
    if not pdf_dir or not os.path.isdir(pdf_dir):
        return []

    all_pdfs = {}
    for f in sorted(os.listdir(pdf_dir)):
        if f.lower().endswith(".pdf"):
            all_pdfs[f] = os.path.join(pdf_dir, f)

    # Sampled docs from samples.json
    sampled_docs: set[str] = set()
    samples_file = getattr(args, "samples_file", None)
    if samples_file and os.path.isfile(samples_file):
        with open(samples_file, encoding="utf-8") as fh:
            samples = json.load(fh)
        if isinstance(samples, dict) and "results" in samples:
            samples = samples["results"]
        sampled_docs = {
            s.get("doc_id", "") for s in samples if isinstance(s, dict) and s.get("doc_id")
        }

    docs = []
    for doc_id, pdf_path in all_pdfs.items():
        is_sampled = doc_id in sampled_docs
        if getattr(args, "only_sampled", False) and not is_sampled:
            continue
        docs.append({"doc_id": doc_id, "pdf_path": pdf_path, "sampled": is_sampled})

    # --doc-filter
    doc_filter = getattr(args, "doc_filter", None)
    if doc_filter:
        patterns = [p.strip().lower() for p in doc_filter.split(",")]
        docs = [d for d in docs if any(p in d["doc_id"].lower() for p in patterns)]

    # --start / --limit
    start = getattr(args, "start", 0)
    limit = getattr(args, "limit", 0)
    if start > 0:
        docs = docs[start:]
    if limit > 0:
        docs = docs[:limit]

    return docs


def _get_existing_trees(output_dir: str) -> set[str]:
    """Return base names of existing, parseable tree artifacts."""
    existing: set[str] = set()
    for fp in glob.glob(os.path.join(output_dir, "*_structure.json")):
        try:
            with open(fp, encoding="utf-8") as handle:
                payload = json.load(handle)
            if not isinstance(payload, (dict, list)):
                continue
        except (OSError, json.JSONDecodeError):
            continue
        base = os.path.basename(fp).replace("_structure.json", "")
        existing.add(base)
    return existing


# ---------------------------------------------------------------------------
# Single-PDF builder
# ---------------------------------------------------------------------------


def _build_single(
    pdf_path: str,
    output_dir: str,
    args: argparse.Namespace,
) -> dict:
    """Build a tree for one PDF. Returns a result dict."""
    _ensure_pageindex()
    from docatlas._vendor.pageindex import config as pi_config
    from docatlas._vendor.pageindex import page_index_main
    from docatlas._vendor.pageindex.utils import set_enable_thinking

    t0 = time.time()
    pdf_name = os.path.splitext(os.path.basename(pdf_path))[0]
    output_file = os.path.join(output_dir, f"{pdf_name}_structure.json")

    try:
        if getattr(args, "no_think", False):
            set_enable_thinking(False)

        opt = pi_config(
            model=args.model,
            toc_check_page_num=args.toc_check_pages,
            max_page_num_each_node=args.max_pages_per_node,
            max_token_num_each_node=args.max_tokens_per_node,
            if_add_node_id="yes",
            if_add_node_summary="yes" if args.node_summary else "no",
            if_add_doc_description="no",
            if_add_node_text="no",
            vision="yes" if args.vision else "no",
            vision_zoom=args.vision_zoom,
            enable_thinking=False if getattr(args, "no_think", False) else None,
        )

        toc_result = page_index_main(pdf_path, opt)

        os.makedirs(output_dir, exist_ok=True)
        atomic_write_json(output_file, toc_result)

        return {
            "success": True,
            "output_file": output_file,
            "latency_s": time.time() - t0,
            "error": None,
        }

    except Exception as e:
        return {
            "success": False,
            "output_file": output_file,
            "latency_s": time.time() - t0,
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        }


# ---------------------------------------------------------------------------
# Task class
# ---------------------------------------------------------------------------


class BuildTreeTask:
    """``build-tree`` subcommand — construct PageIndex trees for PDFs."""

    @staticmethod
    def add_arguments(parser: argparse.ArgumentParser) -> None:
        # Input
        g = parser.add_mutually_exclusive_group(required=True)
        g.add_argument("--pdf", help="Single PDF path.")
        g.add_argument("--pdf-dir", help="Directory of PDFs for batch build.")
        parser.add_argument(
            "--output-dir",
            required=True,
            help="Output directory for *_structure.json files.",
        )

        # PageIndex config
        parser.add_argument(
            "--model",
            required=True,
            help="LLM model / Azure deployment name for tree construction.",
        )
        parser.add_argument(
            "--vision", action="store_true", help="Enable vision (page images) for TOC detection."
        )
        parser.add_argument(
            "--vision-zoom", type=float, default=1.5, help="Render zoom for vision mode."
        )
        parser.add_argument(
            "--toc-check-pages", type=int, default=20, help="Max pages to scan for TOC."
        )
        parser.add_argument("--max-pages-per-node", type=int, default=10)
        parser.add_argument("--max-tokens-per-node", type=int, default=20000)
        parser.add_argument(
            "--node-summary", action="store_true", default=True, help="Generate per-node summaries."
        )
        parser.add_argument("--no-node-summary", dest="node_summary", action="store_false")
        parser.add_argument(
            "--no-think", action="store_true", help="Disable thinking mode for supported models."
        )

        # Batch control
        parser.add_argument("--force", action="store_true", help="Rebuild even if tree exists.")
        parser.add_argument("--doc-filter", help="Comma-separated substrings to filter doc names.")
        parser.add_argument("--start", type=int, default=0)
        parser.add_argument("--limit", type=int, default=0)

        # MMLongBench convenience
        parser.add_argument("--samples-file", help="samples.json to filter only sampled docs.")
        parser.add_argument("--only-sampled", action="store_true")

    @staticmethod
    def run(args: argparse.Namespace) -> int:
        # Load .env for Azure credentials
        from ..config import _maybe_load_dotenv

        _maybe_load_dotenv()

        if args.vision_zoom <= 0:
            print("error: --vision-zoom must be greater than zero", file=sys.stderr)
            return 2
        if min(args.toc_check_pages, args.max_pages_per_node, args.max_tokens_per_node) < 1:
            print("error: tree size limits must be positive", file=sys.stderr)
            return 2
        if args.start < 0 or args.limit < 0:
            print("error: --start and --limit must be non-negative", file=sys.stderr)
            return 2

        _ensure_pageindex()

        docs = _discover_documents(args)
        if not docs:
            print("No documents found to build.", file=sys.stderr)
            return 1

        output_dir = os.path.abspath(args.output_dir)
        os.makedirs(output_dir, exist_ok=True)

        # Skip existing (unless --force)
        existing = _get_existing_trees(output_dir)
        if not args.force:
            before = len(docs)
            docs = [d for d in docs if os.path.splitext(d["doc_id"])[0] not in existing]
            skipped = before - len(docs)
            if skipped:
                print(
                    f"Skipped {skipped} documents with existing trees (use --force to rebuild).",
                    file=sys.stderr,
                )

        if not docs:
            print("All documents already have trees. Nothing to do.", file=sys.stderr)
            return 0

        # Print build plan
        print(f"{'=' * 60}", file=sys.stderr)
        print("  PageIndex Tree Build", file=sys.stderr)
        print(f"{'=' * 60}", file=sys.stderr)
        print(f"  Documents: {len(docs)}", file=sys.stderr)
        print(f"  Model: {args.model}", file=sys.stderr)
        print(f"  Vision: {'yes' if args.vision else 'no'}", file=sys.stderr)
        print(f"  Output: {output_dir}", file=sys.stderr)
        print(f"{'=' * 60}", file=sys.stderr)

        # Build loop
        build_log: dict[str, Any] = {
            "config": {
                "model": args.model,
                "vision": args.vision,
                "toc_check_pages": args.toc_check_pages,
                "max_pages_per_node": args.max_pages_per_node,
                "max_tokens_per_node": args.max_tokens_per_node,
                "node_summary": args.node_summary,
            },
            "started_at": datetime.now(timezone.utc).isoformat(),
            "results": [],
        }
        log_path = os.path.join(output_dir, "build_log.json")

        success_count = 0
        fail_count = 0

        for i, doc in enumerate(docs, 1):
            doc_id = doc["doc_id"]
            pdf_path = doc["pdf_path"]
            print(f"  [{i}/{len(docs)}] {doc_id} ...", end=" ", file=sys.stderr, flush=True)

            result = _build_single(pdf_path, output_dir, args)

            if result["success"]:
                success_count += 1
                print(f"OK ({result['latency_s']:.1f}s)", file=sys.stderr)
            else:
                fail_count += 1
                print(f"FAIL: {result['error']}", file=sys.stderr)

            build_log["results"].append(
                {
                    "doc_id": doc_id,
                    "sampled": doc.get("sampled", False),
                    "success": result["success"],
                    "latency_s": result["latency_s"],
                    "output_file": result["output_file"],
                    "error": result.get("error"),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )

            # Incremental log save
            atomic_write_json(log_path, build_log)

        # Summary
        print(f"\n{'=' * 60}", file=sys.stderr)
        print(
            f"  Done: {success_count} success, {fail_count} failed, {len(docs)} total",
            file=sys.stderr,
        )
        print(f"  Output: {output_dir}", file=sys.stderr)
        print(f"  Log: {log_path}", file=sys.stderr)
        print(f"{'=' * 60}", file=sys.stderr)

        return 0 if fail_count == 0 else 1
