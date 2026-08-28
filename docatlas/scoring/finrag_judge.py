"""LLM-as-judge with the FinRAG-style prompt.

Independent of docatlas/scoring/score_mmlongbench_hybrid.py. Reads a runner output
JSON ({"meta":..., "results":[...]}), asks an LLM to judge each
(question, ground_truth, prediction) triplet using the user-provided
prompt, and writes:
  <output>.json  — per-sample {score, reasoning, parse_error?}
  <output>.txt   — aggregate report (overall + slices)

Usage:
  python finrag_judge.py -i path/to/samples.json -o path/to/report --model gpt-4o --n-jobs 10
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib import import_module
from pathlib import Path
from typing import Any

from tqdm import tqdm

_io_utils = import_module(f"{__package__}.io_utils" if __package__ else "io_utils")
atomic_write_json = _io_utils.atomic_write_json
atomic_write_text = _io_utils.atomic_write_text

JUDGE_PROMPT = """### ROLE
You are an expert evaluator. Your task is to determine if a model's
generated answer is correct by comparing it to a ground truth value.
### TASK
You will be given a question, the prediction which includes reasoning steps
and a final answer, and a ground_truth which is the correct answer. You
must determine if the final conclusion of the prediction matches the
ground_truth.
### INSTRUCTIONS
1. **Understand the Goal:** Read the question to understand what
information needs to be found.
2. **Extract the Final Answer:** Carefully analyze the prediction. Ignore
the reasoning steps and identify only the final, conclusive answer
provided by the model. The answer is often at the end of the text and
might be bolded.
3. **Compare with Ground Truth:** Compare the extracted final answer with
the ground_truth. Be flexible with formatting-for example, a model
answer of "45 percent" should be considered a match for a ground truth
of "45".
4. **Generate Analysis:** Write a brief analysis of your finding.
### INPUTS
You will receive the data like this:
Question: [The user's question]
Ground Truth: [The expected answer]
Prediction: [The model's actual answer]
## OUTPUT FORMAT:
Your response MUST be a JSON object with two keys:
1. score: A float, either 1.0 for a correct prediction or 0.0 for an
incorrect one.
2. reasoning: A brief, one-sentence explanation for your decision."""


def _is_azure(model: str) -> bool:
    return model.startswith(("gpt-5", "gpt-4", "o1", "o3", "o4"))


def make_client(model: str):
    from openai import AzureOpenAI, OpenAI

    if _is_azure(model):
        endpoint = os.environ["AZURE_OPENAI_ENDPOINT"]
        api_version = os.environ.get(
            "AZURE_OPENAI_API_VERSION",
            os.environ.get("AZURE_API_VERSION", "2025-04-01-preview"),
        )
        key = os.environ.get("AZURE_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
        if key:
            return AzureOpenAI(azure_endpoint=endpoint, api_key=key, api_version=api_version)
        from azure.identity import AzureCliCredential, get_bearer_token_provider

        token_provider = get_bearer_token_provider(
            AzureCliCredential(), "https://cognitiveservices.azure.com/.default"
        )
        return AzureOpenAI(
            azure_endpoint=endpoint,
            azure_ad_token_provider=token_provider,
            api_version=api_version,
        )
    return OpenAI()


def _parse_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    # Strip code fences
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        text = text.strip()
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            candidate, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            return candidate
    return None


def judge_one(
    client, model: str, question: str, gt: str, pred: str, max_retries: int = 2
) -> dict[str, Any]:
    user_msg = f"{JUDGE_PROMPT}\n\nQuestion: {question}\nGround Truth: {gt}\nPrediction: {pred}\n"
    last_err = ""
    for attempt in range(max_retries + 1):
        try:
            kwargs: dict[str, Any] = dict(
                model=model,
                messages=[{"role": "user", "content": user_msg}],
            )
            if _is_azure(model):
                kwargs["max_completion_tokens"] = 512
            else:
                kwargs["max_tokens"] = 512
                kwargs["temperature"] = 0.0
            resp = client.chat.completions.create(**kwargs)
            text = (resp.choices[0].message.content or "").strip()
            obj = _parse_json(text)
            if obj is None:
                last_err = f"parse_error: {text[:200]}"
                continue
            raw = obj.get("score", 0)
            try:
                s = float(raw)
            except Exception:
                s = 0.0
            if s not in (0.0, 1.0):
                s = 1.0 if s >= 0.5 else 0.0
            return {
                "score": s,
                "reasoning": obj.get("reasoning", ""),
                "raw": text,
                "parse_error": False,
            }
        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            time.sleep(1.0 * (attempt + 1))
    return {"score": 0.0, "reasoning": last_err, "raw": "", "parse_error": True}


def aggregate_report(
    records: list[dict], n_total: int, n_errors_excluded: int, out_path: Path
) -> str:
    scored = [r for r in records if "score" in r]
    if not scored:
        return "No scored records."

    def acc(rs):
        return sum(r["score"] for r in rs) / len(rs) if rs else 0.0

    lines: list[str] = []
    lines.append("=" * 60)
    lines.append("  LLM-as-Judge Evaluation Report (FinRAG-style prompt)")
    lines.append("=" * 60)
    lines.append(
        f"Total samples  : {n_total}  |  Scored: {len(scored)}  "
        f"|  Errors excluded: {n_errors_excluded}"
    )
    lines.append(f"Scored-only Accuracy : {acc(scored):.4f}  |  N={len(scored)}")
    end_to_end = sum(r["score"] for r in scored) / n_total if n_total else 0.0
    lines.append(f"End-to-end Accuracy  : {end_to_end:.4f}  |  N={n_total} (excluded=0)")
    parse_err = sum(1 for r in scored if r.get("parse_error"))
    if parse_err:
        lines.append(f"Parse errors (counted as 0): {parse_err}")
    lines.append("-" * 60)

    def slice_by(field):
        groups: dict[str, list] = {}
        for r in scored:
            v = r.get(field)
            if v is None:
                continue
            groups.setdefault(str(v), []).append(r)
        return groups

    for label, field in [
        ("Evidence-page bucket", "_eviplace"),
        ("Evidence Source", "evidence_sources"),
        ("Doc Type", "doc_type"),
        ("Answer Format", "answer_format"),
    ]:
        g = slice_by(field)
        if not g:
            continue
        for k in sorted(g):
            lines.append(f"{label}: {k:<35} | Acc: {acc(g[k]):.4f} | N={len(g[k])}")
        lines.append("-" * 60)

    atomic_write_text(out_path, "\n".join(lines))
    return "\n".join(lines)


def _eviplace(rec: dict) -> str | None:
    """Tag like single-page / cross-page / unanswerable."""
    pages_raw = rec.get("evidence_pages")
    if pages_raw in (None, "", "[]", "['']", "[None]"):
        return "Unanswerable"
    try:
        pages = ast.literal_eval(pages_raw) if isinstance(pages_raw, str) else pages_raw
    except (SyntaxError, ValueError):
        return None
    if not pages:
        return "Unanswerable"
    if not isinstance(pages, (list, tuple, set)):
        return None
    if len(pages) == 1:
        return "Single-page"
    return "Cross-page"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-i", "--input", required=True)
    ap.add_argument("-o", "--output", required=True, help="Path prefix; .json + .txt are written.")
    ap.add_argument(
        "--model",
        required=True,
        help="LLM model / Azure deployment name (Azure auto-detected for gpt-*/o1/o3/o4).",
    )
    ap.add_argument("--n-jobs", type=int, default=10)
    args = ap.parse_args()
    if args.n_jobs < 1:
        ap.error("--n-jobs must be at least 1")

    raw = json.loads(Path(args.input).read_text())
    if isinstance(raw, dict) and "results" in raw:
        records = raw["results"]
    else:
        records = raw
    if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
        raise ValueError("input must be a list of record objects or an object with a results list")
    n_total = len(records)
    print(f"Loaded {n_total} records from {args.input}")

    work = []
    for i, r in enumerate(records):
        gt = r.get("answer", "")
        pred = r.get("final_answer", "")
        q = r.get("question", "")
        if (r.get("inference") or {}).get("error"):
            r["_excluded"] = True
            continue
        if not pred:
            r["_excluded"] = True
            continue
        r["_eviplace"] = _eviplace(r)
        work.append((i, q, gt, pred))

    n_excluded = n_total - len(work)
    print(f"Will judge {len(work)}; excluded {n_excluded} (no prediction or runtime error)")

    client = make_client(args.model)

    out_json_path = Path(args.output + ".json")
    out_txt_path = Path(args.output + ".txt")
    out_json_path.parent.mkdir(parents=True, exist_ok=True)

    def task(item):
        i, q, gt, pred = item
        res = judge_one(client, args.model, q, str(gt), str(pred))
        return i, res

    with ThreadPoolExecutor(max_workers=args.n_jobs) as ex:
        futs = [ex.submit(task, w) for w in work]
        for fut in tqdm(as_completed(futs), total=len(futs), desc=f"Judging (j={args.n_jobs})"):
            i, res = fut.result()
            records[i].update(res)

    # Persist per-sample
    atomic_write_json(out_json_path, records)

    # Aggregate
    report = aggregate_report(records, n_total, n_excluded, out_txt_path)
    print(report)
    print(f"\nWrote: {out_json_path}")
    print(f"Wrote: {out_txt_path}")


if __name__ == "__main__":
    main()
