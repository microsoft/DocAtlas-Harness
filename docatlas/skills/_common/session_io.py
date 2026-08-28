"""Session-file I/O for stateful SKILLs.

Stateful SKILLs (Note / Review / Search) share data through a single
`session.json` on disk. The harness creates it; every SKILL invocation
reads and (if it mutates) writes the file atomically.

The session path is conveyed to skills via `HARNESS_SESSION_FILE` in the
environment — this keeps the LLM-visible tool schema clean.

Shape of `session.json`::

    {
      "session_id": "...",
      "doc_env":   { "pdf_path": ..., "markdown_dir": ..., "doc_id": ..., "tree_json_path": ... },
      "notes":     { "question": ..., "step": ..., "tool_call_count": ..., "entries": [...] },
      "tree":      { ... PageIndex tree JSON ... },
      "workspace": { "search_history": [...], "read_history": [...] }
    }

Missing regions default to empty. Writes are tmp-file + rename so partial
writes can't corrupt the file.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

_ENV_KEY = "HARNESS_SESSION_FILE"


def session_file_from_env() -> Path | None:
    """Return Path from $HARNESS_SESSION_FILE, or None if unset."""
    v = os.environ.get(_ENV_KEY, "").strip()
    return Path(v) if v else None


def require_session_file() -> Path:
    p = session_file_from_env()
    if p is None:
        raise RuntimeError(
            f"{_ENV_KEY} is not set. This skill needs a session file; "
            f"launch via `uv run --locked harness chat ...` or set {_ENV_KEY} manually."
        )
    if not p.is_file():
        raise FileNotFoundError(f"Session file does not exist: {p}")
    return p


def load_session(path: str | Path | None = None) -> dict[str, Any]:
    """Load and return the full session dict.

    Callers mutate the returned dict and call save_session() to persist.
    """
    if path is None:
        path = require_session_file()
    p = Path(path)
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"session file at {p} is not a JSON object")
    # Fill in defaults for missing regions
    data.setdefault("doc_env", {})
    data.setdefault("notes", {})
    data.setdefault("tree", None)
    data.setdefault("workspace", {})
    return data


def save_session(data: dict[str, Any], path: str | Path | None = None) -> None:
    """Atomically persist the session dict.

    Writes to a temp file in the same directory, then renames — so readers
    can't see a half-written file and a crash mid-write leaves the previous
    good copy intact.
    """
    if path is None:
        path = require_session_file()
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Use NamedTemporaryFile to get atomic rename within the same filesystem.
    fd, tmp_path = tempfile.mkstemp(prefix=".session.", suffix=".json", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, p)
    except Exception:
        # Clean up tmp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


__all__ = [
    "session_file_from_env",
    "require_session_file",
    "load_session",
    "save_session",
]
