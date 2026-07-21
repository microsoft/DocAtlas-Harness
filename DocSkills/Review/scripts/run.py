#!/usr/bin/env python3
"""Review — DocSkill CLI.

Given a natural-language query, ask an auxiliary LLM to select which of
the session's saved analysis notes are relevant, and return the full
rendering of those selected notes. Useful before the final answer turn
to pull only the subset of prior findings that matter.

Session file: from `HARNESS_SESSION_FILE`.
Aux LLM: configured via `HARNESS_AUX_LLM_*` / `AZURE_OPENAI_*` env.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
_DOC_SKILLS = _THIS.parent.parent.parent
sys.path.insert(0, str(_DOC_SKILLS / "_common"))

from llm_client import call_responses  # type: ignore  # noqa: E402
from note_store import NoteStore  # type: ignore  # noqa: E402
from session_io import load_session, require_session_file  # type: ignore  # noqa: E402


def _render_note_cards(cards: list[dict]) -> str:
    lines = ["=== Note Cards ==="]
    for card in cards:
        lines.append(f"[note_{card['note_id']}] step={card['step']}")
        lines.append(f"pages={card['page_refs']}")
        lines.append(f"sources={card['sources']}")
        lines.append(f"found={card['found']}")
        lines.append("")
    lines.append("=== End Note Cards ===")
    return "\n".join(lines)


def _parse_selection(raw: str) -> tuple[str, list[int]]:
    """Extract JSON {thinking, selected_note_ids} from LLM output."""
    # Grab the first JSON object in the text.
    m = re.search(r"\{[\s\S]*\}", raw or "")
    if not m:
        return ("(no JSON found)", [])
    try:
        obj = json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return ("(JSON parse failed)", [])
    thinking = str(obj.get("thinking", "") or "")
    ids_raw = obj.get("selected_note_ids", []) or []
    ids: list[int] = []
    for x in ids_raw:
        try:
            ids.append(int(x))
        except Exception:  # noqa: BLE001
            continue
    return thinking, ids


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Retrieve analysis notes relevant to a query using an aux LLM.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--query", required=True, help="Focused natural-language recall query.")
    args = ap.parse_args(argv)

    sess_path = require_session_file()
    data = load_session(sess_path)
    store = NoteStore.from_dict(data.get("notes"))

    analyses = store.analysis_entries()
    if not analyses:
        payload = {
            "text": "No analysis notes saved yet — nothing to review.",
            "selected_note_ids": [],
            "thinking": "",
        }
        json.dump(payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    cards = [store.build_note_card(e) for e in analyses]
    prompt = (
        "You are selecting previously saved notes that are relevant to the recall request.\n"
        "You will be given note cards. Each note card contains: note_id, step, page_refs, "
        "sources, and found text.\n"
        "Return ONLY the note IDs that are relevant to the query. Return JSON with keys "
        "`thinking` and `selected_note_ids`.\n"
        "If nothing is relevant, return an empty list.\n\n"
        f"Recall query: {args.query}\n\n"
        f"{_render_note_cards(cards)}\n\n"
        "Reply in JSON:\n"
        "{\n"
        '  "thinking": "<brief reasoning>",\n'
        '  "selected_note_ids": [1, 3]\n'
        "}"
    )
    system = "You are a retrieval helper that selects relevant saved notes."

    try:
        raw = call_responses(
            system=system,
            user=prompt,
            max_output_tokens=2000,
            reasoning_effort="low",
        )
    except Exception as e:  # noqa: BLE001
        json.dump(
            {"error": f"aux LLM call failed: {e}"},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 2

    thinking, selected_ids = _parse_selection(raw)
    selected_entries = [store.find_analysis(i) for i in selected_ids]
    selected_entries = [e for e in selected_entries if e is not None]

    if not selected_entries:
        text = (
            f"No notes matched the query '{args.query}'.\n"
            f"Aux LLM thinking: {thinking or '(none)'}\n"
            f"Candidate note IDs considered: {[c['note_id'] for c in cards]}."
        )
    else:
        rendered = "\n\n".join(e.render() for e in selected_entries)
        text = (
            f"Selected {len(selected_entries)} note(s) for query '{args.query}':\n\n"
            f"{rendered}\n\n"
            f"(Aux LLM thinking: {thinking or '(none)'})"
        )

    payload = {
        "text": text,
        "query": args.query,
        "selected_note_ids": [int(e.data.get("note_id", 0)) for e in selected_entries],
        "candidate_note_ids": [c["note_id"] for c in cards],
        "thinking": thinking,
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
