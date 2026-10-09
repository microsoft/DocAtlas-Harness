from __future__ import annotations

import runpy
from pathlib import Path

import pytest

from docatlas_dsh_sidecar.flash_provider import FlashProvider

ROOT = Path(__file__).resolve().parents[3]
QUALITY = runpy.run_path(str(ROOT / "scripts/evaluate-flash-quality.py"))


def test_navigation_quality_counts_merged_key_items_but_requires_original_section_range() -> None:
    case = QUALITY["PdfCase"]("merged", 8, 2, True, True)
    node = {
        "title": "Merged operating review",
        "keyItems": [case.title(section) for section in range(4)],
        "startPage": 1,
        "endPage": 8,
    }
    metrics = QUALITY["navigation_metrics"](case, [node])
    assert metrics == {"expectedSections": 4, "coveredSections": 4, "runningHeaderNodes": 0}
    incomplete = QUALITY["navigation_metrics"](case, [{**node, "endPage": 7}])
    assert incomplete["coveredSections"] == 3


def test_quality_gate_does_not_treat_ready_trees_or_readable_text_as_chinese_retrieval() -> None:
    metrics = {"expectedSections": 4, "coveredSections": 4, "runningHeaderNodes": 0}
    result = {
        "case": "chinese",
        "raw": metrics,
        "merge": metrics,
        "chineseSubstring": {"expectedPages": 8, "foundPages": [], "allExpectedPagesFound": False},
    }
    assert QUALITY["quality_gaps"](result) == ["chinese:chinese-substring-recall"]
    result["chineseSubstring"]["allExpectedPagesFound"] = True
    assert QUALITY["quality_gaps"](result) == []


def test_quality_gate_reports_missing_sections_and_repeated_header_navigation() -> None:
    case = QUALITY["PdfCase"]("headers", 4, 2, False, True)
    metrics = QUALITY["navigation_metrics"](
        case,
        [{"title": case.running_header, "keyItems": [], "startPage": 1, "endPage": 4}],
    )
    assert metrics == {"expectedSections": 2, "coveredSections": 0, "runningHeaderNodes": 1}
    assert QUALITY["quality_gaps"](
        {"case": "headers", "raw": metrics, "merge": metrics, "chineseSubstring": None}
    ) == [
        "headers:raw:section-coverage",
        "headers:raw:running-header-navigation",
        "headers:merge:section-coverage",
        "headers:merge:running-header-navigation",
    ]


@pytest.mark.skipif(
    not Path("/usr/bin/bwrap").is_file() or not QUALITY["DEFAULT_FONT"].is_file(),
    reason="Real generated Chinese PDF gate requires Linux bwrap and the declared local CJK font",
)
def test_real_generated_chinese_pdf_keeps_raw_merge_navigation_and_original_readable_evidence(
    tmp_path: Path,
) -> None:
    result = QUALITY["evaluate_case"](
        tmp_path / "chinese", QUALITY["CASES"][0], QUALITY["DEFAULT_FONT"], FlashProvider()
    )
    assert result["pages"] == 8
    assert result["readableIndexUnchanged"] is True
    for mode in ("raw", "merge"):
        assert result[mode]["coveredSections"] == result[mode]["expectedSections"] == 4
        assert result[mode]["runningHeaderNodes"] == 0
        assert result[mode]["status"] == "ready"
    assert [probe["physicalPage"] for probe in result["readProbes"]] == [1, 4, 8]
    assert all(probe["resolvedOriginalBbox"] for probe in result["readProbes"])
    assert all(probe["locatedChars"] < probe["pageChars"] for probe in result["readProbes"])
    # Do not freeze a known recall defect as desired behavior. The gate must expose
    # a miss today and automatically pass this axis after a separately reviewed fix.
    retrieval = result["chineseSubstring"]
    assert retrieval["query"] == QUALITY["CHINESE_QUERY"]
    assert retrieval["expectedPages"] == 8
    assert retrieval["allExpectedPagesFound"] == (
        len(retrieval["foundPages"]) == 8 and retrieval["locatedPages"] == retrieval["foundPages"]
    )
    if retrieval["allExpectedPagesFound"]:
        assert retrieval["resolvedChineseBboxPages"] == [1, 8]
    assert bool(QUALITY["quality_gaps"](result)) == (not retrieval["allExpectedPagesFound"])
