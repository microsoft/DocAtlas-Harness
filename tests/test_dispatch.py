from __future__ import annotations

from docatlas.agent.dispatch import SkillDispatcher, _extract_text_and_images


def test_read_metadata_and_image_labels_reach_model() -> None:
    payload = {
        "mode": "markdown",
        "n_pages_total": 12,
        "pages": [
            {"num": 2, "source": "markdown", "text": "Revenue table", "page_image": "page-uri"}
        ],
        "figure_images_meta": [
            {
                "page": 2,
                "ref": "image_1",
                "size_px": [640, 480],
                "bytes": 12345,
                "caption": "Quarterly revenue",
            }
        ],
        "_harness_extras": {"figure_images": [{"page": 2, "ref": "image_1", "uri": "figure-uri"}]},
        "_hint": "Fetch image_1 when visual evidence is required.",
    }

    text, images, labels = _extract_text_and_images("read", payload)

    assert "Figure catalog" in text
    assert "image_1" in text
    assert "Quarterly revenue" in text
    assert "Fetch image_1" in text
    assert images == ["page-uri", "figure-uri"]
    assert labels == ["Page 2 full-page image", "Page 2 figure image_1"]


def test_skill_environment_does_not_leak_unrelated_secrets(monkeypatch) -> None:
    monkeypatch.setenv("UNRELATED_DATABASE_PASSWORD", "example-value")  # pragma: allowlist secret
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "azure-secret")
    dispatcher = SkillDispatcher([], session_args={})

    read_env = dispatcher._subprocess_env("read")
    search_env = dispatcher._subprocess_env("search")

    assert "UNRELATED_DATABASE_PASSWORD" not in read_env
    assert "UNRELATED_DATABASE_PASSWORD" not in search_env
    assert "AZURE_OPENAI_API_KEY" not in read_env
    assert search_env["AZURE_OPENAI_API_KEY"] == "azure-secret"  # pragma: allowlist secret
