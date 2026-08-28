"""Build a merged series tree from N PDFs in one shot.

Pipeline (per input PDF):

    PDF ──build-tree──► <tmp>/<doc_stem>_structure.json
                        \\
    ...   ──merge-trees──► <output>/<series>.json

Trees are written into ``--trees-dir`` (default: alongside the output
file). If a doc's tree already exists there, it's reused (unless
``--force-trees`` is passed).

Use this when you want one command to take you from a set of PDFs to a
ready-to-eval merged series tree, without manually running build-tree N
times then merge-trees.

Example::

    uv run --locked docatlas build-series-tree \\
        --pdf docs/ar2018.pdf --pdf docs/ar2019.pdf --pdf docs/ar2020.pdf \\
        --output trees/series/bis_2018_2020.json \\
        --doc-name "BIS AR 2018-2020" \\
        --model gpt-4o

A manifest is also accepted (lets you override title/summary per doc)::

    uv run --locked docatlas build-series-tree \\
        --manifest series_manifest.json \\
        --output trees/series/foo.json \\
        --doc-name "Foo series"

Where ``series_manifest.json`` is a JSON list of objects::

    [
      {"pdf": "docs/ar2018.pdf", "title": "Annual Economic Report 2018"},
      {"pdf": "docs/ar2019.pdf", "title": "Annual Economic Report 2019",
       "summary": "Focus on monetary policy normalisation..."}
    ]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from ._io import atomic_write_json
from .build_tree import _build_single as _build_tree_single
from .merge_trees import merge_trees


def _resolve_inputs(args: argparse.Namespace) -> tuple[list[str], list[dict]]:
    """Return (pdf_paths, overrides) where overrides[i] may carry title/summary."""

    def validate_unique_stems(pdfs: list[str]) -> None:
        stems = [Path(path).stem.casefold() for path in pdfs]
        duplicates = sorted({stem for stem in stems if stems.count(stem) > 1})
        if duplicates:
            raise ValueError(
                "PDF basenames must be unique because tree cache keys use the filename stem: "
                f"{duplicates}"
            )

    if args.manifest:
        with open(args.manifest, encoding="utf-8") as fh:
            entries = json.load(fh)
        if not isinstance(entries, list):
            raise ValueError("--manifest must be a JSON list")
        pdfs: list[str] = []
        ovs: list[dict] = []
        for e in entries:
            if not isinstance(e, dict) or "pdf" not in e:
                raise ValueError("--manifest entries must be {pdf, ...} objects")
            pdf_path = os.path.abspath(e["pdf"])
            if not os.path.isfile(pdf_path):
                raise FileNotFoundError(f"PDF not found: {pdf_path}")
            pdfs.append(pdf_path)
            ovs.append(
                {
                    "title": e.get("title"),
                    "summary": e.get("summary"),
                    "source_pdf": e.get("source_pdf"),
                }
            )
        validate_unique_stems(pdfs)
        return pdfs, ovs
    if not args.pdf:
        raise ValueError("must pass --pdf one or more times, or --manifest")
    pdfs = []
    for p in args.pdf:
        ap = os.path.abspath(p)
        if not os.path.isfile(ap):
            raise FileNotFoundError(f"PDF not found: {ap}")
        pdfs.append(ap)
    validate_unique_stems(pdfs)
    return pdfs, [{} for _ in pdfs]


class BuildSeriesTreeTask:
    """``build-series-tree`` subcommand — PDFs → trees → merged series JSON."""

    @staticmethod
    def add_arguments(parser: argparse.ArgumentParser) -> None:
        g = parser.add_mutually_exclusive_group(required=True)
        g.add_argument(
            "--pdf",
            action="append",
            default=None,
            help="PDF input. Repeat for multiple docs.",
        )
        g.add_argument(
            "--manifest",
            help="JSON list of {pdf, title?, summary?, source_pdf?}.",
        )
        parser.add_argument(
            "--output",
            "-o",
            required=True,
            help="Output path for the merged series tree JSON.",
        )
        parser.add_argument(
            "--doc-name",
            required=True,
            help="Display name for the merged series.",
        )
        parser.add_argument(
            "--doc-description",
            default=None,
            help="Optional description for the merged series.",
        )
        parser.add_argument(
            "--trees-dir",
            default=None,
            help="Where to store per-doc _structure.json files (default: "
            "next to --output, in 'trees_cache/').",
        )
        parser.add_argument(
            "--force-trees",
            action="store_true",
            help="Rebuild per-doc trees even if cached files exist.",
        )

        # ── Forward-compatible build-tree knobs (same defaults as build-tree) ──
        parser.add_argument(
            "--model",
            required=True,
            help="LLM model / Azure deployment name for per-doc tree construction.",
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
            "--node-summary",
            action="store_true",
            default=True,
            help="Generate per-node summaries (default on).",
        )
        parser.add_argument("--no-node-summary", dest="node_summary", action="store_false")
        parser.add_argument(
            "--no-think", action="store_true", help="Disable thinking mode for supported models."
        )

    @staticmethod
    def run(args: argparse.Namespace) -> int:
        # Load .env (Azure credentials).
        from ..config import _maybe_load_dotenv

        _maybe_load_dotenv()

        try:
            pdfs, overrides = _resolve_inputs(args)
        except Exception as exc:  # noqa: BLE001
            print(f"error: {exc}", file=sys.stderr)
            return 2

        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        trees_dir = (
            Path(args.trees_dir).resolve() if args.trees_dir else output.parent / "trees_cache"
        )
        trees_dir.mkdir(parents=True, exist_ok=True)

        print("=" * 60)
        print("  DocAtlas · Build-Series-Tree")
        print("=" * 60)
        print(f"  PDFs       : {len(pdfs)}")
        print(f"  Trees dir  : {trees_dir}")
        print(f"  Output     : {output}")
        print(f"  Series name: {args.doc_name}")
        print(f"  Model      : {args.model}")
        print("=" * 60)

        # ── Stage 1: build per-doc trees (idempotent unless --force-trees) ──
        tree_paths: list[str] = []
        for i, pdf in enumerate(pdfs, 1):
            stem = os.path.splitext(os.path.basename(pdf))[0]
            tree_path = trees_dir / f"{stem}_structure.json"
            if tree_path.is_file() and not args.force_trees:
                print(f"[{i}/{len(pdfs)}] {stem}: CACHED tree")
                tree_paths.append(str(tree_path))
                continue
            print(f"[{i}/{len(pdfs)}] {stem}: building tree ...", flush=True)
            # Reuse build_tree._build_single by faking the args it expects.
            ns = argparse.Namespace(
                model=args.model,
                vision=args.vision,
                vision_zoom=args.vision_zoom,
                toc_check_pages=args.toc_check_pages,
                max_pages_per_node=args.max_pages_per_node,
                max_tokens_per_node=args.max_tokens_per_node,
                node_summary=args.node_summary,
                no_think=args.no_think,
            )
            res = _build_tree_single(pdf, str(trees_dir), ns)
            if not res["success"]:
                print(f"  FAIL: {res.get('error')}", file=sys.stderr)
                return 1
            print(f"  OK ({res['latency_s']:.1f}s) → {res['output_file']}")
            tree_paths.append(res["output_file"])

        # ── Stage 2: merge → series JSON ──
        print()
        print(f"Merging {len(tree_paths)} trees → {output}")
        # Attach pdf basename overrides so source_pdf is correct.
        for i, pdf in enumerate(pdfs):
            if not overrides[i].get("source_pdf"):
                overrides[i] = {**overrides[i], "source_pdf": os.path.basename(pdf)}
        merged = merge_trees(
            tree_paths,
            overrides=overrides,
            doc_name=args.doc_name,
            doc_description=args.doc_description,
        )
        atomic_write_json(output, merged)

        n_docs = len(merged["structure"])
        print(f"  → {n_docs} docs merged")
        print("=" * 60)
        return 0
