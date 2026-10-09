"""Independent tree-index.v1 bindings and cross-language semantic checks."""

from __future__ import annotations

from typing import Literal, TypedDict

from .product_control import _TEXT_WHITESPACE


class TreeConfig(TypedDict):
    mode: Literal["raw", "merge"]
    useEmbeddedToc: bool
    workers: Literal[1]


class TreeSource(TypedDict):
    documentId: str
    revisionId: str
    sourceHash: str


class TreeBuildRequest(TreeSource):
    schemaVersion: Literal[1]
    kind: Literal["build-tree"]
    config: TreeConfig


class TreeReadRequest(TreeSource):
    schemaVersion: Literal[1]
    kind: Literal["read-tree"]
    generationId: str
    offset: int
    limit: int


class TreeNode(TypedDict):
    nodeId: str
    parentId: str | None
    title: str
    startPage: int
    endPage: int
    sourceNodeId: str | None
    keyItems: list[str]


class TreeData(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["tree-data"]
    generationId: str
    pageCount: int
    nodes: list[TreeNode]


class TreeProviderIdentity(TypedDict):
    name: Literal["pageindex-flash"]
    version: str
    sourceCommit: str
    fingerprint: str


class TreeOptimization(TypedDict):
    mergeCount: int
    samePageMergeCount: int
    samePageDroppedCount: int
    rounds: int
    costBefore: float
    costAfter: float


class TreeGeneration(TreeSource):
    schemaVersion: Literal[1]
    kind: Literal["tree-generation"]
    generationId: str
    parentGenerationId: str | None
    config: TreeConfig
    provider: TreeProviderIdentity
    status: Literal["ready", "empty"]
    pageCount: int
    nodeCount: int
    treeHash: str
    createdAt: str
    tocSource: Literal["detected", "bookmarks", "hybrid", "disabled"]
    warnings: list[Literal["empty-tree", "no-readable-text"]]
    optimization: TreeOptimization


class TreePage(TypedDict):
    schemaVersion: Literal[1]
    kind: Literal["tree-page"]
    generationId: str
    treeHash: str
    offset: int
    total: int
    nextOffset: int | None
    nodes: list[TreeNode]


type TreeIndexValue = TreeBuildRequest | TreeReadRequest | TreeData | TreeGeneration | TreePage


def tree_index_issues(value: TreeIndexValue) -> list[str]:
    issues: dict[str, None] = {}
    if value["kind"] in {"tree-data", "tree-page"}:
        seen: dict[str, TreeNode] = {}
        for node in value["nodes"]:
            if not node["nodeId"].startswith(value["generationId"] + ":"):
                issues["node-generation"] = None
            if node["nodeId"] in seen:
                issues["duplicate-node"] = None
            if not node["title"].strip(_TEXT_WHITESPACE):
                issues["empty-title"] = None
            if node["endPage"] < node["startPage"] or (
                value["kind"] == "tree-data" and node["endPage"] > value["pageCount"]
            ):
                issues["page-range"] = None
            if value["kind"] == "tree-data" and node["parentId"] is not None:
                parent = seen.get(node["parentId"])
                if parent is None or node["parentId"] == node["nodeId"]:
                    issues["hierarchy"] = None
                elif node["startPage"] < parent["startPage"] or node["endPage"] > parent["endPage"]:
                    issues["parent-range"] = None
            seen[node["nodeId"]] = node
    if value["kind"] == "tree-generation":
        if (value["config"]["mode"] == "raw") != (value["parentGenerationId"] is None) or value[
            "parentGenerationId"
        ] == value["generationId"]:
            issues["parent-generation"] = None
        if (value["status"] == "empty") != ("empty-tree" in value["warnings"]):
            issues["empty-warning"] = None
    if value["kind"] == "tree-page":
        end = value["offset"] + len(value["nodes"])
        expected = end if end < value["total"] else None
        if (
            end > value["total"]
            or value["nextOffset"] != expected
            or (not value["nodes"] and end < value["total"])
        ):
            issues["pagination"] = None
    return list(issues)
