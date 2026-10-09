"""Shared enrichment wire shapes, not a Python model job executor or semantic authority."""

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
        Path(__file__).resolve().parents[3] / "contracts/fixtures/document/enrichment.json"
    ).read_text()
)


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    """Apply the exact same shared paths as the TypeScript/browser fixture suite."""
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
def test_valid_enrichment_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert not validate_contract_shape("enrichment", value)
    assert parse_contract("enrichment", value) == value
    assert value == before


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_enrichment_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("enrichment", value)
    with pytest.raises(ContractValidationError):
        parse_contract("enrichment", value)


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_semantic_vectors_are_shape_valid(case: dict[str, Any]) -> None:
    # Match Node's shape parser. Cross-field validation and cryptographic seals
    # belong to the TypeScript application; Python neither runs nor trusts jobs.
    value = materialize(case)
    assert case["codes"]
    assert not validate_contract_shape("enrichment", value)
    assert parse_contract("enrichment", value) == value


def test_shared_fixture_covers_all_union_kinds_and_job_states() -> None:
    valid = [materialize(case) for case in FIXTURE["valid"]]
    assert {value["kind"] for value in valid} == {
        "enrichment-start",
        "enrichment-job",
        "tree-enrichment",
        "enrichment-tree",
        "enrichment-list",
        "enrichment-page",
    }
    assert {value["state"] for value in valid if value["kind"] == "enrichment-job"} == {
        "queued",
        "preparing",
        "generating",
        "completed",
        "failed",
        "cancelled",
    }
