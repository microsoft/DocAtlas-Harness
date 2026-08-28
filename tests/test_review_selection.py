"""Regression tests for auxiliary-LLM Review selections."""

from docatlas.skills.review.scripts.run import _parse_selection


def test_parse_selection_accepts_integer_and_note_label_ids() -> None:
    raw = """{
        "rationale": "Both cards contain relevant evidence.",
        "selected_note_ids": [1, "2", "note_3", "NOTE-4", "note 5"]
    }"""

    rationale, note_ids = _parse_selection(raw)

    assert rationale == "Both cards contain relevant evidence."
    assert note_ids == [1, 2, 3, 4, 5]


def test_parse_selection_deduplicates_and_rejects_invalid_ids() -> None:
    raw = """{
        "rationale": "Only valid positive note IDs should survive.",
        "selected_note_ids": ["note_2", 2, true, 0, -1, "note_x", "1, 3"]
    }"""

    _, note_ids = _parse_selection(raw)

    assert note_ids == [2]


def test_parse_selection_accepts_single_labeled_id() -> None:
    raw = '{"thinking": "one match", "selected_note_ids": "note_12"}'

    rationale, note_ids = _parse_selection(raw)

    assert rationale == "one match"
    assert note_ids == [12]


def test_parse_selection_handles_fenced_or_invalid_output() -> None:
    rationale, note_ids = _parse_selection(
        '```json\n{"rationale": "match", "selected_note_ids": ["note_7"]}\n```'
    )
    assert rationale == "match"
    assert note_ids == [7]

    assert _parse_selection("not JSON") == ("(no valid JSON object found)", [])
