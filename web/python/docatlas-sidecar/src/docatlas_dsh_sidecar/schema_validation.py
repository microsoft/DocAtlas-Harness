"""Production JSON Schema registry generated from canonical workspace contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, cast

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from .generated_schema_bundle import SCHEMA_BUNDLE

type ContractName = Literal[
    "product-search",
    "native-control",
    "native-lineage",
    "product-history",
    "product-research",
    "product-personalization",
    "product-personalization-v2",
    "product-review",
    "product-library",
    "product-continuity",
    "product-probe",
    "product-answer",
    "enrichment",
    "tree-index",
    "product-control",
    "sidecar-envelope",
    "sidecar-capabilities",
    "sidecar-document-rpc",
    "protocol-error",
    "page-info",
    "document-revision",
    "source-representation",
    "source-scope-version",
    "document-locator",
    "evidence-atom",
    "legacy-evidence-lead",
    "docatlas-tool-meta",
    "asset-descriptor",
    "selection-context",
    "selection-rpc",
    "source-scope-rpc",
    "browser-rpc",
    "library-document",
    "library-rpc",
    "reader-focus-rpc",
    "answer-manifest",
    "answer-rpc",
    "personalization-core",
    "personalization-command",
    "personalization-inspect",
]

_CATALOG = cast(dict[str, Any], SCHEMA_BUNDLE["catalog"])
_SCHEMAS = cast(dict[str, dict[str, Any]], SCHEMA_BUNDLE["schemas"])
_REGISTRY = Registry().with_resources(
    (schema["$id"], Resource.from_contents(schema)) for schema in _SCHEMAS.values()
)
_FORMAT_CHECKER = FormatChecker()
_VALIDATORS: dict[str, Draft202012Validator] = {}

for _entry in _CATALOG["schemas"]:
    _name = cast(str, _entry["name"])
    _schema = _SCHEMAS[_name]
    Draft202012Validator.check_schema(_schema)
    if _name != "common":
        _VALIDATORS[_name] = Draft202012Validator(
            _schema,
            registry=_REGISTRY,
            format_checker=_FORMAT_CHECKER,
        )


@dataclass(frozen=True, slots=True)
class ContractShapeIssue:
    instance_path: str
    schema_path: str
    keyword: str
    message: str


def _pointer(parts: list[str | int]) -> str:
    if not parts:
        return ""
    escaped = [str(part).replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped)


def validate_contract_shape(name: ContractName, value: object) -> list[ContractShapeIssue]:
    """Return deterministic shape issues; an empty list means valid."""
    validator = _VALIDATORS.get(name)
    if validator is None:
        raise ValueError(f"unknown DocAtlas contract: {name}")
    errors = sorted(
        validator.iter_errors(value), key=lambda error: (list(error.path), error.message)
    )
    return [
        ContractShapeIssue(
            instance_path=_pointer(list(error.path)),
            schema_path=_pointer(list(error.schema_path)),
            keyword=str(error.validator),
            message=error.message,
        )
        for error in errors
    ]


class ContractValidationError(ValueError):
    contract: ContractName
    issues: tuple[ContractShapeIssue, ...]

    def __init__(self, contract: ContractName, issues: list[ContractShapeIssue]) -> None:
        super().__init__(
            f"invalid {contract} contract: " + "; ".join(issue.message for issue in issues)
        )
        self.contract = contract
        self.issues = tuple(issues)


def parse_contract(name: ContractName, value: object) -> dict[str, Any]:
    """Validate one object and return it with a JSON-object type."""
    issues = validate_contract_shape(name, value)
    if issues:
        raise ContractValidationError(name, issues)
    if not isinstance(value, dict):  # defensive; every current object schema requires an object
        raise ContractValidationError(
            name,
            [ContractShapeIssue("", "", "type", "contract value must be an object")],
        )
    return cast(dict[str, Any], value)


__all__ = [
    "ContractShapeIssue",
    "ContractValidationError",
    "parse_contract",
    "validate_contract_shape",
]
