from __future__ import annotations

import copy
import hashlib
import json
import runpy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
GUARDS = runpy.run_path(str(ROOT / "compat/pageindex-flash/numbered_headings.py"))
GENERATOR = runpy.run_path(str(ROOT / "scripts/vendor_flash.py"))
MANIFEST = ROOT / "compat/pageindex-flash/numbered-headings.patch.json"


def _entries() -> list[dict]:
    return [
        {
            "title": f"Chapter {index + 1}: Operating analysis and risk review",
            "page": 1 + 2 * index,
            "level": 1,
        }
        for index in range(4)
    ]


def _page_texts(entries: list[dict]) -> list[str]:
    pages = ["Actual page body" for _ in range(8)]
    for entry in entries:
        pages[entry["page"] - 1] = "Running header\n" + entry["title"] + "\nActual page body"
    return pages


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Chapter 1: Operating analysis", ("chapter", 1, "Operating analysis")),
        ("CHAPTER ２： Operating analysis", ("chapter", 2, "Operating analysis")),
        ("第一章 经营概览", ("chapter", 1, "经营概览")),
        ("第一百零一章 经营概览", ("chapter", 101, "经营概览")),
        ("Page 1", None),
        ("file-0001", None),
        ("2026 Annual report", None),
        ("Chapter 0: Invalid", None),
        ("Chapter 10000: Unbounded", None),
        ("Chapter 1\nsource body", None),
    ],
)
def test_numbered_content_unit_parser_is_narrow(title: str, expected: object) -> None:
    assert GUARDS["numbered_title"](title) == expected


def test_title_guard_only_preserves_a_real_cross_page_same_style_sequential_cohort() -> None:
    first = "第一章 经营分析与风险审查"
    peers = [
        (f"第{number}章 经营分析与风险审查", page, "source-font", 18.0)
        for number, page in zip("一二三四", (1, 3, 5, 7), strict=True)
    ]
    guard = GUARDS["title_is_numbered_section"]
    assert guard(first, 1, "source-font", 18.0, 12.0, peers)
    assert not guard("Generated report title", 1, "source-font", 26.0, 12.0, peers)
    assert not guard(first, 1, "source-font", 18.0, 12.0, peers[:2])
    assert not guard(first, 1, "source-font", 18.0, 18.0, peers)
    assert not guard(first, 1, "source-font", 18.0, 12.0, list(reversed(peers)))
    assert not guard(first, 1, "source-font", 18.0, 12.0, [peers[0], peers[2], peers[3]])
    assert not guard(
        first,
        1,
        "source-font",
        18.0,
        12.0,
        [(text, 1, style, size) for text, _, style, size in peers],
    )
    assert not guard(first, 1, "other-font", 18.0, 12.0, peers)
    assert not guard(first, 1, "source-font", 17.0, 12.0, peers)
    assert not guard(first, 3, "source-font", 18.0, 12.0, peers)


def test_bookmark_exception_requires_the_whole_cohort_on_exact_original_page_lines() -> None:
    entries = _entries()
    pages = _page_texts(entries)
    support = GUARDS["source_supported_numbered_bookmarks"]
    assert support(entries, 8, pages)
    assert not support(entries, 8, None)
    assert not support(entries, 9, pages)
    assert not support(entries[:2], 8, pages)
    missing = pages.copy()
    missing[2] = "Missing source heading"
    assert not support(entries, 8, missing)
    only_neighbour = pages.copy()
    only_neighbour[1], only_neighbour[2] = pages[2], "No chapter on this page"
    assert not support(entries, 8, only_neighbour)
    embedded_in_prose = [
        f"A paragraph quoting {page.replace(chr(10), ' ')} in its middle." for page in pages
    ]
    assert not support(entries, 8, embedded_in_prose)


@pytest.mark.parametrize("kind", ["Page {number}", "file-{number:04d}", "report-{number:04d}-2026"])
def test_printed_page_and_file_counters_stay_rejected(kind: str) -> None:
    entries = [
        {**entry, "title": kind.format(number=index + 1)} for index, entry in enumerate(_entries())
    ]
    assert not GUARDS["source_supported_numbered_bookmarks"](entries, 8, _page_texts(entries))


@pytest.mark.parametrize(
    "mutation",
    [
        "reverse",
        "duplicate-page",
        "duplicate-number",
        "number-gap",
        "foreign-unit",
        "nested",
        "extra-field",
    ],
)
def test_bookmark_exception_does_not_salvage_invalid_or_ambiguous_entry_sets(mutation: str) -> None:
    entries = _entries()
    if mutation == "reverse":
        entries.reverse()
    elif mutation == "duplicate-page":
        entries[1]["page"] = entries[0]["page"]
    elif mutation == "duplicate-number":
        entries[1]["title"] = entries[0]["title"]
    elif mutation == "number-gap":
        entries[3]["title"] = "Chapter 5: Operating analysis and risk review"
    elif mutation == "foreign-unit":
        entries[3]["title"] = "Part 4: Operating analysis and risk review"
    elif mutation == "nested":
        entries[1]["level"] = 2
    else:
        entries[1]["extra"] = True
    assert not GUARDS["source_supported_numbered_bookmarks"](entries, 8, _page_texts(entries))


def _outputs() -> dict[str, bytes]:
    return {
        name: (ROOT / ".sources/pageindex/pageindex" / name).read_bytes()
        for name in ("flash/main.py", "flash/embedded_toc.py")
    }


def test_reviewed_generator_replays_exact_hashes_in_memory_without_touching_vendor() -> None:
    outputs = _outputs()
    originals = copy.deepcopy(outputs)
    before = (
        ROOT
        / "python/docatlas-sidecar/src/docatlas_dsh_sidecar/_vendor/pageindex_flash/flash/main.py"
    ).read_bytes()
    proof = GENERATOR["apply_reviewed_patch"](outputs)
    manifest = json.loads(MANIFEST.read_text())
    assert proof["manifestSha256"] == hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
    for item in proof["files"]:
        assert hashlib.sha256(originals[item["path"]]).hexdigest() == item["upstreamSha256"]
        assert hashlib.sha256(outputs[item["path"]]).hexdigest() == item["outputSha256"]
    assert (
        outputs["flash/_docatlas_numbered.py"]
        == (ROOT / manifest["addition"]["source"]).read_bytes()
    )
    assert b"entries == raw_entries" in outputs["flash/embedded_toc.py"]
    assert (
        ROOT
        / "python/docatlas-sidecar/src/docatlas_dsh_sidecar/_vendor/pageindex_flash/flash/main.py"
    ).read_bytes() == before


@pytest.mark.parametrize(
    "mutation", ["upstream", "output", "helper", "path", "source", "commit", "duplicate-hunk"]
)
def test_generator_rejects_unreviewed_fingerprints_paths_and_fuzzy_matches_atomically(
    tmp_path: Path, mutation: str
) -> None:
    manifest = json.loads(MANIFEST.read_text())
    if mutation == "upstream":
        manifest["files"][0]["upstreamSha256"] = "0" * 64
    elif mutation == "output":
        manifest["files"][0]["outputSha256"] = "0" * 64
    elif mutation == "helper":
        manifest["addition"]["sha256"] = "0" * 64
    elif mutation == "path":
        manifest["files"][0]["path"] = "../outside.py"
    elif mutation == "source":
        manifest["addition"]["source"] = "../outside.py"
    elif mutation == "commit":
        manifest["sourceCommit"] = "0" * 40
    else:
        manifest["files"][0]["replacements"][0]["before"] = [""]
    path = tmp_path / "patch.json"
    path.write_text(json.dumps(manifest))
    outputs = _outputs()
    before = outputs.copy()
    with pytest.raises(RuntimeError):
        GENERATOR["apply_reviewed_patch"](outputs, path)
    assert outputs == before
