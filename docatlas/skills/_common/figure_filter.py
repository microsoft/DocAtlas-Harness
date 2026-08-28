"""Sanity filter for MinerU sub-images.

Used by Read to decide which figures appear in the metadata catalog and
whether to return pixels for a requested sub-image. Two knobs, both
env-driven so the same filter applies across an eval run for ablation
discipline:

    HARNESS_FIGURE_MIN_SIZE   (default 100)  — both width AND height (px) >=
    HARNESS_FIGURE_MIN_BYTES  (default 2048) — file size (bytes) >=

Failures (corrupt file, PIL can't open) → rejected with reason="unreadable".
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass
class FigureFilter:
    min_size: int
    min_bytes: int

    @classmethod
    def from_env(cls) -> FigureFilter:
        def non_negative_int(name: str, default: int) -> int:
            try:
                return max(0, int(os.getenv(name, str(default))))
            except ValueError:
                return default

        return cls(
            min_size=non_negative_int("HARNESS_FIGURE_MIN_SIZE", 100),
            min_bytes=non_negative_int("HARNESS_FIGURE_MIN_BYTES", 2048),
        )

    def evaluate(self, image_path: str) -> tuple[bool, dict[str, Any]]:
        """Return (keep, info_or_reason).

        keep=True → info has {"size_px":[w,h], "bytes":N}.
        keep=False → info has {"reason": "<why>", ...context}.
        """
        try:
            byte_size = os.stat(image_path).st_size
        except OSError:
            return False, {"reason": "unreadable"}

        try:
            from PIL import Image  # local import keeps cold start cheap

            with Image.open(image_path) as im:
                w, h = im.size
        except Exception:  # noqa: BLE001 — corrupt files raise many things
            return False, {"reason": "unreadable"}

        if w < self.min_size or h < self.min_size:
            return False, {
                "reason": "filtered_by_min_size",
                "size_px": [w, h],
                "min_size": self.min_size,
            }
        if byte_size < self.min_bytes:
            return False, {
                "reason": "filtered_by_min_bytes",
                "bytes": byte_size,
                "min_bytes": self.min_bytes,
            }
        return True, {"size_px": [w, h], "bytes": byte_size}


__all__ = ["FigureFilter"]
