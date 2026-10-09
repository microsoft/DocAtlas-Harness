# Document runtime adapter

The shared `./sandbox-process` guard owns Node bwrap lifetimes, including early stop and namespace-exit verification.
Pi/native/document callers use it; Python PDF/Flash use a kernel-pidfd equivalent. Monitor exit is not sufficient evidence
of quiescence. Application-controlled cancellation is tested; host-death/cgroup/cross-platform release gates remain open.

Framework-neutral Node infrastructure for Core document use cases: approved-root discovery, immutable asset reading,
JSONL supervisor, uv process lifecycle and the optional one-shot Flash tree job. No Pi/DSH/React imports or model loop.
Legacy DSH re-exports use the same implementation through its existing subprocess port.

`launchUvDocumentProcess` accepts trusted application paths only, uses uv `--locked --no-sync` and an offline,
secret-scrubbed environment. Environments must already be synchronized. The new Node path is now namespaced with only
explicit RO runtime/source and RW cache grants. Protected private-state roots must not overlap any grant; never expose
this configuration as a browser/agent arbitrary-path interface. Native PDF parsing has a second, single-file/read-only
namespace and seccomp boundary; coordinators do not import pypdf/PDFium. See ADR-028; this is not full Pi/product acceptance.

`createDocumentBackend` accounts for calls, tree jobs and visual file reads. `abortAll` waits for exit; `resume` is
explicit. Use a separate backend per conversation, plus a separate Library import supervisor, so cancel is local.
Conversation readers use cache-only mode without source grants or ingest capability. Data is independently bound/validated
in Core before Pi receives it. HTTP auth, deployment packaging, full Pi/model isolation, aggregate resources and
evidence/Answer projection remain application/release gates.
