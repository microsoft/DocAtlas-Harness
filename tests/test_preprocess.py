from __future__ import annotations

import json
from pathlib import Path

from docatlas.benchmarks.mmlongbench.runner import _git_revision
from docatlas.preprocess._io import atomic_write_json
from docatlas.preprocess.merge_trees import _load_tree_json


def test_load_tree_accepts_documented_bare_list(tmp_path: Path) -> None:
    path = tmp_path / "tree.json"
    path.write_text(json.dumps([{"node_id": "1", "title": "Intro"}]), encoding="utf-8")

    tree = _load_tree_json(path)

    assert tree["doc_name"] == "tree"
    assert tree["structure"][0]["node_id"] == "1"


def test_atomic_write_json_replaces_complete_document(tmp_path: Path) -> None:
    path = tmp_path / "result.json"
    path.write_text('{"old": true}', encoding="utf-8")

    atomic_write_json(path, {"new": [1, 2, 3]})

    assert json.loads(path.read_text(encoding="utf-8")) == {"new": [1, 2, 3]}
    assert not list(tmp_path.glob("*.tmp"))


def test_git_revision_reads_symbolic_head_without_subprocess(tmp_path: Path, monkeypatch) -> None:
    git_dir = tmp_path / ".git"
    ref = git_dir / "refs" / "heads" / "main"
    ref.parent.mkdir(parents=True)
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    ref.write_text("abc123\n", encoding="utf-8")
    monkeypatch.delenv("GITHUB_SHA", raising=False)

    assert _git_revision(tmp_path) == "abc123"
