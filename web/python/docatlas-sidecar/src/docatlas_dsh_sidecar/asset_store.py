"""Immutable, path-free binary assets shared by the sidecar and authenticated Host."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from .contracts import AssetDescriptor, asset_descriptor_issues
from .schema_validation import validate_contract_shape

ASSET_DESCRIPTOR_FILE = "descriptor.json"
ASSET_CONTENT_FILE = "content.bin"
MAX_ASSET_DESCRIPTOR_BYTES = 64 * 1024
type CancellationCheck = Callable[[], None]
type PublishHook = Callable[[str, Path], None]


class AssetStoreError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class AssetSnapshot:
    descriptor: AssetDescriptor
    content_path: Path


class AssetStore:
    def __init__(
        self,
        cache_root: Path,
        *,
        publish_hook: PublishHook | None = None,
    ) -> None:
        self.root = cache_root.resolve() / "assets"
        self.root.mkdir(parents=True, exist_ok=True)
        _restrict_directory(self.root)
        self._publish_hook = publish_hook
        self._lock = threading.RLock()

    def publish_file(
        self,
        descriptor: AssetDescriptor,
        source: Path,
        *,
        check_cancelled: CancellationCheck | None = None,
    ) -> AssetSnapshot:
        check = check_cancelled or _not_cancelled
        self._validate_descriptor(descriptor)
        target = self._target(descriptor["assetId"])
        with self._lock:
            check()
            if target.exists():
                return self._require_compatible(target, descriptor)
            temporary = Path(tempfile.mkdtemp(prefix=".building-", dir=self.root))
            _restrict_directory(temporary)
            try:
                digest = hashlib.sha256()
                byte_length = 0
                content_path = temporary / ASSET_CONTENT_FILE
                with source.open("rb") as input_stream, content_path.open("xb") as output_stream:
                    _restrict_file(content_path)
                    for chunk in iter(lambda: input_stream.read(1024 * 1024), b""):
                        check()
                        output_stream.write(chunk)
                        digest.update(chunk)
                        byte_length += len(chunk)
                    output_stream.flush()
                    os.fsync(output_stream.fileno())
                if byte_length != descriptor["byteLength"]:
                    raise AssetStoreError("asset byte length does not match descriptor")
                if digest.hexdigest() != descriptor["contentHash"]:
                    raise AssetStoreError("asset content hash does not match descriptor")
                descriptor_bytes = _canonical_json(descriptor)
                descriptor_path = temporary / ASSET_DESCRIPTOR_FILE
                _write_durable(descriptor_path, descriptor_bytes)
                _restrict_file(descriptor_path)
                _fsync_directory(temporary)
                self._hook("before-asset-publish", temporary)
                check()
                try:
                    os.replace(temporary, target)
                except OSError:
                    if not target.exists():
                        raise
                    return self._require_compatible(target, descriptor)
                _fsync_directory(self.root)
                return self._snapshot_at(target)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)

    def snapshot(self, asset_id: str) -> AssetSnapshot | None:
        with self._lock:
            target = self._target(asset_id)
            if not target.exists():
                return None
            snapshot = self._snapshot_at(target)
            if snapshot.descriptor["assetId"] != asset_id:
                raise AssetStoreError("asset descriptor identity mismatch")
            return snapshot

    def _target(self, asset_id: str) -> Path:
        key = hashlib.sha256(asset_id.encode()).hexdigest()
        return self.root / key

    def _snapshot_at(self, target: Path) -> AssetSnapshot:
        if target.is_symlink() or not target.is_dir():
            raise AssetStoreError("asset entry is not an immutable directory")
        descriptor_path = target / ASSET_DESCRIPTOR_FILE
        content_path = target / ASSET_CONTENT_FILE
        if descriptor_path.is_symlink() or content_path.is_symlink():
            raise AssetStoreError("asset entry contains a symbolic link")
        try:
            descriptor_bytes = descriptor_path.read_bytes()
        except OSError as error:
            raise AssetStoreError("asset descriptor is unreadable") from error
        if len(descriptor_bytes) > MAX_ASSET_DESCRIPTOR_BYTES:
            raise AssetStoreError("asset descriptor exceeds its byte limit")
        try:
            candidate = json.loads(descriptor_bytes)
        except json.JSONDecodeError as error:
            raise AssetStoreError("asset descriptor is not JSON") from error
        if not isinstance(candidate, dict):
            raise AssetStoreError("asset descriptor must be an object")
        descriptor = cast(AssetDescriptor, candidate)
        self._validate_descriptor(descriptor)
        stat = content_path.stat()
        if not content_path.is_file() or stat.st_size != descriptor["byteLength"]:
            raise AssetStoreError("asset content size mismatch")
        if _file_hash(content_path) != descriptor["contentHash"]:
            raise AssetStoreError("asset content hash mismatch")
        return AssetSnapshot(descriptor, content_path)

    def _require_compatible(self, target: Path, expected: AssetDescriptor) -> AssetSnapshot:
        snapshot = self._snapshot_at(target)
        if _immutable_fields(snapshot.descriptor) != _immutable_fields(expected):
            raise AssetStoreError("asset id conflicts with an existing descriptor")
        return snapshot

    def _validate_descriptor(self, descriptor: AssetDescriptor) -> None:
        issues = validate_contract_shape("asset-descriptor", descriptor)
        semantic = asset_descriptor_issues(descriptor)
        if issues:
            raise AssetStoreError(f"invalid asset descriptor: {issues[0].message}")
        if semantic:
            raise AssetStoreError(f"invalid asset descriptor: {semantic[0].message}")
        if len(_canonical_json(descriptor)) > MAX_ASSET_DESCRIPTOR_BYTES:
            raise AssetStoreError("asset descriptor exceeds its byte limit")

    def _hook(self, stage: str, path: Path) -> None:
        if self._publish_hook is not None:
            self._publish_hook(stage, path)


def _immutable_fields(descriptor: AssetDescriptor) -> dict[str, object]:
    return {key: value for key, value in descriptor.items() if key != "createdAt"}


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _write_durable(path: Path, content: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _restrict_directory(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o700)


def _restrict_file(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o600)


def _not_cancelled() -> None:
    return None


__all__ = [
    "ASSET_CONTENT_FILE",
    "ASSET_DESCRIPTOR_FILE",
    "AssetSnapshot",
    "AssetStore",
    "AssetStoreError",
]
