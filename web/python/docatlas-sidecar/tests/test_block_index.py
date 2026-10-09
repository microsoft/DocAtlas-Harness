from __future__ import annotations

from docatlas_dsh_sidecar.block_index import (
    PageText,
    assess_text_quality,
    build_blocks,
    normalize_page_text,
)


def test_blocks_are_stable_revision_representation_scoped_and_bounded() -> None:
    pages = [
        PageText(1, "# Revenue\r\n\r\nRevenue increased by 12%.\n"),
        PageText(2, "- Cloud\n- Services\n\n| Q1 | Q2 |\n| 10 | 12 |\n"),
    ]
    first = build_blocks(pages, "rep:one")
    second = build_blocks(pages, "rep:one")
    other_representation = build_blocks(pages, "rep:two")

    assert first == second
    assert [block.kind for block in first] == ["heading", "paragraph", "list", "table"]
    assert first[1].heading == "Revenue"
    assert first[0].block_id.startswith("p00001.b00001.heading.")
    assert first[2].block_id.startswith("p00002.b00001.list.")
    assert [block.block_id for block in first] != [block.block_id for block in other_representation]
    assert all(len(block.text) <= 4000 for block in first)


def test_long_blocks_split_without_losing_text_order() -> None:
    text = "word " * 2000
    blocks = build_blocks([PageText(1, text)], "rep:long")
    assert len(blocks) >= 2
    assert " ".join(block.text for block in blocks).split() == text.split()
    assert [block.page_block_index for block in blocks] == list(range(1, len(blocks) + 1))


def test_pdf_visual_lines_remain_independently_addressable() -> None:
    blocks = build_blocks(
        [PageText(1, "Financial Highlights\nQuarter Revenue Growth\nQ3 14.0 +7%\nQ4 15.2 +9%")],
        "rep:pdf",
        split_visual_lines=True,
    )

    assert [block.text for block in blocks] == [
        "Financial Highlights",
        "Quarter Revenue Growth",
        "Q3 14.0 +7%",
        "Q4 15.2 +9%",
    ]
    assert blocks[-1].char_start == 56
    assert blocks[-1].char_end == 67


def test_text_quality_is_deterministic_and_page_aware() -> None:
    assert assess_text_quality([PageText(1, " \n")]) == "empty"
    assert assess_text_quality([PageText(1, "short")]) == "sparse"
    assert assess_text_quality([PageText(1, "\ufffd" * 10 + "normal")]) == "garbled"
    assert assess_text_quality([PageText(1, "usable text " * 20)]) == "usable"
    assert assess_text_quality([PageText(1, "usable text " * 20), PageText(2, "")]) == "usable"
    assert (
        assess_text_quality([PageText(1, "usable text " * 20), PageText(2, ""), PageText(3, "")])
        == "sparse"
    )


def test_normalization_uses_nfc_and_unix_newlines() -> None:
    assert normalize_page_text("Cafe\u0301\r\nnext\rline") == "Café\nnext\nline"
