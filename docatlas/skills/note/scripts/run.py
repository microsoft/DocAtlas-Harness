#!/usr/bin/env python3
"""Note — Agent Skill CLI.

Append a single "analysis" note entry to the session's note timeline.
The session file is located via the `HARNESS_SESSION_FILE` env var.

Each call records one structured observation — what you found, a plan for
the next step, and a list of evidence items (text excerpts with a page
reference, or image references). Notes are ordered by step and numbered
so later Review calls can select them.

Usage (arguments come as JSON via --json, to avoid argv escaping headaches
for free-text fields)::

    python run.py --json '{"found": "...", "plan": "...", "evidence": [...]}'

Outputs a single JSON object on stdout with the saved note's id and a
rendered preview.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
_DOC_SKILLS = _THIS.parent.parent.parent
sys.path.insert(0, str(_DOC_SKILLS / "_common"))

from note_store import NoteStore  # type: ignore  # noqa: E402
from session_io import (  # type: ignore  # noqa: E402
    load_session,
    require_session_file,
    save_session,
)

_EVIDENCE_TYPES = {"text", "table", "image"}
_SIDE_EFFECT_POLICIES = {
    "auto",
    "save_note_only",
    "save_and_archive",
    "save_and_enrich",
    "save_archive_and_enrich",
}


def _coerce_evidence(raw) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f"evidence must be a list, got {type(raw).__name__}")
    if len(raw) > 20:
        raise ValueError("evidence may contain at most 20 items")
    out: list[dict] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"evidence[{i}] must be an object")
        evidence_type = str(item.get("type", "text") or "text").lower()
        if evidence_type not in _EVIDENCE_TYPES:
            raise ValueError(f"evidence[{i}].type must be one of {sorted(_EVIDENCE_TYPES)}")
        source = str(item.get("source", "") or "").strip()
        if not source:
            raise ValueError(f"evidence[{i}].source must not be empty")
        content = str(item.get("content", "") or "")
        if len(content) > 20_000:
            raise ValueError(f"evidence[{i}].content exceeds 20,000 characters")
        e = {"type": evidence_type, "source": source, "content": content}
        if "filename" in item:
            e["filename"] = str(item.get("filename") or "")
        out.append(e)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Append a progress-analysis note to the session timeline.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--found", default=None, help="1-3 sentence summary of what you observed.")
    ap.add_argument("--plan", default=None, help="What you intend to do next.")
    ap.add_argument(
        "--evidence",
        default=None,
        help=(
            "JSON array of evidence objects. Each: "
            "{type: 'text'|'table'|'image', source: 'Page N[, title]', "
            "content: '...', filename?: '...'}."
        ),
    )
    ap.add_argument(
        "--side-effect-policy",
        default=None,
        choices=[
            "auto",
            "save_note_only",
            "save_and_archive",
            "save_and_enrich",
            "save_archive_and_enrich",
        ],
        help="Override what happens after this note is saved (defaults to 'auto').",
    )
    ap.add_argument(
        "--json",
        default=None,
        help="Alternative: pass all fields as one JSON blob (found/plan/evidence).",
    )
    args = ap.parse_args(argv)

    found: str = ""
    plan: str = ""
    evidence_raw = None
    side_effect_policy: str = "auto"

    if args.json:
        try:
            blob = json.loads(args.json)
        except Exception as e:  # noqa: BLE001
            json.dump({"error": f"--json is not valid JSON: {e}"}, sys.stdout)
            sys.stdout.write("\n")
            return 2
        if not isinstance(blob, dict):
            json.dump({"error": "--json must be an object"}, sys.stdout)
            sys.stdout.write("\n")
            return 2
        found = str(blob.get("found", "") or "")
        plan = str(blob.get("plan", "") or "")
        evidence_raw = blob.get("evidence")
        if blob.get("side_effect_policy"):
            side_effect_policy = str(blob.get("side_effect_policy"))

    # Explicit flags override --json fields when given.
    if args.found is not None:
        found = args.found
    if args.plan is not None:
        plan = args.plan
    if args.side_effect_policy is not None:
        side_effect_policy = args.side_effect_policy
    if args.evidence is not None:
        try:
            evidence_raw = json.loads(args.evidence)
        except Exception as e:  # noqa: BLE001
            json.dump({"error": f"--evidence is not valid JSON: {e}"}, sys.stdout)
            sys.stdout.write("\n")
            return 2

    if not found and not plan and not evidence_raw:
        json.dump(
            {"error": "Note requires at least one of: found, plan, evidence."},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 2
    if len(found) > 4_000 or len(plan) > 4_000:
        json.dump(
            {"error": "found and plan are limited to 4,000 characters each"},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 2
    if side_effect_policy not in _SIDE_EFFECT_POLICIES:
        json.dump({"error": "invalid side_effect_policy"}, sys.stdout)
        sys.stdout.write("\n")
        return 2

    try:
        evidence = _coerce_evidence(evidence_raw)
    except ValueError as e:
        json.dump({"error": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        return 2

    # Load session, append, save.
    try:
        sess_path = require_session_file()
        data = load_session(sess_path)
    except (FileNotFoundError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        json.dump({"error": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    store = NoteStore.from_dict(data.get("notes"))
    entry = store.add_analysis(found=found, plan=plan, evidence=evidence)
    if side_effect_policy and side_effect_policy != "auto":
        entry.data["side_effect_policy"] = side_effect_policy
    elif side_effect_policy == "auto":
        # Persist explicitly so consumers can read it back, but it doesn't override.
        entry.data["side_effect_policy"] = "auto"
    data["notes"] = store.to_dict()
    save_session(data, sess_path)

    note_id = int(entry.data.get("note_id", 0))
    text = (
        f"Saved as note #{note_id} (step {entry.step}). "
        f"Total analyses so far: {store.analysis_count}.\n\n"
        f"{entry.render()}"
    )
    payload = {
        "text": text,
        "note_id": note_id,
        "step": entry.step,
        "analysis_count": store.analysis_count,
        "_harness_extras": {
            "session_patch": {"notes_added": 1, "last_note_id": note_id},
        },
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
