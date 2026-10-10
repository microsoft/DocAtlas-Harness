from __future__ import annotations

from importlib.metadata import metadata, requires
from pathlib import Path

import pytest
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet

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


@pytest.mark.parametrize(
    ("name", "vulnerable", "fixed"),
    [
        ("anyio", "4.13.0", "4.14.2"),
        ("docling", "2.97.0", "2.132.0"),
        ("fsspec", "2026.4.0", "2026.6.0"),
        ("pyjwt", "2.13.0", "2.15.1"),
        ("pypdf", "6.16.1", "6.19.0"),
        ("urllib3", "2.7.0", "2.8.0"),
    ],
)
def test_security_floors_ship_in_package_metadata(name: str, vulnerable: str, fixed: str) -> None:
    runtime = {
        requirement.name.lower(): requirement.specifier
        for value in requires("docatlas") or []
        if (requirement := Requirement(value)).marker is None
    }
    assert vulnerable not in runtime[name]
    assert fixed in runtime[name]


def test_dependency_maintenance_preserves_supported_python_versions() -> None:
    supported = SpecifierSet(metadata("docatlas")["Requires-Python"])
    assert all(version in supported for version in ("3.10", "3.11", "3.12", "3.13"))
    assert "3.9" not in supported
    assert "3.14" not in supported
