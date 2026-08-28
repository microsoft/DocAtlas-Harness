#!/usr/bin/env python3
"""Read — Unified DocSkill CLI.

Read one or more pages from a PDF, returning text and (optionally) page
images. Also provides figure metadata catalogs and sub-image pixel fetch —
the unified content tool for pages, images, and figures.

Text modes:
  * ``text`` (default)   — raw text via pypdf
  * ``markdown``         — MinerU per-page markdown (auto when --markdown-dir
                           supplied AND that doc has markdown available)

Figure support (markdown mode only):
  * ``figure_images_meta`` — always present; catalog of sub-images with
    page/ref/basename/size_px/bytes/caption (empty list in text mode)
  * ``--figures`` — fetch base64 pixels for specific (page, ref) pairs

Usage::

    python run.py --pdf doc.pdf --pages 1,3,5
    python run.py --pdf doc.pdf --pages 12 --with-image
    python run.py --pdf doc.pdf --pages 1,2 --markdown-dir /data/markdown
    python run.py --pdf doc.pdf --pages 2 --markdown-dir /data/md --figures '[{"page":2,"ref":"image_1"}]'

Output: a single JSON object on stdout (see ``--help`` for schema).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

# Make _common importable regardless of how the script is launched.
_THIS = Path(__file__).resolve()
_DOC_SKILLS = _THIS.parent.parent.parent  # .../docatlas/skills
sys.path.insert(0, str(_DOC_SKILLS))

from _common.figure_filter import FigureFilter  # noqa: E402
from _common.markdown_reader import MarkdownReader  # noqa: E402
from _common.note_store import NoteStore  # noqa: E402
from _common.pdf_image import render_pages_to_base64, render_to_data_uri  # noqa: E402
from _common.pdf_text import get_pages_text, has_real_text, page_count  # noqa: E402
from _common.session_io import load_session, save_session  # noqa: E402

# ── caption extraction ──────────────────────────────────────────────
_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)", re.MULTILINE)
_REF_RE = re.compile(r"^image_(\d+)$")
_DEFAULT_MAX_PAGES_PER_READ = 50
_MAX_FIGURES_PER_READ = 20


def _extract_caption(text: str, placeholder: str) -> str:
    """Extract a caption for an image placeholder from the linearized text.

    Strategy: look at the text immediately before ``[IMAGE image_N]``.
    1. If there is a markdown heading within the preceding 500 chars, use it.
    2. Otherwise take the last non-empty line before the placeholder (up to 200 chars).
    3. If nothing useful is found, return ``""``.
    """
    pos = text.find(placeholder)
    if pos < 0:
        return ""
    window = text[max(0, pos - 500) : pos]
    headings = list(_HEADING_RE.finditer(window))
    if headings:
        return headings[-1].group(1).strip()[:200]
    lines = [ln.strip() for ln in window.splitlines() if ln.strip()]
    if lines:
        return lines[-1][:200]
    return ""


def _parse_pages(s: str) -> list[int]:
    try:
        max_pages = int(os.getenv("HARNESS_MAX_PAGES_PER_READ", str(_DEFAULT_MAX_PAGES_PER_READ)))
    except ValueError:
        max_pages = _DEFAULT_MAX_PAGES_PER_READ
    max_pages = max(1, max_pages)

    out: list[int] = []
    for chunk in s.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        match = re.fullmatch(r"(\d+)(?:-(\d+))?", chunk)
        if match is None:
            raise ValueError(f"invalid page expression: {chunk!r}")
        start = int(match.group(1))
        end = int(match.group(2) or start)
        if start < 1 or end < start:
            raise ValueError(f"invalid page range: {chunk!r}")
        if end - start + 1 > max_pages:
            raise ValueError(f"page range {chunk!r} exceeds the {max_pages}-page safety limit")
        if match.group(2) is not None:
            out.extend(range(start, end + 1))
        else:
            out.append(start)
        if len(set(out)) > max_pages:
            raise ValueError(f"a Read call may request at most {max_pages} pages")
    seen: set[int] = set()
    deduplicated: list[int] = []
    for page in out:
        if page not in seen:
            seen.add(page)
            deduplicated.append(page)
    return deduplicated


# ── page builders ───────────────────────────────────────────────────


def _build_markdown_pages(
    reader: MarkdownReader,
    page_ids: list[int],
    fig_filter: FigureFilter,
) -> tuple[list[dict], list[dict], list[int]]:
    """Return (pages_payload, figure_images_meta, missing_pages)."""
    found, missing = reader.read_pages(page_ids)
    pages_payload: list[dict] = []
    figure_meta: list[dict] = []

    for p in sorted(found.keys()):
        pm = found[p]
        text, _ = MarkdownReader.linearize_page_with_image_refs(
            pm,
            encode_images=False,
        )
        pages_payload.append(
            {
                "num": p,
                "text": text,
                "source": "markdown",
            }
        )

        # Build figure metadata catalog (filtered).
        for idx, img_path in enumerate(pm.image_paths, start=1):
            if img_path is None:
                continue
            keep, info = fig_filter.evaluate(img_path)
            if not keep:
                continue
            ref = f"image_{idx}"
            figure_meta.append(
                {
                    "page": p,
                    "ref": ref,
                    "basename": os.path.basename(img_path),
                    "size_px": info["size_px"],
                    "bytes": info["bytes"],
                    "caption": _extract_caption(text, f"[IMAGE {ref}]"),
                }
            )

    return pages_payload, figure_meta, missing


def _build_text_pages(pdf_path: str, page_ids: list[int]) -> tuple[list[dict], list[int], bool]:
    """Return (pages_payload, missing_pages, text_is_empty)."""
    found_text, missing_raw = get_pages_text(pdf_path, page_ids, tag=True)
    pages_payload: list[dict] = []
    for p in sorted(found_text.keys()):
        pages_payload.append(
            {
                "num": p,
                "text": found_text[p],
                "source": "pypdf",
            }
        )
    text_is_empty = bool(found_text) and not has_real_text(found_text)
    missing = missing_raw
    return pages_payload, missing, text_is_empty


# ── figure fetch ──────────────────────────────────


def _fetch_figures(
    reader: MarkdownReader,
    requests: list[dict],
    fig_filter: FigureFilter,
    force: bool,
) -> tuple[list[dict], list[dict]]:
    """Fetch sub-image pixels by (page, ref).

    Returns (figures_out, errors).
    """
    by_page: dict[int, list[dict]] = {}
    for r in requests[:_MAX_FIGURES_PER_READ]:
        if not isinstance(r, dict) or "page" not in r or "ref" not in r:
            by_page.setdefault(-1, []).append(r if isinstance(r, dict) else {"raw": r})
            continue
        try:
            page_num = int(r["page"])
        except (TypeError, ValueError):
            by_page.setdefault(-1, []).append(r)
            continue
        by_page.setdefault(page_num, []).append(r)

    figures_out: list[dict] = []
    errors: list[dict] = []

    for page_num, reqs in by_page.items():
        if page_num < 0:
            for r in reqs:
                errors.append({"reason": "bad_request", "request": r})
            continue
        page = reader.read_page(page_num) if reader.available else None
        if page is None:
            for r in reqs:
                errors.append(
                    {
                        "page": page_num,
                        "ref": r.get("ref"),
                        "reason": "ref_not_found",
                        "available_refs": [],
                    }
                )
            continue

        n = len(page.image_paths)
        available_refs = [
            f"image_{i + 1}" for i, path in enumerate(page.image_paths) if path is not None
        ]

        for r in reqs:
            ref = str(r.get("ref") or "")
            m = _REF_RE.match(ref)
            if not m:
                errors.append(
                    {
                        "page": page_num,
                        "ref": ref,
                        "reason": "ref_not_found",
                        "available_refs": available_refs,
                    }
                )
                continue
            idx = int(m.group(1)) - 1
            if not (0 <= idx < n):
                errors.append(
                    {
                        "page": page_num,
                        "ref": ref,
                        "reason": "ref_not_found",
                        "available_refs": available_refs,
                    }
                )
                continue

            img_path = page.image_paths[idx]
            if img_path is None:
                errors.append(
                    {
                        "page": page_num,
                        "ref": ref,
                        "reason": "ref_not_found",
                        "available_refs": available_refs,
                    }
                )
                continue

            if not force:
                keep, info = fig_filter.evaluate(img_path)
                if not keep:
                    err = {"page": page_num, "ref": ref}
                    err.update(info)
                    errors.append(err)
                    continue

            uri = MarkdownReader.encode_image_file(
                img_path,
                allowed_root=page.image_root,
            )
            if uri is None:
                errors.append(
                    {
                        "page": page_num,
                        "ref": ref,
                        "reason": "unreadable",
                    }
                )
                continue
            figures_out.append({"page": page_num, "ref": ref, "uri": uri})

    return figures_out, errors


# ── main ────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Read pages from a PDF. Outputs JSON to stdout.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument(
        "--pdf",
        default=None,
        help="Path to a PDF. Optional when --markdown-dir and --doc-id are supplied.",
    )
    ap.add_argument(
        "--pages",
        required=True,
        help="Comma-separated 1-based page list. Ranges OK, e.g. '1,3-5,8'.",
    )
    ap.add_argument(
        "--with-image",
        action="store_true",
        help="Also render the requested pages to base64 PNG (page-layout images).",
    )
    ap.add_argument(
        "--zoom",
        type=float,
        default=1.0,
        help="Page-image render zoom (only used with --with-image).",
    )
    ap.add_argument(
        "--markdown-dir",
        default=None,
        help="Root of MinerU per-page markdown output.",
    )
    ap.add_argument(
        "--doc-id",
        default=None,
        help="Document identifier under --markdown-dir. Defaults to the PDF filename stem.",
    )
    ap.add_argument(
        "--figures",
        default=None,
        help='JSON list of {"page":N,"ref":"image_K"} to fetch sub-image pixels.',
    )
    ap.add_argument(
        "--force-figures",
        action="store_true",
        help="Bypass FigureFilter for --figures requests.",
    )
    args = ap.parse_args(argv)

    pdf_path = os.path.abspath(args.pdf) if args.pdf else ""
    # PDF existence check only matters for text mode; markdown mode may not need it.
    pdf_exists = os.path.isfile(pdf_path)

    try:
        page_ids = _parse_pages(args.pages)
    except ValueError as exc:
        json.dump({"error": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    if not page_ids:
        json.dump({"error": "No valid page numbers parsed from --pages."}, sys.stdout)
        sys.stdout.write("\n")
        return 2

    if not 0.25 <= args.zoom <= 4.0:
        json.dump({"error": "--zoom must be between 0.25 and 4.0"}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    if args.with_image and len(page_ids) > 5:
        json.dump({"error": "a Read call may render at most 5 full-page images"}, sys.stdout)
        sys.stdout.write("\n")
        return 2

    doc_id = args.doc_id or (Path(pdf_path).stem if pdf_path else "")
    if not doc_id:
        json.dump(
            {"error": "--doc-id is required when --pdf is omitted"},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 2

    # ── Decide mode ──
    md_reader: MarkdownReader | None = None
    mode = "text"
    if args.markdown_dir:
        candidate = MarkdownReader(args.markdown_dir, doc_id)
        if candidate.available:
            md_reader = candidate
            mode = "markdown"

    fig_filter = FigureFilter.from_env()

    # ── Pages ──
    figure_meta: list[dict] = []
    text_is_empty = False
    auto_vision_fallback = False

    if md_reader is not None:
        try:
            pages_payload, figure_meta, missing = _build_markdown_pages(
                md_reader,
                page_ids,
                fig_filter,
            )
        except Exception as exc:  # noqa: BLE001
            json.dump({"error": f"could not read Markdown pages: {exc}"}, sys.stdout)
            sys.stdout.write("\n")
            return 2
        # If markdown is missing some requested pages, fall back to PyPDF for them.
        if missing and pdf_exists:
            try:
                pypdf_pages, still_missing, fallback_text_is_empty = _build_text_pages(
                    pdf_path,
                    missing,
                )
            except Exception as exc:  # noqa: BLE001
                json.dump({"error": f"could not read PDF fallback pages: {exc}"}, sys.stdout)
                sys.stdout.write("\n")
                return 2
            pages_payload.extend(pypdf_pages)
            pages_payload.sort(key=lambda d: d["num"])
            missing = still_missing
            text_is_empty = fallback_text_is_empty
    else:
        if not pdf_exists:
            json.dump({"error": f"PDF not found: {pdf_path}"}, sys.stdout)
            sys.stdout.write("\n")
            return 2
        try:
            pages_payload, missing, text_is_empty = _build_text_pages(pdf_path, page_ids)
        except Exception as exc:  # noqa: BLE001
            json.dump({"error": f"could not read PDF pages: {exc}"}, sys.stdout)
            sys.stdout.write("\n")
            return 2

    # ── Auto vision fallback (scanned PDFs) ──
    if text_is_empty and not args.with_image and pdf_exists:
        auto_vision_fallback = True
        args.with_image = True

    # ── Optional page-layout images ──
    page_images_payload: list[dict] = []
    page_image_errors: list[dict] = []
    if args.with_image and pdf_exists:
        image_page_ids = page_ids[:5]
        if len(page_ids) > 5:
            page_image_errors.append(
                {
                    "reason": "too_many_page_images",
                    "message": "automatic vision fallback rendered only the first 5 pages",
                }
            )
        try:
            rendered = render_pages_to_base64(pdf_path, image_page_ids, zoom=args.zoom)
        except (OSError, ValueError) as exc:
            rendered = []
            page_image_errors.append({"reason": "render_failed", "message": str(exc)})
        for page_num, b64 in rendered:
            page_images_payload.append({"page": page_num, "uri": render_to_data_uri(b64)})
        by_num = {entry["page"]: entry["uri"] for entry in page_images_payload}
        for entry in pages_payload:
            if entry["num"] in by_num:
                entry["page_image"] = by_num[entry["num"]]

    # ── Figure fetch (--figures) ──
    figure_images: list[dict] = []
    figure_errors: list[dict] = []
    if args.figures and md_reader is not None:
        try:
            requests = json.loads(args.figures)
            if isinstance(requests, list) and requests:
                if len(requests) > _MAX_FIGURES_PER_READ:
                    figure_errors.append(
                        {
                            "reason": "too_many_figures",
                            "message": (
                                f"at most {_MAX_FIGURES_PER_READ} figures may be fetched per call"
                            ),
                        }
                    )
                fetched_images, fetched_errors = _fetch_figures(
                    md_reader,
                    requests[:_MAX_FIGURES_PER_READ],
                    fig_filter,
                    args.force_figures,
                )
                figure_images.extend(fetched_images)
                figure_errors.extend(fetched_errors)
            elif not isinstance(requests, list):
                figure_errors.append(
                    {
                        "reason": "invalid_json_type",
                        "message": "--figures must decode to a JSON array",
                    }
                )
        except json.JSONDecodeError:
            figure_errors.append({"reason": "invalid_json", "raw": args.figures[:200]})
    elif args.figures and md_reader is None:
        figure_errors.append(
            {
                "reason": "no_markdown",
                "message": "--figures requires markdown to be available",
            }
        )

    # ── Build extras ──
    extras: dict = {}
    if figure_images:
        extras["figure_images"] = figure_images

    # ── Payload ──
    payload: dict = {
        "doc_id": doc_id,
        "pdf_path": pdf_path or None,
        "mode": mode,
        "requested_pages": page_ids,
        "missing_pages": sorted(missing),
        "pages": pages_payload,
        "text_is_empty": text_is_empty,
        "figure_images_meta": figure_meta,
    }
    if pdf_exists:
        try:
            payload["n_pages_total"] = page_count(pdf_path)
        except Exception as exc:  # noqa: BLE001
            payload["page_count_warning"] = str(exc)
    if auto_vision_fallback:
        payload["auto_vision_fallback"] = True
    if figure_errors:
        payload["figure_errors"] = figure_errors
    if page_image_errors:
        payload["page_image_errors"] = page_image_errors
    if extras:
        payload["_harness_extras"] = extras

    # ── Hint (always present) ──
    requested = list(page_ids)
    returned = sorted({int(p["num"]) for p in pages_payload if "num" in p})
    remaining = [p for p in requested if p not in returned]
    memory_on = os.getenv("HARNESS_ENABLE_MEMORY", "0") in ("1", "true", "True")

    hint_parts: list[str] = []
    hint_parts.append(
        f"This read prioritized pages {returned} from the requested pages {requested}."
    )
    if remaining:
        hint_parts.append(
            f"If the answer is still missing, your next step should be to read the remaining "
            f"requested pages {remaining} before calling Search again or giving a final answer."
        )
    else:
        hint_parts.append(
            "Only after exhausting the requested candidate pages should you call Search again, "
            "broaden the investigation, or explain that the available evidence is insufficient."
        )
    if memory_on:
        hint_parts.append(
            "If you found useful information above, consider calling Note with structured "
            "evidence (exact text excerpts, Markdown tables, or figure references) to preserve "
            "key findings and free up context for further reading."
        )
    if len(page_ids) > 5:
        hint_parts.append(
            f"You requested {len(page_ids)} pages in one call. For better focus, prefer reading ≤5 pages per call."
        )
    payload["_hint"] = "[Hint] " + " ".join(hint_parts)

    # ── Session bookkeeping (tick tool counter + record read_history) ──
    sess_path = os.environ.get("HARNESS_SESSION_FILE")
    session_patch: dict = {}
    if sess_path:
        try:
            data = load_session(sess_path)
            workspace = data.setdefault("workspace", {})
            read_history = list(workspace.get("read_history") or [])
            read_history.append(
                {
                    "pages": returned,
                    "doc_id": doc_id,
                    "timestamp": time.strftime("%H:%M:%S"),
                }
            )
            workspace["read_history"] = read_history[-100:]
            data["workspace"] = workspace

            store = NoteStore.from_dict(data.get("notes"))
            store.tick_tool_call()
            data["notes"] = store.to_dict()

            save_session(data, sess_path)
            session_patch = {
                "workspace.read_history.appended": {"pages": returned, "doc_id": doc_id},
                "notes.tool_call_count": store.tool_call_count,
            }
        except Exception as exc:  # noqa: BLE001
            payload["session_warning"] = f"session bookkeeping failed: {exc}"

    if session_patch:
        extras.setdefault("session_patch", session_patch)
        payload["_harness_extras"] = extras

    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
