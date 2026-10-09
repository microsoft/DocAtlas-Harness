# ADR-025: Native I/O adaptation and product submission dispatch

> Status: Internal implementation reviewed; full production security gate remains open
> Date: 2026-09-08
> Scope: published Pi 0.85.1 compatibility patch, native I/O boundary, submission-to-native-message attribution and scheduler.

## Findings and decisions

The published high-level SDK does not pass ToolsOptions to AgentSession. Replacing builtins with extension tools would
change origin/default activation and can lose native prompt/renderer behavior. Keep the original native definitions and
route their operations through explicit application backends instead.

The existing grep operations still spawn host rg; read's path-variant existence probe accesses the host; explicit user
Bash uses a separate executor; shell full-output files need a read grant outside the private transcript directory.
All are covered by the pinned package patch. It changes neither tool schemas nor native JSONL format, model/provider
loop, queue priority, tool-result formatting, renderers or default tool inventory.

The patch also exposes a narrow onUserMessage preflight observer for the exact transformed native user object. Product
dispatch must not match repeated text/timestamps heuristically or inject identifiers into the user's prompt. The hook
does not create new persisted event types. It runs before queue mutation, so a rejected admission leaves no ghost item.

Patch inventory, SHA and installed-file hashes live in compat/pi/patch-baseline.json and are checked by check:compat.
pnpm patchedDependencies applies it reproducibly; the upstream checkout remains untouched. Only unbundled SDK use is
adapted; this is not a claim that the separate prebundled Pi CLI is patched. Review/remove the delta on any upgrade.

## Implemented internal execution path

ControlStore acceptance → preparation → durable dispatch intent → Pi native message admission → native execution →
actual settlement/checkpoint → committed completion. Ordinary messages serialize; steer/follow-up use Pi's original
queues and priorities. Each product submission maps to a distinct native user entry, even for identical input text.

SubmissionCoordinator renews a single writer lease, preserves queued input in SQLite, fences stale outcomes and waits
for runtime/native operations to stop on cancellation. Lease loss triggers actual stop before unknown-outcome recovery.
Prepare is a required application port; the initial document-free implementation rejects document/selection references
instead of making up admission. Observation callbacks cannot roll back durable state or abort execution.

LinuxExecutor creates real user/PID/network namespaces with bwrap. Workspace is RW; approved source/output mounts RO;
product private directories and credentials are not granted. Environment is an allowlist, not inherited from the server.
Read/edit/write/search paths—including symlinks—are resolved inside the boundary. Per-runtime scratch persists across
operations. Native output files remain readable while transcript/control/profile stores stay outside native grants.
Unavailable isolation fails closed. Bounds currently cover operation duration, output bytes, file size and active launches.

## Proven scope and explicit remaining gates

Tests exercise original builtin metadata, actual native read/write/edit/bash/grep/find/ls, symlink/private/RO denial,
explicit Bash, long-output readback, host-network denial, cancellation, complete scheduling and genuine saved success.
Separate real-Pi tests cover ordinary queueing, duplicate receipt replay, steer/follow-up priority, exact message identity,
heartbeat, preparation cancellation, stale writer recovery and transformed user messages.

This does NOT yet certify production isolation for all execution paths:

- Trusted Pi/runtime/extensions remain outside the native operation namespace. Official extension pi.exec still needs
  routing; arbitrary trusted extension Node code can bypass tool operations. Resource approval/snapshot and immutable
  runtime installation must prevent automatic execution of agent-modified extension code.
- Full worker/model-credential separation, aggregate CPU/RSS/PID quotas, approved egress and persistent background jobs /
  preview-port mediation remain required. Current network policy is offline, not an unrestricted networking promise.
- Python/uv and optional PowerShell toolchain grants need their platform matrix. No fallback to host executables is added.
- Complete browser auth/observations/approval/native-control routes and permission-aware document preparation remain pending.
- Extension-handled input without an attributable user entry is marked unknown, not fabricated as saved success; its
  dedicated command receipt/control mapping is still required. Rare unconsumed-queue/settlement boundaries need broader fault tests.

Therefore ADR-023/R1 and the full product goal remain incomplete. These internal modules must not be presented as a
deployed backend or as proof of all native parity/security gates.

Final internal verification: `bash scripts/check.sh` passes 469 JS tests (one existing skip) and 102 Python tests;
`bash scripts/pnpmw run test:browser` passes six legacy tests after the build. Frozen install, 20 patched-file fingerprints
and all 10 source checkouts pass. These results prove the scoped implementation and regression baseline above, not the open gates.
