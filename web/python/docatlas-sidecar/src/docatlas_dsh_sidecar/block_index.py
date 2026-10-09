"""Deterministic page normalization, block segmentation, and text quality."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

type BlockKind = Literal["heading", "paragraph", "list", "table", "caption", "other"]
type TextQuality = Literal["empty", "sparse", "garbled", "usable"]

_HEADING = re.compile(r"^#{1,6}\s+\S")
_LIST = re.compile(r"^(?:[-*+]\s+|\d+[.)]\s+)")
_CAPTION = re.compile(r"^(?:figure|fig\.|table)\s+\d+", re.IGNORECASE)
_MAX_BLOCK_CHARS = 4000


@dataclass(frozen=True, slots=True)
class PageText:
    physical_page: int
    text: str


@dataclass(frozen=True, slots=True)
class TextBlock:
    block_id: str
    physical_page: int
    page_block_index: int
    ordinal: int
    kind: BlockKind
    heading: str
    text: str
    char_start: int
    char_end: int
    text_hash: str


def normalize_page_text(value: str) -> str:
    """Normalize encoding/newlines without collapsing evidence-bearing whitespace."""
    return unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n")


def assess_text_quality(pages: list[PageText]) -> TextQuality:
    text = "".join(page.text for page in pages)
    visible = [char for char in text if not char.isspace()]
    if not visible:
        return "empty"
    bad = sum(
        char == "\ufffd" or unicodedata.category(char) in {"Cc", "Cs", "Co"} for char in visible
    )
    if bad / len(visible) >= 0.02:
        return "garbled"
    nonempty_pages = sum(bool(page.text.strip()) for page in pages)
    average_chars = len(visible) / max(1, len(pages))
    if average_chars < 80 or nonempty_pages / max(1, len(pages)) < 0.5:
        return "sparse"
    return "usable"


def build_blocks(
    pages: list[PageText],
    representation_id: str,
    *,
    split_visual_lines: bool = False,
) -> list[TextBlock]:
    blocks: list[TextBlock] = []
    ordinal = 0
    for page in pages:
        page_blocks = (
            _visual_line_blocks(page.text) if split_visual_lines else _page_blocks(page.text)
        )
        heading = ""
        for page_index, (kind, text, start, end) in enumerate(page_blocks, start=1):
            ordinal += 1
            if kind == "heading":
                heading = text.lstrip("#").strip()
                rendered = heading
                rendered_offset = text.find(rendered)
                block_start = start + max(0, rendered_offset)
                block_end = block_start + len(rendered)
            else:
                rendered = text
                block_start = start
                block_end = end
            digest = hashlib.sha256(
                f"{representation_id}\0{page.physical_page}\0{page_index}\0{kind}\0{rendered}".encode()
            ).hexdigest()
            blocks.append(
                TextBlock(
                    block_id=(f"p{page.physical_page:05d}.b{page_index:05d}.{kind}.{digest[:12]}"),
                    physical_page=page.physical_page,
                    page_block_index=page_index,
                    ordinal=ordinal,
                    kind=kind,
                    heading=heading,
                    text=rendered,
                    char_start=block_start,
                    char_end=block_end,
                    text_hash=hashlib.sha256(rendered.encode()).hexdigest(),
                )
            )
    return blocks


def _visual_line_blocks(text: str) -> list[tuple[BlockKind, str, int, int]]:
    """Keep PDF visual lines independently addressable for source-page citation focus."""
    normalized = normalize_page_text(text)
    output: list[tuple[BlockKind, str, int, int]] = []
    offset = 0
    for line in normalized.splitlines(keepends=True):
        content = line.rstrip("\n")
        left_trim = len(content) - len(content.lstrip())
        rendered = content.strip()
        if rendered:
            start = offset + left_trim
            cursor = 0
            for segment in _bounded_segments(rendered):
                relative = rendered.find(segment, cursor)
                output.append(
                    (
                        _line_kind(segment),
                        segment,
                        start + relative,
                        start + relative + len(segment),
                    )
                )
                cursor = relative + len(segment)
        offset += len(line)
    if normalized and not normalized.endswith("\n") and offset < len(normalized):
        rendered = normalized[offset:].strip()
        if rendered:
            start = normalized.find(rendered, offset)
            output.append((_line_kind(rendered), rendered, start, start + len(rendered)))
    return output


def _line_kind(text: str) -> BlockKind:
    stripped = text.strip()
    if _HEADING.match(stripped):
        return "heading"
    if _LIST.match(stripped):
        return "list"
    if stripped.startswith("|") and stripped.endswith("|"):
        return "table"
    if _CAPTION.match(stripped):
        return "caption"
    return "paragraph"


def _page_blocks(text: str) -> list[tuple[BlockKind, str, int, int]]:
    normalized = normalize_page_text(text)
    output: list[tuple[BlockKind, str, int, int]] = []
    pending: list[tuple[str, int, int]] = []
    pending_kind: BlockKind | None = None

    def flush() -> None:
        nonlocal pending, pending_kind
        if not pending or pending_kind is None:
            pending = []
            pending_kind = None
            return
        joined = "".join(line for line, _, _ in pending)
        left_trim = len(joined) - len(joined.lstrip())
        raw = joined.strip()
        start = pending[0][1] + left_trim
        cursor = 0
        for segment in _bounded_segments(raw):
            relative_start = raw.find(segment, cursor)
            if relative_start < 0:
                relative_start = cursor
            relative_end = relative_start + len(segment)
            output.append((pending_kind, segment, start + relative_start, start + relative_end))
            cursor = relative_end
        pending = []
        pending_kind = None

    offset = 0
    for line in normalized.splitlines(keepends=True):
        end = offset + len(line)
        stripped = line.strip()
        if not stripped:
            flush()
            offset = end
            continue
        kind = _line_kind(line)
        if kind == "heading":
            flush()
            pending = [(line, offset, end)]
            pending_kind = kind
            flush()
        elif (
            pending_kind is not None
            and kind != pending_kind
            and (
                kind in {"list", "table", "caption"} or pending_kind in {"list", "table", "caption"}
            )
        ):
            flush()
            pending = [(line, offset, end)]
            pending_kind = kind
        else:
            pending.append((line, offset, end))
            if pending_kind is None:
                pending_kind = kind
        offset = end
    if normalized and not normalized.endswith(("\n", "\r")):
        offset = len(normalized)
    flush()
    return output


def _bounded_segments(text: str) -> list[str]:
    if len(text) <= _MAX_BLOCK_CHARS:
        return [text]
    remaining = text
    output: list[str] = []
    while len(remaining) > _MAX_BLOCK_CHARS:
        cut = max(
            remaining.rfind("\n", 0, _MAX_BLOCK_CHARS + 1),
            remaining.rfind(" ", 0, _MAX_BLOCK_CHARS + 1),
        )
        if cut <= 0:
            cut = _MAX_BLOCK_CHARS
        output.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        output.append(remaining)
    return output


__all__ = [
    "PageText",
    "TextBlock",
    "TextQuality",
    "assess_text_quality",
    "build_blocks",
    "normalize_page_text",
]
