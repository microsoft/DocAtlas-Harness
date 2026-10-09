#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workspace_root=$(cd "$script_dir/.." && pwd)
node_version=22.19.0

case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    platform=linux-x64
    checksum=c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2
    ;;
  Linux:aarch64|Linux:arm64)
    platform=linux-arm64
    checksum=0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc
    ;;
  Darwin:x86_64)
    platform=darwin-x64
    checksum=41796082f45db51738d1902cae84fa4f699ff6d2550321361424e8bfe6ea1939
    ;;
  Darwin:arm64)
    platform=darwin-arm64
    checksum=1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a
    ;;
  *)
    echo "unsupported platform for local Node bootstrap: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

archive="node-v${node_version}-${platform}.tar.xz"
tools_dir="$workspace_root/.cache/tools"
install_dir="$tools_dir/node-v${node_version}-${platform}"
archive_path="$tools_dir/$archive"

if [[ -x "$install_dir/bin/node" ]]; then
  installed=$("$install_dir/bin/node" --version)
  if [[ "$installed" == "v${node_version}" ]]; then
    printf 'Node %s already available at %s\n' "$node_version" "$install_dir"
    exit 0
  fi
  echo "unexpected Node version at $install_dir: $installed" >&2
  exit 1
fi

if [[ -e "$install_dir" ]]; then
  echo "incomplete Node install exists at $install_dir; inspect it before retrying" >&2
  exit 1
fi

mkdir -p "$tools_dir"
curl --fail --location --retry 3 --output "$archive_path" \
  "https://nodejs.org/dist/v${node_version}/${archive}"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive_path" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive_path" | awk '{print $1}')
else
  echo "sha256sum or shasum is required to verify Node" >&2
  exit 1
fi

if [[ "$actual" != "$checksum" ]]; then
  echo "Node archive checksum mismatch: $actual" >&2
  exit 1
fi

staging="$tools_dir/.node-v${node_version}-${platform}-staging-$$"
mkdir "$staging"
tar -xJf "$archive_path" --strip-components=1 -C "$staging"
mv "$staging" "$install_dir"
printf 'Installed Node %s at %s\n' "$node_version" "$install_dir"
