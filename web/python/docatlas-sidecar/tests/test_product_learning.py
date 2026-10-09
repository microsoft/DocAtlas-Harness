"""Shared learning wire shapes; Python owns neither a profile nor a learning loop."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from docatlas_dsh_sidecar.schema_validation import (
    ContractValidationError,
    parse_contract,
    validate_contract_shape,
)

DIRECTORY = Path(__file__).resolve().parents[3] / "contracts/fixtures"
FIXTURE = json.loads((DIRECTORY / "product-learning.json").read_text())
IMPORTED = {
    name: json.loads((DIRECTORY / path).read_text()) for name, path in FIXTURE["imports"].items()
}


def expand(value: Any, depth: int = 0) -> Any:
    assert depth <= 24
    if isinstance(value, list):
        return [expand(item, depth + 1) for item in value]
    if not isinstance(value, dict):
        return value
    if "$fixture" in value:
        assert set(value) == {"$fixture", "path"}
        source = IMPORTED[value["$fixture"]]
        for part in value["path"]:
            source = source[part]
        return expand(source, depth + 1)
    return {key: expand(item, depth + 1) for key, item in value.items()}


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    value: dict[str, Any] = expand(FIXTURE["bases"][case["base"]])

    def parent(path: list[str | int]) -> Any:
        current: Any = value
        for part in path[:-1]:
            current = current[part]
        return current

    for change in case.get("set", []):
        path = change["path"]
        parent(path)[path[-1]] = expand(change["value"])
    for path in case.get("remove", []):
        del parent(path)[path[-1]]
    return value


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda case: case["name"])
def test_valid_product_learning_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert not validate_contract_shape("product-learning", value)
    assert parse_contract("product-learning", value) == value
    assert value == before


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_product_learning_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("product-learning", value)
    with pytest.raises(ContractValidationError):
        parse_contract("product-learning", value)


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_learning_semantic_vectors_are_shape_valid(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert case["codes"]
    assert not validate_contract_shape("product-learning", value)
    assert parse_contract("product-learning", value) == value


@pytest.mark.parametrize("case", FIXTURE["hostOnly"], ids=lambda case: case["name"])
def test_learning_shapes_do_not_grant_authority(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert case["authority"]
    assert not validate_contract_shape("product-learning", value)
    assert parse_contract("product-learning", value) == value


def test_learning_fixture_covers_all_commands() -> None:
    values = [materialize(case) for case in FIXTURE["valid"]]
    assert {value["action"] for value in values if value["kind"] == "learning-command"} == {
        "configure",
        "prepare",
        "choose",
        "dismiss",
        "review",
    }
