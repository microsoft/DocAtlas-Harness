# Pi execution adapter — initial runtime composition

`./worker` provides directional/bounded IPC, credential-free model proxies, native/document operation bridges and
persisted checkpoint verification. Server owns the OS worker and real brokers. Pi runtime/tools/loop/sessions/resources
remain native. ADR-029 scopes this internal integration; full controls/resource/provider parity and deployment remain open.
ADR-030 adds a loader-scoped extension exec backend before factory execution; the compatibility patch now fingerprints
24 files. Worker native exec cancellation returns its actual result only after process settlement. Approved resources are
read-only aliases, keeping original skill/helper reads available without granting the mutable private agent directory.

Status: published SDK 0.85.1 with a reviewed pinned compatibility patch; composition, checkpoints, native I/O bridging
and exact-message product dispatch implemented. Not a production server
or a complete native security/parity gate. createPiRuntime retains the full native runtime and rebinds extensions.

This is the only product package that owns Pi imports, SDK composition, native capability bridging, session replacement,
tool/context hooks, rich runtime controls and extension UI adaptation. It executes for DocAtlas Core; it does not own
Evidence, research truth, personal memory or the Web product. Internal Pi hooks are an integration technique.

Retain native tools/resources/session behavior. Do not wrap only `prompt/abort`, use a document-only allowlist, or replace
native `read`. Do not import `.sources/pi` or experimental source-only entry points into product code.

[Design and parity matrix](../../docs/architecture/pi-runtime.md) · [Pinned source baseline](../../compat/pi/README.md)

R1-001a's SDK/first-prompt package is verified; R1-004a/full parity remains in progress. Native lifecycle and namespace tests are implemented.
The native first-prompt gap remains upstream; apps/server now preserves input in a durable inbox and tests safe
pre-dispatch recovery versus unknown dispatched outcome. checkpointPiSubmission validates and fsyncs the real native
file before saved success. PiProductDriver maps ordinary/steer/follow-up submissions to actual native user entries;
apps/server renews writer leases and cancels real execution. Full extension/worker/model isolation and parity remain required.
No Azure or paid model request is made by these tests. The separate ./testing export is test-only, never a live fallback.

ADR-050 adds real `navigateTree`/`AgentSessionRuntime.fork` with separate file seals/selected heads, exact SDK inheritance
proofs and selected-history projection. Preserve native labels, compaction references, hooks, per-session model/thinking
and actual child queues. Product binding transfer, isolated-file installation and recovery remain host-owned; no second
transcript or fabricated user checkpoint is introduced. The existing 24-file Pi patch is unchanged. See the task board
for current integration and browser acceptance, not just SDK test coverage.

Run: bash scripts/pnpmw exec vitest run packages/runtime-pi/test
Evidence: [runtime spike](../../research/19-backend-runtime-spike.md).
Latest: [native dispatch/I/O](../../research/21-native-dispatch-and-io.md) · [patch review](../../compat/pi/patches.md).
