"""Finite-source vendoring with exact, fingerprinted local patches; no fuzzy edits."""

from __future__ import annotations

import argparse
import ast
import builtins
import hashlib
import json
import os
import stat
import subprocess
import symtable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "ae169566b3148792776531d987f543edcad92321"
TARGET = (
    ROOT / "python/docatlas-sidecar/src/docatlas_dsh_sidecar/_vendor/pageindex_flash"
)
PATCH_MANIFEST = ROOT / "compat/pageindex-flash/numbered-headings.patch.json"
PATCH_TARGETS = {"flash/main.py", "flash/embedded_toc.py"}
PATCH_ADDITION = "flash/_docatlas_numbered.py"
PATCH_SOURCE = "compat/pageindex-flash/numbered_headings.py"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_pinned_file(source: Path, relative: str) -> bytes:
    """Open only regular files under the captured checkout, never following symlinks."""
    parts = Path(relative).parts
    if (
        not parts
        or any(part in {"", ".", ".."} for part in parts)
        or Path(relative).is_absolute()
    ):
        raise RuntimeError("Invalid pinned source path")
    directory = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = child
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise RuntimeError("Pinned source must be a regular file")
            content = stream.read(16 * 1024**2 + 1)
            if len(content) > 16 * 1024**2:
                raise RuntimeError("Pinned source exceeds the reviewed byte limit")
            return content
    finally:
        os.close(directory)


def verified_sources(source: Path, commit: str = COMMIT) -> dict[str, bytes]:
    """Capture clean working bytes that exactly match the selected pinned Git blobs."""
    if source.is_symlink() or source.resolve() != source:
        raise RuntimeError("PageIndex checkout cannot be a symlink")
    actual = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual != commit:
        raise RuntimeError(
            "Review Flash vendor selection before changing its source pin"
        )
    dirty = subprocess.check_output(
        [
            "git",
            "-C",
            str(source),
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "-z",
        ]
    )
    if dirty:
        raise RuntimeError("PageIndex source checkout must be clean before vendoring")
    tree = subprocess.check_output(
        [
            "git",
            "-C",
            str(source),
            "ls-tree",
            "-rz",
            "--full-tree",
            commit,
            "--",
            "pageindex/flash",
            "pageindex/tree_optimize.py",
            "pageindex/utils.py",
            "LICENSE",
        ]
    )
    selected: dict[str, str] = {}
    for record in tree.split(b"\0"):
        if not record:
            continue
        metadata, _, raw_name = record.partition(b"\t")
        mode, kind, oid = metadata.decode("ascii").split()
        name = raw_name.decode("utf-8")
        path = Path(name)
        if name.startswith("pageindex/flash/") and (
            path.suffix not in {".py", ".json"} or "__pycache__" in path.parts
        ):
            continue
        if mode not in {"100644", "100755"} or kind != "blob" or len(oid) != 40:
            raise RuntimeError("Pinned source tree contains an unsupported object")
        selected[name] = oid
    required = {"LICENSE", "pageindex/tree_optimize.py", "pageindex/utils.py"}
    if not required <= selected.keys():
        raise RuntimeError("Pinned source tree is incomplete")
    flash_root = source / "pageindex/flash"
    if flash_root.is_symlink() or flash_root.resolve() != flash_root:
        raise RuntimeError("Flash input directory cannot contain symlinks")
    observed: set[str] = set()
    for directory, names, files in os.walk(flash_root, followlinks=False):
        parent = Path(directory)
        if any((parent / name).is_symlink() for name in [*names, *files]):
            raise RuntimeError("Flash input directory cannot contain symlinks")
        names[:] = [name for name in names if name != "__pycache__"]
        for name in files:
            path = parent / name
            if path.suffix in {".py", ".json"}:
                observed.add(path.relative_to(source).as_posix())
    if observed != {name for name in selected if name.startswith("pageindex/flash/")}:
        raise RuntimeError("Flash input file set differs from the pinned Git tree")
    result = {}
    for name, oid in selected.items():
        content = _read_pinned_file(source, name)
        # Git's pinned repository uses SHA-1 object identities; published provenance
        # and generated/provider fingerprints continue to use SHA-256.
        blob = b"blob " + str(len(content)).encode() + b"\0" + content
        if hashlib.sha1(blob).hexdigest() != oid:
            raise RuntimeError("Source bytes differ from the pinned Git blob")
        result[name] = content
    return result


def functions(content: bytes, seeds: set[str]) -> tuple[bytes, list[str]]:
    text = content.decode("utf-8")
    module = ast.parse(text)
    definitions = {
        node.name: node for node in module.body if isinstance(node, ast.FunctionDef)
    }
    selected = set(seeds)
    while True:
        dependencies = {
            node.id
            for name in selected
            for node in ast.walk(definitions[name])
            if isinstance(node, ast.Name) and node.id in definitions
        }
        next_selected = selected | dependencies
        if next_selected == selected:
            break
        selected = next_selected
    if selected & {"ask_model", "default_model", "optimize_tree", "load_pages"}:
        raise RuntimeError("Deterministic closure acquired a model/I/O dependency")
    lines = text.splitlines(keepends=True)
    bodies = [
        "".join(lines[node.lineno - 1 : node.end_lineno])
        for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name in selected
    ]
    return ("\n\n".join(bodies) + "\n").encode(), sorted(selected)


def apply_reviewed_patch(
    outputs: dict[str, bytes], manifest_path: Path = PATCH_MANIFEST
) -> dict[str, object]:
    """Replay one allowlisted patch entirely in memory before any generated writes."""
    raw = manifest_path.read_bytes()
    patch = json.loads(raw)
    if (
        set(patch)
        != {"schemaVersion", "id", "sourceCommit", "reason", "files", "addition"}
        or patch["schemaVersion"] != 1
        or patch["id"] != "docatlas-numbered-headings-v1"
        or patch["sourceCommit"] != COMMIT
        or not isinstance(patch["reason"], str)
    ):
        raise RuntimeError("Unreviewed Flash patch manifest")
    if (
        not isinstance(patch["files"], list)
        or len(patch["files"]) != len(PATCH_TARGETS)
        or {item.get("path") for item in patch["files"]} != PATCH_TARGETS
    ):
        raise RuntimeError("Unreviewed Flash patch targets")
    transformed: dict[str, bytes] = {}
    recorded = []
    for item in patch["files"]:
        if set(item) != {"path", "upstreamSha256", "outputSha256", "replacements"}:
            raise RuntimeError("Unreviewed Flash patch fields")
        content = outputs[item["path"]]
        if digest(content) != item["upstreamSha256"]:
            raise RuntimeError(
                f"Flash patch upstream fingerprint changed: {item['path']}"
            )
        if (
            not isinstance(item["replacements"], list)
            or not 1 <= len(item["replacements"]) <= 4
        ):
            raise RuntimeError("Unreviewed Flash patch replacement count")
        for replacement in item["replacements"]:
            if set(replacement) != {"before", "after"}:
                raise RuntimeError("Unreviewed Flash patch replacement")
            for lines in replacement.values():
                if (
                    not isinstance(lines, list)
                    or not 1 <= len(lines) <= 100
                    or not all(
                        isinstance(line, str) and "\n" not in line and "\r" not in line
                        for line in lines
                    )
                ):
                    raise RuntimeError("Invalid Flash patch lines")
            before = ("\n".join(replacement["before"]) + "\n").encode()
            after = ("\n".join(replacement["after"]) + "\n").encode()
            if content.count(before) != 1:
                raise RuntimeError(
                    f"Flash patch must match exactly once: {item['path']}"
                )
            content = content.replace(before, after, 1)
        if digest(content) != item["outputSha256"]:
            raise RuntimeError(
                f"Flash patch output fingerprint changed: {item['path']}"
            )
        ast.parse(content)
        transformed[item["path"]] = content
        recorded.append(
            {key: item[key] for key in ("path", "upstreamSha256", "outputSha256")}
        )
    addition = patch["addition"]
    if (
        set(addition) != {"path", "source", "sha256"}
        or addition["path"] != PATCH_ADDITION
        or addition["source"] != PATCH_SOURCE
        or PATCH_ADDITION in outputs
    ):
        raise RuntimeError("Unreviewed Flash patch addition")
    source_path = ROOT / PATCH_SOURCE
    if source_path.is_symlink() or source_path.resolve() != source_path:
        raise RuntimeError("Flash patch source must be a regular reviewed file")
    helper = source_path.read_bytes()
    if digest(helper) != addition["sha256"]:
        raise RuntimeError("Flash patch helper fingerprint changed")
    for node in ast.walk(ast.parse(helper)):
        names = (
            [alias.name.split(".")[0] for alias in node.names]
            if isinstance(node, ast.Import)
            else [node.module.split(".")[0] if node.module else ""]
            if isinstance(node, ast.ImportFrom)
            else []
        )
        if any(
            name
            not in {
                "__future__",
                "re",
                "unicodedata",
                "collections",
                "itertools",
                "typing",
            }
            for name in names
        ):
            raise RuntimeError("Flash patch helper acquired an unreviewed dependency")
    transformed[PATCH_ADDITION] = helper
    outputs.update(transformed)
    return {
        "id": patch["id"],
        "manifest": PATCH_MANIFEST.relative_to(ROOT).as_posix(),
        "manifestSha256": digest(raw),
        "files": recorded,
        "addition": addition,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = ROOT / ".sources/pageindex"
    inputs = verified_sources(source)
    outputs: dict[str, bytes] = {}
    originals: dict[str, str] = {}
    for name, content in sorted(inputs.items()):
        if not name.startswith("pageindex/flash/"):
            continue
        relative = Path(name).relative_to("pageindex").as_posix()
        if relative in {"flash/api.py", "flash/__init__.py"}:
            continue
        outputs[relative] = content
        originals[relative] = digest(outputs[relative])
    outputs["flash/__init__.py"] = (
        b'"""Pinned raw Flash pipeline; public model/summary API intentionally not imported."""\n'
    )
    outputs["__init__.py"] = (
        b'"""Finite PageIndex Flash vendor. See LICENSE and provenance.json."""\n'
    )
    outputs["LICENSE"] = inputs["LICENSE"]
    optimization, names = functions(
        inputs["pageindex/tree_optimize.py"],
        {"merge", "merge_same_page", "relabel", "complexity", "validate"},
    )
    stripping, _ = functions(inputs["pageindex/utils.py"], {"strip_internal_keys"})
    tree_source = inputs["pageindex/tree_optimize.py"].decode("utf-8")
    tree_lines = tree_source.splitlines(keepends=True)
    constants = []
    for entry in ast.parse(tree_source).body:
        if isinstance(entry, ast.Assign) and any(
            isinstance(target, ast.Name)
            and target.id in {"ROUTING_COST", "TITLE_MAX_CHARS"}
            for target in entry.targets
        ):
            constants.append("".join(tree_lines[entry.lineno - 1 : entry.end_lineno]))
    if len(constants) != 2:
        raise RuntimeError("Optimizer constants changed; review required")
    outputs["deterministic.py"] = (
        b'"""Exact deterministic function closure from pinned PageIndex; generated, do not edit."""\n'
        b"import re\nimport sys\n"
        + "".join(constants).encode()
        + b"\n"
        + optimization
        + b"\n"
        + stripping
    )
    symbols = symtable.symtable(
        outputs["deterministic.py"].decode(), "deterministic.py", "exec"
    )
    allowed = set(symbols.get_identifiers()) | set(vars(builtins))
    tables = list(symbols.get_children())
    while tables:
        table = tables.pop()
        for symbol in table.get_symbols():
            if (
                symbol.is_referenced()
                and symbol.is_global()
                and symbol.get_name() not in allowed
            ):
                raise RuntimeError(
                    f"Unreviewed deterministic dependency: {symbol.get_name()}"
                )
        tables.extend(table.get_children())
    local_patch = apply_reviewed_patch(outputs)
    provenance = {
        "schemaVersion": 1,
        "upstream": "https://github.com/VectifyAI/PageIndex",
        "commit": COMMIT,
        "version": "0.2.10",
        "license": "MIT",
        "copiedSourceHashes": originals,
        "extraction": {
            "tree_optimize.py": {
                "sha256": digest(inputs["pageindex/tree_optimize.py"]),
                "functions": names,
            },
            "utils.py": {
                "sha256": digest(inputs["pageindex/utils.py"]),
                "functions": ["strip_internal_keys"],
            },
        },
        "adjustments": [
            "empty Flash initializer; omit public summary/chat API",
            "exact deterministic function closure with only stdlib imports/constants",
            "reviewed source-backed numbered-heading and bookmark guards; exact local patch",
        ],
        "localPatches": [local_patch],
        "outputHashes": {name: digest(data) for name, data in outputs.items()},
    }
    outputs["provenance.json"] = (
        json.dumps(provenance, indent=2, ensure_ascii=False) + "\n"
    ).encode()
    for name, data in outputs.items():
        path = TARGET / name
        if args.check:
            if not path.is_file() or path.read_bytes() != data:
                raise RuntimeError(f"Flash vendor drift: {name}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    extras = {
        path.relative_to(TARGET).as_posix()
        for path in TARGET.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    } - set(outputs)
    if extras:
        raise RuntimeError(f"Unreviewed vendor files: {sorted(extras)}")
    print(
        f"Flash {COMMIT[:7]}: {len(outputs)} files, {len(names)} deterministic functions {'verified' if args.check else 'generated'}"
    )


if __name__ == "__main__":
    main()
