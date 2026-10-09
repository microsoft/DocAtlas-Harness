import json
from pathlib import Path
from typing import Any

import pytest

from docatlas_dsh_sidecar.observation_contracts import conversation_observation_issues
from docatlas_dsh_sidecar.schema_validation import validate_contract_shape

fixtures = json.loads(
    (
        Path(__file__).resolve().parents[3] / "contracts/fixtures/conversation-observations.json"
    ).read_text()
)


@pytest.mark.parametrize("value", fixtures["valid"])
def test_valid_observation(value: dict[str, Any]) -> None:
    assert not validate_contract_shape("conversation-observation", value)
    assert not conversation_observation_issues(value)


@pytest.mark.parametrize("value", fixtures["invalid"])
def test_invalid_observation(value: dict[str, Any]) -> None:
    assert validate_contract_shape("conversation-observation", value)


@pytest.mark.parametrize("case", fixtures["semantic"])
def test_observation_identity(case: dict[str, Any]) -> None:
    assert not validate_contract_shape("conversation-observation", case["value"])
    assert conversation_observation_issues(case["value"]) == case["codes"]
