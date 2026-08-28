"""SessionStore — bundles DocEnv + NoteStore + tree + workspace.

The on-disk `session.json` is the single source of truth that SKILL
subprocesses read and write through ``docatlas.skills._common.session_io``.
SessionStore is the harness-side view: it creates that file at launch,
can refresh itself from disk after each dispatch (so the loop observes
what skills wrote), and can dump it for the trace.

Layout under `outputs/sessions/<uuid>/`:

    session.json           — the shared state file, including a session-local
                             copy of the document tree

`new()` creates the directory + file; `load(path)` reopens an existing one.
"""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .doc_env import DocEnv
from .notes import NoteStore
from .tree import load_tree


def _default_sessions_root() -> Path:
    return Path(
        os.getenv("HARNESS_SESSIONS_ROOT", str(Path.cwd() / "outputs" / "sessions"))
    ).expanduser()


DEFAULT_SESSIONS_ROOT = _default_sessions_root()


@dataclass
class SessionStore:
    """In-memory mirror of session.json plus its path on disk."""

    session_id: str
    path: Path
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    doc_env: DocEnv = field(default_factory=DocEnv)
    notes: NoteStore = field(default_factory=NoteStore)
    tree: Any = None  # list | dict | None — PageIndex tree JSON
    workspace: dict[str, Any] = field(
        default_factory=lambda: {
            "search_history": [],
            "read_history": [],
        }
    )

    # ── construction ────────────────────────────────────────────────────────

    @classmethod
    def new(
        cls,
        doc_env: DocEnv,
        *,
        question: str = "",
        sessions_root: Path | None = None,
        session_id: str | None = None,
    ) -> SessionStore:
        """Create a fresh session directory + session.json on disk.

        Loads the tree from `doc_env.tree_json_path` if provided.
        """
        root = Path(sessions_root) if sessions_root else _default_sessions_root()
        sid = session_id or uuid.uuid4().hex
        if not sid or Path(sid).name != sid or sid in {".", ".."}:
            raise ValueError("session_id must be a single safe path component")
        sess_dir = root / sid
        sess_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        path = sess_dir / "session.json"

        tree = None
        if doc_env.tree_json_path:
            try:
                tree = load_tree(doc_env.tree_json_path)
            except Exception as e:  # noqa: BLE001
                raise ValueError(
                    f"Could not load tree JSON at {doc_env.tree_json_path}: {e}"
                ) from e

        notes = NoteStore(question=question)
        store = cls(
            session_id=sid,
            path=path,
            doc_env=doc_env,
            notes=notes,
            tree=tree,
        )
        store.save()
        return store

    @classmethod
    def load(cls, path: str | Path) -> SessionStore:
        p = Path(path)
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return cls(
            session_id=str(data.get("session_id") or p.parent.name),
            path=p,
            created_at=str(data.get("created_at") or datetime.now(timezone.utc).isoformat()),
            doc_env=DocEnv.from_dict(data.get("doc_env")),
            notes=NoteStore.from_dict(data.get("notes")),
            tree=data.get("tree"),
            workspace=dict(data.get("workspace") or {"search_history": [], "read_history": []}),
        )

    # ── serialization ───────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "created_at": self.created_at,
            "doc_env": self.doc_env.to_dict(),
            "notes": self.notes.to_dict(),
            "tree": self.tree,
            "workspace": self.workspace,
        }

    def save(self) -> None:
        """Atomic write (tmp + rename) of session.json."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=".session.", suffix=".json", dir=str(self.path.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    def refresh_from_disk(self) -> None:
        """Re-read session.json into this store (after a skill has written)."""
        with open(self.path, encoding="utf-8") as f:
            data = json.load(f)
        self.doc_env = DocEnv.from_dict(data.get("doc_env"))
        self.notes = NoteStore.from_dict(data.get("notes"))
        self.tree = data.get("tree")
        self.workspace = dict(data.get("workspace") or self.workspace)

    # ── trace helpers ───────────────────────────────────────────────────────

    def summary(self) -> str:
        bits = [f"session={self.session_id}"]
        if self.doc_env.pdf_path:
            bits.append(f"pdf={Path(self.doc_env.pdf_path).name}")
        if self.doc_env.doc_id:
            bits.append(f"doc_id={self.doc_env.doc_id}")
        bits.append(f"notes={len(self.notes.entries)}")
        bits.append(f"analyses={self.notes.analysis_count}")
        if self.tree is not None:
            bits.append("tree=loaded")
        return " ".join(bits)


__all__ = ["SessionStore", "DEFAULT_SESSIONS_ROOT"]
