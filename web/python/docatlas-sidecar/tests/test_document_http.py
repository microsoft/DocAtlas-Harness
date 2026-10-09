import json
from pathlib import Path

import pytest

from docatlas_dsh_sidecar.schema_validation import validate_contract_shape

fixtures = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts/fixtures/document-http.json").read_text()
)


@pytest.mark.parametrize("value", fixtures["valid"])
def test_valid_document_http(value: object) -> None:
    assert not validate_contract_shape("document-http", value)


@pytest.mark.parametrize("value", fixtures["invalid"])
def test_invalid_document_http(value: object) -> None:
    assert validate_contract_shape("document-http", value)
