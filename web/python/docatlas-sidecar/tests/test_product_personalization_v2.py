"""Shared v2 envelopes preserve v1 actions and durable record versions."""

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

FIXTURES = Path(__file__).resolve().parents[3] / "contracts/fixtures"
SOURCE = json.loads((FIXTURES / "product-personalization.json").read_text())
V2 = json.loads((FIXTURES / "product-personalization-v2.json").read_text())


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    value: dict[str, Any] = copy.deepcopy(SOURCE["bases"][case["base"]])
    value["schemaVersion"] = 2
    if value["kind"] == "preference-inspection":
        value["profileEpoch"] = 0
        value["modelApplication"] = "host-ephemeral"
        value["useSemantics"] = "observed-answer-generation"
    elif value["kind"] == "preference-command":
        value["expectedProfileEpoch"] = 0

    def parent(path: list[str | int]) -> Any:
        current: Any = value
        for key in path[:-1]:
            current = current[key]
        return current

    for change in case.get("set", []):
        path = change["path"]
        parent(path)[path[-1]] = copy.deepcopy(change["value"])
    for path in case.get("remove", []):
        del parent(path)[path[-1]]
    return value


@pytest.mark.parametrize("case", [*V2["valid"], *SOURCE["valid"]], ids=lambda c: c["name"])
def test_v2_shape_preserves_actions_and_inner_records(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert parse_contract("product-personalization-v2", value) == value
    assert value == before
    assert validate_contract_shape("product-personalization", value)


@pytest.mark.parametrize("case", V2["invalidShape"], ids=lambda c: c["name"])
def test_v2_rejects_false_application_and_version_claims(case: dict[str, Any]) -> None:
    with pytest.raises(ContractValidationError):
        parse_contract("product-personalization-v2", materialize(case))


@pytest.mark.parametrize(
    "case", [*V2["invalidSemantic"], *SOURCE["invalidSemantic"]], ids=lambda c: c["name"]
)
def test_v2_shape_alone_does_not_establish_domain_authority(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert case["codes"]
    assert parse_contract("product-personalization-v2", value) == value


def test_v1_stays_disconnected_only() -> None:
    original = SOURCE["bases"]["inspection"]
    assert parse_contract("product-personalization", original) == original
    with pytest.raises(ContractValidationError):
        parse_contract(
            "product-personalization", {**original, "modelApplication": "host-ephemeral"}
        )
