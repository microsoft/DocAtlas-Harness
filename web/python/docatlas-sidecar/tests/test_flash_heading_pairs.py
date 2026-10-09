from __future__ import annotations

import runpy
from pathlib import Path

import pytest

from docatlas_dsh_sidecar.flash_provider import FlashProvider

ROOT = Path(__file__).resolve().parents[3]
PAIRS = runpy.run_path(str(ROOT / "scripts/evaluate-flash-heading-pairs.py"))


@pytest.mark.skipif(
    not Path("/usr/bin/bwrap").is_file() or not PAIRS["QUALITY"]["DEFAULT_FONT"].is_file(),
    reason="Real paired-PDF navigation gate requires Linux bwrap and the declared local CJK font",
)
@pytest.mark.parametrize(
    "name",
    [
        "no-cover-repeated",
        "no-cover-distinct",
        "bookmarks-supported",
        "bookmarks-page-counter",
        "bookmarks-file-counter",
        "bookmarks-neighbour-only",
    ],
)
def test_real_numbered_sections_and_printed_garbage_boundaries(tmp_path: Path, name: str) -> None:
    case = next(value for value in PAIRS["CASES"] if value.name == name)
    result = PAIRS["evaluate"](
        tmp_path / name, case, PAIRS["QUALITY"]["DEFAULT_FONT"], FlashProvider()
    )
    assert result["coveredSections"] == result["expectedSections"] == 4
    assert result["allNodeTitlesOnExactSourcePage"] is True
    assert result["qualityGaps"] == []
    assert result["tocSource"] == ("hybrid" if name == "bookmarks-supported" else "detected")
