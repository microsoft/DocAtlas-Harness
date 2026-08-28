"""Tree — load/persist a PageIndex tree JSON plus findings I/O.

The PageIndex tree is a nested list of node dicts (produced by the
PageIndex tree pipeline). It lives on disk as one JSON
file per document. Here we give the harness a tiny wrapper to load it
once at session start, copy it into the session file so skills can read
and mutate it through the session transport, and — at the end — optionally
save it back to its original path.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..skills._common.tree_ops import annotate_tree_from_note


def load_tree(path: str | Path) -> list | dict:
    """Read a PageIndex tree JSON from disk.

    Accepts both the raw list-of-nodes shape and the wrapped
    `{doc_name, structure}` shape (the PageIndex tree JSON).
    Returns the bare node structure in both cases, since tree_ops mutators
    expect that.
    """
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and isinstance(data.get("structure"), (list, dict)):
        return data["structure"]
    return data


def format_toc(structure: list | dict | None, max_lines: int = 80) -> str:
    """Render a lightweight table-of-contents (no summaries, no findings)."""
    if structure is None:
        return "(no tree loaded)"
    lines: list[str] = []
    _format_toc_recurse(structure, 0, lines)
    if len(lines) > max_lines:
        return "\n".join(lines[:max_lines]) + f"\n... ({len(lines) - max_lines} more lines)"
    return "\n".join(lines)


def _format_toc_recurse(structure, indent: int, out: list[str]) -> None:
    nodes = structure if isinstance(structure, list) else [structure]
    for node in nodes:
        if not isinstance(node, dict):
            continue
        prefix = "  " * indent
        node_id = node.get("node_id", "????")
        title = node.get("title", "Untitled")
        if "start_index" in node:
            start = node.get("start_index", "?")
            end = node.get("end_index", "?")
            line = f"{prefix}[{node_id}] {title} (Pages {start}-{end})"
        elif "line_num" in node:
            line_num = node.get("line_num", "?")
            line = f"{prefix}[{node_id}] {title} (Line {line_num})"
        else:
            line = f"{prefix}[{node_id}] {title}"
        out.append(line)
        if "nodes" in node:
            _format_toc_recurse(node["nodes"], indent + 1, out)


__all__ = [
    "load_tree",
    "format_toc",
    "annotate_tree_from_note",
]
