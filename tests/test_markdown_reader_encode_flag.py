"""linearize_page_with_image_refs(encode_images=False) returns paths-only refs."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "DocSkills"))
from _common.markdown_reader import MarkdownReader, PageMarkdown


def _make_page(tmp_path: Path) -> PageMarkdown:
    img_dir = tmp_path / "images"
    img_dir.mkdir()
    p = img_dir / "abc.png"
    Image.new("RGB", (200, 200), (0, 0, 255)).save(p)
    md = "Some text\n\n![](images/abc.png)\n\nMore text\n"
    return PageMarkdown(page_num=1, markdown=md, image_paths=[str(p)])


def test_encode_true_returns_uri(tmp_path: Path):
    page = _make_page(tmp_path)
    text, refs = MarkdownReader.linearize_page_with_image_refs(page, encode_images=True)
    assert "[IMAGE image_1]" in text
    assert len(refs) == 1
    assert refs[0].image_uri is not None
    assert refs[0].image_uri.startswith("data:image/")


def test_encode_false_returns_no_uri(tmp_path: Path):
    page = _make_page(tmp_path)
    text, refs = MarkdownReader.linearize_page_with_image_refs(page, encode_images=False)
    assert "[IMAGE image_1]" in text
    assert len(refs) == 1
    assert refs[0].image_uri is None
    assert refs[0].image_ref == "image_1"


def test_default_is_encode_true_for_back_compat(tmp_path: Path):
    page = _make_page(tmp_path)
    _, refs = MarkdownReader.linearize_page_with_image_refs(page)
    assert refs[0].image_uri is not None
