"""DocAtlas CLI entry point — `python -m harness ...`.

Phase 2 surface: a single `chat` subcommand that runs one user message
through the agent loop and prints the final answer + a compact trace.

Example:

    python -m harness chat --skill Read \\
        --pdf /path/to/doc.pdf \\
        --message "What's on page 4?"
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

import yaml

from .agent.dispatch import SkillDispatcher
from .agent.loop import AgentLoop
from .agent.post_note import PostNoteHooks
from .config import HarnessConfig
from .llm.factory import make_backend
from .prompt_composer import build_tool_schemas, compose_system_prompt
from .session import DocEnv, SessionStore
from .skill_loader import load_skill


_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_SKILLS_ROOT = _REPO_ROOT / "DocSkills"


def _resolve_skill_dir(name_or_path: str) -> Path:
    p = Path(name_or_path)
    if p.is_dir():
        return p
    candidate = _DEFAULT_SKILLS_ROOT / name_or_path
    if candidate.is_dir():
        return candidate
    raise FileNotFoundError(
        f"Skill '{name_or_path}' not found (looked for ./{name_or_path} and {candidate})"
    )


def _load_profile(path: str | Path) -> dict[str, Any]:
    """Load a YAML profile file and return it as a flat dict."""
    p = Path(path)
    if not p.is_file():
        # Try relative to repo root
        candidate = _REPO_ROOT / path
        if candidate.is_file():
            p = candidate
        else:
            raise FileNotFoundError(f"Profile not found: {path}")
    with open(p) as f:
        data = yaml.safe_load(f) or {}
    return data


def _apply_profile(args: argparse.Namespace, profile: dict[str, Any]) -> None:
    """Apply profile defaults to args — CLI explicit values take precedence.

    Convention: profile uses underscores (``max_turns``), matching the
    argparse dest names. The special key ``skills`` maps to ``args.skill``.
    """
    # Map profile key -> argparse dest for keys that differ
    key_map = {"skills": "skill"}

    for key, value in profile.items():
        dest = key_map.get(key, key)
        current = getattr(args, dest, None)

        # Skip if CLI explicitly set a value (not None / not default empty list)
        if dest == "skill":
            # --skill is append: None means not provided, [] impossible from argparse
            if current is not None:
                continue
            setattr(args, dest, value)
        elif current is not None:
            continue
        else:
            setattr(args, dest, value)


def cmd_chat(args: argparse.Namespace) -> int:
    # Apply profile defaults (CLI flags override profile values)
    if getattr(args, "profile", None):
        profile = _load_profile(args.profile)
        _apply_profile(args, profile)

    cfg = HarnessConfig.from_env()
    if args.max_turns:
        cfg.max_turns = args.max_turns
    if args.memory is not None:
        cfg.enable_memory = bool(args.memory)
    if args.tree_annotate is not None:
        cfg.enable_tree_annotate = bool(args.tree_annotate)
    if getattr(args, "backend", None):
        cfg.backend = args.backend
    if getattr(args, "copilot_base_url", None):
        cfg.copilot_base_url = args.copilot_base_url
    if getattr(args, "copilot_model", None):
        cfg.copilot_model = args.copilot_model
    if getattr(args, "copilot_max_tokens", None):
        cfg.copilot_max_tokens = args.copilot_max_tokens

    # Validate required fields (may come from CLI or profile)
    if not args.skill:
        print("error: --skill is required (via CLI or profile)", file=sys.stderr)
        return 2
    if not args.message:
        print("error: --message is required (via CLI or profile)", file=sys.stderr)
        return 2

    skills = [load_skill(_resolve_skill_dir(name)) for name in args.skill]

    # ── Multi-doc handling ───────────────────────────────────────────────
    # `--pdf` may be repeated (action="append"); `--manifest` may also
    # supply a list of {pdf, markdown_dir?, doc_id?} entries. If we end
    # up with 2+ docs, build a `doc_map` so the Read skill can route by
    # `doc_id` and Search can filter the (merged) tree per doc.
    pdf_list = list(getattr(args, "pdf", None) or [])
    manifest_entries: list[dict] = []
    if getattr(args, "manifest", None):
        with open(args.manifest, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        if not isinstance(payload, list):
            print("error: --manifest must be a JSON list of objects",
                  file=sys.stderr)
            return 2
        manifest_entries = payload
        for e in manifest_entries:
            if isinstance(e, dict) and e.get("pdf"):
                pdf_list.append(str(e["pdf"]))

    doc_map: dict[str, dict[str, str]] | None = None
    primary_pdf = args.pdf if isinstance(args.pdf, str) else None
    primary_md_dir = args.markdown_dir
    primary_doc_id = args.doc_id

    if len(pdf_list) >= 2:
        from pathlib import Path as _Path
        doc_map = {}
        for i, pdf_path in enumerate(pdf_list):
            stem = _Path(pdf_path).stem
            entry_md_dir = args.markdown_dir
            entry_doc_id = stem
            if i < len(manifest_entries):
                m = manifest_entries[i] or {}
                entry_md_dir = m.get("markdown_dir") or entry_md_dir
                entry_doc_id = m.get("doc_id") or entry_doc_id
            doc_map[entry_doc_id] = {
                "pdf_path": str(_Path(pdf_path).resolve()),
                "markdown_dir": str(entry_md_dir or ""),
                "doc_id": entry_doc_id,
            }
        first_key = next(iter(doc_map))
        primary_pdf = doc_map[first_key]["pdf_path"]
        primary_md_dir = doc_map[first_key]["markdown_dir"] or primary_md_dir
        primary_doc_id = doc_map[first_key]["doc_id"]
    elif len(pdf_list) == 1:
        primary_pdf = pdf_list[0]

    # Build DocEnv + SessionStore up front so stateful skills have somewhere
    # to persist through the chat.
    doc_env = DocEnv.from_cli(
        pdf=primary_pdf,
        markdown_dir=primary_md_dir,
        doc_id=primary_doc_id,
        tree_json_path=args.tree_json,
        doc_map=doc_map,
    )
    session = SessionStore.new(doc_env, question=args.message)
    sys.stderr.write(f"[session] {session.summary()} → {session.path}\n")
    renderer = None
    if not args.quiet:
        from .ui.plain_renderer import PlainRenderer
        renderer = PlainRenderer(session)

    backend = make_backend(cfg)

    # Pass aux-LLM settings to every skill subprocess so Review (and future
    # llm-using skills) pick up the right endpoint/model.
    aux_env: dict[str, str] = {}
    if cfg.aux_endpoint:
        aux_env["HARNESS_AUX_LLM_ENDPOINT"] = cfg.aux_endpoint
    if cfg.aux_api_version:
        aux_env["HARNESS_AUX_LLM_API_VERSION"] = cfg.aux_api_version
    if cfg.aux_model:
        aux_env["HARNESS_AUX_LLM_MODEL"] = cfg.aux_model
    aux_env["HARNESS_FIGURE_MIN_SIZE"] = str(args.figure_min_size)
    aux_env["HARNESS_FIGURE_MIN_BYTES"] = str(args.figure_min_bytes)

    dispatcher = SkillDispatcher(
        skills,
        session_args={
            "pdf": doc_env.pdf_path,
            "markdown_dir": doc_env.markdown_dir,
            "doc_id": doc_env.doc_id,
            "doc_map": doc_env.doc_map,
        },
        python_executable=cfg.skill_python,
        session_file=session.path,
        extra_env=aux_env,
    )

    loop = AgentLoop(
        backend=backend,
        dispatcher=dispatcher,
        tool_schemas=build_tool_schemas(skills),
        system_prompt=compose_system_prompt(skills, memory_enabled=cfg.enable_memory, tree_annotate_enabled=cfg.enable_tree_annotate),
        max_turns=cfg.max_turns,
        image_detail=cfg.image_detail,
        post_note_hooks=PostNoteHooks(
            archive_enabled=cfg.enable_memory,
            tree_annotate_enabled=cfg.enable_tree_annotate,
        ) if (cfg.enable_memory or cfg.enable_tree_annotate) else None,
        session_store=session,
        callbacks=renderer.as_callbacks() if renderer else None,
    )

    # In multi-doc chats, prepend a one-shot preamble listing the doc_ids
    # so the model knows what values it can pass to Read/Search's `doc_id`.
    user_message = args.message
    if doc_map and len(doc_map) > 1:
        bits = [f"This question spans {len(doc_map)} documents. "
                "When calling Read or Search, pass `doc_id` to select "
                "which document to operate on. Available doc_ids:"]
        for did in doc_map:
            bits.append(f"  - {did}")
        bits.append("")
        bits.append(args.message)
        user_message = "\n".join(bits)

    result = loop.run(user_message)

    sys.stdout.write(result.answer.rstrip() + "\n")
    if renderer:
        renderer.print_stats(result)
        try:
            session.refresh_from_disk()
            sys.stderr.write(f"[session-final] {session.summary()}\n")
        except Exception:  # noqa: BLE001
            pass
    return 0 if not result.error else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="harness", description="DocAtlas CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    chat = sub.add_parser("chat", help="Run a single user message through the agent.")
    chat.add_argument(
        "--profile", help="Path to a YAML profile (defaults for all flags).",
    )
    chat.add_argument(
        "--skill", action="append", default=None,
        help="Skill name (looked up under DocSkills/) or path. Repeatable.",
    )
    chat.add_argument("--message", default=None, help="The user message.")
    chat.add_argument(
        "--pdf", action="append", default=None,
        help="Path to the PDF for skills that need it (Read). Repeat for "
             "multi-doc QA — when 2+ PDFs are given (or a --manifest is used) "
             "the harness builds a doc_map and Read/Search route by `doc_id` "
             "(the PDF stem). The Search tree should typically be a merged "
             "series tree (see `harness merge-trees` / `harness build-series-tree`).",
    )
    chat.add_argument(
        "--manifest", default=None,
        help="JSON list of {pdf, markdown_dir?, doc_id?} entries for multi-doc "
             "chat. Equivalent to repeating --pdf but lets you override the "
             "per-doc markdown_dir or doc_id.",
    )
    chat.add_argument("--markdown-dir", help="Root of MinerU per-page markdown.")
    chat.add_argument("--doc-id", help="Doc folder name under --markdown-dir (defaults to PDF stem).")
    chat.add_argument("--tree-json", help="Path to a PageIndex tree JSON to load into the session.")
    chat.add_argument("--max-turns", type=int, default=None)
    chat.add_argument(
        "--memory", dest="memory", action="store_true", default=None,
        help="Enable archival of stale Read outputs after each Note.",
    )
    chat.add_argument(
        "--no-memory", dest="memory", action="store_false",
        help="Disable memory policy even if HARNESS_ENABLE_MEMORY=1.",
    )
    chat.add_argument(
        "--tree-annotate", dest="tree_annotate", action="store_true", default=None,
        help="Enable automatic tree annotation after each Note call.",
    )
    chat.add_argument(
        "--no-tree-annotate", dest="tree_annotate", action="store_false",
        help="Disable tree annotation hook.",
    )
    chat.add_argument(
        "--figure-min-size", type=int, default=100,
        help="Min width/height (px) for figure catalog entries (default: 100).",
    )
    chat.add_argument(
        "--figure-min-bytes", type=int, default=2048,
        help="Min file size (bytes) for figure catalog entries (default: 2048).",
    )
    chat.add_argument("--quiet", action="store_true", help="Suppress the trace on stderr.")
    chat.add_argument(
        "--backend", choices=["azure", "copilot"], default=None,
        help="LLM backend to use. 'azure' (default) → Azure Responses API; "
             "'copilot' → OpenAI-compatible chat.completions against copilot-api.",
    )
    chat.add_argument("--copilot-base-url", default=None,
                      help="Base URL for copilot-api (default: http://localhost:4141/v1).")
    chat.add_argument("--copilot-model", default=None,
                      help="Model id served by copilot-api (e.g. gemini-2.5-pro).")
    chat.add_argument("--copilot-max-tokens", type=int, default=None,
                      help="Max output tokens for copilot backend (default: 4096).")
    chat.set_defaults(func=cmd_chat)

    # ── eval-mmlongbench (Phase 4 batch task) ──
    eval_mml = sub.add_parser(
        "eval-mmlongbench",
        help="MMLongBench-Doc batch evaluation.",
    )
    # Lazy import to avoid pulling the task module unless this subcommand is used.
    # Ensure the repo root (parent of `harness/`) is on sys.path so `tasks/` resolves.
    _repo_root = str(Path(__file__).resolve().parent.parent)
    if _repo_root not in sys.path:
        sys.path.insert(0, _repo_root)
    from tasks.mmlongbench.runner import MMLongBenchTask  # noqa: PLC0415

    _mml_task = MMLongBenchTask()
    _mml_task.add_arguments(eval_mml)
    eval_mml.set_defaults(func=_mml_task.run)

    # ── build-tree (PageIndex tree construction) ──
    build_tree = sub.add_parser(
        "build-tree",
        help="Build PageIndex tree structures for PDF documents.",
    )
    from tasks.preprocess import BuildTreeTask  # noqa: PLC0415

    BuildTreeTask.add_arguments(build_tree)
    build_tree.set_defaults(func=BuildTreeTask.run)

    # ── build-md (Docling per-page markdown extraction) ──
    build_md = sub.add_parser(
        "build-md",
        help="Build per-page markdown (+figures) for PDFs using Docling. "
             "Lightweight CPU-friendly alternative to MinerU.",
    )
    from tasks.preprocess import BuildMdTask  # noqa: PLC0415

    BuildMdTask.add_arguments(build_md)
    build_md.set_defaults(func=BuildMdTask.run)

    # ── merge-trees (combine N single-doc trees → one series tree) ──
    merge_trees = sub.add_parser(
        "merge-trees",
        help="Merge N single-doc PageIndex trees into one series tree "
             "(series-tree schema).",
    )
    from tasks.preprocess import MergeTreesTask  # noqa: PLC0415

    MergeTreesTask.add_arguments(merge_trees)
    merge_trees.set_defaults(func=MergeTreesTask.run)

    # ── build-series-tree (PDFs → trees → merged series in one shot) ──
    build_series = sub.add_parser(
        "build-series-tree",
        help="Build per-doc trees then merge them into one series tree "
             "(end-to-end multi-doc preprocessing).",
    )
    from tasks.preprocess import BuildSeriesTreeTask  # noqa: PLC0415

    BuildSeriesTreeTask.add_arguments(build_series)
    build_series.set_defaults(func=BuildSeriesTreeTask.run)

    return p


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
