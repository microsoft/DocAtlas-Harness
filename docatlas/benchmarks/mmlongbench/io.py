"""I/O helpers for the MMLongBench-Doc batch task.

Handles the data-handling subset for this task (sample loading, tree/PDF
resolution, sample filtering, resume bookkeeping, atomic incremental
save). These helpers keep the on-disk JSON shape matching what
`docatlas/scoring/score_mmlongbench_hybrid.py` consumes.

This module remains independent of the agent runtime.
"""

from __future__ import annotations

import ast
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── samples + dataset name ──────────────────────────────────────────────────


def load_samples(path: str | Path) -> list[dict]:
    """Load MMLongBench samples.json. Accepts a bare list or a {results: ...}
    wrapper (the same wrapper our own outputs use, so resume-as-input works)."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "results" in data:
        return list(data["results"])
    if isinstance(data, list):
        return list(data)
    raise ValueError(f"Unexpected samples format in {path}: {type(data).__name__}")


def infer_dataset_name(samples_file: str | None) -> str:
    if not samples_file:
        return "mmlongbench"
    stem = Path(samples_file).stem
    return stem or "mmlongbench"


# ── evidence_sources parsing ────────────────────────────────────────────────


def parse_evidence_sources(value: Any) -> list[str]:
    """The samples.json field is a Python-style stringified list, e.g.
    "['Chart', 'Table']". Be lenient about other shapes."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        try:
            parsed = ast.literal_eval(s)
            if isinstance(parsed, (list, tuple)):
                return [str(v) for v in parsed]
            return [str(parsed)]
        except (ValueError, SyntaxError):
            return [s]
    return [str(value)]


# ── tree / pdf resolution ───────────────────────────────────────────────────


def load_trees(results_dir: str | Path) -> dict[str, dict]:
    """Scan a PageIndex results directory for `*_structure.json` files.

    Returns `{stem_without_suffix: {"file_path": ..., "doc_name": ...}}`.
    `doc_name` is the stem without the trailing "_structure" so we can
    later locate the PDF by that name.
    """
    out: dict[str, dict] = {}
    root = Path(results_dir)
    if not root.is_dir():
        return out
    for f in sorted(root.glob("*_structure.json")):
        stem = f.stem  # e.g. "Foo_Bar_structure"
        doc_name = stem[: -len("_structure")] if stem.endswith("_structure") else stem
        out[doc_name] = {"file_path": str(f), "doc_name": doc_name}
    return out


def load_series_trees(series_dir: str | Path | None) -> list[dict]:
    """Scan a directory of merged series tree JSONs (one per series).

    Returns a list of `{"file_path", "doc_name", "source_pdfs": [...]}`
    where source_pdfs is the list of member-PDF basenames (with .pdf),
    extracted from the top-level nodes' `source_pdf` field. Also accepts
    files ending in `_structure.json` or `.json` (skipping `_merge_summary.json`).
    """
    out: list[dict] = []
    if not series_dir:
        return out
    root = Path(series_dir)
    if not root.is_dir():
        return out
    for f in sorted(root.glob("*.json")):
        if f.name.endswith("_merge_summary.json"):
            continue
        try:
            with open(f, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Skipping unreadable series tree %s: %s", f, exc)
            data = None
        if data is None:
            continue
        struct = data.get("structure") if isinstance(data, dict) else None
        if not isinstance(struct, list):
            continue
        pdfs: list[str] = []
        for n in struct:
            if isinstance(n, dict):
                sp = n.get("source_pdf")
                if isinstance(sp, str) and sp:
                    pdfs.append(sp)
        if not pdfs:
            continue
        out.append(
            {
                "file_path": str(f),
                "doc_name": data.get("doc_name") or f.stem,
                "source_pdfs": pdfs,
            }
        )
    return out


def find_series_tree_for_pdfs(series_trees: list[dict], pdf_ids: list[str]) -> dict | None:
    """Pick the series tree that covers the given PDF set.

    Match when every pdf_id (basename, with or without .pdf) appears in
    a candidate's source_pdfs list. Prefer the smallest matching series
    (most specific).
    """
    if not series_trees or not pdf_ids:
        return None
    wanted = set()
    for p in pdf_ids:
        s = os.path.basename(str(p).strip()).lower()
        if not s:
            continue
        if not s.lower().endswith(".pdf"):
            s = s + ".pdf"
        wanted.add(s)
    candidates = []
    for st in series_trees:
        sp_set = {os.path.basename(str(value)).lower() for value in st["source_pdfs"]}
        if wanted.issubset(sp_set):
            candidates.append(st)
    if not candidates:
        return None
    candidates.sort(key=lambda x: len(x["source_pdfs"]))
    return candidates[0]


def find_tree_for_doc(trees: dict[str, dict], doc_id: str) -> str | None:
    """Resolve a document id without silently choosing an ambiguous match."""
    if not doc_id:
        return None
    base = os.path.splitext(os.path.basename(doc_id))[0].casefold()
    exact = [key for key in trees if key.casefold() == base]
    if exact:
        return exact[0]
    partial = [key for key in trees if base in key.casefold() or key.casefold() in base]
    return partial[0] if len(partial) == 1 else None


def find_pdf_for_doc(doc_name: str, pdf_dirs: list[str]) -> str | None:
    """Search each pdf_dir for `<doc_name>.pdf` (or the literal name)."""
    if not doc_name:
        return None
    requested = os.path.basename(str(doc_name))
    requested_stem = Path(requested).stem.casefold()
    exact_matches: list[Path] = []
    partial_matches: list[Path] = []
    for d in pdf_dirs:
        try:
            for candidate in Path(d).iterdir():
                if not candidate.is_file() or candidate.suffix.casefold() != ".pdf":
                    continue
                stem = candidate.stem.casefold()
                if stem == requested_stem:
                    exact_matches.append(candidate)
                elif requested_stem in stem or stem in requested_stem:
                    partial_matches.append(candidate)
        except OSError:
            continue
    if exact_matches:
        return str(sorted(exact_matches)[0])
    return str(partial_matches[0]) if len(partial_matches) == 1 else None


# ── sample bookkeeping ──────────────────────────────────────────────────────


def make_sample_key(sample: dict) -> str:
    return f"{sample.get('doc_id', '')}||{sample.get('question', '')}"


def filter_samples(
    samples: list[dict],
    *,
    doc_filter: str | None = None,
    answer_format: str | None = None,
    evidence_source: str | None = None,
    start: int = 0,
    limit: int = 0,
) -> list[dict]:
    out = list(samples)
    if doc_filter:
        out = [s for s in out if doc_filter in str(s.get("doc_id", ""))]
    if answer_format:
        wanted = {a.strip() for a in answer_format.split(",") if a.strip()}
        out = [s for s in out if str(s.get("answer_format", "")) in wanted]
    if evidence_source:
        wanted = {e.strip().lower() for e in evidence_source.split(",") if e.strip()}

        def _has(s):
            return bool(
                {x.lower() for x in parse_evidence_sources(s.get("evidence_sources"))} & wanted
            )

        out = [s for s in out if _has(s)]
    if start > 0:
        out = out[start:]
    if limit and limit > 0:
        out = out[:limit]
    return out


# ── resume + incremental save ───────────────────────────────────────────────


def load_existing_results(path: str | Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """Returns (completed_keys_with_final_answer, all_existing_by_key).

    A record counts as completed only when it has a non-null final answer.
    Failed and skipped records remain in ``all_existing_by_key`` but are retried
    on resume, which lets users fix missing inputs or transient service errors.
    """
    completed: dict[str, dict] = {}
    everything: dict[str, dict] = {}
    p = Path(path)
    if not p.is_file():
        return completed, everything
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return completed, everything
    rows = data.get("results") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return completed, everything
    for r in rows:
        if not isinstance(r, dict):
            continue
        key = make_sample_key(r)
        everything[key] = r
        has_answer = r.get("final_answer") is not None
        if has_answer:
            completed[key] = r
    return completed, everything


def save_incremental(
    results: list[dict],
    output_path: str | Path,
    *,
    meta: dict[str, Any],
) -> None:
    """Atomic write of `{"meta": meta, "results": results}`."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": {
            **meta,
            "total_completed": len(results),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
        "results": results,
    }
    fd, tmp = tempfile.mkstemp(prefix=".mmlongbench.", suffix=".json", dir=str(out.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, out)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


__all__ = [
    "load_samples",
    "infer_dataset_name",
    "parse_evidence_sources",
    "load_trees",
    "load_series_trees",
    "find_series_tree_for_pdfs",
    "find_tree_for_doc",
    "find_pdf_for_doc",
    "make_sample_key",
    "filter_samples",
    "load_existing_results",
    "save_incremental",
]
