#!/usr/bin/env bash
# ============================================================
#  PageIndex Tree Construction — DocAtlas edition
#
#  Builds PageIndex tree structures for MMLongBench PDFs.
#
#  Usage:
#    bash scripts/run_build_tree.sh
#    bash scripts/run_build_tree.sh --limit 5
#    bash scripts/run_build_tree.sh --only-sampled --vision
#    bash scripts/run_build_tree.sh --doc-filter "paper_name"
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
PDF_DIR="${HARNESS_MMLB_PDF_DIR:-${DATA_ROOT}/documents}"
SAMPLES_FILE="${HARNESS_MMLB_SAMPLES:-${DATA_ROOT}/samples.json}"
OUTPUT_DIR="${HARNESS_MMLB_TREES_DIR:-${DATA_ROOT}/trees}"

# ── Model (required): your Azure deployment name, e.g. gpt-4o ──
MODEL="${AZURE_OPENAI_DEPLOYMENT:?set AZURE_OPENAI_DEPLOYMENT in .env (your Azure deployment name)}"

command -v uv >/dev/null 2>&1 || { echo "uv is required" >&2; exit 1; }

uv run --locked docatlas build-tree \
    --pdf-dir "${PDF_DIR}" \
    --output-dir "${OUTPUT_DIR}" \
    --model "${MODEL}" \
    --no-think \
    --toc-check-pages 20 \
    --max-pages-per-node 10 \
    --max-tokens-per-node 20000 \
    --samples-file "${SAMPLES_FILE}" \
    "$@"
