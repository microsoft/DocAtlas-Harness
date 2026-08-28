from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from docatlas.scoring.finrag_judge import _eviplace
from docatlas.scoring.score_mmlongbench_hybrid import _safe_eval_list, eval_score
from docatlas.skills._common.markdown_reader import MarkdownReader


def _write_png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (120, 120), (20, 40, 60)).save(path)


def test_markdown_reader_confines_images_to_page_image_directory(tmp_path: Path) -> None:
    doc_id = "report"
    vlm = tmp_path / doc_id / f"{doc_id}_page0" / "vlm"
    image_dir = vlm / "images"
    safe_image = image_dir / "safe.png"
    outside_image = tmp_path / "outside.png"
    _write_png(safe_image)
    _write_png(outside_image)
    vlm.mkdir(parents=True, exist_ok=True)
    (vlm / f"{doc_id}_page0.md").write_text(
        "![](images/safe.png)\n![](../../../outside.png)\n", encoding="utf-8"
    )

    page = MarkdownReader(str(tmp_path), doc_id).read_page(1)

    assert page is not None
    assert page.image_paths[0] == str(safe_image.resolve())
    assert page.image_paths[1] is None


def test_literal_parsers_do_not_execute_input(tmp_path: Path) -> None:
    marker = tmp_path / "executed"
    expression = f"[__import__('pathlib').Path({str(marker)!r}).write_text('owned')]"

    assert _safe_eval_list(expression) == [expression]
    assert eval_score("['expected']", expression, "List") == 0.0
    assert _eviplace({"evidence_pages": expression}) is None
    assert not marker.exists()


def test_markdown_page_size_limit(tmp_path: Path, monkeypatch) -> None:
    doc_id = "large"
    vlm = tmp_path / doc_id / f"{doc_id}_page0" / "vlm"
    vlm.mkdir(parents=True)
    (vlm / f"{doc_id}_page0.md").write_text("too large", encoding="utf-8")
    monkeypatch.setenv("HARNESS_MAX_MARKDOWN_BYTES", "4")

    with pytest.raises(ValueError, match="exceeds"):
        MarkdownReader(str(tmp_path), doc_id).read_page(1)
