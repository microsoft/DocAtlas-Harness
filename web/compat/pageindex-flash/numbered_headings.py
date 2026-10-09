"""Reviewed DocAtlas navigation guards; stdlib-only, no I/O or tree synthesis.

This source is mechanically copied into the finite Flash vendor. Do not edit
the generated copy. It only keeps source-backed numbered sections eligible for
the existing detector and admits a narrowly supported bookmark exception.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from itertools import pairwise
from typing import Any

_ENGLISH = re.compile(
    r"^(chapter|part|section|book|appendix|unit|lesson)\s+([1-9][0-9]{0,3})"
    r"(?:(?:\s*[:.\-–—]\s*|\s+)(\S.*))?$",
    re.IGNORECASE,
)
_CHINESE = re.compile(
    r"^第([0-9零〇一二三四五六七八九十百千两]{1,12})(章|部|节|篇|卷)[\s:：、.．\-–—]*(.*)$"
)
_DIGITS = {char: index for index, char in enumerate("零一二三四五六七八九")}
_DIGITS.update({"〇": 0, "两": 2})
_UNITS = {"章": "chapter", "部": "part", "节": "section", "篇": "part", "卷": "book"}


def _number(value: str) -> int | None:
    if value.isascii() and value.isdecimal():
        number = int(value)
        return number if 1 <= number <= 9999 else None
    if all(char in _DIGITS for char in value):
        number = int("".join(str(_DIGITS[char]) for char in value))
        return number if 1 <= number <= 9999 else None
    total, digit, previous_unit = 0, None, 10000
    for char in value:
        if char in _DIGITS:
            if digit is not None and digit != 0:
                return None
            digit = _DIGITS[char]
            continue
        unit = {"十": 10, "百": 100, "千": 1000}.get(char)
        if unit is None or unit >= previous_unit or digit == 0:
            return None
        total += (1 if digit is None else digit) * unit
        digit, previous_unit = None, unit
    number = total + (digit or 0)
    return number if 1 <= number <= 9999 else None


def _normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def numbered_title(value: str) -> tuple[str, int, str] | None:
    """Strict content-unit prefix; page/file labels and arbitrary digits are not units."""
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 200
        or "\n" in value
        or "\r" in value
    ):
        return None
    normalized = unicodedata.normalize("NFKC", value).strip()
    match = _ENGLISH.fullmatch(normalized)
    if match:
        return match[1].casefold(), int(match[2]), (match[3] or "").strip()
    match = _CHINESE.fullmatch(normalized)
    if match:
        number = _number(match[1])
        if number is not None:
            return _UNITS[match[2]], number, match[3].strip()
    return None


def title_is_numbered_section(
    title: str,
    page: int,
    style: str,
    font_size: float,
    body_size: float,
    candidates: Iterable[tuple[str, int, str, float]],
) -> bool:
    """A first member of >=3 real, styled, cross-page consecutive sections is not a cover title.

    The caller passes only eligible single-line, upper-page, non-body blocks
    after header/footer classification. No node or title is created here.
    """
    first = numbered_title(title)
    if first is None or not style or font_size <= body_size + 0.1:
        return False
    peers: list[tuple[int, int]] = []
    for inspected, (text, candidate_page, candidate_style, candidate_size) in enumerate(
        candidates, 1
    ):
        if inspected > 20000:
            return False
        parsed = numbered_title(text)
        if parsed is None or parsed[0] != first[0] or candidate_style != style:
            continue
        if abs(candidate_size - font_size) > 0.1 or candidate_size <= body_size + 0.1:
            continue
        peers.append((candidate_page, parsed[1]))
        if len(peers) > 256:
            return False
    return (
        len(peers) >= 3
        and peers[0] == (page, first[1])
        and all(
            right[0] > left[0] and right[1] == left[1] + 1
            for left, right in pairwise(peers)
        )
    )


def source_supported_numbered_bookmarks(
    entries: Sequence[Mapping[str, Any]], n_pages: int, page_texts: Sequence[str] | None
) -> bool:
    """Narrow enum exception: the whole flat, ordered cohort is printed on exact target pages.

    Only call this after upstream classified the unmodified entry set as IGNORE.
    No adjacent-page matching, source rewriting or inferred/fuzzy section titles.
    """
    if not 3 <= len(entries) <= 256 or page_texts is None or len(page_texts) != n_pages:
        return False
    previous_page, previous_number, unit, scanned_chars = 0, 0, None, 0
    for entry in entries:
        if set(entry) != {"title", "level", "page"} or entry["level"] != 1:
            return False
        page, title = entry["page"], entry["title"]
        if type(page) is not int or not previous_page < page <= n_pages:
            return False
        parsed = numbered_title(title)
        if parsed is None or not parsed[2]:
            return False
        if unit is not None and (unit != parsed[0] or parsed[1] != previous_number + 1):
            return False
        source_text = page_texts[page - 1]
        if not isinstance(source_text, str):
            return False
        scanned_chars += len(source_text)
        if len(source_text) > 250000 or scanned_chars > 2_000_000:
            return False
        expected = _normalized(title)
        if not any(_normalized(line) == expected for line in source_text.splitlines()):
            return False
        previous_page, previous_number, unit = page, parsed[1], parsed[0]
    return True
