"""Revision-bound document ingestion with atomic SQLite FTS publication."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path, PurePosixPath
from typing import Any, Literal, cast

from .asset_store import AssetStore, AssetStoreError
from .block_index import (
    PageText,
    TextBlock,
    TextQuality,
    assess_text_quality,
    build_blocks,
    normalize_page_text,
)
from .contracts import AssetDescriptor, SourceRepresentation
from .document_rpc import (
    IngestRequest,
    IngestResult,
    ingest_request_issues,
    ingest_result_issues,
)
from .pdf_isolation import PdfWorkerError, call_pdf
from .schema_validation import validate_contract_shape

type IngestFailureCode = Literal[
    "invalid-request",
    "permission-denied",
    "source-missing",
    "source-integrity",
    "source-too-large",
    "unsupported-media-type",
    "encrypted-pdf",
    "index-integrity",
    "idempotency-conflict",
    "unavailable",
    "limit-exceeded",
]
type PublishHook = Callable[[str, Path], None]
type CancellationCheck = Callable[[], None]

_GENERATION = re.compile(r"^[a-f0-9]{32}$")
_INDEX_SCHEMA_VERSION = 1
_MAX_DOCUMENT_BYTES = 536_870_912


class IngestFailure(RuntimeError):
    def __init__(self, code: IngestFailureCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class IndexSnapshot:
    generation_id: str
    directory: Path
    database_path: Path
    manifest: dict[str, Any]


class DocumentIndexStore:
    def __init__(
        self,
        source_roots: Mapping[str, Path],
        cache_root: Path,
        *,
        keep_generations: int = 2,
        publish_hook: PublishHook | None = None,
    ) -> None:
        if keep_generations < 1:
            raise ValueError("keep_generations must be positive")
        self._source_roots = {
            root_id: path.resolve(strict=True) for root_id, path in source_roots.items()
        }
        if any(not path.is_dir() for path in self._source_roots.values()):
            raise ValueError("every source root must be a directory")
        self._cache_root = cache_root.resolve()
        self._cache_root.mkdir(parents=True, exist_ok=True)
        self._indexes_root = self._cache_root / "indexes"
        self._indexes_root.mkdir(exist_ok=True)
        self._keep_generations = keep_generations
        self._publish_hook = publish_hook
        self._lock = threading.RLock()
        self._control_path = self._cache_root / "control.sqlite3"
        self.asset_store = AssetStore(self._cache_root, publish_hook=publish_hook)
        self._initialize_control_database()

    @property
    def cache_root(self) -> Path:
        return self._cache_root

    @property
    def can_ingest(self) -> bool:
        return bool(self._source_roots)

    def ingest(
        self, request: IngestRequest, *, check_cancelled: CancellationCheck | None = None
    ) -> IngestResult:
        check = check_cancelled or _not_cancelled
        check()
        shape_issues = validate_contract_shape("sidecar-document-rpc", request)
        if shape_issues:
            raise IngestFailure("invalid-request", shape_issues[0].message)
        semantic_issues = ingest_request_issues(request)
        if semantic_issues:
            raise IngestFailure("invalid-request", semantic_issues[0].message)
        request_hash = _json_hash(request)
        with self._lock:
            check()
            replay = self._load_idempotent(request["idempotencyKey"], request_hash)
            if replay is not None:
                if self.current_snapshot(replay["documentId"], replay["revisionId"]) is None:
                    raise IngestFailure("index-integrity", "idempotent result has no current index")
                self._require_original_asset(replay)
                return replay
            source_path = self._resolve_and_verify_source(request, check)
            spec_hash = self._build_spec_hash(request)
            revision = request["revision"]
            index_key = _identity_digest(revision["documentId"], revision["revisionId"])
            if not request["options"]["forceRebuild"]:
                current = self.current_snapshot(revision["documentId"], revision["revisionId"])
                if current is not None and current.manifest.get("buildSpecHash") == spec_hash:
                    reused_result = cast(
                        IngestResult, json.loads(json.dumps(current.manifest["result"]))
                    )
                    reused_result["idempotencyKey"] = request["idempotencyKey"]
                    reused_result["cacheStatus"] = "reused"
                    self._require_original_asset(reused_result)
                    self._record_idempotent(request["idempotencyKey"], request_hash, reused_result)
                    return reused_result

            pages, total_pages, provider_name, provider_version, warnings = self._extract_pages(
                source_path, request, check
            )
            self._verify_file(source_path, request, check)
            quality = assess_text_quality(pages)
            representations, indexed_representation = self._representations(
                request,
                pages,
                total_pages,
                provider_name,
                provider_version,
                quality,
                warnings,
            )
            self._publish_original_asset(representations[0], source_path, check)
            blocks = build_blocks(
                pages,
                indexed_representation["representationId"],
                split_visual_lines=revision["mediaType"] == "application/pdf",
            )
            check()
            result: IngestResult = {
                "schemaVersion": 1,
                "resultType": "ingest",
                "idempotencyKey": request["idempotencyKey"],
                "documentId": revision["documentId"],
                "revisionId": revision["revisionId"],
                "cacheStatus": "refreshed"
                if self.current_snapshot(revision["documentId"], revision["revisionId"])
                else "created",
                "representations": representations,
                "index": {
                    "status": "ready" if len(pages) == total_pages else "partial",
                    "blockCount": len(blocks),
                    "indexedPages": len(pages),
                    "totalPages": total_pages,
                    "textQuality": quality,
                },
                "warnings": warnings[:32],
            }
            result_issues = ingest_result_issues(result)
            if result_issues or validate_contract_shape("sidecar-document-rpc", result):
                raise IngestFailure("index-integrity", "generated ingest result is invalid")
            self._publish(
                index_key,
                spec_hash,
                result,
                pages,
                blocks,
                indexed_representation,
                check,
            )
            self._record_idempotent(request["idempotencyKey"], request_hash, result)
            return result

    def _publish_original_asset(
        self,
        representation: SourceRepresentation,
        source_path: Path,
        check: CancellationCheck,
    ) -> None:
        raw_media_type = representation["mediaType"]
        if raw_media_type not in {"application/pdf", "text/markdown", "text/plain"}:
            raise IngestFailure(
                "unsupported-media-type", "original asset media type is unsupported"
            )
        media_type = cast(Literal["application/pdf", "text/markdown", "text/plain"], raw_media_type)
        descriptor: AssetDescriptor = {
            "schemaVersion": 1,
            "assetId": representation["representationId"],
            "kind": "original-bytes",
            "documentId": representation["documentId"],
            "revisionId": representation["revisionId"],
            "representationId": representation["representationId"],
            "representationContentHash": representation["contentHash"],
            "contentHash": representation["contentHash"],
            "mediaType": media_type,
            "byteLength": representation["byteLength"],
            "createdAt": representation["createdAt"],
        }
        try:
            self.asset_store.publish_file(descriptor, source_path, check_cancelled=check)
        except AssetStoreError as error:
            raise IngestFailure("index-integrity", "original asset publication failed") from error

    def _require_original_asset(self, result: IngestResult) -> None:
        original = next(
            (
                representation
                for representation in result["representations"]
                if representation["kind"] == "original-bytes"
            ),
            None,
        )
        if original is None:
            raise IngestFailure("index-integrity", "ingest result has no original representation")
        try:
            snapshot = self.asset_store.snapshot(original["representationId"])
        except AssetStoreError as error:
            raise IngestFailure("index-integrity", "original asset is corrupt") from error
        if snapshot is None:
            raise IngestFailure("index-integrity", "ingest result has no original asset")

    def current_snapshot(self, document_id: str, revision_id: str) -> IndexSnapshot | None:
        with self._lock:
            return self._read_current_snapshot(document_id, revision_id)

    @contextmanager
    def snapshot_lease(self, document_id: str, revision_id: str) -> Iterator[IndexSnapshot | None]:
        """Keep a generation alive while a reader uses its immutable SQLite file."""
        with self._lock:
            yield self._read_current_snapshot(document_id, revision_id)

    def _read_current_snapshot(self, document_id: str, revision_id: str) -> IndexSnapshot | None:
        index_root = self._indexes_root / _identity_digest(document_id, revision_id)
        pointer_path = index_root / "current.json"
        if not pointer_path.is_file():
            return None
        try:
            pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
            if pointer.get("schemaVersion") != 1:
                raise ValueError("invalid pointer schema version")
            generation_id = pointer["generationId"]
            manifest_hash = pointer["manifestHash"]
            if not isinstance(generation_id, str) or _GENERATION.fullmatch(generation_id) is None:
                raise ValueError("invalid generation id")
            generation = index_root / "generations" / generation_id
            manifest_path = generation / "manifest.json"
            manifest_bytes = manifest_path.read_bytes()
            if hashlib.sha256(manifest_bytes).hexdigest() != manifest_hash:
                raise ValueError("manifest hash mismatch")
            manifest = json.loads(manifest_bytes)
            if (
                manifest.get("documentId") != document_id
                or manifest.get("revisionId") != revision_id
                or manifest.get("indexSchemaVersion") != _INDEX_SCHEMA_VERSION
            ):
                raise ValueError("manifest identity mismatch")
            database_path = generation / "index.sqlite3"
            if not database_path.is_file():
                raise ValueError("index database is missing")
            if _file_hash(database_path) != manifest.get("databaseHash"):
                raise ValueError("index database hash mismatch")
            return IndexSnapshot(generation_id, generation, database_path, manifest)
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise IngestFailure("index-integrity", f"current index is corrupt: {error}") from error

    def _resolve_and_verify_source(
        self, request: IngestRequest, check_cancelled: CancellationCheck
    ) -> Path:
        binding = request["sourceBinding"]
        root = self._source_roots.get(binding["rootId"])
        if root is None:
            raise IngestFailure("permission-denied", "source root is not configured")
        relative = PurePosixPath(binding["relativePath"])
        candidate = root.joinpath(*relative.parts)
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError as error:
            raise IngestFailure("source-missing", "source file does not exist") from error
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise IngestFailure("permission-denied", "source binding escapes its configured root")
        self._verify_file(resolved, request, check_cancelled)
        return resolved

    def _verify_file(
        self, resolved: Path, request: IngestRequest, check_cancelled: CancellationCheck
    ) -> None:
        binding = request["sourceBinding"]
        stat = resolved.stat()
        if stat.st_size > _MAX_DOCUMENT_BYTES:
            raise IngestFailure("source-too-large", "source exceeds the document byte limit")
        if stat.st_size != binding["byteLength"]:
            raise IngestFailure("source-integrity", "source byte length changed")
        digest = hashlib.sha256()
        with resolved.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                check_cancelled()
                digest.update(chunk)
        if digest.hexdigest() != binding["expectedContentHash"]:
            raise IngestFailure("source-integrity", "source content hash changed")

    def _extract_pages(
        self,
        source_path: Path,
        request: IngestRequest,
        check_cancelled: CancellationCheck,
    ) -> tuple[list[PageText], int, str, str, list[str]]:
        media_type = request["revision"]["mediaType"]
        max_pages = request["options"].get("maxPages")
        warnings: list[str] = []
        if media_type == "application/pdf":
            with source_path.open("rb") as stream:
                signature = stream.read(5)
            if signature != b"%PDF-":
                raise IngestFailure("source-integrity", "PDF signature does not match media type")
            try:
                response = call_pdf(
                    source_path,
                    request["revision"]["contentHash"],
                    "extract",
                    {"maxPages": max_pages, "expectedPages": request["revision"].get("pageCount")},
                    check_cancelled,
                )
            except PdfWorkerError as error:
                code: IngestFailureCode = (
                    cast(IngestFailureCode, error.code)
                    if error.code
                    in {"encrypted-pdf", "limit-exceeded", "unavailable", "source-integrity"}
                    else "unavailable"
                )
                raise IngestFailure(code, "Isolated PDF text extraction failed") from error
            if not isinstance(response, dict) or set(response) != {
                "pages",
                "totalPages",
                "warnings",
            }:
                raise IngestFailure("source-integrity", "Invalid PDF extraction response")
            total_pages = response["totalPages"]
            if (
                type(total_pages) is not int
                or total_pages < 1
                or not isinstance(response["pages"], list)
            ):
                raise IngestFailure("source-integrity", "Invalid PDF page count")
            expected_count = min(total_pages, max_pages) if max_pages is not None else total_pages
            if len(response["pages"]) != expected_count or any(
                not isinstance(text, str) for text in response["pages"]
            ):
                raise IngestFailure("source-integrity", "Incomplete PDF extraction")
            if not isinstance(response["warnings"], list) or any(
                not isinstance(value, str) for value in response["warnings"]
            ):
                raise IngestFailure("source-integrity", "Invalid PDF extraction warnings")
            pages = [PageText(index + 1, text) for index, text in enumerate(response["pages"])]
            return pages, total_pages, "pypdf", version("pypdf"), response["warnings"]
        if media_type in {"text/markdown", "text/plain"}:
            try:
                text = source_path.read_text(encoding="utf-8")
            except UnicodeDecodeError as error:
                raise IngestFailure("source-integrity", "text source is not UTF-8") from error
            raw_pages = normalize_page_text(text).split("\f")
            total_pages = max(1, len(raw_pages))
            expected_pages = request["revision"].get("pageCount")
            if expected_pages is not None and expected_pages != total_pages:
                raise IngestFailure("source-integrity", "text page count does not match revision")
            count = min(total_pages, max_pages) if max_pages is not None else total_pages
            pages = [PageText(index + 1, raw_pages[index]) for index in range(count)]
            check_cancelled()
            if count < total_pages:
                warnings.append(f"index limited to {count} of {total_pages} pages")
            return pages, total_pages, "docatlas-text", "1.0.0", warnings
        raise IngestFailure("unsupported-media-type", f"unsupported media type: {media_type}")

    def _representations(
        self,
        request: IngestRequest,
        pages: list[PageText],
        total_pages: int,
        provider_name: str,
        provider_version: str,
        quality: TextQuality,
        warnings: list[str],
    ) -> tuple[list[SourceRepresentation], SourceRepresentation]:
        revision = request["revision"]
        created_at = _timestamp()
        original_id = _opaque_digest(
            "rep", revision["documentId"], revision["revisionId"], "original-bytes"
        )
        original: SourceRepresentation = {
            "schemaVersion": 1,
            "representationId": original_id,
            "documentId": revision["documentId"],
            "revisionId": revision["revisionId"],
            "kind": "original-bytes",
            "mediaType": revision["mediaType"],
            "contentHash": revision["contentHash"],
            "byteLength": revision["byteLength"],
            "pageCount": total_pages,
            "textQuality": "not-applicable",
            "derivedFromRepresentationIds": [],
            "createdAt": created_at,
            "status": "current",
        }
        text_bytes = "\n\f\n".join(page.text for page in pages).encode()
        if not text_bytes:
            warnings.append("source has no extractable embedded text")
            if request["options"]["allowOcr"]:
                warnings.append("OCR was requested but no OCR provider is installed")
            return [original], original
        kind: Literal["derived-markdown", "embedded-text"] = (
            "derived-markdown" if revision["mediaType"] == "text/markdown" else "embedded-text"
        )
        config_hash = _json_hash(
            {"provider": provider_name, "version": provider_version, "normalization": "NFC-LF-v1"}
        )
        content_hash = hashlib.sha256(text_bytes).hexdigest()
        text_representation: SourceRepresentation = {
            "schemaVersion": 1,
            "representationId": _opaque_digest(
                "rep", revision["documentId"], revision["revisionId"], kind, content_hash
            ),
            "documentId": revision["documentId"],
            "revisionId": revision["revisionId"],
            "kind": kind,
            "mediaType": "text/markdown" if kind == "derived-markdown" else "text/plain",
            "contentHash": content_hash,
            "byteLength": len(text_bytes),
            "pageCount": len(pages),
            "textQuality": quality,
            "derivedFromRepresentationIds": [original_id],
            "generator": {
                "name": provider_name,
                "version": provider_version,
                "configHash": config_hash,
            },
            "createdAt": created_at,
            "status": "current",
        }
        supported = {kind}
        for requested in request["requestedRepresentationKinds"]:
            if requested not in supported:
                warnings.append(f"requested representation is unavailable: {requested}")
        return [original, text_representation], text_representation

    def _publish(
        self,
        index_key: str,
        spec_hash: str,
        result: IngestResult,
        pages: list[PageText],
        blocks: list[TextBlock],
        representation: SourceRepresentation,
        check_cancelled: CancellationCheck,
    ) -> None:
        index_root = self._indexes_root / index_key
        generations_root = index_root / "generations"
        generations_root.mkdir(parents=True, exist_ok=True)
        generation_id = uuid.uuid4().hex
        temporary = Path(tempfile.mkdtemp(prefix=".building-", dir=generations_root))
        generation = generations_root / generation_id
        pointer_temp: Path | None = None
        try:
            database_path = temporary / "index.sqlite3"
            check_cancelled()
            self._write_index(database_path, pages, blocks, representation)
            check_cancelled()
            database_hash = _file_hash(database_path)
            manifest = {
                "indexSchemaVersion": _INDEX_SCHEMA_VERSION,
                "generationId": generation_id,
                "documentId": result["documentId"],
                "revisionId": result["revisionId"],
                "representationId": representation["representationId"],
                "representationContentHash": representation["contentHash"],
                "buildSpecHash": spec_hash,
                "databaseHash": database_hash,
                "publishedAt": _timestamp(),
                "result": result,
            }
            manifest_path = temporary / "manifest.json"
            manifest_bytes = _canonical_json(manifest)
            _write_durable(manifest_path, manifest_bytes)
            _fsync_directory(temporary)
            self._hook("before-generation-publish", temporary)
            check_cancelled()
            os.replace(temporary, generation)
            _fsync_directory(generations_root)
            self._hook("before-pointer-publish", generation)
            check_cancelled()
            pointer = _canonical_json(
                {
                    "schemaVersion": 1,
                    "generationId": generation_id,
                    "manifestHash": hashlib.sha256(manifest_bytes).hexdigest(),
                }
            )
            pointer_temp = index_root / f".current-{uuid.uuid4().hex}.tmp"
            _write_durable(pointer_temp, pointer)
            os.replace(pointer_temp, index_root / "current.json")
            _fsync_directory(index_root)
            self._hook("after-pointer-publish", generation)
            self._cleanup_generations(generations_root, generation_id)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
            if pointer_temp is not None and pointer_temp.exists():
                pointer_temp.unlink()

    def _write_index(
        self,
        path: Path,
        pages: list[PageText],
        blocks: list[TextBlock],
        representation: SourceRepresentation,
    ) -> None:
        connection = sqlite3.connect(path)
        try:
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute(f"PRAGMA user_version={_INDEX_SCHEMA_VERSION}")
            connection.executescript(
                """
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
                CREATE TABLE pages (
                    physical_page INTEGER PRIMARY KEY CHECK (physical_page >= 1),
                    text TEXT NOT NULL,
                    text_hash TEXT NOT NULL,
                    char_count INTEGER NOT NULL CHECK (char_count >= 0)
                );
                CREATE TABLE blocks (
                    block_id TEXT PRIMARY KEY,
                    ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 1),
                    physical_page INTEGER NOT NULL REFERENCES pages(physical_page),
                    page_block_index INTEGER NOT NULL CHECK (page_block_index >= 1),
                    kind TEXT NOT NULL,
                    heading TEXT NOT NULL,
                    text TEXT NOT NULL,
                    text_hash TEXT NOT NULL,
                    char_start INTEGER NOT NULL CHECK (char_start >= 0),
                    char_end INTEGER NOT NULL CHECK (char_end >= char_start),
                    UNIQUE (physical_page, page_block_index)
                );
                CREATE INDEX blocks_page_ordinal ON blocks(physical_page, page_block_index);
                CREATE VIRTUAL TABLE blocks_fts USING fts5(
                    block_id UNINDEXED, text, heading,
                    tokenize='unicode61 remove_diacritics 2'
                );
                """
            )
            metadata = {
                "documentId": representation["documentId"],
                "revisionId": representation["revisionId"],
                "representationId": representation["representationId"],
                "representationContentHash": representation["contentHash"],
            }
            connection.executemany(
                "INSERT INTO metadata(key, value) VALUES (?, ?)", metadata.items()
            )
            connection.executemany(
                "INSERT INTO pages VALUES (?, ?, ?, ?)",
                [
                    (
                        page.physical_page,
                        page.text,
                        hashlib.sha256(page.text.encode()).hexdigest(),
                        len(page.text),
                    )
                    for page in pages
                ],
            )
            connection.executemany(
                "INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        block.block_id,
                        block.ordinal,
                        block.physical_page,
                        block.page_block_index,
                        block.kind,
                        block.heading,
                        block.text,
                        block.text_hash,
                        block.char_start,
                        block.char_end,
                    )
                    for block in blocks
                ],
            )
            connection.executemany(
                "INSERT INTO blocks_fts(block_id, text, heading) VALUES (?, ?, ?)",
                [(block.block_id, block.text, block.heading) for block in blocks],
            )
            connection.commit()
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            if integrity != ("ok",):
                raise IngestFailure("index-integrity", "SQLite integrity check failed")
            if connection.execute("SELECT count(*) FROM blocks_fts").fetchone() != (len(blocks),):
                raise IngestFailure("index-integrity", "FTS row count does not match blocks")
        finally:
            connection.close()
        with path.open("rb") as stream:
            os.fsync(stream.fileno())

    def _build_spec_hash(self, request: IngestRequest) -> str:
        return _json_hash(
            {
                "indexSchemaVersion": _INDEX_SCHEMA_VERSION,
                "revision": request["revision"],
                "requestedRepresentationKinds": request["requestedRepresentationKinds"],
                "blockSegmentation": "pdf-visual-lines-v1"
                if request["revision"]["mediaType"] == "application/pdf"
                else "semantic-blocks-v1",
                "allowOcr": request["options"]["allowOcr"],
                "maxPages": request["options"].get("maxPages"),
            }
        )

    def _initialize_control_database(self) -> None:
        connection = sqlite3.connect(self._control_path)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS idempotency (
                    idempotency_key TEXT PRIMARY KEY,
                    request_hash TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                ) WITHOUT ROWID
                """
            )
            connection.commit()
        finally:
            connection.close()

    def _load_idempotent(self, key: str, request_hash: str) -> IngestResult | None:
        connection = sqlite3.connect(self._control_path)
        try:
            row = connection.execute(
                "SELECT request_hash, result_json FROM idempotency WHERE idempotency_key = ?",
                (key,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            return None
        if row[0] != request_hash:
            raise IngestFailure(
                "idempotency-conflict", "idempotency key was used by another request"
            )
        result = json.loads(row[1])
        if validate_contract_shape("sidecar-document-rpc", result):
            raise IngestFailure("index-integrity", "stored idempotent result is invalid")
        return cast(IngestResult, result)

    def _record_idempotent(self, key: str, request_hash: str, result: IngestResult) -> None:
        connection = sqlite3.connect(self._control_path)
        try:
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute(
                "INSERT INTO idempotency VALUES (?, ?, ?, ?)",
                (key, request_hash, _canonical_json(result).decode(), _timestamp()),
            )
            connection.commit()
        except sqlite3.IntegrityError:
            connection.rollback()
            existing = self._load_idempotent(key, request_hash)
            if existing is None:
                raise
        finally:
            connection.close()

    def _cleanup_generations(self, root: Path, current: str) -> None:
        generations = sorted(
            (
                path
                for path in root.iterdir()
                if path.is_dir() and _GENERATION.fullmatch(path.name) is not None
            ),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
        keep = {current}
        for path in generations:
            if len(keep) >= self._keep_generations:
                break
            keep.add(path.name)
        for path in generations:
            if path.name not in keep:
                shutil.rmtree(path)

    def _hook(self, stage: str, path: Path) -> None:
        if self._publish_hook is not None:
            self._publish_hook(stage, path)


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _json_hash(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _identity_digest(document_id: str, revision_id: str) -> str:
    return hashlib.sha256(f"{document_id}\0{revision_id}".encode()).hexdigest()


def _opaque_digest(prefix: str, *values: str) -> str:
    return f"{prefix}:{hashlib.sha256(chr(0).join(values).encode()).hexdigest()[:32]}"


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_durable(path: Path, content: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _not_cancelled() -> None:
    return None


__all__ = ["DocumentIndexStore", "IndexSnapshot", "IngestFailure"]
