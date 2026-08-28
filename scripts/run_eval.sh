#!/usr/bin/env bash
# ============================================================
#  MMLongBench-Doc Evaluation — DocAtlas edition
#
#  Drives `uv run --locked docatlas eval-mmlongbench` over MMLongBench-Doc
#  corpus. Output JSON is shape-compatible with
#  docatlas/scoring/score_mmlongbench_hybrid.py.
#
#  See the README Evaluation section for setup, then place the corpus under
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
#  Additional arguments flow through to `docatlas eval-mmlongbench`
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
    # shellcheck source=/dev/null
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

command -v uv >/dev/null 2>&1 || { echo "uv is required" >&2; exit 1; }

# Best config (reproduces the paper's headline MMLongBench-Doc number with
# the paper's model + MinerU markdown): 4 skills, --detail high, high reasoning,
# vision-zoom 1.0, max-turns 50, figure metadata, memory OFF, tree-annotate
# ON (the eval runner enables tree-annotate automatically).
uv run --locked docatlas eval-mmlongbench \
    --skill search \
    --skill read \
    --skill note \
    --skill review \
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
