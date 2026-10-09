from __future__ import annotations

from typing import Any

import pytest

from docatlas_dsh_sidecar.schema_validation import parse_contract, validate_contract_shape


@pytest.mark.parametrize(
    "value",
    [
        {
            "schemaVersion": 1,
            "kind": "product-search-request",
            "recipe": "tree-search.v1",
            "query": "现金流",
            "strategy": "combined",
            "limits": {"maxItems": 10, "maxChars": 6000},
        },
        {
            "schemaVersion": 1,
            "kind": "tree-search-selection",
            "nodes": [{"key": "n0", "reason": "相关章节"}],
        },
        {
            "schemaVersion": 1,
            "kind": "product-search-execution",
            "recipe": "tree-search.v1",
            "requestHash": "a" * 64,
            "strategies": ["tree"],
            "catalogTruncated": False,
            "nodesConsidered": 2,
            "sourceCount": 1,
            "model": "test/tree",
            "treeRefs": [
                {
                    "candidateId": "candidate:one",
                    "generationId": "tree:one",
                    "nodeId": "tree:one:n1",
                    "sourceHash": "b" * 64,
                    "treeHash": "c" * 64,
                }
            ],
        },
    ],
)
def test_product_search_wire_round_trip(value: dict[str, Any]) -> None:
    assert parse_contract("product-search", value) == value


def test_tree_planner_cannot_supply_pages_or_authority() -> None:
    for extra in [{"page": 99}, {"actorId": "actor:forged"}, {"blockIds": ["tree:n0"]}]:
        assert validate_contract_shape(
            "product-search",
            {
                "schemaVersion": 1,
                "kind": "tree-search-selection",
                "nodes": [{"key": "n0", "reason": "r", **extra}],
            },
        )
