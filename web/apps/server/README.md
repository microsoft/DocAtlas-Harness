# DocAtlas server — internal control implementation

Current local launcher: [ADR-055](../../docs/adr/055-login-free-local-web.md) enables login-free loopback access with a server-owned actor, exact Host/Origin, Fetch Metadata and CSRF checks. It does not generate pairing codes, set login cookies or expose `/api/auth/*`. The generic paired adapter below is retained for trusted embeddings and compatibility tests, not the local product UI. Existing per-document/native authorization remains in force; do not expose this local mode publicly.

ADR-037 adds product-owned `SelectionTickets` and `ProductSelections`: authenticated text selection staging resolves
current Library page text through Core/Python and persists exact locators. Preparation binds all selected tickets to one
submission/hash; exact native consumption rechecks and consumes them transactionally. Expired/revoked/foreign tickets
reject the entire group. Ticket quotas/expiry are bounded, but terminal retention/GC and image/table-region support remain
acceptance work. This is not a migration of the legacy DSH selection marker service or canonical Evidence storage.

Status: buildable workspace package with durable ControlStore and real-Pi inbox/crash/checkpoint integration tests.
No HTTP server, authentication endpoint or Web execution service is deployed yet.
`createProductHttpHandler` now implements paired HttpOnly sessions and authenticated submit/receipt/stop over HTTP,
tested with the actual isolated Pi worker. It does not listen by itself or expose uploads, arbitrary RPC, approval writes
or a production Web surface. `ProductAuth.issueBootstrap` is an operator-only, short-lived pairing API (ADR-032).
An optional pre-registered `ConversationObservations` port adds authenticated `GET /api/conversations/:id/snapshot`
(bounded recent receipts, optional `before` receipt cursor) and `/events` (SSE/Last-Event-ID). Snapshots separate durable
receipts, verified native text history and provisional progress. Gaps resync; disconnects do not rerun or stop work. Never
forward the internal raw `runtime.snapshot` to a browser. Full history/branches/cold restore and client integration remain
pending; see ADR-033 for the exact internal scope and limits.
`GET /api/conversations` now lists only the authenticated actor/workspace's existing bindings (32 per page, optional
`after` keyset cursor). It does not create runtimes from browser configuration. `apps/web/live.html` consumes these APIs;
its browser harness uses the real isolated stack with an explicitly faux model, not a production launcher (ADR-034).

`RuntimeManager` composes ControlStore, RuntimeCatalog, approved resources, LinuxExecutor, Pi and optional per-conversation
document services. `POST /api/conversations` uses an idempotent creation key and server-owned runtime IDs/paths. Cold reopen
after a verified clean shutdown loads the exact sealed native JSONL; completed or cancelled submissions are not replayed.
An unclean owner claim or modified/missing native file is not automatically reset. Runtime capacity is bounded; complete
crash supervision/reconciliation, branch administration and a default launcher remain acceptance work (ADR-035).

`UploadStore` + `DocumentHttp` expose explicit paired PDF reservations/transfers/import status, current Library listing and
original PDF reads. Configure dedicated upload metadata and byte roots, `DocumentApplication` with the upload discovery
port, and RuntimeManager document services; keep these roots outside native workspace grants. No arbitrary filesystem path
or generic RPC comes from the browser. Upload budget is 25 MiB/file, 256 reservations/512 MiB per actor/workspace; interrupted
staging after abrupt process death is fenced, not deleted automatically. A cleared browser upload note is not server deletion.
No retention/GC/version-replacement/deployed-service acceptance is implied (ADR-036).
`IsolatedPiWorker` now runs actual Pi in a private Linux namespace with host model/native/document brokers and native
checkpoint verification. This is an internal API, not an authenticated product launcher or full parity acceptance.
Creation now requires a `ResourceStore` approval (actor/workspace/reviewed manifest hash). Only its immutable tree is
mounted into Pi and native effects; the mutable agent directory is not granted. Approval revocation stops the worker.
Capture/approval are private application APIs, not browser filesystem access. See ADR-030 for remaining compatibility gates.

Owns the DocAtlas application composition: Core, Pi adapter, Python document process, authentication/authorization,
run and submission coordination, browser transport, asset delivery, and deployment/storage boundaries.
The product starts here; it is not started as an optional Pi extension.

Core owns domain policy and journals; Pi owns its execution loop and native transcript. Server-specific filesystem,
process, authentication and transport implementations satisfy Core ports. Raw browser paths, credentials in shell/
Python/client, and unbounded event forwarding are forbidden.

Implemented: `storage/control-store.ts`, independent product-control v1, writer epochs/CAS, bounded/idempotent input,
all-or-none preparation references, explicit cancellation/unknown recovery and checkpoint-bound completion. Recovery
methods are trusted application APIs: the caller must actually verify worker termination, not infer it from lease expiry.
Also implemented: `runs/submission-coordinator.ts` (durable queue/heartbeat/cancel/fencing), `execution/linux-executor.ts`
(actual native process/file mounts) and end-to-end internal Pi/Bash/checkpoint tests. Preparation is a required port;
the document-free implementation remains available for generic tasks. `documents/application.ts` now composes the
extracted Library/Scope/Core operations and runtime-document adapters. Document sourceRefs prepare durably and activate
only when Pi consumes the matching native message. Per-conversation process managers keep cancellation separate.
The real SDK fixture drives actual Flash/search/six-mode Read/images/native Bash and a durable checkpoint; its model is
explicitly faux, not answer-quality evidence. Source/image hashes, policy, native session/generation and stale results are checked.
The new document path now has coordinator and one-file native PDF namespaces (ADR-028), while cache-only readers have no
import-source grants. Remaining: full authenticated transport/UI, upload/selection/Answer/Evidence, full Pi/extension/model boundaries,
aggregate quotas, non-Linux equivalent isolation and Web integration.

[Runtime design](../../docs/architecture/pi-runtime.md) · [Migration](../../docs/migration/dsh-to-core.md)

The prototype is now user-accepted. [Backend delivery design](../../docs/architecture/backend-delivery.md) specifies
the first live slice, candidate HTTP/SSE interfaces, durable submission/checkpoint coordination, isolation spikes and
implementation order. ADR-023 is proposed; ADR-024 scopes the internal submission/checkpoint contract and ADR-025 the
native I/O/dispatch seam and remaining safety gates. Do not expose
these methods directly as browser or agent-supplied commands; no production backend launcher exists yet. See
[ADR-027](../../docs/adr/027-document-application-and-pi-tools.md) for the document mapping and its explicit limits.
