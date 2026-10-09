# ADR-052: Human research authoring, direct PDF annotations and governed records

- Status: Implemented with bounded Core/HTTP/Web integration verification; full research/recovery acceptance remains open
- Date: 2026-09-09
- Extends: ADR-018/021/037/041/044/045/046/050

## Product decision

Connect the existing research domain as an independent human workspace: free or PDF-anchored Note/Question, typed Decision/Policy, complete-record editing, versioned lifecycle, working/workspace filters and read-only original-source overlays. Preserve the chat-first homepage. Selecting text in either original PDF offers independent “add to question” and “save to research” intents; saving neither requires nor modifies a pending question, its selected sources, one-shot ticket or Pi execution.

Note/Question prose remains an unverified research lead. A verified saved quote/Locator supports returning to the original PDF, not new Answer/Evidence support. Decisions and Policies record human governance, not established facts, model sign-off, personalization or automatically enforced instructions. A Policy's investigation/workspace scope is declared intent; automatic inheritance/execution still requires its own review. Do not present this authoring work as automatic learning or all R4 completion.

## Canonical data and migration

Do not forge an Agent `callId`, change `createdBy` in the Agent-only protocol, create an empty SelectionContext, or reuse an Ask ticket to represent free human authorship. Add an independent `HumanResearchRecord` with real human-command provenance. Free records have no anchors. Anchored records contain only actual Core-verified `VerifiedSelectionItem` values, bounded to 8 items/8000 source scalars, plus exact associated source identities; they do not manufacture EvidenceAtoms.

Reuse the same SourceScopeStore domain SQLite and `journal_events` canonical log. A reviewed schema v5→v6 migration adds human-record/idempotency and command-receipt projections in that database, preserving original rows, hashes and existing Agent/Selection/Governance records. This is not a second research content store or a user-data relocation. Old v5 binaries must reject v6 rather than silently ignore human records. Existing backup-before-upgrade, verification/rebuild, lifecycle, Recall/Notebook and Continuity adapters must understand the new family. Test temporary v5 databases and rollback behavior; do not migrate the user's live data during implementation.

Human records retain original conversation/investigation/capture, author, complete command provenance, typed content and explicit associated sources. The new record family participates in existing research lifecycle and FTS/overlays. Direct anchors create `anchor-only` overlays without changing canonical trees. Free Notes, Questions, Decisions and Policies never receive invented page anchors; records without sufficient source support remain incomplete leads for factual Continuity use.

## Explicit context; no hidden admission

Creation freezes `sourceRefs` and PDF selection proposals in the complete browser command. Free creation defaults to no sources; do not silently attach the open Reader, next-question selection or last consumed Pi frame. The host authorizes exact source revisions/representations and independently verifies proposed text on the original page. The durable record owns the verified quote and Locator; there is no intermediate Ask ticket to add, consume or cancel.

ResearchScopeSnapshots retains only immutable non-admitting capture scopes. Persist a capture only for an actual human creation, never a query/detail/operation GET. An unused capture after a rejected cross-store write is not a committed record or document admission. A completed effect is established only by its domain transaction/receipt. Capture IDs cannot collide with admitted scopes. Current and original conversations and all associated sources are checked before returning content, counts, cursors and original PDF focus.

## Commands and durable receipts

`human-research.v1` is separate from the legacy `product-research.v1`, Agent record and selection protocols. Browser commands contain only expected binding/generation, idempotency key and typed human intent. The authenticated host supplies actor/workspace/conversation, resolves source authority and computes the complete request hash. The deterministic operation ID is `human-op:` plus SHA-256 of canonical JSON `[actorId, workspaceId, conversationId, idempotencyKey]`; it is not a native Pi tool call.

Creation supports Note/Question (free or verified selections) and Decision/Policy (explicit associated sources, no fabricated anchors). Note/Question use edit/resolve/archive/delete; Decisions/Policies use revise/archive/delete. Resolve applies only to a Question, and mutation cannot change record type. Existing records are authorized in their original source frame before mutation; Governance's legacy adapter receives that original session/scope rather than silently rewriting its dependencies to the current conversation.

Trusted Core mutation context includes human actor, complete product command identity/hash and a synchronous current-authority assertion. Validate before replay, before transaction/write and before commit. The record/domain change and minimal immutable `HumanResearchReceipt` commit in the same domain transaction, including create, lifecycle and governance operations. Store only operation/owner/binding/action/hash/record/version commit metadata in this receipt; it is not a second copy of note content. Failed commit or changed source/CAS cannot publish success.

Exact original-key replay checks the complete hash and original ownership, not only matching text or a timestamp. A read-only operation lookup can return that original receipt across an authorized binding generation, without executing anything or filling deleted prose back into the UI. A new mutation must match the current binding. Soft deletion hides current content/active projections but retains original history; minimal receipts do not imply privacy erasure. Unconfirmed writes remain explicit tab-local outboxes; queries/reload do not resubmit, rebase or invent a new key.

New human Governance also persists its original exact source identities in the same canonical journal event's private `humanCommand` metadata. Keep the legacy Governance record wire unchanged; do not recover a new record's source hashes by reading the latest representation. Revisions retain that original set. The marker must point to its same-transaction receipt; a missing receipt is an integrity failure, not an unexecuted command. Both the new human record family and human-created Governance require the trusted commit context on later mutation: legacy endpoints cannot bypass the new receipt path, while old Agent/Selection/legacy-Governance behavior remains supported.

## Public read surfaces

The authenticated research workbench supplies typed/status-filtered working/workspace Notebook pages, complete four-type entry details, original-key operation lookup, original source focus and exact source/page overlays. A bounded preview is never an edit body. Filter permissions before FTS, counts, ranking and cursor fingerprints. Recheck ownership/version/source after awaited PDF verification; accept only record/Locator IDs on focus, never an arbitrary browser Locator/path.

Keep product budgets compatible with the reused Core protocols: Notebook queries allow 1–12000 preview scalars, overlay queries 1000–20000, and both at most 50 items per page. Full entry reads have their own body bound and are not silently replaced with these previews. HTTP replies must additionally match their route's discriminator, target IDs, filter/budget, and—for writes—the complete original command hash/action/version, not merely the same owner.

The browser verifies full response identity and command hash, preserves independent question/research drafts and suppresses late responses/errors after owner or binding changes. Existing research contribution/recall policy and personalization controls remain separate. Human explicit authoring does not grant Agent research contribution or promote personal memory.

## Required verification

Shared Node/static-browser/Python valid/invalid and semantic vectors; v5→v6 backup/migration/reopen/downgrade refusal, transaction rollback, complete receipt/identity/idempotency, human attribution without native calls, all four typed lifecycles, deleted-content filtering, exact-source/current+original permission races, all-or-none PDF verification and source hash changes, safe Recall/Notebook/overlay before counts/cursors, original PDF focus, branch-independent research and no hidden Pi/source/profile writes. Real browser scenarios must save a selection without changing an unsent/uncertain question, create free records without a PDF, revise typed governance, recover unknown writes by original receipt and continue from authorized prior research. Scripted model tests and raw annotation locations do not establish factual correctness or complete production recovery.

Batch25's full workspace check and bounded real-application browser journeys passed; the [execution tracker](../execution-tracker.md) separates the full run, test-only corrections and final focused Web verification. This does not claim full R4 acceptance, preservation of unsubmitted drafts across binding changes, automatic policy application, real-model learning quality or live-user-data migration.
