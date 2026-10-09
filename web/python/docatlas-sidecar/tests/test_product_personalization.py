"""Shared product personalization shapes; domain/host authority is not inferred from JSON."""

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

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[3] / "contracts/fixtures/product-personalization.json"
    ).read_text()
)


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    value: dict[str, Any] = copy.deepcopy(FIXTURE["bases"][case["base"]])

    def parent(path: list[str | int]) -> Any:
        current: Any = value
        for part in path[:-1]:
            current = current[part]
        return current

    for change in case.get("set", []):
        path = change["path"]
        parent(path)[path[-1]] = copy.deepcopy(change["value"])
    for path in case.get("remove", []):
        del parent(path)[path[-1]]
    return value


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda case: case["name"])
def test_valid_product_personalization_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert not validate_contract_shape("product-personalization", value)
    assert parse_contract("product-personalization", value) == value
    assert value == before


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_product_personalization_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("product-personalization", value)
    with pytest.raises(ContractValidationError):
        parse_contract("product-personalization", value)


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_product_personalization_semantic_vectors_remain_shape_valid(case: dict[str, Any]) -> None:
    # The Node/Python shape parsers intentionally do not own domain authorization,
    # source resolution, memory application, or TypeScript cross-field invariants.
    value = materialize(case)
    assert case["codes"]
    assert not validate_contract_shape("product-personalization", value)
    assert parse_contract("product-personalization", value) == value


def test_product_personalization_kind_coverage() -> None:
    assert {materialize(case)["kind"] for case in FIXTURE["valid"]} == {
        "preference-command",
        "preference-inspection",
        "preference-result",
    }
