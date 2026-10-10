"""Offline dependency-regression measurements over the two public sample PDFs.

Run in each locked environment with ``uv run --locked python
scripts/benchmark_cli.py --output /tmp/report.json [--docling]``. Compare input
and output hashes before interpreting timings; no real-model quality or timing
equivalence is implied. Docling uses cached weights only, with the normal
images-on/OCR-off settings on four CPU threads. Outputs never touch the corpus.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from docatlas.skills._common.pdf_image import render_pages_to_base64
from docatlas.skills._common.pdf_text import get_pages_text, page_count

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = (
    "anyio",
    "azure-identity",
    "docling",
    "docling-core",
    "docling-ibm-models",
    "docling-parse",
    "docling-slim",
    "fsspec",
    "openai",
    "opencv-python",
    "opencv-python-headless",
    "pillow",
    "pypdf",
    "pymupdf",
    "pyjwt",
    "rapidocr",
    "torch",
    "transformers",
    "urllib3",
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def package_version(name: str) -> str | None:
    # OpenCV's wheel name changed upstream; preserve absent packages as evidence.
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def measure(operation, repeats: int) -> dict[str, Any]:
    """Include the first run explicitly; require deterministic observable results."""
    if repeats < 1:
        raise ValueError("repeat count must be positive")
    samples = []
    result = None
    for _ in range(repeats):
        start = time.perf_counter()
        current = operation()
        samples.append(time.perf_counter() - start)
        if len(samples) > 1 and current != result:
            raise ValueError("non-deterministic output; timing comparison is not valid")
        result = current
    return {
        "result": result,
        "seconds": samples,
        "median_seconds": statistics.median(samples),
        "warm_median_seconds": statistics.median(samples[1:]) if repeats > 1 else None,
    }


def read_pdf(path: Path) -> dict[str, Any]:
    count = page_count(str(path))
    text, missing = get_pages_text(str(path), list(range(1, count + 1)))
    return {
        "pages": count,
        "missing": missing,
        "text_sha256": {str(p): digest(t.encode()) for p, t in text.items()},
        "text_chars": {str(p): len(t) for p, t in text.items()},
    }


def render_pdf(path: Path) -> dict[str, str]:
    return {
        str(p): digest(base64.b64decode(data))
        for p, data in render_pages_to_base64(str(path), [1, 2, 4, 6])
    }


def convert_pdf(path: Path, modules: dict) -> dict[str, Any]:
    from docatlas.preprocess.build_md import _build_single

    with tempfile.TemporaryDirectory(prefix="docatlas-cli-benchmark-") as output:
        result = _build_single(
            str(path),
            output,
            argparse.Namespace(images=True, images_scale=2.0, ocr=False),
            modules,
        )
        if not result["success"]:
            raise RuntimeError(result["error"])
        files = {
            p.relative_to(output).as_posix(): digest(p.read_bytes())
            for p in sorted(Path(output).rglob("*"))
            if p.is_file()
        }
        return {
            "pages_written": result["pages_written"],
            "images_written": result["images_written"],
            "files_sha256": files,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--docling", action="store_true")
    parser.add_argument("--docling-repeats", type=int, default=2)
    args = parser.parse_args()
    if args.repeats < 1 or args.docling_repeats < 1:
        parser.error("repeat counts must be positive")
    # No downloads, telemetry, or accidental GPU contention during the benchmark.
    os.environ.update(
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1",
        CUDA_VISIBLE_DEVICES="",
        DOCLING_DEVICE="cpu",
        DOCLING_NUM_THREADS="4",
    )
    report: dict[str, Any] = {
        "schema": "docatlas-cli-regression.v1",
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": {p: package_version(p) for p in PACKAGES},
        "fixture_sha256": {},
        "measurements": {},
    }
    # Exclusive creation prevents replacing another run's evidence.
    with args.output.open("x", encoding="utf-8") as output:
        measurements = report["measurements"]
        for command in ([], ["build-md"], ["build-tree"], ["chat"]):

            def help_output(command=command):
                run = subprocess.run(
                    [sys.executable, "-m", "docatlas", *command, "--help"],
                    cwd=ROOT,
                    capture_output=True,
                    check=True,
                    timeout=60,
                )
                return {"stdout_sha256": digest(run.stdout), "stderr_sha256": digest(run.stderr)}

            measurements["help:" + "/".join(command)] = measure(help_output, args.repeats)
        for name in ("sample_report.pdf", "sample_report_prior.pdf"):
            path = ROOT / "data" / name
            report["fixture_sha256"][name] = digest(path.read_bytes())
            measurements[f"read:{name}"] = measure(lambda: read_pdf(path), args.repeats)
            measurements[f"render:{name}"] = measure(lambda: render_pdf(path), args.repeats)
        if args.docling:
            from docatlas.preprocess.build_md import _import_docling

            start = time.perf_counter()
            modules = _import_docling()
            report["docling_import_seconds"] = time.perf_counter() - start
            report["docling_settings"] = {
                "images": True,
                "images_scale": 2.0,
                "ocr": False,
                "device": "cpu",
                "num_threads": 4,
            }
            for name in ("sample_report.pdf", "sample_report_prior.pdf"):
                path = ROOT / "data" / name
                measurements[f"docling:{name}"] = measure(
                    lambda: convert_pdf(path, modules), args.docling_repeats
                )
        json.dump(report, output, indent=2, sort_keys=True)
        output.write("\n")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
