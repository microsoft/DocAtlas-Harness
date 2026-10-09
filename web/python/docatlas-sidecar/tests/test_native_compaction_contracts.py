"""The sidecar validates shared shapes, never executing compact or owning history."""

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
ORIGINAL = json.loads((DIRECTORY / "native-history.json").read_text())["native-control"]
CASES = json.loads((DIRECTORY / "native-compaction-cases.json").read_text())


def patched(candidate: Any, patches: list[dict[str, Any]]) -> Any:
    result = copy.deepcopy(candidate)
    for patch in patches:
        if not patch["path"]:
            result = copy.deepcopy(patch["value"])
            continue
        current = result
        for part in patch["path"][:-1]:
            current = current[part]
        last = patch["path"][-1]
        if patch.get("remove"):
            del current[last]
        else:
            current[last] = (
                patch["value"] * patch["repeat"]
                if "repeat" in patch
                else copy.deepcopy(patch["value"])
            )
    return result


VALUES = [patched(ORIGINAL[vector["base"]], vector["patches"]) for vector in CASES["vectors"]]


@pytest.mark.parametrize("value", VALUES, ids=[vector["name"] for vector in CASES["vectors"]])
def test_compaction_shared_shapes(value: dict[str, Any]) -> None:
    before = copy.deepcopy(value)
    assert not validate_contract_shape("native-control", value)
    assert parse_contract("native-control", value) == value
    assert value == before


@pytest.mark.parametrize("case", CASES["invalidShape"], ids=lambda case: case["name"])
def test_compaction_malformed_shapes(case: dict[str, Any]) -> None:
    value = patched(VALUES[case["vector"]], case["patches"])
    assert validate_contract_shape("native-control", value)
    with pytest.raises(ContractValidationError):
        parse_contract("native-control", value)


@pytest.mark.parametrize("case", CASES["invalidSemantic"], ids=lambda case: case["name"])
def test_compaction_semantic_vectors_are_shape_valid(case: dict[str, Any]) -> None:
    # Actual host/browser semantics and immutable native bytes remain outside Python.
    value = patched(VALUES[case["vector"]], case["patches"])
    assert not validate_contract_shape("native-control", value)


def test_compaction_unicode_limit() -> None:
    value = {"kind": "compact", "instructions": "🔬" * 4096}
    assert parse_contract("native-control", value) == value
    with pytest.raises(ContractValidationError):
        parse_contract("native-control", {**value, "instructions": value["instructions"] + "🔬"})
