# ADR-024: Durable product submissions and native completion checkpoints

> Status: Accepted — bounded internal contract verified; not a deployed browser API or full R1 acceptance
> Date: 2026-09-08
> Evidence: research/19 first-prompt SIGKILL gap; canonical product fixtures; new ControlStore/Pi inbox integration tests.
> Scope: new product control v1 only. ADR-023's complete isolation/auth/transport decisions remain proposed.

## Decision

The product persists a bounded submission and its input before acknowledging receipt. Pi remains the only native
conversation transcript. A private SQLite control database records binding/generation, idempotency, run state,
temporary recovery input and native checkpoint references; it is not Research or Personalization storage.

`contracts/product/control.schema.json` introduces independent `product-control.v1` objects: binding, submission,
prepared context, run receipt, native checkpoint and legal state transition. Legacy DSH v1 meanings do not change.
TS/Python shape and semantic checks share fixtures. Python only exposes bindings/validation, not a control RPC or loop.

The request does not accept an actor, filesystem path or runtime session ID. Actor/workspace are supplied by trusted
application authentication. Existing source/selection IDs remain references; preparation must verify authority and
admit all of them together before recording dispatch intent. Recovery resets pre-dispatch prepared work to preparation.

## State and recovery

accepted → preparing → ready → dispatching → running → completed

Cancellation, failure and outcome-unknown are explicit alternatives, not successful completion. The complete graph is
in the canonical schema and its shared fixture. A native `agent_end`/message callback cannot create saved success.

- Duplicate idempotency key + same canonical request returns its existing receipt; different input conflicts.
- One conversation has one writer capability/epoch. Only the hash of its process-local token is stored.
- Lease expiry does not prove the worker stopped and never grants automatic takeover. The lifecycle manager must
  confirm execution termination, then retire/recover the expected epoch. Old callbacks fail capability/CAS checks.
- Accepted/preparing work has not dispatched and may be re-prepared; ready work loses its prepared lease after recovery.
- Dispatching/running/cancelling becomes outcome-unknown after verified worker termination; never automatically replay it.
  Further dispatch is blocked until that unknown run is reconciled through an explicit trusted operation.
- Domain tools will additionally use their own idempotent commit receipts. Native Bash/edit cannot be promised exactly-once.

Successful completion requires a checkpoint bound to the request/submission and the current Pi session: actual native
user entry, successful final answer, current branch/leaf, fully parsed disk content, file hash/length and file/directory
fsync. Disk contents must agree with live Pi entries. The checkpoint is constructed internally, never accepted from a
browser as proof. Partial/error/native command-only outcomes require separate control semantics, not fake assistants.
The control database binds each native session/user-entry pair to at most one product submission, so a previous identical
question cannot be reused as completion proof for a new request. Multi-message/steering attribution still requires adapter validation.

After checkpointed completion the input recovery copy may be logically removed; the original conversation remains in
Pi's file. This is not a claim of forensic deletion from WAL, backups or external copies. Pending/unknown input cannot
be purged as though it were safely archived.

## Persistence/security boundaries

The control DB has its own application ID/schema version, foreign keys, WAL/FULL synchronous transactions, file modes,
bounded pending queue, version checks and shape/hash validation on stored records. Unknown databases/versions and
symlink storage roots are rejected, not migrated automatically. Application-owned directories are required.

This store cannot itself prove OS process termination or source permission. Its internal recovery/transition APIs are
not public authorization boundaries. Product auth, worker/native/credential isolation, permission-aware preparation,
UI approval, SSE replay and normal native command routing remain required before public routes are enabled.

## Review gates

- Shared valid/invalid/semantic fixtures and all state pairs agree in TS/Python.
- SQLite close/reopen, duplicate/conflicting input, cross actor/workspace, writer expiry/forgery, stale callbacks,
  all-or-none preparation, cancellation race, missing/wrong checkpoint, payload tampering, queue/cursor and unknown version.
- Real Pi child SIGKILL before dispatch: input survives and safely executes once under the same native session identity.
- Real Pi child SIGKILL after dispatch intent: input survives, state is unknown, and replay is refused.
- Real successful Pi run: file/directory checkpoint, exact request/entry binding; changed/malformed/oversized native file rejected.

Only this bounded internal contract may be accepted when those gates pass. It does not complete R1, authorize public
deployment, or certify hardware power-loss behavior, every filesystem, every Pi feature, or arbitrary external side effects.

## Acceptance evidence (2026-09-08)

26 shared contract cases pass in each language, including all 100 state pairs in a graph test. Twelve ControlStore tests
and three actual Pi/process integration tests pass; the two crash boundaries await confirmed child exit before recovery.
The full workspace check passes 454 JS tests (one pre-existing skip) and 102 Python tests. A separate legacy browser
rerun passes all six tests. This accepts only the internal contract above; auth/queue orchestration, full native isolation,
steering attribution, browser observation/approval and document-domain settlement remain work in progress.
