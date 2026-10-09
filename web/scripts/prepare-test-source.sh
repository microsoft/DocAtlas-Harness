#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$script_dir/.."
target=.sources/pageindex
commit=ae169566b3148792776531d987f543edcad92321
if [[ ! -e "$target" ]]; then
  mkdir -p .sources
  git clone --no-checkout https://github.com/VectifyAI/PageIndex.git "$target"
  git -C "$target" checkout --detach "$commit"
fi
[[ $(git -C "$target" remote get-url origin) == https://github.com/VectifyAI/PageIndex.git ]]
[[ $(git -C "$target" rev-parse HEAD) == "$commit" ]]
[[ -z $(git -C "$target" status --porcelain) ]]
printf 'Pinned read-only Flash test source verified.\n'
