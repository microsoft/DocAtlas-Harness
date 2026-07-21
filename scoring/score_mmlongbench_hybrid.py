#!/usr/bin/env python3
"""
Unified scorer for MMLongBench Hybrid outputs.

Modes:
  1) Rule-based scoring with optional LLM extraction (same as score_mmlongbench.py)
  2) LLM-as-judge scoring (same idea as evaluate_mmlongbench_llm.py)

Defaults are set for hybrid outputs in this workspace.

# Rule-based scoring + LLM extraction (default)
python score_mmlongbench_hybrid.py -i outputs/mmlongbench_hybrid.json --add-notanswerable --n-jobs 8

# Rule-based scoring, no extraction
python score_mmlongbench_hybrid.py -i outputs/mmlongbench_hybrid.json --skip-extract

# LLM-as-judge
python score_mmlongbench_hybrid.py -i outputs/mmlongbench_hybrid.json --judge --add-notanswerable --n-jobs 8

"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import isclose
from pathlib import Path
from typing import Any

from tqdm import tqdm

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
AZURE_API_VERSION = os.environ.get("AZURE_API_VERSION", "2025-04-01-preview")
from extract_prompts import EXTRACT_SYSTEM_PROMPT, EXTRACT_QUERY_TEMPLATE, EXTRACT_FEW_SHOTS


# Credentials are read from environment variables (see README / .env).

# ------------------------------
# 1) LLM extraction (optional)
# ------------------------------


def _is_azure_model(name: str) -> bool:
    m = (name or "").strip().lower()
    return m.startswith(("gpt", "o1", "o3", "computer-use"))


def create_llm_client(
    api_key: str,
    base_url: str,
    model: str = "",
    azure_endpoint: str | None = None,
    azure_api_version: str = AZURE_API_VERSION,
):
    """Create OpenAI or AzureOpenAI client with auto-detection."""
    from openai import AzureOpenAI, OpenAI

    # Auto-detect Azure from model name + env vars
    if _is_azure_model(model):
        endpoint = azure_endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT")
        if endpoint:
            # For Azure, only use Azure-specific keys (not CHATGPT_API_KEY,
            # which targets an OpenAI-compatible endpoint)
            azure_key = (
                os.environ.get("AZURE_OPENAI_API_KEY")
                or os.environ.get("OPENAI_API_KEY")
            )
            version = azure_api_version or AZURE_API_VERSION
            if azure_key:
                return AzureOpenAI(
                    azure_endpoint=endpoint,
                    api_key=azure_key,
                    api_version=version,
                )
            # Fallback: try Azure AD token via az CLI
            try:
                import subprocess
                token = subprocess.check_output(
                    ["az", "account", "get-access-token",
                     "--resource", "https://cognitiveservices.azure.com/",
                     "--query", "accessToken", "-o", "tsv"],
                    text=True, stderr=subprocess.DEVNULL,
                ).strip()
                if token:
                    return OpenAI(
                        base_url=f"{endpoint.rstrip('/')}/openai/v1",
                        api_key=token,
                    )
            except Exception:
                pass

    return OpenAI(api_key=api_key, base_url=base_url)


def extract_answer_llm(
    client,
    model: str,
    question: str,
    analysis: str,
    *,
    answer_type: str = "Str",
    extra_body: dict | None = None,
) -> str:
    if not analysis or analysis.strip() == "":
        return "Fail to answer"

    user_msg = EXTRACT_QUERY_TEMPLATE.format(
        question=question, answer_type=answer_type, analysis=analysis,
    )
    messages: list[dict] = (
        [{"role": "system", "content": EXTRACT_SYSTEM_PROMPT}]
        + EXTRACT_FEW_SHOTS
        + [{"role": "user", "content": user_msg}]
    )
    kwargs: dict[str, Any] = dict(
        model=model,
        messages=messages,
    )
    if not _is_azure_model(model):
        kwargs["temperature"] = 0.01
    if extra_body:
        kwargs["extra_body"] = extra_body

    completion = client.chat.completions.create(**kwargs)
    raw = completion.choices[0].message.content or ""

    pattern = r"Extracted answer:\s*(.*?)(?=\s*Answer format:|$)"
    match = re.search(pattern, raw, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else raw.strip()


# ------------------------------
# 2) Rule-based scoring
# ------------------------------

def levenshtein_distance(s1: str, s2: str) -> int:
    if len(s1) > len(s2):
        s1, s2 = s2, s1
    distances = list(range(len(s1) + 1))
    for i2, c2 in enumerate(s2):
        new_distances = [i2 + 1]
        for i1, c1 in enumerate(s1):
            if c1 == c2:
                new_distances.append(distances[i1])
            else:
                new_distances.append(1 + min(distances[i1], distances[i1 + 1], new_distances[-1]))
        distances = new_distances
    return distances[-1]


def anls_compute(groundtruth: str, prediction: str, threshold: float = 0.5) -> float:
    dist = levenshtein_distance(groundtruth, prediction)
    length = max(len(groundtruth), len(prediction))
    if length == 0:
        return 0.0
    value = float(dist) / float(length)
    anls = 1.0 - value
    return anls if anls > threshold else 0.0


def is_float_equal(
    reference: float,
    prediction: float,
    include_percentage: bool = False,
    is_close: bool = False,
) -> bool:
    def _precision(v: float) -> int:
        s = str(v)
        return len(s.split(".")[-1]) if "." in s else 3

    try:
        reference = float(str(reference).strip().rstrip("%").strip())
        prediction = float(str(prediction).strip().rstrip("%").strip())
    except (ValueError, TypeError):
        return False

    candidates = [reference / 100, reference, reference * 100] if include_percentage else [reference]
    for cand in candidates:
        try:
            if is_close and isclose(cand, prediction, rel_tol=0.01):
                return True
            prec = max(min(_precision(prediction), _precision(cand)), 2)
            if round(prediction, prec) == round(cand, prec):
                return True
        except Exception:
            continue
    return False


def _normalize_dashes(s: str) -> str:
    return re.sub(r"[\u2013\u2014\u2212\u2012\u2015]", "-", s)


def get_clean_string(s: str) -> str:
    s = str(s).lower().strip()
    s = _normalize_dashes(s)
    for suffix in ("miles", "mile", "million"):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
    s = re.sub(r"\s*\([^)]*\)", "", s).strip()
    s = re.sub(r"^['\"]|['\"]$", "", s).strip()
    s = s.lstrip("$").strip().rstrip("%").strip()
    return s


def _is_exact_match_type(s: str) -> bool:
    if "https://" in s:
        return True
    if s.endswith((".py", "ipynb")):
        return True
    if s.startswith("page"):
        return True
    if re.fullmatch(r"\b\d+(-\d+|\s\d+)?\b", s):
        return True
    if "a.m." in s or "p.m." in s:
        return True
    if re.fullmatch(r"\b\d{4}[-\s]\d{2}[-\s]\d{2}\b", s):
        return True
    if re.fullmatch(r"\b\d{4}[-\s]\d{2}\b", s):
        return True
    if re.fullmatch(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", s):
        return True
    return False


def _isfloat(s: str) -> bool:
    try:
        float(s)
        return True
    except (ValueError, TypeError):
        return False


_NOT_ANSWERABLE_SYNONYMS = {
    "not answerable", "none", "n/a", "not applicable",
    "unanswerable", "cannot be answered", "not available",
    "cannot determine", "can not determine", "unable to determine",
    "insufficient information", "insufficient info",
    "not enough information", "not enough info",
    "not mentioned", "not specified", "not provided",
    "unknown", "unclear", "cannot tell", "can not tell",
    "fail to answer",
}


def _normalize_unanswerable(s: str) -> str:
    normalized = re.sub(r"\s+", " ", str(s).lower().strip())
    if normalized in _NOT_ANSWERABLE_SYNONYMS:
        return "Not answerable"

    broad_patterns = [
        r"\bnot answerable\b",
        r"\bunanswerable\b",
        r"\bcannot be answered\b",
        r"\b(can(?:not|'t)|unable to) determine\b",
        r"\b(can(?:not|'t)|unable to) tell\b",
        r"\binsufficient (information|info|evidence|context)\b",
        r"\bnot enough (information|info|evidence|context)\b",
        r"\bnot (mentioned|specified|provided|available)\b",
        r"\bunclear from the (document|documents|context|image|images)\b",
        r"\bunknown\b",
    ]
    if any(re.search(pattern, normalized) for pattern in broad_patterns):
        return "Not answerable"
    return s


_ANSWER_TYPE_MAP = {
    "Integer": "Int",
    "String": "Str",
    "Float": "Float",
    "List": "List",
    "None": "None",
}


def _normalize_answer_type(raw: str) -> str:
    """Map LongDocURL-style answer formats (Integer/String) to canonical (Int/Str)."""
    return _ANSWER_TYPE_MAP.get(raw, raw)


def eval_score(gt: Any, pred: Any, answer_type: str) -> float:
    gt = _normalize_unanswerable(str(gt))
    pred = _normalize_unanswerable(str(pred))

    if gt == "Not answerable" and pred == "Not answerable":
        return 1.0

    if answer_type == "Int":
        try:
            gt_int = int(gt)
            pred_int = int(float(pred))
        except (ValueError, TypeError):
            return 0.0
        return float(gt_int == pred_int)

    if answer_type == "Float":
        try:
            gt_f = float(get_clean_string(str(gt)))
            pred_f = float(get_clean_string(str(pred)))
        except (ValueError, TypeError):
            return 0.0
        return float(is_float_equal(gt_f, pred_f, include_percentage=True, is_close=True))

    if answer_type in ("Str", "None"):
        gt_s = get_clean_string(gt)
        pred_s = get_clean_string(pred)
        if _is_exact_match_type(gt_s):
            return float(gt_s == pred_s)
        return anls_compute(gt_s, pred_s)

    # List type
    if isinstance(gt, str) and gt.startswith("["):
        gt = eval(gt)  # noqa: S307
    if not isinstance(gt, list):
        gt = [gt]
    if isinstance(pred, str) and pred.startswith("["):
        try:
            pred = eval(pred)  # noqa: S307
        except Exception:
            pred = [pred]
    if not isinstance(pred, list):
        pred = [pred]

    if len(gt) != len(pred):
        return 0.0

    gt_clean = sorted(get_clean_string(a) for a in gt)
    pred_clean = sorted(get_clean_string(a) for a in pred)

    if _isfloat(gt_clean[0]) or _is_exact_match_type(gt_clean[0]):
        return float("-".join(gt_clean) == "-".join(pred_clean))
    return float(min(anls_compute(g, p) for g, p in zip(gt_clean, pred_clean)))


# ------------------------------
# 3) LLM judge scoring
# ------------------------------

def _extract_json_object(text: str) -> dict[str, Any] | None:
    try:
        return json.loads(text)
    except Exception:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            return None
    return None


def evaluate_response(
    client,
    model: str,
    predicted_answer: str,
    ground_truth: str,
    question: str,
    answer_type: str,
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    prompt = f"""You are an expert evaluator for document understanding tasks.

Question: {question}
Expected Answer Format: {answer_type}
Ground Truth Answer: {ground_truth}
Model's Prediction: {predicted_answer}

Evaluate whether the model's prediction correctly answers the question compared to the ground truth.

Rules:
- For Int format: The predicted integer should match the ground truth exactly. Minor formatting differences (e.g., \"5\" vs \"five\") are acceptable if the value is the same.
- For Float format: The predicted number should be approximately equal to the ground truth (within 1% relative tolerance). Percentage format differences are acceptable (e.g., \"0.05\" vs \"5%\", \"21.3%\" vs \"21.3\").
- For Str format: The prediction should convey the same meaning as the ground truth. Minor wording differences, synonyms, or extra articles (\"the\", \"a\") are acceptable. The core answer must match.
- For List format: All items in the ground truth list should be present in the prediction (order does not matter). Each item is compared by meaning, not exact string match.
- For None / unanswerable cases: be lenient. If the ground truth is \"Not answerable\", accept any prediction that clearly means the answer is unavailable from the provided document/context, including phrasing like \"cannot determine\", \"not mentioned\", \"insufficient information\", \"unknown\", \"unclear from the document\", or similar abstentions.
- Do not require the prediction to literally say \"Not answerable\".
- If the prediction says the content is unreadable, missing, illegible, or the needed evidence cannot be found, treat that as correct for an unanswerable ground truth unless it also gives a specific concrete answer.
- If the prediction gives a concrete answer, specific entity, number, or list instead of abstaining, score 0.
- The model's prediction may contain extra text or reasoning. Focus on the final answer.
- If the prediction conveys the same correct answer as the ground truth, score 1.
- If the prediction is wrong, incomplete, or irrelevant, score 0.

Return ONLY a JSON object parseable by json.loads: {{\"binary_correctness\": 1}} or {{\"binary_correctness\": 0}}"""

    try:
        kwargs: dict[str, Any] = dict(
            model=model,
            messages=[{"role": "user", "content": prompt}],
        )
        if _is_azure_model(model):
            kwargs["max_completion_tokens"] = max_tokens
        else:
            kwargs["max_tokens"] = max_tokens
            kwargs["temperature"] = temperature
            kwargs["extra_body"] = {"enable_thinking": False}
        response = client.chat.completions.create(**kwargs)
        text = (response.choices[0].message.content or "").strip()
        obj = _extract_json_object(text)
        if obj is None:
            return {"score": -1.0, "explanation": text, "parse_error": True}

        raw_score = obj.get("binary_correctness", 0)
        try:
            score = float(raw_score)
        except Exception:
            score = 0.0

        if score not in (0.0, 1.0):
            score = 1.0 if score >= 0.5 else 0.0

        return {"score": score, "explanation": text, "parse_error": False}
    except Exception as exc:
        return {
            "score": 0.0,
            "explanation": f"Evaluation error: {type(exc).__name__}: {exc}",
            "parse_error": False,
        }


# ------------------------------
# 4) Reporting
# ------------------------------

def compute_acc_f1(samples: list[dict]) -> tuple[float, float]:
    scored = [s for s in samples if "score" in s]
    if not scored:
        return 0.0, 0.0

    acc = sum(s["score"] for s in scored) / len(scored)
    try:
        answerable = [s for s in scored if s["answer"] != "Not answerable"]
        pred_answerable = [s for s in scored if s["pred"] != "Not answerable"]
        recall = sum(s["score"] for s in answerable) / len(answerable) if answerable else 0.0
        precision = sum(s["score"] for s in answerable) / len(pred_answerable) if pred_answerable else 0.0
        f1 = 2 * recall * precision / (recall + precision) if (recall + precision) > 0 else 0.0
    except ZeroDivisionError:
        f1 = 0.0
    return acc, f1


def _safe_eval_list(s: Any) -> list:
    if isinstance(s, list):
        return s
    if isinstance(s, str):
        try:
            return eval(s)  # noqa: S307
        except Exception:
            return [s]
    return [s] if s else []


def generate_report(samples: list[dict], output_path: str | None = None) -> str:
    for sample in samples:
        sample["evidence_pages"] = _safe_eval_list(sample.get("evidence_pages", []))
        sample["evidence_sources"] = _safe_eval_list(sample.get("evidence_sources", []))

    all_samples = samples
    error_samples = [s for s in all_samples if s.get("error")]
    samples = [s for s in all_samples if not s.get("error")]

    lines: list[str] = []

    acc, f1 = compute_acc_f1(samples)
    lines.append(f"{'=' * 60}")
    lines.append("  MMLongBench-Doc Evaluation Report")
    lines.append(f"{'=' * 60}")
    lines.append(f"Total samples  : {len(all_samples)}  |  "
                 f"Scored: {len(samples)}  |  Errors excluded: {len(error_samples)}")
    lines.append(f"Overall Accuracy : {acc:.4f}  |  Scored questions: {len(samples)}")
    lines.append(f"Overall F1-score : {f1:.4f}  |  Scored questions: {len(samples)}")
    lines.append(f"{'-' * 60}")

    single_page = [s for s in samples if len(s["evidence_pages"]) == 1]
    cross_page = [s for s in samples if len(s["evidence_pages"]) != 1 and s["answer"] != "Not answerable"]
    unanswerable = [s for s in samples if s["answer"] == "Not answerable"]

    acc_sp, _ = compute_acc_f1(single_page)
    acc_cp, _ = compute_acc_f1(cross_page)
    acc_na, _ = compute_acc_f1(unanswerable)

    lines.append(f"Single-page    | Acc: {acc_sp:.4f}  |  N={len(single_page)}")
    lines.append(f"Cross-page     | Acc: {acc_cp:.4f}  |  N={len(cross_page)}")
    lines.append(f"Unanswerable   | Acc: {acc_na:.4f}  |  N={len(unanswerable)}")
    lines.append(f"{'-' * 60}")

    source_dict: dict[str, list[dict]] = defaultdict(list)
    for s in samples:
        for src in s["evidence_sources"]:
            source_dict[src].append(s)
    for src_name in sorted(source_dict):
        sub = source_dict[src_name]
        a, _ = compute_acc_f1(sub)
        lines.append(f"Evidence Source: {src_name:<20} | Acc: {a:.4f}  |  N={len(sub)}")
    lines.append(f"{'-' * 60}")

    dtype_dict: dict[str, list[dict]] = defaultdict(list)
    for s in samples:
        dtype_dict[s.get("doc_type", "Unknown")].append(s)
    for dt in sorted(dtype_dict):
        sub = dtype_dict[dt]
        a, _ = compute_acc_f1(sub)
        lines.append(f"Doc Type: {dt:<35} | Acc: {a:.4f}  |  N={len(sub)}")
    lines.append(f"{'-' * 60}")

    fmt_dict: dict[str, list[dict]] = defaultdict(list)
    for s in samples:
        fmt_dict[s.get("answer_type", "Unknown")].append(s)
    for fmt in sorted(fmt_dict):
        sub = fmt_dict[fmt]
        a, _ = compute_acc_f1(sub)
        lines.append(f"Answer Format: {fmt:<20} | Acc: {a:.4f}  |  N={len(sub)}")
    lines.append(f"{'-' * 60}")

    has_tool = [s for s in samples if s.get("tool_usage")]
    if has_tool:
        lines.append("")
        lines.append(f"{'-' * 60}")
        lines.append("  Tool Usage Statistics")
        lines.append(f"{'-' * 60}")

        used_tools = [s for s in has_tool if s["tool_usage"].get("used_tools")]
        no_tools = [s for s in has_tool if not s["tool_usage"].get("used_tools")]

        acc_used, _ = compute_acc_f1(used_tools)
        acc_none, _ = compute_acc_f1(no_tools)

        lines.append(f"Used tools     | Acc: {acc_used:.4f}  |  N={len(used_tools)}")
        lines.append(f"No tools       | Acc: {acc_none:.4f}  |  N={len(no_tools)}")

        total_calls = [s["tool_usage"].get("total_calls", 0) for s in used_tools]
        if total_calls:
            avg_calls = sum(total_calls) / len(total_calls)
            lines.append(f"Avg tool calls : {avg_calls:.1f}  |  "
                         f"Min={min(total_calls)}  Max={max(total_calls)}")

        tool_counter: dict[str, int] = defaultdict(int)
        for s in has_tool:
            counts = s["tool_usage"].get("counts", {})
            for tool_name, count in counts.items():
                tool_counter[tool_name] += count
        if tool_counter:
            lines.append("Tool call totals:")
            for tn in sorted(tool_counter, key=tool_counter.get, reverse=True):
                lines.append(f"  {tn:<25} : {tool_counter[tn]}")

        lines.append(f"{'-' * 60}")

    if error_samples:
        lines.append("")
        lines.append(f"Errors (excluded): {len(error_samples)} / {len(all_samples)}  "
                     f"({100 * len(error_samples) / len(all_samples):.1f}%)")
        err_types: dict[str, int] = defaultdict(int)
        for s in error_samples:
            err_str = str(s["error"])
            err_type = err_str.split(":")[0].strip() if ":" in err_str else err_str[:50]
            err_types[err_type] += 1
        for et in sorted(err_types, key=err_types.get, reverse=True):
            lines.append(f"  {et:<40} : {err_types[et]}")
        lines.append(f"{'-' * 60}")

    doc_dict: dict[str, list[dict]] = defaultdict(list)
    for s in samples:
        doc_dict[s.get("doc_id", "Unknown")].append(s)
    if len(doc_dict) > 1:
        lines.append("")
        lines.append(f"{'-' * 60}")
        lines.append("  Per-Document Accuracy (top 10 worst)")
        lines.append(f"{'-' * 60}")
        doc_accs = []
        for did in doc_dict:
            sub = doc_dict[did]
            a, _ = compute_acc_f1(sub)
            doc_accs.append((did, a, len(sub)))
        doc_accs.sort(key=lambda x: x[1])
        for did, a, n in doc_accs[:10]:
            lines.append(f"  {did[:45]:<45} | Acc: {a:.4f}  |  N={n}")
        lines.append(f"{'-' * 60}")

    lines.append(f"{'=' * 60}")

    report = "\n".join(lines)

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"Report saved to: {output_path}")

    return report


# ------------------------------
# 5) Data loading
# ------------------------------

def load_input(path: str) -> list[dict]:
    path = Path(path)
    records: list[dict] = []

    if path.suffix == ".json":
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        raw_list = data.get("results", data) if isinstance(data, dict) else data
        for r in raw_list:
            records.append({
                "doc_id": r.get("doc_id", ""),
                "question": r.get("question", ""),
                "pred_raw": r.get("final_answer") or r.get("predicted_answer") or "",
                "answer": r.get("answer", r.get("ground_truth_answer", "")),
                "answer_type": _normalize_answer_type(r.get("answer_format", "Str")),
                "evidence_pages": r.get("evidence_pages", "[]"),
                "evidence_sources": r.get("evidence_sources", "[]"),
                "doc_type": r.get("doc_type", "Unknown"),
                "error": r.get("error"),
                "tool_usage": r.get("tool_usage") or (r.get("inference") or {}).get("tool_usage"),
            })

    elif path.suffix == ".jsonl":
        with open(path, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                records.append({
                    "doc_id": r.get("path", r.get("doc_id", "")),
                    "question": r.get("question", ""),
                    "pred_raw": r.get("predicted_answer", r.get("final_answer", "")),
                    "answer": r.get("ground_truth_answer", r.get("answer", "")),
                    "answer_type": _normalize_answer_type(r.get("answer_format", "Str")),
                    "evidence_pages": r.get("evidence_pages", "[]"),
                    "evidence_sources": r.get("evidence_sources", "[]"),
                    "doc_type": r.get("doc_type", "Report"),
                    "error": r.get("error"),
                    "tool_usage": r.get("tool_usage"),
                })
    else:
        raise ValueError(f"Unsupported file format: {path.suffix}  (expected .json or .jsonl)")

    print(f"Loaded {len(records)} samples from {path.name}")
    return records


# ------------------------------
# 6) Pipeline steps
# ------------------------------

def run_extraction(records: list[dict], *, model: str, api_key: str, base_url: str,
                   cache_path: str | None = None, extra_body: dict | None = None,
                   n_jobs: int = 1,
                   azure_endpoint: str | None = None,
                   azure_api_version: str = AZURE_API_VERSION) -> list[dict]:
    done: dict[tuple[str, str], str] = {}
    skipped_fail = 0
    if cache_path and os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                pred_val = obj.get("pred", "")
                if pred_val.strip().lower() == "fail to answer":
                    skipped_fail += 1
                    continue
                done[(obj["doc_id"], obj["question"])] = pred_val
        msg = f"Loaded {len(done)} cached extractions from {cache_path}"
        if skipped_fail:
            msg += f" (skipped {skipped_fail} 'Fail to answer' entries for re-extraction)"
        print(msg)

    # Separate cached vs. to-process records
    to_process: list[dict] = []
    for rec in records:
        key = (rec["doc_id"], rec["question"])
        if key in done:
            rec["pred"] = done[key]
        elif rec.get("error") or not rec["pred_raw"]:
            rec["pred"] = "Fail to answer"
        else:
            to_process.append(rec)

    if not to_process:
        return records

    cache_lock = threading.Lock()
    cache_f = open(cache_path, "a", encoding="utf-8") if cache_path else None

    def _write_cache(rec: dict):
        if cache_f:
            with cache_lock:
                cache_f.write(json.dumps({
                    "doc_id": rec["doc_id"],
                    "question": rec["question"],
                    "pred": rec["pred"],
                }, ensure_ascii=False) + "\n")
                cache_f.flush()

    def _extract_one(rec: dict, client):
        rec["pred"] = extract_answer_llm(
            client, model, rec["question"], rec["pred_raw"],
            answer_type=rec.get("answer_type", "Str"),
            extra_body=extra_body,
        )
        _write_cache(rec)

    try:
        if n_jobs <= 1:
            client = create_llm_client(api_key, base_url, model=model,
                                       azure_endpoint=azure_endpoint,
                                       azure_api_version=azure_api_version)
            for rec in tqdm(to_process, desc="Extracting answers"):
                _extract_one(rec, client)
        else:
            print(f"Extracting with {n_jobs} parallel workers...")
            clients = [create_llm_client(api_key, base_url, model=model,
                                         azure_endpoint=azure_endpoint,
                                         azure_api_version=azure_api_version)
                       for _ in range(n_jobs)]
            pbar = tqdm(total=len(to_process), desc=f"Extracting (j={n_jobs})")
            with ThreadPoolExecutor(max_workers=n_jobs) as pool:
                futures = {
                    pool.submit(_extract_one, rec, clients[i % n_jobs]): rec
                    for i, rec in enumerate(to_process)
                }
                for future in as_completed(futures):
                    try:
                        future.result()
                    except Exception as e:
                        rec = futures[future]
                        rec["pred"] = "Fail to answer"
                        print(f"  [WARN] Extraction error: {e}")
                    pbar.update(1)
            pbar.close()
    finally:
        if cache_f:
            cache_f.close()

    return records


def run_rule_scoring(records: list[dict]) -> list[dict]:
    scorable = [rec for rec in records if not rec.get("error")]
    skipped = len(records) - len(scorable)
    if skipped:
        print(f"Skipping {skipped} error samples from scoring.")
    print(f"Scoring {len(scorable)} samples ...")
    for rec in tqdm(scorable, desc="Scoring"):
        try:
            rec["score"] = eval_score(rec["answer"], rec["pred"], rec["answer_type"])
        except Exception as exc:
            print(f"  [WARN] Scoring error: {exc}  (question={rec['question'][:60]})")
            rec["score"] = 0.0
    return records


def run_llm_judge(records: list[dict], *, model: str, api_key: str, base_url: str,
                  max_tokens: int, temperature: float, add_notanswerable: bool,
                  n_jobs: int = 1,
                  azure_endpoint: str | None = None,
                  azure_api_version: str = AZURE_API_VERSION) -> list[dict]:
    evaluated = []
    to_judge: list[dict] = []

    for rec in records:
        if rec.get("error"):
            rec["pred"] = rec.get("pred_raw", "")
            rec["score"] = 0.0
            rec["judge_explanation"] = "Error during generation"
            rec["parse_error"] = False
            evaluated.append(rec)
            continue
        if rec.get("answer", "") == "Not answerable" and not add_notanswerable:
            continue
        rec["pred"] = rec.get("pred_raw", "")
        to_judge.append(rec)

    def _judge_one(rec: dict, client):
        eval_result = evaluate_response(
            client=client, model=model,
            predicted_answer=rec["pred"],
            ground_truth=rec.get("answer", ""),
            question=rec.get("question", ""),
            answer_type=rec.get("answer_type", "Str"),
            max_tokens=max_tokens, temperature=temperature,
        )
        rec["score"] = eval_result["score"]
        rec["judge_explanation"] = eval_result["explanation"]
        rec["parse_error"] = eval_result["parse_error"]
        return rec

    if n_jobs <= 1:
        client = create_llm_client(api_key, base_url, model=model,
                                   azure_endpoint=azure_endpoint,
                                   azure_api_version=azure_api_version)
        for rec in tqdm(to_judge, desc="LLM judging"):
            evaluated.append(_judge_one(rec, client))
    else:
        print(f"LLM judging with {n_jobs} parallel workers...")
        clients = [create_llm_client(api_key, base_url, model=model,
                                     azure_endpoint=azure_endpoint,
                                     azure_api_version=azure_api_version)
                   for _ in range(n_jobs)]
        pbar = tqdm(total=len(to_judge), desc=f"LLM judging (j={n_jobs})")
        eval_lock = threading.Lock()
        with ThreadPoolExecutor(max_workers=n_jobs) as pool:
            futures = {
                pool.submit(_judge_one, rec, clients[i % n_jobs]): rec
                for i, rec in enumerate(to_judge)
            }
            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception as e:
                    rec = futures[future]
                    rec["score"] = 0.0
                    rec["judge_explanation"] = f"Error: {e}"
                    rec["parse_error"] = True
                    result = rec
                    print(f"  [WARN] Judge error: {e}")
                with eval_lock:
                    evaluated.append(result)
                pbar.update(1)
        pbar.close()

    return evaluated


# ------------------------------
# 7) Main
# ------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="MMLongBench Hybrid Scorer (rule-based or LLM-judge)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Rule-based scoring with LLM extraction
  python score_mmlongbench_hybrid.py -i outputs/mmlongbench_hybrid.json

  # Rule-based scoring without extraction
  python score_mmlongbench_hybrid.py -i outputs/mmlongbench_hybrid.json --skip-extract

  # LLM-judge scoring
  python score_mmlongbench_hybrid.py -i outputs/mmlongbench_hybrid.json --judge
        """,
    )
    parser.add_argument("--input", "-i", default="outputs/mmlongbench_hybrid.json",
                        help="Path to results file (.json or .jsonl)")
    parser.add_argument("--output", "-o", default=None,
                        help="Path to save evaluation report (default: <input>_eval_report.txt)")
    parser.add_argument("--extract-cache", default=None,
                        help="JSONL cache file for extracted answers (enables resume)")
    parser.add_argument("--skip-extract", action="store_true",
                        help="Skip LLM extraction; use final_answer directly as pred")
    parser.add_argument("--judge", action="store_true",
                        help="Use LLM-as-judge scoring instead of rule-based scoring")

    parser.add_argument("--model", default=None,
                        help="LLM model / Azure deployment name for extraction or judge "
                             "(required unless --skip-extract). Azure auto-detected for gpt-*/o1/o3.")
    parser.add_argument("--api-key", default=None,
                        help="API key (or set OPENAI_API_KEY / AZURE_OPENAI_API_KEY env var)")
    parser.add_argument("--base-url",
                        default=os.environ.get("OPENAI_BASE_URL", ""),
                        help="OpenAI-compatible API base URL (or set OPENAI_BASE_URL). "
                             "Ignored for Azure models, which use AZURE_OPENAI_ENDPOINT.")
    parser.add_argument("--azure-endpoint", default=None,
                        help="Azure OpenAI endpoint (auto-detected from AZURE_OPENAI_ENDPOINT env var for gpt/o1/o3 models)")
    parser.add_argument("--azure-api-version", default=AZURE_API_VERSION,
                        help="Azure API version")

    parser.add_argument("--max-tokens", type=int, default=256,
                        help="Max tokens for LLM judge output")
    parser.add_argument("--temperature", type=float, default=0.0,
                        help="Judge temperature")
    parser.add_argument("--add-notanswerable", action="store_true",
                        help="Include 'Not answerable' samples in judge mode")
    parser.add_argument("--n-jobs", type=int, default=1,
                        help="Parallel workers for extraction/judge (default: 1)")

    args = parser.parse_args()

    if args.output is None:
        stem = Path(args.input).stem
        args.output = str(Path(args.input).parent / f"{stem}_eval_report.txt")

    if args.extract_cache is None and not args.skip_extract and not args.judge:
        stem = Path(args.input).stem
        args.extract_cache = str(Path(args.input).parent / f"{stem}_extracted.jsonl")

    records = load_input(args.input)

    if args.judge:
        api_key = (
            args.api_key
            or os.environ.get("AZURE_OPENAI_API_KEY", "")
            or os.environ.get("OPENAI_API_KEY", "")
            or os.environ.get("CHATGPT_API_KEY", "")
        )
        if not args.model:
            print("ERROR: --model is required for judge mode (e.g. --model gpt-4o).")
            sys.exit(1)
        # Azure models can auth via `az login` (AzureCliCredential); only
        # require an explicit key for non-Azure / no-endpoint setups.
        azure_login_ok = _is_azure_model(args.model) and (
            args.azure_endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT")
        )
        if not api_key and not azure_login_ok:
            print("ERROR: set --api-key, or one of AZURE_OPENAI_API_KEY / OPENAI_API_KEY / "
                  "CHATGPT_API_KEY (or use an Azure model with AZURE_OPENAI_ENDPOINT + `az login`).")
            sys.exit(1)

        records = run_llm_judge(
            records,
            model=args.model,
            api_key=api_key,
            base_url=args.base_url,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            add_notanswerable=args.add_notanswerable,
            n_jobs=args.n_jobs,
            azure_endpoint=args.azure_endpoint,
            azure_api_version=args.azure_api_version,
        )
    else:
        if args.skip_extract:
            print("Skipping LLM extraction — using raw predictions directly.")
            for rec in records:
                rec["pred"] = rec["pred_raw"] if rec["pred_raw"] else "Fail to answer"
        else:
            api_key = (
                args.api_key
                or os.environ.get("AZURE_OPENAI_API_KEY", "")
                or os.environ.get("OPENAI_API_KEY", "")
                or os.environ.get("CHATGPT_API_KEY", "")
            )
            if not args.model:
                print("ERROR: --model is required for extraction (e.g. --model gpt-4o). "
                      "Use --skip-extract to bypass.")
                sys.exit(1)
            # Azure models can auth via `az login`; only require an explicit
            # key for non-Azure / no-endpoint setups.
            azure_login_ok = _is_azure_model(args.model) and (
                args.azure_endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT")
            )
            if not api_key and not azure_login_ok:
                print("ERROR: set --api-key, or one of AZURE_OPENAI_API_KEY / OPENAI_API_KEY / "
                      "CHATGPT_API_KEY (or use an Azure model with AZURE_OPENAI_ENDPOINT + `az login`).")
                print("       Use --skip-extract to bypass LLM extraction.")
                sys.exit(1)

            extra_body = None
            if not _is_azure_model(args.model):
                extra_body = {"enable_thinking": False}
            records = run_extraction(
                records,
                model=args.model,
                api_key=api_key,
                base_url=args.base_url,
                cache_path=args.extract_cache,
                extra_body=extra_body,
                n_jobs=args.n_jobs,
                azure_endpoint=args.azure_endpoint,
                azure_api_version=args.azure_api_version,
            )

        records = run_rule_scoring(records)

    report = generate_report(records, output_path=args.output)
    print()
    print(report)

    detail_path = str(Path(args.output).with_suffix(".json"))
    save_records = []
    for rec in records:
        r = {k: v for k, v in rec.items() if k != "model_output"}
        save_records.append(r)
    with open(detail_path, "w", encoding="utf-8") as f:
        json.dump(save_records, f, ensure_ascii=False, indent=2)
    print(f"\nPer-sample details saved to: {detail_path}")


if __name__ == "__main__":
    main()