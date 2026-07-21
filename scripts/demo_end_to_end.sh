#!/usr/bin/env bash
# ============================================================
#  DocAtlas · End-to-end demo
#
#  PDF → per-page markdown (build-md, Docling)
#      → PageIndex tree   (build-tree, Azure OpenAI)
#      → single-question chat (Search → Read → Note → Review)
#
#  Use this to validate the whole pipeline on one document. Output of
#  each stage is cached under outputs/demo/<doc_stem>/ so re-runs skip
#  stages that already finished (pass --force to rebuild everything).
#
#  Usage:
#
#    # Defaults: first PDF found under data/sample_pdfs/ + a generic question
#    bash scripts/demo_end_to_end.sh
#
#    # Bring your own PDF and question
#    bash scripts/demo_end_to_end.sh \
#         --pdf  /path/to/doc.pdf \
#         --question "What is the maximum recommended dose of X?"
#
#    # Force-rebuild md+tree (e.g. you changed a flag)
#    bash scripts/demo_end_to_end.sh --force
#
#    # Skip md/tree stages and only run chat (md+tree must already exist)
#    bash scripts/demo_end_to_end.sh --chat-only
#
#    # Or via env (handy in CI):
#    HARNESS_DEMO_PDF=/path/to/doc.pdf bash scripts/demo_end_to_end.sh
#
#  Required env (loaded from .env if present):
#    AZURE_OPENAI_ENDPOINT     e.g. https://your-resource.openai.azure.com/
#    AZURE_API_VERSION         e.g. 2025-04-01-preview
#    AZURE_OPENAI_DEPLOYMENT   e.g. gpt-4o
#  Auth: AzureCliCredential (run `az login` once) or AZURE_OPENAI_API_KEY.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ── Load .env if present (Azure endpoint / api version / deployment) ──
if [ -f "${PROJECT_ROOT}/.env" ]; then
    set -a
    source "${PROJECT_ROOT}/.env"
    set +a
fi

# ── Defaults ─────────────────────────────────────────────────────────
# Default PDF: first .pdf found under data/sample_pdfs/ (a place you can
# drop a small PDF for the demo). Override with --pdf or set HARNESS_DEMO_PDF.
DEFAULT_PDF="${HARNESS_DEMO_PDF:-}"
if [ -z "${DEFAULT_PDF}" ]; then
    DEFAULT_PDF="$(ls "${PROJECT_ROOT}/data/sample_pdfs/"*.pdf 2>/dev/null | head -1 || true)"
fi
DEFAULT_Q="${HARNESS_DEMO_QUESTION:-Summarize the main contribution of this document in one sentence.}"

PDF="${DEFAULT_PDF}"
QUESTION="${DEFAULT_Q}"
OUTPUT_ROOT="${PROJECT_ROOT}/outputs/demo"
MAX_TURNS=20
FORCE=0
CHAT_ONLY=0
MODEL="${AZURE_OPENAI_DEPLOYMENT:-}"

# Python: prefer HARNESS_DRIVER_PYTHON → HARNESS_SKILL_PYTHON → local
# uv venv → plain python3.
if [ -n "${HARNESS_DRIVER_PYTHON:-}" ]; then
    PY="${HARNESS_DRIVER_PYTHON}"
elif [ -n "${HARNESS_SKILL_PYTHON:-}" ]; then
    PY="${HARNESS_SKILL_PYTHON}"
elif [ -x "${PROJECT_ROOT}/.venv/bin/python" ]; then
    PY="${PROJECT_ROOT}/.venv/bin/python"
else
    PY="python3"
fi

# ── Parse CLI ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pdf)         PDF="$2"; shift 2 ;;
        --question|-q) QUESTION="$2"; shift 2 ;;
        --output-dir)  OUTPUT_ROOT="$2"; shift 2 ;;
        --model)       MODEL="$2"; shift 2 ;;
        --max-turns)   MAX_TURNS="$2"; shift 2 ;;
        --force)       FORCE=1; shift ;;
        --chat-only)   CHAT_ONLY=1; shift ;;
        --python)      PY="$2"; shift 2 ;;
        -h|--help)
            sed -n '4,30p' "${BASH_SOURCE[0]}"
            exit 0 ;;
        *)
            echo "Unknown flag: $1" >&2
            exit 2 ;;
    esac
done

if [ -z "${PDF}" ] || [ ! -f "${PDF}" ]; then
    echo "PDF not found: '${PDF}'" >&2
    echo "  Pass --pdf <path>, set HARNESS_DEMO_PDF, or drop one under" >&2
    echo "  ${PROJECT_ROOT}/data/sample_pdfs/" >&2
    exit 1
fi

if [ -z "${MODEL}" ]; then
    echo "No model set. Set AZURE_OPENAI_DEPLOYMENT in .env or pass --model <deployment>." >&2
    exit 1
fi

DOC_STEM="$(basename "${PDF}" .pdf)"
WORK_DIR="${OUTPUT_ROOT}/${DOC_STEM}"
MD_DIR="${WORK_DIR}/md"
TREE_DIR="${WORK_DIR}/tree"
TREE_JSON="${TREE_DIR}/${DOC_STEM}_structure.json"
PAGE_MD_GLOB="${MD_DIR}/${DOC_STEM}/${DOC_STEM}_page0/vlm/${DOC_STEM}_page0.md"

mkdir -p "${WORK_DIR}" "${MD_DIR}" "${TREE_DIR}"

# ── Banner ──────────────────────────────────────────────────────────
echo "============================================================"
echo "  DocAtlas End-to-End Demo"
echo "============================================================"
echo "  PDF        : ${PDF}"
echo "  Doc stem   : ${DOC_STEM}"
echo "  Work dir   : ${WORK_DIR}"
echo "  Model      : ${MODEL}"
echo "  Max turns  : ${MAX_TURNS}"
echo "  Question   : ${QUESTION}"
echo "============================================================"

# ── Stage 1: build-md (Docling, per-page markdown) ──────────────────
if [ ${CHAT_ONLY} -eq 1 ]; then
    echo "[1/3] build-md SKIPPED (--chat-only)"
elif [ ${FORCE} -eq 0 ] && [ -f "${PAGE_MD_GLOB}" ]; then
    echo "[1/3] build-md CACHED  ($(find "${MD_DIR}/${DOC_STEM}" -name "*.md" | wc -l) page md files exist)"
else
    echo "[1/3] build-md ..."
    BUILD_MD_FORCE=""
    [ ${FORCE} -eq 1 ] && BUILD_MD_FORCE="--force"
    "${PY}" -m harness build-md \
        --pdf "${PDF}" \
        --output-dir "${MD_DIR}" \
        ${BUILD_MD_FORCE}
fi

# ── Stage 2: build-tree (Azure OpenAI, PageIndex structure JSON) ──
if [ ${CHAT_ONLY} -eq 1 ]; then
    echo "[2/3] build-tree SKIPPED (--chat-only)"
elif [ ${FORCE} -eq 0 ] && [ -f "${TREE_JSON}" ]; then
    echo "[2/3] build-tree CACHED  (${TREE_JSON})"
else
    echo "[2/3] build-tree (model=${MODEL}) ..."
    BUILD_TREE_FORCE=""
    [ ${FORCE} -eq 1 ] && BUILD_TREE_FORCE="--force"
    "${PY}" -m harness build-tree \
        --pdf "${PDF}" \
        --output-dir "${TREE_DIR}" \
        --model "${MODEL}" \
        --node-summary \
        ${BUILD_TREE_FORCE}
fi

if [ ! -f "${TREE_JSON}" ]; then
    echo "ERROR: tree JSON not produced at ${TREE_JSON}" >&2
    exit 1
fi
if [ ! -d "${MD_DIR}/${DOC_STEM}" ]; then
    echo "ERROR: markdown dir not produced at ${MD_DIR}/${DOC_STEM}" >&2
    exit 1
fi

# ── Stage 3: chat (Search → Read → Note → Review) ──────────────────
echo "[3/3] chat ..."
echo "------------------------------------------------------------"
AZURE_OPENAI_DEPLOYMENT="${MODEL}" \
"${PY}" -m harness chat \
    --skill Search --skill Read --skill Note --skill Review \
    --pdf "${PDF}" \
    --markdown-dir "${MD_DIR}" \
    --doc-id "${DOC_STEM}" \
    --tree-json "${TREE_JSON}" \
    --max-turns "${MAX_TURNS}" \
    --no-memory \
    --message "${QUESTION}"
echo "------------------------------------------------------------"
echo "Done. Artifacts:"
echo "  - markdown:  ${MD_DIR}/${DOC_STEM}/"
echo "  - tree json: ${TREE_JSON}"
echo "  - session:   outputs/sessions/<latest>/  (see trace above)"
