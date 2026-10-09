# Architecture decision records

ADRs freeze decisions that implementation and contracts must follow. The
[implementation plan](../implementation-plan.md) remains the execution authority; ADRs provide the durable rationale
for individual boundaries.

As of 2026-09-08, [ADR-021](021-docatlas-first-pi-runtime.md) establishes DocAtlas product ownership and an embedded full
Pi runtime. Earlier host-specific decisions remain valid for the legacy DSH implementation; their domain invariants are
retained unless ADR-021 explicitly supersedes the ownership/transport/UI seam. This does not migrate existing wire data.

| ADR | Status | Decision |
|---|---|---|
| [ADR-001](001-runtime-ownership.md) | Superseded for new product | Legacy DSH ownership; see ADR-021 for the active target |
| [ADR-002](002-document-identity-and-locators.md) | Accepted | Documents, revisions, representations, locators, and evidence use separate immutable identities |
| [ADR-003](003-storage-and-journals.md) | Accepted | Investigation and Personalization use separate plugin-owned SQLite ledgers beside, not inside, the DSH Session log |
| [ADR-004](004-sidecar-lifecycle.md) | Accepted | The Host supervises one negotiated, cancellable document sidecar process with bounded concurrency and explicit recovery |
| [ADR-005](005-authenticated-source-transport.md) | Accepted | DSH Connection serves immutable PDF/page assets by opaque ID with source-scope authorization and bounded Range semantics |
| [ADR-006](006-selection-submission.md) | Accepted | Host stages selections; public composer chips carry stable refs; pre-step claim and request commit bind them atomically |
| [ADR-007](007-library-source-admission.md) | Accepted | Library admission uses bounded, expiring Host candidates and never accepts a browser-supplied path |
| [ADR-008](008-reader-focus-and-dual-cursors.md) | Accepted | Reader focus is Host-resolved; Agent Reads never take over the independent user cursor by default |
| [ADR-009](009-answer-manifest-admission.md) | Accepted | Answer evidence maps are compiled from the same DSH Agent turn without a second model or inferred citations |
| [ADR-010](010-source-scope-overview-and-patch.md) | Accepted | Source categories are Host-aggregated and scope edits use immutable CAS patches |
| [ADR-011](011-record-recall-review-boundaries.md) | Accepted | Typed record, bounded recall lead, and actual review remain separate governed capabilities |
| [ADR-012](012-research-tree-overlay.md) | Accepted | Exact Locator-bound research overlays are rebuildable and never mutate the canonical document tree |
| [ADR-013](013-research-continuity.md) | Accepted | Prior research is a bounded lead that must be admitted, re-resolved, and reverified before factual reuse |
| [ADR-014](014-governed-personalization.md) | Accepted | Personalization uses governed typed effects and a Fact Trace guard; it never changes factual support or publication gates |
| [ADR-015](015-personalization-privacy-deletion-export.md) | Accepted | Profile storage, pause/edit/forget, truthful deletion receipts, and reference-only export have explicit privacy semantics |
| [ADR-017](017-controlled-pdf-reader-and-compare.md) | Accepted | PDF pages use authenticated bitmap + text rails; Compare keeps exact independent source cursors |
| [ADR-018](018-research-governance-and-notebook.md) | Accepted | ProjectDecision/ResearchPolicy are user-only journal records; Notebook is a bounded non-evidence projection |
| [ADR-019](019-claim-review-and-artifact-semantics.md) | Accepted | Immutable claims, evidence relations, G0–G4 Review, human sign-off, and Artifact publication remain separately auditable |
| [ADR-020](020-explicit-document-mention-and-pdf-focus.md) | Accepted | Explicit @document submission prepares Source Scope; verified PDF character geometry drives original-page citation focus |
| [ADR-021](021-docatlas-first-pi-runtime.md) | Accepted target; migration pending | DocAtlas is the product/domain core; embed full Pi execution, preserve prior modules, own the Web and admission lifecycle |
| [ADR-022](022-prototype-first-delivery.md) | Accepted | Prototype-first UX review before runtime/Core migration; real local PDF interaction, clearly scripted answers, authenticated static preview only |
| [ADR-023](023-product-backend-control-plane.md) | Proposed; engineering gates pending | Product server/control plane, first live document slice, durable inbox/checkpoints and real Pi/native/model isolation |
| [ADR-024](024-durable-product-submissions.md) | Accepted; internal scope only | Independent product-control v1, durable input, fenced writer/state transitions and real native completion checkpoints; not full product auth/runtime acceptance |
| [ADR-025](025-native-io-and-submission-dispatch.md) | Internal implementation reviewed; full security gate open | Pinned SDK I/O/message seams, original native tools in namespaces, queue/heartbeat/cancel coordination; remaining extension/worker/network gates explicit |
| [ADR-026](026-flash-provider-generations.md) | Accepted for internal opt-in raw/merge only | Finite Flash vendor, immutable generations and isolated worker; cached merge equivalence; enhancement/default quality/product gates remain open |
| [ADR-027](027-document-application-and-pi-tools.md) | Accepted for internal document integration | Portable Library/Scope/Node ports, exact native-message scope activation, real Pi Read/images/tree; public HTTP/full isolation and Answer/selection gates open |
| [ADR-028](028-document-process-isolation.md) | Accepted for internal Linux document path | Whole Node coordinator namespace + one-file PDF worker, cache-only readers, kernel/resource boundaries and algorithm equality; full Pi/product/cross-platform gates remain open |

An accepted ADR is changed by a superseding ADR, not by silently editing runtime behavior around it.

[ADR-041](041-product-research-and-capture-scopes.md) adds Core-owned research capture scopes, Pi Record/Recall, private native
provenance and authenticated Notebook operations without granting new document admission or evidence support.
[ADR-042](042-explicit-product-personalization-controls.md) adds explicit profile controls; model application and automatic learning remain unconnected.

[ADR-037](037-product-selection-tickets.md) adds verified, durable one-shot selection tickets for live Pi submissions;
it does not change legacy DSH selection markers or turn Reader text into canonical Evidence automatically.

[ADR-036](036-live-document-admission.md) connects bounded PDF upload/Library admission and original-byte Reader routes
to paired live conversations. Original previews do not constitute selection tickets or verified answer citations.

[ADR-035](035-managed-session-reopen.md) adds managed ownership and exact native-file reopen after verified shutdown.
An active/unclean claim is not a TTL lease that can be silently stolen; crash-supervision acceptance remains open.

[ADR-034](034-live-chat-client.md) adds a distinct paired live browser client, static validation and scoped uncertain-submit
outboxes. Real browser/isolated-runtime tests do not imply a deployed product or completed PDF workflow.

[ADR-033](033-conversation-observations.md) adds bounded SSE/snapshot observations over the authenticated product boundary.
It does not turn live text or event replay into durable history or authorize a new execution on reconnect.

[ADR-031](031-shared-namespace-lifecycle.md) centralizes namespace termination, and
[ADR-032](032-local-authenticated-http.md) freezes initial product pairing/HTTP commands. Both are internal acceptance,
not a default launcher switch or completed Web/Reader/approval/stream surface.

[ADR-030](030-extension-execution-and-resource-snapshots.md) adds loader-scoped pi.exec, approved immutable resources and
early namespace cancellation. Internal Linux acceptance does not close the full project/provider/auth/Web gates.

[ADR-029](029-pi-worker-and-model-broker.md) implements the internal isolated Pi worker/model/effect bridge; full controls,
trusted resource policy, provider parity, auth and deployment gates remain open.
