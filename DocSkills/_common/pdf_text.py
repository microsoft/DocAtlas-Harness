"""Minimal PDF text extraction.

Extracts text from a PDF. Pure function over `pdf_path` + page numbers;
no project state.
"""

from __future__ import annotations

import re

import pypdf


def get_pages_text(
    pdf_path: str,
    page_nums: list[int],
    *,
    tag: bool = True,
) -> tuple[dict[int, str], list[int]]:
    """Read text for multiple pages.

    Returns (found_text_by_page, missing_pages).
    Pages that fail to extract (e.g. out-of-range) are silently dropped into
    *missing_pages* so callers can decide how to surface them.
    """
    found: dict[int, str] = {}
    missing: list[int] = []
    reader = pypdf.PdfReader(pdf_path)
    n_pages = len(reader.pages)
    for p in page_nums:
        try:
            if p < 1 or p > n_pages:
                missing.append(p)
                continue
            text = reader.pages[p - 1].extract_text() or ""
            if tag:
                text = f"<start_index_{p}>\n{text}\n<end_index_{p}>\n"
            found[p] = text
        except Exception:
            missing.append(p)
    return found, missing


def has_real_text(pages: dict[int, str]) -> bool:
    """Heuristic: True iff combined page text has content beyond index tags."""
    combined = "".join(pages.values())
    stripped = re.sub(r"<(?:start|end)_index_\d+>", "", combined).strip()
    return len(stripped) > 0


def page_count(pdf_path: str) -> int:
    return len(pypdf.PdfReader(pdf_path).pages)
