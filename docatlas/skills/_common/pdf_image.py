"""Minimal PDF page → base64 PNG renderer.

Renders PDF pages to base64-encoded PNGs. Pure function over a file path;
no project state.
"""

from __future__ import annotations

import base64
import os

import pymupdf

_DEFAULT_MAX_PAGE_PIXELS = 25_000_000
_DEFAULT_MAX_PAGE_IMAGE_BYTES = 20 * 1024 * 1024


def _positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def render_pages_to_base64(
    pdf_path: str,
    page_numbers: list[int],
    *,
    zoom: float = 2.0,
) -> list[tuple[int, str]]:
    """Render the requested 1-based pages to base64-encoded PNG bytes.

    Returns a list of ``(page_number, base64_str)`` sorted by page number.
    Out-of-range pages are silently skipped.
    """
    if not page_numbers:
        return []
    doc = pymupdf.open(pdf_path)
    results: list[tuple[int, str]] = []
    try:
        matrix = pymupdf.Matrix(zoom, zoom)
        max_pixels = _positive_env_int("HARNESS_MAX_PAGE_IMAGE_PIXELS", _DEFAULT_MAX_PAGE_PIXELS)
        max_bytes = _positive_env_int("HARNESS_MAX_PAGE_IMAGE_BYTES", _DEFAULT_MAX_PAGE_IMAGE_BYTES)
        for p in sorted(set(int(x) for x in page_numbers)):
            if p < 1 or p > doc.page_count:
                continue
            page = doc.load_page(p - 1)
            pixel_count = int(page.rect.width * zoom) * int(page.rect.height * zoom)
            if pixel_count > max_pixels:
                raise ValueError(
                    f"page {p} would render {pixel_count:,} pixels; limit is {max_pixels:,}"
                )
            pix = page.get_pixmap(matrix=matrix)
            img_bytes = pix.tobytes("png")
            if len(img_bytes) > max_bytes:
                raise ValueError(
                    f"page {p} image is {len(img_bytes):,} bytes; limit is {max_bytes:,}"
                )
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            results.append((p, b64))
    finally:
        doc.close()
    return results


def render_to_data_uri(b64: str) -> str:
    return f"data:image/png;base64,{b64}"
