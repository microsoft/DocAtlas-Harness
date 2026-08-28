from __future__ import annotations

import pytest

from docatlas.skills.read.scripts.run import _parse_pages


def test_parse_pages_preserves_order_and_deduplicates() -> None:
    assert _parse_pages("3,1-2,2") == [3, 1, 2]


@pytest.mark.parametrize("value", ["0", "4-2", "one", "1--3"])
def test_parse_pages_rejects_invalid_expressions(value: str) -> None:
    with pytest.raises(ValueError):
        _parse_pages(value)


def test_parse_pages_rejects_oversized_range(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_MAX_PAGES_PER_READ", "5")
    with pytest.raises(ValueError, match="safety limit"):
        _parse_pages("1-6")
