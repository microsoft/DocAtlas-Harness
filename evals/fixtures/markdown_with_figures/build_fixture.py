"""Idempotently rebuild the markdown_with_figures fixture.

Layout produced (matches MinerU's per-page output):

  evals/fixtures/markdown_with_figures/
    mini_doc/
      mini_doc_page0/vlm/mini_doc_page0.md     (no images)
      mini_doc_page1/vlm/mini_doc_page1.md     (2 charts)
      mini_doc_page1/vlm/images/chart_a.png    (120x120, RGB noise; >min_size, >min_bytes)
      mini_doc_page1/vlm/images/chart_b.png    (150x120, RGB noise; >min_size, >min_bytes)
      mini_doc_page2/vlm/mini_doc_page2.md     (1 logo)
      mini_doc_page2/vlm/images/logo.png       (60x60 → filtered by min_size)
"""
from __future__ import annotations

import random
import shutil
from pathlib import Path
from PIL import Image


HERE = Path(__file__).resolve().parent
DOC = HERE / "mini_doc"


def _noisy(w: int, h: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
    return img


def _solid(w: int, h: int, color=(120, 120, 120)) -> Image.Image:
    return Image.new("RGB", (w, h), color)


def _write_page(page_idx: int, md_text: str, images: dict[str, Image.Image]) -> None:
    vlm = DOC / f"mini_doc_page{page_idx}" / "vlm"
    img_dir = vlm / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for name, im in images.items():
        im.save(img_dir / name, "PNG")
    (vlm / f"mini_doc_page{page_idx}.md").write_text(md_text, encoding="utf-8")


def build() -> None:
    if DOC.exists():
        # Idempotent rebuild — wipe and recreate so contents are deterministic.
        shutil.rmtree(DOC)
    DOC.mkdir(parents=True)

    _write_page(0, "# Page One\n\nNo figures here, just text.\n", {})

    _write_page(
        1,
        "# Page Two\n\nFirst chart:\n\n![](images/chart_a.png)\n\n"
        "Second chart:\n\n![](images/chart_b.png)\n",
        {
            "chart_a.png": _noisy(120, 120, seed=1),
            "chart_b.png": _noisy(150, 120, seed=2),
        },
    )

    _write_page(
        2,
        "# Page Three\n\nCompany logo:\n\n![](images/logo.png)\n",
        {"logo.png": _solid(60, 60)},
    )

    print(f"built fixture at {DOC}")


if __name__ == "__main__":
    build()
