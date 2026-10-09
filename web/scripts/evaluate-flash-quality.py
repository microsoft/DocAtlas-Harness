"""Offline, generated-PDF navigation/read quality gate; never a model quality score.

Uses the locked product dependencies, an explicitly identified local CJK font and
the real isolated PDF/Flash providers. Generated files stay in a temporary folder.
An unmet quality gate exits 2 after printing the complete measurements.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import json
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from docatlas_dsh_sidecar.document_service import DocumentService
from docatlas_dsh_sidecar.flash_provider import FlashProvider
from docatlas_dsh_sidecar.ingest import DocumentIndexStore
from docatlas_dsh_sidecar.tree_index import TreeBuildRequest, TreeNode
from docatlas_dsh_sidecar.tree_service import TreeIndexService
from pypdf import PdfReader, PdfWriter
from pypdfium2 import raw as pdfium_c

DEFAULT_FONT = Path("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf")
CHINESE_FACT = "本期经营现金流保持稳定且现金储备足以覆盖未来投入"
CHINESE_QUERY = "经营现金流"


def chinese_digits(value: int) -> str:
    return str(value).translate(str.maketrans("0123456789", "零一二三四五六七八九"))


@dataclass(frozen=True)
class PdfCase:
    name: str
    pages: int
    section_pages: int
    chinese: bool
    bookmarks: bool

    def title(self, section: int) -> str:
        return (
            f"第{chinese_digits(section + 1)}章 经营分析与风险审查"
            if self.chinese
            else f"Chapter {section + 1}: Operating analysis and risk review"
        )

    def marker(self, page: int) -> str:
        # One lexical token isolates the target despite identical running headers.
        return f"evidenceanchor{page:04d}"

    @property
    def running_header(self) -> str:
        return (
            "星河集团年度经营报告" if self.chinese else "RESEARCH GROUP ANNUAL REPORT"
        )


CASES = (
    PdfCase("chinese-bookmarks", 8, 2, True, True),
    PdfCase("chinese-no-bookmarks", 8, 2, True, False),
    PdfCase("repeated-headers", 16, 4, False, True),
    PdfCase("long-bilingual", 80, 10, True, True),
)


def _add_text(
    page: Any, document: Any, font: tuple[Any, Any], text: str, size: int, y: int
) -> None:
    selected = font[0] if any(ord(char) > 127 for char in text) else font[1]
    obj = pdfium_c.FPDFPageObj_CreateTextObj(document, selected, size)
    if not obj:
        raise RuntimeError("Could not allocate the generated PDF text object")
    encoded = ctypes.create_string_buffer(text.encode("utf-16-le") + b"\0\0")
    if not pdfium_c.FPDFText_SetText(
        obj, ctypes.cast(encoded, ctypes.POINTER(ctypes.c_ushort))
    ):
        pdfium_c.FPDFPageObj_Destroy(obj)
        raise RuntimeError("Could not write the generated Unicode PDF text")
    pdfium_c.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 48, y)
    pdfium_c.FPDFPage_InsertObject(page, obj)


def generate_pdf(path: Path, case: PdfCase, font_path: Path) -> None:
    """Make actual glyph-bearing PDF pages, not a mocked parser or tree response."""
    font_bytes = font_path.read_bytes()
    if not 1 <= len(font_bytes) <= 16 * 1024**2:
        raise ValueError("CJK font must be a bounded local TTF")
    font_buffer = (ctypes.c_ubyte * len(font_bytes)).from_buffer_copy(font_bytes)
    document = pdfium.PdfDocument.new()
    font = pdfium_c.FPDFText_LoadFont(
        document, font_buffer, len(font_bytes), pdfium_c.FPDF_FONT_TRUETYPE, True
    )
    if not font:
        document.close()
        raise RuntimeError("PDFium could not load the selected CJK font")
    latin = pdfium_c.FPDFText_LoadStandardFont(document, b"Helvetica")
    if not latin:
        pdfium_c.FPDFFont_Close(font)
        document.close()
        raise RuntimeError("PDFium could not load its standard Latin font")
    fonts = (font, latin)
    try:
        for page_index in range(case.pages):
            page = document.new_page(612, 792)
            try:
                _add_text(page, document, fonts, case.running_header, 9, 760)
                if page_index % case.section_pages == 0:
                    _add_text(
                        page,
                        document,
                        fonts,
                        case.title(page_index // case.section_pages),
                        18,
                        710,
                    )
                _add_text(page, document, fonts, case.marker(page_index + 1), 12, 650)
                for line in range(8):
                    text = (
                        (
                            CHINESE_FACT
                            if line == 0
                            else f"本页第{chinese_digits(page_index + 1)}号审查记录{chinese_digits(line)}：已核验项目预算与风险条件"
                        )
                        if case.chinese
                        else (
                            f"Page {page_index + 1} finding {line + 1}: verified operating budget and risk conditions."
                        )
                    )
                    _add_text(page, document, fonts, text, 12, 620 - line * 24)
                _add_text(
                    page, document, fonts, f"{page_index + 1} / {case.pages}", 9, 30
                )
                page.gen_content()
            finally:
                page.close()
        output = io.BytesIO()
        document.save(output)
    finally:
        pdfium_c.FPDFFont_Close(font)
        pdfium_c.FPDFFont_Close(latin)
        document.close()
    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(output.getvalue())).pages:
        writer.add_page(page)
    if case.bookmarks:
        for start in range(0, case.pages, case.section_pages):
            writer.add_outline_item(case.title(start // case.section_pages), start)
    with path.open("wb") as stream:
        writer.write(stream)


def navigation_metrics(case: PdfCase, nodes: list[TreeNode]) -> dict[str, int]:
    """Known title/range coverage, including titles retained by deterministic merge."""
    sections = range(0, case.pages, case.section_pages)
    covered = 0
    for start in sections:
        title = case.title(start // case.section_pages)
        if any(
            any(title in value for value in [node["title"], *node["keyItems"]])
            and node["startPage"] <= start + 1
            and node["endPage"] >= min(start + case.section_pages, case.pages)
            for node in nodes
        ):
            covered += 1
    return {
        "expectedSections": len(sections),
        "coveredSections": covered,
        "runningHeaderNodes": sum(
            case.running_header in node["title"] for node in nodes
        ),
    }


def quality_gaps(result: dict[str, Any]) -> list[str]:
    gaps = []
    for mode in ("raw", "merge"):
        metrics = result[mode]
        if metrics["coveredSections"] != metrics["expectedSections"]:
            gaps.append(f"{result['case']}:{mode}:section-coverage")
        if metrics["runningHeaderNodes"]:
            gaps.append(f"{result['case']}:{mode}:running-header-navigation")
    if (
        result["chineseSubstring"] is not None
        and not result["chineseSubstring"]["allExpectedPagesFound"]
    ):
        gaps.append(f"{result['case']}:chinese-substring-recall")
    return gaps


def evaluate_case(
    directory: Path, case: PdfCase, font_path: Path, provider: FlashProvider
) -> dict[str, Any]:
    directory.mkdir()
    source_dir = directory / "sources"
    source_dir.mkdir()
    source = source_dir / f"{case.name}.pdf"
    generate_pdf(source, case, font_path)
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    store = DocumentIndexStore({"root:quality": source_dir}, directory / "cache")
    service = DocumentService(store)
    started = time.perf_counter()
    ingested = store.ingest(
        {
            "schemaVersion": 1,
            "requestType": "ingest",
            "idempotencyKey": "idempotency:quality",
            "revision": {
                "schemaVersion": 1,
                "documentId": "doc:quality",
                "revisionId": "rev:quality",
                "contentHash": digest,
                "byteLength": len(content),
                "mediaType": "application/pdf",
                "displayName": source.name,
                "origin": {"kind": "local-file"},
                "ingestedAt": "2026-09-09T00:00:00Z",
                "status": "active",
            },
            "sourceBinding": {
                "schemaVersion": 1,
                "bindingId": "binding:quality",
                "rootId": "root:quality",
                "relativePath": source.name,
                "expectedContentHash": digest,
                "byteLength": len(content),
                "mediaType": "application/pdf",
            },
            "requestedRepresentationKinds": ["embedded-text"],
            "options": {"forceRebuild": False, "allowOcr": False},
        }
    )
    ingest_seconds = time.perf_counter() - started
    identity = {
        "documentId": "doc:quality",
        "revisionId": "rev:quality",
        "representationId": ingested["representations"][-1]["representationId"],
    }
    before = store.current_snapshot("doc:quality", "rev:quality")
    read_probes = []
    for physical_page in sorted({1, case.pages // 2, case.pages}):
        page = service.read(
            {
                "schemaVersion": 1,
                "requestType": "read",
                "mode": "page",
                "source": identity,
                "physicalPage": physical_page,
                "limits": {"maxItems": 100, "maxChars": 12000},
            }
        )
        text = "\n".join(item["text"] for item in page["items"])
        assert case.marker(physical_page) in text
        if case.chinese:
            assert CHINESE_FACT in text, (
                "Generated Chinese glyph text must survive the real parser"
            )
        located = service.read(
            {
                "schemaVersion": 1,
                "requestType": "read",
                "mode": "locate",
                "source": identity,
                "query": case.marker(physical_page),
                "limits": {"maxItems": 5, "maxChars": 1000},
            }
        )
        assert (
            len(located["items"]) == 1
            and located["items"][0]["physicalPage"] == physical_page
        )
        item = located["items"][0]
        resolved = service.resolve(
            {
                "schemaVersion": 1,
                "requestType": "resolve",
                "locator": item["locator"],
                "allowCandidates": True,
                "maxCandidates": 5,
            }
        )
        assert resolved["status"] == "resolved"
        selectors = resolved["resolvedLocator"]["selectors"]
        assert any(selector["type"] == "bbox" for selector in selectors)
        read_probes.append(
            {
                "physicalPage": physical_page,
                "locatedBlocks": 1,
                "locatedChars": located["pageInfo"]["usedChars"],
                "pageChars": page["pageInfo"]["usedChars"],
                "resolvedOriginalBbox": True,
            }
        )
    chinese_substring = None
    if case.chinese:
        started = time.perf_counter()
        found = service.search(
            {
                "schemaVersion": 1,
                "requestType": "search",
                "scopeVersionId": "scope:quality",
                "sources": [identity],
                "query": CHINESE_QUERY,
                "strategy": "fts",
                "limits": {"maxItems": 200, "maxChars": 20000},
            }
        )
        search_seconds = time.perf_counter() - started
        found_pages = sorted(
            {item["physicalPageStart"] for item in found["candidates"]}
        )
        located = service.read(
            {
                "schemaVersion": 1,
                "requestType": "read",
                "mode": "locate",
                "source": identity,
                "query": CHINESE_QUERY,
                "limits": {"maxItems": 200, "maxChars": 20000},
            }
        )
        located_pages = sorted({item["physicalPage"] for item in located["items"]})
        resolved_pages = []
        for index in sorted({0, len(located["items"]) - 1}) if located["items"] else []:
            item = located["items"][index]
            assert CHINESE_QUERY in item["text"]
            resolved = service.resolve(
                {
                    "schemaVersion": 1,
                    "requestType": "resolve",
                    "locator": item["locator"],
                    "allowCandidates": True,
                    "maxCandidates": 5,
                }
            )
            assert resolved["status"] == "resolved"
            assert any(
                selector["type"] == "bbox"
                for selector in resolved["resolvedLocator"]["selectors"]
            )
            resolved_pages.append(item["physicalPage"])
        chinese_substring = {
            "query": CHINESE_QUERY,
            "expectedPages": case.pages,
            "foundPages": found_pages,
            "searchSeconds": round(search_seconds, 6),
            "locatedPages": located_pages,
            "resolvedChineseBboxPages": resolved_pages,
            "allExpectedPagesFound": len(found_pages) == case.pages
            and located_pages == found_pages,
        }
    trees = TreeIndexService(store, provider)
    request: TreeBuildRequest = {
        "schemaVersion": 1,
        "kind": "build-tree",
        "documentId": "doc:quality",
        "revisionId": "rev:quality",
        "sourceHash": digest,
        "config": {"mode": "raw", "useEmbeddedToc": True, "workers": 1},
    }
    metrics = {}
    for mode in ("raw", "merge"):
        started = time.perf_counter()
        manifest = trees.build(
            {**request, "config": {**request["config"], "mode": mode}}
        )
        seconds = time.perf_counter() - started
        tree = trees.read(
            {
                "schemaVersion": 1,
                "kind": "read-tree",
                "documentId": "doc:quality",
                "revisionId": "rev:quality",
                "sourceHash": digest,
                "generationId": manifest["generationId"],
                "offset": 0,
                "limit": 200,
            }
        )
        assert tree["nextOffset"] is None, (
            "The generated quality corpus must fit the measured tree page"
        )
        metrics[mode] = {
            "seconds": round(seconds, 3),
            "nodes": manifest["nodeCount"],
            "tocSource": manifest["tocSource"],
            "status": manifest["status"],
            "warnings": manifest["warnings"],
            "costBefore": manifest["optimization"]["costBefore"],
            "costAfter": manifest["optimization"]["costAfter"],
            **navigation_metrics(case, tree["nodes"]),
        }
    assert store.current_snapshot("doc:quality", "rev:quality") == before
    return {
        "case": case.name,
        "pages": case.pages,
        "sourceBytes": len(content),
        "sourceHash": digest,
        "ingestSeconds": round(ingest_seconds, 3),
        **metrics,
        "readProbes": read_probes,
        "chineseSubstring": chinese_substring,
        "readableIndexUnchanged": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, default=DEFAULT_FONT)
    parser.add_argument(
        "--case", action="append", choices=[case.name for case in CASES]
    )
    args = parser.parse_args()
    if sys.version_info[:3] != (3, 12, 12):
        raise RuntimeError("Use the locked CPython 3.12.12 environment through uv")
    font = args.font.resolve(strict=True)
    provider = FlashProvider()
    results = []
    with tempfile.TemporaryDirectory(prefix="docatlas-flash-quality-") as temporary:
        for case in CASES:
            if args.case is None or case.name in args.case:
                results.append(
                    evaluate_case(Path(temporary) / case.name, case, font, provider)
                )
    gaps = [gap for result in results for gap in quality_gaps(result)]
    print(
        json.dumps(
            {
                "schemaVersion": 1,
                "corpus": "generated-pdf-quality.v1",
                "provider": provider.identity,
                "font": {
                    "file": font.name,
                    "sha256": hashlib.sha256(font.read_bytes()).hexdigest(),
                },
                "modelCalls": 0,
                "workers": 1,
                "unmeasured": [
                    "legacy-tree",
                    "summary",
                    "expand",
                    "full",
                    "OCR",
                    "real-world-corpus",
                    "model-quality",
                ],
                "results": results,
                "qualityGaps": gaps,
                "qualityGate": "pass" if not gaps else "not-met",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 2 if gaps else 0


if __name__ == "__main__":
    raise SystemExit(main())
