"""Shared continuity shapes; Python does not own host ACLs, PDF resolution or human decisions."""

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
    (Path(__file__).resolve().parents[3] / "contracts/fixtures/product-continuity.json").read_text()
)


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    value: dict[str, Any] = copy.deepcopy(FIXTURE["bases"][case["base"]])

    def parent(path: list[str | int]) -> Any:
        result: Any = value
        for part in path[:-1]:
            result = result[part]
        return result

    for change in case.get("set", []):
        parent(change["path"])[change["path"][-1]] = copy.deepcopy(change["value"])
    for path in case.get("remove", []):
        del parent(path)[path[-1]]
    return value


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda case: case["name"])
def test_valid_continuity_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert not validate_contract_shape("product-continuity", value)
    assert parse_contract("product-continuity", value) == value
    assert value == before


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_continuity_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("product-continuity", value)
    with pytest.raises(ContractValidationError):
        parse_contract("product-continuity", value)


@pytest.mark.parametrize(
    "case", FIXTURE["invalidSemantic"] + FIXTURE["hostOnly"], ids=lambda case: case["name"]
)
def test_shape_does_not_claim_host_or_semantic_authority(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert case.get("codes") or case.get("authority")
    assert not validate_contract_shape("product-continuity", value)
    assert parse_contract("product-continuity", value) == value
