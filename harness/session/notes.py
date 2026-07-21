"""Harness-side re-export of the portable NoteStore.

The actual implementation lives in `DocSkills/_common/note_store.py` so
SKILL CLIs can use it without importing from `harness/`. The harness is a
consumer of the same library — this thin shim keeps the import path tidy
on the harness side (`from harness.session.notes import NoteStore`).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure DocSkills/_common is on sys.path. In Phase 3a we don't assume the
# project has been `pip install`ed, so we resolve relative to this file.
_COMMON = Path(__file__).resolve().parents[2] / "DocSkills" / "_common"
if str(_COMMON) not in sys.path:
    sys.path.insert(0, str(_COMMON))

from note_store import NoteEntry, NoteStore  # type: ignore  # noqa: E402

__all__ = ["NoteEntry", "NoteStore"]
