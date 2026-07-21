"""MMLongBench-Doc batch evaluation runner.

Drives the DocAtlas agent loop over a filtered slice of MMLongBench
samples, in parallel via a ThreadPoolExecutor, with resume support.
Each question gets its own SessionStore (own UUID directory under
`outputs/sessions/`), so per-question state never leaks between threads.

The output JSON shape is chosen so the rule-based +
optional-LLM-extraction scorer in `scoring/score_mmlongbench_hybrid.py`
consumes our results unmodified. We deliberately do **not** fill
`result["scoring"]` — the scorer overwrites it.

The agent core is `harness.agent.loop.AgentLoop`; the dispatcher and
session machinery come from the kernel. We pick which SKILLs to load via
repeated `--skill` flags (same as `python -m harness chat`).
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
import traceback
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

from harness.agent.dispatch import SkillDispatcher
from harness.agent.loop import AgentLoop
from harness.agent.post_note import PostNoteHooks
from harness.config import HarnessConfig
from harness.llm.azure_responses import AzureResponsesBackend
from harness.prompt_composer import build_tool_schemas, compose_system_prompt
from harness.session import DocEnv, SessionStore
from harness.skill_loader import load_skill

from .io import (
    filter_samples,
    find_pdf_for_doc,
    find_series_tree_for_pdfs,
    find_tree_for_doc,
    infer_dataset_name,
    load_existing_results,
    load_samples,
    load_series_trees,
    load_trees,
    make_sample_key,
    save_incremental,
)


_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_SKILLS_ROOT = _REPO_ROOT / "DocSkills"


def _resolve_skill_dir(name_or_path: str) -> Path:
    p = Path(name_or_path)
    if p.is_dir():
        return p
    cand = _DEFAULT_SKILLS_ROOT / name_or_path
    if cand.is_dir():
        return cand
    raise FileNotFoundError(
        f"Skill '{name_or_path}' not found (looked in ./{name_or_path} and {cand})"
    )


# ── trace sanitization ──────────────────────────────────────────────────────


def _sanitize_tool_call(tc) -> dict:
    """Sanitize a tool call — drop image binaries, keep
    short text. `text_output` from harness is already truncated to 2000ch
    in the loop's TurnEvent recording."""
    text = tc.text_output or ""
    if len(text) > 1000 and ("data:image" in text[:200] or "base64" in text[:200]):
        text = "[image content removed]"
    return {
        "call_id": tc.call_id,
        "name": tc.name,
        "arguments": tc.arguments,
        "result": [{"type": "text", "text": text}]
        + ([{"type": "image", "note": "[image removed]"}] * tc.image_count),
    }


def _sanitize_turns(agent_result) -> list[dict]:
    out = []
    for t in agent_result.turns:
        out.append({
            "turn_num": t.turn_num,
            "reasoning_summary": t.reasoning_summary,
            "text_output": t.text_output,
            # Field names: `tokens_input` / `tokens_output`.
            "tokens_input": t.input_tokens,
            "tokens_output": t.output_tokens,
            "reasoning_tokens": t.reasoning_tokens,
            "elapsed_s": t.elapsed_s,
            "archived_count": t.archived_count,
            "tool_calls": [_sanitize_tool_call(tc) for tc in t.tool_calls],
        })
    return out


# ── per-question executor ───────────────────────────────────────────────────


class _Runner:
    """Holds the per-batch shared bits so each question can spawn its own
    dispatcher/loop without redoing config or skill loading."""

    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.cfg = HarnessConfig.from_env()
        if args.max_turns:
            self.cfg.max_turns = args.max_turns
        if args.memory:
            self.cfg.enable_memory = True
        self.cfg.enable_tree_annotate = bool(getattr(args, "tree_annotate", True))
        if args.reasoning_effort:
            self.cfg.reasoning_effort = args.reasoning_effort
        if args.reasoning_summary:
            self.cfg.reasoning_summary = args.reasoning_summary
        if args.parallel_tool_calls:
            self.cfg.parallel_tool_calls = True

        self.skills = [load_skill(_resolve_skill_dir(n)) for n in args.skill]
        if not self.skills:
            raise SystemExit("error: --skill is required at least once")

        self.system_prompt = compose_system_prompt(self.skills, memory_enabled=self.cfg.enable_memory, tree_annotate_enabled=self.cfg.enable_tree_annotate)
        self.tool_schemas = build_tool_schemas(self.skills)

        # One backend instance per worker thread is fine — AzureOpenAI client
        # is thread-safe per OpenAI's docs.
        self.backend = AzureResponsesBackend(
            model=self.cfg.azure_deployment,
            endpoint=self.cfg.azure_endpoint,
            api_version=self.cfg.azure_api_version,
            reasoning_effort=self.cfg.reasoning_effort,
            reasoning_summary=self.cfg.reasoning_summary,
            parallel_tool_calls=self.cfg.parallel_tool_calls,
            max_output_tokens=32768,
        )

        self.aux_env: dict[str, str] = {}
        if self.cfg.aux_endpoint:
            self.aux_env["HARNESS_AUX_LLM_ENDPOINT"] = self.cfg.aux_endpoint
        if self.cfg.aux_api_version:
            self.aux_env["HARNESS_AUX_LLM_API_VERSION"] = self.cfg.aux_api_version
        if self.cfg.aux_model:
            self.aux_env["HARNESS_AUX_LLM_MODEL"] = self.cfg.aux_model
        self.aux_env["HARNESS_FIGURE_MIN_SIZE"] = str(args.figure_min_size)
        self.aux_env["HARNESS_FIGURE_MIN_BYTES"] = str(args.figure_min_bytes)

        self.sessions_root = (
            Path(args.sessions_root) if args.sessions_root else None
        )

    def _build_user_message(self, session: SessionStore, question: str) -> str:
        """Prepend a short doc-context preamble (TOC) to the question.
        TOC only, no node summaries, no page_findings."""
        from harness.session.tree import format_toc

        toc_text = format_toc(session.tree, max_lines=80)
        bits = []
        doc_map = session.doc_env.doc_map
        if isinstance(doc_map, dict) and len(doc_map) > 1:
            bits.append(f"This question spans {len(doc_map)} documents. "
                        f"When calling Read or Search, pass `doc_id` to select "
                        f"the document you want to operate on. Available doc_ids:")
            for did in doc_map:
                bits.append(f"  - {did}")
            bits.append("")
        elif session.doc_env.doc_id:
            bits.append(f"Document: {session.doc_env.doc_id}")
            bits.append("")
        bits.append("Table of contents:")
        bits.append(toc_text)
        bits.append("")
        bits.append(f"Question: {question}")
        return "\n".join(bits)

    def run_one(self, sample: dict, tree_info: dict, pdf_path: str | None,
                doc_map: dict[str, dict[str, str]] | None = None) -> dict:
        t0 = time.time()
        question = sample.get("question", "")
        doc_id = sample.get("doc_id", "")
        try:
            primary_doc_id = None
            primary_pdf = pdf_path
            primary_md = self.args.markdown_dir if self.args.use_markdown else None
            if doc_map:
                # In multi-doc mode, prefer the first entry as the "primary"
                # for any skill call that doesn't specify a doc_id.
                first_key = next(iter(doc_map))
                first = doc_map[first_key]
                primary_doc_id = first.get("doc_id") or first_key
                primary_pdf = first.get("pdf_path") or pdf_path
                primary_md = first.get("markdown_dir") or primary_md
            else:
                primary_doc_id = os.path.splitext(doc_id)[0] if doc_id else None

            doc_env = DocEnv.from_cli(
                pdf=primary_pdf,
                markdown_dir=primary_md,
                doc_id=primary_doc_id,
                tree_json_path=tree_info.get("file_path"),
                doc_map=doc_map,
            )
            session = SessionStore.new(
                doc_env, question=question, sessions_root=self.sessions_root,
            )
            dispatcher = SkillDispatcher(
                self.skills,
                session_args={
                    "pdf": doc_env.pdf_path,
                    "markdown_dir": doc_env.markdown_dir,
                    "doc_id": doc_env.doc_id,
                    "doc_map": doc_env.doc_map,
                },
                python_executable=self.cfg.skill_python,
                session_file=session.path,
                extra_env=self.aux_env,
            )
            loop = AgentLoop(
                backend=self.backend,
                dispatcher=dispatcher,
                tool_schemas=self.tool_schemas,
                system_prompt=self.system_prompt,
                max_turns=self.cfg.max_turns,
                image_detail=self.args.detail or self.cfg.image_detail,
                post_note_hooks=PostNoteHooks(
                    archive_enabled=self.cfg.enable_memory,
                    tree_annotate_enabled=self.cfg.enable_tree_annotate,
                ) if (self.cfg.enable_memory or self.cfg.enable_tree_annotate) else None,
                session_store=session,
            )

            user_message = self._build_user_message(session, question)
            agent_result = loop.run(user_message)

            try:
                session.refresh_from_disk()
            except Exception:  # noqa: BLE001
                pass

            tool_counts: dict[str, int] = defaultdict(int)
            total_calls = 0
            for t in agent_result.turns:
                for tc in t.tool_calls:
                    tool_counts[tc.name] += 1
                    total_calls += 1

            return {
                "final_answer": agent_result.answer,
                "turns": _sanitize_turns(agent_result),
                "tool_usage": {
                    "used_tools": total_calls > 0,
                    "total_calls": total_calls,
                    "counts": dict(tool_counts),
                },
                "latency_s": time.time() - t0,
                "error": agent_result.error,
                "traceback": agent_result.error,
                "note_stats": {
                    "total_entries": len(session.notes.entries),
                    "tool_calls": session.notes.tool_call_count,
                },
                "token_usage": {
                    "input": agent_result.total_input_tokens,
                    "output": agent_result.total_output_tokens,
                    "reasoning": agent_result.total_reasoning_tokens,
                },
                "session_id": session.session_id,
            }
        except Exception as exc:  # noqa: BLE001
            if self.args.verbose:
                traceback.print_exc()
            return {
                "final_answer": None,
                "turns": None,
                "tool_usage": {"used_tools": False, "total_calls": 0, "counts": {}},
                "latency_s": time.time() - t0,
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
                "note_stats": {"total_entries": 0, "tool_calls": 0},
                "token_usage": {"input": 0, "output": 0, "reasoning": 0},
            }


# ── output path / meta ──────────────────────────────────────────────────────


def _build_output_path(args: argparse.Namespace) -> Path:
    if args.output_file:
        return Path(args.output_file)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # When resuming, reuse the most recent existing output file instead
    # of creating a new one (otherwise resume loads an empty file).
    if args.resume:
        import glob as _glob
        dataset = infer_dataset_name(args.samples_file)
        pattern = str(out_dir / f"{dataset}_harness_*.json")
        existing = sorted(_glob.glob(pattern), key=os.path.getmtime, reverse=True)
        if existing:
            return Path(existing[0])

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = f"{infer_dataset_name(args.samples_file)}_harness_{ts}.json"
    return out_dir / name


def _build_meta(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "dataset_name": infer_dataset_name(args.samples_file),
        "eval_mode": "docatlas",
        "skills": list(args.skill),
        "vision": bool(args.vision),
        "vision_zoom": args.vision_zoom,
        "detail": args.detail,
        "use_markdown": bool(args.use_markdown),
        "markdown_dir": args.markdown_dir,
        "reasoning_effort": args.reasoning_effort,
        "reasoning_summary": args.reasoning_summary,
        "parallel_tool_calls": bool(args.parallel_tool_calls),
        "enable_memory": bool(args.memory),
        "enable_tree_annotate": bool(getattr(args, "tree_annotate", True)),
        "max_turns": args.max_turns,
        "n_jobs": args.n_jobs,
        "samples_file": args.samples_file,
        "results_dir": args.results_dir,
        "pdf_dir": args.pdf_dir,
        "figure_min_size": args.figure_min_size,
        "figure_min_bytes": args.figure_min_bytes,
    }


# ── the Task ────────────────────────────────────────────────────────────────


class MMLongBenchTask:
    name = "eval-mmlongbench"

    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        # Skills
        parser.add_argument(
            "--skill", action="append", required=True,
            help="Skill name (under DocSkills/) or path. Repeatable.",
        )

        # Data
        parser.add_argument("--samples-file", required=True)
        parser.add_argument("--results-dir", required=True,
                            help="Directory of PageIndex *_structure.json files.")
        parser.add_argument("--series-trees-dir", default=None,
                            help="(Optional) Directory of merged series *_structure.json "
                                 "or merged JSON files for cross-doc QA. When set, samples "
                                 "with is_cross_doc=true are routed to a series tree.")
        parser.add_argument("--pdf-dir", required=True,
                            help="Comma-separated list of PDF directories.")
        parser.add_argument("--markdown-dir", default=None,
                            help="MinerU per-page markdown root (required if --use-markdown).")

        # Output
        parser.add_argument("--output-dir", default="outputs")
        parser.add_argument("--output-file", default=None)
        parser.add_argument("--sessions-root", default=None,
                            help="Override outputs/sessions/ root (one UUID dir per question).")

        # Filtering
        parser.add_argument("--start", type=int, default=0)
        parser.add_argument("--limit", type=int, default=0)
        parser.add_argument("--doc-filter", default=None)
        parser.add_argument("--answer-format", default=None,
                            help="Comma-separated answer_format values to keep (e.g. Str,Int).")
        parser.add_argument("--evidence-source", default=None,
                            help="Comma-separated evidence_sources values to keep.")
        parser.add_argument("--resume", action="store_true")

        # Runtime knobs (forwarded to AgentLoop / backend)
        parser.add_argument("--vision", action="store_true", default=False)
        parser.add_argument("--vision-zoom", type=float, default=1.0)
        parser.add_argument("--detail", default="auto", choices=["low", "high", "auto"])
        parser.add_argument("--use-markdown", action="store_true", default=False)
        parser.add_argument("--reasoning-effort", default=None,
                            choices=["minimal", "low", "medium", "high"])
        parser.add_argument("--reasoning-summary", default=None,
                            choices=["auto", "concise", "detailed"])
        parser.add_argument("--parallel-tool-calls", action="store_true", default=False)
        parser.add_argument("--max-turns", type=int, default=20)
        parser.add_argument("--memory", action="store_true", default=False,
                            help="Enable post-Note archival of stale Read outputs.")
        parser.add_argument("--tree-annotate", dest="tree_annotate",
                            action="store_true", default=True,
                            help="Lift Note page-findings into the PageIndex tree "
                                 "for later Search (default: on).")
        parser.add_argument("--no-tree-annotate", dest="tree_annotate",
                            action="store_false",
                            help="Disable the post-Note tree-annotation hook.")
        parser.add_argument(
            "--figure-min-size", type=int, default=100,
            help="Min width/height (px) for figure catalog entries (default: 100).",
        )
        parser.add_argument(
            "--figure-min-bytes", type=int, default=2048,
            help="Min file size (bytes) for figure catalog entries (default: 2048).",
        )

        # Concurrency / verbosity
        parser.add_argument("--n-jobs", "--n_jobs", dest="n_jobs", type=int, default=1)
        parser.add_argument("--verbose", action="store_true")

    def run(self, args: argparse.Namespace) -> int:
        if args.use_markdown and not args.markdown_dir:
            print("error: --use-markdown requires --markdown-dir", file=sys.stderr)
            return 2
        if args.n_jobs < 1:
            print("error: --n-jobs must be >= 1", file=sys.stderr)
            return 2

        runner = _Runner(args)

        all_samples = load_samples(args.samples_file)
        total_available = len(all_samples)
        samples = filter_samples(
            all_samples,
            doc_filter=args.doc_filter,
            answer_format=args.answer_format,
            evidence_source=args.evidence_source,
            start=args.start,
            limit=args.limit,
        )

        trees = load_trees(args.results_dir)
        series_trees = load_series_trees(args.series_trees_dir) if args.series_trees_dir else []
        if not trees and not series_trees:
            print(f"error: no *_structure.json found in {args.results_dir}", file=sys.stderr)
            return 1

        output_path = _build_output_path(args)
        meta = _build_meta(args)

        completed_keys: dict[str, dict] = {}
        existing_by_key: dict[str, dict] = {}
        if args.resume:
            completed_keys, existing_by_key = load_existing_results(output_path)

        print("=" * 60)
        print(f"  MMLongBench-Doc · DocAtlas Evaluation")
        print("=" * 60)
        print(f"  Total samples : {total_available} → filtered: {len(samples)}")
        print(f"  Skills        : {', '.join(args.skill)}")
        print(f"  Vision        : {'on' if args.vision else 'off'} (detail={args.detail})")
        print(f"  Markdown      : {'on' if args.use_markdown else 'off'}")
        print(f"  Memory        : {'on' if args.memory else 'off'}")
        print(f"  Tree annotate : on")
        print(f"  Max turns     : {args.max_turns}")
        print(f"  Parallel jobs : {args.n_jobs}")
        print(f"  Output        : {output_path}")
        if args.resume:
            print(f"  Resumed       : completed={len(completed_keys)}, "
                  f"existing={len(existing_by_key)}")
        print("=" * 60)

        pdf_dirs = [d.strip() for d in args.pdf_dir.split(",") if d.strip()]

        results_by_key: dict[str, dict] = dict(existing_by_key)
        runnable: list[dict] = []
        skipped = 0

        for sample in samples:
            doc_id = sample.get("doc_id", "")
            question = sample.get("question", "")
            if not doc_id or not question:
                continue
            key = make_sample_key(sample)
            if args.resume and key in completed_keys:
                skipped += 1
                continue

            base_record = dict(sample)
            base_record["eval_mode"] = "docatlas"
            base_record["eval_timestamp"] = datetime.now().isoformat()

            # ── Cross-doc branch ────────────────────────────────────────
            is_cross = bool(sample.get("is_cross_doc")) or (
                isinstance(sample.get("evidence_pages_by_pdf"), dict)
                and len(sample["evidence_pages_by_pdf"]) > 1
            )
            if is_cross and series_trees:
                pdf_keys = list((sample.get("evidence_pages_by_pdf") or {}).keys())
                series_info = find_series_tree_for_pdfs(series_trees, pdf_keys)
                if not series_info:
                    base_record.update({
                        "final_answer": None, "inference": None,
                        "scoring": {"match": False, "score": 0.0,
                                    "match_type": "skipped",
                                    "details": f"Series tree not found for {pdf_keys}"},
                        "error": f"Series tree not found for {pdf_keys}",
                    })
                    results_by_key[key] = base_record
                    continue
                # Build doc_map for every PDF the question touches.
                doc_map: dict[str, dict[str, str]] = {}
                missing_pdfs: list[str] = []
                for pk in pdf_keys:
                    pk_clean = pk[:-4] if pk.lower().endswith(".pdf") else pk
                    pdf_path = find_pdf_for_doc(pk_clean, pdf_dirs) or find_pdf_for_doc(pk, pdf_dirs)
                    if not pdf_path:
                        missing_pdfs.append(pk)
                        continue
                    doc_map[pk_clean] = {
                        "pdf_path": pdf_path,
                        "markdown_dir": args.markdown_dir or "",
                        "doc_id": pk_clean,
                    }
                if missing_pdfs and args.vision:
                    base_record.update({
                        "final_answer": None, "inference": None,
                        "scoring": {"match": False, "score": 0.0,
                                    "match_type": "skipped",
                                    "details": f"PDF not found for {missing_pdfs}"},
                        "error": f"PDF not found for {missing_pdfs}",
                    })
                    results_by_key[key] = base_record
                    continue
                if not doc_map:
                    base_record.update({
                        "final_answer": None, "inference": None,
                        "scoring": {"match": False, "score": 0.0,
                                    "match_type": "skipped",
                                    "details": f"No resolvable PDFs for {pdf_keys}"},
                        "error": f"No resolvable PDFs for {pdf_keys}",
                    })
                    results_by_key[key] = base_record
                    continue
                first_key = next(iter(doc_map))
                runnable.append({
                    "sample": sample,
                    "tree_info": {
                        "file_path": series_info["file_path"],
                        "doc_name": series_info["doc_name"],
                    },
                    "pdf_path": doc_map[first_key]["pdf_path"],
                    "doc_map": doc_map,
                })
                continue

            # ── Single-doc branch (unchanged) ───────────────────────────
            tree_key = find_tree_for_doc(trees, doc_id)
            if not tree_key:
                base_record.update({
                    "final_answer": None,
                    "inference": None,
                    "scoring": {
                        "match": False, "score": 0.0,
                        "match_type": "skipped",
                        "details": f"Tree not found for {doc_id}",
                    },
                    "error": f"Tree structure not found for {doc_id}",
                })
                results_by_key[key] = base_record
                continue

            doc_name = trees[tree_key]["doc_name"]
            pdf_path = find_pdf_for_doc(doc_name, pdf_dirs) or find_pdf_for_doc(doc_id, pdf_dirs)
            if not pdf_path and args.vision:
                base_record.update({
                    "final_answer": None,
                    "inference": None,
                    "scoring": {
                        "match": False, "score": 0.0,
                        "match_type": "skipped",
                        "details": f"PDF not found for {doc_id}",
                    },
                    "error": f"PDF not found for {doc_id}",
                })
                results_by_key[key] = base_record
                continue

            runnable.append({
                "sample": sample,
                "tree_info": trees[tree_key],
                "pdf_path": pdf_path,
                "doc_map": None,
            })

        if results_by_key:
            save_incremental(list(results_by_key.values()), output_path, meta=meta)
        if skipped:
            print(f"  Resumed: skipped {skipped} already-completed samples")

        lock = threading.Lock()

        def _process(item: dict) -> dict:
            sample = item["sample"]
            inference = runner.run_one(
                sample, item["tree_info"], item["pdf_path"],
                doc_map=item.get("doc_map"),
            )

            record = dict(sample)
            record["eval_mode"] = "docatlas"
            record["eval_timestamp"] = datetime.now().isoformat()
            record["final_answer"] = inference.get("final_answer")
            record["inference"] = {k: v for k, v in inference.items() if k != "final_answer"}
            record["tool_usage"] = inference.get("tool_usage", {})
            if inference.get("error"):
                record["error"] = inference["error"]
            return record

        _unsaved_count = 0
        _SAVE_EVERY = 1  # save every completion

        def _record_done(record: dict) -> None:
            nonlocal _unsaved_count
            with lock:
                results_by_key[make_sample_key(record)] = record
                _unsaved_count += 1
                if _unsaved_count >= _SAVE_EVERY:
                    try:
                        save_incremental(list(results_by_key.values()), output_path, meta=meta)
                    except Exception as exc:  # noqa: BLE001
                        print(f"  [warn] save_incremental failed: {exc}", flush=True)
                    _unsaved_count = 0

        if args.n_jobs <= 1:
            for i, item in enumerate(runnable, 1):
                rec = _process(item)
                _record_done(rec)
                print(f"  [{i}/{len(runnable)}] {make_sample_key(rec)[:80]}  "
                      f"{'OK' if not rec.get('error') else 'ERR: ' + str(rec['error'])[:80]}")
        else:
            with ThreadPoolExecutor(max_workers=args.n_jobs) as pool:
                futures = {pool.submit(_process, item): item for item in runnable}
                completed = 0
                for fut in as_completed(futures):
                    completed += 1
                    try:
                        rec = fut.result()
                    except Exception as exc:  # noqa: BLE001
                        item = futures[fut]
                        rec = dict(item["sample"])
                        rec.update({
                            "eval_mode": "docatlas",
                            "final_answer": None,
                            "inference": None,
                            "tool_usage": {"used_tools": False, "total_calls": 0, "counts": {}},
                            "scoring": {
                                "match": False, "score": 0.0,
                                "match_type": "error",
                                "details": str(exc),
                            },
                            "error": f"{type(exc).__name__}: {exc}",
                        })
                    _record_done(rec)
                    status = "OK" if not rec.get("error") else "ERR"
                    print(f"  [{completed}/{len(runnable)}] {make_sample_key(rec)[:80]}  {status}", flush=True)

        # Final save (catch any unsaved results)
        save_incremental(list(results_by_key.values()), output_path, meta=meta)

        print()
        print(f"📄 Results: {output_path}")
        print(f"   Total records: {len(results_by_key)}")
        print()
        print("Next: score with")
        print(f"  python scoring/score_mmlongbench_hybrid.py -i {output_path} --skip-extract")
        return 0


__all__ = ["MMLongBenchTask"]
