import json
from pathlib import Path

import pytest

from docatlas_dsh_sidecar.schema_validation import validate_contract_shape

fixtures = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts/fixtures/resource-trust.json").read_text()
)


@pytest.mark.parametrize("value", fixtures["valid"])
def test_valid_resource_trust(value: object) -> None:
    assert not validate_contract_shape("resource-trust", value)


@pytest.mark.parametrize("value", fixtures["invalid"])
def test_invalid_resource_trust(value: object) -> None:
    assert validate_contract_shape("resource-trust", value)
