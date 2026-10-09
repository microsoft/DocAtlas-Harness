from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from docatlas_dsh_sidecar.schema_validation import validate_contract_shape
from docatlas_dsh_sidecar.tree_index import TreeIndexValue, tree_index_issues

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[3] / "contracts/fixtures/document/tree-index.json"
    ).read_text()
)


@pytest.mark.parametrize("value", FIXTURE["valid"])
def test_valid_tree(value: TreeIndexValue) -> None:
    assert not validate_contract_shape("tree-index", value)
    assert tree_index_issues(value) == []


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_tree_shape(case: dict[str, Any]) -> None:
    assert validate_contract_shape("tree-index", case["value"])


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_tree_semantics(case: dict[str, Any]) -> None:
    assert not validate_contract_shape("tree-index", case["value"])
    assert tree_index_issues(case["value"]) == case["codes"]
