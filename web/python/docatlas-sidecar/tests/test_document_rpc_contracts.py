from __future__ import annotations

import copy
import json
from pathlib import Path

from docatlas_dsh_sidecar.document_rpc import (
    IngestRequest,
    IngestResult,
    ReadRequest,
    ReadResult,
    ResolveRequest,
    ResolveResult,
    SearchResult,
    ingest_request_issues,
    ingest_result_issues,
    read_result_issues,
    resolve_result_issues,
    search_result_issues,
    source_binding_issues,
)
from docatlas_dsh_sidecar.schema_validation import parse_contract, validate_contract_shape

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (WORKSPACE_ROOT / "contracts" / "fixtures" / "m1" / "document-rpc.json").read_text(
        encoding="utf-8"
    )
)


def _values() -> list[tuple[str, dict]]:
    return [
        ("ingest", FIXTURE["ingestRequest"]),
        ("ingest", FIXTURE["ingestResult"]),
        ("search", FIXTURE["searchRequest"]),
        ("search", FIXTURE["searchResult"]),
        *(("read", value) for value in FIXTURE["readRequests"]),
        ("read", FIXTURE["readResult"]),
        ("resolve", FIXTURE["resolveRequest"]),
        ("resolve", FIXTURE["resolveResult"]),
    ]


def test_every_canonical_document_request_and_result_parses() -> None:
    for _, value in _values():
        assert validate_contract_shape("sidecar-document-rpc", value) == []
        assert parse_contract("sidecar-document-rpc", value) is value


def test_every_canonical_document_value_has_a_valid_envelope() -> None:
    for method, value in _values():
        if "requestType" in value:
            envelope = {
                "jsonrpc": "2.0",
                "id": f"request:{method}",
                "method": method,
                "params": value,
            }
        else:
            envelope = {"jsonrpc": "2.0", "id": f"result:{method}", "result": value}
        assert validate_contract_shape("sidecar-envelope", envelope) == []


def test_canonical_document_semantics_are_consistent() -> None:
    ingest_request: IngestRequest = FIXTURE["ingestRequest"]
    ingest_result: IngestResult = FIXTURE["ingestResult"]
    search_result: SearchResult = FIXTURE["searchResult"]
    read_result: ReadResult = FIXTURE["readResult"]
    resolve_request: ResolveRequest = FIXTURE["resolveRequest"]
    resolve_result: ResolveResult = FIXTURE["resolveResult"]

    assert ingest_request_issues(ingest_request) == []
    assert ingest_result_issues(ingest_result) == []
    assert search_result_issues(search_result) == []
    assert read_result_issues(read_result) == []
    assert resolve_result_issues(resolve_result, resolve_request) == []


def test_mode_confusion_and_unsafe_path_fail_closed() -> None:
    request: ReadRequest = {**FIXTURE["readRequests"][0], "mode": "blocks"}
    assert validate_contract_shape("sidecar-document-rpc", request)

    binding = {**FIXTURE["ingestRequest"]["sourceBinding"], "relativePath": "docs/./report.pdf"}
    assert [issue.code for issue in source_binding_issues(binding)] == [
        "source-binding-absolute-or-unsafe-path"
    ]


def test_identity_and_range_conflicts_have_matching_issue_codes() -> None:
    ingest: IngestRequest = copy.deepcopy(FIXTURE["ingestRequest"])
    ingest["sourceBinding"]["expectedContentHash"] = "f" * 64
    assert [issue.code for issue in ingest_request_issues(ingest)] == [
        "ingest-binding-hash-mismatch"
    ]

    search: SearchResult = copy.deepcopy(FIXTURE["searchResult"])
    search["candidates"][0]["physicalPageEnd"] = 1
    assert [issue.code for issue in search_result_issues(search)] == ["search-candidate-page-order"]

    read: ReadResult = copy.deepcopy(FIXTURE["readResult"])
    read["items"][0]["physicalPage"] = 3
    assert [issue.code for issue in read_result_issues(read)] == ["read-item-page-mismatch"]

    resolve: ResolveResult = copy.deepcopy(FIXTURE["resolveResult"])
    del resolve["resolvedLocator"]
    assert [issue.code for issue in resolve_result_issues(resolve, FIXTURE["resolveRequest"])] == [
        "resolve-resolved-target-missing"
    ]
