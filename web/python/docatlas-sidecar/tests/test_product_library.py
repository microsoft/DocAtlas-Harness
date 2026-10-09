"""Shared revision wire shapes; Python does not grant product upload/Library authority."""

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
FIXTURE = json.loads((DIRECTORY / "product-library.json").read_text())
IMPORTED = {
    name: json.loads((DIRECTORY / path).read_text()) for name, path in FIXTURE["imports"].items()
}


def expand(value: Any) -> Any:
    if isinstance(value, list):
        return [expand(item) for item in value]
    if not isinstance(value, dict):
        return value
    if "$fixture" in value:
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
def test_valid_revision_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert not validate_contract_shape("product-library", value)
    assert parse_contract("product-library", value) == value


@pytest.mark.parametrize("case", FIXTURE["invalidShape"], ids=lambda case: case["name"])
def test_invalid_revision_shape(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("product-library", value)
    with pytest.raises(ContractValidationError):
        parse_contract("product-library", value)


@pytest.mark.parametrize("case", FIXTURE["invalidSemantic"], ids=lambda case: case["name"])
def test_semantic_vectors_require_host_and_browser_guards(case: dict[str, Any]) -> None:
    assert case["codes"]
    assert not validate_contract_shape("product-library", materialize(case))


@pytest.mark.parametrize("case", FIXTURE["hostOnly"], ids=lambda case: case["name"])
def test_valid_shapes_never_grant_host_authority(case: dict[str, Any]) -> None:
    assert case["authority"]
    assert not validate_contract_shape("product-library", materialize(case))


def test_additive_library_target_and_legacy_compatibility() -> None:
    request = {
        "schemaVersion": 1,
        "requestType": "library-import",
        "sessionId": "session:one",
        "workspaceId": "workspace:library",
        "candidateId": "candidate:one",
        "sourceRole": "primary",
        "idempotencyKey": "library:original:key",
    }
    assert parse_contract("library-rpc", request) == request
    target = {
        "documentId": "doc:library:report",
        "expectedCurrentRevisionId": "rev:library:report:1",
    }
    value = {**request, "revisionTarget": target}
    assert parse_contract("library-rpc", value) == value
    for invalid in [{"documentId": target["documentId"]}, {**target, "path": "/private.pdf"}]:
        assert validate_contract_shape("library-rpc", {**request, "revisionTarget": invalid})
