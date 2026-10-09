from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from referencing import Registry, Resource

from docatlas_dsh_sidecar.contracts import (
    AssetDescriptor,
    DocumentLocator,
    DocumentRevision,
    EvidenceAtom,
    LegacyEvidenceLead,
    PageInfo,
    ProtocolError,
    SourceRepresentation,
    SourceScopeVersion,
    asset_descriptor_issues,
    build_legacy_evidence_lead,
    document_locator_issues,
    document_revision_issues,
    evidence_locator_issues,
    page_info_issues,
    source_representation_issues,
    source_scope_issues,
)
from docatlas_dsh_sidecar.schema_validation import (
    ContractValidationError,
    parse_contract,
    validate_contract_shape,
)

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ROOT = WORKSPACE_ROOT / "contracts"


def _load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


CATALOG = _load_json(CONTRACT_ROOT / "schema-catalog.json")
SCHEMAS = {entry["name"]: _load_json(CONTRACT_ROOT / entry["path"]) for entry in CATALOG["schemas"]}
REGISTRY = Registry().with_resources(
    (schema["$id"], Resource.from_contents(schema)) for schema in SCHEMAS.values()
)
FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m0" / "canonical-slice.json")
MULTI_DOC_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m0" / "multi-document-same-page.json")
SELECTION_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m2" / "selection.json")
SOURCE_SCOPE_RPC_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m2" / "source-scope.json")
LIBRARY_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m2" / "library.json")
READER_FOCUS_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m2" / "reader-focus.json")
ANSWER_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m2" / "answer-manifest.json")
RESEARCH_GOVERNANCE_FIXTURE = _load_json(
    CONTRACT_ROOT / "fixtures" / "m3" / "research-governance.json"
)
RESEARCH_NOTEBOOK_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m3" / "research-notebook.json")
M4_RPC_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m4" / "m4-rpc.json")
M4_RPC_INVALID_FIXTURE = _load_json(CONTRACT_ROOT / "fixtures" / "m4" / "m4-rpc.invalid.json")
PERSONALIZATION_FIXTURE = _load_json(
    CONTRACT_ROOT / "fixtures" / "m6" / "personalization.valid.json"
)
PERSONALIZATION_INSPECT_FIXTURE = _load_json(
    CONTRACT_ROOT / "fixtures" / "m6" / "personalization-inspect.json"
)


def _validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        SCHEMAS[name],
        registry=REGISTRY,
        format_checker=FormatChecker(),
    )


def test_m0_schema_catalog_is_complete_and_well_formed() -> None:
    assert CATALOG["schemaVersion"] == 1
    assert set(SCHEMAS) == {
        "product-search",
        "native-control",
        "human-research",
        "native-lineage",
        "product-history",
        "enrichment",
        "document-http",
        "runtime-progress",
        "conversation-observation",
        "product-http",
        "product-answer",
        "question-context",
        "product-research",
        "product-personalization",
        "product-personalization-v2",
        "product-review",
        "product-library",
        "product-continuity",
        "product-probe",
        "product-learning",
        "resource-trust",
        "worker-frame",
        "tree-index",
        "product-control",
        "common",
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
        "reader-page-rpc",
        "research-recall-rpc",
        "research-record-rpc",
        "research-lifecycle-rpc",
        "research-governance-rpc",
        "research-notebook-rpc",
        "tree-overlay-rpc",
        "continuity-rpc",
        "claim-version",
        "evidence-relation",
        "derivation-activity",
        "review-result",
        "artifact-manifest",
        "m4-rpc",
        "personalization-core",
        "personalization-command",
        "personalization-inspect",
        "answer-manifest",
        "answer-rpc",
    }
    for entry in CATALOG["schemas"]:
        schema = SCHEMAS[entry["name"]]
        assert schema["$id"] == entry["id"]
        Draft202012Validator.check_schema(schema)


def test_docatlas_tool_meta_is_bounded_and_rejects_raw_payloads() -> None:
    value = {
        "schemaVersion": 1,
        "schema": "docatlas.tool-meta.v1",
        "operation": "search",
        "scopeVersionId": "scope:test:1",
        "documentIds": ["doc:test"],
        "candidateIds": ["candidate:test"],
        "uiSummary": "1 candidate",
        "truncated": False,
    }
    assert validate_contract_shape("docatlas-tool-meta", value) == []
    assert parse_contract("docatlas-tool-meta", value) == value
    with pytest.raises(ContractValidationError):
        parse_contract("docatlas-tool-meta", {**value, "rawMarkdown": "not durable meta"})


def test_asset_descriptor_shape_and_semantics_match_host() -> None:
    value: AssetDescriptor = {
        "schemaVersion": 1,
        "assetId": "rep:asset:original",
        "kind": "original-bytes",
        "documentId": "doc:asset",
        "revisionId": "rev:asset:1",
        "representationId": "rep:asset:original",
        "representationContentHash": "a" * 64,
        "contentHash": "a" * 64,
        "mediaType": "application/pdf",
        "byteLength": 1024,
        "createdAt": "2026-08-30T07:00:00Z",
    }
    assert validate_contract_shape("asset-descriptor", value) == []
    assert asset_descriptor_issues(value) == []
    assert asset_descriptor_issues({**value, "physicalPage": 1})[0].code == (
        "asset-original-visual-fields"
    )


def test_research_governance_and_notebook_shape_parity() -> None:
    for key in (
        "createDecisionRequest",
        "createDecisionResult",
        "createPolicyRequest",
        "createPolicyResult",
        "archivePolicyRequest",
        "archivePolicyResult",
    ):
        assert (
            validate_contract_shape("research-governance-rpc", RESEARCH_GOVERNANCE_FIXTURE[key])
            == []
        )
    assert (
        validate_contract_shape("research-notebook-rpc", RESEARCH_NOTEBOOK_FIXTURE["request"]) == []
    )
    assert (
        validate_contract_shape("research-notebook-rpc", RESEARCH_NOTEBOOK_FIXTURE["result"]) == []
    )
    with pytest.raises(ContractValidationError):
        parse_contract(
            "research-notebook-rpc",
            {**RESEARCH_NOTEBOOK_FIXTURE["request"], "path": "/private/store.sqlite3"},
        )


def test_m4_authenticated_rpc_shape_parity() -> None:
    for value in M4_RPC_FIXTURE.values():
        assert validate_contract_shape("m4-rpc", value) == []
    for value in M4_RPC_INVALID_FIXTURE.values():
        with pytest.raises(ContractValidationError):
            parse_contract("m4-rpc", value)


def test_selection_contract_fixture_has_cross_language_shape_parity() -> None:
    assert validate_contract_shape("selection-context", SELECTION_FIXTURE["context"]) == []
    for key in (
        "stageRequest",
        "stageResult",
        "prepareRequest",
        "prepareResult",
        "statusRequest",
        "statusResult",
        "cancelRequest",
        "cancelResult",
        "actionRequest",
        "actionResult",
    ):
        assert validate_contract_shape("selection-rpc", SELECTION_FIXTURE[key]) == []
    invalid = {**SELECTION_FIXTURE["cancelRequest"], "nonce": "seln_too-short"}
    assert validate_contract_shape("selection-rpc", invalid)
    assert (
        validate_contract_shape(
            "browser-rpc",
            {"schemaVersion": 1, "ok": True, "result": SELECTION_FIXTURE["actionResult"]},
        )
        == []
    )


def test_source_scope_rpc_fixture_has_cross_language_shape_parity() -> None:
    for value in SOURCE_SCOPE_RPC_FIXTURE.values():
        assert validate_contract_shape("source-scope-rpc", value) == []
    assert (
        validate_contract_shape(
            "browser-rpc",
            {"schemaVersion": 1, "ok": True, "result": SOURCE_SCOPE_RPC_FIXTURE["commitResult"]},
        )
        == []
    )
    assert (
        validate_contract_shape(
            "browser-rpc",
            {"schemaVersion": 1, "ok": True, "result": SOURCE_SCOPE_RPC_FIXTURE["overviewResult"]},
        )
        == []
    )


def test_library_contract_fixture_has_cross_language_shape_parity() -> None:
    assert validate_contract_shape("library-document", LIBRARY_FIXTURE["document"]) == []
    for key in ("discoverRequest", "discoverResult", "jobResult"):
        assert validate_contract_shape("library-rpc", LIBRARY_FIXTURE[key]) == []


def test_reader_focus_fixture_has_cross_language_shape_parity() -> None:
    assert validate_contract_shape("reader-focus-rpc", READER_FOCUS_FIXTURE["request"]) == []
    assert validate_contract_shape("reader-focus-rpc", READER_FOCUS_FIXTURE["result"]) == []
    assert (
        validate_contract_shape(
            "browser-rpc",
            {"schemaVersion": 1, "ok": True, "result": READER_FOCUS_FIXTURE["result"]},
        )
        == []
    )


def test_answer_manifest_fixture_has_cross_language_shape_parity() -> None:
    assert validate_contract_shape("answer-manifest", ANSWER_FIXTURE["manifest"]) == []
    assert validate_contract_shape("answer-rpc", ANSWER_FIXTURE["getRequest"]) == []
    assert validate_contract_shape("answer-rpc", ANSWER_FIXTURE["getResult"]) == []
    available = {
        **ANSWER_FIXTURE["getResult"],
        "status": "available",
        "manifest": ANSWER_FIXTURE["manifest"],
    }
    assert validate_contract_shape("answer-rpc", available) == []
    assert (
        validate_contract_shape(
            "browser-rpc", {"schemaVersion": 1, "ok": True, "result": available}
        )
        == []
    )


@pytest.mark.parametrize(
    ("schema_name", "fixture_key"),
    [
        ("protocol-error", "protocolError"),
        ("page-info", "pageInfo"),
        ("document-revision", "documentRevision"),
        ("source-representation", "originalRepresentation"),
        ("source-representation", "textRepresentation"),
        ("source-scope-version", "sourceScope"),
        ("document-locator", "quoteLocator"),
        ("evidence-atom", "evidence"),
        ("legacy-evidence-lead", "legacyLead"),
    ],
)
def test_canonical_m0_slice_validates(schema_name: str, fixture_key: str) -> None:
    _validator(schema_name).validate(FIXTURE[fixture_key])


@pytest.mark.parametrize(
    ("schema_name", "fixture_key", "mutate"),
    [
        (
            "page-info",
            "pageInfo",
            lambda value: (
                value.update(truncated=True, completeness="partial"),
                value.pop("nextCursor", None),
            ),
        ),
        (
            "document-revision",
            "documentRevision",
            lambda value: value.pop("pageCount"),
        ),
        (
            "source-representation",
            "textRepresentation",
            lambda value: value.pop("generator"),
        ),
        (
            "document-locator",
            "quoteLocator",
            lambda value: value.update(physicalPage=0),
        ),
        (
            "evidence-atom",
            "evidence",
            lambda value: value.update(content={"mediaType": "image/png", "assetId": "asset:1"}),
        ),
    ],
)
def test_invalid_m0_shapes_fail_closed(schema_name: str, fixture_key: str, mutate) -> None:
    value = copy.deepcopy(FIXTURE[fixture_key])
    mutate(value)
    with pytest.raises(ValidationError):
        _validator(schema_name).validate(value)


def test_canonical_m0_semantics_are_consistent() -> None:
    page: PageInfo = FIXTURE["pageInfo"]
    protocol_error: ProtocolError = FIXTURE["protocolError"]
    revision: DocumentRevision = FIXTURE["documentRevision"]
    original: SourceRepresentation = FIXTURE["originalRepresentation"]
    text: SourceRepresentation = FIXTURE["textRepresentation"]
    scope: SourceScopeVersion = FIXTURE["sourceScope"]
    locator: DocumentLocator = FIXTURE["quoteLocator"]
    evidence: EvidenceAtom = FIXTURE["evidence"]
    legacy_lead: LegacyEvidenceLead = FIXTURE["legacyLead"]

    assert page_info_issues(page) == []
    assert protocol_error["code"] == "stale"
    assert document_revision_issues(revision) == []
    assert source_representation_issues(original, revision) == []
    assert source_representation_issues(text, revision) == []
    assert source_scope_issues(scope) == []
    assert document_locator_issues(locator) == []
    assert evidence_locator_issues(evidence, locator) == []
    assert legacy_lead["resolutionStatus"] == "unresolved"
    assert legacy_lead["verificationStatus"] == "unverified"


def test_personalization_fixture_has_cross_language_shape_parity() -> None:
    for key in (
        "sessionPolicy",
        "explicitObservation",
        "sessionOnlyObservation",
        "inferredObservation",
        "candidate",
        "sensitiveCandidate",
        "memoryVersion",
        "decision",
        "memoryUse",
        "preferenceProbe",
        "preferenceChoice",
        "pairwiseObservation",
    ):
        assert validate_contract_shape("personalization-core", PERSONALIZATION_FIXTURE[key]) == []
    for key, value in PERSONALIZATION_FIXTURE["commands"].items():
        assert validate_contract_shape("personalization-command", value) == [], key
        if key.endswith("Result"):
            assert (
                validate_contract_shape(
                    "browser-rpc", {"schemaVersion": 1, "ok": True, "result": value}
                )
                == []
            )
    polluted = copy.deepcopy(PERSONALIZATION_FIXTURE["commands"]["setSessionPolicyRequest"])
    polluted["path"] = "/private/profile.sqlite3"
    assert validate_contract_shape("personalization-command", polluted)
    for value in PERSONALIZATION_INSPECT_FIXTURE.values():
        assert validate_contract_shape("personalization-inspect", value) == []
    assert (
        validate_contract_shape(
            "browser-rpc",
            {
                "schemaVersion": 1,
                "ok": True,
                "result": PERSONALIZATION_INSPECT_FIXTURE["result"],
            },
        )
        == []
    )


def test_semantic_checks_fail_closed_on_cross_field_conflicts() -> None:
    page: PageInfo = {**FIXTURE["pageInfo"], "returned": 9}
    assert {issue.code for issue in page_info_issues(page)} == {
        "page-returned-exceeds-limit",
        "page-returned-exceeds-total",
    }

    revision: DocumentRevision = copy.deepcopy(FIXTURE["documentRevision"])
    revision["previousRevisionId"] = revision["revisionId"]
    assert {issue.code for issue in document_revision_issues(revision)} == {
        "revision-self-previous"
    }

    representation: SourceRepresentation = copy.deepcopy(FIXTURE["textRepresentation"])
    representation["derivedFromRepresentationIds"] = [representation["representationId"]]
    assert {issue.code for issue in source_representation_issues(representation)} == {
        "representation-self-derived"
    }

    scope: SourceScopeVersion = copy.deepcopy(FIXTURE["sourceScope"])
    included = scope["included"][0]
    scope["included"].append({**included, "role": "secondary"})
    scope["excluded"].append(
        {
            "documentId": included["documentId"],
            "revisionId": included["revisionId"],
            "reason": "user",
        }
    )
    assert [issue.code for issue in source_scope_issues(scope)] == [
        "scope-duplicate-included",
        "scope-included-and-excluded",
    ]

    locator: DocumentLocator = copy.deepcopy(FIXTURE["quoteLocator"])
    locator["supersedesLocatorId"] = locator["locatorId"]
    locator["selectors"] = [
        {"type": "text-position", "start": 8, "end": 8, "unit": "unicode-scalar"},
        {
            "type": "bbox",
            "unit": "ratio",
            "x": 0.8,
            "y": 0.9,
            "width": 0.3,
            "height": 0.2,
            "rotation": 0,
        },
    ]
    assert [issue.code for issue in document_locator_issues(locator)] == [
        "locator-self-supersedes",
        "locator-text-position-order",
        "locator-ratio-bounds",
    ]

    evidence: EvidenceAtom = copy.deepcopy(FIXTURE["evidence"])
    evidence["revisionId"] = "rev:other"
    assert [issue.code for issue in evidence_locator_issues(evidence, FIXTURE["quoteLocator"])] == [
        "evidence-locator-mismatch"
    ]


def test_multi_document_same_page_identity_is_unambiguous() -> None:
    locator_a: DocumentLocator = MULTI_DOC_FIXTURE["locatorA"]
    locator_b: DocumentLocator = MULTI_DOC_FIXTURE["locatorB"]
    evidence_b: EvidenceAtom = MULTI_DOC_FIXTURE["evidenceB"]
    stale_b: EvidenceAtom = MULTI_DOC_FIXTURE["staleEvidenceB"]
    ambiguous_b: EvidenceAtom = MULTI_DOC_FIXTURE["ambiguousEvidenceB"]

    for locator in (locator_a, locator_b):
        _validator("document-locator").validate(locator)
        assert document_locator_issues(locator) == []
    for evidence in (evidence_b, stale_b, ambiguous_b):
        _validator("evidence-atom").validate(evidence)

    assert locator_a["physicalPage"] == locator_b["physicalPage"] == 2
    assert locator_a["documentId"] != locator_b["documentId"]
    assert locator_a["revisionId"] != locator_b["revisionId"]
    assert evidence_locator_issues(evidence_b, locator_b) == []
    assert [issue.code for issue in evidence_locator_issues(evidence_b, locator_a)] == [
        "evidence-locator-mismatch"
    ]
    assert stale_b["resolutionStatus"] == stale_b["status"] == "stale"
    assert ambiguous_b["resolutionStatus"] == "ambiguous"
    assert ambiguous_b["status"] == "current"


def test_production_schema_registry_parses_canonical_objects() -> None:
    parsed = parse_contract("document-locator", FIXTURE["quoteLocator"])
    assert parsed["locatorId"] == "loc:revenue-growth"
    assert validate_contract_shape("evidence-atom", FIXTURE["evidence"]) == []
    assert (
        parse_contract("legacy-evidence-lead", FIXTURE["legacyLead"])["verificationStatus"]
        == "unverified"
    )
    with pytest.raises(ContractValidationError):
        parse_contract("evidence-atom", FIXTURE["legacyLead"])


def test_production_schema_registry_reports_structured_issues() -> None:
    invalid = {**FIXTURE["quoteLocator"], "physicalPage": 0}
    issues = validate_contract_shape("document-locator", invalid)
    assert any(issue.instance_path == "/physicalPage" for issue in issues)
    with pytest.raises(ContractValidationError) as captured:
        parse_contract("document-locator", invalid)
    assert captured.value.contract == "document-locator"


def test_legacy_import_can_only_create_an_unresolved_unverified_lead() -> None:
    lead = build_legacy_evidence_lead(
        {
            "leadId": "legacy-lead:test",
            "legacyKind": "note-evidence",
            "sourceSessionId": "session:legacy",
            "rawSource": "  Page 2  ",
            "rawContent": "legacy observation",
            "documentCandidates": [
                {"documentId": "doc:a", "revisionId": "rev:a:1"},
                {"documentId": "doc:b", "revisionId": "rev:b:1"},
            ],
            "importedBy": {"kind": "system", "actorId": "system:legacy-import"},
            "importedAt": "2026-08-30T00:00:00Z",
        }
    )
    assert lead["physicalPageCandidate"] == 2
    assert lead["resolutionStatus"] == "unresolved"
    assert lead["verificationStatus"] == "unverified"
    assert validate_contract_shape("legacy-evidence-lead", lead) == []
    assert validate_contract_shape("evidence-atom", lead)


def test_legacy_import_does_not_invent_a_page_from_arbitrary_text() -> None:
    lead = build_legacy_evidence_lead(
        {
            "leadId": "legacy-lead:no-page",
            "legacyKind": "page-finding",
            "sourceSessionId": "session:legacy",
            "rawSource": "not a locator",
            "documentCandidates": [],
            "importedBy": {"kind": "system", "actorId": "system:legacy-import"},
            "importedAt": "2026-08-30T00:00:00Z",
        }
    )
    assert "physicalPageCandidate" not in lead
