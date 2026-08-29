#!/usr/bin/env python3
"""Tests for the unified Read CLI (text, page images, and figure sub-images).

Runs the Read CLI as a subprocess using the uv-managed test interpreter.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

_HARNESS = Path(__file__).resolve().parent.parent
_READ_SCRIPT = _HARNESS / "docatlas" / "skills" / "read" / "scripts" / "run.py"


def _run_read(extra_args: list[str], env_override: dict[str, str] | None = None) -> dict:
    """Run the Read CLI and return parsed JSON output."""
    env = os.environ.copy()
    if env_override:
        env.update(env_override)

    cmd = [sys.executable, str(_READ_SCRIPT), *extra_args]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=env)
    assert r.returncode in (0, 2), f"Read CLI failed: {r.stderr}"
    return json.loads(r.stdout)


@pytest.fixture
def markdown_fixture(tmp_path: Path) -> Path:
    """Create the smallest valid MinerU-style tree needed by Read tests."""
    root = tmp_path / "markdown"
    vlm = root / "mini_doc" / "mini_doc_page1" / "vlm"
    images = vlm / "images"
    images.mkdir(parents=True)
    Image.new("RGB", (120, 120), (20, 80, 140)).save(images / "chart.png")
    (vlm / "mini_doc_page1.md").write_text(
        "# Page Two\n\nRevenue by segment:\n\n![](images/chart.png)\n",
        encoding="utf-8",
    )
    return root


def test_markdown_mode_returns_figure_images_meta(markdown_fixture: Path):
    """Markdown mode should populate figure_images_meta with catalog entries."""
    result = _run_read(
        ["--pages", "2", "--markdown-dir", str(markdown_fixture), "--doc-id", "mini_doc"],
        env_override={"HARNESS_FIGURE_MIN_SIZE": "1", "HARNESS_FIGURE_MIN_BYTES": "1"},
    )
    assert result["mode"] == "markdown"
    meta = result.get("figure_images_meta", [])
    assert len(meta) >= 1, f"Expected figure_images_meta entries, got {meta}"
    entry = meta[0]
    assert entry["page"] == 2
    assert "ref" in entry
    assert "caption" in entry
    assert "size_px" in entry


def test_figures_param_returns_sub_images(markdown_fixture: Path):
    """--figures should return base64 URIs in _harness_extras.figure_images."""
    result = _run_read(
        [
            "--pages",
            "2",
            "--markdown-dir",
            str(markdown_fixture),
            "--doc-id",
            "mini_doc",
            "--figures",
            json.dumps([{"page": 2, "ref": "image_1"}]),
        ],
        env_override={"HARNESS_FIGURE_MIN_SIZE": "1", "HARNESS_FIGURE_MIN_BYTES": "1"},
    )
    extras = result.get("_harness_extras", {})
    figs = extras.get("figure_images", [])
    assert len(figs) == 1, f"Expected 1 figure, got {figs}"
    assert figs[0]["ref"] == "image_1"
    assert figs[0]["uri"].startswith("data:image/")


def test_bad_ref_returns_figure_errors(markdown_fixture: Path):
    """Bad ref should produce figure_errors with reason=ref_not_found."""
    result = _run_read(
        [
            "--pages",
            "2",
            "--markdown-dir",
            str(markdown_fixture),
            "--doc-id",
            "mini_doc",
            "--figures",
            json.dumps([{"page": 2, "ref": "image_99"}]),
        ],
    )
    errors = result.get("figure_errors", [])
    assert len(errors) == 1
    assert errors[0]["reason"] == "ref_not_found"
    assert "available_refs" in errors[0]


def test_text_mode_returns_empty_figure_meta(tmp_path: Path):
    """When no markdown is available, figure_images_meta should be empty list."""
    # Page 1 of mini_doc has no figures; use a non-existent markdown-dir
    # to force text mode. We need a real PDF — create a minimal one.
    from pypdf import PdfWriter

    tmp_pdf = tmp_path / "blank.pdf"
    writer = PdfWriter()
    writer.add_blank_page(72, 72)
    with tmp_pdf.open("wb") as handle:
        writer.write(handle)

    result = _run_read(["--pdf", str(tmp_pdf), "--pages", "1"])
    assert result["mode"] == "text"
    assert result.get("figure_images_meta") == []


def test_invalid_pdf_returns_structured_error(tmp_path: Path):
    invalid_pdf = tmp_path / "invalid.pdf"
    invalid_pdf.write_text("not a PDF", encoding="utf-8")

    result = _run_read(["--pdf", str(invalid_pdf), "--pages", "1"])

    assert "could not read PDF pages" in result["error"]
