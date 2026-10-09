# ADR-023: Product backend control plane and first live document slice

> Status: Proposed — implementation direction; contract and fault-injection review required
> Date: 2026-09-08
> Basis: user accepted Prototype 01 and requested a carefully designed backend implementation plan.
> Scope: new DocAtlas product only; does not reinterpret legacy DSH wire or data.

## Proposed decisions

1. Build a modular product server with Core, a full Pi execution adapter, a supervised Python document engine and the
   existing chat-first Web. Do not copy Pi's loop, embed DSH's shell, or ship a document-only native-tool preset.
2. Deliver a live vertical slice before all later research surfaces: user PDF → actual answer → verified original PDF →
   selection follow-up → reload/resume; preserve document-free Pi tasks from the runtime foundation.
3. Prefer same-origin HTTP commands, bounded SSE observations and authenticated snapshot/asset reads. The protocol is
   product-owned, not a relay of every Pi callback. Exact schemas/routes are signed with shared fixtures in R1-001b.
4. Use a durable submission inbox and dispatch/checkpoint coordination around the native Pi transcript. Acknowledged
   receipt, runtime acceptance, execution and saved completion are separate facts. A temporary recovery payload is not
   a second permanent conversation log. Never synthesize an assistant or silently replay a side-effectful unknown run.
5. Enforce native I/O and credential boundaries with a real execution backend. Prefer an isolated worker plus scoped
   model broker; prove session persistence isolation and public SDK capability first. Native operations backends are
   an alternative only if they cover every execution path. A cwd, env filter or document hook alone is not a sandbox.
6. Keep domain contracts and stores distinct from run control. Preserve old provenance; version host-bound objects when
   needed rather than putting Pi run semantics into DSH turn/session fields. Extract, then improve; no implicit DB move.
7. Keep original PDF as the citation destination. Evidence admission is server-owned; provisional streaming text and
   untrusted browser quote/bbox do not confer verified support. Geometry must match the actual displayed original page.

## Required engineering decisions before acceptance

| Gate | Evidence needed | Cannot be assumed |
|---|---|---|
| R1-001a | SDK first-prompt/settlement/file timing, crash and unknown-outcome experiments | native callback equals durable commit |
| R1-004a | worker/native/session file/model broker seam, actual OS isolation and termination checks | binaries on PATH mean usable isolation |
| R1-001b | identity/command/observation/submission/recovery/approval schemas with valid and invalid fixtures | prototype state or legacy event names are a production contract |
| R1-002/005 | public npm SDK load and same-policy native parity | matching version/npm engine claim means integrated |
| R2/R3 | receipt-bound citations and selection, original-byte/geometry/permissions tests | a matching page number or browser text quote is evidence |

If the public SDK cannot meet a gate, record the precise seam and smallest adapter/patch with compatibility and update
cost before proceeding. Do not respond by disabling required Pi capabilities or silently weakening isolation/durability.

## Explicit non-decisions

No multi-user hosting, Redis/remote queues, automatic profile learning, PageIndex model pipeline, production data import,
default launcher switch or universal TUI-widget compatibility is approved here. No JSON field/version, SQLite migration
or secret transport is frozen by this proposal. Those require their corresponding review and tests.

## Consequences

The first package is a reproducible SDK/lifecycle/isolation spike, followed by contract fixtures and small working
increments. Later Compare/research/personalization prototypes gate their own modules, not the accepted core journey.
The server remains a product composition layer, not a new general harness platform. Existing DSH tests and launchers
continue to provide a regression/rollback baseline.

Detailed design, execution order, source findings and acceptance matrix:
[Backend delivery design](../architecture/backend-delivery.md).

Subsequent limited acceptance: [ADR-024](024-durable-product-submissions.md) freezes the independent internal control
contract after actual Pi crash/recovery/checkpoint tests. This proposal's full worker/auth/transport gates remain open.
