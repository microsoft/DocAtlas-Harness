#!/usr/bin/env python3
"""Tests for the unified Read CLI (text, page images, and figure sub-images).

Runs the Read CLI as a subprocess using the current interpreter. Skips
gracefully if fixtures or dependencies are unavailable.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_HARNESS = Path(__file__).resolve().parent.parent
_READ_SCRIPT = _HARNESS / "DocSkills" / "Read" / "scripts" / "run.py"
_FIXTURE_DIR = _HARNESS / "evals" / "fixtures" / "markdown_with_figures"
_MINI_DOC = _FIXTURE_DIR / "mini_doc"


def _find_python() -> str:
    """Find a Python with PyPDF2 + PIL available."""
    # Try conda pageindex env first
    try:
        r = subprocess.run(
            ["conda", "run", "-n", "pageindex", "python", "-c",
             "import PyPDF2; import PIL; print('ok')"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0 and "ok" in r.stdout:
            return "conda-pageindex"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    # Try sys.executable
    try:
        r = subprocess.run(
            [sys.executable, "-c", "import PyPDF2; import PIL; print('ok')"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0 and "ok" in r.stdout:
            return "sys"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


_PYTHON_MODE = _find_python()


def _run_read(extra_args: list[str], env_override: dict[str, str] | None = None) -> dict:
    """Run the Read CLI and return parsed JSON output."""
    env = os.environ.copy()
    if env_override:
        env.update(env_override)

    if _PYTHON_MODE == "conda-pageindex":
        cmd = ["conda", "run", "-n", "pageindex", "python", str(_READ_SCRIPT)] + extra_args
    elif _PYTHON_MODE == "sys":
        cmd = [sys.executable, str(_READ_SCRIPT)] + extra_args
    else:
        pytest.skip("No Python with PyPDF2+PIL found")

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=env)
    assert r.returncode in (0, 2), f"Read CLI failed: {r.stderr}"
    return json.loads(r.stdout)


needs_fixtures = pytest.mark.skipif(
    not _MINI_DOC.is_dir(),
    reason="Fixtures not found at evals/fixtures/markdown_with_figures/mini_doc",
)

needs_python = pytest.mark.skipif(
    not _PYTHON_MODE,
    reason="No Python environment with PyPDF2+PIL available",
)


@needs_fixtures
@needs_python
def test_markdown_mode_returns_figure_images_meta():
    """Markdown mode should populate figure_images_meta with catalog entries."""
    result = _run_read(
        ["--pdf", "/dev/null", "--pages", "2",
         "--markdown-dir", str(_FIXTURE_DIR), "--doc-id", "mini_doc"],
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


@needs_fixtures
@needs_python
def test_figures_param_returns_sub_images():
    """--figures should return base64 URIs in _harness_extras.figure_images."""
    result = _run_read(
        ["--pdf", "/dev/null", "--pages", "2",
         "--markdown-dir", str(_FIXTURE_DIR), "--doc-id", "mini_doc",
         "--figures", json.dumps([{"page": 2, "ref": "image_1"}])],
        env_override={"HARNESS_FIGURE_MIN_SIZE": "1", "HARNESS_FIGURE_MIN_BYTES": "1"},
    )
    extras = result.get("_harness_extras", {})
    figs = extras.get("figure_images", [])
    assert len(figs) == 1, f"Expected 1 figure, got {figs}"
    assert figs[0]["ref"] == "image_1"
    assert figs[0]["uri"].startswith("data:image/")


@needs_fixtures
@needs_python
def test_bad_ref_returns_figure_errors():
    """Bad ref should produce figure_errors with reason=ref_not_found."""
    result = _run_read(
        ["--pdf", "/dev/null", "--pages", "2",
         "--markdown-dir", str(_FIXTURE_DIR), "--doc-id", "mini_doc",
         "--figures", json.dumps([{"page": 2, "ref": "image_99"}])],
    )
    errors = result.get("figure_errors", [])
    assert len(errors) == 1
    assert errors[0]["reason"] == "ref_not_found"
    assert "available_refs" in errors[0]


@needs_fixtures
@needs_python
def test_text_mode_returns_empty_figure_meta():
    """When no markdown is available, figure_images_meta should be empty list."""
    # Page 1 of mini_doc has no figures; use a non-existent markdown-dir
    # to force text mode. We need a real PDF — create a minimal one.
    import tempfile
    # Create minimal PDF via the available Python
    pdf_script = (
        "import sys; from PyPDF2 import PdfWriter; "
        "w = PdfWriter(); w.add_blank_page(72,72); "
        "w.write(open(sys.argv[1], 'wb'))"
    )
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        tmp_pdf = f.name

    try:
        if _PYTHON_MODE == "conda-pageindex":
            subprocess.run(
                ["conda", "run", "-n", "pageindex", "python", "-c", pdf_script, tmp_pdf],
                check=True, timeout=30,
            )
        else:
            subprocess.run(
                [sys.executable, "-c", pdf_script, tmp_pdf],
                check=True, timeout=30,
            )

        result = _run_read(["--pdf", tmp_pdf, "--pages", "1"])
        assert result["mode"] == "text"
        assert result.get("figure_images_meta") == []
    finally:
        os.unlink(tmp_pdf)
