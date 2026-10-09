"""Finite, versioned Flash provider in an actual bounded document-only process."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import selectors
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from .sandbox_process import SandboxProcess
from .schema_validation import validate_contract_shape
from .tree_index import (
    TreeConfig,
    TreeData,
    TreeGeneration,
    TreeNode,
    TreeOptimization,
    TreeProviderIdentity,
    tree_index_issues,
)

type TreeErrorCode = Literal[
    "invalid-request",
    "not-found",
    "source-integrity",
    "invalid-pdf",
    "unavailable",
    "resource-limit",
    "cancelled",
    "invalid-output",
    "index-integrity",
]


class TreeIndexError(RuntimeError):
    def __init__(self, code: TreeErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class FlashLimits:
    wall_seconds: float = 90
    cpu_seconds: int = 60
    memory_bytes: int = 2 * 1024**3
    max_source_bytes: int = 64 * 1024**2
    max_pages: int = 1000


@dataclass(frozen=True, slots=True)
class FlashResult:
    data: TreeData
    toc_source: Literal["detected", "bookmarks", "hybrid", "disabled"]
    warnings: list[Literal["empty-tree", "no-readable-text"]]
    optimization: TreeOptimization


def canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


class FlashProvider:
    def __init__(
        self, *, limits: FlashLimits = FlashLimits(), bubblewrap: Path = Path("/usr/bin/bwrap")
    ) -> None:
        if (
            not 0 < limits.wall_seconds <= 600
            or not 1 <= limits.cpu_seconds <= 300
            or not 128 * 1024**2 <= limits.memory_bytes <= 4 * 1024**3
            or not 1 <= limits.max_pages <= 10000
            or not 1 <= limits.max_source_bytes <= 512 * 1024**2
        ):
            raise ValueError("Invalid Flash execution limits")
        self.limits = limits
        self._bwrap = bubblewrap
        self._code_root = Path(__file__).resolve().parents[1]
        provenance = Path(__file__).parent / "_vendor/pageindex_flash/provenance.json"
        content = provenance.read_bytes()
        metadata = json.loads(content)
        for name, expected in metadata["outputHashes"].items():
            if hashlib.sha256((provenance.parent / name).read_bytes()).hexdigest() != expected:
                raise TreeIndexError("unavailable", "Flash vendor fingerprint mismatch")
        dependencies = {
            name: importlib.metadata.version(name)
            for name in ("pypdfium2", "PyPDF2", "regex", "sortedcontainers")
        }
        fingerprint = hashlib.sha256(
            canonical(
                {
                    "vendor": hashlib.sha256(content).hexdigest(),
                    "adapter": {
                        name: hashlib.sha256(
                            (Path(__file__).parent / name).read_bytes()
                        ).hexdigest()
                        for name in (
                            "flash_provider.py",
                            "flash_worker.py",
                            "tree_index.py",
                            "process_security.py",
                        )
                    },
                    "dependencies": dependencies,
                    "platform": sys.platform,
                    "arch": platform.machine(),
                }
            )
        ).hexdigest()
        self._identity: TreeProviderIdentity = {
            "name": "pageindex-flash",
            "version": metadata["version"],
            "sourceCommit": metadata["commit"],
            "fingerprint": fingerprint,
        }

    @property
    def identity(self) -> TreeProviderIdentity:
        return self._identity.copy()

    def generation_id(
        self, document_id: str, revision_id: str, source_hash: str, config: TreeConfig
    ) -> str:
        return (
            "tree:"
            + hashlib.sha256(
                canonical(
                    {
                        "documentId": document_id,
                        "revisionId": revision_id,
                        "sourceHash": source_hash,
                        "config": config,
                        "provider": self.identity,
                    }
                )
            ).hexdigest()
        )

    def build(
        self,
        source: Path,
        source_hash: str,
        generation_id: str,
        config: TreeConfig,
        check_cancelled: Callable[[], None] = lambda: None,
        *,
        raw: tuple[Path, TreeGeneration] | None = None,
    ) -> FlashResult:
        if sys.platform != "linux" or not self._bwrap.is_file():
            raise TreeIndexError(
                "unavailable", "Flash requires the configured Linux isolation boundary"
            )
        if source.is_symlink() or source.resolve(strict=True) != source or not source.is_file():
            raise TreeIndexError("source-integrity", "Flash input must be a verified regular asset")
        if source.stat().st_size > self.limits.max_source_bytes:
            raise TreeIndexError(
                "resource-limit",
                "Source exceeds Flash byte limit; original content remains available",
            )
        check_cancelled()
        code = (
            f"import sys,runpy;sys.path.insert(0,{str(self._code_root)!r});"
            "runpy.run_module('docatlas_dsh_sidecar.flash_worker',run_name='__main__')"
        )
        args = [
            str(self._bwrap),
            "--unshare-user",
            "--unshare-pid",
            "--unshare-net",
            "--die-with-parent",
            "--new-session",
            "--tmpfs",
            "/tmp",
        ]
        roots = [
            Path("/usr"),
            Path("/bin"),
            Path("/lib"),
            Path("/lib64"),
            Path(sys.base_prefix),
            Path(sys.prefix),
            self._code_root,
        ]
        for path in dict.fromkeys(roots):
            args.extend(["--ro-bind", str(path), str(path)])
        args.extend(
            [
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--dir",
                "/input",
                "--ro-bind",
                str(source),
                "/input/source.pdf",
                "--chdir",
                "/tmp",
                "--",
                sys.executable,
                "-I",
                "-c",
                code,
            ]
        )
        request = {
            "sourceHash": source_hash,
            "mode": config["mode"],
            "useEmbeddedToc": config["useEmbeddedToc"],
            "maxPages": self.limits.max_pages,
            "memoryBytes": self.limits.memory_bytes,
            "cpuSeconds": self.limits.cpu_seconds,
        }
        if raw is not None:
            raw_path, manifest = raw
            if (
                config["mode"] != "merge"
                or manifest["config"]["mode"] != "raw"
                or manifest["config"]["useEmbeddedToc"] != config["useEmbeddedToc"]
                or manifest["provider"] != self.identity
                or manifest["sourceHash"] != source_hash
                or self.generation_id(
                    manifest["documentId"], manifest["revisionId"], source_hash, config
                )
                != generation_id
                or raw_path.is_symlink()
                or not raw_path.is_file()
                or raw_path.resolve() != raw_path
            ):
                raise TreeIndexError(
                    "source-integrity", "Raw generation is not compatible with this merge"
                )
            position = args.index("--chdir")
            args[position:position] = ["--ro-bind", str(raw_path), "/input/raw.json"]
            request.update(
                {
                    "rawTreeHash": manifest["treeHash"],
                    "rawGenerationId": manifest["generationId"],
                    "rawTocSource": manifest["tocSource"],
                    "rawReadable": "no-readable-text" not in manifest["warnings"],
                }
            )
        deadline = time.monotonic() + self.limits.wall_seconds
        try:
            with SandboxProcess(
                args,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            ) as sandbox:
                process = sandbox.process
                try:
                    assert process.stdin and process.stdout and process.stderr
                    process.stdin.write(canonical(request))
                    process.stdin.close()
                    chunks: list[bytes] = []
                    size = 0
                    stderr_size = 0
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ, True)
                        selector.register(process.stderr, selectors.EVENT_READ, False)
                        while selector.get_map():
                            check_cancelled()
                            if time.monotonic() > deadline:
                                raise TreeIndexError(
                                    "resource-limit", "Flash wall-time limit reached"
                                )
                            for key, _ in selector.select(0.05):
                                chunk = os.read(key.fd, 65536)
                                if not chunk:
                                    selector.unregister(key.fileobj)
                                    continue
                                if key.data:
                                    size += len(chunk)
                                    if size > 16 * 1024**2:
                                        raise TreeIndexError(
                                            "resource-limit", "Flash output exceeds limit"
                                        )
                                    chunks.append(chunk)
                                else:
                                    stderr_size += len(chunk)
                                    if stderr_size > 64 * 1024:
                                        raise TreeIndexError(
                                            "resource-limit", "Flash diagnostics exceed limit"
                                        )
                    code_value = process.wait(timeout=max(0.01, deadline - time.monotonic()))
                    check_cancelled()
                    if code_value != 0:
                        raise TreeIndexError(
                            "resource-limit"
                            if code_value < 0 or code_value >= 128
                            else "unavailable",
                            "Flash worker failed; no tree published",
                        )
                    response = json.loads(b"".join(chunks))
                except BaseException:
                    sandbox.close()
                    raise
        except subprocess.TimeoutExpired as error:
            raise TreeIndexError(
                "resource-limit", "Flash worker did not stop before its deadline"
            ) from error
        except json.JSONDecodeError as error:
            raise TreeIndexError("invalid-output", "Flash output is not valid JSON") from error
        except (OSError, subprocess.SubprocessError) as error:
            raise TreeIndexError("unavailable", "Flash worker could not execute") from error
        if response.get("ok") is not True:
            error_code = response.get("code")
            error_code = (
                error_code
                if error_code
                in {
                    "invalid-pdf",
                    "source-integrity",
                    "resource-limit",
                    "invalid-output",
                    "unavailable",
                }
                else "invalid-output"
            )
            raise TreeIndexError(
                cast(TreeErrorCode, error_code), "Flash did not produce a publishable tree"
            )
        try:
            result = response["result"]
            nodes = _flatten(result["structure"], generation_id)
            data: TreeData = {
                "schemaVersion": 1,
                "kind": "tree-data",
                "generationId": generation_id,
                "pageCount": result["pageCount"],
                "nodes": nodes,
            }
            if validate_contract_shape("tree-index", data) or tree_index_issues(data):
                raise ValueError("invalid tree")
            return FlashResult(
                data, result["tocSource"], result["warnings"], result["optimization"]
            )
        except (ValueError, TypeError, KeyError, RecursionError) as error:
            raise TreeIndexError(
                "invalid-output", "Flash returned invalid navigation data"
            ) from error


def _flatten(structure: list[dict[str, Any]], generation_id: str) -> list[TreeNode]:
    nodes: list[TreeNode] = []
    stack: list[tuple[dict[str, Any], str | None, int]] = [
        (node, None, 0) for node in reversed(structure)
    ]
    while stack:
        node, parent, depth = stack.pop()
        if len(nodes) >= 20000 or depth > 64:
            raise ValueError("Tree exceeds structural limits")
        node_id = f"{generation_id}:n{len(nodes):05d}"
        nodes.append(
            {
                "nodeId": node_id,
                "parentId": parent,
                "title": node["title"],
                "startPage": node["start_index"],
                "endPage": node["end_index"],
                "sourceNodeId": node.get("node_id"),
                "keyItems": node.get("key_items", []),
            }
        )
        stack.extend((child, node_id, depth + 1) for child in reversed(node.get("nodes", [])))
    return nodes
