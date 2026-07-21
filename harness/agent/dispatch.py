"""Dispatch a SKILL by spawning its CLI as a subprocess.

The dispatcher is the single component that knows the SKILL output
convention (`pages[*].text`, `pages[*].page_image`,
`_harness_extras.figure_images[*].uri`, etc.). Everywhere else in the
harness operates on `SkillResult`, which separates plain text from image
data URIs so the loop can route the latter to native image content blocks.

Session-level args (the PDF path, MinerU markdown directory) are bound when
the dispatcher is constructed and injected into every call. Those settings
intentionally do **not** appear in the LLM-facing tool schema — the model
shouldn't be picking the document on every call; it picks pages.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..skill_loader import LoadedSkill


# ── Per-skill argv binding ──────────────────────────────────────────────────
#
# For Phase 2 we hard-wire `Read`'s session args. Other skills will plug in
# here in Phase 3. A more general system (declarative session-arg binding
# via a sidecar file) can come later — the goal now is to keep this honest
# and small.

_SESSION_ARG_INJECTORS: dict[str, callable] = {}


def _resolve_doc_in_map(session: dict[str, Any], requested_doc_id: str | None) -> dict[str, Any] | None:
    """Look up a doc entry in session['doc_map'] by id (PDF stem).

    Tolerant of the `.pdf` suffix and case differences. Returns None if no
    doc_map or no match.
    """
    doc_map = session.get("doc_map") or None
    if not isinstance(doc_map, dict) or not doc_map:
        return None
    if not requested_doc_id:
        return None
    key = str(requested_doc_id)
    # Strip a trailing .pdf if the model added it.
    if key.lower().endswith(".pdf"):
        key = key[:-4]
    if key in doc_map:
        return doc_map[key]
    # case-insensitive fallback
    lk = key.lower()
    for k, v in doc_map.items():
        if str(k).lower() == lk:
            return v
    return None


def _inject_read_session_args(session: dict[str, Any], model_args: dict[str, Any] | None = None) -> list[str]:
    argv: list[str] = []
    # Multi-doc routing: if the model specified a `doc_id` and the session
    # carries a doc_map, resolve pdf/markdown_dir from that map.
    requested = (model_args or {}).get("doc_id") if model_args else None
    entry = _resolve_doc_in_map(session, requested)
    if entry is not None:
        pdf = entry.get("pdf_path")
        md_dir = entry.get("markdown_dir")
        did = entry.get("doc_id")
        if not pdf:
            raise ValueError(
                f"doc_map entry for '{requested}' is missing 'pdf_path'"
            )
        argv.extend(["--pdf", str(pdf)])
        if md_dir:
            argv.extend(["--markdown-dir", str(md_dir)])
        if did:
            argv.extend(["--doc-id", str(did)])
        return argv
    pdf = session.get("pdf")
    if not pdf:
        raise ValueError("Read skill requires session arg 'pdf' (path to the PDF)")
    argv.extend(["--pdf", str(pdf)])
    md_dir = session.get("markdown_dir")
    if md_dir:
        argv.extend(["--markdown-dir", str(md_dir)])
    doc_id = session.get("doc_id")
    if doc_id:
        argv.extend(["--doc-id", str(doc_id)])
    return argv


def _inject_noop(session: dict[str, Any], model_args: dict[str, Any] | None = None) -> list[str]:
    # Skills that read everything they need from HARNESS_SESSION_FILE.
    return []


_SESSION_ARG_INJECTORS["Read"] = _inject_read_session_args
_SESSION_ARG_INJECTORS["Note"] = _inject_noop
_SESSION_ARG_INJECTORS["Review"] = _inject_noop
_SESSION_ARG_INJECTORS["Search"] = _inject_noop


# ── Argv builder for per-call args from the model ───────────────────────────


def _model_args_to_argv(args: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    """Translate {param: value} model args into CLI flags.

    Conventions (matching Read's run.py):
      - underscored param name → kebab-cased flag (`with_image` → `--with-image`)
      - bool: emitted as a flag without value when True; omitted when False
      - list/dict: serialized as JSON (so downstream argparse can json.loads it)
      - everything else: `--flag value` (stringified)
      - None values are omitted
    """
    properties = (schema or {}).get("properties", {})
    argv: list[str] = []
    for key, value in args.items():
        if value is None:
            continue
        prop = properties.get(key, {})
        flag = "--" + key.replace("_", "-")
        if prop.get("type") == "boolean" or isinstance(value, bool):
            if value:
                argv.append(flag)
            continue
        if isinstance(value, (list, dict)):
            argv.extend([flag, json.dumps(value, ensure_ascii=False)])
            continue
        argv.extend([flag, str(value)])
    return argv


# ── Result containers ──────────────────────────────────────────────────────


@dataclass
class SkillResult:
    skill_name: str
    ok: bool
    text_output: str                            # what we send back as function_call_output
    image_uris: list[str] = field(default_factory=list)
    raw_json: dict[str, Any] | None = None      # full parsed stdout
    session_patch: dict[str, Any] | None = None # _harness_extras.session_patch, if present
    stderr: str = ""
    returncode: int = 0


def _extract_text_and_images(skill_name: str, payload: dict[str, Any]) -> tuple[str, list[str]]:
    """Pull (text_blob, [image_uri,...]) out of a skill JSON payload.

    Knows the Read convention; falls back to a generic `text` field for
    other skills. Image fields are stripped from the text blob so we don't
    waste tokens shipping base64 twice.
    """
    images: list[str] = []
    pages = payload.get("pages")
    if isinstance(pages, list):
        text_chunks: list[str] = []
        meta_bits: list[str] = []
        for p in pages:
            if not isinstance(p, dict):
                continue
            t = p.get("text")
            if t:
                text_chunks.append(t)
            img = p.get("page_image")
            if img:
                images.append(img)
        if payload.get("mode"):
            meta_bits.append(f"mode={payload['mode']}")
        if payload.get("missing_pages"):
            meta_bits.append(f"missing_pages={payload['missing_pages']}")
        if payload.get("text_is_empty"):
            meta_bits.append("text_is_empty=true (page has no extractable text — request --with-image)")
        text_blob = "\n\n".join(text_chunks)
        if meta_bits:
            text_blob = "[" + "; ".join(meta_bits) + "]\n" + text_blob

        extras = payload.get("_harness_extras") or {}
        for fig in extras.get("figure_images") or []:
            uri = fig.get("uri")
            if uri:
                images.append(uri)
        return text_blob or "[skill returned no text]", images

    # Generic fallback
    text = payload.get("text")
    if isinstance(text, str):
        return text, images
    return json.dumps(payload, ensure_ascii=False), images


# ── The dispatcher ─────────────────────────────────────────────────────────


class SkillDispatcher:
    def __init__(
        self,
        skills: list[LoadedSkill],
        *,
        session_args: dict[str, Any],
        python_executable: str | None = None,
        session_file: str | Path | None = None,
        extra_env: dict[str, str] | None = None,
    ):
        self._by_name = {s.name: s for s in skills}
        self.session_args = session_args
        self.python = python_executable or os.getenv("HARNESS_SKILL_PYTHON") or sys.executable
        self.session_file = str(session_file) if session_file else None
        self.extra_env = dict(extra_env or {})

    def _subprocess_env(self) -> dict[str, str]:
        env = dict(os.environ)
        if self.session_file:
            env["HARNESS_SESSION_FILE"] = self.session_file
        for k, v in self.extra_env.items():
            if v is not None:
                env[str(k)] = str(v)
        return env

    def call(self, skill_name: str, args: dict[str, Any]) -> SkillResult:
        skill = self._by_name.get(skill_name)
        if skill is None:
            return SkillResult(
                skill_name=skill_name, ok=False,
                text_output=f"[error] unknown skill '{skill_name}'. "
                            f"Available: {list(self._by_name)}",
            )

        argv = [self.python, str(skill.cli_path)]
        injector = _SESSION_ARG_INJECTORS.get(skill_name)
        consumed_model_keys: set[str] = set()
        if injector is not None:
            argv.extend(injector(self.session_args, args))
            # Skills whose session-arg injector observes a model arg (like
            # Read's `doc_id`) should not also receive it via _model_args_to_argv,
            # or the CLI sees the flag twice.
            if skill_name == "Read" and (self.session_args.get("doc_map") or self.session_args.get("pdf")):
                consumed_model_keys.add("doc_id")
        model_args_for_cli = {k: v for k, v in args.items() if k not in consumed_model_keys}
        argv.extend(_model_args_to_argv(model_args_for_cli, skill.parameters_schema))

        try:
            proc = subprocess.run(
                argv, capture_output=True, text=True, check=False,
                env=self._subprocess_env(),
                timeout=300,  # 5-minute hard limit per skill call
            )
        except subprocess.TimeoutExpired:
            return SkillResult(
                skill_name=skill_name, ok=False,
                text_output=f"[error] skill timed out after 300s",
            )
        except Exception as e:                    # noqa: BLE001
            return SkillResult(
                skill_name=skill_name, ok=False,
                text_output=f"[error] failed to launch skill: {e}",
            )

        if proc.returncode != 0:
            return SkillResult(
                skill_name=skill_name, ok=False,
                text_output=f"[error] skill exited {proc.returncode}\nstderr:\n{proc.stderr.strip()[:2000]}",
                stderr=proc.stderr, returncode=proc.returncode,
            )

        try:
            payload = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception as e:                    # noqa: BLE001
            return SkillResult(
                skill_name=skill_name, ok=False,
                text_output=f"[error] could not parse skill JSON: {e}\nstdout head:\n{proc.stdout[:1000]}",
                stderr=proc.stderr, returncode=proc.returncode,
            )

        text_blob, images = _extract_text_and_images(skill_name, payload)
        session_patch = None
        extras = payload.get("_harness_extras") or {}
        if isinstance(extras.get("session_patch"), dict):
            session_patch = extras["session_patch"]
        return SkillResult(
            skill_name=skill_name, ok=True,
            text_output=text_blob, image_uris=images,
            raw_json=payload, session_patch=session_patch,
            stderr=proc.stderr, returncode=0,
        )
