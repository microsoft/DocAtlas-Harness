#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

command -v uv >/dev/null 2>&1 || { echo "uv is required" >&2; exit 1; }
unset VIRTUAL_ENV
exec uv run --locked docatlas tui "$@"
