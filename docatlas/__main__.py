"""DocAtlas CLI entry point — `docatlas ...` or `python -m docatlas ...`.

The `chat` subcommand runs one user message through the agent loop and prints
the final answer plus a compact trace.

Example:

    uv run --locked docatlas chat --skill read \\
        --pdf /path/to/doc.pdf \\
        --message "What's on page 4?"
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Protocol

import yaml

from . import __version__
from .config import HarnessConfig
from .runtime import create_agent_runtime
from .session import DocEnv, SessionStore
from .skill_loader import load_skills

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_SKILLS_ROOT = Path(__file__).resolve().parent / "skills"
_DEFAULT_SKILLS = ["search", "read", "note", "review"]
logger = logging.getLogger(__name__)


class _ResultSession(Protocol):
    session_id: str
    path: Path


def _read_message(value: str | None) -> str:
    """Resolve a message from --message, a terminal prompt, or piped stdin."""
    if value is not None and value.strip():
        return value.strip()
    if sys.stdin.isatty():
        try:
            value = input("DocAtlas question › ").strip()
        except EOFError:
            value = ""
    else:
        value = sys.stdin.read().strip()
    if not value:
        raise ValueError("a question is required via --message or stdin")
    return value


def _chat_result_payload(result: Any, session: _ResultSession) -> dict[str, Any]:
    """Build the stable, machine-readable chat result envelope."""
    from .ui.plain_renderer import safe_display_path

    turns = getattr(result, "turns", [])
    tools = [tool for turn in turns for tool in getattr(turn, "tool_calls", [])]
    return {
        "schema_version": "1",
        "answer": getattr(result, "answer", ""),
        "error": getattr(result, "error", None),
        "session": {
            "id": session.session_id,
            "path": safe_display_path(session.path),
        },
        "execution": {
            "turns": len(turns),
            "tool_calls": len(tools),
            "failed_tool_calls": sum(not getattr(tool, "ok", True) for tool in tools),
            "elapsed_seconds": round(float(getattr(result, "total_elapsed_s", 0.0)), 3),
        },
        "usage": {
            "input_tokens": int(getattr(result, "total_input_tokens", 0)),
            "output_tokens": int(getattr(result, "total_output_tokens", 0)),
            "reasoning_tokens": int(getattr(result, "total_reasoning_tokens", 0)),
        },
    }


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
    """Create a reusable session file for direct Agent Skill CLI calls."""
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


def cmd_tui(args: argparse.Namespace) -> int:
    """Launch the interactive document workbench."""
    from .ui.app import TUIOptions, run_tui

    options = TUIOptions(
        paths=list(getattr(args, "paths", None) or []),
        recursive=bool(getattr(args, "recursive", False)),
        force=bool(getattr(args, "force", False)),
        assume_yes=bool(getattr(args, "assume_yes", False)),
        workspace_root=getattr(args, "workspace_root", None),
        model=getattr(args, "model", None),
        max_turns=getattr(args, "max_turns", None),
        max_documents=int(getattr(args, "max_documents", 100)),
        show_reasoning=bool(getattr(args, "show_reasoning", False)),
        memory=bool(getattr(args, "memory", True)),
        tree_annotate=bool(getattr(args, "tree_annotate", True)),
    )
    return run_tui(options)


def cmd_chat(args: argparse.Namespace) -> int:
    # Apply profile defaults (CLI flags override profile values)
    if getattr(args, "profile", None):
        profile = _load_profile(args.profile)
        _apply_profile(args, profile)

    # Resolve ergonomic defaults after profile/CLI precedence is known.
    if not args.skill:
        args.skill = list(_DEFAULT_SKILLS)
    args.message = _read_message(args.message)

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
    runtime = create_agent_runtime(
        doc_env=doc_env,
        question=args.message,
        skills=skills,
        config=cfg,
        figure_min_size=args.figure_min_size,
        figure_min_bytes=args.figure_min_bytes,
        max_input_images=max_input_images,
    )
    session = runtime.session
    renderer = None
    output_format = args.output_format or "text"
    if not args.quiet and output_format == "text":
        from .ui.plain_renderer import PlainRenderer

        renderer = PlainRenderer(
            session,
            skills=[skill.name for skill in skills],
            show_reasoning=bool(args.show_reasoning),
        )
        renderer.print_session()
    runtime.loop.callbacks = renderer.as_callbacks() if renderer else None

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

    try:
        result = runtime.loop.run(user_message)
    except KeyboardInterrupt:
        if renderer:
            renderer.abort()
        raise

    if output_format == "json":
        json.dump(_chat_result_payload(result, session), sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        rendered_answer = renderer.print_answer(result.answer) if renderer else False
        if not rendered_answer:
            sys.stdout.write(result.answer.rstrip() + "\n")
            sys.stdout.flush()
        if renderer:
            renderer.print_stats(result)
    if renderer:
        try:
            session.refresh_from_disk()
        except Exception:  # noqa: BLE001
            logger.warning("Could not refresh final session summary", exc_info=True)
    return 0 if not result.error else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="docatlas", description="DocAtlas CLI")
    p.add_argument("--version", action="version", version=f"DocAtlas {__version__}")
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show informational SDK and HTTP logs (may include endpoint hostnames).",
    )
    p.set_defaults(func=cmd_tui)
    sub = p.add_subparsers(dest="cmd")

    tui = sub.add_parser("tui", help="Open the interactive document workbench (default).")
    tui.add_argument(
        "paths",
        nargs="*",
        help="Optional PDF files, folders, or HTTP(S) PDF URLs; prefix local paths with @.",
    )
    tui.add_argument(
        "--recursive", action="store_true", help="Search selected folders recursively."
    )
    tui.add_argument("--force", action="store_true", help="Rebuild cached Markdown and trees.")
    tui.add_argument(
        "-y",
        "--yes",
        dest="assume_yes",
        action="store_true",
        help="Accept the initial document selection without confirmation.",
    )
    tui.add_argument("--workspace-root", help="Override the outputs/tui cache directory.")
    tui.add_argument("--model", help="Override AZURE_OPENAI_DEPLOYMENT for this workbench.")
    tui.add_argument("--max-turns", type=int, help="Maximum tool/model turns per question.")
    tui.add_argument(
        "--max-documents",
        type=int,
        default=100,
        help="Maximum PDFs accepted from one selection (default: 100).",
    )
    tui.add_argument(
        "--show-reasoning",
        action="store_true",
        help="Show API-provided reasoning summaries.",
    )
    tui.add_argument(
        "--no-memory",
        dest="memory",
        action="store_false",
        default=True,
        help="Disable post-Note context archival.",
    )
    tui.add_argument(
        "--no-tree-annotate",
        dest="tree_annotate",
        action="store_false",
        default=True,
        help="Disable session-local tree enrichment after Note calls.",
    )
    tui.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Show informational SDK and HTTP logs (may include endpoint hostnames).",
    )

    init_session = sub.add_parser(
        "init-session",
        help="Create a session file for direct Agent Skill CLI calls.",
    )
    init_session.add_argument("--pdf", help="Optional PDF path.")
    init_session.add_argument("--markdown-dir", help="Optional per-page Markdown root.")
    init_session.add_argument("--doc-id", help="Document id under --markdown-dir.")
    init_session.add_argument("--tree-json", help="Optional PageIndex tree JSON.")
    init_session.add_argument("--question", default="", help="Question stored with the session.")
    init_session.add_argument("--sessions-root", help="Directory in which to create the session.")
    init_session.add_argument("--session-id", help="Explicit unique session directory name.")
    init_session.set_defaults(func=cmd_init_session)

    chat = sub.add_parser("chat", help="Run a question through the document agent.")
    chat.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Show informational SDK and HTTP logs (may include endpoint hostnames).",
    )
    chat.add_argument(
        "--profile",
        help="Built-in profile name or YAML path (defaults for all flags).",
    )
    chat.add_argument(
        "--skill",
        action="append",
        default=None,
        help="Skill name (looked up under docatlas/skills/) or path. Repeatable; "
        "defaults to search, read, note, and review.",
    )
    chat.add_argument(
        "--message",
        default=None,
        help="The question. When omitted, read it from the terminal or stdin.",
    )
    chat.add_argument(
        "--pdf",
        action="append",
        default=None,
        help="Path to the PDF for skills that need it (read). Repeat for "
        "multi-doc QA — when 2+ PDFs are given (or a --manifest is used) "
        "DocAtlas builds a doc_map and read/search route by `doc_id` "
        "(the PDF stem). The search tree should typically be a merged "
        "series tree (see `docatlas merge-trees` / `docatlas build-series-tree`).",
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
        help="Reasoning-summary detail requested from the API. Display it with --show-reasoning.",
    )
    chat.add_argument(
        "--show-reasoning",
        action="store_true",
        default=None,
        help="Show API-provided reasoning summaries in the terminal trace.",
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
    chat.add_argument(
        "--format",
        dest="output_format",
        choices=["text", "json"],
        default=None,
        help="Final-answer output format; JSON mode suppresses the terminal trace.",
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
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if getattr(args, "verbose", False) else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        force=True,
    )
    try:
        return args.func(args)
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    except (
        FileNotFoundError,
        json.JSONDecodeError,
        RuntimeError,
        ValueError,
        yaml.YAMLError,
    ) as exc:
        if getattr(args, "output_format", None) == "json":
            json.dump(
                {"schema_version": "1", "answer": "", "error": str(exc)},
                sys.stdout,
                ensure_ascii=False,
            )
            sys.stdout.write("\n")
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
