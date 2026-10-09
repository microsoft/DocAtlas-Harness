# Pi 0.85.1 local compatibility patch

The product installs the published SDK with `patches/@earendil-works__pi-coding-agent@0.85.1.patch` through pnpm's
patchedDependencies. The release version remains 0.85.1; it is not claimed to be an unmodified stock SDK. The read-only
source checkout remains at d981de1. Pi's upstream MIT license and copyright notices remain in the installed package.

Review baseline: `compat/pi/patch-baseline.json` (`native-io-message-identity.v1`). It fingerprints the patch and all 20
modified installed files. `bash scripts/pnpmw run check:compat` verifies both release and patch, in addition to legacy DSH.

## Delta

- Pass ToolsOptions through SDK → services → AgentSession → original builtin factories, including runtime rebuilding.
- Route explicit `executeBash` through the configured operations, alongside model-invoked Bash.
- Add grep's missing process-spawn seam; custom backends do not cause a host tool download.
- Route read's filename-variant existence probes through the provided backend instead of host fs.
- Allow per-runtime shell output directories, preserving full-output recovery without granting transcript access.
- Export Pi's own byte-based MIME detector; its JPEG/APNG/BMP safeguards are reused, not reimplemented approximately.
- Observe the exact expanded user object before normal/steer/follow-up admission, without changing native JSONL or
  inserting product IDs into user text. A rejected observer runs before queue mutation.

No agent loop, provider dispatch, tool schema, prompt/render metadata, tool-result truncation, default activation or
native queue priority is replaced. This patch covers unbundled SDK use; it does not alter Pi's prebundled CLI or certify
that every extension execution path is isolated. Source maps are upstream artifacts, so debug line mapping may differ.

## Update workflow

Use the pinned pnpm wrapper's patch/patch-commit workflow in a dedicated `.cache` edit directory, make edits with
apply_patch, and commit the resulting patch/lock/manifest changes together after verification. Do not edit `.sources/pi`
or node_modules in place. Do not run upstream npm or create an independent forked loop.

For an upstream upgrade, inspect each seam, drop upstreamed changes, regenerate the baseline only after review, and
run the full workspace plus runtime/server tests. A changed fingerprint is a review failure, not permission to silently
update the expected hash. Tests include unchanged native behavior without configured operations, transformed/repeated
messages, queue rejection, actual sandbox tools and full dispatch/cancel/checkpoint integration.

Open security/functional gates are listed in ADR-025: extension pi.exec/direct Node, trusted resource snapshots, full
worker/model/credential isolation, aggregate resources, approved egress, managed persistent jobs, toolchain/platform
coverage and complete native-control/browser mapping. A green patch check proves installation, not production safety.
