from __future__ import annotations

import os
import runpy
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
GENERATOR = runpy.run_path(str(ROOT / "scripts/vendor_flash.py"))


def _git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def _checkout(tmp_path: Path) -> tuple[Path, str]:
    root = tmp_path / "upstream"
    (root / "pageindex/flash").mkdir(parents=True)
    for name, content in {
        ".gitignore": "*.ignored.py\n*.extra.json\nignored\n",
        "README.md": "Official upstream text\n",
        "LICENSE": "Fixture license\n",
        "pageindex/tree_optimize.py": "def merge(): return None\n",
        "pageindex/utils.py": "def strip_internal_keys(): return None\n",
        "pageindex/flash/main.py": "VALUE = 1\n",
        "pageindex/flash/data.json": '{"official": true}\n',
    }.items():
        (root / name).write_text(content)
    _git(root, "init", "--quiet")
    _git(root, "add", ".")
    _git(
        root,
        "-c",
        "user.name=DocAtlas test",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "pinned fixture",
    )
    return root, _git(root, "rev-parse", "HEAD")


def test_capture_uses_only_clean_pinned_regular_git_blobs(tmp_path: Path) -> None:
    source, commit = _checkout(tmp_path)
    captured = GENERATOR["verified_sources"](source, commit)
    assert set(captured) == {
        "LICENSE",
        "pageindex/tree_optimize.py",
        "pageindex/utils.py",
        "pageindex/flash/main.py",
        "pageindex/flash/data.json",
    }
    assert captured["pageindex/flash/main.py"] == b"VALUE = 1\n"
    with pytest.raises(RuntimeError, match="source pin"):
        GENERATOR["verified_sources"](source, "0" * 40)


@pytest.mark.parametrize("change", ["tracked", "staged", "untracked", "unrelated-tracked"])
def test_dirty_checkout_is_rejected_before_copying_without_printing_source_content(
    tmp_path: Path, change: str
) -> None:
    source, commit = _checkout(tmp_path)
    path = source / ("README.md" if change == "unrelated-tracked" else "pageindex/flash/main.py")
    if change == "untracked":
        path = source / "pageindex/flash/new.py"
    path.write_text("private-fixture-content-must-not-appear-in-errors")
    if change == "staged":
        _git(source, "add", str(path.relative_to(source)))
    with pytest.raises(RuntimeError, match="must be clean") as failure:
        GENERATOR["verified_sources"](source, commit)
    assert "private-fixture-content" not in str(failure.value)


@pytest.mark.parametrize("name", ["extra.ignored.py", "extra.extra.json"])
def test_gitignored_extra_code_and_data_are_not_official_sources(tmp_path: Path, name: str) -> None:
    source, commit = _checkout(tmp_path)
    (source / "pageindex/flash" / name).write_text("ignored but not official")
    assert _git(source, "status", "--porcelain=v1", "--untracked-files=all") == ""
    with pytest.raises(RuntimeError, match="file set differs"):
        GENERATOR["verified_sources"](source, commit)


def test_ignored_symlinks_and_direct_file_reader_never_follow_external_targets(
    tmp_path: Path,
) -> None:
    source, commit = _checkout(tmp_path)
    outside = tmp_path / "outside.py"
    outside.write_text("not a pinned source")
    link = source / "pageindex/flash/link.ignored.py"
    link.symlink_to(outside)
    assert _git(source, "status", "--porcelain=v1", "--untracked-files=all") == ""
    with pytest.raises(RuntimeError, match="symlink"):
        GENERATOR["verified_sources"](source, commit)
    with pytest.raises(OSError):
        GENERATOR["_read_pinned_file"](source, "pageindex/flash/link.ignored.py")
    alias = tmp_path / "alias"
    alias.symlink_to(source, target_is_directory=True)
    with pytest.raises(RuntimeError, match="symlink"):
        GENERATOR["verified_sources"](alias, commit)


def test_ignored_directory_symlink_is_rejected_without_traversal(tmp_path: Path) -> None:
    source, commit = _checkout(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "payload.py").write_text("outside data")
    (source / "pageindex/flash/ignored").symlink_to(outside, target_is_directory=True)
    assert _git(source, "status", "--porcelain=v1", "--untracked-files=all") == ""
    with pytest.raises(RuntimeError, match="symlink"):
        GENERATOR["verified_sources"](source, commit)


def test_blob_identity_is_checked_even_if_status_were_to_miss_a_worktree_edit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, commit = _checkout(tmp_path)
    (source / "pageindex/flash/main.py").write_text("VALUE = 2\n")
    original = subprocess.check_output

    def status_missed_edit(args: list[str], **kwargs: object) -> object:
        return b"" if "status" in args else original(args, **kwargs)

    monkeypatch.setattr(subprocess, "check_output", status_missed_edit)
    with pytest.raises(RuntimeError, match="pinned Git blob"):
        GENERATOR["verified_sources"](source, commit)


def test_nonregular_source_reader_does_not_block_on_a_fifo(tmp_path: Path) -> None:
    source, _ = _checkout(tmp_path)
    os.mkfifo(source / "pageindex/flash/fifo.py")
    with pytest.raises(RuntimeError, match="regular file"):
        GENERATOR["_read_pinned_file"](source, "pageindex/flash/fifo.py")
