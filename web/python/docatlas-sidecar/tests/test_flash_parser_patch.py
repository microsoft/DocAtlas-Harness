from __future__ import annotations

import ast
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import runpy
from pathlib import Path

import pytest

from docatlas_dsh_sidecar.flash_provider import FlashProvider

ROOT = Path(__file__).resolve().parents[3]
GENERATOR = runpy.run_path(str(ROOT / "scripts/vendor_flash.py"))
MANIFEST = ROOT / "compat/pageindex-flash/pypdf-backend.patch.json"


def originals() -> dict[str, bytes]:
    return {
        path: (ROOT / ".sources/pageindex/pageindex" / path).read_bytes()
        for path in GENERATOR["PDF_PARSER_TARGETS"]
    }


def test_reviewed_parser_imports_preserve_every_function_and_class() -> None:
    source = originals()
    output = source.copy()
    result = GENERATOR["apply_reviewed_pdf_parser_patch"](output)
    assert result["id"] == "docatlas-pypdf-backend-v1"
    assert len(result["files"]) == 5
    for name, content in output.items():
        before, after = ast.parse(source[name]), ast.parse(content)
        for kind in (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef):
            assert [ast.dump(node) for node in ast.walk(before) if isinstance(node, kind)] == [
                ast.dump(node) for node in ast.walk(after) if isinstance(node, kind)
            ]
        for node in ast.walk(after):
            if isinstance(node, ast.Import):
                assert all(alias.name != "PyPDF2" for alias in node.names)
            if isinstance(node, ast.ImportFrom):
                assert node.module != "PyPDF2.generic"
        generated = (
            ROOT / "python/docatlas-sidecar/src/docatlas_dsh_sidecar/_vendor/pageindex_flash"
        )
        assert (generated / name).read_bytes() == content


@pytest.mark.parametrize(
    "mutation",
    [
        "root",
        "schema",
        "id",
        "commit",
        "reason",
        "extra",
        "files-type",
        "missing",
        "duplicate",
        "foreign",
        "path-type",
        "item-type",
        "item-extra",
        "upstream",
        "output",
    ],
)
def test_unreviewed_parser_patch_is_atomic_and_fails_closed(tmp_path: Path, mutation: str) -> None:
    patch = json.loads(MANIFEST.read_bytes())
    if mutation == "root":
        patch = []
    elif mutation == "schema":
        patch["schemaVersion"] = 2
    elif mutation == "id":
        patch["id"] = "unreviewed"
    elif mutation == "commit":
        patch["sourceCommit"] = "0" * 40
    elif mutation == "reason":
        patch["reason"] = None
    elif mutation == "extra":
        patch["extra"] = True
    elif mutation == "files-type":
        patch["files"] = {}
    elif mutation == "missing":
        patch["files"].pop()
    elif mutation == "duplicate":
        patch["files"][-1] = copy.deepcopy(patch["files"][0])
    elif mutation == "foreign":
        patch["files"][0]["path"] = "../outside.py"
    elif mutation == "path-type":
        patch["files"][0]["path"] = []
    elif mutation == "item-type":
        patch["files"][0] = None
    elif mutation == "item-extra":
        patch["files"][0]["replacements"] = []
    else:
        patch["files"][-1][f"{mutation}Sha256"] = "0" * 64
    path = tmp_path / "patch.json"
    path.write_text(json.dumps(patch))
    output = originals()
    before = output.copy()
    with pytest.raises(RuntimeError):
        GENERATOR["apply_reviewed_pdf_parser_patch"](output, path)
    assert output == before


def test_import_occurrence_count_cannot_be_relaxed_by_changing_manifest_hashes(
    tmp_path: Path,
) -> None:
    patch = json.loads(MANIFEST.read_bytes())
    output = originals()
    item = patch["files"][0]
    output[item["path"]] += GENERATOR["PDF_PARSER_REPLACEMENTS"][0][0]
    item["upstreamSha256"] = hashlib.sha256(output[item["path"]]).hexdigest()
    path = tmp_path / "patch.json"
    path.write_text(json.dumps(patch))
    with pytest.raises(RuntimeError, match="import count"):
        GENERATOR["apply_reviewed_pdf_parser_patch"](output, path)


def test_matching_output_hash_does_not_authorize_algorithm_edits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    apply_parser = GENERATOR["apply_reviewed_pdf_parser_patch"]
    replacements = list(GENERATOR["PDF_PARSER_REPLACEMENTS"])
    before, after = replacements[0]
    replacements[0] = (before, after + b"UNREVIEWED_ALGORITHM = True\n")
    monkeypatch.setitem(apply_parser.__globals__, "PDF_PARSER_REPLACEMENTS", tuple(replacements))
    patch = json.loads(MANIFEST.read_bytes())
    output = originals()
    item = patch["files"][0]
    altered = output[item["path"]].replace(*replacements[0])
    item["outputSha256"] = hashlib.sha256(altered).hexdigest()
    path = tmp_path / "patch.json"
    path.write_text(json.dumps(patch))
    with pytest.raises(RuntimeError, match="algorithm"):
        apply_parser(output, path)


def test_parser_version_participates_in_new_generation_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FlashProvider()
    actual_version = importlib.metadata.version
    monkeypatch.setattr(
        importlib.metadata,
        "version",
        lambda name: actual_version(name) + "+changed" if name == "pypdf" else actual_version(name),
    )
    changed = FlashProvider()
    assert provider.identity["sourceCommit"] == changed.identity["sourceCommit"]
    assert provider.identity["fingerprint"] != changed.identity["fingerprint"]
    config = {"mode": "raw", "useEmbeddedToc": True, "workers": 1}
    assert provider.generation_id(
        "doc:test", "rev:test", "a" * 64, config
    ) != changed.generation_id("doc:test", "rev:test", "a" * 64, config)


def test_unmaintained_parser_is_not_an_installed_runtime_dependency() -> None:
    assert importlib.util.find_spec("PyPDF2") is None
    assert importlib.metadata.version("pypdf") == "6.19.0"
