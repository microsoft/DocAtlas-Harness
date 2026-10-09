# ADR-006: Atomic selection submission

> Status: Accepted
> Date: 2026-08-30
> Owners: `docatlas-dsh` Host and Web Client

## Context

A user can select text, table cells, figures, page regions, or several non-contiguous ranges and ask the Agent about
them from the resident DSH composer. A selection cannot live only in browser memory, be represented as a page number,
or drift onto a later message after a failed send. It must remain bound to an exact document, revision,
representation hash, and Locator.

The pinned DSH runtime exposes additive `conversation.input.dock` UI, public session-scoped
`slash/input-insert-reference`, and an Input Trigger reference codec. The composer serializes reference chips before
calling its default sink and restores its draft if serialization or delivery fails. It does not expose a plugin hook
that can extend the default-sink transaction or observe its successful commit. Calling `agent.inject()` independently
also cannot prove that the context and the intended direct user message enter the same pre-step.

## Decision

### Host-staged, two-identity selection

The Client stages a proposed selection through authenticated typed RPC. The Host:

1. resolves the current per-session SourceScopeVersion;
2. validates document/revision/representation and representation hash;
3. resolves or creates revision-bound Locators and re-reads bounded selected content;
4. creates a stable `selectionContextId` plus a random 192-bit `nonce` with a ten-minute expiry;
5. stores only a nonce hash alongside the staged context.

The nonce authorizes cancellation and remains in Host + Client transient state. It never enters the composer document
or DSH Session. Read-only prepare/status calls use the stable context ID plus Session binding, so a persisted draft can
rehydrate after a Client reload without recovering nonce authority. The stable context ID is not a bearer credential:
every submit use is session-bound, single-use, scope-checked, and revision-checked.

### Public composer reference, not a DOM patch

The selection tray contributes through `conversation.input.dock`. “Ask Agent” emits the public
session-scoped `slash/input-insert-reference` event with a CAS `TokenSpan` derived from `InputState.draftRev`, inserting
a DocAtlas reference chip at the current draft edge. The chip stores only Session routing plus `selectionContextId`;
its visible label and
clipboard projection are bounded previews.

The DocAtlas Input Trigger source owns the chip codec. Serialization performs a read-only Host status/prepare check
and emits one exact marker containing the stable context ID. A serialization failure blocks the send and DSH restores
the draft. No raw quote, path, nonce, JSON object, or reusable authorization token is encoded in the draft.

The public compile baseline `0.1.1-rc.2` exposes the typed input-dock, scoped `slash/input-insert-reference`,
`InputState` occurrence projection, and `ReferenceCodec`; the pinned `0.1.2-alpha.1` keeps those shapes while extending
the candidate UI. DocAtlas compiles against rc.2 and probes the pinned source behavior that serializes references
before the default sink and retains the draft on serializer failure.

The clipboard/persistence projection is the stable non-secret marker (context ID only). On reload the tray asks the
Host for status, then span-CAS replaces that plain marker with a structured occurrence before submit. The marker may
appear transiently in DSH's standard `agent/inbox/spliced` event because the inbox is the pre-step input; it is removed
before the durable `user/message` and model request. The nonce never enters either surface.

### Pre-step claim and durable commit

The Host handles markers only in direct user input proposed for the first step of a turn. Selection references are not
accepted in steering, plugin injection, tool results, recalled content, or later in-turn steps.

At a prepended `agent/pre-step` waterfall listener, DocAtlas first awaits all downstream admission. Only after they
accept, one synchronous transaction:

1. parses all exact DocAtlas markers and rejects duplicates or malformed near-matches;
2. requires every referenced context to be staged/prepared, unexpired, bound to this Session, and still authorized by
   the exact active SourceScopeVersion and representation hashes;
3. claims all contexts for `(sessionId, turn, step)` or claims none;
4. removes the markers from the direct user text;
5. adds bounded authoritative SelectionContext messages with plugin provenance and stable Locator IDs;
6. returns the accepted decision; because all downstream listeners already settled, none can reject after this claim.

The loop appends the returned messages as standard `user/message` events. On `agent/request`, after those events exist,
the Host commits matching claims as consumed. Recovery reconciles a stranded claim by looking for its stable context ID
in the Session log: present means consumed; absent after lease expiry means staged again. No custom Session event is
introduced and no reusable nonce is persisted.

If any reference is expired, stale, denied, wrong-session, replayed, or invalid, the whole selection set is rejected.
The Client preflights chip status for a useful error and retains the draft; a race at pre-step ends blocked and the tray
requires re-selection. It never silently submits the question without its requested context.

### Context and lifecycle limits

- one context contains 1–16 selections and at most 64 KiB canonical JSON;
- selected model text is bounded per item; larger ranges retain Locators, full content hash/count, and partial preview,
  then direct the Agent to progressive Read;
- at most 16 live contexts per Session and 256 per Host process; oldest expired records are collected first;
- stage TTL is ten minutes; claim lease is one minute and is always reconciled before reuse;
- repeated markers and a context referenced by concurrent submissions fail all-or-none;
- default retention is `one-shot`; `investigation-focus` is an explicit later domain mutation, not an extended nonce;
- “save evidence”, “write note”, and “form claim” are separate typed commands and never implicit side effects of Ask.

### Explicit post-selection actions

Staging or asking does not create durable research facts. The tray exposes four separate authenticated writes:

- `save-evidence` materializes exact, resolved Locator-backed `EvidenceAtom`s and an evidence bookmark;
- `create-note` requires user-authored body plus commentary/hypothesis/scratch type;
- `open-question` requires explicit question text and creates an `open` object;
- `propose-claim` requires statement plus support/refute/qualify relation and remains `proposed`—it is not a
  `ClaimVersion`, accepted fact, Review decision, or published content.

Each write requires the in-memory cancel nonce, a stable idempotency key, an unchanged active Scope, and an unconsumed
selection. The nonce is hashed in memory and only its request hash is persisted. The immutable result, exact Locators,
EvidenceAtoms, and SelectionContext are journaled in the Investigation SQLite store under
`selection-action.recorded`; no DocAtlas Session event is introduced. Lost-response retries replay the exact result,
while same-key/different-request conflicts. Reloaded stable markers may still be asked, but cannot mutate the domain
without a fresh selection restoring one-time authority.

Ask/Explain/Compare/Challenge/Translate/Calculate are intent values on the SelectionContext and all continue through
the one DSH Agent Loop. They do not invoke a second model or silently trigger any of the durable actions above.

## Consequences

### Positive

- a failed composer send does not consume or reassign a selection;
- Session replay carries stable Locator context rather than browser state or nonce authority;
- exact source authorization is rechecked at the last boundary before a model request;
- the resident DSH composer and its queue/cancel/trajectory semantics remain the only submission plane;
- multiple selection chips commit atomically and in visible order.

### Costs

- stage/claim/commit needs Host storage, expiry collection, crash reconciliation, and a typed RPC surface;
- the probed runtime's reference insertion and pre-step seams are required for the full Client path;
- pre-step rejection has only DSH's generic blocked ending, so the Client must preflight and translate domain status;
- a future public composer transaction extension could replace part of this protocol and would require a superseding
  ADR plus migration tests.

## Rejected alternatives

1. **Put selected text in the draft.** Rejected because it loses Locator identity, can be edited, and can flood context.
2. **Persist the nonce marker in the message.** Rejected because Session replay would retain transient authorization.
3. **Consume during reference serialization.** Rejected because the downstream send can fail and restore the draft.
4. **Call `agent.inject()` beside an ordinary send.** Rejected because the two operations have no shared claim boundary.
5. **Replace or monkey-patch the composer/default sink.** Rejected because it is a private ownership violation.
6. **Submit immediately from a selection popover.** Rejected because it bypasses visible draft review and DSH queueing.
7. **Silently drop invalid selections and send the question.** Rejected because the resulting answer would use a
   different evidence scope than the user requested.

## Required M2 verification

- valid text/table/figure/page/multi-range staging resolves exact revision-bound Locators;
- malformed selectors, content-hash mismatch, out-of-scope source, and oversized context fail before staging;
- nonce never appears in composer state, Session events, logs, errors, or telemetry;
- serialization/send failure retains the chip and leaves the context reusable until expiry;
- duplicate, expired, replayed, wrong-session, stale-revision, denied, and mixed-validity sets fail all-or-none;
- concurrent submissions can claim a context only once;
- downstream pre-step reject/throw releases claims; request entry commits after standard user messages exist;
- crash reconciliation distinguishes logged context from an uncommitted claim;
- one-shot context cannot reappear in another message; pinned focus requires a separate audited mutation;
- keyboard, screen-reader label, remove/reorder, multi-tab, reload, queue, cancel, and steering cases pass browser tests.
