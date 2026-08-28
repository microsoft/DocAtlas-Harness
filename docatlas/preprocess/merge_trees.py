"""Merge N single-doc PageIndex trees into one series tree.

The output schema matches the series-tree JSON format,
so anything downstream that already consumes that format (notably
``docatlas.benchmarks.mmlongbench.io.load_series_trees`` and search/read's
multi-doc routing) works unchanged.

Output:

    {
      "doc_name": "<series name>",
      "doc_description": "Merged from N single-doc PageIndex trees.",
      "structure": [
        { "title": "<doc 0 name>",
          "node_id": "D000_root",
          "source_file": "<basename of input tree json>",
          "source_pdf":  "<basename(.pdf) of source>",
          "start_index": 1,
          "end_index":   <total pages of that doc>,
          "summary": "<optional, from input>",
          "nodes": [
            { "node_id": "D000_0000", "title": "Preface", ... },
            { "node_id": "D000_0001", "title": "Editorial", ... }
          ]
        },
        { "title": "<doc 1 name>", "node_id": "D001_root", ... },
        ...
      ]
    }

Every node_id from the input trees is rewritten with a ``D{idx:03d}_``
prefix so node ids stay globally unique across the merged tree.

The two CLI shapes are:

    # 1) explicit list of tree files
    uv run --locked harness merge-trees \\
        --tree-files tree1.json tree2.json tree3.json \\
        --output trees/series/foo.json \\
        --doc-name "Foo series"

    # 2) directory + glob filter
    uv run --locked harness merge-trees \\
        --tree-dir results/trees \\
        --include "*ar20*" \\
        --output trees/series/bis_ar.json \\
        --doc-name "BIS AR 2018-2024"

    # 3) manifest (JSON list of {tree, pdf?, title?, summary?})
    uv run --locked harness merge-trees \\
        --manifest series_manifest.json \\
        --output trees/series/foo.json \\
        --doc-name "Foo series"

The manifest is the most flexible — each entry can override the title
shown in the merged tree (otherwise we fall back to the input's
``doc_name`` field, else the file stem).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
from pathlib import Path

from ._io import atomic_write_json

# ── Input loading ──────────────────────────────────────────────────────────


def _load_tree_json(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, list):
        return {"doc_name": Path(path).stem, "structure": data}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: tree JSON is not an object")
    if "structure" not in data:
        raise ValueError(f"{path}: tree JSON missing 'structure' key")
    return data


def _resolve_tree_paths(args: argparse.Namespace) -> list[str]:
    paths: list[str] = []
    if args.tree_files:
        for p in args.tree_files:
            if not os.path.isfile(p):
                raise FileNotFoundError(f"tree file not found: {p}")
            paths.append(os.path.abspath(p))
    elif args.tree_dir:
        d = Path(args.tree_dir)
        if not d.is_dir():
            raise FileNotFoundError(f"tree dir not found: {d}")
        glob_pat = args.include or "*_structure.json"
        for f in sorted(d.glob("*.json")):
            if not fnmatch.fnmatch(f.name, glob_pat):
                continue
            paths.append(str(f))
    elif args.manifest:
        with open(args.manifest, encoding="utf-8") as fh:
            entries = json.load(fh)
        if not isinstance(entries, list):
            raise ValueError("--manifest must be a JSON list")
        for e in entries:
            if not isinstance(e, dict) or "tree" not in e:
                raise ValueError("--manifest entries must be {tree, ...} objects")
            paths.append(os.path.abspath(e["tree"]))
    else:
        raise ValueError("one of --tree-files / --tree-dir / --manifest is required")
    if not paths:
        raise ValueError("no tree files matched")
    return paths


def _manifest_overrides(args: argparse.Namespace, n: int) -> list[dict]:
    """Return per-doc overrides (title / source_pdf / summary), keyed by index.
    If no manifest is given, returns N empty dicts."""
    if not args.manifest:
        return [{} for _ in range(n)]
    with open(args.manifest, encoding="utf-8") as fh:
        entries = json.load(fh)
    out = []
    for e in entries:
        out.append(
            {
                "title": e.get("title"),
                "source_pdf": e.get("pdf"),
                "summary": e.get("summary"),
            }
        )
    return out


# ── Node-id rewriting ──────────────────────────────────────────────────────


def _rewrite_node_ids(nodes: list[dict] | dict, doc_idx: int) -> None:
    """In-place: every node['node_id'] gets a ``D{doc_idx:03d}_`` prefix.
    Idempotent if already prefixed."""
    if isinstance(nodes, dict):
        nodes = [nodes]
    prefix = f"D{doc_idx:03d}_"
    for n in nodes:
        if not isinstance(n, dict):
            continue
        nid = n.get("node_id")
        if isinstance(nid, str) and nid and not nid.startswith(prefix):
            n["node_id"] = f"{prefix}{nid}"
        sub = n.get("nodes")
        if isinstance(sub, list):
            _rewrite_node_ids(sub, doc_idx)


def _compute_doc_page_range(structure: list) -> tuple[int, int]:
    """Find min start_index / max end_index across top-level nodes."""
    starts: list[int] = []
    ends: list[int] = []

    def walk(n):
        if not isinstance(n, dict):
            return
        if "start_index" in n:
            try:
                starts.append(int(n["start_index"]))
            except (ValueError, TypeError):
                pass
        if "end_index" in n:
            try:
                ends.append(int(n["end_index"]))
            except (ValueError, TypeError):
                pass
        for c in n.get("nodes") or []:
            walk(c)

    for n in structure if isinstance(structure, list) else [structure]:
        walk(n)
    return (min(starts) if starts else 1, max(ends) if ends else 1)


# ── Merge ──────────────────────────────────────────────────────────────────


def merge_trees(
    tree_paths: list[str],
    overrides: list[dict] | None = None,
    doc_name: str = "Merged series",
    doc_description: str | None = None,
) -> dict:
    """Return a merged-tree dict matching the series-tree schema."""
    if overrides is None:
        overrides = [{} for _ in tree_paths]

    structure: list[dict] = []
    for idx, path in enumerate(tree_paths):
        data = _load_tree_json(path)
        ov = overrides[idx] if idx < len(overrides) else {}

        sub_struct = data.get("structure")
        if isinstance(sub_struct, dict):
            sub_struct = [sub_struct]
        if not isinstance(sub_struct, list):
            raise ValueError(f"{path}: 'structure' must be list-like")

        # Rewrite node_ids under D{idx:03d}_ namespace.
        _rewrite_node_ids(sub_struct, idx)

        # Source bookkeeping.
        src_file = os.path.basename(path)
        # Default source_pdf: drop "_structure.json" suffix, add ".pdf".
        # Override if manifest gave one.
        if src_file.endswith("_structure.json"):
            stem = src_file[: -len("_structure.json")]
        else:
            stem = Path(src_file).stem
        source_pdf = os.path.basename(str(ov.get("source_pdf") or f"{stem}.pdf"))

        # Title precedence (per design): explicit override > input doc_name > stem.
        title = ov.get("title") or data.get("doc_name") or stem

        # Page range — Docling/PageIndex usually carries per-node ranges; we
        # set the doc-root's [start, end] to the min/max across its children.
        start_idx, end_idx = _compute_doc_page_range(sub_struct)

        doc_root = {
            "title": str(title),
            "node_id": f"D{idx:03d}_root",
            "source_file": src_file,
            "source_pdf": str(source_pdf),
            "start_index": start_idx,
            "end_index": end_idx,
            "nodes": sub_struct,
        }
        summary = ov.get("summary") or data.get("doc_description") or data.get("summary")
        if summary:
            doc_root["summary"] = str(summary)

        structure.append(doc_root)

    out = {
        "doc_name": doc_name,
        "doc_description": doc_description
        or f"Merged from {len(tree_paths)} single-doc PageIndex trees.",
        "structure": structure,
    }
    return out


# ── Task class ─────────────────────────────────────────────────────────────


class MergeTreesTask:
    """``merge-trees`` subcommand — combine N _structure.json into one series."""

    @staticmethod
    def add_arguments(parser: argparse.ArgumentParser) -> None:
        g = parser.add_mutually_exclusive_group(required=True)
        g.add_argument(
            "--tree-files",
            nargs="+",
            help="Explicit list of _structure.json files to merge (in order).",
        )
        g.add_argument(
            "--tree-dir",
            help="Directory of _structure.json files (alphabetical order).",
        )
        g.add_argument(
            "--manifest",
            help="JSON list of {tree, pdf?, title?, summary?} objects. Most flexible.",
        )
        parser.add_argument(
            "--include",
            default=None,
            help="With --tree-dir, fnmatch glob to filter file names (default: *_structure.json).",
        )
        parser.add_argument(
            "--output", "-o", required=True, help="Output path for the merged series tree JSON."
        )
        parser.add_argument("--doc-name", required=True, help="Display name for the merged series.")
        parser.add_argument(
            "--doc-description", default=None, help="Optional human-readable description."
        )

    @staticmethod
    def run(args: argparse.Namespace) -> int:
        try:
            paths = _resolve_tree_paths(args)
            overrides = _manifest_overrides(args, len(paths))
            merged = merge_trees(
                paths,
                overrides=overrides,
                doc_name=args.doc_name,
                doc_description=args.doc_description,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"error: {exc}", file=sys.stderr)
            return 1

        out_path = Path(args.output)
        atomic_write_json(out_path, merged)

        n_docs = len(merged["structure"])
        n_nodes = 0
        for d in merged["structure"]:
            for _ in _walk_nodes(d.get("nodes") or []):
                n_nodes += 1
        print(f"Merged {len(paths)} trees → {out_path}")
        print(f"  docs       : {n_docs}")
        print(f"  total nodes: {n_nodes}")
        print(f"  doc_name   : {args.doc_name}")
        return 0


def _walk_nodes(nodes):
    if isinstance(nodes, dict):
        nodes = [nodes]
    for n in nodes:
        if not isinstance(n, dict):
            continue
        yield n
        for c in n.get("nodes") or []:
            yield from _walk_nodes(c)
