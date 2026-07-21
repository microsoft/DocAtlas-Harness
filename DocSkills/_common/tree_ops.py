"""Pure tree-annotation helpers.

Contains the annotation functions that don't depend on live message
objects. These operate on
plain Python dicts/lists (the PageIndex tree JSON), so they're safe to
call from a subprocess SKILL CLI that loaded the tree from disk.

The central routine — `annotate_tree_from_note` — writes query-conditioned
partial observations back into the finest-grained tree node covering each
page referenced in a progress-note's evidence. The resulting
`page_findings` become auxiliary hints the next Search turn can read.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


# ── Public API ──────────────────────────────────────────────────────────────


def annotate_tree_from_note(
    structure: list | dict,
    note_data: dict,
    question: str = "",
    search_query: str = "",
    return_details: bool = False,
) -> int | dict[str, Any]:
    """Write agent findings from a progress_note back into tree nodes.

    Mutates `structure` in place. Returns either the count of findings
    written, or a detail dict (pages/nodes touched, counters) when
    `return_details=True`.
    """
    details: dict[str, Any] = {
        "finding_count": 0,
        "enriched_pages": [],
        "enriched_nodes": [],
        "page_descriptions_count": 0,
    }
    if not structure or not note_data:
        return details if return_details else 0

    evidence = note_data.get("evidence", [])
    page_observations: dict[int, list[dict[str, str]]] = {}
    for ev in (evidence if isinstance(evidence, list) else []):
        if not isinstance(ev, dict):
            continue
        page_num, source_title = _parse_source_reference(ev.get("source", ""))
        if page_num is None:
            continue
        content = _normalize_evidence_content(ev)
        observed = source_title or _short_text(content, 120) or f"Page {page_num} evidence"
        if not content and not observed:
            continue
        page_observations.setdefault(page_num, []).append(
            {"observed": observed, "evidence": content}
        )

    if not page_observations:
        return details if return_details else 0

    details["page_descriptions_count"] = len(page_observations)
    n_written = 0
    enriched_pages: set[int] = set()
    enriched_nodes: set[str] = set()

    for page_num, observations in sorted(page_observations.items()):
        node = _find_finest_node_for_page(structure, page_num)
        if node is None:
            continue
        enriched_pages.add(page_num)
        enriched_nodes.add(str(node.get("node_id", "????")))

        if "page_findings" not in node or not isinstance(node.get("page_findings"), list):
            node["page_findings"] = []

        summary = _build_observation_summary(search_query, observations)
        if not summary:
            continue

        existing = next(
            (item for item in node["page_findings"]
             if isinstance(item, dict) and int(item.get("page_id", -1)) == page_num),
            None,
        )
        if existing is None:
            node["page_findings"].append(
                {"page_id": page_num, "observation_summary": summary}
            )
            n_written += 1
        else:
            merged = _merge_observation_summary(
                existing_summary=str(existing.get("observation_summary", "") or ""),
                new_summary=summary,
            )
            if merged != str(existing.get("observation_summary", "") or ""):
                existing["observation_summary"] = merged
                n_written += 1

    details["finding_count"] = n_written
    details["enriched_pages"] = sorted(enriched_pages)
    details["enriched_nodes"] = sorted(enriched_nodes)
    if n_written > 0:
        logger.info("Wrote %d page_findings across %d page(s)", n_written, len(page_observations))
    return details if return_details else n_written


def format_tree_for_prompt(structure, indent: int = 0) -> list[str]:
    """Render the tree for the search prompt — includes summaries but NO
    page_findings."""
    lines: list[str] = []
    nodes = structure if isinstance(structure, list) else [structure]
    for node in nodes:
        if not isinstance(node, dict):
            continue
        prefix = "  " * indent
        node_id = node.get("node_id", "????")
        title = node.get("title", "Untitled")
        summary = node.get("summary", "") or node.get("prefix_summary", "")
        if "start_index" in node:
            start = node.get("start_index", "?")
            end = node.get("end_index", "?")
            line = f"{prefix}[{node_id}] {title} (Pages {start}-{end})"
        elif "line_num" in node:
            line_num = node.get("line_num", "?")
            line = f"{prefix}[{node_id}] {title} (Line {line_num})"
        else:
            line = f"{prefix}[{node_id}] {title}"
        if summary:
            line += f" | {summary}"
        lines.append(line)
        if "nodes" in node:
            lines.extend(format_tree_for_prompt(node["nodes"], indent + 1))
    return lines


def format_tree_with_findings(structure, indent: int = 0) -> list[str]:
    """Render a tree with page_findings interleaved."""
    lines: list[str] = []
    nodes = structure if isinstance(structure, list) else [structure]
    for node in nodes:
        if not isinstance(node, dict):
            continue
        prefix = "  " * indent
        node_id = node.get("node_id", "????")
        title = node.get("title", "Untitled")
        summary = node.get("summary", "") or node.get("prefix_summary", "")
        if "start_index" in node:
            start = node.get("start_index", "?")
            end = node.get("end_index", "?")
            line = f"{prefix}[{node_id}] {title} (Pages {start}-{end})"
        elif "line_num" in node:
            line_num = node.get("line_num", "?")
            line = f"{prefix}[{node_id}] {title} (Line {line_num})"
        else:
            line = f"{prefix}[{node_id}] {title}"
        if summary:
            line += f" | {summary}"
        lines.append(line)

        findings = node.get("page_findings", [])
        if isinstance(findings, list) and findings:
            lines.append(f"{prefix}  page_findings:")
            for f in findings:
                if not isinstance(f, dict):
                    continue
                pn = f.get("page_id", "?")
                txt = str(f.get("observation_summary", "") or "")
                if txt:
                    lines.append(f"{prefix}    - Page {pn}: {txt}")

        if "nodes" in node:
            lines.extend(format_tree_with_findings(node["nodes"], indent + 1))
    return lines


# ── Internal helpers ────────────────────────────

_OBS_HEADER = "Earlier partial observations for this page:"
_OBS_FOOTER = (
    "These are not the full contents of the page; they only reflect partial "
    "information observed during earlier reading."
)


def _parse_source_reference(source: str) -> tuple[int | None, str]:
    text = str(source or "").strip()
    m = re.search(r"[Pp](?:age)?\.?\s*(\d+)", text)
    page_num = int(m.group(1)) if m else None
    title = ""
    if "," in text:
        title = text.split(",", 1)[1].strip()
    return page_num, title


def _normalize_evidence_content(ev: dict[str, Any]) -> str:
    ev_type = str(ev.get("type", "text") or "text").strip().lower()
    if ev_type == "image":
        filename = str(ev.get("filename", "") or ev.get("content", "") or "").strip()
        return f"Figure reference: {filename}" if filename else ""
    content = str(ev.get("content", "") or "").strip()
    return _short_text(content, 400)


def _build_observation_summary(search_query: str, observations: list[dict[str, str]]) -> str:
    if not observations:
        return ""
    q = _short_text(str(search_query or "").strip(), 200) or "the previous search"
    observed_parts: list[str] = []
    evidence_parts: list[str] = []
    for item in observations:
        o = str(item.get("observed", "") or "").strip()
        e = str(item.get("evidence", "") or "").strip()
        if o:
            observed_parts.append(o)
        if e:
            evidence_parts.append(e)
    observed_text = "; ".join(_dedupe(observed_parts)) or "partial relevant information"
    evidence_text = " ".join(_dedupe(evidence_parts)) or observed_text
    return (
        f'For query "{q}", we observed on this page: {observed_text}. '
        f"Evidence observed earlier: {evidence_text}. {_OBS_FOOTER}"
    )


def _merge_observation_summary(existing_summary: str, new_summary: str) -> str:
    existing = (existing_summary or "").strip()
    new = (new_summary or "").strip()
    if not existing:
        return new
    if not new or new in existing:
        return existing
    existing_body = _extract_observation_body(existing)
    new_body = _extract_observation_body(new)
    pieces = _dedupe([p for p in [existing_body, new_body] if p])
    if not pieces:
        return existing
    return f"{_OBS_HEADER} {' '.join(pieces)} {_OBS_FOOTER}"


def _extract_observation_body(summary: str) -> str:
    t = (summary or "").strip()
    if t.startswith(_OBS_HEADER):
        t = t[len(_OBS_HEADER):].strip()
    if t.endswith(_OBS_FOOTER):
        t = t[: -len(_OBS_FOOTER)].strip()
    return t


def _find_finest_node_for_page(structure, page_num: int) -> dict | None:
    nodes = structure if isinstance(structure, list) else [structure]
    for node in nodes:
        r = _find_finest_node_for_page_in_node(node, page_num)
        if r is not None:
            return r
    return None


def _find_finest_node_for_page_in_node(node: dict, page_num: int) -> dict | None:
    if not isinstance(node, dict):
        return None
    if not _node_covers_page(node, page_num):
        return None
    for child in node.get("nodes", []) or []:
        r = _find_finest_node_for_page_in_node(child, page_num)
        if r is not None:
            return r
    return node


def _node_covers_page(node: dict, page_num: int) -> bool:
    start = node.get("start_index")
    end = node.get("end_index")
    if start is None or end is None:
        return False
    try:
        return int(start) <= int(page_num) <= int(end)
    except (TypeError, ValueError):
        return False


def _short_text(text: str, max_len: int) -> str:
    normalized = " ".join(str(text or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[:max_len].rstrip() + "…"


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        s = (x or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


__all__ = [
    "annotate_tree_from_note",
    "format_tree_for_prompt",
    "format_tree_with_findings",
]
