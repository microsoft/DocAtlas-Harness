"""I/O helpers for the MMLongBench-Doc batch task.

Handles the data-handling subset for this task (sample loading, tree/PDF
resolution, sample filtering, resume bookkeeping, atomic incremental
save). These helpers keep the on-disk JSON shape matching what
`scoring/score_mmlongbench_hybrid.py` consumes.

Nothing here imports from `harness/` — this module stays pure data.
"""

from __future__ import annotations

import ast
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


# ── samples + dataset name ──────────────────────────────────────────────────


def load_samples(path: str | Path) -> list[dict]:
    """Load MMLongBench samples.json. Accepts a bare list or a {results: ...}
    wrapper (the same wrapper our own outputs use, so resume-as-input works)."""
    with open(path, "r", encoding="utf-8") as f:
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
            with open(f, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:  # noqa: BLE001
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
        out.append({
            "file_path": str(f),
            "doc_name": data.get("doc_name") or f.stem,
            "source_pdfs": pdfs,
        })
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
        s = str(p).strip()
        if not s:
            continue
        if not s.lower().endswith(".pdf"):
            s = s + ".pdf"
        wanted.add(s)
    candidates = []
    for st in series_trees:
        sp_set = set(st["source_pdfs"])
        if wanted.issubset(sp_set):
            candidates.append(st)
    if not candidates:
        return None
    candidates.sort(key=lambda x: len(x["source_pdfs"]))
    return candidates[0]


def find_tree_for_doc(trees: dict[str, dict], doc_id: str) -> str | None:
    """Substring-match doc_id (sans .pdf suffix) against tree keys."""
    if not doc_id:
        return None
    base = os.path.splitext(doc_id)[0]
    if base in trees:
        return base
    for key in trees:
        if base in key or key in base:
            return key
    return None


def find_pdf_for_doc(doc_name: str, pdf_dirs: list[str]) -> str | None:
    """Search each pdf_dir for `<doc_name>.pdf` (or the literal name)."""
    if not doc_name:
        return None
    for d in pdf_dirs:
        p = Path(d) / f"{doc_name}.pdf"
        if p.is_file():
            return str(p)
        p = Path(d) / doc_name
        if p.is_file():
            return str(p)
    # Last-ditch: glob for substring match in each dir.
    for d in pdf_dirs:
        try:
            for cand in Path(d).glob(f"*{doc_name}*.pdf"):
                return str(cand)
        except OSError:
            continue
    return None


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
            return bool({x.lower() for x in parse_evidence_sources(s.get("evidence_sources"))} & wanted)

        out = [s for s in out if _has(s)]
    if start > 0:
        out = out[start:]
    if limit and limit > 0:
        out = out[:limit]
    return out


# ── resume + incremental save ───────────────────────────────────────────────


def load_existing_results(path: str | Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """Returns (completed_keys_with_final_answer, all_existing_by_key).

    A record counts as "completed" only if it has a non-null `final_answer`
    or an explicit `error` field — partial/skipped records still go into
    `all_existing_by_key` so they're preserved in the merged output.
    """
    completed: dict[str, dict] = {}
    everything: dict[str, dict] = {}
    p = Path(path)
    if not p.is_file():
        return completed, everything
    try:
        with open(p, "r", encoding="utf-8") as f:
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
        is_error = r.get("error") is not None
        match_type = (r.get("scoring") or {}).get("match_type")
        if has_answer or is_error or match_type == "skipped":
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
        "meta": {**meta, "total_completed": len(results), "timestamp": datetime.now().isoformat()},
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
