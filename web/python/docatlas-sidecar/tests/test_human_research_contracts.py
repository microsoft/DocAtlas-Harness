"""Shared human research shapes; Python receives no authoring RPC or user authority."""

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

CASES: dict[str, Any] = json.loads(
    (
        Path(__file__).resolve().parents[3] / "contracts/fixtures/human-research-cases.json"
    ).read_text()
)


def expand(value: Any, depth: int = 0) -> Any:
    if depth > 128:
        raise ValueError("Cyclic fixture")
    if isinstance(value, list):
        return [expand(item, depth + 1) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"$template"}:
        return expand(CASES["templates"][value["$template"]], depth + 1)
    return {key: expand(item, depth + 1) for key, item in value.items()}


def patched(value: Any, patches: list[dict[str, Any]]) -> Any:
    result = copy.deepcopy(value)
    for patch in patches:
        current = result
        for key in patch["path"][:-1]:
            current = current[key]
        key = patch["path"][-1]
        if patch.get("remove"):
            del current[key]
        else:
            current[key] = (
                patch["value"] * patch["repeat"] if "repeat" in patch else expand(patch["value"])
            )
    return result


VECTORS = [
    {**vector, "value": patched(expand(vector["value"]), vector.get("patches", []))}
    for vector in CASES["vectors"]
]
BY_ID = {vector["id"]: vector for vector in VECTORS}


@pytest.mark.parametrize("vector", VECTORS, ids=lambda vector: vector["name"])
def test_human_research_shared_shapes(vector: dict[str, Any]) -> None:
    value = vector["value"]
    before = copy.deepcopy(value)
    assert not validate_contract_shape("human-research", value)
    assert parse_contract("human-research", value) == value
    assert value == before


@pytest.mark.parametrize("case", CASES["invalidShape"], ids=lambda case: case["name"])
def test_human_research_malformed_shapes(case: dict[str, Any]) -> None:
    value = patched(BY_ID[case["vector"]]["value"], case["patches"])
    assert validate_contract_shape("human-research", value)
    with pytest.raises(ContractValidationError):
        parse_contract("human-research", value)


@pytest.mark.parametrize("case", CASES["invalidSemantic"], ids=lambda case: case["name"])
def test_human_research_host_semantics_are_shape_valid(case: dict[str, Any]) -> None:
    # Cross-field checks and original source/human authority belong to host consumers.
    value = patched(BY_ID[case["vector"]]["value"], case["patches"])
    assert not validate_contract_shape("human-research", value)


def test_human_research_scalar_limits_and_separate_authority() -> None:
    command = copy.deepcopy(BY_ID["command"]["value"])
    command["entry"]["body"] = "🔬" * 4000
    assert parse_contract("human-research", command) == command
    command["entry"]["body"] += "🔬"
    with pytest.raises(ContractValidationError):
        parse_contract("human-research", command)
    with pytest.raises(ContractValidationError):
        parse_contract("research-record-rpc", BY_ID["record"]["value"])
    with pytest.raises(ContractValidationError):
        parse_contract("selection-context", BY_ID["record"]["value"])


def test_human_research_vector_links() -> None:
    assert len(BY_ID) == len(VECTORS)
    for case in CASES["invalidShape"] + CASES["invalidSemantic"]:
        assert case["vector"] in BY_ID
