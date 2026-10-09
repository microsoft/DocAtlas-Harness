from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from docatlas_dsh_sidecar.asset_store import AssetStore, AssetStoreError
from docatlas_dsh_sidecar.contracts import AssetDescriptor


def _descriptor(content: bytes, *, created_at: str = "2026-08-30T07:00:00Z") -> AssetDescriptor:
    digest = hashlib.sha256(content).hexdigest()
    return {
        "schemaVersion": 1,
        "assetId": "rep:asset:original",
        "kind": "original-bytes",
        "documentId": "doc:asset",
        "revisionId": "rev:asset:1",
        "representationId": "rep:asset:original",
        "representationContentHash": digest,
        "contentHash": digest,
        "mediaType": "application/pdf",
        "byteLength": len(content),
        "createdAt": created_at,
    }


def test_asset_publish_is_immutable_and_idempotent(tmp_path: Path) -> None:
    content = b"%PDF-1.7\nimmutable revision bytes\n"
    source = tmp_path / "source.pdf"
    source.write_bytes(content)
    store = AssetStore(tmp_path / "cache")

    first = store.publish_file(_descriptor(content), source)
    source.write_bytes(b"changed after ingest")
    replay = store.publish_file(
        _descriptor(content, created_at="2026-08-30T08:00:00Z"), first.content_path
    )

    assert first.content_path.read_bytes() == content
    assert replay.content_path == first.content_path
    assert replay.descriptor["createdAt"] == "2026-08-30T07:00:00Z"
    assert store.snapshot("rep:asset:original") == replay


def test_asset_publish_rejects_conflicts_and_corruption(tmp_path: Path) -> None:
    content = b"%PDF-1.7\nasset\n"
    source = tmp_path / "source.pdf"
    source.write_bytes(content)
    store = AssetStore(tmp_path / "cache")
    snapshot = store.publish_file(_descriptor(content), source)

    with pytest.raises(AssetStoreError, match="conflicts"):
        store.publish_file({**_descriptor(content), "documentId": "doc:different"}, source)

    snapshot.content_path.write_bytes(b"corrupt")
    with pytest.raises(AssetStoreError, match="size mismatch"):
        store.snapshot("rep:asset:original")


def test_crash_before_atomic_publish_exposes_no_asset(tmp_path: Path) -> None:
    content = b"%PDF-1.7\nasset\n"
    source = tmp_path / "source.pdf"
    source.write_bytes(content)

    def crash(stage: str, _path: Path) -> None:
        if stage == "before-asset-publish":
            raise RuntimeError("simulated crash")

    store = AssetStore(tmp_path / "cache", publish_hook=crash)
    with pytest.raises(RuntimeError, match="simulated crash"):
        store.publish_file(_descriptor(content), source)
    assert store.snapshot("rep:asset:original") is None
    assert list(store.root.glob(".building-*")) == []
