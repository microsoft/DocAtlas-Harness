"""Runtime re-export of the portable NoteStore.

The implementation lives under ``docatlas.skills._common`` so Skill CLIs and
the agent runtime share one state model.
"""

from __future__ import annotations

from ..skills._common.note_store import NoteEntry, NoteStore

__all__ = ["NoteEntry", "NoteStore"]
