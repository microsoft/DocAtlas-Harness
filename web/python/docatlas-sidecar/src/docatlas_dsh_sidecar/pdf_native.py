"""Native PDF functions; invoked only inside the one-file parser boundary."""

from __future__ import annotations

import hashlib
import io
import math
from collections.abc import Callable
from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .block_index import PageText, normalize_page_text
from .contracts import RatioBBoxSelector
from .pdf_isolation import PdfWorkerError
from .visual import (
    MAX_IMAGE_DIMENSION,
    MAX_VISUAL_BYTES,
    VisualRenderError,
    _encode_png,
    _normalize_pdf_text,
)


def extract(
    source_path: Path,
    max_pages: int | None,
    expected_pages: int | None,
    check_cancelled: Callable[[], None],
) -> dict[str, object]:
    warnings: list[str] = []
    try:
        reader = PdfReader(source_path, strict=True)
        if reader.is_encrypted and reader.decrypt("") == 0:
            raise PdfWorkerError("encrypted-pdf", "encrypted PDF requires an unsupported password")
    except PdfReadError as error:
        raise PdfWorkerError("source-integrity", "PDF structure is invalid") from error
    total_pages = len(reader.pages)
    if expected_pages is not None and expected_pages != total_pages:
        raise PdfWorkerError("source-integrity", "PDF page count does not match revision")
    count = min(total_pages, max_pages) if max_pages is not None else total_pages
    pages: list[PageText] = []
    for index in range(count):
        check_cancelled()
        try:
            text = reader.pages[index].extract_text() or ""
        except Exception as error:  # pypdf surfaces parser-specific exception classes
            text = ""
            warnings.append(f"page {index + 1} text extraction failed: {type(error).__name__}")
        pages.append(PageText(index + 1, normalize_page_text(text)))
    if count < total_pages:
        warnings.append(f"index limited to {count} of {total_pages} pages")
    return {"pages": [page.text for page in pages], "totalPages": total_pages, "warnings": warnings}


def locate(source: Path, physical_page: int, exact: str) -> RatioBBoxSelector | None:
    document = None
    page = None
    text_page = None
    try:
        document = pdfium.PdfDocument(str(source))
        if physical_page < 1 or physical_page > len(document):
            return None
        page = document[physical_page - 1]
        if page.get_rotation() != 0:
            return None
        page_width, page_height = page.get_size()
        if page_width <= 0 or page_height <= 0:
            return None
        text_page = page.get_textpage()
        raw = text_page.get_text_range()
        normalized, raw_indices = _normalize_pdf_text(raw)
        if raw_indices is None:
            return None
        starts: list[int] = []
        start = normalized.find(exact)
        while start >= 0:
            starts.append(start)
            if len(starts) > 1:
                return None
            start = normalized.find(exact, start + 1)
        if len(starts) != 1:
            return None
        begin = starts[0]
        end = begin + len(exact)
        boxes: list[tuple[float, float, float, float]] = []
        for normalized_index in range(begin, end):
            if normalized[normalized_index].isspace():
                continue
            box = text_page.get_charbox(raw_indices[normalized_index])
            if not all(math.isfinite(value) for value in box):
                return None
            left, bottom, right, top = box
            if right > left and top > bottom:
                boxes.append((left, bottom, right, top))
        if not boxes:
            return None
        left = max(0.0, min(box[0] for box in boxes))
        bottom = max(0.0, min(box[1] for box in boxes))
        right = min(page_width, max(box[2] for box in boxes))
        top = min(page_height, max(box[3] for box in boxes))
        if right <= left or top <= bottom:
            return None
        selector: RatioBBoxSelector = {
            "type": "bbox",
            "unit": "ratio",
            "x": left / page_width,
            "y": (page_height - top) / page_height,
            "width": (right - left) / page_width,
            "height": (top - bottom) / page_height,
            "rotation": 0,
        }
        if selector["x"] + selector["width"] > 1.0000001:
            return None
        if selector["y"] + selector["height"] > 1.0000001:
            return None
        return selector
    except Exception:
        return None
    finally:
        if text_page is not None:
            text_page.close()
        if page is not None:
            page.close()
        if document is not None:
            document.close()


def render(
    source: Path,
    physical_page: int,
    max_pixels: int,
    rendered_path: io.BytesIO,
    check: Callable[[], None],
) -> dict[str, int | str]:
    document = page = bitmap = None
    try:
        document = pdfium.PdfDocument(str(source))
        if physical_page < 1 or physical_page > len(document):
            raise VisualRenderError("not-found", "visual physical page is outside the PDF")
        page = document[physical_page - 1]
        page_width, page_height = page.get_size()
        if not math.isfinite(page_width) or not math.isfinite(page_height):
            raise VisualRenderError("unavailable", "PDF page dimensions are invalid")
        if page_width <= 0 or page_height <= 0:
            raise VisualRenderError("unavailable", "PDF page dimensions are empty")
        scale = min(
            math.sqrt(max_pixels / (page_width * page_height)),
            MAX_IMAGE_DIMENSION / page_width,
            MAX_IMAGE_DIMENSION / page_height,
        )
        if scale <= 0 or not math.isfinite(scale):
            raise VisualRenderError("limit-exceeded", "PDF render scale is invalid")
        for _attempt in range(5):
            check()
            bitmap = page.render(scale=scale, rev_byteorder=True)
            pixels = bitmap.width * bitmap.height
            if (
                pixels <= max_pixels
                and bitmap.width <= MAX_IMAGE_DIMENSION
                and bitmap.height <= MAX_IMAGE_DIMENSION
            ):
                break
            dimension_steps = [
                (dimension - 1) / dimension
                for dimension in (bitmap.width, bitmap.height)
                if dimension > 1
            ]
            if not dimension_steps:
                break
            scale *= min(dimension_steps) * 0.999
            bitmap.close()
            bitmap = None
        if bitmap is None or bitmap.width * bitmap.height > max_pixels:
            raise VisualRenderError(
                "limit-exceeded", "PDFium could not satisfy the visual pixel limit"
            )
        check()
        _encode_png(bitmap, rendered_path, check)
        data = rendered_path.getvalue()
        content_hash, byte_length = hashlib.sha256(data).hexdigest(), len(data)
        if byte_length > MAX_VISUAL_BYTES:
            raise VisualRenderError(
                "limit-exceeded", "rendered image exceeds the visual byte limit"
            )
        return {
            "width": bitmap.width,
            "height": bitmap.height,
            "contentHash": content_hash,
            "byteLength": byte_length,
        }
    finally:
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()
        if document is not None:
            document.close()
