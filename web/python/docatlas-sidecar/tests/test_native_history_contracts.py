"""Shared native wire shapes; Python never acquires runtime/history authority."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from docatlas_dsh_sidecar.schema_validation import (
    ContractName,
    ContractValidationError,
    parse_contract,
    validate_contract_shape,
)

DIRECTORY = Path(__file__).resolve().parents[3] / "contracts/fixtures"
FIXTURES = json.loads((DIRECTORY / "native-history.json").read_text())
CASES = json.loads((DIRECTORY / "native-history-cases.json").read_text())


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    value: dict[str, Any] = copy.deepcopy(FIXTURES[case["contract"]][case["index"]])
    current: Any = value
    for part in case["path"][:-1]:
        current = current[part]
    last = case["path"][-1]
    if case.get("remove"):
        del current[last]
    else:
        current[last] = "x" * case["repeat"] if "repeat" in case else copy.deepcopy(case["value"])
    return value


@pytest.mark.parametrize(
    ("name", "value"),
    [(name, value) for name, values in FIXTURES.items() for value in values],
)
def test_native_history_valid(name: ContractName, value: dict[str, Any]) -> None:
    before = copy.deepcopy(value)
    assert not validate_contract_shape(name, value)
    assert parse_contract(name, value) == value
    assert value == before


@pytest.mark.parametrize("case", CASES["invalidShape"], ids=lambda case: case["name"])
def test_native_history_invalid_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape(case["contract"], value)
    with pytest.raises(ContractValidationError):
        parse_contract(case["contract"], value)


@pytest.mark.parametrize("case", CASES["invalidSemantic"], ids=lambda case: case["name"])
def test_native_semantic_vectors_remain_shape_valid(case: dict[str, Any]) -> None:
    # Browser/host apply semantic and actual native-prefix verification; not a Python loop.
    value = materialize(case)
    assert not validate_contract_shape(case["contract"], value)
