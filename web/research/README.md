# Research index

The canonical execution sequence, current status, gates, and open ADRs live in the
[DocAtlas implementation plan](../docs/implementation-plan.md). The notes below preserve observations,
research evidence, design alternatives, and detailed rationale; they do not independently override the master plan.

The notes in this directory separate observed upstream behavior from proposed
DocAtlas design. Each note records the source revisions it was checked against.

- [DSH architecture](01-dsh-architecture.md) — plugin, Web UI, tool, persistence, and maintenance boundaries.
- [PageIndex SDK](02-pageindex-sdk.md) — Python/JavaScript SDK, MCP, Flash, File System, and ChatIndex findings.
- [Personalization memory](03-personalization-memory.md) — evidence-grounded, user-controlled longitudinal memory.
- [Document experience](04-document-experience.md) — document-first Web information architecture and layouts.
- [Roadmap](05-roadmap.md) — staged delivery, compatibility gates, source maintenance, and evaluation plan.
- [Commercial systems](06-commercial-systems.md) — Gemini Notebook/NotebookLM, Acrobat, Copilot, ChatGPT, Claude, Hebbia, Harvey, Elicit, and active-reading patterns.
- [Fact trace and Agent interaction](07-fact-trace-agent-interaction.md) — evidence, atomic claims, provenance, verification gates, and DSH human-in-the-loop mechanics.
- [Product route v2](08-product-route-v2.md) — Evidence-native Personal Research Agent positioning, product surfaces, modes, journeys, and launch slice.
- [Complete upstream implementation audit](09-upstream-docatlas-implementation.md) — pinned full-code review, reuse/retirement boundaries, confirmed multi-document defect, and migration corrections.
- [DocAtlas-native personalization proposal](10-docatlas-native-personalization.md) — discussion draft for memory ownership, DSH/Core boundaries, parallel delivery tracks, and unresolved decisions.
- [Personalization implementation research](11-personalization-implementation-research.md) — 2026 research synthesis, governed adaptation loop, draft contracts, v0 implementation, and DocAtlas-specific evaluation plan.
- [Progressive Read spike](12-progressive-read-spike.md) — one-tool locate/blocks/expand/sequential/visual prototype, bounded-result tests, and remaining Locator/Evidence gaps.
- [Progressive Read stress results](13-progressive-read-stress-results.md) — 435-call local stress run, 22.5 MB boundary case, concurrency/version matrix, real-PDF probes, and discovered bottlenecks.
- [DocAtlas Memory architecture](14-adaptive-interface-research-continuity.md) — controlled preference probes, Research Memory, cross-document recall-to-reverify, Note evolution, scenarios, and staged delivery.
- [Note, Review, and Memory design space](15-note-review-memory-design-space.md) — orthogonal product roles, current-code probes, combination matrix, Tree projection, ten real-world scenarios, tool alternatives, and phased optimization.
- [Web UI interaction design](16-web-ui-interaction-design.md) — claim-span citations, exact source focus, multi-document information architecture, selection Q&A, business workflows, DSH seams, responsive/accessibility, and UI0–UI7 delivery.

Source-code observations are tied to the exact commits in
`../sources.lock.json`; commercial-product observations cite official pages and
the research date because those pages can change without a commit history.
Proposed DocAtlas decisions are labeled as recommendations and should become
versioned contracts/ADRs before implementation.

## Current architecture research

- [Pi local source audit](17-pi-source-audit.md) — release-pinned SDK/loop/session review, native parity, lifecycle/durability risks and DocAtlas-first composition.
- [Flash adoption](18-pageindex-flash-adoption.md) — prior no-model smoke, latest SDK comparison, bounded workers, index generations and geometry limitations.
- [Backend runtime spike](19-backend-runtime-spike.md) — public Pi SDK execution, first-prompt crash evidence, native isolation probe, byte-identical Core extraction and PageIndex source update.
- [Durable inbox and Flash probe](20-durable-inbox-and-flash-probe.md) — persistent input, real Pi crash/recovery/checkpoints, shared control contracts and bounded Flash/bookmark experiments.
- [Native dispatch and I/O](21-native-dispatch-and-io.md) — actual queue/heartbeat/cancel coordination, pinned SDK seams, namespace-backed original tools and remaining execution paths.
- [Flash provider and generations](22-flash-provider-and-generation.md) — finite upstream vendor, installed worker/CLI, immutable generations and raw-reuse optimization with full-data equality measurements.
- [Document Core and Pi bridge](23-document-core-and-pi-bridge.md) — real Library/Flash/Read/image/native checkpoint flow, scoped queued-message frames, per-conversation cancellation and artifact verification.
- [Document process isolation](24-document-process-isolation.md) — Node coordinator plus single-file native PDF boundaries, cache-only grants, syscall probes and exact text/pixel/geometry comparisons.
- [Isolated Pi worker](25-isolated-pi-worker.md) — actual native runtime in namespaces, host model/effect brokers, document tools, private checkpoint verification and cancel/crash evidence.
- [Extension execution and resource trust](26-extension-exec-and-resource-trust.md) — scoped pi.exec, approved byte snapshots, revocation, and the real bwrap early-cancellation race.
- [Namespace lifecycle and HTTP](27-namespace-lifecycle-and-http.md) — shared process ownership, Python pidfds, and real authenticated HTTP submissions/cancellation through isolated Pi.
- [Conversation observations](28-conversation-observations.md) — bounded SSE/reconnect, committed receipts, checkpoint-backed text projection and provisional progress.
- [Paired live chat](29-paired-live-chat.md) — real browser authentication/streaming/outbox, static contracts, and actual isolated Pi browser tests alongside the retained prototype.
- [Managed session reopen](30-managed-session-reopen.md) — durable runtime claims, verified native files, idempotent creation and real clean-restart/cancelled-context tests.
- [Live document admission](31-live-document-admission.md) — immutable upload reservations, Library commits, live source selection and real Pi/Flash/Read to same-revision original PDF.
- [Product selection tickets](32-product-selection-tickets.md) — verified original-page text, durable one-shot groups and native consumption with real browser replay/selection tests.
- [Flash enrichment jobs](33-flash-enrichment-jobs.md) — explicit summary/expand overlays, scoped Pi navigation, shared contract/empty-tree fixes and host-neutral Answer compiler extraction.
- [Product citations and local entry](34-product-citations-and-local-entry.md) — independently attested native citations, original-PDF focus, real Azure Responses compatibility and a supported local Pi Web beta.
- [Research, Compare and preference controls](35-product-research-compare-and-preferences.md) — independent original-PDF cursors, durable Notebook/Record/Recall, and explicit profile controls without a false model-application claim.
- [Native controls and lineage gaps](36-native-controls-and-lineage-gaps.md) — current model/thinking/compact/fork/history/queue seams, selected-head durability and cross-boundary citation gaps; next implementation sequence, not new functionality.
- [PageIndex/SDK follow-up](38-pageindex-sdk-followup.md) — verified stable/source/published-artifact distinctions, local/cloud scope limitations, benchmark coverage and bounded parallel-enrichment candidates; no unreviewed upgrade or paid calls.

The DSH-first ownership and mandatory multi-pane shell in earlier notes are historical design inputs, superseded by
[ADR-021](../docs/adr/021-docatlas-first-pi-runtime.md) and the [current Web specification](../docs/product/web-experience.md).
Evidence, research continuity, personalization and interaction requirements remain active; see the
[module-by-module migration map](../docs/migration/dsh-to-core.md).
