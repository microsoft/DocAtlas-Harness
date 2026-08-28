"""MinerU per-page markdown reader.

Loads per-page markdown produced by MinerU's VLM pipeline and exposes it
through a small reader API.

Directory layout expected (MinerU per-page VLM output)::

    markdown_dir/
      <doc_stem>/                         # e.g. "3M_2018_10K"
        <doc_stem>_page0/                 # 0-based page index
          vlm/
            <doc_stem>_page0.md           # markdown text
            images/                       # extracted figures (jpg/png)
              <hash>.jpg

Page numbering: MinerU uses 0-based indices internally; this module's public
API is **1-based** (and converts as needed).
"""

from __future__ import annotations

import base64
import glob
import mimetypes
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_ALLOWED_IMAGE_SUFFIXES = {".gif", ".jpeg", ".jpg", ".png", ".webp"}
_DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_DEFAULT_MAX_MARKDOWN_BYTES = 5 * 1024 * 1024


def _max_image_bytes() -> int:
    try:
        value = int(os.getenv("HARNESS_MAX_FIGURE_BYTES", str(_DEFAULT_MAX_IMAGE_BYTES)))
    except ValueError:
        return _DEFAULT_MAX_IMAGE_BYTES
    return max(1, value)


def _max_markdown_bytes() -> int:
    try:
        value = int(os.getenv("HARNESS_MAX_MARKDOWN_BYTES", str(_DEFAULT_MAX_MARKDOWN_BYTES)))
    except ValueError:
        return _DEFAULT_MAX_MARKDOWN_BYTES
    return max(1, value)


def _resolve_image_path(vlm_dir: str, raw_ref: str) -> str | None:
    """Resolve a Markdown image reference without allowing directory escape.

    MinerU and Docling place extracted figures under ``vlm/images``. Remote
    URLs, absolute paths, symlinks escaping that directory, non-images, and
    oversized files are rejected.
    """
    ref = unquote(str(raw_ref or "").strip())
    if ref.startswith("<") and ref.endswith(">"):
        ref = ref[1:-1].strip()
    if not ref or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", ref) or ref.startswith("//"):
        return None

    image_root = (Path(vlm_dir) / "images").resolve()
    try:
        candidate = (Path(vlm_dir) / ref).resolve(strict=True)
        candidate.relative_to(image_root)
    except (FileNotFoundError, OSError, ValueError):
        return None
    if not candidate.is_file() or candidate.suffix.lower() not in _ALLOWED_IMAGE_SUFFIXES:
        return None
    try:
        if candidate.stat().st_size > _max_image_bytes():
            return None
    except OSError:
        return None
    return str(candidate)


@dataclass
class PageMarkdown:
    page_num: int  # 1-based
    markdown: str  # raw markdown text
    # One entry per Markdown image placeholder. ``None`` preserves numbering
    # for rejected/missing references so image_N remains stable.
    image_paths: list[str | None] = field(default_factory=list)
    image_root: str | None = None


@dataclass
class PageImageRef:
    image_ref: str
    image_uri: str | None = None


class MarkdownReader:
    """Reads MinerU per-page markdown output for a document."""

    def __init__(self, markdown_dir: str, doc_id: str):
        self.markdown_dir = markdown_dir
        self.doc_id = doc_id
        self.doc_dir = os.path.join(markdown_dir, doc_id)
        self._available = os.path.isdir(self.doc_dir)

    @property
    def available(self) -> bool:
        return self._available

    def _page_dir(self, page_num: int) -> str | None:
        page_idx = page_num - 1
        page_dir = os.path.join(self.doc_dir, f"{self.doc_id}_page{page_idx}", "vlm")
        return page_dir if os.path.isdir(page_dir) else None

    def _find_md_file(self, vlm_dir: str, page_num: int) -> str | None:
        page_idx = page_num - 1
        expected = os.path.join(vlm_dir, f"{self.doc_id}_page{page_idx}.md")
        if os.path.isfile(expected):
            return expected
        candidates = sorted(glob.glob(os.path.join(vlm_dir, "*.md")))
        return candidates[0] if candidates else None

    def read_page(self, page_num: int) -> PageMarkdown | None:
        if not self._available:
            return None
        vlm_dir = self._page_dir(page_num)
        if not vlm_dir:
            return None
        md_file = self._find_md_file(vlm_dir, page_num)
        if not md_file:
            return None
        if os.path.getsize(md_file) > _max_markdown_bytes():
            raise ValueError(f"Markdown page exceeds {_max_markdown_bytes():,} bytes: {md_file}")

        with open(md_file, encoding="utf-8") as f:
            md_text = f.read()

        image_paths: list[str | None] = []
        for match in _MD_IMAGE_RE.finditer(md_text):
            image_paths.append(_resolve_image_path(vlm_dir, match.group(2)))

        return PageMarkdown(
            page_num=page_num,
            markdown=md_text,
            image_paths=image_paths,
            image_root=str((Path(vlm_dir) / "images").resolve()),
        )

    def read_pages(self, page_nums: list[int]) -> tuple[dict[int, PageMarkdown], list[int]]:
        """Returns (found_by_page, missing_pages)."""
        found: dict[int, PageMarkdown] = {}
        missing: list[int] = []
        for pn in page_nums:
            r = self.read_page(pn)
            if r is None:
                missing.append(pn)
            else:
                found[pn] = r
        return found, missing

    @staticmethod
    def encode_image_file(image_path: str, *, allowed_root: str | None = None) -> str | None:
        try:
            path = Path(image_path).resolve(strict=True)
            if allowed_root is not None:
                path.relative_to(Path(allowed_root).resolve())
            if path.suffix.lower() not in _ALLOWED_IMAGE_SUFFIXES:
                return None
            if path.stat().st_size > _max_image_bytes():
                return None

            # Always validate pixels, even when the caller bypasses the size
            # filter via ``force_figures``.
            from PIL import Image

            with Image.open(path) as image:
                image.verify()
            data = path.read_bytes()
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if not mime.startswith("image/"):
                return None
            b64 = base64.b64encode(data).decode("utf-8")
            return f"data:{mime};base64,{b64}"
        except (OSError, ValueError):
            return None

    @staticmethod
    def linearize_page_with_image_refs(
        page: PageMarkdown,
        encode_images: bool = True,
    ) -> tuple[str, list[PageImageRef]]:
        """Replace ``![alt](path)`` with ``[IMAGE image_N]`` and return the
        accompanying image refs (with base64 data URIs where readable).

        If *encode_images* is False, ``image_uri`` will be None for every ref,
        skipping the cost of base64-encoding."""
        parts: list[str] = []
        image_refs: list[PageImageRef] = []
        last_end = 0
        image_index = 0

        for match in _MD_IMAGE_RE.finditer(page.markdown):
            parts.append(page.markdown[last_end : match.start()])
            image_index += 1
            ref = f"image_{image_index}"
            parts.append(f"[IMAGE {ref}]")

            abs_path = (
                page.image_paths[image_index - 1] if image_index <= len(page.image_paths) else None
            )
            if encode_images and abs_path:
                uri = MarkdownReader.encode_image_file(
                    abs_path,
                    allowed_root=page.image_root,
                )
            else:
                uri = None
            image_refs.append(PageImageRef(image_ref=ref, image_uri=uri))
            last_end = match.end()

        parts.append(page.markdown[last_end:])
        linearized = "".join(parts).strip()
        linearized = re.sub(r"\n{3,}", "\n\n", linearized)
        return linearized, image_refs
