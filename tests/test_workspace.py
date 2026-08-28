from __future__ import annotations

from pathlib import Path

import pytest
from pypdf import PdfWriter

from docatlas.workspace import (
    DocumentWorkspace,
    build_preprocess_stages,
    normalize_document_paths,
    parse_at_paths,
)


def _pdf(path: Path, content: bytes = b"%PDF-fixture") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def test_parse_at_paths_supports_quotes_and_multiple_mentions() -> None:
    assert parse_at_paths('@report.pdf @"annual report.pdf" normal-text') == [
        "report.pdf",
        "annual report.pdf",
    ]


def test_normalize_documents_accepts_files_and_directories(tmp_path: Path) -> None:
    first = _pdf(tmp_path / "one.pdf")
    second = _pdf(tmp_path / "folder" / "TWO.PDF")
    _pdf(tmp_path / "folder" / "nested" / "three.pdf")
    (tmp_path / "folder" / "ignore.txt").write_text("not a PDF")

    documents = normalize_document_paths([first, tmp_path / "folder"])
    recursive = normalize_document_paths([tmp_path / "folder"], recursive=True)

    assert documents == [first.resolve(), second.resolve()]
    assert [path.name for path in recursive] == ["three.pdf", "TWO.PDF"]


def test_normalize_documents_rejects_duplicate_stems(tmp_path: Path) -> None:
    first = _pdf(tmp_path / "a" / "report.pdf")
    second = _pdf(tmp_path / "b" / "REPORT.PDF")

    with pytest.raises(ValueError, match="unique stems"):
        normalize_document_paths([first, second])


def test_workspace_builds_single_document_plan(tmp_path: Path) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")

    stages = build_preprocess_stages(
        workspace,
        model="gpt-test",
        force=True,
        python_executable="python-test",
    )

    assert workspace.tree_json == workspace.trees_dir / "report_structure.json"
    assert [stage.title for stage in stages] == ["Markdown 1/1 · report.pdf", "PageIndex tree"]
    assert stages[0].argv[:4] == ("python-test", "-m", "docatlas", "build-md")
    assert "--force" in stages[0].argv
    assert "--force" in stages[1].argv
    assert workspace.doc_env().doc_map is None


def test_workspace_builds_multi_document_plan_and_doc_map(tmp_path: Path) -> None:
    first = _pdf(tmp_path / "one.pdf")
    second = _pdf(tmp_path / "two.pdf")
    workspace = DocumentWorkspace.create([first, second], workspace_root=tmp_path / "workspaces")

    stages = build_preprocess_stages(
        workspace,
        model="gpt-test",
        python_executable="python-test",
    )
    doc_env = workspace.doc_env()

    assert len(stages) == 3
    assert stages[-1].title == "Merged PageIndex tree"
    assert stages[-1].argv.count("--pdf") == 2
    assert "--force-trees" not in stages[-1].argv
    assert doc_env.doc_map is not None
    assert set(doc_env.doc_map) == {"one", "two"}
    assert doc_env.tree_json_path == str(workspace.tree_json)


def test_model_change_forces_only_tree_rebuild(tmp_path: Path) -> None:
    document = _pdf(tmp_path / "report.pdf")
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")

    stages = build_preprocess_stages(
        workspace,
        model="new-model",
        force_trees=True,
        python_executable="python-test",
    )

    assert "--force" not in stages[0].argv
    assert "--force" in stages[1].argv


def test_workspace_key_changes_when_document_changes(tmp_path: Path) -> None:
    document = _pdf(tmp_path / "report.pdf")
    first = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    document.write_bytes(b"%PDF-fixture-changed")
    second = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")

    assert first.key != second.key


def test_workspace_ready_requires_complete_matching_artifacts(tmp_path: Path) -> None:
    document = tmp_path / "report.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with document.open("wb") as handle:
        writer.write(handle)
    workspace = DocumentWorkspace.create([document], workspace_root=tmp_path / "workspaces")
    assert workspace.is_ready(model="gpt-test") is False

    page = workspace.markdown_dir / "report" / "report_page0" / "vlm" / "report_page0.md"
    page.parent.mkdir(parents=True)
    page.write_text("# Report")
    workspace.tree_json.parent.mkdir(parents=True)
    workspace.tree_json.write_text('{"structure": []}')
    workspace.save_metadata(model="gpt-test")

    assert workspace.cached_model() == "gpt-test"
    assert workspace.is_ready(model="gpt-test") is True
    assert workspace.is_ready(model="different-model") is False
    page.write_text("")
    assert workspace.is_ready(model="gpt-test") is False
