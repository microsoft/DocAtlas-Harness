#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$script_dir/.."
unset VIRTUAL_ENV
"$script_dir/pnpmw" run check:js
uv run --locked --project python/docatlas-sidecar ruff check python/docatlas-sidecar
uv run --locked --project python/docatlas-sidecar ruff format --check python/docatlas-sidecar
uv run --locked --project python/docatlas-sidecar ruff check --config python/docatlas-sidecar/pyproject.toml scripts/verify-sidecar-wheel.py
uv run --locked --project python/docatlas-sidecar ruff format --check --config python/docatlas-sidecar/pyproject.toml scripts/verify-sidecar-wheel.py
uv run --locked --project python/docatlas-sidecar mypy --config-file python/docatlas-sidecar/pyproject.toml python/docatlas-sidecar/src
uv run --locked --project python/docatlas-sidecar pytest python/docatlas-sidecar/tests \
  --cov=docatlas_dsh_sidecar --cov-branch --cov-config=python/docatlas-sidecar/pyproject.toml \
  --cov-report=term:skip-covered --cov-report=json:.cache/coverage/python/coverage.json \
  --cov-report=html:.cache/coverage/python/html
uv run --locked --project python/docatlas-sidecar python scripts/vendor_flash.py --check
uv run --locked --project python/docatlas-sidecar python scripts/verify-sidecar-wheel.py
printf '\nAll independent Web checks passed.\n'
