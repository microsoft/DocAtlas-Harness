#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workspace_root=$(cd "$script_dir/.." && pwd)
cd "$workspace_root"

"$script_dir/pnpmw" --filter @docatlas/server build
"$script_dir/pnpmw" run build:demo
exec "$script_dir/pnpmw" exec node apps/server/lib/cli.js "$@"
