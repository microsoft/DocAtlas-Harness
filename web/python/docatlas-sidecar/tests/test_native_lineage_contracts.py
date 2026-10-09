"""Shared wire shapes only; Python owns no Agent Loop, lineage or native proof authority."""

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
CACHE: dict[str, Any] = {}


def load(file: str) -> Any:
    if file not in CACHE:
        CACHE[file] = json.loads((DIRECTORY / file).read_text())
    return CACHE[file]


CASES = load("native-lineage-cases.json")


def expand(value: Any, depth: int = 0) -> Any:
    """Test-asset directives are resolved before validation, never accepted as product wire."""
    if depth > 128:
        raise ValueError("Cyclic fixture reference")
    if isinstance(value, list):
        return [expand(item, depth + 1) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"$template"}:
        return expand(CASES["templates"][value["$template"]], depth + 1)
    if set(value) == {"$fixture", "path"}:
        selected = load(value["$fixture"])
        for key in value["path"]:
            selected = selected[key]
        return expand(selected, depth + 1)
    return {key: expand(item, depth + 1) for key, item in value.items()}


def patched(candidate: Any, patches: list[dict[str, Any]]) -> Any:
    result = copy.deepcopy(candidate)
    for patch in patches:
        if not patch["path"]:
            result = expand(patch["value"])
            continue
        current = result
        for part in patch["path"][:-1]:
            current = current[part]
        last = patch["path"][-1]
        if patch.get("remove"):
            del current[last]
        else:
            current[last] = (
                patch["value"] * patch["repeat"] if "repeat" in patch else expand(patch["value"])
            )
    return result


VECTORS = [
    {**vector, "value": patched(expand(vector["value"]), vector.get("patches", []))}
    for vector in CASES["vectors"]
]
BY_ID = {vector["id"]: vector for vector in VECTORS}


@pytest.mark.parametrize("vector", VECTORS, ids=lambda vector: vector["name"])
def test_native_lineage_shared_shapes(vector: dict[str, Any]) -> None:
    value = vector["value"]
    before = copy.deepcopy(value)
    assert not validate_contract_shape(vector["contract"], value)
    assert parse_contract(vector["contract"], value) == value
    assert value == before


@pytest.mark.parametrize("case", CASES["invalidShape"], ids=lambda case: case["name"])
def test_native_lineage_malformed_shapes(case: dict[str, Any]) -> None:
    vector = BY_ID[case["vector"]]
    value = patched(vector["value"], case["patches"])
    assert validate_contract_shape(vector["contract"], value)
    with pytest.raises(ContractValidationError):
        parse_contract(vector["contract"], value)


@pytest.mark.parametrize("case", CASES["invalidSemantic"], ids=lambda case: case["name"])
def test_native_lineage_semantics_remain_shape_valid(case: dict[str, Any]) -> None:
    # Actual parent bytes, ownership, policy and selected ancestry are host responsibilities.
    vector = BY_ID[case["vector"]]
    assert not validate_contract_shape(
        vector["contract"], patched(vector["value"], case["patches"])
    )


def test_native_lineage_unicode_limits() -> None:
    action: dict[str, Any] = {
        "kind": "navigate",
        "targetEntryId": "entry:target",
        "summarize": True,
        "instructions": "🔬" * 4096,
        "replaceInstructions": False,
        "label": "🔬" * 256,
    }
    assert parse_contract("native-lineage", action) == action
    for field in ("instructions", "label"):
        with pytest.raises(ContractValidationError):
            parse_contract("native-lineage", {**action, field: action[field] + "🔬"})


def test_inherited_answer_preserves_original_manifest() -> None:
    original = load("product-answer.json")["bases"]["response"]
    inherited = BY_ID["inherited-answer"]["value"]
    assert inherited["conversationId"] != original["conversationId"]
    assert inherited["origin"]["conversationId"] == original["conversationId"]
    assert inherited["origin"]["entryId"] == inherited["messageId"]
    assert inherited["manifest"] == original["manifest"]
    assert inherited["nativeTextHash"] == original["nativeTextHash"]


def test_native_lineage_vector_references_are_complete() -> None:
    assert len(BY_ID) == len(VECTORS)
    for case in CASES["invalidShape"] + CASES["invalidSemantic"]:
        assert case["vector"] in BY_ID
