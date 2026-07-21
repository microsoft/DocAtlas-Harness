"""Load a DocSkill from disk into a normalized in-memory representation.

A SKILL directory is expected to contain:

    <skill_dir>/
      SKILL.md              # YAML frontmatter (name, description) + body
      scripts/run.py        # CLI entry; JSON over stdout
      tool.json             # JSON Schema for the LLM-facing parameters

`SKILL.md` follows the official Claude Code skill format — frontmatter is the
only structured part; the body is free-form markdown that we hand to the
model verbatim as part of the system prompt.

The sidecar `tool.json` carries the parameters JSON Schema. Keeping it
separate from the markdown lets the prose stay human-friendly while the
LLM tool contract stays machine-checkable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


_FRONTMATTER_FENCE = "---"


@dataclass
class LoadedSkill:
    name: str                      # tool name exposed to the LLM
    description: str               # short description from SKILL.md frontmatter
    body: str                      # full prose body of SKILL.md (after frontmatter)
    parameters_schema: dict[str, Any]  # JSON Schema for the LLM tool call
    cli_path: Path                 # absolute path to scripts/run.py
    skill_dir: Path                # absolute path to the skill directory


def _split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split a SKILL.md into (frontmatter_dict, body_str).

    Tolerates skills with no frontmatter by returning ({}, text) — Phase 1
    placeholder skills don't have YAML yet, and we'd rather warn at the
    higher level than crash here.
    """
    stripped = text.lstrip("﻿")
    if not stripped.startswith(_FRONTMATTER_FENCE):
        return {}, text
    # Find the closing fence on a line by itself.
    rest = stripped[len(_FRONTMATTER_FENCE):]
    if rest.startswith("\n"):
        rest = rest[1:]
    end = rest.find(f"\n{_FRONTMATTER_FENCE}")
    if end == -1:
        return {}, text
    frontmatter_raw = rest[:end]
    body = rest[end + len(_FRONTMATTER_FENCE) + 1:]
    if body.startswith("\n"):
        body = body[1:]
    fm = yaml.safe_load(frontmatter_raw) or {}
    if not isinstance(fm, dict):
        raise ValueError(f"SKILL.md frontmatter must be a YAML mapping, got {type(fm).__name__}")
    return fm, body


def load_skill(skill_dir: str | Path) -> LoadedSkill:
    """Load a SKILL directory into a `LoadedSkill`.

    Raises FileNotFoundError if SKILL.md or tool.json is missing, ValueError
    if the frontmatter is malformed or required fields are absent.
    """
    skill_dir = Path(skill_dir).resolve()
    md_path = skill_dir / "SKILL.md"
    tool_path = skill_dir / "tool.json"
    cli_path = skill_dir / "scripts" / "run.py"

    if not md_path.is_file():
        raise FileNotFoundError(f"SKILL.md not found in {skill_dir}")
    if not tool_path.is_file():
        raise FileNotFoundError(
            f"tool.json sidecar not found in {skill_dir}. "
            "Every harness-loaded skill needs a JSON Schema for its parameters."
        )
    if not cli_path.is_file():
        raise FileNotFoundError(f"scripts/run.py not found in {skill_dir}")

    fm, body = _split_frontmatter(md_path.read_text(encoding="utf-8"))
    name = fm.get("name")
    description = fm.get("description", "")
    if not name:
        raise ValueError(f"SKILL.md in {skill_dir} is missing required field 'name'")

    parameters_schema = json.loads(tool_path.read_text(encoding="utf-8"))
    if not isinstance(parameters_schema, dict):
        raise ValueError(f"{tool_path} must contain a JSON object (the params schema)")

    return LoadedSkill(
        name=str(name),
        description=str(description),
        body=body,
        parameters_schema=parameters_schema,
        cli_path=cli_path,
        skill_dir=skill_dir,
    )


def load_skills(skill_dirs: list[str | Path]) -> list[LoadedSkill]:
    return [load_skill(d) for d in skill_dirs]
