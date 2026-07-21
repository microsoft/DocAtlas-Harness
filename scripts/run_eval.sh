#!/usr/bin/env bash
# ============================================================
#  MMLongBench-Doc Evaluation — DocAtlas edition
#
#  Drives `python -m harness eval-mmlongbench` over the MMLongBench-Doc
#  corpus. Output JSON is shape-compatible with
#  scoring/score_mmlongbench_hybrid.py.
#
#  MMLongBench-Doc is not redistributed with this repo — see the README
#  "Data & benchmarks" section for how to obtain it, then drop it under
#  data/MMLongBench/ (gitignored) or point the env vars below elsewhere:
#
#    HARNESS_MMLB_DATA_ROOT    base dir holding samples.json + documents/
#                              + markdown/ + (optional) text_doc/
#                              default: data/MMLongBench
#    HARNESS_MMLB_TREES_DIR    PageIndex *_structure.json directory
#                              default: data/MMLongBench/trees
#    HARNESS_MMLB_SAMPLES      override the samples.json path
#    HARNESS_MMLB_PDF_DIR      override the documents/ dir
#    HARNESS_MMLB_MARKDOWN_DIR override the markdown/ dir
#
#  Anything else flows through to `python -m harness eval-mmlongbench`
#  via "$@".
#
#  Usage:
#    bash scripts/run_eval.sh
#    bash scripts/run_eval.sh --resume
#    bash scripts/run_eval.sh --limit 10 --n-jobs 2 --verbose
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ── Load .env if present ──
if [ -f "${PROJECT_ROOT}/.env" ]; then
    set -a
    source "${PROJECT_ROOT}/.env"
    set +a
fi

# ── Data paths (in-repo defaults; override via env) ──
DATA_ROOT="${HARNESS_MMLB_DATA_ROOT:-${PROJECT_ROOT}/data/MMLongBench}"
SAMPLES_FILE="${HARNESS_MMLB_SAMPLES:-${DATA_ROOT}/samples.json}"
PDF_DIR="${HARNESS_MMLB_PDF_DIR:-${DATA_ROOT}/documents}"
MARKDOWN_DIR="${HARNESS_MMLB_MARKDOWN_DIR:-${DATA_ROOT}/markdown}"
RESULTS_DIR="${HARNESS_MMLB_TREES_DIR:-${DATA_ROOT}/trees}"

# ── Output ──
OUTPUT_DIR="${PROJECT_ROOT}/outputs"
mkdir -p "${OUTPUT_DIR}"

# ── Defaults ──
N_JOBS=8
MAX_TURNS=50

# ── Python interpreter ──
# Prefer HARNESS_DRIVER_PYTHON → HARNESS_SKILL_PYTHON → local uv venv
# → plain python3 (last-resort, system).
if [ -n "${HARNESS_DRIVER_PYTHON:-}" ]; then
    DRIVER_PY="${HARNESS_DRIVER_PYTHON}"
elif [ -n "${HARNESS_SKILL_PYTHON:-}" ]; then
    DRIVER_PY="${HARNESS_SKILL_PYTHON}"
elif [ -x "${PROJECT_ROOT}/.venv/bin/python" ]; then
    DRIVER_PY="${PROJECT_ROOT}/.venv/bin/python"
else
    DRIVER_PY="python3"
fi

# Best config (reproduces the paper's headline MMLongBench-Doc number with
# the paper's model + MinerU markdown): 4 skills, --detail high, high reasoning,
# vision-zoom 1.0, max-turns 50, figure metadata, memory OFF, tree-annotate
# ON (the eval runner enables tree-annotate automatically).
"${DRIVER_PY}" -m harness eval-mmlongbench \
    --skill Search \
    --skill Read \
    --skill Note \
    --skill Review \
    \
    --vision \
    --vision-zoom 1.0 \
    --detail high \
    --use-markdown \
    \
    --reasoning-effort high \
    --reasoning-summary detailed \
    --max-turns "${MAX_TURNS}" \
    --n-jobs "${N_JOBS}" \
    \
    --samples-file "${SAMPLES_FILE}" \
    --results-dir "${RESULTS_DIR}" \
    --pdf-dir "${PDF_DIR}" \
    --markdown-dir "${MARKDOWN_DIR}" \
    --output-dir "${OUTPUT_DIR}" \
    \
    "$@"
