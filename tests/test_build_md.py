"""Docling's installed API and the CLI's per-page/atomic-output contract.

Only the inference result is substituted in serialization tests. Real installed
Docling types handle tables, images and provenance; model-backed comparisons are
opt-in via scripts/benchmark_cli.py, not silently downloaded in the unit suite.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from types import SimpleNamespace

import pytest
from docling_core.types.doc import (
    BoundingBox,
    DocItemLabel,
    DoclingDocument,
    ImageRef,
    ProvenanceItem,
    Size,
    TableCell,
    TableData,
)
from PIL import Image
from pypdf import PdfWriter

from docatlas.preprocess import build_md


@pytest.fixture(scope="module")
def docling_modules():
    return build_md._import_docling()


@pytest.fixture
def document() -> DoclingDocument:
    doc = DoclingDocument(name="synthetic")
    for page in range(1, 4):
        doc.add_page(page, Size(width=100, height=100))

    def prov(page: int) -> ProvenanceItem:
        return ProvenanceItem(page_no=page, bbox=BoundingBox(l=0, t=0, r=90, b=90), charspan=(0, 7))

    doc.add_heading("Summary", level=2, prov=prov(1))
    doc.add_text(DocItemLabel.TEXT, "Revenue: 15.2", prov=prov(1))
    doc.add_table(
        data=TableData(
            num_rows=1,
            num_cols=1,
            table_cells=[
                TableCell(
                    text="15.2",
                    start_row_offset_idx=0,
                    end_row_offset_idx=1,
                    start_col_offset_idx=0,
                    end_col_offset_idx=1,
                )
            ],
        ),
        prov=prov(1),
    )
    doc.add_picture(image=ImageRef.from_pil(Image.new("RGB", (8, 8), "blue"), 72), prov=prov(2))
    return doc


def modules_with_result(modules: dict, document: DoclingDocument, captured: dict) -> dict:
    class Converter:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def convert(self, path):
            captured["path"] = path
            return SimpleNamespace(document=document)

    return {**modules, "DocumentConverter": Converter}


@pytest.fixture
def pdf_path(tmp_path: Path) -> Path:
    path = tmp_path / "report.pdf"
    with PdfWriter() as writer:
        for _ in range(3):
            writer.add_blank_page(100, 100)
        writer.write(path)
    return path


@pytest.mark.parametrize("images", [True, False])
@pytest.mark.parametrize("ocr", [True, False])
def test_build_md_preserves_options_page_layout_and_real_docling_types(
    tmp_path: Path, pdf_path: Path, docling_modules, document, images: bool, ocr: bool
) -> None:
    captured: dict = {}
    output = tmp_path / "markdown"
    result = build_md._build_single(
        str(pdf_path),
        str(output),
        argparse.Namespace(images=images, images_scale=2.0, ocr=ocr),
        modules_with_result(docling_modules, document, captured),
    )
    assert result["success"] is True, result
    assert result["pages_written"] == 3
    assert result["images_written"] == int(images)
    assert captured["path"] == str(pdf_path)
    pdf_format = docling_modules["InputFormat"].PDF
    assert captured["allowed_formats"] == [pdf_format]
    opts = captured["format_options"][pdf_format].pipeline_options
    assert opts.images_scale == 2.0
    assert opts.generate_picture_images is images
    assert opts.generate_page_images is False
    assert opts.do_ocr is ocr
    assert opts.enable_remote_services is False
    assert opts.allow_external_plugins is False

    page_one = output / "report/report_page0/vlm/report_page0.md"
    text = page_one.read_text(encoding="utf-8")
    assert text.startswith("## Summary\n\nRevenue: 15.2\n\n")
    assert "<table>" in text and "<td>15.2</td>" in text
    page_two = output / "report/report_page1/vlm"
    assert (page_two / "report_page1.md").read_text() == (
        "![](images/picture-1.png)\n" if images else "\n"
    )
    image = page_two / "images/picture-1.png"
    assert image.exists() is images
    if images:
        with Image.open(image) as picture:
            assert picture.size == (8, 8)
            assert picture.getpixel((0, 0)) == (0, 0, 255)
    assert (output / "report/report_page2/vlm/report_page2.md").read_text() == "\n"
    assert build_md._doc_already_built(str(output), "report", str(pdf_path))
    page_one.unlink()
    assert not build_md._doc_already_built(str(output), "report", str(pdf_path))


def test_build_md_commit_failure_preserves_prior_output_and_cleans_staging(
    tmp_path: Path, pdf_path: Path, docling_modules, document, monkeypatch
) -> None:
    output = tmp_path / "markdown"
    previous = output / "report"
    previous.mkdir(parents=True)
    (previous / "original.md").write_text("keep this generation", encoding="utf-8")
    replace = build_md.os.replace

    def fail_commit(source, target):
        if Path(source).name.startswith(".report.building-") and Path(target) == previous:
            raise OSError("simulated atomic-install failure")
        replace(source, target)

    monkeypatch.setattr(build_md.os, "replace", fail_commit)
    result = build_md._build_single(
        str(pdf_path),
        str(output),
        argparse.Namespace(images=True, images_scale=2.0, ocr=False),
        modules_with_result(docling_modules, document, {}),
    )
    assert result["success"] is False
    assert "simulated atomic-install failure" in result["error"]
    assert (previous / "original.md").read_text() == "keep this generation"
    assert list(output.iterdir()) == [previous]


def test_build_md_does_not_accept_docling_json_disguised_as_pdf(
    tmp_path: Path, docling_modules, document, monkeypatch
) -> None:
    # A --pdf entry point must not dispatch JSON's local-image or other backends.
    pdf = tmp_path / "disguised.pdf"
    document.save_as_json(pdf)
    output = tmp_path / "markdown"

    def no_model_pipeline(*args, **kwargs):
        raise AssertionError("non-PDF input must be rejected before model initialization")

    monkeypatch.setattr(docling_modules["DocumentConverter"], "_get_pipeline", no_model_pipeline)
    result = build_md._build_single(
        str(pdf),
        str(output),
        argparse.Namespace(images=True, images_scale=2.0, ocr=False),
        docling_modules,
    )
    assert result["success"] is False
    assert "AssertionError" not in result["error"]
    assert not output.exists()
