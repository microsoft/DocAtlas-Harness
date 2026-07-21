"""Session state layer — shared document/notes/tree context per chat.

See `store.py` for the bundle and `doc_env.py`, `notes.py`, `tree.py` for
the individual regions. The on-disk `session.json` format is defined by
`DocSkills/_common/session_io.py`; keeping it out of harness/ means SKILL
subprocesses stay portable.
"""

from .doc_env import DocEnv
from .notes import NoteEntry, NoteStore
from .store import SessionStore, DEFAULT_SESSIONS_ROOT
from .tree import load_tree

__all__ = [
    "DocEnv",
    "NoteEntry",
    "NoteStore",
    "SessionStore",
    "DEFAULT_SESSIONS_ROOT",
    "load_tree",
]
