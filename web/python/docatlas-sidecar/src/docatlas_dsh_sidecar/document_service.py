"""Bounded Search, Read, and Locator resolution over immutable document indexes."""

from __future__ import annotations

import hashlib
import re
import sqlite3
from contextlib import ExitStack, closing
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, cast

from .contracts import DocumentLocator, PageInfo
from .document_rpc import (
    IngestRequest,
    IngestResult,
    ReadBlocksRequest,
    ReadExpandRequest,
    ReadItem,
    ReadLocateRequest,
    ReadPageRequest,
    ReadRequest,
    ReadResult,
    ReadSequentialRequest,
    ReadVisualFigureRequest,
    ReadVisualPageRequest,
    ResolveRequest,
    ResolveResult,
    SearchCandidate,
    SearchRequest,
    SearchResult,
    SourceIdentity,
)
from .flash_provider import FlashProvider, TreeIndexError
from .ingest import CancellationCheck, DocumentIndexStore, IndexSnapshot
from .schema_validation import validate_contract_shape
from .tree_index import TreeBuildRequest, TreeGeneration, TreePage, TreeReadRequest
from .tree_service import TreeIndexService
from .visual import DEFAULT_VISUAL_PIXELS, VisualRenderer, VisualRenderError

type DocumentServiceErrorCode = Literal[
    "invalid-request",
    "not-found",
    "stale",
    "unavailable",
    "limit-exceeded",
    "integrity-error",
]

_QUERY_TOKEN = re.compile(r"\w+", re.UNICODE)
_SPACE = re.compile(r"\s+")
_HAN_CHARACTER = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af]")
_LITERAL_SCAN_BLOCKS = 8192
_LITERAL_SCAN_CHARS = 2_000_000
_LITERAL_SCAN_WORK = 16_000_000


class DocumentServiceError(RuntimeError):
    def __init__(self, code: DocumentServiceErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class _RankedBlock:
    rank: float
    source: SourceIdentity
    snapshot: IndexSnapshot
    row: sqlite3.Row


@dataclass(slots=True)
class _LiteralScanBudget:
    """One request-wide allowance, including all authorized source revisions."""

    blocks: int = 0
    chars: int = 0
    work: int = 0

    def consume(self, chars: int, terms: int) -> None:
        self.blocks += 1
        self.chars += chars
        self.work += chars * terms
        if (
            self.blocks > _LITERAL_SCAN_BLOCKS
            or self.chars > _LITERAL_SCAN_CHARS
            or self.work > _LITERAL_SCAN_WORK
        ):
            raise DocumentServiceError(
                "limit-exceeded",
                "Literal Han search exceeds its bounded scan; "
                "narrow the source scope or read pages",
            )


class DocumentService:
    def __init__(
        self, store: DocumentIndexStore, *, flash_provider: FlashProvider | None = None
    ) -> None:
        self._store = store
        self._visual = VisualRenderer(store.cache_root, store.asset_store)
        self._trees = (
            TreeIndexService(store, flash_provider) if flash_provider is not None else None
        )

    def build_tree(
        self, request: TreeBuildRequest, *, check_cancelled: CancellationCheck | None = None
    ) -> TreeGeneration:
        if self._trees is None:
            raise TreeIndexError("unavailable", "Flash provider is not enabled")
        return self._trees.build(request, check_cancelled=check_cancelled or (lambda: None))

    @property
    def can_ingest(self) -> bool:
        return self._store.can_ingest

    def read_tree(self, request: TreeReadRequest) -> TreePage:
        if self._trees is None:
            raise TreeIndexError("unavailable", "Flash provider is not enabled")
        return self._trees.read(request)

    def ingest(self, request: IngestRequest) -> IngestResult:
        return self._store.ingest(request)

    def search(self, request: SearchRequest) -> SearchResult:
        self._validate(request)
        if request["strategy"] == "tree":
            raise DocumentServiceError(
                "unavailable", "tree search is not available in this sidecar"
            )
        normalized_query = _normalize_query(request["query"])
        fts_query = _fts_query(normalized_query)
        query_hash = hashlib.sha256(normalized_query.encode()).hexdigest()
        offset = _parse_search_cursor(request.get("cursor"), query_hash)
        fetch_limit = offset + request["limits"]["maxItems"] + 1
        ranked: list[_RankedBlock] = []
        literal_budget = _LiteralScanBudget()
        with ExitStack() as leases:
            for source in request["sources"]:
                snapshot = leases.enter_context(
                    self._store.snapshot_lease(source["documentId"], source["revisionId"])
                )
                if snapshot is None:
                    raise DocumentServiceError("not-found", "source revision has no current index")
                self._require_representation(snapshot, source)
                with _read_connection(snapshot) as connection:
                    rows = _search_rows(
                        connection, normalized_query, fts_query, fetch_limit, literal_budget
                    )
                ranked.extend(
                    _RankedBlock(float(row["rank"]), source, snapshot, row) for row in rows
                )
            ranked.sort(
                key=lambda item: (
                    item.rank,
                    item.source["documentId"],
                    item.source["revisionId"],
                    item.row["ordinal"],
                )
            )
            available = ranked[offset:]
            candidates: list[SearchCandidate] = []
            used_chars = 0
            for item in available:
                if len(candidates) >= request["limits"]["maxItems"]:
                    break
                preview = _preview(item.row["text"])
                remaining = request["limits"]["maxChars"] - used_chars
                if remaining <= 0:
                    break
                preview = preview[: min(remaining, 2000)]
                if not preview:
                    break
                candidate: SearchCandidate = {
                    "candidateId": _opaque_digest(
                        "candidate",
                        query_hash,
                        item.source["documentId"],
                        item.source["revisionId"],
                        item.row["block_id"],
                    ),
                    "documentId": item.source["documentId"],
                    "revisionId": item.source["revisionId"],
                    "representationId": item.source["representationId"],
                    "physicalPageStart": item.row["physical_page"],
                    "physicalPageEnd": item.row["physical_page"],
                    "blockIds": [item.row["block_id"]],
                    "title": (
                        item.row["heading"]
                        or f"Page {item.row['physical_page']} · {item.row['kind']}"
                    )[:1000],
                    "preview": preview,
                    "matchKind": "combined" if request["strategy"] == "combined" else "lexical",
                    "reason": "Bounded cached-block literal Han substring match"
                    if item.row["matched_by"] == "literal-han"
                    else "SQLite FTS5 block match",
                }
                candidates.append(candidate)
                used_chars += len(preview)
            consumed = offset + len(candidates)
            truncated = consumed < len(ranked)
            page_info: PageInfo = {
                "schemaVersion": 1,
                "limit": request["limits"]["maxItems"],
                "returned": len(candidates),
                "usedChars": used_chars,
                "truncated": truncated,
                "completeness": "candidate",
            }
            if truncated:
                page_info["nextCursor"] = _search_cursor(query_hash, consumed)
            result: SearchResult = {
                "schemaVersion": 1,
                "resultType": "search",
                "scopeVersionId": request["scopeVersionId"],
                "queryHash": query_hash,
                "candidates": candidates,
                "pageInfo": page_info,
            }
        self._validate_generated(result)
        return result

    def read(self, request: ReadRequest) -> ReadResult:
        self._validate(request)
        if request["mode"] == "visual":
            return self._read_visual(request)
        source = request["source"]
        with self._store.snapshot_lease(source["documentId"], source["revisionId"]) as snapshot:
            if snapshot is None:
                raise DocumentServiceError("not-found", "source revision has no current index")
            self._require_representation(snapshot, source)
            with _read_connection(snapshot) as connection:
                rows, start_char, total, candidate = self._read_rows(connection, request, snapshot)
            items, used_chars, truncated, next_ordinal, next_char = self._bounded_blocks(
                rows,
                source,
                snapshot,
                request["limits"]["maxItems"],
                request["limits"]["maxChars"],
                start_char,
            )
            page_info: PageInfo = {
                "schemaVersion": 1,
                "limit": request["limits"]["maxItems"],
                "returned": len(items),
                "usedChars": used_chars,
                "truncated": truncated,
                "completeness": "candidate"
                if candidate
                else ("partial" if truncated else "complete"),
            }
            if total is not None:
                page_info["total"] = total
            if truncated and next_ordinal is not None:
                if request["mode"] == "sequential":
                    page_info["nextCursor"] = _read_cursor(
                        source["representationId"], next_ordinal, next_char
                    )
                elif request["mode"] == "page":
                    page_info["nextCursor"] = _page_read_cursor(
                        source["representationId"],
                        request["physicalPage"],
                        next_ordinal,
                        next_char,
                    )
            result: ReadResult = {
                "schemaVersion": 1,
                "resultType": "read",
                "mode": request["mode"],
                "source": source,
                "textQuality": snapshot.manifest["result"]["index"]["textQuality"],
                "items": items,
                "pageInfo": page_info,
            }
        self._validate_generated(result)
        return result

    def _read_visual(self, request: ReadVisualPageRequest | ReadVisualFigureRequest) -> ReadResult:
        if "figureId" in request:
            raise DocumentServiceError(
                "unavailable", "figure visual Read requires a persisted figure crop"
            )
        source = request["source"]
        with self._store.snapshot_lease(source["documentId"], source["revisionId"]) as snapshot:
            if snapshot is None:
                raise DocumentServiceError("not-found", "source revision has no current index")
            self._require_representation(snapshot, source)
            original = next(
                (
                    representation
                    for representation in snapshot.manifest["result"]["representations"]
                    if representation["kind"] == "original-bytes"
                ),
                None,
            )
            if original is None:
                raise DocumentServiceError(
                    "integrity-error", "index has no original asset representation"
                )
            try:
                asset = self._visual.render_page(
                    source,
                    snapshot.manifest["representationContentHash"],
                    original["representationId"],
                    request["physicalPage"],
                    request.get("maxPixels", DEFAULT_VISUAL_PIXELS),
                )
            except VisualRenderError as error:
                raise DocumentServiceError(
                    cast(DocumentServiceErrorCode, error.code), str(error)
                ) from error
            descriptor = asset.descriptor
            width = descriptor.get("width")
            height = descriptor.get("height")
            if width is None or height is None:
                raise DocumentServiceError(
                    "integrity-error", "visual asset has no pixel dimensions"
                )
            locator = _visual_locator(
                source, snapshot, descriptor["assetId"], request["physicalPage"]
            )
            result: ReadResult = {
                "schemaVersion": 1,
                "resultType": "read",
                "mode": "visual",
                "source": source,
                "textQuality": snapshot.manifest["result"]["index"]["textQuality"],
                "items": [
                    {
                        "itemType": "visual",
                        "physicalPage": request["physicalPage"],
                        "asset": {
                            "assetId": descriptor["assetId"],
                            "contentHash": descriptor["contentHash"],
                            "mediaType": "image/png",
                            "byteLength": descriptor["byteLength"],
                            "width": width,
                            "height": height,
                        },
                        "locator": locator,
                    }
                ],
                "pageInfo": {
                    "schemaVersion": 1,
                    "limit": request["limits"]["maxItems"],
                    "returned": 1,
                    "total": 1,
                    "usedChars": 0,
                    "truncated": False,
                    "completeness": "complete",
                },
            }
        self._validate_generated(result)
        return result

    def resolve(self, request: ResolveRequest) -> ResolveResult:
        self._validate(request)
        locator = request["locator"]
        source: SourceIdentity = {
            "documentId": locator["documentId"],
            "revisionId": locator["revisionId"],
            "representationId": locator["representationId"],
        }
        with self._store.snapshot_lease(source["documentId"], source["revisionId"]) as snapshot:
            if snapshot is None:
                return self._resolution(request, None, "missing", "source revision has no index")
            if (
                snapshot.manifest["representationId"] != source["representationId"]
                or snapshot.manifest["representationContentHash"]
                != locator["representationContentHash"]
            ):
                return self._resolution(
                    request, snapshot, "stale", "locator representation is not current"
                )
            with _read_connection(snapshot) as connection:
                page = connection.execute(
                    "SELECT text FROM pages WHERE physical_page=?", (locator["physicalPage"],)
                ).fetchone()
                if page is None:
                    return self._resolution(
                        request, snapshot, "missing", "locator physical page is not indexed"
                    )
                selectors = [cast(dict[str, Any], selector) for selector in locator["selectors"]]
                block_selector = next(
                    (selector for selector in selectors if selector["type"] == "block"), None
                )
                quote_selector = next(
                    (selector for selector in selectors if selector["type"] == "text-quote"), None
                )
                position_selector = next(
                    (selector for selector in selectors if selector["type"] == "text-position"),
                    None,
                )
                block_row = None
                if block_selector is not None:
                    block_row = connection.execute(
                        "SELECT * FROM blocks WHERE block_id=?",
                        (block_selector["blockId"],),
                    ).fetchone()
                block_candidate = None
                if block_row is not None and block_row["physical_page"] == locator["physicalPage"]:
                    block_candidate = _block_locator(
                        source,
                        snapshot,
                        block_row,
                        block_row["text"],
                        block_row["char_start"],
                        block_row["char_end"],
                        supersedes=locator["locatorId"],
                    )

                if quote_selector is not None:
                    exact = str(quote_selector["exact"])
                    if (
                        hashlib.sha256(exact.encode()).hexdigest()
                        != quote_selector["normalizedHash"]
                    ):
                        return self._resolution(
                            request, snapshot, "stale", "text quote hash is invalid"
                        )
                    quote_candidates = self._quote_candidates(
                        connection, source, snapshot, exact, locator["locatorId"]
                    )
                    if block_candidate is not None:
                        assert block_row is not None
                        if exact in str(block_row["text"]) and (
                            position_selector is None
                            or _position_matches(position_selector, str(page["text"]), exact)
                        ):
                            return self._resolution(
                                request,
                                snapshot,
                                "resolved",
                                "block and quote selectors resolved",
                                resolved=block_candidate,
                                exact_text=exact,
                            )
                    if len(quote_candidates) == 1 and block_candidate is None:
                        return self._resolution(
                            request,
                            snapshot,
                            "resolved",
                            "text quote re-anchored uniquely",
                            resolved=quote_candidates[0],
                            exact_text=exact,
                        )
                    combined = _unique_locators(
                        ([block_candidate] if block_candidate is not None else [])
                        + quote_candidates
                    )
                    if len(combined) > 1:
                        return self._resolution(
                            request,
                            snapshot,
                            "ambiguous",
                            "selectors resolve to multiple candidates",
                            candidates=combined,
                        )
                    return self._resolution(
                        request, snapshot, "stale", "text quote could not be re-anchored"
                    )

                if block_candidate is not None:
                    assert block_row is not None
                    return self._resolution(
                        request,
                        snapshot,
                        "resolved",
                        "block selector resolved",
                        resolved=block_candidate,
                        exact_text=str(block_row["text"]),
                    )
                if block_selector is not None:
                    return self._resolution(
                        request, snapshot, "stale", "block selector is not present on the page"
                    )
                if position_selector is not None:
                    start = int(position_selector["start"])
                    end = int(position_selector["end"])
                    page_text = str(page["text"])
                    if 0 <= start < end <= len(page_text):
                        exact = page_text[start:end]
                        resolved = _match_locator(
                            source,
                            snapshot,
                            locator["physicalPage"],
                            exact,
                            start,
                            end,
                            None,
                            locator["locatorId"],
                        )
                        return self._resolution(
                            request,
                            snapshot,
                            "resolved",
                            "text position selector resolved",
                            resolved=resolved,
                            exact_text=exact,
                        )
                    return self._resolution(
                        request, snapshot, "stale", "text position is outside the current page"
                    )
                return self._resolution(
                    request,
                    snapshot,
                    "page-only",
                    "page exists but selectors require an unavailable representation provider",
                )

    def _quote_candidates(
        self,
        connection: sqlite3.Connection,
        source: SourceIdentity,
        snapshot: IndexSnapshot,
        exact: str,
        supersedes: str,
    ) -> list[DocumentLocator]:
        candidates: list[DocumentLocator] = []
        pages = connection.execute("SELECT physical_page, text FROM pages ORDER BY physical_page")
        for page in pages:
            page_text = str(page["text"])
            start = page_text.find(exact)
            while start >= 0:
                end = start + len(exact)
                block = connection.execute(
                    """
                    SELECT * FROM blocks
                    WHERE physical_page=? AND char_start <= ? AND char_end >= ?
                    ORDER BY ordinal LIMIT 1
                    """,
                    (page["physical_page"], start, end),
                ).fetchone()
                candidates.append(
                    _match_locator(
                        source,
                        snapshot,
                        int(page["physical_page"]),
                        exact,
                        start,
                        end,
                        block,
                        supersedes,
                    )
                )
                if len(candidates) > 20:
                    return candidates
                start = page_text.find(exact, start + 1)
        return _unique_locators(candidates)

    def _resolution(
        self,
        request: ResolveRequest,
        snapshot: IndexSnapshot | None,
        status: Literal["resolved", "page-only", "ambiguous", "stale", "missing", "denied"],
        reason: str,
        *,
        resolved: DocumentLocator | None = None,
        exact_text: str | None = None,
        candidates: list[DocumentLocator] | None = None,
    ) -> ResolveResult:
        locator = request["locator"]
        available_candidates = candidates or []
        if not request["allowCandidates"]:
            available_candidates = []
        available_candidates = available_candidates[: request["maxCandidates"]]
        checked_hash = None if snapshot is None else snapshot.manifest["representationContentHash"]
        result: ResolveResult = {
            "schemaVersion": 1,
            "resultType": "resolve",
            "resolutionId": _opaque_digest(
                "resolution",
                locator["locatorId"],
                checked_hash or "missing",
                status,
                *(candidate["locatorId"] for candidate in available_candidates),
            ),
            "locatorId": locator["locatorId"],
            "documentId": locator["documentId"],
            "revisionId": locator["revisionId"],
            "representationId": locator["representationId"],
            "status": status,
            "checkedAt": _timestamp(),
            "reason": reason,
            "candidates": available_candidates,
        }
        if checked_hash is not None:
            result["checkedRepresentationHash"] = checked_hash
        if resolved is not None and exact_text is not None and snapshot is not None:
            resolved = self._attach_pdf_geometry(snapshot, resolved, exact_text)
        if resolved is not None:
            result["resolvedLocator"] = resolved
        if exact_text is not None:
            result["exactText"] = exact_text
        self._validate_generated(result)
        return result

    def _attach_pdf_geometry(
        self,
        snapshot: IndexSnapshot,
        locator: DocumentLocator,
        exact: str,
    ) -> DocumentLocator:
        if any(selector["type"] == "bbox" for selector in locator["selectors"]):
            return locator
        original = next(
            (
                representation
                for representation in snapshot.manifest["result"]["representations"]
                if representation["kind"] == "original-bytes"
                and representation["mediaType"] == "application/pdf"
            ),
            None,
        )
        if original is None:
            return locator
        selector = self._visual.locate_text(
            original["representationId"], locator["physicalPage"], exact
        )
        if selector is None:
            return locator
        return {**locator, "selectors": [*locator["selectors"], selector]}

    def _read_rows(
        self,
        connection: sqlite3.Connection,
        request: ReadRequest,
        snapshot: IndexSnapshot,
    ) -> tuple[list[sqlite3.Row], int, int | None, bool]:
        mode = request["mode"]
        if mode == "locate":
            locate = cast(ReadLocateRequest, request)
            if "cursor" in locate:
                raise DocumentServiceError(
                    "invalid-request", "cursor is only supported by sequential Read"
                )
            normalized = _normalize_query(locate["query"])
            rows = _search_rows(
                connection,
                normalized,
                _fts_query(normalized),
                request["limits"]["maxItems"] + 1,
                _LiteralScanBudget(),
            )
            return rows, 0, None, True
        if mode == "blocks":
            blocks_request = cast(ReadBlocksRequest, request)
            if "cursor" in blocks_request:
                raise DocumentServiceError(
                    "invalid-request", "cursor is only supported by sequential Read"
                )
            identifiers = blocks_request["blockIds"]
            placeholders = ",".join("?" for _ in identifiers)
            found = connection.execute(
                f"SELECT * FROM blocks WHERE block_id IN ({placeholders})", identifiers
            ).fetchall()
            by_id = {row["block_id"]: row for row in found}
            if any(identifier not in by_id for identifier in identifiers):
                raise DocumentServiceError("not-found", "one or more requested blocks are missing")
            return [by_id[identifier] for identifier in identifiers], 0, len(identifiers), False
        if mode == "expand":
            expand = cast(ReadExpandRequest, request)
            if "cursor" in expand:
                raise DocumentServiceError(
                    "invalid-request", "cursor is only supported by sequential Read"
                )
            target = connection.execute(
                "SELECT ordinal FROM blocks WHERE block_id=?", (expand["targetBlockId"],)
            ).fetchone()
            if target is None:
                raise DocumentServiceError("not-found", "target block is missing")
            start = max(1, int(target["ordinal"]) - expand["before"])
            end = int(target["ordinal"]) + expand["after"]
            rows = connection.execute(
                "SELECT * FROM blocks WHERE ordinal BETWEEN ? AND ? ORDER BY ordinal", (start, end)
            ).fetchall()
            return rows, 0, len(rows), False
        if mode == "page":
            page = cast(ReadPageRequest, request)
            page_exists = connection.execute(
                "SELECT 1 FROM pages WHERE physical_page=?", (page["physicalPage"],)
            ).fetchone()
            if page_exists is None:
                raise DocumentServiceError("not-found", "physical page is not indexed")
            start_ordinal, start_char = _parse_page_read_cursor(
                page.get("cursor"), snapshot.manifest["representationId"], page["physicalPage"]
            )
            total = int(
                connection.execute(
                    "SELECT count(*) FROM blocks WHERE physical_page=?",
                    (page["physicalPage"],),
                ).fetchone()[0]
            )
            rows = connection.execute(
                """
                SELECT * FROM blocks
                WHERE physical_page=? AND ordinal>=?
                ORDER BY page_block_index
                """,
                (page["physicalPage"], start_ordinal),
            ).fetchall()
            if page.get("cursor") is not None and not rows:
                raise DocumentServiceError("invalid-request", "page Read cursor is exhausted")
            if rows and start_char > len(str(rows[0]["text"])):
                raise DocumentServiceError(
                    "invalid-request", "page Read cursor character offset is invalid"
                )
            return rows, start_char, total, False
        sequential = cast(ReadSequentialRequest, request)
        cursor = sequential.get("cursor")
        start_ordinal, start_char = _parse_read_cursor(
            cursor, snapshot.manifest["representationId"]
        )
        total = int(connection.execute("SELECT count(*) FROM blocks").fetchone()[0])
        rows = connection.execute(
            "SELECT * FROM blocks WHERE ordinal >= ? ORDER BY ordinal LIMIT ?",
            (start_ordinal, request["limits"]["maxItems"] + 1),
        ).fetchall()
        if rows and start_char > len(str(rows[0]["text"])):
            raise DocumentServiceError("invalid-request", "Read cursor character offset is invalid")
        return rows, start_char, total, False

    def _bounded_blocks(
        self,
        rows: list[sqlite3.Row],
        source: SourceIdentity,
        snapshot: IndexSnapshot,
        max_items: int,
        max_chars: int,
        start_char: int,
    ) -> tuple[list[ReadItem], int, bool, int | None, int]:
        items: list[ReadItem] = []
        used = 0
        next_ordinal: int | None = None
        next_char = 0
        for row_index, row in enumerate(rows):
            if len(items) >= max_items:
                next_ordinal = int(row["ordinal"])
                break
            offset = start_char if row_index == 0 else 0
            text = str(row["text"])[offset:]
            remaining = max_chars - used
            if remaining <= 0:
                next_ordinal = int(row["ordinal"])
                next_char = offset
                break
            rendered = text[:remaining]
            if not rendered:
                continue
            char_start = int(row["char_start"]) + offset
            char_end = char_start + len(rendered)
            locator = _block_locator(source, snapshot, row, rendered, char_start, char_end)
            items.append(
                {
                    "itemType": "block",
                    "blockId": row["block_id"],
                    "physicalPage": row["physical_page"],
                    "kind": row["kind"],
                    "text": rendered,
                    "locator": locator,
                }
            )
            used += len(rendered)
            if len(rendered) < len(text):
                next_ordinal = int(row["ordinal"])
                next_char = offset + len(rendered)
                break
        truncated = next_ordinal is not None or len(items) < len(rows)
        if next_ordinal is None and len(items) < len(rows):
            next_ordinal = int(rows[len(items)]["ordinal"])
        return items, used, truncated, next_ordinal, next_char

    def _validate(self, value: object) -> None:
        issues = validate_contract_shape("sidecar-document-rpc", value)
        if issues:
            raise DocumentServiceError("invalid-request", issues[0].message)

    def _validate_generated(self, value: object) -> None:
        issues = validate_contract_shape("sidecar-document-rpc", value)
        if issues:
            raise DocumentServiceError("integrity-error", issues[0].message)

    def _require_representation(self, snapshot: IndexSnapshot, source: SourceIdentity) -> None:
        if snapshot.manifest["representationId"] != source["representationId"]:
            raise DocumentServiceError("stale", "requested representation is not the current index")


def _read_connection(snapshot: IndexSnapshot) -> closing[sqlite3.Connection]:
    connection = sqlite3.connect(f"file:{snapshot.database_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA trusted_schema=OFF")
    return closing(connection)


def _normalize_query(query: str) -> str:
    normalized = _SPACE.sub(" ", query).strip().casefold()
    if not normalized:
        raise DocumentServiceError("invalid-request", "query must contain searchable text")
    return normalized


def _fts_query(query: str) -> str:
    tokens = _QUERY_TOKEN.findall(query)
    if not tokens:
        raise DocumentServiceError("invalid-request", "query contains no searchable tokens")
    if len(tokens) > 64 or any(len(token) > 256 for token in tokens):
        raise DocumentServiceError("limit-exceeded", "query exceeds the FTS term limit")
    return " OR ".join(f'"{token}"' for token in tokens)


def _search_rows(
    connection: sqlite3.Connection,
    normalized_query: str,
    fts_query: str,
    limit: int,
    budget: _LiteralScanBudget,
) -> list[sqlite3.Row]:
    rows = connection.execute(
        """
        SELECT b.*, bm25(blocks_fts) AS rank, 'fts' AS matched_by
        FROM blocks_fts JOIN blocks AS b ON b.block_id=blocks_fts.block_id
        WHERE blocks_fts MATCH ? ORDER BY rank, b.ordinal LIMIT ?
        """,
        (fts_query, limit),
    ).fetchall()
    terms = tuple(
        dict.fromkeys(
            token
            for token in _QUERY_TOKEN.findall(normalized_query)
            if _HAN_CHARACTER.search(token)
        )
    )
    if not terms:
        return rows
    # unicode61 treats a continuous Han sentence as one token. Supplement only
    # actual literal occurrences; this is not segmentation or semantic retrieval.
    # Complete the bounded scan before returning any page, so a scope exceeding
    # the allowance never masquerades as a complete empty/partial result.
    seen = {row["block_id"] for row in rows}
    extras: list[sqlite3.Row] = []
    with closing(
        connection.execute(
            "SELECT b.*, 0.0 AS rank, 'literal-han' AS matched_by "
            "FROM blocks AS b ORDER BY b.ordinal LIMIT ?",
            (max(0, _LITERAL_SCAN_BLOCKS - budget.blocks) + 1,),
        )
    ) as cursor:
        for row in cursor:
            text = row["text"].casefold()
            budget.consume(len(text), len(terms))
            if row["block_id"] not in seen and any(term in text for term in terms):
                if len(extras) < limit:
                    extras.append(row)
    return sorted([*rows, *extras], key=lambda row: (float(row["rank"]), row["ordinal"]))[:limit]


def _preview(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def _search_cursor(query_hash: str, offset: int) -> str:
    return f"cursor:search:{query_hash[:16]}:{offset}"


def _parse_search_cursor(cursor: str | None, query_hash: str) -> int:
    if cursor is None:
        return 0
    match = re.fullmatch(r"cursor:search:([a-f0-9]{16}):(\d+)", cursor)
    if match is None or match.group(1) != query_hash[:16]:
        raise DocumentServiceError("invalid-request", "search cursor does not match query")
    offset = int(match.group(2))
    if offset > 1_000_000:
        raise DocumentServiceError("invalid-request", "search cursor offset is too large")
    return offset


def _read_cursor(representation_id: str, ordinal: int, char_offset: int) -> str:
    identity = hashlib.sha256(representation_id.encode()).hexdigest()[:16]
    return f"cursor:read:{identity}:{ordinal}:{char_offset}"


def _page_read_cursor(
    representation_id: str, physical_page: int, ordinal: int, char_offset: int
) -> str:
    identity = hashlib.sha256(representation_id.encode()).hexdigest()[:16]
    return f"cursor:page:{identity}:{physical_page}:{ordinal}:{char_offset}"


def _parse_page_read_cursor(
    cursor: str | None, representation_id: str, physical_page: int
) -> tuple[int, int]:
    if cursor is None:
        return 1, 0
    match = re.fullmatch(r"cursor:page:([a-f0-9]{16}):(\d+):(\d+):(\d+)", cursor)
    identity = hashlib.sha256(representation_id.encode()).hexdigest()[:16]
    if match is None or match.group(1) != identity or int(match.group(2)) != physical_page:
        raise DocumentServiceError(
            "invalid-request", "page Read cursor does not match representation and page"
        )
    ordinal = int(match.group(3))
    char_offset = int(match.group(4))
    if ordinal < 1 or ordinal > 1_000_000 or char_offset > 20_000:
        raise DocumentServiceError("invalid-request", "page Read cursor bounds are invalid")
    return ordinal, char_offset


def _parse_read_cursor(cursor: str | None, representation_id: str) -> tuple[int, int]:
    if cursor is None:
        return 1, 0
    match = re.fullmatch(r"cursor:read:([a-f0-9]{16}):(\d+):(\d+)", cursor)
    identity = hashlib.sha256(representation_id.encode()).hexdigest()[:16]
    if match is None or match.group(1) != identity:
        raise DocumentServiceError("invalid-request", "Read cursor does not match representation")
    ordinal = int(match.group(2))
    char_offset = int(match.group(3))
    if ordinal < 1 or ordinal > 1_000_000 or char_offset > 20_000:
        raise DocumentServiceError("invalid-request", "Read cursor bounds are invalid")
    return ordinal, char_offset


def _block_locator(
    source: SourceIdentity,
    snapshot: IndexSnapshot,
    row: sqlite3.Row,
    text: str,
    char_start: int,
    char_end: int,
    supersedes: str | None = None,
) -> DocumentLocator:
    quote_hash = hashlib.sha256(text.encode()).hexdigest()
    locator_id = _opaque_digest(
        "loc",
        source["documentId"],
        source["revisionId"],
        source["representationId"],
        str(row["physical_page"]),
        str(row["block_id"]),
        str(char_start),
        str(char_end),
        quote_hash,
    )
    locator: DocumentLocator = {
        "schemaVersion": 1,
        "locatorId": locator_id,
        "documentId": source["documentId"],
        "revisionId": source["revisionId"],
        "representationId": source["representationId"],
        "representationContentHash": snapshot.manifest["representationContentHash"],
        "physicalPage": row["physical_page"],
        "selectors": [
            {"type": "block", "blockId": row["block_id"]},
            {
                "type": "text-position",
                "start": char_start,
                "end": char_end,
                "unit": "unicode-scalar",
            },
            {"type": "text-quote", "exact": text, "normalizedHash": quote_hash},
        ],
        "createdAt": snapshot.manifest["publishedAt"],
    }
    if supersedes is not None and supersedes != locator_id:
        locator["supersedesLocatorId"] = supersedes
    return locator


def _visual_locator(
    source: SourceIdentity,
    snapshot: IndexSnapshot,
    asset_id: str,
    physical_page: int,
) -> DocumentLocator:
    locator_id = _opaque_digest(
        "loc",
        source["documentId"],
        source["revisionId"],
        source["representationId"],
        str(physical_page),
        asset_id,
    )
    return {
        "schemaVersion": 1,
        "locatorId": locator_id,
        "documentId": source["documentId"],
        "revisionId": source["revisionId"],
        "representationId": source["representationId"],
        "representationContentHash": snapshot.manifest["representationContentHash"],
        "physicalPage": physical_page,
        "selectors": [
            {
                "type": "bbox",
                "unit": "ratio",
                "x": 0,
                "y": 0,
                "width": 1,
                "height": 1,
                "rotation": 0,
            }
        ],
        "createdAt": snapshot.manifest["publishedAt"],
    }


def _match_locator(
    source: SourceIdentity,
    snapshot: IndexSnapshot,
    physical_page: int,
    exact: str,
    start: int,
    end: int,
    block: sqlite3.Row | None,
    supersedes: str,
) -> DocumentLocator:
    quote_hash = hashlib.sha256(exact.encode()).hexdigest()
    selectors: list[dict[str, Any]] = []
    if block is not None:
        selectors.append({"type": "block", "blockId": block["block_id"]})
    selectors.extend(
        [
            {"type": "text-position", "start": start, "end": end, "unit": "unicode-scalar"},
            {"type": "text-quote", "exact": exact, "normalizedHash": quote_hash},
        ]
    )
    locator_id = _opaque_digest(
        "loc",
        source["documentId"],
        source["revisionId"],
        source["representationId"],
        str(physical_page),
        str(start),
        str(end),
        quote_hash,
    )
    locator: DocumentLocator = {
        "schemaVersion": 1,
        "locatorId": locator_id,
        "documentId": source["documentId"],
        "revisionId": source["revisionId"],
        "representationId": source["representationId"],
        "representationContentHash": snapshot.manifest["representationContentHash"],
        "physicalPage": physical_page,
        "selectors": cast(Any, selectors),
        "createdAt": snapshot.manifest["publishedAt"],
    }
    if locator_id != supersedes:
        locator["supersedesLocatorId"] = supersedes
    return locator


def _position_matches(selector: dict[str, Any], page_text: str, exact: str) -> bool:
    start = int(selector["start"])
    end = int(selector["end"])
    return 0 <= start < end <= len(page_text) and page_text[start:end] == exact


def _unique_locators(values: list[DocumentLocator]) -> list[DocumentLocator]:
    output: list[DocumentLocator] = []
    seen: set[str] = set()
    for value in values:
        if value["locatorId"] in seen:
            continue
        seen.add(value["locatorId"])
        output.append(value)
    return output


def _opaque_digest(prefix: str, *values: str) -> str:
    digest = hashlib.sha256(chr(0).join(values).encode()).hexdigest()[:32]
    return f"{prefix}:{digest}"


def _timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


__all__ = ["DocumentService", "DocumentServiceError"]
