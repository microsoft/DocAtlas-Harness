"""Wire parity only; Python does not own question history or source authorization."""

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
    (Path(__file__).resolve().parents[3] / "contracts/fixtures/question-context.json").read_text()
)


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    value: dict[str, Any] = copy.deepcopy(FIXTURE["base"])
    value.update(copy.deepcopy(case["set"]))
    for name in case.get("remove", []):
        del value[name]
    return value


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda case: case["name"])
def test_question_context_wire(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert not validate_contract_shape("question-context", value)
    assert parse_contract("question-context", value) == value


@pytest.mark.parametrize("case", FIXTURE["invalid"], ids=lambda case: case["name"])
def test_question_context_rejects_unknown_wire(case: dict[str, Any]) -> None:
    value = materialize(case)
    assert validate_contract_shape("question-context", value)
    with pytest.raises(ContractValidationError):
        parse_contract("question-context", value)
