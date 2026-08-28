"""DocEnv — immutable per-session document context.

Captures the paths/ids a multi-turn investigation pins itself to: the PDF,
the MinerU markdown directory, the document id used inside that directory,
and an optional PageIndex tree JSON. The harness builds one `DocEnv` at
CLI launch and the session file carries it through to every skill call.

Kept simple on purpose: plain dataclass, JSON round-trippable, no I/O.
Skills that need individual fields should read them from the session file
(via ``docatlas.skills._common.session_io``), not by re-constructing DocEnv.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class DocEnv:
    pdf_path: str | None = None
    markdown_dir: str | None = None
    doc_id: str | None = None
    tree_json_path: str | None = None
    # Multi-doc support: when set, the harness is operating on multiple
    # documents (cross-doc QA on a merged series tree). Each entry maps a
    # canonical doc_id (PDF stem, without .pdf) to its `{pdf_path,
    # markdown_dir, doc_id}`. The single-doc fields above remain the
    # "primary" doc (the first entry, used as fallback when a skill call
    # doesn't specify which doc).
    doc_map: dict[str, dict[str, str]] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> DocEnv:
        d = d or {}
        return cls(
            pdf_path=_opt_str(d.get("pdf_path")),
            markdown_dir=_opt_str(d.get("markdown_dir")),
            doc_id=_opt_str(d.get("doc_id")),
            tree_json_path=_opt_str(d.get("tree_json_path")),
            doc_map=_opt_doc_map(d.get("doc_map")),
        )

    @classmethod
    def from_cli(
        cls,
        *,
        pdf: str | None = None,
        markdown_dir: str | None = None,
        doc_id: str | None = None,
        tree_json_path: str | None = None,
        doc_map: dict[str, dict[str, str]] | None = None,
    ) -> DocEnv:
        """Build from CLI args.

        `doc_id` defaults to the PDF's filename stem when not provided —
        that's the convention MinerU uses when laying out per-page markdown
        so the downstream Read skill finds files by default.
        """
        if doc_id is None and pdf:
            doc_id = Path(pdf).stem
        return cls(
            pdf_path=_opt_str(pdf),
            markdown_dir=_opt_str(markdown_dir),
            doc_id=_opt_str(doc_id),
            tree_json_path=_opt_str(tree_json_path),
            doc_map=_opt_doc_map(doc_map),
        )


def _opt_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _opt_doc_map(v: Any) -> dict[str, dict[str, str]] | None:
    if not isinstance(v, dict) or not v:
        return None
    out: dict[str, dict[str, str]] = {}
    for k, sub in v.items():
        if not isinstance(sub, dict):
            continue
        entry: dict[str, str] = {}
        for fld in ("pdf_path", "markdown_dir", "doc_id"):
            s = _opt_str(sub.get(fld))
            if s is not None:
                entry[fld] = s
        if entry:
            out[str(k)] = entry
    return out or None


__all__ = ["DocEnv"]
