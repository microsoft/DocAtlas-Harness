"""Language-neutral product-control bindings only; Python never runs the control plane."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, NotRequired, TypedDict

# Match JavaScript String.trim exactly, including BOM but not Python-only C0 separators.
_TEXT_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff" + "".join(
    chr(code) for code in range(0x2000, 0x200B)
)

type ProductRunState = Literal[
    "accepted",
    "preparing",
    "ready",
    "dispatching",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "outcome-unknown",
]
type ProductMode = Literal["prompt", "steer", "follow-up"]
type ProductError = Literal[
    "preparation-failed",
    "runtime-rejected",
    "runtime-failed",
    "execution-interrupted",
    "checkpoint-failed",
    "stale-binding",
    "selection-invalid",
    "source-unavailable",
    "internal",
]


class ProductSourceRef(TypedDict):
    documentId: str
    revisionId: str


class ProductBinding(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["binding"]
    bindingId: str
    conversationId: str
    workspaceId: str
    ownerActorId: str
    investigationId: str | None
    runtimeSessionId: str
    branchEntryId: str | None
    generation: int
    version: int
    createdAt: str
    updatedAt: str


class ProductDocumentSearch(TypedDict):
    recipe: Literal["tree-search.v1"]
    strategy: Literal["fts", "tree", "combined"]


class ProductSubmission(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["submission"]
    conversationId: str
    idempotencyKey: str
    expectedGeneration: int
    mode: ProductMode
    text: str
    sourceRefs: list[ProductSourceRef]
    selectionContextIds: list[str]
    documentSearch: NotRequired[ProductDocumentSearch]


class ProductPrepared(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["prepared"]
    submissionId: str
    requestHash: str
    bindingGeneration: int
    scopeVersionId: str | None
    sourceRefs: list[ProductSourceRef]
    selectionContextIds: list[str]


class ProductCheckpoint(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["pi-checkpoint"]
    submissionId: str
    requestHash: str
    runtimeSessionId: str
    userEntryId: str
    leafEntryId: str
    transcriptHash: str
    byteLength: int
    entryCount: int
    settledAt: str


class ProductReceipt(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["run-receipt"]
    submissionId: str
    runId: str
    conversationId: str
    generation: int
    mode: ProductMode
    state: ProductRunState
    version: int
    requestHash: str
    createdAt: str
    updatedAt: str
    payloadRetained: bool
    errorCode: NotRequired[ProductError]
    checkpoint: NotRequired[ProductCheckpoint]


# Functional TypedDict preserves the reserved wire field "from" exactly.
ProductTransitionWire = TypedDict(
    "ProductTransitionWire",
    {
        "schemaVersion": Literal[1],
        "kind": Literal["run-transition"],
        "from": ProductRunState,
        "to": ProductRunState,
    },
)
type ProductControlValue = (
    ProductBinding
    | ProductSubmission
    | ProductPrepared
    | ProductCheckpoint
    | ProductReceipt
    | ProductTransitionWire
)


def product_control_issues(value: ProductControlValue) -> list[str]:
    """Run after canonical JSON Schema validation; shares codes with TypeScript."""
    issues: list[str] = []
    if value["kind"] == "submission" and not value["text"].strip(_TEXT_WHITESPACE):
        issues.append("empty-text")
    if value["kind"] == "run-receipt" or value["kind"] == "binding":
        if _time(value["updatedAt"]) < _time(value["createdAt"]):
            issues.append("time-order")
    if value["kind"] == "prepared" and value["scopeVersionId"] is None:
        if value["sourceRefs"] or value["selectionContextIds"]:
            issues.append("missing-scope")
    if value["kind"] == "pi-checkpoint" and value["userEntryId"] == value["leafEntryId"]:
        issues.append("checkpoint-entries")
    if value["kind"] == "run-receipt" and "checkpoint" in value:
        checkpoint = value["checkpoint"]
        if (
            checkpoint["submissionId"] != value["submissionId"]
            or checkpoint["requestHash"] != value["requestHash"]
        ):
            issues.append("checkpoint-binding")
        if (
            not _time(value["createdAt"])
            <= _time(checkpoint["settledAt"])
            <= _time(value["updatedAt"])
        ):
            issues.append("checkpoint-time")
        issues.extend(product_control_issues(checkpoint))
    return issues


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
