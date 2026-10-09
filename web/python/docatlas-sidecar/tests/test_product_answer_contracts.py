"""Product answer wire parity; Python never owns conversation or citation authority."""

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
    (Path(__file__).resolve().parents[3] / "contracts/fixtures/product-answer.json").read_text()
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
def test_valid_product_answer_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert not validate_contract_shape("product-answer", value)
    assert parse_contract("product-answer", value) == value
    assert value == before


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_product_answer_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("product-answer", value)
    with pytest.raises(ContractValidationError):
        parse_contract("product-answer", value)


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_product_answer_semantic_vectors_remain_shape_valid(case: dict[str, Any]) -> None:
    # Cross-field semantics and actual source resolution remain application-owned,
    # matching the Node shape parser rather than creating a second Python authority.
    value = materialize(case)
    assert case["codes"]
    assert not validate_contract_shape("product-answer", value)
    assert parse_contract("product-answer", value) == value


def test_product_answer_unicode_scalar_text_limit() -> None:
    value = copy.deepcopy(FIXTURE["bases"]["focus"])
    value["exactText"] = "文😀" * 10000
    assert parse_contract("product-answer", value) == value
    value["exactText"] += "。"
    with pytest.raises(ContractValidationError):
        parse_contract("product-answer", value)


def test_product_answer_status_coverage() -> None:
    values = [materialize(case) for case in FIXTURE["valid"]]
    assert {value["status"] for value in values if value["kind"] == "answer-response"} == {
        "available",
        "unavailable",
    }
    assert {value["status"] for value in values if value["kind"] == "citation-focus"} == {
        "resolved",
        "page-only",
        "ambiguous",
    }
