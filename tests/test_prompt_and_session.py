from __future__ import annotations

import os
from pathlib import Path

from docatlas.__main__ import _load_profile, main
from docatlas.config import _maybe_load_dotenv
from docatlas.prompt_composer import compose_system_prompt
from docatlas.skill_loader import load_skill


def test_general_prompt_does_not_include_benchmark_grading_rules() -> None:
    skill = load_skill("docatlas/skills/read")

    general = compose_system_prompt([skill])
    benchmark = compose_system_prompt([skill], benchmark_mode=True)

    assert "Graders read ONLY" not in general
    assert "drop unit words" not in general
    assert "Final answer:" not in general
    assert "Preserve units" in general
    assert "Graders read ONLY" in benchmark


def test_builtin_profile_resolves_by_name() -> None:
    assert _load_profile("default")["skills"] == ["search", "read", "note", "review"]


def test_untrusted_working_directory_dotenv_is_not_loaded(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / ".env").write_text("DOCATLAS_UNTRUSTED_VALUE=loaded\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("HARNESS_ENV_FILE", raising=False)
    monkeypatch.delenv("DOCATLAS_UNTRUSTED_VALUE", raising=False)

    _maybe_load_dotenv()

    assert "DOCATLAS_UNTRUSTED_VALUE" not in os.environ


def test_init_session_creates_reusable_private_file(tmp_path: Path, capsys) -> None:
    sessions_root = tmp_path / "sessions"

    code = main(
        [
            "init-session",
            "--sessions-root",
            str(sessions_root),
            "--session-id",
            "test-session",
            "--question",
            "What changed?",
        ]
    )

    path = Path(capsys.readouterr().out.strip())
    assert code == 0
    assert path.is_file()
    assert path.stat().st_mode & 0o077 == 0


def test_init_session_rejects_path_traversal(tmp_path: Path, capsys) -> None:
    code = main(
        [
            "init-session",
            "--sessions-root",
            str(tmp_path),
            "--session-id",
            "../escape",
        ]
    )

    assert code == 2
    assert "safe path component" in capsys.readouterr().err
