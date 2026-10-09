"""Revision-bound immutable tree publication; independent of the readable/FTS generation."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from .asset_store import AssetSnapshot, AssetStoreError
from .flash_provider import FlashProvider, TreeIndexError, canonical
from .ingest import DocumentIndexStore
from .schema_validation import validate_contract_shape
from .tree_index import (
    TreeBuildRequest,
    TreeData,
    TreeGeneration,
    TreeIndexValue,
    TreePage,
    TreeReadRequest,
    tree_index_issues,
)


class TreeIndexService:
    def __init__(self, store: DocumentIndexStore, provider: FlashProvider) -> None:
        self._store = store
        self._provider = provider
        self._root = store.cache_root / "tree-generations"
        if self._root.is_symlink():
            raise TreeIndexError("index-integrity", "Tree directory cannot be a symlink")
        self._root.mkdir(mode=0o700, exist_ok=True)
        self._lock = threading.RLock()

    def build(
        self, request: TreeBuildRequest, *, check_cancelled: Callable[[], None] = lambda: None
    ) -> TreeGeneration:
        _validate(request, "build-tree")
        request = cast(TreeBuildRequest, json.loads(canonical(request)))
        with self._lock:
            check_cancelled()
            asset = self._source(
                request["documentId"], request["revisionId"], request["sourceHash"]
            )
            generation_id = self._provider.generation_id(
                request["documentId"],
                request["revisionId"],
                request["sourceHash"],
                request["config"],
            )
            existing = self._load(generation_id)
            if existing is not None:
                if (
                    asset.descriptor["byteLength"] > self._provider.limits.max_source_bytes
                    or existing[0]["pageCount"] > self._provider.limits.max_pages
                ):
                    raise TreeIndexError(
                        "resource-limit", "Cached tree exceeds current operation limits"
                    )
                self._require_identity(
                    existing[0], request["documentId"], request["revisionId"], request["sourceHash"]
                )
                return existing[0]
            parent: str | None = None
            raw_input: tuple[Path, TreeGeneration] | None = None
            if request["config"]["mode"] == "merge":
                raw: TreeBuildRequest = {**request, "config": {**request["config"], "mode": "raw"}}
                raw_manifest = self.build(raw, check_cancelled=check_cancelled)
                parent = raw_manifest["generationId"]
                raw_input = (self._path(parent) / "data.json", raw_manifest)
            result = self._provider.build(
                asset.content_path,
                request["sourceHash"],
                generation_id,
                request["config"],
                check_cancelled,
                raw=raw_input,
            )
            check_cancelled()
            self._source(request["documentId"], request["revisionId"], request["sourceHash"])
            data = canonical(result.data)
            if len(data) > 16 * 1024**2:
                raise TreeIndexError("resource-limit", "Tree data exceeds publication limit")
            manifest: TreeGeneration = {
                "schemaVersion": 1,
                "kind": "tree-generation",
                "documentId": request["documentId"],
                "revisionId": request["revisionId"],
                "sourceHash": request["sourceHash"],
                "generationId": generation_id,
                "parentGenerationId": parent,
                "config": request["config"],
                "provider": self._provider.identity.copy(),
                "status": "ready" if result.data["nodes"] else "empty",
                "pageCount": result.data["pageCount"],
                "nodeCount": len(result.data["nodes"]),
                "treeHash": hashlib.sha256(data).hexdigest(),
                "createdAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "tocSource": result.toc_source,
                "warnings": result.warnings,
                "optimization": result.optimization,
            }
            _validate(manifest, "tree-generation")
            temporary = Path(tempfile.mkdtemp(prefix=".building-", dir=self._root))
            try:
                _write(temporary / "data.json", data)
                manifest_bytes = canonical(manifest)
                _write(temporary / "manifest.json", manifest_bytes)
                _write(
                    temporary / "seal.json",
                    canonical(
                        {
                            "schemaVersion": 1,
                            "manifestHash": hashlib.sha256(manifest_bytes).hexdigest(),
                        }
                    ),
                )
                _sync_directory(temporary)
                check_cancelled()
                try:
                    os.rename(temporary, self._path(generation_id))
                except OSError:
                    existing = self._load(generation_id)
                    if existing is None or existing[0]["treeHash"] != manifest["treeHash"]:
                        raise TreeIndexError(
                            "index-integrity", "Conflicting tree generation publication"
                        ) from None
                    return existing[0]
                _sync_directory(self._root)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
            return manifest

    def read(self, request: TreeReadRequest) -> TreePage:
        _validate(request, "read-tree")
        request = cast(TreeReadRequest, json.loads(canonical(request)))
        with self._lock:
            self._source(request["documentId"], request["revisionId"], request["sourceHash"])
            snapshot = self._load(request["generationId"])
            if snapshot is None:
                raise TreeIndexError("not-found", "Tree generation not found")
            manifest, data = snapshot
            self._require_identity(
                manifest, request["documentId"], request["revisionId"], request["sourceHash"]
            )
            start = request["offset"]
            if start > len(data["nodes"]):
                raise TreeIndexError("invalid-request", "Tree offset exceeds node count")
            nodes = data["nodes"][start : start + request["limit"]]
            end = start + len(nodes)
            result: TreePage = {
                "schemaVersion": 1,
                "kind": "tree-page",
                "generationId": manifest["generationId"],
                "treeHash": manifest["treeHash"],
                "offset": start,
                "total": len(data["nodes"]),
                "nextOffset": end if end < len(data["nodes"]) else None,
                "nodes": nodes,
            }
            _validate(result, "tree-page")
            return result

    def _source(self, document_id: str, revision_id: str, source_hash: str) -> AssetSnapshot:
        snapshot = self._store.current_snapshot(document_id, revision_id)
        if snapshot is None:
            raise TreeIndexError("not-found", "Source revision is not ingested")
        original = next(
            (
                item
                for item in snapshot.manifest["result"]["representations"]
                if item["kind"] == "original-bytes"
            ),
            None,
        )
        if (
            original is None
            or original["contentHash"] != source_hash
            or original["mediaType"] != "application/pdf"
        ):
            raise TreeIndexError("source-integrity", "Tree source does not match the PDF revision")
        try:
            asset = self._store.asset_store.snapshot(original["representationId"])
        except AssetStoreError as error:
            raise TreeIndexError("source-integrity", "Original PDF asset is invalid") from error
        if (
            asset is None
            or asset.descriptor["documentId"] != document_id
            or asset.descriptor["revisionId"] != revision_id
            or asset.descriptor["contentHash"] != source_hash
        ):
            raise TreeIndexError(
                "source-integrity", "Original PDF asset is unavailable or mismatched"
            )
        return asset

    def _path(self, generation_id: str) -> Path:
        if not re.fullmatch(r"tree:[a-f0-9]{64}", generation_id):
            raise TreeIndexError("invalid-request", "Invalid tree generation ID")
        return self._root / generation_id[5:]

    def _load(self, generation_id: str) -> tuple[TreeGeneration, TreeData] | None:
        path = self._path(generation_id)
        if not path.exists() and not path.is_symlink():
            return None
        try:
            if path.is_symlink() or not path.is_dir():
                raise ValueError("Invalid tree directory")
            values = []
            for name, limit in (
                ("manifest.json", 65536),
                ("data.json", 16 * 1024**2),
                ("seal.json", 1024),
            ):
                file = path / name
                if file.is_symlink() or not file.is_file() or file.stat().st_size > limit:
                    raise ValueError("Invalid tree file")
                values.append(file.read_bytes())
            manifest = cast(TreeGeneration, json.loads(values[0]))
            data = cast(TreeData, json.loads(values[1]))
            seal = json.loads(values[2])
            if seal != {"schemaVersion": 1, "manifestHash": hashlib.sha256(values[0]).hexdigest()}:
                raise ValueError("Tree metadata seal changed")
            _validate(manifest, "tree-generation")
            _validate(data, "tree-data")
            expected_id = (
                "tree:"
                + hashlib.sha256(
                    canonical(
                        {
                            "documentId": manifest["documentId"],
                            "revisionId": manifest["revisionId"],
                            "sourceHash": manifest["sourceHash"],
                            "config": manifest["config"],
                            "provider": manifest["provider"],
                        }
                    )
                ).hexdigest()
            )
            expected_parent = None
            if manifest["config"]["mode"] == "merge":
                expected_parent = (
                    "tree:"
                    + hashlib.sha256(
                        canonical(
                            {
                                "documentId": manifest["documentId"],
                                "revisionId": manifest["revisionId"],
                                "sourceHash": manifest["sourceHash"],
                                "config": {**manifest["config"], "mode": "raw"},
                                "provider": manifest["provider"],
                            }
                        )
                    ).hexdigest()
                )
            if (
                expected_id != generation_id
                or manifest["parentGenerationId"] != expected_parent
                or manifest["generationId"] != generation_id
                or data["generationId"] != generation_id
                or manifest["treeHash"] != hashlib.sha256(values[1]).hexdigest()
                or manifest["nodeCount"] != len(data["nodes"])
                or manifest["pageCount"] != data["pageCount"]
            ):
                raise ValueError("Tree manifest/data binding changed")
            return manifest, data
        except (OSError, ValueError, KeyError, TypeError, TreeIndexError) as error:
            raise TreeIndexError(
                "index-integrity", "Tree generation failed integrity checks"
            ) from error

    @staticmethod
    def _require_identity(
        manifest: TreeGeneration, document_id: str, revision_id: str, source_hash: str
    ) -> None:
        if (manifest["documentId"], manifest["revisionId"], manifest["sourceHash"]) != (
            document_id,
            revision_id,
            source_hash,
        ):
            raise TreeIndexError(
                "source-integrity", "Tree generation belongs to another source revision"
            )


def _validate(value: TreeIndexValue, kind: str) -> None:
    if (
        validate_contract_shape("tree-index", value)
        or value.get("kind") != kind
        or tree_index_issues(value)
    ):
        raise TreeIndexError("invalid-request", f"Invalid {kind} contract")


def _write(path: Path, content: bytes) -> None:
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
