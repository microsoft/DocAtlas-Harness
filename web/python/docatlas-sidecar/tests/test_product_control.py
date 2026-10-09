from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest

from docatlas_dsh_sidecar.product_control import ProductControlValue, product_control_issues
from docatlas_dsh_sidecar.schema_validation import parse_contract, validate_contract_shape

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts/fixtures/product/control.json").read_text()
)


@pytest.mark.parametrize("value", FIXTURE["valid"])
def test_valid_control(value: ProductControlValue) -> None:
    assert parse_contract("product-control", value) == value
    assert product_control_issues(value) == []


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_control_shape(case: dict[str, Any]) -> None:
    assert validate_contract_shape("product-control", case["value"])


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_invalid_control_semantics(case: dict[str, Any]) -> None:
    assert not validate_contract_shape("product-control", case["value"])
    assert product_control_issues(cast(ProductControlValue, case["value"])) == case["codes"]


def test_control_transition_graph() -> None:
    transitions = FIXTURE["transitions"]
    states = set(transitions) | {state for targets in transitions.values() for state in targets}
    assert len(states) == 10
    for old in states:
        for new in states:
            issues = validate_contract_shape(
                "product-control",
                {
                    "schemaVersion": 1,
                    "kind": "run-transition",
                    "from": old,
                    "to": new,
                },
            )
            assert (not issues) == (new in transitions.get(old, []))


def test_explicit_product_search_policy_preserves_whole_submission() -> None:
    submission = next(value for value in FIXTURE["valid"] if value["kind"] == "submission")
    for strategy in ["fts", "tree", "combined"]:
        value = {**submission, "documentSearch": {"recipe": "tree-search.v1", "strategy": strategy}}
        assert parse_contract("product-control", value) == value
    for policy in [
        {"strategy": "tree"},
        {"recipe": "tree-search.v0", "strategy": "tree"},
        {"recipe": "tree-search.v1", "strategy": "tree", "actorId": "forged"},
    ]:
        assert validate_contract_shape("product-control", {**submission, "documentSearch": policy})
