"""Unit tests for FigureFilter — pure module, no I/O of its own beyond stat+PIL.open."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from docatlas.skills._common.figure_filter import FigureFilter


def _write_png(path: Path, w: int, h: int, color=(255, 0, 0)) -> None:
    img = Image.new("RGB", (w, h), color)
    img.save(path, "PNG")


def test_keep_when_above_thresholds(tmp_path: Path):
    p = tmp_path / "ok.png"
    _write_png(p, 200, 200)
    # padding bytes large enough to clear min_bytes=2048
    with open(p, "ab") as f:
        f.write(b"\x00" * 4096)
    f = FigureFilter(min_size=100, min_bytes=2048)
    keep, info = f.evaluate(str(p))
    assert keep is True
    assert info["size_px"] == [200, 200]
    assert info["bytes"] >= 2048


def test_reject_when_too_small(tmp_path: Path):
    p = tmp_path / "small.png"
    _write_png(p, 50, 50)
    f = FigureFilter(min_size=100, min_bytes=0)
    keep, info = f.evaluate(str(p))
    assert keep is False
    assert info["reason"] == "filtered_by_min_size"
    assert info["size_px"] == [50, 50]
    assert info["min_size"] == 100


def test_reject_when_too_few_bytes(tmp_path: Path):
    p = tmp_path / "tiny.png"
    _write_png(p, 200, 200)  # PNG of solid color is small
    f = FigureFilter(min_size=0, min_bytes=10_000_000)
    keep, info = f.evaluate(str(p))
    assert keep is False
    assert info["reason"] == "filtered_by_min_bytes"
    assert "bytes" in info
    assert info["min_bytes"] == 10_000_000


def test_reject_when_unreadable(tmp_path: Path):
    p = tmp_path / "broken.png"
    p.write_bytes(b"not a real png")
    f = FigureFilter(min_size=0, min_bytes=0)
    keep, info = f.evaluate(str(p))
    assert keep is False
    assert info["reason"] == "unreadable"


def test_from_env_defaults(monkeypatch):
    monkeypatch.delenv("HARNESS_FIGURE_MIN_SIZE", raising=False)
    monkeypatch.delenv("HARNESS_FIGURE_MIN_BYTES", raising=False)
    f = FigureFilter.from_env()
    assert f.min_size == 100
    assert f.min_bytes == 2048


def test_from_env_overrides(monkeypatch):
    monkeypatch.setenv("HARNESS_FIGURE_MIN_SIZE", "300")
    monkeypatch.setenv("HARNESS_FIGURE_MIN_BYTES", "5000")
    f = FigureFilter.from_env()
    assert f.min_size == 300
    assert f.min_bytes == 5000
