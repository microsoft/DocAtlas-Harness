"""DocAtlas CLI entry point — `harness ...` or `python -m docatlas ...`.

The `chat` subcommand runs one user message through the agent loop and prints
the final answer plus a compact trace.

Example:

    uv run --locked harness chat --skill read \\
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

from . import __version__
from .agent.dispatch import SkillDispatcher
from .agent.loop import AgentLoop
from .agent.post_note import PostNoteHooks
from .config import HarnessConfig
from .llm.factory import make_backend
from .prompt_composer import build_tool_schemas, compose_system_prompt
from .session import DocEnv, SessionStore
from .skill_loader import load_skills

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_SKILLS_ROOT = Path(__file__).resolve().parent / "skills"
logger = logging.getLogger(__name__)


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
        candidates = [
            _REPO_ROOT / path,
            Path(__file__).resolve().parent / "profiles" / f"{Path(path).stem}.yaml",
        ]
        found = next((candidate for candidate in candidates if candidate.is_file()), None)
        if found is None:
            raise FileNotFoundError(f"Profile not found: {path}")
        p = found
    with open(p) as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Profile must contain a YAML mapping: {p}")
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
        if not hasattr(args, dest):
            raise ValueError(f"Unknown profile key: {key}")
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


def cmd_init_session(args: argparse.Namespace) -> int:
    """Create a reusable session file for direct DocSkill CLI calls."""
    pdf = None
    if args.pdf:
        pdf_path = Path(args.pdf).expanduser().resolve()
        if not pdf_path.is_file():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")
        pdf = str(pdf_path)
    tree_json = None
    if args.tree_json:
        tree_path = Path(args.tree_json).expanduser().resolve()
        if not tree_path.is_file():
            raise FileNotFoundError(f"tree JSON not found: {tree_path}")
        tree_json = str(tree_path)
    sessions_root = Path(args.sessions_root).expanduser() if args.sessions_root else None
    doc_env = DocEnv.from_cli(
        pdf=pdf,
        markdown_dir=args.markdown_dir,
        doc_id=args.doc_id,
        tree_json_path=tree_json,
    )
    session = SessionStore.new(
        doc_env,
        question=args.question or "",
        sessions_root=sessions_root,
        session_id=args.session_id,
    )
    print(session.path.resolve())
    return 0


def cmd_chat(args: argparse.Namespace) -> int:
    # Apply profile defaults (CLI flags override profile values)
    if getattr(args, "profile", None):
        profile = _load_profile(args.profile)
        _apply_profile(args, profile)

    # Validate required fields (may come from CLI or profile)
    if not args.skill:
        print("error: --skill is required (via CLI or profile)", file=sys.stderr)
        return 2
    if not args.message:
        print("error: --message is required (via CLI or profile)", file=sys.stderr)
        return 2

    skills = load_skills([_resolve_skill_dir(name) for name in args.skill])
    skill_names = {skill.name for skill in skills}

    cfg = HarnessConfig.from_env()
    if args.max_turns is not None:
        if args.max_turns < 1:
            raise ValueError("--max-turns must be at least 1")
        cfg.max_turns = args.max_turns
    if args.memory is not None:
        cfg.enable_memory = bool(args.memory)
    if args.tree_annotate is not None:
        cfg.enable_tree_annotate = bool(args.tree_annotate)
    if args.reasoning_effort is not None:
        cfg.reasoning_effort = args.reasoning_effort
    if args.reasoning_summary is not None:
        cfg.reasoning_summary = args.reasoning_summary
    if args.image_detail is not None:
        cfg.image_detail = args.image_detail
    if args.parallel_tool_calls is not None:
        cfg.parallel_tool_calls = bool(args.parallel_tool_calls)
    max_input_images = args.max_input_images if args.max_input_images is not None else 50
    if max_input_images < 0:
        raise ValueError("--max-input-images must be non-negative")
    if args.figure_min_size is None:
        args.figure_min_size = 100
    if args.figure_min_bytes is None:
        args.figure_min_bytes = 2048
    if args.figure_min_size < 0 or args.figure_min_bytes < 0:
        raise ValueError("figure filter thresholds must be non-negative")

    # ── Multi-doc handling ───────────────────────────────────────────────
    # `--pdf` may be repeated (action="append"); `--manifest` may also
    # supply a list of {pdf, markdown_dir?, doc_id?} entries. If we end
    # up with 2+ docs, build a `doc_map` so the Read skill can route by
    # `doc_id` and Search can filter the (merged) tree per doc.
    pdf_args = getattr(args, "pdf", None) or []
    if isinstance(pdf_args, str):
        pdf_args = [pdf_args]
    doc_specs: list[dict[str, Any]] = [{"pdf": pdf_path} for pdf_path in pdf_args]
    if getattr(args, "manifest", None):
        with open(args.manifest, encoding="utf-8") as fh:
            payload = json.load(fh)
        if not isinstance(payload, list):
            raise ValueError("--manifest must be a JSON list of objects")
        for index, entry in enumerate(payload):
            if not isinstance(entry, dict) or not entry.get("pdf"):
                raise ValueError(f"--manifest entry {index} must contain a non-empty 'pdf'")
            doc_specs.append(dict(entry))

    doc_map: dict[str, dict[str, str]] | None = None
    primary_pdf: str | None = None
    primary_md_dir = args.markdown_dir
    primary_doc_id = args.doc_id

    normalized_specs: list[dict[str, str]] = []
    for index, spec in enumerate(doc_specs):
        pdf_path = Path(str(spec["pdf"])).expanduser().resolve()
        if not pdf_path.is_file():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")
        entry_doc_id = str(spec.get("doc_id") or pdf_path.stem).strip()
        if not entry_doc_id:
            raise ValueError(f"document {index} has an empty doc_id")
        entry_md_dir = str(spec.get("markdown_dir") or args.markdown_dir or "")
        normalized_specs.append(
            {
                "pdf_path": str(pdf_path),
                "markdown_dir": entry_md_dir,
                "doc_id": entry_doc_id,
            }
        )

    if len(normalized_specs) >= 2:
        doc_map = {}
        for spec in normalized_specs:
            entry_doc_id = spec["doc_id"]
            if entry_doc_id in doc_map:
                raise ValueError(f"duplicate doc_id in inputs: {entry_doc_id}")
            doc_map[entry_doc_id] = spec
        first_key = next(iter(doc_map))
        primary_pdf = doc_map[first_key]["pdf_path"]
        primary_md_dir = doc_map[first_key]["markdown_dir"] or primary_md_dir
        primary_doc_id = doc_map[first_key]["doc_id"]
    elif len(normalized_specs) == 1:
        spec = normalized_specs[0]
        primary_pdf = spec["pdf_path"]
        primary_md_dir = spec["markdown_dir"] or primary_md_dir
        primary_doc_id = spec["doc_id"]

    if "read" in skill_names and not primary_pdf and not (primary_md_dir and primary_doc_id):
        raise ValueError("the read skill requires --pdf, or both --markdown-dir and --doc-id")
    if "search" in skill_names and not args.tree_json:
        raise ValueError("the search skill requires --tree-json")

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
    aux_env["HARNESS_ENABLE_MEMORY"] = "1" if cfg.enable_memory else "0"
    aux_env["HARNESS_ENABLE_TREE_ANNOTATE"] = "1" if cfg.enable_tree_annotate else "0"
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
        system_prompt=compose_system_prompt(
            skills, memory_enabled=cfg.enable_memory, tree_annotate_enabled=cfg.enable_tree_annotate
        ),
        max_turns=cfg.max_turns,
        image_detail=cfg.image_detail,
        post_note_hooks=PostNoteHooks(
            archive_enabled=cfg.enable_memory,
            tree_annotate_enabled=cfg.enable_tree_annotate,
        )
        if (cfg.enable_memory or cfg.enable_tree_annotate)
        else None,
        session_store=session,
        callbacks=renderer.as_callbacks() if renderer else None,
        max_input_images=max_input_images,
    )

    # In multi-doc chats, prepend a one-shot preamble listing the doc_ids
    # so the model knows what values it can pass to Read/Search's `doc_id`.
    user_message = args.message
    if doc_map and len(doc_map) > 1:
        bits = [
            f"This question spans {len(doc_map)} documents. "
            "When calling Read or Search, pass `doc_id` to select "
            "which document to operate on. Available doc_ids:"
        ]
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
            logger.warning("Could not refresh final session summary", exc_info=True)
    return 0 if not result.error else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="harness", description="DocAtlas CLI")
    p.add_argument("--version", action="version", version=f"DocAtlas {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    init_session = sub.add_parser(
        "init-session",
        help="Create a session file for direct DocSkill CLI calls.",
    )
    init_session.add_argument("--pdf", help="Optional PDF path.")
    init_session.add_argument("--markdown-dir", help="Optional per-page Markdown root.")
    init_session.add_argument("--doc-id", help="Document id under --markdown-dir.")
    init_session.add_argument("--tree-json", help="Optional PageIndex tree JSON.")
    init_session.add_argument("--question", default="", help="Question stored with the session.")
    init_session.add_argument("--sessions-root", help="Directory in which to create the session.")
    init_session.add_argument("--session-id", help="Explicit unique session directory name.")
    init_session.set_defaults(func=cmd_init_session)

    chat = sub.add_parser("chat", help="Run a single user message through the agent.")
    chat.add_argument(
        "--profile",
        help="Built-in profile name or YAML path (defaults for all flags).",
    )
    chat.add_argument(
        "--skill",
        action="append",
        default=None,
        help="Skill name (looked up under docatlas/skills/) or path. Repeatable.",
    )
    chat.add_argument("--message", default=None, help="The user message.")
    chat.add_argument(
        "--pdf",
        action="append",
        default=None,
        help="Path to the PDF for skills that need it (read). Repeat for "
        "multi-doc QA — when 2+ PDFs are given (or a --manifest is used) "
        "the harness builds a doc_map and read/search route by `doc_id` "
        "(the PDF stem). The search tree should typically be a merged "
        "series tree (see `harness merge-trees` / `harness build-series-tree`).",
    )
    chat.add_argument(
        "--manifest",
        default=None,
        help="JSON list of {pdf, markdown_dir?, doc_id?} entries for multi-doc "
        "chat. Equivalent to repeating --pdf but lets you override the "
        "per-doc markdown_dir or doc_id.",
    )
    chat.add_argument("--markdown-dir", help="Root of MinerU/Docling per-page Markdown.")
    chat.add_argument(
        "--doc-id", help="Doc folder name under --markdown-dir (defaults to PDF stem)."
    )
    chat.add_argument("--tree-json", help="Path to a PageIndex tree JSON to load into the session.")
    chat.add_argument("--max-turns", type=int, default=None)
    chat.add_argument(
        "--reasoning-effort",
        choices=["minimal", "low", "medium", "high"],
        default=None,
        help="Reasoning effort sent to the Azure Responses API.",
    )
    chat.add_argument(
        "--reasoning-summary",
        choices=["auto", "concise", "detailed"],
        default=None,
        help="Reasoning-summary detail emitted in the progress trace.",
    )
    chat.add_argument(
        "--image-detail",
        choices=["low", "high", "auto"],
        default=None,
        help="Detail level for model-visible page and figure images.",
    )
    chat.add_argument(
        "--parallel-tool-calls",
        action="store_true",
        default=None,
        help="Allow the model to request multiple tools in one turn.",
    )
    chat.add_argument(
        "--max-input-images",
        type=int,
        default=None,
        help="Maximum retained input images; 0 disables trimming (default: 50).",
    )
    chat.add_argument(
        "--memory",
        dest="memory",
        action="store_true",
        default=None,
        help="Enable archival of stale Read outputs after each Note.",
    )
    chat.add_argument(
        "--no-memory",
        dest="memory",
        action="store_false",
        help="Disable memory policy even if HARNESS_ENABLE_MEMORY=1.",
    )
    chat.add_argument(
        "--tree-annotate",
        dest="tree_annotate",
        action="store_true",
        default=None,
        help="Enable automatic tree annotation after each Note call.",
    )
    chat.add_argument(
        "--no-tree-annotate",
        dest="tree_annotate",
        action="store_false",
        help="Disable tree annotation hook.",
    )
    chat.add_argument(
        "--figure-min-size",
        type=int,
        default=None,
        help="Min width/height (px) for figure catalog entries (default: 100).",
    )
    chat.add_argument(
        "--figure-min-bytes",
        type=int,
        default=None,
        help="Min file size (bytes) for figure catalog entries (default: 2048).",
    )
    chat.add_argument(
        "--quiet",
        action="store_true",
        default=None,
        help="Suppress the trace on stderr.",
    )
    chat.set_defaults(func=cmd_chat)

    # ── eval-mmlongbench batch task ──
    eval_mml = sub.add_parser(
        "eval-mmlongbench",
        help="MMLongBench-Doc batch evaluation.",
    )
    # Lazy import to avoid pulling the benchmark module unless this command is used.
    from .benchmarks.mmlongbench.runner import MMLongBenchTask  # noqa: PLC0415

    _mml_task = MMLongBenchTask()
    _mml_task.add_arguments(eval_mml)
    eval_mml.set_defaults(func=_mml_task.run)

    # ── build-tree (PageIndex tree construction) ──
    build_tree = sub.add_parser(
        "build-tree",
        help="Build PageIndex tree structures for PDF documents.",
    )
    from .preprocess import BuildTreeTask  # noqa: PLC0415

    BuildTreeTask.add_arguments(build_tree)
    build_tree.set_defaults(func=BuildTreeTask.run)

    # ── build-md (Docling per-page markdown extraction) ──
    build_md = sub.add_parser(
        "build-md",
        help="Build per-page markdown (+figures) for PDFs using Docling. "
        "Lightweight CPU-friendly alternative to MinerU.",
    )
    from .preprocess import BuildMdTask  # noqa: PLC0415

    BuildMdTask.add_arguments(build_md)
    build_md.set_defaults(func=BuildMdTask.run)

    # ── merge-trees (combine N single-doc trees → one series tree) ──
    merge_trees = sub.add_parser(
        "merge-trees",
        help="Merge N single-doc PageIndex trees into one series tree (series-tree schema).",
    )
    from .preprocess import MergeTreesTask  # noqa: PLC0415

    MergeTreesTask.add_arguments(merge_trees)
    merge_trees.set_defaults(func=MergeTreesTask.run)

    # ── build-series-tree (PDFs → trees → merged series in one shot) ──
    build_series = sub.add_parser(
        "build-series-tree",
        help="Build per-doc trees then merge them into one series tree "
        "(end-to-end multi-doc preprocessing).",
    )
    from .preprocess import BuildSeriesTreeTask  # noqa: PLC0415

    BuildSeriesTreeTask.add_arguments(build_series)
    build_series.set_defaults(func=BuildSeriesTreeTask.run)

    return p


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (
        FileNotFoundError,
        json.JSONDecodeError,
        RuntimeError,
        ValueError,
        yaml.YAMLError,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
