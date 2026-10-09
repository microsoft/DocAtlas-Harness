"""Shared product Review wire shapes, never Python-owned host or Evidence authority."""

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
FIXTURE = json.loads((DIRECTORY / "product-review.json").read_text())
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
        target = parent(path)
        # JavaScript array index assignment at length appends; share that exact fixture meaning.
        if isinstance(target, list) and path[-1] == len(target):
            target.append(expand(change["value"]))
        else:
            target[path[-1]] = expand(change["value"])
    for path in case.get("remove", []):
        del parent(path)[path[-1]]
    return value


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda case: case["name"])
def test_valid_product_review_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    before = copy.deepcopy(value)
    assert not validate_contract_shape("product-review", value)
    assert parse_contract("product-review", value) == value
    assert value == before


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_product_review_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("product-review", value)
    with pytest.raises(ContractValidationError):
        parse_contract("product-review", value)


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_product_review_semantic_vectors_are_shape_valid(case: dict[str, Any]) -> None:
    # These same vectors are rejected by the TypeScript semantic display/parser guard.
    # Python validates shared wire shape; it does not own the human Agent/Review application.
    value = materialize(case)
    assert case["codes"]
    assert not validate_contract_shape("product-review", value)
    assert parse_contract("product-review", value) == value


@pytest.mark.parametrize("case", FIXTURE["hostOnly"], ids=lambda case: case["name"])
def test_product_review_shapes_do_not_grant_host_authority(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert case["authority"]
    assert not validate_contract_shape("product-review", value)
    assert parse_contract("product-review", value) == value


def test_product_review_kind_action_and_publication_coverage() -> None:
    values = [materialize(case) for case in FIXTURE["valid"]]
    assert {value["kind"] for value in values} == {
        "review-command",
        "review-workspace",
        "review-result",
        "review-focus",
    }
    assert {value["action"] for value in values if value["kind"] == "review-command"} == {
        "claim-save",
        "artifact-create",
        "review-attest",
        "review-run",
        "review-decide",
        "artifact-publish",
    }
    workspace = materialize({"base": "workspace"})
    assert {artifact["kind"] for artifact in workspace["artifacts"]} == {"brief", "matrix"}
    for artifact in workspace["artifacts"]:
        if publication := artifact.get("publication"):
            review = next(
                item
                for item in workspace["reviews"]
                if item["reviewResultId"] == publication["reviewResultId"]
            )
            assert artifact["artifactManifestId"] in review["subject"]["objectIds"]
            assert artifact["contentHash"] == review["subject"]["contentHash"]
