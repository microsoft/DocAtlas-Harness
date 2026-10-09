"""Shared controlled-presentation shapes, not Python-owned Agent or profile authority."""

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
FIXTURE = json.loads((DIRECTORY / "product-probe.json").read_text())
IMPORTED = {
    name: json.loads((DIRECTORY / path).read_text()) for name, path in FIXTURE["imports"].items()
}


def expand(value: Any) -> Any:
    if isinstance(value, list):
        return [expand(item) for item in value]
    if not isinstance(value, dict):
        return value
    if "$fixture" in value:
        assert set(value) == {"$fixture", "path"}
        source = IMPORTED[value["$fixture"]]
        for part in value["path"]:
            source = source[part]
        return copy.deepcopy(source)
    return {key: expand(item) for key, item in value.items()}


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
def test_valid_product_probe_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert not validate_contract_shape("product-probe", value)
    assert parse_contract("product-probe", value) == value
    assert value == before


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_product_probe_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("product-probe", value)
    with pytest.raises(ContractValidationError):
        parse_contract("product-probe", value)


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_semantic_vectors_are_shape_valid(case: dict[str, Any]) -> None:
    # Display consistency is checked by TypeScript; Python never gains profile/host authority.
    value = materialize(case)
    assert case["codes"]
    assert not validate_contract_shape("product-probe", value)
    assert parse_contract("product-probe", value) == value


@pytest.mark.parametrize("case", FIXTURE["hostOnly"], ids=lambda case: case["name"])
def test_parser_acceptance_does_not_grant_host_authority(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert case["authority"]
    assert not validate_contract_shape("product-probe", value)
    assert parse_contract("product-probe", value) == value


def test_probe_kind_coverage_and_real_empty_claim_references() -> None:
    assert {materialize(case)["kind"] for case in FIXTURE["valid"]} == {
        "probe-inspect",
        "probe-prepare",
        "probe-choose",
        "probe-review",
        "probe-view",
        "probe-choice-result",
        "probe-review-result",
    }
    ready = materialize({"base": "ready"})
    assert ready["probe"]["backbone"]["claimVersionIds"] == []
    assert ready["probe"]["backbone"]["evidenceAtomIds"] == ["evidence:revenue-growth"]
