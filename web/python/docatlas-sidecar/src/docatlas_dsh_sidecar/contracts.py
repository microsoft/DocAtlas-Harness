"""Typed M0 domain bindings and semantic checks shared with Host fixtures.

JSON Schema owns wire shape. These checks cover invariants that need values
from multiple fields or objects and therefore cannot be expressed reliably by
shape validation alone.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict

type ContractSchemaVersion = Literal[1]
type OpaqueId = str
type Sha256 = str
type IsoTimestamp = str
type ActorKind = Literal["user", "agent", "system", "rule"]
type SourceRole = Literal["primary", "secondary", "external", "user-authored", "model-derived"]
type ProtocolErrorCode = Literal[
    "invalid-request",
    "invalid-params",
    "not-found",
    "conflict",
    "stale",
    "permission-denied",
    "limit-exceeded",
    "cancelled",
    "unavailable",
    "integrity-error",
    "internal",
]
type ProtocolNextAction = Literal[
    "retry",
    "reduce-scope",
    "request-access",
    "open-old-revision",
    "re-anchor",
    "load-next",
    "choose-candidate",
    "contact-operator",
]


class ActorRef(TypedDict):
    kind: ActorKind
    actorId: OpaqueId


class ProtocolErrorDetail(TypedDict):
    path: NotRequired[str]
    reason: str
    expected: NotRequired[str]
    actual: NotRequired[str]


class ProtocolError(TypedDict):
    schemaVersion: ContractSchemaVersion
    code: ProtocolErrorCode
    message: str
    retryable: bool
    correlationId: NotRequired[OpaqueId]
    details: NotRequired[list[ProtocolErrorDetail]]
    nextActions: NotRequired[list[ProtocolNextAction]]


class PageInfo(TypedDict):
    schemaVersion: ContractSchemaVersion
    limit: int
    returned: int
    total: NotRequired[int]
    usedChars: NotRequired[int]
    truncated: bool
    completeness: Literal["candidate", "partial", "complete"]
    nextCursor: NotRequired[OpaqueId]


class DocumentOrigin(TypedDict):
    kind: Literal["local-file", "upload", "remote-url", "provider", "generated"]
    providerId: NotRequired[OpaqueId]
    externalId: NotRequired[str]


class DocumentRevision(TypedDict):
    schemaVersion: ContractSchemaVersion
    documentId: OpaqueId
    revisionId: OpaqueId
    contentHash: Sha256
    byteLength: int
    mediaType: str
    displayName: str
    origin: DocumentOrigin
    ingestedAt: IsoTimestamp
    sourceModifiedAt: NotRequired[IsoTimestamp]
    previousRevisionId: NotRequired[OpaqueId]
    supersededByRevisionId: NotRequired[OpaqueId]
    pageCount: NotRequired[int]
    status: Literal["active", "superseded", "deleted", "quarantined"]


class RepresentationGenerator(TypedDict):
    name: str
    version: str
    configHash: Sha256


class SourceRepresentation(TypedDict):
    schemaVersion: ContractSchemaVersion
    representationId: OpaqueId
    documentId: OpaqueId
    revisionId: OpaqueId
    kind: Literal[
        "original-bytes",
        "page-image",
        "embedded-text",
        "ocr-text",
        "derived-markdown",
        "table-extraction",
        "figure-crop",
        "model-description",
    ]
    mediaType: str
    contentHash: Sha256
    byteLength: int
    pageCount: NotRequired[int]
    textQuality: NotRequired[Literal["empty", "sparse", "garbled", "usable", "not-applicable"]]
    derivedFromRepresentationIds: list[OpaqueId]
    generator: NotRequired[RepresentationGenerator]
    createdAt: IsoTimestamp
    status: Literal["current", "stale", "failed", "deleted"]


class AssetDescriptor(TypedDict):
    schemaVersion: ContractSchemaVersion
    assetId: OpaqueId
    kind: Literal["original-bytes", "page-image", "figure-crop"]
    documentId: OpaqueId
    revisionId: OpaqueId
    representationId: OpaqueId
    representationContentHash: Sha256
    contentHash: Sha256
    mediaType: Literal["application/pdf", "text/markdown", "text/plain", "image/png", "image/jpeg"]
    byteLength: int
    physicalPage: NotRequired[int]
    width: NotRequired[int]
    height: NotRequired[int]
    figureId: NotRequired[OpaqueId]
    generator: NotRequired[RepresentationGenerator]
    createdAt: IsoTimestamp


class IncludedSource(TypedDict):
    documentId: OpaqueId
    revisionId: OpaqueId
    role: SourceRole
    reason: NotRequired[str]


class ExcludedSource(TypedDict):
    documentId: OpaqueId
    revisionId: OpaqueId
    reason: Literal["user", "policy", "permission", "out-of-date", "duplicate", "other"]
    detail: NotRequired[str]


class SourceScopeVersion(TypedDict):
    schemaVersion: ContractSchemaVersion
    scopeVersionId: OpaqueId
    workspaceId: OpaqueId
    investigationId: OpaqueId
    version: int
    previousScopeVersionId: NotRequired[OpaqueId]
    included: list[IncludedSource]
    excluded: list[ExcludedSource]
    locked: bool
    policyTags: NotRequired[list[OpaqueId]]
    createdBy: ActorRef
    createdAt: IsoTimestamp


class BlockSelector(TypedDict):
    type: Literal["block"]
    blockId: OpaqueId


class TextQuoteSelector(TypedDict):
    type: Literal["text-quote"]
    exact: str
    prefix: NotRequired[str]
    suffix: NotRequired[str]
    normalizedHash: Sha256


class TextPositionSelector(TypedDict):
    type: Literal["text-position"]
    start: int
    end: int
    unit: Literal["unicode-scalar"]


class RatioBBoxSelector(TypedDict):
    type: Literal["bbox"]
    unit: Literal["ratio"]
    x: int | float
    y: int | float
    width: int | float
    height: int | float
    rotation: Literal[0, 90, 180, 270]


class PdfPointBBoxSelector(TypedDict):
    type: Literal["bbox"]
    unit: Literal["pdf-point"]
    x: int | float
    y: int | float
    width: int | float
    height: int | float
    rotation: Literal[0, 90, 180, 270]


class TableCellSelector(TypedDict):
    type: Literal["table-cell"]
    tableId: OpaqueId
    row: NotRequired[int]
    column: NotRequired[int]


class FigureSelector(TypedDict):
    type: Literal["figure"]
    figureId: OpaqueId


type DocumentSelector = (
    BlockSelector
    | TextQuoteSelector
    | TextPositionSelector
    | RatioBBoxSelector
    | PdfPointBBoxSelector
    | TableCellSelector
    | FigureSelector
)


class DocumentLocator(TypedDict):
    schemaVersion: ContractSchemaVersion
    locatorId: OpaqueId
    documentId: OpaqueId
    revisionId: OpaqueId
    representationId: OpaqueId
    representationContentHash: Sha256
    physicalPage: int
    selectors: list[DocumentSelector]
    supersedesLocatorId: NotRequired[OpaqueId]
    createdAt: IsoTimestamp


class EvidenceContent(TypedDict):
    mediaType: str
    text: NotRequired[str]
    assetId: NotRequired[OpaqueId]


class EvidenceAtom(TypedDict):
    schemaVersion: ContractSchemaVersion
    evidenceId: OpaqueId
    documentId: OpaqueId
    revisionId: OpaqueId
    representationId: OpaqueId
    locatorId: OpaqueId
    kind: Literal["quote", "table-cell", "figure", "visual-observation"]
    content: EvidenceContent
    contentHash: Sha256
    sourceRole: SourceRole
    resolutionStatus: Literal["resolved", "page-only", "ambiguous", "stale", "missing", "denied"]
    status: Literal["current", "stale", "withdrawn", "deleted"]
    createdBy: ActorRef
    provenanceActivityId: OpaqueId
    createdAt: IsoTimestamp


class LegacyDocumentCandidate(TypedDict):
    documentId: OpaqueId
    revisionId: OpaqueId


class LegacyEvidenceLead(TypedDict):
    schemaVersion: ContractSchemaVersion
    leadId: OpaqueId
    legacyKind: Literal["note-evidence", "page-finding", "read-history", "search-history"]
    sourceSessionId: OpaqueId
    rawSource: str
    rawContent: NotRequired[str]
    physicalPageCandidate: NotRequired[int]
    documentCandidates: list[LegacyDocumentCandidate]
    resolutionStatus: Literal["unresolved"]
    verificationStatus: Literal["unverified"]
    importedBy: ActorRef
    importedAt: IsoTimestamp


class LegacyEvidenceLeadInput(TypedDict):
    leadId: OpaqueId
    legacyKind: Literal["note-evidence", "page-finding", "read-history", "search-history"]
    sourceSessionId: OpaqueId
    rawSource: str
    rawContent: NotRequired[str]
    documentCandidates: list[LegacyDocumentCandidate]
    importedBy: ActorRef
    importedAt: IsoTimestamp


_LEGACY_PHYSICAL_PAGE = re.compile(r"\b(?:page|p\.)\s*([1-9][0-9]*)\b", re.IGNORECASE)


def build_legacy_evidence_lead(input_value: LegacyEvidenceLeadInput) -> LegacyEvidenceLead:
    """Convert page-only legacy material into an unresolved, unverified lead."""
    raw_source = input_value["rawSource"].strip()
    if not raw_source:
        raise ValueError("legacy evidence rawSource must not be empty")
    match = _LEGACY_PHYSICAL_PAGE.search(raw_source)
    result: LegacyEvidenceLead = {
        "schemaVersion": 1,
        "leadId": input_value["leadId"],
        "legacyKind": input_value["legacyKind"],
        "sourceSessionId": input_value["sourceSessionId"],
        "rawSource": raw_source,
        "documentCandidates": input_value["documentCandidates"],
        "resolutionStatus": "unresolved",
        "verificationStatus": "unverified",
        "importedBy": input_value["importedBy"],
        "importedAt": input_value["importedAt"],
    }
    if "rawContent" in input_value:
        result["rawContent"] = input_value["rawContent"]
    if match is not None:
        result["physicalPageCandidate"] = int(match.group(1))
    return result


type ContractIssueCode = Literal[
    "page-returned-exceeds-limit",
    "page-returned-exceeds-total",
    "revision-self-previous",
    "revision-self-supersedes",
    "representation-self-derived",
    "representation-revision-mismatch",
    "representation-original-hash-mismatch",
    "scope-first-version-has-previous",
    "scope-later-version-missing-previous",
    "scope-duplicate-included",
    "scope-duplicate-excluded",
    "scope-included-and-excluded",
    "locator-self-supersedes",
    "locator-text-position-order",
    "locator-ratio-bounds",
    "evidence-locator-mismatch",
    "asset-original-hash-mismatch",
    "asset-original-visual-fields",
    "asset-pixel-limit",
    "asset-byte-limit",
    "asset-page-has-figure",
]


@dataclass(frozen=True, slots=True)
class ContractIssue:
    code: ContractIssueCode
    path: str
    message: str


def page_info_issues(value: PageInfo) -> list[ContractIssue]:
    issues: list[ContractIssue] = []
    if value["returned"] > value["limit"]:
        issues.append(
            ContractIssue(
                "page-returned-exceeds-limit",
                "/returned",
                "returned must not exceed limit",
            )
        )
    total = value.get("total")
    if total is not None and value["returned"] > total:
        issues.append(
            ContractIssue(
                "page-returned-exceeds-total",
                "/returned",
                "returned must not exceed total",
            )
        )
    return issues


def document_revision_issues(value: DocumentRevision) -> list[ContractIssue]:
    issues: list[ContractIssue] = []
    if value.get("previousRevisionId") == value["revisionId"]:
        issues.append(
            ContractIssue(
                "revision-self-previous",
                "/previousRevisionId",
                "a revision cannot name itself as its previous revision",
            )
        )
    if value.get("supersededByRevisionId") == value["revisionId"]:
        issues.append(
            ContractIssue(
                "revision-self-supersedes",
                "/supersededByRevisionId",
                "a revision cannot supersede itself",
            )
        )
    return issues


def source_representation_issues(
    value: SourceRepresentation,
    revision: DocumentRevision | None = None,
) -> list[ContractIssue]:
    issues: list[ContractIssue] = []
    if value["representationId"] in value["derivedFromRepresentationIds"]:
        issues.append(
            ContractIssue(
                "representation-self-derived",
                "/derivedFromRepresentationIds",
                "a representation cannot derive from itself",
            )
        )
    if revision is not None and (
        value["documentId"] != revision["documentId"]
        or value["revisionId"] != revision["revisionId"]
    ):
        issues.append(
            ContractIssue(
                "representation-revision-mismatch",
                "/",
                "representation document/revision identity must match its revision",
            )
        )
    if (
        revision is not None
        and value["kind"] == "original-bytes"
        and value["contentHash"] != revision["contentHash"]
    ):
        issues.append(
            ContractIssue(
                "representation-original-hash-mismatch",
                "/contentHash",
                "the original representation hash must match the revision content hash",
            )
        )
    return issues


def asset_descriptor_issues(value: AssetDescriptor) -> list[ContractIssue]:
    issues: list[ContractIssue] = []
    if value["kind"] == "original-bytes":
        if value["contentHash"] != value["representationContentHash"]:
            issues.append(
                ContractIssue(
                    "asset-original-hash-mismatch",
                    "/contentHash",
                    "original asset hashes must match",
                )
            )
        if any(
            field in value for field in ("physicalPage", "width", "height", "figureId", "generator")
        ):
            issues.append(
                ContractIssue(
                    "asset-original-visual-fields",
                    "/",
                    "original asset cannot carry visual fields",
                )
            )
        return issues
    width = value.get("width")
    height = value.get("height")
    if width is not None and height is not None and width * height > 40_000_000:
        issues.append(
            ContractIssue(
                "asset-pixel-limit",
                "/width",
                "visual asset exceeds the aggregate pixel limit",
            )
        )
    if value["byteLength"] > 32 * 1024 * 1024:
        issues.append(
            ContractIssue(
                "asset-byte-limit",
                "/byteLength",
                "visual asset exceeds the byte limit",
            )
        )
    if value["kind"] == "page-image" and "figureId" in value:
        issues.append(
            ContractIssue(
                "asset-page-has-figure",
                "/figureId",
                "page image cannot carry a figure id",
            )
        )
    return issues


def _source_identity_key(value: IncludedSource | ExcludedSource) -> tuple[str, str]:
    return (value["documentId"], value["revisionId"])


def source_scope_issues(value: SourceScopeVersion) -> list[ContractIssue]:
    issues: list[ContractIssue] = []
    if value["version"] == 1 and "previousScopeVersionId" in value:
        issues.append(
            ContractIssue(
                "scope-first-version-has-previous",
                "/previousScopeVersionId",
                "source scope version 1 must not name a previous version",
            )
        )
    if value["version"] > 1 and "previousScopeVersionId" not in value:
        issues.append(
            ContractIssue(
                "scope-later-version-missing-previous",
                "/previousScopeVersionId",
                "source scope versions after 1 must name their previous version",
            )
        )

    included: set[tuple[str, str]] = set()
    for index, included_entry in enumerate(value["included"]):
        key = _source_identity_key(included_entry)
        if key in included:
            issues.append(
                ContractIssue(
                    "scope-duplicate-included",
                    f"/included/{index}",
                    "the same document revision cannot be included more than once",
                )
            )
        included.add(key)

    excluded: set[tuple[str, str]] = set()
    for index, excluded_entry in enumerate(value["excluded"]):
        key = _source_identity_key(excluded_entry)
        if key in excluded:
            issues.append(
                ContractIssue(
                    "scope-duplicate-excluded",
                    f"/excluded/{index}",
                    "the same document revision cannot be excluded more than once",
                )
            )
        if key in included:
            issues.append(
                ContractIssue(
                    "scope-included-and-excluded",
                    f"/excluded/{index}",
                    "the same document revision cannot be both included and excluded",
                )
            )
        excluded.add(key)
    return issues


def document_locator_issues(value: DocumentLocator) -> list[ContractIssue]:
    issues: list[ContractIssue] = []
    if value.get("supersedesLocatorId") == value["locatorId"]:
        issues.append(
            ContractIssue(
                "locator-self-supersedes",
                "/supersedesLocatorId",
                "a locator cannot supersede itself",
            )
        )
    for index, selector in enumerate(value["selectors"]):
        if selector["type"] == "text-position" and selector["start"] >= selector["end"]:
            issues.append(
                ContractIssue(
                    "locator-text-position-order",
                    f"/selectors/{index}",
                    "text position start must be less than end",
                )
            )
        if (
            selector["type"] == "bbox"
            and selector["unit"] == "ratio"
            and (selector["x"] + selector["width"] > 1 or selector["y"] + selector["height"] > 1)
        ):
            issues.append(
                ContractIssue(
                    "locator-ratio-bounds",
                    f"/selectors/{index}",
                    "ratio bounding boxes must remain inside the page",
                )
            )
    return issues


def evidence_locator_issues(
    evidence: EvidenceAtom,
    locator: DocumentLocator,
) -> list[ContractIssue]:
    if (
        evidence["locatorId"] == locator["locatorId"]
        and evidence["documentId"] == locator["documentId"]
        and evidence["revisionId"] == locator["revisionId"]
        and evidence["representationId"] == locator["representationId"]
    ):
        return []
    return [
        ContractIssue(
            "evidence-locator-mismatch",
            "/",
            "evidence and locator identities must match exactly",
        )
    ]


__all__ = [
    "ActorRef",
    "AssetDescriptor",
    "ContractIssue",
    "DocumentLocator",
    "DocumentRevision",
    "EvidenceAtom",
    "LegacyEvidenceLead",
    "PageInfo",
    "ProtocolError",
    "SourceRepresentation",
    "SourceScopeVersion",
    "asset_descriptor_issues",
    "build_legacy_evidence_lead",
    "document_locator_issues",
    "document_revision_issues",
    "evidence_locator_issues",
    "page_info_issues",
    "source_representation_issues",
    "source_scope_issues",
]
