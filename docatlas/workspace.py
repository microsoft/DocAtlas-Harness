"""Document selection and cached preprocessing workspaces for the TUI."""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import sys
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .preprocess._io import atomic_write_json
from .session import DocEnv

_WORKSPACE_SCHEMA_VERSION = 1


def _path_text_is_safe(value: str) -> bool:
    return all(unicodedata.category(char) not in {"Cc", "Cf", "Cs"} for char in value)


def parse_at_paths(value: str) -> list[str]:
    """Extract shell-quoted ``@path`` document mentions from one input line."""
    try:
        tokens = shlex.split(value, posix=os.name != "nt")
    except ValueError as exc:
        raise ValueError(f"could not parse @ paths: {exc}") from exc
    paths: list[str] = []
    for token in tokens:
        # A bare at-sign opens selection; it is not a credential value.
        if token == "@":  # nosec B105
            continue
        if token.startswith("@") and len(token) > 1:
            paths.append(token[1:])
    return paths


def normalize_document_paths(
    inputs: Iterable[str | Path],
    *,
    recursive: bool = False,
    max_documents: int = 100,
) -> list[Path]:
    """Resolve PDF files and directories into a safe, deterministic list."""
    if max_documents < 1:
        raise ValueError("max_documents must be at least 1")

    discovered: dict[str, Path] = {}
    for raw in inputs:
        raw_text = str(raw).strip()
        if raw_text.startswith("@"):
            raw_text = raw_text[1:]
        if not raw_text:
            continue
        if not _path_text_is_safe(raw_text):
            raise ValueError(
                "document paths containing terminal control characters are unsupported"
            )
        path = Path(raw_text).expanduser().resolve()
        if path.is_file():
            if path.suffix.lower() != ".pdf":
                raise ValueError(f"not a PDF file: {path}")
            discovered[str(path)] = path
            continue
        if path.is_dir():
            candidates = path.rglob("*") if recursive else path.iterdir()
            try:
                for candidate in sorted(candidates, key=lambda item: str(item).casefold()):
                    if not _path_text_is_safe(str(candidate)):
                        continue
                    if candidate.is_file() and candidate.suffix.lower() == ".pdf":
                        resolved = candidate.resolve()
                        discovered[str(resolved)] = resolved
                        if len(discovered) > max_documents:
                            raise ValueError(
                                f"selected more than {max_documents} PDFs; narrow the folder"
                            )
            except OSError as exc:
                raise ValueError(f"could not read directory {path}: {exc}") from exc
            continue
        raise FileNotFoundError(f"document path does not exist: {path}")

    documents = list(discovered.values())
    if not documents:
        raise ValueError("no PDF documents were selected")
    if len(documents) > max_documents:
        raise ValueError(
            f"selected {len(documents)} PDFs; the interactive limit is {max_documents}"
        )

    by_stem: dict[str, list[Path]] = {}
    for document in documents:
        by_stem.setdefault(document.stem.casefold(), []).append(document)
    collisions = [paths for paths in by_stem.values() if len(paths) > 1]
    if collisions:
        names = ", ".join(str(path) for paths in collisions for path in paths)
        raise ValueError(f"PDF filenames must have unique stems; rename one of: {names}")
    return documents


def _workspace_key(documents: Iterable[Path]) -> str:
    digest = hashlib.sha256(f"docatlas-workspace-v{_WORKSPACE_SCHEMA_VERSION}\n".encode())
    for path in documents:
        stat = path.stat()
        digest.update(str(path).encode("utf-8", errors="surrogateescape"))
        digest.update(f"\0{stat.st_size}\0{stat.st_mtime_ns}\n".encode())
    return digest.hexdigest()[:16]


@dataclass(frozen=True)
class DocumentWorkspace:
    """Cached preprocessing paths for one immutable document selection."""

    documents: tuple[Path, ...]
    key: str
    root: Path
    markdown_dir: Path
    trees_dir: Path
    tree_json: Path

    @classmethod
    def create(
        cls,
        documents: Iterable[Path],
        *,
        workspace_root: str | Path | None = None,
    ) -> DocumentWorkspace:
        docs = tuple(documents)
        if not docs:
            raise ValueError("a workspace requires at least one document")
        key = _workspace_key(docs)
        base = (
            Path(workspace_root).expanduser().resolve()
            if workspace_root is not None
            else (Path.cwd() / "outputs" / "tui").resolve()
        )
        root = base / key
        trees_dir = root / "trees"
        tree_json = (
            trees_dir / f"{docs[0].stem}_structure.json"
            if len(docs) == 1
            else root / "series_structure.json"
        )
        return cls(
            documents=docs,
            key=key,
            root=root,
            markdown_dir=root / "markdown",
            trees_dir=trees_dir,
            tree_json=tree_json,
        )

    def doc_env(self) -> DocEnv:
        first = self.documents[0]
        doc_map = None
        if len(self.documents) > 1:
            doc_map = {
                document.stem: {
                    "pdf_path": str(document),
                    "markdown_dir": str(self.markdown_dir),
                    "doc_id": document.stem,
                }
                for document in self.documents
            }
        return DocEnv.from_cli(
            pdf=str(first),
            markdown_dir=str(self.markdown_dir),
            doc_id=first.stem,
            tree_json_path=str(self.tree_json),
            doc_map=doc_map,
        )

    def save_metadata(self, *, model: str) -> None:
        payload: dict[str, Any] = {
            "schema_version": _WORKSPACE_SCHEMA_VERSION,
            "key": self.key,
            "documents": [str(path) for path in self.documents],
            "markdown_dir": str(self.markdown_dir),
            "tree_json": str(self.tree_json),
            "model": model,
        }
        atomic_write_json(self.root / "workspace.json", payload)

    def cached_model(self) -> str | None:
        try:
            payload = json.loads((self.root / "workspace.json").read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or payload.get("key") != self.key:
            return None
        model = payload.get("model")
        return str(model) if isinstance(model, str) and model else None

    def is_ready(self, *, model: str) -> bool:
        """Return True only for a complete cache matching this exact selection."""
        metadata_path = self.root / "workspace.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            tree = json.loads(self.tree_json.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return False
        if not isinstance(metadata, dict) or not isinstance(tree, dict):
            return False
        if not isinstance(tree.get("structure"), list):
            return False
        if metadata.get("schema_version") != _WORKSPACE_SCHEMA_VERSION:
            return False
        if metadata.get("key") != self.key:
            return False
        if metadata.get("documents") != [str(path) for path in self.documents]:
            return False
        if metadata.get("model") != model:
            return False
        try:
            from pypdf import PdfReader

            for document in self.documents:
                page_count = len(PdfReader(str(document)).pages)
                markdown_files = [
                    self.markdown_dir
                    / document.stem
                    / f"{document.stem}_page{index}"
                    / "vlm"
                    / f"{document.stem}_page{index}.md"
                    for index in range(page_count)
                ]
                if not markdown_files or any(
                    not path.is_file() or path.stat().st_size == 0 for path in markdown_files
                ):
                    return False
        except Exception:  # noqa: BLE001 - corrupt PDFs make a cache unusable, not fatal
            return False
        return True


@dataclass(frozen=True)
class PreprocessStage:
    title: str
    argv: tuple[str, ...]


def build_preprocess_stages(
    workspace: DocumentWorkspace,
    *,
    model: str,
    force: bool = False,
    force_trees: bool = False,
    python_executable: str | Path | None = None,
) -> list[PreprocessStage]:
    """Return the exact subprocess plan needed to prepare a workspace."""
    if not model.strip():
        raise ValueError("an Azure model deployment is required for PageIndex")
    executable = str(python_executable or sys.executable)
    stages: list[PreprocessStage] = []
    for index, document in enumerate(workspace.documents, 1):
        argv = [
            executable,
            "-m",
            "docatlas",
            "build-md",
            "--pdf",
            str(document),
            "--output-dir",
            str(workspace.markdown_dir),
        ]
        if force:
            argv.append("--force")
        stages.append(
            PreprocessStage(
                title=f"Markdown {index}/{len(workspace.documents)} · {document.name}",
                argv=tuple(argv),
            )
        )

    if len(workspace.documents) == 1:
        argv = [
            executable,
            "-m",
            "docatlas",
            "build-tree",
            "--pdf",
            str(workspace.documents[0]),
            "--output-dir",
            str(workspace.trees_dir),
            "--model",
            model,
            "--node-summary",
        ]
        if force or force_trees:
            argv.append("--force")
        stages.append(PreprocessStage(title="PageIndex tree", argv=tuple(argv)))
    else:
        argv = [executable, "-m", "docatlas", "build-series-tree"]
        for document in workspace.documents:
            argv.extend(["--pdf", str(document)])
        argv.extend(
            [
                "--output",
                str(workspace.tree_json),
                "--trees-dir",
                str(workspace.trees_dir),
                "--doc-name",
                f"DocAtlas workspace {workspace.key}",
                "--model",
                model,
                "--node-summary",
            ]
        )
        if force or force_trees:
            argv.append("--force-trees")
        stages.append(PreprocessStage(title="Merged PageIndex tree", argv=tuple(argv)))
    return stages


__all__ = [
    "DocumentWorkspace",
    "PreprocessStage",
    "build_preprocess_stages",
    "normalize_document_paths",
    "parse_at_paths",
]
