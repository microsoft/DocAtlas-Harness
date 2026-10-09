"""Generated-PDF 2x2 title/cover and adversarial bookmark gate; no model calls."""

from __future__ import annotations

import argparse
import hashlib
import json
import runpy
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from docatlas_dsh_sidecar.document_service import DocumentService
from docatlas_dsh_sidecar.flash_provider import FlashProvider
from docatlas_dsh_sidecar.ingest import DocumentIndexStore
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

ROOT = Path(__file__).resolve().parents[1]
QUALITY = runpy.run_path(str(ROOT / "scripts/evaluate-flash-quality.py"))
BASELINE = {
    item["case"]: item
    for item in json.loads(
        (ROOT / "evals/flash-quality/heading-pairs-baseline.json").read_text()
    )["results"]
}


@dataclass(frozen=True)
class HeadingCase:
    name: str
    chinese: bool
    cover: bool = False
    distinct: bool = False
    bookmark_kind: str = "none"

    @property
    def body_pages(self) -> int:
        return 8 if self.chinese else 16

    @property
    def pages_per_section(self) -> int:
        return self.body_pages // 4

    def title(self, section: int) -> str:
        if self.distinct:
            return (
                "第一章 经营概览",
                "第二章 财务表现",
                "第三章 风险管理",
                "第四章 未来计划",
            )[section]
        return (
            f"第{'一二三四'[section]}章 经营分析与风险审查"
            if self.chinese
            else f"Chapter {section + 1}: Operating analysis and risk review"
        )


CASES = (
    HeadingCase("no-cover-repeated", True),
    HeadingCase("cover-repeated", True, cover=True),
    HeadingCase("no-cover-distinct", True, distinct=True),
    HeadingCase("cover-distinct", True, cover=True, distinct=True),
    *(
        HeadingCase(f"bookmarks-{kind}", False, bookmark_kind=kind)
        for kind in (
            "supported",
            "page-counter",
            "file-counter",
            "missing-source",
            "reversed",
            "duplicate-page",
            "neighbour-only",
        )
    ),
)


def _cover(writer: PdfWriter) -> None:
    page = writer.add_blank_page(612, 792)
    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    stream = DecodedStreamObject()
    stream.set_data(
        b"BT /F1 26 Tf 72 630 Td (Operating Research Collection) Tj ET\n"
        b"BT /F1 12 Tf 72 590 Td (A generated report with four independently numbered chapters.) Tj ET\n"
    )
    page[NameObject("/Contents")] = writer._add_object(stream)


def generate_pair(path: Path, case: HeadingCase, font: Path) -> None:
    class BodyCase(QUALITY["PdfCase"]):
        def title(self, section: int) -> str:
            return case.title(section)

    body = BodyCase(
        "paired", case.body_pages, case.pages_per_section, case.chinese, False
    )
    draw = QUALITY["generate_pdf"].__globals__["_add_text"]

    def draw_with_printed_counter(
        page: Any, document: Any, fonts: Any, text: str, size: int, y: int
    ) -> None:
        draw(page, document, fonts, text, size, y)
        if y == 30 and case.bookmark_kind in {"page-counter", "file-counter"}:
            physical_page = int(text.split("/")[0].strip())
            label = (
                f"Page {physical_page}"
                if case.bookmark_kind == "page-counter"
                else f"file-{physical_page:04d}-2026"
            )
            draw(page, document, fonts, label, 9, 55)

    raw = path.with_suffix(".body.pdf")
    try:
        QUALITY["generate_pdf"].__globals__["_add_text"] = draw_with_printed_counter
        QUALITY["generate_pdf"](raw, body, font)
    finally:
        QUALITY["generate_pdf"].__globals__["_add_text"] = draw
    if not case.cover and case.bookmark_kind == "none":
        raw.rename(path)
        return
    writer = PdfWriter()
    if case.cover:
        _cover(writer)
    for page in PdfReader(raw).pages:
        writer.add_page(page)
    entries = [
        (case.title(index), index * case.pages_per_section) for index in range(4)
    ]
    if case.bookmark_kind == "page-counter":
        entries = [(f"Page {page + 1}", page) for _, page in entries]
    elif case.bookmark_kind == "file-counter":
        entries = [(f"file-{page + 1:04d}-2026", page) for _, page in entries]
    elif case.bookmark_kind == "missing-source":
        entries = [
            (f"Chapter {index + 1}: Unprinted fabricated topic", page)
            for index, (_, page) in enumerate(entries)
        ]
    elif case.bookmark_kind == "reversed":
        entries.reverse()
    elif case.bookmark_kind == "duplicate-page":
        entries[1] = (entries[1][0], entries[0][1])
    elif case.bookmark_kind == "neighbour-only":
        entries = [(title, page + 1) for title, page in entries]
    if case.bookmark_kind != "none":
        for title, page in entries:
            writer.add_outline_item(title, page + int(case.cover))
    writer.write(path)


def evaluate(
    directory: Path, case: HeadingCase, font: Path, provider: FlashProvider
) -> dict[str, Any]:
    directory.mkdir()
    sources = directory / "sources"
    sources.mkdir()
    path = sources / "paired.pdf"
    generate_pair(path, case, font)
    content = path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if case.name in BASELINE:
        assert digest == BASELINE[case.name]["sourceHash"], (
            "Paired source bytes changed since baseline"
        )
    store = DocumentIndexStore({"root:pairs": sources}, directory / "cache")
    ingested = store.ingest(
        {
            "schemaVersion": 1,
            "requestType": "ingest",
            "idempotencyKey": "idempotency:pairs",
            "revision": {
                "schemaVersion": 1,
                "documentId": "doc:pairs",
                "revisionId": "rev:pairs",
                "contentHash": digest,
                "byteLength": len(content),
                "mediaType": "application/pdf",
                "displayName": path.name,
                "origin": {"kind": "local-file"},
                "ingestedAt": "2026-09-09T00:00:00Z",
                "status": "active",
            },
            "sourceBinding": {
                "schemaVersion": 1,
                "bindingId": "binding:pairs",
                "rootId": "root:pairs",
                "relativePath": path.name,
                "expectedContentHash": digest,
                "byteLength": len(content),
                "mediaType": "application/pdf",
            },
            "requestedRepresentationKinds": ["embedded-text"],
            "options": {"forceRebuild": False, "allowOcr": False},
        }
    )
    identity = {
        "documentId": "doc:pairs",
        "revisionId": "rev:pairs",
        "representationId": ingested["representations"][-1]["representationId"],
    }
    service = DocumentService(store)
    config = {"mode": "raw", "useEmbeddedToc": True, "workers": 1}
    generation = provider.generation_id("doc:pairs", "rev:pairs", digest, config)
    tree = provider.build(path.resolve(), digest, generation, config)
    expected = [
        {
            "title": case.title(index),
            "startPage": index * case.pages_per_section + 1 + int(case.cover),
            "endPage": (index + 1) * case.pages_per_section + int(case.cover),
        }
        for index in range(4)
    ]
    pages = {}
    for number in sorted(
        {entry["startPage"] for entry in expected}
        | {node["startPage"] for node in tree.data["nodes"]}
    ):
        read = service.read(
            {
                "schemaVersion": 1,
                "requestType": "read",
                "mode": "page",
                "source": identity,
                "physicalPage": number,
                "limits": {"maxItems": 100, "maxChars": 20000},
            }
        )
        assert not read["pageInfo"]["truncated"]
        pages[number] = [item["text"] for item in read["items"]]
    normalize = lambda value: " ".join(value.split())
    assert all(
        any(
            normalize(entry["title"]) == normalize(text)
            for text in pages[entry["startPage"]]
        )
        for entry in expected
    )
    covered = sum(
        any(
            node["title"] == entry["title"]
            and node["startPage"] <= entry["startPage"]
            and node["endPage"] >= entry["endPage"]
            for node in tree.data["nodes"]
        )
        for entry in expected
    )
    supported = all(
        any(
            normalize(node["title"]) == normalize(text)
            for text in pages[node["startPage"]]
        )
        for node in tree.data["nodes"]
    )
    expected_toc = "hybrid" if case.bookmark_kind == "supported" else "detected"
    gaps = []
    if covered != 4:
        gaps.append("section-coverage")
    if not supported:
        gaps.append("unprinted-navigation-title")
    if tree.toc_source != expected_toc:
        gaps.append("bookmark-admission")
    return {
        "case": case.name,
        "cover": case.cover,
        "distinctTitles": case.distinct,
        "bookmarkKind": case.bookmark_kind,
        "sourceHash": digest,
        "pages": tree.data["pageCount"],
        "coveredSections": covered,
        "expectedSections": 4,
        "tocSource": tree.toc_source,
        "allNodeTitlesOnExactSourcePage": supported,
        "qualityGaps": gaps,
        "nodes": [
            {key: node[key] for key in ("title", "startPage", "endPage")}
            for node in tree.data["nodes"]
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--font",
        type=Path,
        default=QUALITY["DEFAULT_FONT"],
        help="Local CJK TTF; paired source hashes must reproduce the recorded baseline",
    )
    parser.add_argument(
        "--case", action="append", choices=[case.name for case in CASES]
    )
    args = parser.parse_args()
    provider = FlashProvider()
    with tempfile.TemporaryDirectory(prefix="docatlas-heading-pairs-") as temporary:
        results = [
            evaluate(Path(temporary) / case.name, case, args.font, provider)
            for case in CASES
            if args.case is None or case.name in args.case
        ]
    gaps = [
        f"{result['case']}:{gap}" for result in results for gap in result["qualityGaps"]
    ]
    print(
        json.dumps(
            {
                "schemaVersion": 1,
                "corpus": "generated-heading-pairs.v1",
                "provider": provider.identity,
                "modelCalls": 0,
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
