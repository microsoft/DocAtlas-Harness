from __future__ import annotations

from pathlib import Path

import docatlas
from docatlas.skill_loader import load_skills


def test_runtime_uses_single_docatlas_namespace() -> None:
    repository_root = Path(__file__).resolve().parents[1]
    for legacy_name in ("harness", "tasks", "scoring", "vendor", "DocSkills"):
        assert not (repository_root / legacy_name).exists()


def test_all_bundled_skills_load_from_package_resources() -> None:
    package_root = Path(docatlas.__file__).resolve().parent
    skills = load_skills(
        [package_root / "skills" / name for name in ("search", "read", "note", "review")]
    )

    assert [skill.name for skill in skills] == ["search", "read", "note", "review"]
