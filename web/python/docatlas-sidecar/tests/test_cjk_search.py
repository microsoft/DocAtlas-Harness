from __future__ import annotations

from pathlib import Path

import pytest
from test_document_service import _ingest_request

from docatlas_dsh_sidecar import document_service as implementation
from docatlas_dsh_sidecar.document_rpc import SearchRequest, SourceIdentity
from docatlas_dsh_sidecar.document_service import DocumentService, DocumentServiceError
from docatlas_dsh_sidecar.ingest import DocumentIndexStore


def _service(
    tmp_path: Path, documents: list[str]
) -> tuple[DocumentService, DocumentIndexStore, list[SourceIdentity]]:
    directory = tmp_path / "sources"
    directory.mkdir()
    store = DocumentIndexStore({"root:test": directory}, tmp_path / "cache")
    identities: list[SourceIdentity] = []
    for index, text in enumerate(documents):
        path = directory / f"source-{index}.md"
        path.write_text(text, encoding="utf-8")
        result = store.ingest(
            _ingest_request(path, path.name, f"doc:{index}", f"rev:{index}", f"idem:{index}")
        )
        identities.append(
            {
                "documentId": result["documentId"],
                "revisionId": result["revisionId"],
                "representationId": result["representations"][-1]["representationId"],
            }
        )
    return DocumentService(store), store, identities


def _search(
    sources: list[SourceIdentity], query: str = "经营现金流", limit: int = 20
) -> SearchRequest:
    return {
        "schemaVersion": 1,
        "requestType": "search",
        "scopeVersionId": "scope:cjk",
        "sources": sources,
        "query": query,
        "strategy": "fts",
        "limits": {"maxItems": limit, "maxChars": 20000},
    }


def test_han_literal_search_and_locate_preserve_original_block_and_index(tmp_path: Path) -> None:
    text = "本期经营现金流保持稳定且现金储备足以覆盖未来投入"
    service, store, sources = _service(tmp_path, [text + "\n\n另一个无关段落"])
    before = store.current_snapshot("doc:0", "rev:0")
    searched = service.search(_search(sources))
    assert len(searched["candidates"]) == 1
    assert searched["candidates"][0]["preview"] == text
    assert searched["candidates"][0]["reason"] == "Bounded cached-block literal Han substring match"
    located = service.read(
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "locate",
            "source": sources[0],
            "query": "经营现金流",
            "limits": {"maxItems": 1, "maxChars": 20000},
        }
    )
    assert located["items"][0]["text"] == text
    assert located["items"][0]["blockId"] == searched["candidates"][0]["blockIds"][0]
    assert located["pageInfo"]["completeness"] == "candidate"
    resolved = service.resolve(
        {
            "schemaVersion": 1,
            "requestType": "resolve",
            "locator": located["items"][0]["locator"],
            "allowCandidates": True,
            "maxCandidates": 5,
        }
    )
    assert resolved["status"] == "resolved"
    assert store.current_snapshot("doc:0", "rev:0") == before


def test_mixed_queries_keep_fts_priority_or_semantics_exact_dedup_and_casefold(
    tmp_path: Path,
) -> None:
    service, _, sources = _service(
        tmp_path,
        [
            "经营现金流\n\n本期经营现金流保持稳定\n\n"
            "English ONLYtoken finding\n\n本期现金流ALPHA保持稳定"
        ],
    )
    result = service.search(_search(sources, "ONLYtoken 经营现金流"))
    values = result["candidates"]
    assert len(values) == 3
    assert len({value["blockIds"][0] for value in values}) == 3
    assert all(value["reason"] == "SQLite FTS5 block match" for value in values[:2])
    assert values[-1]["preview"] == "本期经营现金流保持稳定"
    assert service.search(_search(sources, "现金流alpha"))["candidates"][0]["preview"] == (
        "本期现金流ALPHA保持稳定"
    )
    assert service.search(_search(sources, "现金流风险"))["candidates"] == []
    assert len(service.search(_search(sources, "%经营现金流%"))["candidates"]) == 2


def test_extended_han_is_literal_and_inherited_headings_do_not_create_new_body_matches(
    tmp_path: Path,
) -> None:
    service, _, sources = _service(
        tmp_path, ["# 本期经营现金流保持稳定\n\n正文中没有查询词\n\n本期𠀀业务增长"]
    )
    matches = service.search(_search(sources))["candidates"]
    assert len(matches) == 1 and matches[0]["preview"] == "本期经营现金流保持稳定"
    extended = service.search(_search(sources, "𠀀业务"))["candidates"]
    assert len(extended) == 1 and extended[0]["preview"] == "本期𠀀业务增长"


def test_cursor_pages_are_stable_unique_and_scoped_across_literal_and_fts_matches(
    tmp_path: Path,
) -> None:
    service, _, sources = _service(
        tmp_path,
        [
            "经营现金流\n\n甲方经营现金流稳定\n\n乙方经营现金流改善",
            "海外经营现金流改善\n\n内部经营现金流稳定",
        ],
    )
    request = _search(sources, limit=1)
    previews = []
    identifiers = []
    for _ in range(6):
        result = service.search(request)
        assert service.search(request) == result
        previews.extend(value["preview"] for value in result["candidates"])
        identifiers.extend(value["candidateId"] for value in result["candidates"])
        cursor = result["pageInfo"].get("nextCursor")
        if cursor is None:
            break
        request = {**request, "cursor": cursor}
    assert previews == [
        "经营现金流",
        "甲方经营现金流稳定",
        "乙方经营现金流改善",
        "海外经营现金流改善",
        "内部经营现金流稳定",
    ]
    assert len(set(identifiers)) == 5
    assert len(service.search(_search(sources[:1]))["candidates"]) == 3
    assert all(
        value["documentId"] == sources[0]["documentId"]
        for value in service.search(_search(sources[:1]))["candidates"]
    )
    with pytest.raises(DocumentServiceError, match="does not match query"):
        service.search({**request, "query": "另一查询"})


def test_ascii_queries_never_enter_literal_scan_and_stale_sources_are_rejected_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, _, sources = _service(tmp_path, ["Revenue increased\n\n本期经营现金流稳定"])

    def forbidden(*args: object) -> None:
        raise AssertionError("unexpected literal scan")

    monkeypatch.setattr(implementation._LiteralScanBudget, "consume", forbidden)
    assert len(service.search(_search(sources, "Revenue"))["candidates"]) == 1
    assert service.search(_search(sources, "notfound"))["candidates"] == []
    with pytest.raises(DocumentServiceError):
        service.search(_search(sources, "..."))
    with pytest.raises(DocumentServiceError) as stale:
        service.search(_search([{**sources[0], "representationId": "rep:foreign"}]))
    assert stale.value.code == "stale"


def test_block_budget_is_cumulative_across_sources_and_does_not_return_a_partial_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, _, sources = _service(tmp_path, ["本期经营现金流稳定", "海外经营现金流改善"])
    monkeypatch.setattr(implementation, "_LITERAL_SCAN_BLOCKS", 1)
    assert len(service.search(_search(sources[:1]))["candidates"]) == 1
    with pytest.raises(DocumentServiceError, match="narrow the source scope") as failure:
        service.search(_search(sources, limit=1))
    assert failure.value.code == "limit-exceeded"


@pytest.mark.parametrize("budget", ["_LITERAL_SCAN_CHARS", "_LITERAL_SCAN_WORK"])
def test_character_and_token_work_budgets_are_also_request_wide(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, budget: str
) -> None:
    text = "本期经营现金流稳定"
    service, _, sources = _service(tmp_path, [text, text])
    query = "经营现金流 现金储备"
    monkeypatch.setattr(implementation, budget, len(text) * (2 if budget.endswith("WORK") else 1))
    assert len(service.search(_search(sources[:1], query))["candidates"]) == 1
    with pytest.raises(DocumentServiceError) as failure:
        service.search(_search(sources, query))
    assert failure.value.code == "limit-exceeded"


@pytest.mark.parametrize("budget", ["_LITERAL_SCAN_CHARS", "_LITERAL_SCAN_WORK"])
def test_scan_char_and_work_limits_fail_explicitly_in_search_and_locate_but_not_page_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, budget: str
) -> None:
    service, _, sources = _service(tmp_path, ["本期经营现金流稳定"])
    monkeypatch.setattr(implementation, budget, 1)
    with pytest.raises(DocumentServiceError) as search_failure:
        service.search(_search(sources))
    assert search_failure.value.code == "limit-exceeded"
    with pytest.raises(DocumentServiceError) as read_failure:
        service.read(
            {
                "schemaVersion": 1,
                "requestType": "read",
                "mode": "locate",
                "source": sources[0],
                "query": "经营现金流",
                "limits": {"maxItems": 1, "maxChars": 20000},
            }
        )
    assert read_failure.value.code == "limit-exceeded"
    page = service.read(
        {
            "schemaVersion": 1,
            "requestType": "read",
            "mode": "page",
            "source": sources[0],
            "physicalPage": 1,
            "limits": {"maxItems": 10, "maxChars": 20000},
        }
    )
    assert page["items"][0]["text"] == "本期经营现金流稳定"
