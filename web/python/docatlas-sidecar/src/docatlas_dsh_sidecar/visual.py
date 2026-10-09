"""Bounded PDFium page rendering into immutable DocAtlas assets."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import os
import struct
import tempfile
import threading
import unicodedata
import zlib
from collections.abc import Callable
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from typing import Any, BinaryIO, Literal, cast

from .asset_store import AssetSnapshot, AssetStore, AssetStoreError
from .contracts import AssetDescriptor, RatioBBoxSelector
from .document_rpc import SourceIdentity
from .pdf_isolation import PdfWorkerError, call_pdf

MAX_VISUAL_PIXELS = 40_000_000
MAX_VISUAL_BYTES = 32 * 1024 * 1024
DEFAULT_VISUAL_PIXELS = 2_000_000
MAX_IMAGE_DIMENSION = 32_768
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_ENCODER_VERSION = "png-rgb-zlib-v1"
type CancellationCheck = Callable[[], None]


class VisualRenderError(RuntimeError):
    def __init__(
        self,
        code: Literal[
            "invalid-request", "not-found", "unavailable", "limit-exceeded", "integrity-error"
        ],
        message: str,
    ) -> None:
        super().__init__(message)
        self.code = code


class VisualRenderer:
    def __init__(self, cache_root: Path, asset_store: AssetStore) -> None:
        self._asset_store = asset_store
        self._keys_root = cache_root.resolve() / "render-keys"
        self._keys_root.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            self._keys_root.chmod(0o700)
        self._lock = threading.RLock()

    def render_page(
        self,
        source: SourceIdentity,
        representation_hash: str,
        original_asset_id: str,
        physical_page: int,
        max_pixels: int,
        *,
        check_cancelled: CancellationCheck | None = None,
    ) -> AssetSnapshot:
        check = check_cancelled or _not_cancelled
        if max_pixels < 1 or max_pixels > MAX_VISUAL_PIXELS:
            raise VisualRenderError("invalid-request", "visual pixel limit is invalid")
        config_hash = _json_hash(
            {
                "renderer": "pypdfium2",
                "version": version("pypdfium2"),
                "encoder": _ENCODER_VERSION,
                "maxPixels": max_pixels,
                "maxDimension": MAX_IMAGE_DIMENSION,
            }
        )
        request_key = _json_hash(
            {
                **source,
                "representationContentHash": representation_hash,
                "physicalPage": physical_page,
                "configHash": config_hash,
            }
        )
        with self._lock:
            check()
            cached = self._cached(
                request_key, source, representation_hash, physical_page, config_hash
            )
            if cached is not None:
                return cached
            try:
                original = self._asset_store.snapshot(original_asset_id)
            except AssetStoreError as error:
                raise VisualRenderError(
                    "integrity-error", "original PDF asset is corrupt"
                ) from error
            if original is None or original.descriptor["mediaType"] != "application/pdf":
                raise VisualRenderError("unavailable", "visual Read requires an indexed PDF asset")
            return self._render_and_publish(
                request_key,
                source,
                representation_hash,
                physical_page,
                max_pixels,
                config_hash,
                original,
                check,
            )

    def locate_text(
        self,
        original_asset_id: str,
        physical_page: int,
        exact: str,
    ) -> RatioBBoxSelector | None:
        """Resolve one unique text range to a top-left ratio box on the original PDF page."""
        try:
            original = self._asset_store.snapshot(original_asset_id)
        except AssetStoreError:
            return None
        if original is None or original.descriptor["mediaType"] != "application/pdf":
            return None
        try:
            result = call_pdf(
                original.content_path,
                original.descriptor["contentHash"],
                "locate",
                {"physicalPage": physical_page, "exact": exact},
                _not_cancelled,
            )
        except PdfWorkerError:
            return None  # Keep text/page fallback; never invent a box after worker failure.
        if result is None:
            return None
        if not isinstance(result, dict) or set(result) != {
            "type",
            "unit",
            "x",
            "y",
            "width",
            "height",
            "rotation",
        }:
            raise VisualRenderError("integrity-error", "Invalid PDF geometry response")
        if result["type"] != "bbox" or result["unit"] != "ratio" or result["rotation"] != 0:
            raise VisualRenderError("integrity-error", "Invalid PDF geometry space")
        for key in ("x", "y", "width", "height"):
            if (
                type(result[key]) not in (int, float)
                or not math.isfinite(result[key])
                or not 0 <= result[key] <= 1
            ):
                raise VisualRenderError("integrity-error", "Invalid PDF geometry bounds")
        if result["x"] + result["width"] > 1.0000001 or result["y"] + result["height"] > 1.0000001:
            raise VisualRenderError("integrity-error", "Invalid PDF geometry range")
        if result["width"] <= 0 or result["height"] <= 0:
            raise VisualRenderError("integrity-error", "Empty PDF geometry")
        return cast(RatioBBoxSelector, result)

    def _render_and_publish(
        self,
        request_key: str,
        source: SourceIdentity,
        representation_hash: str,
        physical_page: int,
        max_pixels: int,
        config_hash: str,
        original: AssetSnapshot,
        check: CancellationCheck,
    ) -> AssetSnapshot:
        descriptor_fd, rendered_name = tempfile.mkstemp(
            prefix=".render-", suffix=".png", dir=self._asset_store.root
        )
        os.close(descriptor_fd)
        rendered_path = Path(rendered_name)
        if os.name != "nt":
            rendered_path.chmod(0o600)
        try:
            result = call_pdf(
                original.content_path,
                original.descriptor["contentHash"],
                "render",
                {"physicalPage": physical_page, "maxPixels": max_pixels},
                check,
            )
            if not isinstance(result, dict) or set(result) != {
                "width",
                "height",
                "contentHash",
                "byteLength",
                "png",
            }:
                raise VisualRenderError("integrity-error", "Invalid PDF image response")
            width, height = result["width"], result["height"]
            if (
                type(width) is not int
                or type(height) is not int
                or not 1 <= width <= MAX_IMAGE_DIMENSION
                or not 1 <= height <= MAX_IMAGE_DIMENSION
                or width * height > max_pixels
            ):
                raise VisualRenderError("integrity-error", "PDF image exceeded pixel bounds")
            data = base64.b64decode(result["png"], validate=True)
            if (
                len(data) > MAX_VISUAL_BYTES
                or len(data) < 33
                or data[:8] != _PNG_SIGNATURE
                or struct.unpack(">II", data[16:24]) != (width, height)
            ):
                raise VisualRenderError("integrity-error", "Invalid PDF image data")
            content_hash, byte_length = hashlib.sha256(data).hexdigest(), len(data)
            if result["contentHash"] != content_hash or result["byteLength"] != byte_length:
                raise VisualRenderError("integrity-error", "PDF image checksum mismatch")
            check()
            rendered_path.write_bytes(data)
            asset_id = _opaque_digest(
                "asset",
                source["documentId"],
                source["revisionId"],
                source["representationId"],
                str(physical_page),
                config_hash,
                content_hash,
            )
            descriptor: AssetDescriptor = {
                "schemaVersion": 1,
                "assetId": asset_id,
                "kind": "page-image",
                "documentId": source["documentId"],
                "revisionId": source["revisionId"],
                "representationId": source["representationId"],
                "representationContentHash": representation_hash,
                "contentHash": content_hash,
                "mediaType": "image/png",
                "byteLength": byte_length,
                "physicalPage": physical_page,
                "width": width,
                "height": height,
                "generator": {
                    "name": "pypdfium2",
                    "version": version("pypdfium2"),
                    "configHash": config_hash,
                },
                "createdAt": _timestamp(),
            }
            try:
                published = self._asset_store.publish_file(
                    descriptor, rendered_path, check_cancelled=check
                )
            except AssetStoreError as error:
                raise VisualRenderError(
                    "integrity-error", "rendered asset publication failed"
                ) from error
            self._publish_pointer(request_key, published.descriptor["assetId"])
            return published
        except PdfWorkerError as error:
            code = error.code if error.code in {"not-found", "limit-exceeded"} else "unavailable"
            raise VisualRenderError(cast(Any, code), "Isolated PDF rendering failed") from error
        except VisualRenderError:
            raise
        except Exception as error:
            raise VisualRenderError("unavailable", "PDF page rendering failed") from error
        finally:
            rendered_path.unlink(missing_ok=True)

    def _cached(
        self,
        request_key: str,
        source: SourceIdentity,
        representation_hash: str,
        physical_page: int,
        config_hash: str,
    ) -> AssetSnapshot | None:
        pointer = self._keys_root / f"{request_key}.json"
        if not pointer.exists():
            return None
        if pointer.is_symlink() or not pointer.is_file():
            raise VisualRenderError("integrity-error", "render cache pointer is invalid")
        if pointer.stat().st_size > 1024:
            raise VisualRenderError("integrity-error", "render cache pointer is corrupt")
        try:
            value = json.loads(pointer.read_bytes())
        except (OSError, json.JSONDecodeError) as error:
            raise VisualRenderError("integrity-error", "render cache pointer is corrupt") from error
        if (
            not isinstance(value, dict)
            or set(value) != {"assetId"}
            or not isinstance(value["assetId"], str)
        ):
            raise VisualRenderError("integrity-error", "render cache pointer is corrupt")
        try:
            snapshot = self._asset_store.snapshot(value["assetId"])
        except AssetStoreError as error:
            raise VisualRenderError("integrity-error", "render cache asset is corrupt") from error
        if snapshot is None:
            raise VisualRenderError("integrity-error", "render cache asset is missing")
        descriptor = snapshot.descriptor
        expected = (
            descriptor["kind"] == "page-image"
            and descriptor["documentId"] == source["documentId"]
            and descriptor["revisionId"] == source["revisionId"]
            and descriptor["representationId"] == source["representationId"]
            and descriptor["representationContentHash"] == representation_hash
            and descriptor.get("physicalPage") == physical_page
            and descriptor.get("generator", {}).get("configHash") == config_hash
        )
        if not expected:
            raise VisualRenderError("integrity-error", "render cache identity mismatch")
        return snapshot

    def _publish_pointer(self, request_key: str, asset_id: str) -> None:
        target = self._keys_root / f"{request_key}.json"
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{request_key}.", suffix=".tmp", dir=self._keys_root
        )
        try:
            with os.fdopen(file_descriptor, "wb") as stream:
                stream.write(_canonical_json({"assetId": asset_id}))
                stream.flush()
                os.fsync(stream.fileno())
            if os.name != "nt":
                Path(temporary_name).chmod(0o600)
            os.replace(temporary_name, target)
            _fsync_directory(self._keys_root)
        finally:
            Path(temporary_name).unlink(missing_ok=True)


def _write_png(bitmap: Any, path: Path, check: CancellationCheck) -> None:
    with path.open("wb") as stream:
        _encode_png(bitmap, stream, check)
        os.fsync(stream.fileno())


def _encode_png(bitmap: Any, stream: BinaryIO, check: CancellationCheck) -> None:
    if bitmap.mode != "RGB" or bitmap.stride < bitmap.width * 3:
        raise VisualRenderError("unavailable", "PDFium returned an unsupported bitmap format")
    stream.write(_PNG_SIGNATURE)
    _png_chunk(
        stream,
        b"IHDR",
        struct.pack(">IIBBBBB", bitmap.width, bitmap.height, 8, 2, 0, 0, 0),
    )
    compressor = zlib.compressobj(level=6)
    for row in range(bitmap.height):
        check()
        start = row * bitmap.stride
        pixels = bytes(bitmap.buffer[start : start + bitmap.width * 3])
        compressed = compressor.compress(b"\0" + pixels)
        if compressed:
            _png_chunk(stream, b"IDAT", compressed)
            _enforce_output_limit(stream)
    final = compressor.flush()
    if final:
        _png_chunk(stream, b"IDAT", final)
    _png_chunk(stream, b"IEND", b"")
    _enforce_output_limit(stream)
    stream.flush()


def _png_chunk(stream: BinaryIO, kind: bytes, data: bytes) -> None:
    stream.write(struct.pack(">I", len(data)))
    stream.write(kind)
    stream.write(data)
    checksum = binascii.crc32(data, binascii.crc32(kind)) & 0xFFFFFFFF
    stream.write(struct.pack(">I", checksum))


def _enforce_output_limit(stream: BinaryIO) -> None:
    if stream.tell() > MAX_VISUAL_BYTES:
        raise VisualRenderError("limit-exceeded", "rendered image exceeds the visual byte limit")


def _hash_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    byte_length = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            byte_length += len(chunk)
    return digest.hexdigest(), byte_length


def _opaque_digest(prefix: str, *values: str) -> str:
    return f"{prefix}:{hashlib.sha256(chr(0).join(values).encode()).hexdigest()[:32]}"


def _json_hash(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _not_cancelled() -> None:
    return None


def _normalize_pdf_text(raw: str) -> tuple[str, list[int] | None]:
    characters: list[str] = []
    raw_indices: list[int] = []
    index = 0
    while index < len(raw):
        char = raw[index]
        if char == "\r":
            characters.append("\n")
            raw_indices.append(index)
            index += 2 if index + 1 < len(raw) and raw[index + 1] == "\n" else 1
            continue
        characters.append(char)
        raw_indices.append(index)
        index += 1
    text = "".join(characters)
    normalized = unicodedata.normalize("NFC", text)
    if normalized != text:
        return normalized, None
    return normalized, raw_indices


__all__ = [
    "DEFAULT_VISUAL_PIXELS",
    "MAX_VISUAL_BYTES",
    "MAX_VISUAL_PIXELS",
    "VisualRenderError",
    "VisualRenderer",
]
