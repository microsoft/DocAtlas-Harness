# Pi compatibility baseline

- Upstream: `https://github.com/earendil-works/pi.git`
- Local read-only checkout: `.sources/pi`
- Release: `v0.85.1`
- Commit: `d981de1229ef899957bbe968bc8dcda02a21f477`
- Source lock: `sources.lock.json` (branch tracks `main` for update discovery; the selected release stays pinned).
- Runtime/npm integration: published 0.85.1 plus a [reviewed local compatibility patch](patches.md); composition,
  durable submissions/checkpoints, native message attribution/dispatch and a native I/O namespace backend are implemented.
  Full extension/worker/model isolation, all native parity and deployed Web integration remain pending.
- 2026-09-08 read-only registry check: the published package is `@earendil-works/pi-coding-agent@0.85.1`,
  engines `node >=22.19.0`. This confirms metadata only, not public-SDK execution or transitive dependency compatibility.

The product uses the published SDK with pnpm-pinned patch fingerprints, not imports from the checkout. Upstream uses npm; this checkout is source-only,
and no upstream dependency manager/build was run. Product dependencies must use the workspace's pinned pnpm workflow.

ADR-048 adds first-question-free persistence via public SessionManager entries/reopen, native intent/commit proofs, full SDK-supported
thinking choices (including max when supported), queue modes and bounded native history pages. It does not add a Pi patch or create fake
assistant messages. Metadata-only reopen may append Pi's own initialization entries; historical proofs verify the original prefix, not the
latest configuration. Clean cold reconciliation must not execute approved factories before unresolved operation barriers are checked.
ADR-049 adds real manual SDK compaction, verified non-application and its on-demand Web control without another patch. Native summaries are not Evidence or answer-generation MemoryUse. Fork/selected-head, automatic in-turn compaction/steering attribution and full native/extension Web acceptance remain open; batch 23 verification is recorded in the execution tracker.

Native parity and release checks are defined in [runtime design](../../docs/architecture/pi-runtime.md). Review
AgentSession, runtime replacement, resource loading/trust, SessionManager, tools, model auth and event semantics for each
upgrade. Source presence, a matching version, or legacy DSH tests do not certify Pi compatibility.
