#!/usr/bin/env bash
# ============================================================
#  DocAtlas · End-to-end multi-doc demo
#
#  Two PDFs → per-doc markdown (build-md, Docling)
#           → per-doc trees → merged series tree (build-series-tree)
#           → cross-doc chat (Search + Read with --doc-id routing)
#
#  Default scenario: first 2 PDFs under data/sample_pdfs/, with a generic
#  cross-document question. Override with --pdf flags (repeat) or by
#  setting HARNESS_DEMO_PDFS (newline- or colon-separated list).
#
#  Use this to validate the entire multi-doc path in one command.
#
#  Usage:
#
#    bash scripts/demo_end_to_end_multi.sh
#
#    bash scripts/demo_end_to_end_multi.sh \\
#         --pdf doc1.pdf --pdf doc2.pdf \\
#         --question "Cross-document question here" \\
#         --doc-name "My Series"
#
#    # Force-rebuild everything
#    bash scripts/demo_end_to_end_multi.sh --force
#
#    # Chat-only (artifacts must already exist)
#    bash scripts/demo_end_to_end_multi.sh --chat-only
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ── Load .env if present ─────────────────────────────────────────────
if [ -f "${PROJECT_ROOT}/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "${PROJECT_ROOT}/.env"
    set +a
fi

# Always let uv select this repository's locked environment. An unrelated
# activated virtualenv otherwise produces a warning and can confuse users.
unset VIRTUAL_ENV

# ── Defaults ────────────────────────────────────────────────────────
# By default we look under data/sample_pdfs/ and use the first 2 PDFs
# we find. Override with one or more --pdf flags, or set HARNESS_DEMO_PDFS
# (newline- or colon-separated list of paths).
DEFAULT_PDFS=()
if [ -n "${HARNESS_DEMO_PDFS:-}" ]; then
    # Allow either ':' or newline as the separator.
    while IFS=$'\n:' read -r p; do
        [ -n "$p" ] && DEFAULT_PDFS+=("$p")
    done <<< "${HARNESS_DEMO_PDFS}"
else
    while IFS= read -r p; do
        DEFAULT_PDFS+=("$p")
    done < <(find "${PROJECT_ROOT}/data/sample_pdfs" -maxdepth 1 -type f -name '*.pdf' -print | sort | head -2)
fi
DEFAULT_Q="${HARNESS_DEMO_QUESTION:-Compare the main themes of these documents and note one substantive difference.}"
DEFAULT_SERIES_NAME="${HARNESS_DEMO_SERIES_NAME:-Demo series}"
PDFS=()
QUESTION="${DEFAULT_Q}"
SERIES_NAME="${DEFAULT_SERIES_NAME}"
SERIES_SLUG=""
OUTPUT_ROOT="${PROJECT_ROOT}/outputs/demo_multi"
MAX_TURNS=20
FORCE=0
CHAT_ONLY=0
MODEL="${AZURE_OPENAI_DEPLOYMENT:-}"

command -v uv >/dev/null 2>&1 || { echo "uv is required" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pdf)         PDFS+=("$2"); shift 2 ;;
        --question|-q) QUESTION="$2"; shift 2 ;;
        --doc-name)    SERIES_NAME="$2"; shift 2 ;;
        --series-slug) SERIES_SLUG="$2"; shift 2 ;;
        --output-dir)  OUTPUT_ROOT="$2"; shift 2 ;;
        --model)       MODEL="$2"; shift 2 ;;
        --max-turns)   MAX_TURNS="$2"; shift 2 ;;
        --force)       FORCE=1; shift ;;
        --chat-only)   CHAT_ONLY=1; shift ;;
        -h|--help)
            sed -n '4,30p' "${BASH_SOURCE[0]}"
            exit 0 ;;
        *) echo "Unknown flag: $1" >&2; exit 2 ;;
    esac
done

if [ ${#PDFS[@]} -eq 0 ]; then
    PDFS=("${DEFAULT_PDFS[@]}")
fi
if [ ${#PDFS[@]} -lt 2 ]; then
    echo "error: multi-doc demo needs at least 2 --pdf inputs (got ${#PDFS[@]})." >&2
    echo "  Pass --pdf <path> twice, set HARNESS_DEMO_PDFS, or drop ≥2 PDFs" >&2
    echo "  under ${PROJECT_ROOT}/data/sample_pdfs/" >&2
    exit 2
fi
for p in "${PDFS[@]}"; do
    [ -f "$p" ] || { echo "PDF not found: $p" >&2; exit 1; }
done

if [ -z "${MODEL}" ]; then
    echo "No model set. Set AZURE_OPENAI_DEPLOYMENT in .env or pass --model <deployment>." >&2
    exit 1
fi

if [ -z "${SERIES_SLUG}" ]; then
    SERIES_SLUG=$(echo "${SERIES_NAME}" | tr '[:upper:]' '[:lower:]' \
                | tr -c '[:alnum:]' '_' | tr -s '_' | sed 's/^_\|_$//g')
    [ -z "${SERIES_SLUG}" ] && SERIES_SLUG="series"
fi
WORK_DIR="${OUTPUT_ROOT}/${SERIES_SLUG}"
MD_DIR="${WORK_DIR}/md"
TREES_CACHE="${WORK_DIR}/trees_cache"
MERGED_TREE="${WORK_DIR}/series_tree.json"

mkdir -p "${WORK_DIR}" "${MD_DIR}" "${TREES_CACHE}"

echo "============================================================"
echo "  DocAtlas End-to-End Demo (multi-doc)"
echo "============================================================"
echo "  PDFs       : ${#PDFS[@]}"
for p in "${PDFS[@]}"; do echo "    - $(basename "$p")"; done
echo "  Series     : ${SERIES_NAME}"
echo "  Work dir   : ${WORK_DIR}"
echo "  Model      : ${MODEL}"
echo "  Max turns  : ${MAX_TURNS}"
echo "  Question   : ${QUESTION}"
echo "============================================================"

# ── Stage 1: build-md for each PDF ─────────────────────────────────
if [ ${CHAT_ONLY} -eq 1 ]; then
    echo "[1/3] build-md SKIPPED (--chat-only)"
else
    for p in "${PDFS[@]}"; do
        STEM=$(basename "$p" .pdf)
        EXIST_PAGE0="${MD_DIR}/${STEM}/${STEM}_page0/vlm/${STEM}_page0.md"
        if [ ${FORCE} -eq 0 ] && [ -f "${EXIST_PAGE0}" ]; then
            echo "[1/3] build-md ${STEM}: CACHED"
            continue
        fi
        echo "[1/3] build-md ${STEM} ..."
        BUILD_MD_ARGS=()
        [ ${FORCE} -eq 1 ] && BUILD_MD_ARGS+=(--force)
        uv run --locked harness build-md \
            --pdf "$p" --output-dir "${MD_DIR}" "${BUILD_MD_ARGS[@]}"
    done
fi

# ── Stage 2: build-series-tree (per-doc trees → merged) ────────────
if [ ${CHAT_ONLY} -eq 1 ]; then
    echo "[2/3] build-series-tree SKIPPED (--chat-only)"
elif [ ${FORCE} -eq 0 ] && [ -f "${MERGED_TREE}" ]; then
    echo "[2/3] build-series-tree CACHED  (${MERGED_TREE})"
else
    echo "[2/3] build-series-tree (model=${MODEL}) ..."
    BUILD_TREE_ARGS=()
    [ ${FORCE} -eq 1 ] && BUILD_TREE_ARGS+=(--force-trees)
    PDF_FLAGS=()
    for p in "${PDFS[@]}"; do PDF_FLAGS+=(--pdf "$p"); done
    uv run --locked harness build-series-tree \
        "${PDF_FLAGS[@]}" \
        --output "${MERGED_TREE}" \
        --trees-dir "${TREES_CACHE}" \
        --doc-name "${SERIES_NAME}" \
        --model "${MODEL}" \
        --node-summary \
        "${BUILD_TREE_ARGS[@]}"
fi

[ -f "${MERGED_TREE}" ] || { echo "ERROR: merged tree not produced: ${MERGED_TREE}" >&2; exit 1; }

# ── Stage 3: multi-doc chat ────────────────────────────────────────
echo "[3/3] chat (multi-doc) ..."
echo "------------------------------------------------------------"
PDF_FLAGS=()
for p in "${PDFS[@]}"; do PDF_FLAGS+=(--pdf "$p"); done
AZURE_OPENAI_DEPLOYMENT="${MODEL}" \
uv run --locked harness chat \
    --skill search --skill read --skill note --skill review \
    "${PDF_FLAGS[@]}" \
    --markdown-dir "${MD_DIR}" \
    --tree-json "${MERGED_TREE}" \
    --max-turns "${MAX_TURNS}" \
    --no-memory \
    --message "${QUESTION}"
echo "------------------------------------------------------------"
echo "Done. Artifacts:"
echo "  - per-doc md:  ${MD_DIR}/"
echo "  - per-doc trees: ${TREES_CACHE}/"
echo "  - series tree: ${MERGED_TREE}"
echo "  - session:     outputs/sessions/<latest>/"
