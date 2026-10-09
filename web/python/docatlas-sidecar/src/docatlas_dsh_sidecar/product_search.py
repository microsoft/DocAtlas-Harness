"""Product search wire bindings only; selection/model execution stays in the host."""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

type ProductSearchStrategy = Literal["fts", "tree", "combined"]


class SearchLimits(TypedDict):
    maxItems: int
    maxChars: int


class ProductSearchRequest(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["product-search-request"]
    recipe: Literal["tree-search.v1"]
    query: str
    strategy: ProductSearchStrategy
    limits: SearchLimits
    cursor: NotRequired[str]


class TreeSearchNodeChoice(TypedDict):
    key: str
    reason: str


class TreeSearchSelection(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["tree-search-selection"]
    nodes: list[TreeSearchNodeChoice]


class SearchTreeRef(TypedDict):
    candidateId: str
    generationId: str
    treeHash: str
    sourceHash: str
    nodeId: str


class SearchSummaryRef(TypedDict):
    jobId: str
    resultHash: str
    baseGenerationId: str
    nodesUsed: int


class ProductSearchExecution(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["product-search-execution"]
    recipe: Literal["tree-search.v1"]
    requestHash: str
    strategies: list[Literal["fts", "tree"]]
    catalogTruncated: bool
    nodesConsidered: int
    sourceCount: int
    model: str | None
    treeRefs: list[SearchTreeRef]
    summaryRefs: NotRequired[list[SearchSummaryRef]]


type ProductSearchValue = ProductSearchRequest | TreeSearchSelection | ProductSearchExecution
