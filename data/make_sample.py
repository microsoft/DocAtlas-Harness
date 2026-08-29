#!/usr/bin/env python3
"""Generate a small, fully self-authored sample document for demos and smoke tests.

Produces artifacts under this directory:

  sample_report.pdf                       — a 6-page fictional report (2025)
  sample_report_markdown/                 — generated per-page markdown
      sample_report/
        sample_report_page{0..5}/vlm/
          sample_report_page{N}.md
          images/                         # figure PNG(s), where present
  sample_report_prior.pdf                 — a 2024 prior-year variant, so the
                                            multi-doc demo has a default pair

The markdown layout mirrors the on-disk shape that `docatlas build-md`
emits and that `docatlas/skills/_common/markdown_reader.py` consumes, so the
sample exercises Read's markdown mode (page 2 has a real table) and its
figure path (page 4 has a chart) without needing Docling/MinerU.

Content is invented for this repo (a fictional "Annual Widget Report
2025") and is freely redistributable. Regenerate with:

    uv run --locked python data/make_sample.py

Requires PyMuPDF (installed via the project's deps).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import fitz  # PyMuPDF

HERE = Path(__file__).resolve().parent
DOC_ID = "sample_report"
PDF_PATH = HERE / f"{DOC_ID}.pdf"
MD_ROOT = HERE / f"{DOC_ID}_markdown" / DOC_ID

# (heading, body-lines) per physical page (1-based order).
PAGES = [
    (
        "Executive Summary",
        [
            "Annual Widget Report 2025",
            "",
            "This report summarizes the annual performance of the Widget",
            "division. It covers financial highlights, regional performance,",
            "market share, the product roadmap, and the outlook for 2026.",
        ],
    ),
    (
        "Financial Highlights",
        [
            "Quarterly revenue grew steadily through 2025, as shown below.",
        ],
    ),  # table drawn separately
    (
        "Regional Performance",
        [
            "The North region contributed the largest share of revenue,",
            "followed by the East and South regions. The West region grew",
            "fastest year over year, driven by new distribution partners.",
        ],
    ),
    (
        "Market Share",
        [
            "Estimated 2025 market share by segment is shown in the chart.",
        ],
    ),  # figure drawn separately
    (
        "Product Roadmap",
        [
            "Planned 2026 milestones:",
            "  - Widget Pro launch in Q1",
            "  - Expanded API access in Q2",
            "  - Regional data centers in Q3",
        ],
    ),
    (
        "Outlook and Conclusion",
        [
            "The division expects continued growth in 2026, supported by the",
            "product roadmap and stronger regional coverage. Risks include",
            "supply variability and competitive pricing pressure.",
        ],
    ),
]

TABLE_ROWS = [
    ("Quarter", "Revenue (USD M)", "Growth"),
    ("Q1", "12.3", "+4%"),
    ("Q2", "13.1", "+7%"),
    ("Q3", "14.0", "+7%"),
    ("Q4", "15.2", "+9%"),
]

CHART_BARS = [("Widget", 45), ("Gadget", 30), ("Gizmo", 15), ("Other", 10)]


def _draw_table(page: fitz.Page, x: float, y: float, rows) -> None:
    row_h, col_w = 26, 150
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            rect = fitz.Rect(x + c * col_w, y + r * row_h, x + (c + 1) * col_w, y + (r + 1) * row_h)
            page.draw_rect(rect, color=(0.4, 0.4, 0.4), width=0.8)
            page.insert_text((rect.x0 + 6, rect.y0 + 17), cell, fontsize=11, fontname="helv")


def _draw_chart(page: fitz.Page, x: float, y: float) -> None:
    """Draw a simple horizontal bar chart onto *page*."""
    bar_h, gap, scale = 22, 14, 3.2
    for i, (label, val) in enumerate(CHART_BARS):
        top = y + i * (bar_h + gap)
        rect = fitz.Rect(x + 90, top, x + 90 + val * scale, top + bar_h)
        page.draw_rect(rect, color=(0.15, 0.3, 0.55), fill=(0.2, 0.45, 0.75))
        page.insert_text((x, top + 16), label, fontsize=11, fontname="helv")
        page.insert_text((rect.x1 + 6, top + 16), f"{val}%", fontsize=11, fontname="helv")


def _save_chart_png(path: Path) -> None:
    """Render a standalone PNG of the same chart for the markdown figure."""
    doc = fitz.open()
    page = doc.new_page(width=320, height=200)
    _draw_chart(page, 20, 20)
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
    path.parent.mkdir(parents=True, exist_ok=True)
    pix.save(str(path))
    doc.close()


def build_pdf(path: Path, pages, table_rows, title: str) -> None:
    doc = fitz.open()
    for idx, (heading, lines) in enumerate(pages):
        page = doc.new_page(width=595, height=842)  # A4
        head = f"{heading} ({title})" if idx == 0 else heading
        page.insert_text((72, 90), head, fontsize=20, fontname="hebo")
        y = 130
        for line in lines:
            page.insert_text((72, y), line, fontsize=12, fontname="helv")
            y += 20
        if heading == "Financial Highlights":
            _draw_table(page, 72, y + 10, table_rows)
        if heading == "Market Share":
            _draw_chart(page, 90, y + 20)
    doc.save(str(path))
    doc.close()
    print(f"wrote {path}")


# 2024 prior-year variant (lower revenue) so the multi-doc demo has a pair.
TABLE_ROWS_PRIOR = [
    ("Quarter", "Revenue (USD M)", "Growth"),
    ("Q1", "10.8", "+2%"),
    ("Q2", "11.2", "+4%"),
    ("Q3", "11.9", "+6%"),
    ("Q4", "12.6", "+6%"),
]


def build_markdown() -> None:
    for idx, (heading, lines) in enumerate(PAGES):
        vlm = MD_ROOT / f"{DOC_ID}_page{idx}" / "vlm"
        vlm.mkdir(parents=True, exist_ok=True)
        body = [f"# {heading}", ""]
        body += [ln for ln in lines if ln and not ln.startswith("Annual Widget")]
        if heading == "Financial Highlights":
            body += ["", "| Quarter | Revenue (USD M) | Growth |", "|---|---|---|"]
            body += [f"| {q} | {rev} | {g} |" for q, rev, g in TABLE_ROWS[1:]]
        if heading == "Market Share":
            _save_chart_png(vlm / "images" / "market_share.png")
            body += ["", "![](images/market_share.png)", "", "The Widget segment leads at 45%."]
        (vlm / f"{DOC_ID}_page{idx}.md").write_text("\n".join(body) + "\n", encoding="utf-8")
    print(f"wrote {MD_ROOT}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Regenerate DocAtlas's sample PDF fixtures.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the generated sample artifacts.",
    )
    args = parser.parse_args(argv)
    prior_pdf = HERE / f"{DOC_ID}_prior.pdf"
    outputs = [PDF_PATH, prior_pdf, MD_ROOT]
    if not args.force and all(path.exists() for path in outputs):
        print("Sample fixtures already exist; pass --force to regenerate them.")
        return 0

    if args.force or not PDF_PATH.exists():
        build_pdf(PDF_PATH, PAGES, TABLE_ROWS, "2025")
    if args.force or not MD_ROOT.exists():
        build_markdown()
    if args.force or not prior_pdf.exists():
        build_pdf(prior_pdf, PAGES, TABLE_ROWS_PRIOR, "2024")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
