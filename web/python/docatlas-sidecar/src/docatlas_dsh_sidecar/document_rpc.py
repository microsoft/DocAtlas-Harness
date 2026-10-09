"""Typed sidecar document RPC bindings and cross-field semantic checks."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict

from .contracts import (
    DocumentLocator,
    DocumentRevision,
    OpaqueId,
    PageInfo,
    Sha256,
    SourceRepresentation,
)


class SourceIdentity(TypedDict):
    documentId: OpaqueId
    revisionId: OpaqueId
    representationId: OpaqueId


class SourceBinding(TypedDict):
    schemaVersion: Literal[1]
    bindingId: OpaqueId
    rootId: OpaqueId
    relativePath: str
    expectedContentHash: Sha256
    byteLength: int
    mediaType: str


class IngestOptions(TypedDict):
    forceRebuild: bool
    allowOcr: bool
    maxPages: NotRequired[int]


class IngestRequest(TypedDict):
    schemaVersion: Literal[1]
    requestType: Literal["ingest"]
    idempotencyKey: OpaqueId
    revision: DocumentRevision
    sourceBinding: SourceBinding
    requestedRepresentationKinds: list[
        Literal[
            "embedded-text",
            "ocr-text",
            "derived-markdown",
            "page-image",
            "table-extraction",
            "figure-crop",
            "model-description",
        ]
    ]
    options: IngestOptions


class IngestIndex(TypedDict):
    status: Literal["ready", "partial"]
    blockCount: int
    indexedPages: int
    totalPages: int
    textQuality: Literal["empty", "sparse", "garbled", "usable"]


class IngestResult(TypedDict):
    schemaVersion: Literal[1]
    resultType: Literal["ingest"]
    idempotencyKey: OpaqueId
    documentId: OpaqueId
    revisionId: OpaqueId
    cacheStatus: Literal["created", "reused", "refreshed"]
    representations: list[SourceRepresentation]
    index: IngestIndex
    warnings: list[str]


class TextLimits(TypedDict):
    maxItems: int
    maxChars: int


class SearchRequest(TypedDict):
    schemaVersion: Literal[1]
    requestType: Literal["search"]
    scopeVersionId: OpaqueId
    sources: list[SourceIdentity]
    query: str
    strategy: Literal["tree", "fts", "combined"]
    limits: TextLimits
    cursor: NotRequired[OpaqueId]


class SearchCandidate(SourceIdentity):
    candidateId: OpaqueId
    physicalPageStart: int
    physicalPageEnd: int
    blockIds: list[OpaqueId]
    title: str
    preview: str
    matchKind: Literal["tree", "lexical", "combined"]
    score: NotRequired[int | float]
    reason: str


class SearchResult(TypedDict):
    schemaVersion: Literal[1]
    resultType: Literal["search"]
    scopeVersionId: OpaqueId
    queryHash: Sha256
    candidates: list[SearchCandidate]
    pageInfo: PageInfo


class ReadRequestBase(TypedDict):
    schemaVersion: Literal[1]
    requestType: Literal["read"]
    source: SourceIdentity
    limits: TextLimits
    cursor: NotRequired[OpaqueId]


class ReadLocateRequest(ReadRequestBase):
    mode: Literal["locate"]
    query: str


class ReadBlocksRequest(ReadRequestBase):
    mode: Literal["blocks"]
    blockIds: list[OpaqueId]


class ReadExpandRequest(ReadRequestBase):
    mode: Literal["expand"]
    targetBlockId: OpaqueId
    before: int
    after: int


class ReadSequentialRequest(ReadRequestBase):
    mode: Literal["sequential"]


class ReadPageRequest(ReadRequestBase):
    """Internal bounded page primitive used by the authenticated browser Reader."""

    mode: Literal["page"]
    physicalPage: int


class ReadVisualPageRequest(ReadRequestBase):
    mode: Literal["visual"]
    physicalPage: int
    maxPixels: NotRequired[int]


class ReadVisualFigureRequest(ReadRequestBase):
    mode: Literal["visual"]
    figureId: OpaqueId
    maxPixels: NotRequired[int]


type ReadRequest = (
    ReadLocateRequest
    | ReadBlocksRequest
    | ReadExpandRequest
    | ReadSequentialRequest
    | ReadPageRequest
    | ReadVisualPageRequest
    | ReadVisualFigureRequest
)


class TextBlockItem(TypedDict):
    itemType: Literal["block"]
    blockId: OpaqueId
    physicalPage: int
    kind: Literal["heading", "paragraph", "list", "table", "caption", "other"]
    text: str
    locator: DocumentLocator


class VisualAsset(TypedDict):
    assetId: OpaqueId
    contentHash: Sha256
    mediaType: Literal["image/png", "image/jpeg", "image/webp"]
    byteLength: int
    width: int
    height: int


class VisualAssetItem(TypedDict):
    itemType: Literal["visual"]
    physicalPage: int
    asset: VisualAsset
    locator: DocumentLocator


type ReadItem = TextBlockItem | VisualAssetItem


class ReadResult(TypedDict):
    schemaVersion: Literal[1]
    resultType: Literal["read"]
    mode: Literal["locate", "blocks", "expand", "sequential", "visual", "page"]
    source: SourceIdentity
    textQuality: Literal["empty", "sparse", "garbled", "usable", "not-applicable"]
    items: list[ReadItem]
    pageInfo: PageInfo


class ResolveRequest(TypedDict):
    schemaVersion: Literal[1]
    requestType: Literal["resolve"]
    locator: DocumentLocator
    allowCandidates: bool
    maxCandidates: int


class ResolveResult(SourceIdentity):
    schemaVersion: Literal[1]
    resultType: Literal["resolve"]
    resolutionId: OpaqueId
    locatorId: OpaqueId
    status: Literal["resolved", "page-only", "ambiguous", "stale", "missing", "denied"]
    checkedRepresentationHash: NotRequired[Sha256]
    checkedAt: str
    exactText: NotRequired[str]
    reason: NotRequired[str]
    resolvedLocator: NotRequired[DocumentLocator]
    candidates: list[DocumentLocator]


type SidecarDocumentRpcValue = (
    IngestRequest
    | IngestResult
    | SearchRequest
    | SearchResult
    | ReadRequest
    | ReadResult
    | ResolveRequest
    | ResolveResult
)

type DocumentRpcIssueCode = Literal[
    "source-binding-absolute-or-unsafe-path",
    "ingest-binding-hash-mismatch",
    "ingest-binding-length-mismatch",
    "ingest-binding-media-type-mismatch",
    "ingest-result-identity-mismatch",
    "ingest-index-page-overflow",
    "search-candidate-page-order",
    "read-item-identity-mismatch",
    "read-item-page-mismatch",
    "resolve-result-identity-mismatch",
    "resolve-resolved-target-missing",
    "resolve-nonresolved-target-present",
]


@dataclass(frozen=True, slots=True)
class DocumentRpcIssue:
    code: DocumentRpcIssueCode
    path: str
    message: str


_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")


def source_binding_issues(binding: SourceBinding) -> list[DocumentRpcIssue]:
    path = binding["relativePath"]
    unsafe = (
        path.startswith("/")
        or _WINDOWS_DRIVE.match(path) is not None
        or "\\" in path
        or ":" in path
        or any(part in {"", ".", ".."} for part in path.split("/"))
    )
    if not unsafe:
        return []
    return [
        DocumentRpcIssue(
            "source-binding-absolute-or-unsafe-path",
            "/relativePath",
            "source binding paths must be normalized relative paths "
            "without empty or parent segments",
        )
    ]


def ingest_request_issues(value: IngestRequest) -> list[DocumentRpcIssue]:
    issues = source_binding_issues(value["sourceBinding"])
    binding = value["sourceBinding"]
    revision = value["revision"]
    comparisons: tuple[tuple[bool, DocumentRpcIssue], ...] = (
        (
            binding["expectedContentHash"] != revision["contentHash"],
            DocumentRpcIssue(
                "ingest-binding-hash-mismatch",
                "/sourceBinding/expectedContentHash",
                "source binding hash must match the immutable revision hash",
            ),
        ),
        (
            binding["byteLength"] != revision["byteLength"],
            DocumentRpcIssue(
                "ingest-binding-length-mismatch",
                "/sourceBinding/byteLength",
                "source binding length must match the immutable revision length",
            ),
        ),
        (
            binding["mediaType"] != revision["mediaType"],
            DocumentRpcIssue(
                "ingest-binding-media-type-mismatch",
                "/sourceBinding/mediaType",
                "source binding media type must match the immutable revision media type",
            ),
        ),
    )
    issues.extend(issue for failed, issue in comparisons if failed)
    return issues


def ingest_result_issues(value: IngestResult) -> list[DocumentRpcIssue]:
    issues = [
        DocumentRpcIssue(
            "ingest-result-identity-mismatch",
            f"/representations/{index}",
            "every representation must belong to the ingest result document revision",
        )
        for index, representation in enumerate(value["representations"])
        if representation["documentId"] != value["documentId"]
        or representation["revisionId"] != value["revisionId"]
    ]
    if value["index"]["indexedPages"] > value["index"]["totalPages"]:
        issues.append(
            DocumentRpcIssue(
                "ingest-index-page-overflow",
                "/index/indexedPages",
                "indexed pages must not exceed total pages",
            )
        )
    return issues


def search_result_issues(value: SearchResult) -> list[DocumentRpcIssue]:
    return [
        DocumentRpcIssue(
            "search-candidate-page-order",
            f"/candidates/{index}",
            "candidate page start must not exceed page end",
        )
        for index, candidate in enumerate(value["candidates"])
        if candidate["physicalPageStart"] > candidate["physicalPageEnd"]
    ]


def read_result_issues(value: ReadResult) -> list[DocumentRpcIssue]:
    issues: list[DocumentRpcIssue] = []
    for index, item in enumerate(value["items"]):
        locator = item["locator"]
        source = value["source"]
        if (
            locator["documentId"] != source["documentId"]
            or locator["revisionId"] != source["revisionId"]
            or locator["representationId"] != source["representationId"]
        ):
            issues.append(
                DocumentRpcIssue(
                    "read-item-identity-mismatch",
                    f"/items/{index}/locator",
                    "read item locator must belong to the requested source identity",
                )
            )
        if locator["physicalPage"] != item["physicalPage"]:
            issues.append(
                DocumentRpcIssue(
                    "read-item-page-mismatch",
                    f"/items/{index}/physicalPage",
                    "read item page must match its locator page",
                )
            )
    return issues


def resolve_result_issues(value: ResolveResult, request: ResolveRequest) -> list[DocumentRpcIssue]:
    issues: list[DocumentRpcIssue] = []
    locator = request["locator"]
    if (
        value["locatorId"] != locator["locatorId"]
        or value["documentId"] != locator["documentId"]
        or value["revisionId"] != locator["revisionId"]
        or value["representationId"] != locator["representationId"]
    ):
        issues.append(
            DocumentRpcIssue(
                "resolve-result-identity-mismatch",
                "/",
                "resolve result identity must match the requested locator",
            )
        )
    if value["status"] == "resolved" and "resolvedLocator" not in value:
        issues.append(
            DocumentRpcIssue(
                "resolve-resolved-target-missing",
                "/resolvedLocator",
                "resolved results require an exact resolved locator",
            )
        )
    if value["status"] != "resolved" and "resolvedLocator" in value:
        issues.append(
            DocumentRpcIssue(
                "resolve-nonresolved-target-present",
                "/resolvedLocator",
                "non-resolved results cannot expose an exact resolved locator",
            )
        )
    return issues


__all__ = [
    "DocumentRpcIssue",
    "IngestRequest",
    "IngestResult",
    "ReadRequest",
    "ReadResult",
    "ResolveRequest",
    "ResolveResult",
    "SearchRequest",
    "SearchResult",
    "SidecarDocumentRpcValue",
    "SourceBinding",
    "ingest_request_issues",
    "ingest_result_issues",
    "read_result_issues",
    "resolve_result_issues",
    "search_result_issues",
    "source_binding_issues",
]
