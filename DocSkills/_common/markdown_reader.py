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
import os
import re
from dataclasses import dataclass, field


_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


@dataclass
class PageMarkdown:
    page_num: int                                    # 1-based
    markdown: str                                    # raw markdown text
    image_paths: list[str] = field(default_factory=list)


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
        candidates = glob.glob(os.path.join(vlm_dir, "*.md"))
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

        with open(md_file, "r", encoding="utf-8") as f:
            md_text = f.read()

        image_paths: list[str] = []
        for match in _MD_IMAGE_RE.finditer(md_text):
            rel_path = match.group(2)
            abs_path = os.path.normpath(os.path.join(vlm_dir, rel_path))
            if os.path.isfile(abs_path):
                image_paths.append(abs_path)

        return PageMarkdown(page_num=page_num, markdown=md_text, image_paths=image_paths)

    def read_pages(
        self, page_nums: list[int]
    ) -> tuple[dict[int, PageMarkdown], list[int]]:
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
    def encode_image_file(image_path: str) -> str | None:
        try:
            with open(image_path, "rb") as f:
                data = f.read()
            ext = os.path.splitext(image_path)[1].lower()
            mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"
            b64 = base64.b64encode(data).decode("utf-8")
            return f"data:{mime};base64,{b64}"
        except Exception:
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
        basename_to_path = {os.path.basename(p): p for p in page.image_paths}
        parts: list[str] = []
        image_refs: list[PageImageRef] = []
        last_end = 0
        image_index = 0

        for match in _MD_IMAGE_RE.finditer(page.markdown):
            parts.append(page.markdown[last_end:match.start()])
            image_index += 1
            ref = f"image_{image_index}"
            parts.append(f"[IMAGE {ref}]")

            basename = os.path.basename(match.group(2))
            abs_path = basename_to_path.get(basename)
            if encode_images and abs_path:
                uri = MarkdownReader.encode_image_file(abs_path)
            else:
                uri = None
            image_refs.append(PageImageRef(image_ref=ref, image_uri=uri))
            last_end = match.end()

        parts.append(page.markdown[last_end:])
        linearized = "".join(parts).strip()
        linearized = re.sub(r"\n{3,}", "\n\n", linearized)
        return linearized, image_refs
