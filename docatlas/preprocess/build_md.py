"""Build per-page Markdown for PDFs using Docling.

This task fills DocAtlas's PDF→markdown preprocessing slot. It produces
output that the harness `Read` skill consumes via
`docatlas/skills/_common/markdown_reader.py`:

    output_dir/
      <doc_stem>/
        <doc_stem>_page0/                    # 0-based page index
          vlm/
            <doc_stem>_page0.md              # page markdown text
            images/                          # figures on this page
              picture-1.png
              picture-2.png
        <doc_stem>_page1/
          vlm/
            <doc_stem>_page1.md
            ...

Why Docling and not MinerU?

  NOTE: The paper's benchmark numbers were produced with **MinerU 2.5**.
  This Docling backend is a low-resource convenience path so the pipeline
  runs end-to-end on a CPU-only box; its markdown is lower-fidelity on
  dense tables/formulas and will NOT match the reported results. To
  reproduce, run MinerU 2.5 and point --markdown-dir at its output.

  - **Docling** is installed from the checked-in uv lockfile and runs on CPU,
    runtime by default, ~2 GB of HF-hosted weights pulled on first use,
    no GPU required, MIT licensed. Great for getting `--markdown-dir`
    coverage on a new dataset in minutes without provisioning a GPU box.
    Not what the paper used — expect different (lower) benchmark numbers.
  - **MinerU 2.5** is heavier but more accurate on dense layouts (multi-column
    scientific papers, complex tables, formula-heavy pages). This is the
    extractor behind the reported results — use it whenever benchmark
    numbers matter; use Docling only for fast bootstrapping.

Both write the same on-disk layout, so swapping backends doesn't require
any changes downstream.

Usage::

    # Single PDF
    uv run --locked harness build-md --pdf doc.pdf --output-dir markdown/

    # Batch over a directory
    uv run --locked harness build-md --pdf-dir data/MMLongBench/documents \\
                               --output-dir data/MMLongBench/markdown \\
                               --limit 5

    # With image extraction off (text-only fast path)
    uv run --locked harness build-md --pdf doc.pdf --output-dir markdown/ \\
                               --no-images
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

from ._io import atomic_write_json

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Docling import is lazy so `harness --help` works before the environment is synced.
# on a fresh checkout that hasn't installed docling yet.
# ---------------------------------------------------------------------------


def _import_docling():
    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling_core.types.doc import PictureItem
    except ImportError as e:
        raise SystemExit(
            "error: docling is not installed in the active Python.\n"
            "       Install the locked environment with: uv sync --locked\n"
            f"       (underlying error: {e})"
        )
    return {
        "InputFormat": InputFormat,
        "PdfPipelineOptions": PdfPipelineOptions,
        "DocumentConverter": DocumentConverter,
        "PdfFormatOption": PdfFormatOption,
        "PictureItem": PictureItem,
    }


# ---------------------------------------------------------------------------
# Document discovery (mirrors build_tree._discover_documents)
# ---------------------------------------------------------------------------


def _discover_documents(args: argparse.Namespace) -> list[dict]:
    if getattr(args, "pdf", None):
        p = os.path.abspath(args.pdf)
        if not os.path.isfile(p):
            return []
        return [{"doc_id": os.path.basename(p), "pdf_path": p, "sampled": True}]

    pdf_dir = getattr(args, "pdf_dir", None)
    if not pdf_dir or not os.path.isdir(pdf_dir):
        return []

    all_pdfs: dict[str, str] = {}
    for f in sorted(os.listdir(pdf_dir)):
        if f.lower().endswith(".pdf"):
            all_pdfs[f] = os.path.join(pdf_dir, f)

    sampled_docs: set[str] = set()
    samples_file = getattr(args, "samples_file", None)
    if samples_file and os.path.isfile(samples_file):
        with open(samples_file, encoding="utf-8") as fh:
            samples = json.load(fh)
        if isinstance(samples, dict) and "results" in samples:
            samples = samples["results"]
        sampled_docs = {
            s.get("doc_id", "") for s in samples if isinstance(s, dict) and s.get("doc_id")
        }

    docs: list[dict] = []
    for doc_id, pdf_path in all_pdfs.items():
        is_sampled = doc_id in sampled_docs
        if getattr(args, "only_sampled", False) and not is_sampled:
            continue
        docs.append({"doc_id": doc_id, "pdf_path": pdf_path, "sampled": is_sampled})

    doc_filter = getattr(args, "doc_filter", None)
    if doc_filter:
        patterns = [p.strip().lower() for p in doc_filter.split(",")]
        docs = [d for d in docs if any(p in d["doc_id"].lower() for p in patterns)]

    start = getattr(args, "start", 0)
    limit = getattr(args, "limit", 0)
    if start > 0:
        docs = docs[start:]
    if limit > 0:
        docs = docs[:limit]

    return docs


def _doc_already_built(output_dir: str, doc_stem: str, pdf_path: str) -> bool:
    """Return True only when every PDF page has generated Markdown."""
    pattern = os.path.join(output_dir, doc_stem, f"{doc_stem}_page*", "vlm", f"{doc_stem}_page*.md")
    try:
        from pypdf import PdfReader

        expected_pages = len(PdfReader(pdf_path).pages)
    except Exception:  # noqa: BLE001
        return False
    discovered = glob.glob(pattern)
    if len(discovered) != expected_pages:
        return False
    expected = [
        os.path.join(
            output_dir,
            doc_stem,
            f"{doc_stem}_page{index}",
            "vlm",
            f"{doc_stem}_page{index}.md",
        )
        for index in range(expected_pages)
    ]
    return all(os.path.isfile(path) for path in expected)


# ---------------------------------------------------------------------------
# Per-page builder
# ---------------------------------------------------------------------------


def _serialize_item_markdown(item, doc) -> str:
    """Render a single Docling content item as a markdown fragment.

    We can't just call `doc.export_to_markdown(item=...)` per-item without
    knowing internal helpers, so we render lightweight markdown for the
    common item types. For text-like items we use `item.text`. For images
    we emit an image link (the caller writes the actual PNG). Tables emit
    HTML (Docling's native table representation), falling back to a
    `[Table]` placeholder if we can't get markup.
    """
    # Text-like items have .text directly.
    text = getattr(item, "text", None)
    if isinstance(text, str) and text.strip():
        # Use heading markers if Docling tagged the item as a heading.
        label = getattr(item, "label", "")
        label_str = str(label) if label is not None else ""
        if "title" in label_str.lower() or "section_header" in label_str.lower():
            level = getattr(item, "level", 1) or 1
            prefix = "#" * max(1, min(int(level), 6))
            return f"{prefix} {text.strip()}\n\n"
        return text.strip() + "\n\n"

    # Tables: prefer HTML which Docling produces natively.
    try:
        from docling_core.types.doc import TableItem  # noqa: PLC0415

        if isinstance(item, TableItem):
            try:
                html = item.export_to_html(doc=doc)  # type: ignore[attr-defined]
                if html:
                    return html.strip() + "\n\n"
            except Exception:  # noqa: BLE001
                logger.debug("Could not export table HTML", exc_info=True)
            return "[Table]\n\n"
    except Exception:  # noqa: BLE001
        logger.debug("Could not serialize Docling item", exc_info=True)

    return ""


def _build_single(
    pdf_path: str,
    output_dir: str,
    args: argparse.Namespace,
    docling_mods: dict,
) -> dict:
    """Build per-page markdown for one PDF. Returns a result dict."""
    InputFormat = docling_mods["InputFormat"]
    PdfPipelineOptions = docling_mods["PdfPipelineOptions"]
    DocumentConverter = docling_mods["DocumentConverter"]
    PdfFormatOption = docling_mods["PdfFormatOption"]
    PictureItem = docling_mods["PictureItem"]

    t0 = time.time()
    doc_stem = os.path.splitext(os.path.basename(pdf_path))[0]
    doc_root = os.path.join(output_dir, doc_stem)
    staging_root: str | None = None
    backup_root: str | None = None

    try:
        opts = PdfPipelineOptions()
        opts.images_scale = float(args.images_scale)
        opts.generate_page_images = False
        opts.generate_picture_images = bool(args.images)
        if hasattr(opts, "do_ocr"):
            opts.do_ocr = bool(args.ocr)

        converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=opts),
            }
        )

        conv_res = converter.convert(pdf_path)
        doc = conv_res.document

        # Buckets keyed by 0-based page index.
        page_md_chunks: dict[int, list[str]] = {}
        page_picture_counter: dict[int, int] = {}
        page_pictures: dict[int, list] = {}  # (item, target_filename)

        # First pass: walk items in reading order, accrete per-page markdown
        # and remember which figures live on which page.
        for item, _level in doc.iterate_items():
            prov_list = getattr(item, "prov", []) or []
            if not prov_list:
                continue
            page_no_raw = getattr(prov_list[0], "page_no", None)
            if page_no_raw is None:
                continue
            # Docling page_no is 1-based; we want 0-based on disk to match
            # MinerU / MMLongBench convention.
            page_idx = int(page_no_raw) - 1
            chunks = page_md_chunks.setdefault(page_idx, [])

            if isinstance(item, PictureItem) and args.images:
                page_picture_counter[page_idx] = page_picture_counter.get(page_idx, 0) + 1
                pn = page_picture_counter[page_idx]
                rel_name = f"picture-{pn}.png"
                page_pictures.setdefault(page_idx, []).append((item, rel_name))
                chunks.append(f"![](images/{rel_name})\n\n")
                continue

            md_frag = _serialize_item_markdown(item, doc)
            if md_frag:
                chunks.append(md_frag)

        # Ensure every page has at least an entry, even if the page is empty.
        for page_no in doc.pages:
            idx = int(page_no) - 1
            page_md_chunks.setdefault(idx, [])
            page_picture_counter.setdefault(idx, 0)

        # Write into a staging directory and replace the old output only when
        # every page has been completed successfully.
        os.makedirs(output_dir, exist_ok=True)
        staging_root = tempfile.mkdtemp(prefix=f".{doc_stem}.building-", dir=output_dir)

        pages_written = 0
        images_written = 0
        for page_idx in sorted(page_md_chunks):
            page_dir = os.path.join(
                staging_root,
                f"{doc_stem}_page{page_idx}",
                "vlm",
            )
            os.makedirs(page_dir, exist_ok=True)

            md_text = "".join(page_md_chunks[page_idx]).rstrip() + "\n"
            md_path = os.path.join(page_dir, f"{doc_stem}_page{page_idx}.md")
            with open(md_path, "w", encoding="utf-8") as fh:
                fh.write(md_text)
            pages_written += 1

            if args.images and page_pictures.get(page_idx):
                images_dir = os.path.join(page_dir, "images")
                os.makedirs(images_dir, exist_ok=True)
                for item, rel_name in page_pictures[page_idx]:
                    try:
                        pil_img = item.get_image(doc)
                        if pil_img is not None:
                            pil_img.save(
                                os.path.join(images_dir, rel_name),
                                "PNG",
                            )
                            images_written += 1
                    except Exception:  # noqa: BLE001
                        # Don't crash a whole doc because one figure failed.
                        logger.warning("Could not export figure %s", rel_name, exc_info=True)

        if os.path.isdir(doc_root):
            backup_root = f"{doc_root}.previous-{uuid.uuid4().hex}"
            os.replace(doc_root, backup_root)
        try:
            os.replace(staging_root, doc_root)
            staging_root = None
        except Exception:
            if backup_root and os.path.isdir(backup_root):
                os.replace(backup_root, doc_root)
                backup_root = None
            raise
        if backup_root and os.path.isdir(backup_root):
            shutil.rmtree(backup_root, ignore_errors=True)
            backup_root = None

        return {
            "success": True,
            "output_dir": doc_root,
            "pages_written": pages_written,
            "images_written": images_written,
            "latency_s": time.time() - t0,
            "error": None,
        }

    except Exception as e:  # noqa: BLE001
        if staging_root and os.path.isdir(staging_root):
            shutil.rmtree(staging_root, ignore_errors=True)
        if backup_root and os.path.isdir(backup_root) and not os.path.exists(doc_root):
            os.replace(backup_root, doc_root)
        return {
            "success": False,
            "output_dir": doc_root,
            "pages_written": 0,
            "images_written": 0,
            "latency_s": time.time() - t0,
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        }


# ---------------------------------------------------------------------------
# Task class
# ---------------------------------------------------------------------------


class BuildMdTask:
    """``build-md`` subcommand — produce per-page markdown via Docling."""

    @staticmethod
    def add_arguments(parser: argparse.ArgumentParser) -> None:
        # Input
        g = parser.add_mutually_exclusive_group(required=True)
        g.add_argument("--pdf", help="Single PDF path.")
        g.add_argument("--pdf-dir", help="Directory of PDFs for batch build.")
        parser.add_argument(
            "--output-dir",
            required=True,
            help="Output markdown root. Each PDF becomes <doc_stem>/ inside it.",
        )

        # Docling pipeline knobs
        parser.add_argument(
            "--images",
            action="store_true",
            default=True,
            help="Extract figure PNG files (default).",
        )
        parser.add_argument(
            "--no-images",
            dest="images",
            action="store_false",
            help="Skip figure extraction (text-only, faster).",
        )
        parser.add_argument(
            "--images-scale",
            type=float,
            default=2.0,
            help="Image resolution multiplier (default 2.0 → ~144 DPI).",
        )
        parser.add_argument(
            "--ocr",
            action="store_true",
            default=False,
            help="Enable OCR fallback for image-only PDFs (slower).",
        )

        # Batch control
        parser.add_argument(
            "--force",
            action="store_true",
            help="Rebuild even if at least one page md already exists.",
        )
        parser.add_argument("--doc-filter", help="Comma-separated substrings to filter doc names.")
        parser.add_argument("--start", type=int, default=0)
        parser.add_argument("--limit", type=int, default=0)
        parser.add_argument("--samples-file", help="samples.json to limit to sampled docs.")
        parser.add_argument(
            "--only-sampled",
            action="store_true",
            help="With --samples-file, skip PDFs not in samples.json.",
        )

    @staticmethod
    def run(args: argparse.Namespace) -> int:
        if args.images_scale <= 0:
            print("error: --images-scale must be greater than zero", file=sys.stderr)
            return 2
        if args.start < 0 or args.limit < 0:
            print("error: --start and --limit must be non-negative", file=sys.stderr)
            return 2

        docling_mods = _import_docling()

        docs = _discover_documents(args)
        if not docs:
            print("No documents found to build.", file=sys.stderr)
            return 1

        output_dir = os.path.abspath(args.output_dir)
        os.makedirs(output_dir, exist_ok=True)

        skipped: list[str] = []
        if not args.force:
            kept: list[dict] = []
            for d in docs:
                stem = os.path.splitext(d["doc_id"])[0]
                if _doc_already_built(output_dir, stem, d["pdf_path"]):
                    skipped.append(d["doc_id"])
                else:
                    kept.append(d)
            docs = kept

        print("=" * 60)
        print("  DocAtlas · Build-MD (Docling backend)")
        print("=" * 60)
        print(f"  Output dir       : {output_dir}")
        print("  Backend          : docling (lightweight)")
        print(f"  Images           : {'on' if args.images else 'off'} (scale={args.images_scale}x)")
        print(f"  OCR              : {'on' if args.ocr else 'off'}")
        print(f"  Documents        : {len(docs)} to build, {len(skipped)} skipped")
        print("=" * 60)

        log: dict[str, Any] = {
            "config": {
                "backend": "docling",
                "images": bool(args.images),
                "images_scale": float(args.images_scale),
                "ocr": bool(args.ocr),
            },
            "started_at": datetime.now(timezone.utc).isoformat(),
            "results": [],
        }
        log_path = os.path.join(output_dir, "build_md_log.json")

        success = 0
        failed = 0
        for i, d in enumerate(docs, 1):
            print(f"  [{i}/{len(docs)}] {d['doc_id']} ... ", end="", flush=True)
            res = _build_single(d["pdf_path"], output_dir, args, docling_mods)
            res.update(
                {
                    "doc_id": d["doc_id"],
                    "sampled": d["sampled"],
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )
            log["results"].append(res)
            atomic_write_json(log_path, log)

            if res["success"]:
                success += 1
                print(
                    f"OK  pages={res['pages_written']}  "
                    f"images={res['images_written']}  "
                    f"({res['latency_s']:.1f}s)"
                )
            else:
                failed += 1
                print(f"FAIL  ({res['latency_s']:.1f}s)  {res['error']}")

        print()
        print("=" * 60)
        print(
            f"  Done: {success} success, {failed} failed, "
            f"{len(docs)} total ({len(skipped)} skipped)"
        )
        print(f"  Output: {output_dir}")
        print(f"  Log:    {log_path}")
        print("=" * 60)
        return 0 if failed == 0 else 1
