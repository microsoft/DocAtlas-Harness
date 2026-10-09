# ADR-009: Answer evidence maps are compiled from the same DSH Agent turn

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

A plain assistant string cannot prove which evidence supports which factual span. Assigning the latest Read result to a
whole answer would create false precision; asking a second model to retrofit citations would create another agent loop,
different intent, and an unlogged authority. DSH persists assistant messages and Tool results as standard Session events,
and exposes one per-message `conversation.chat.assistant-actions` slot.

## Decision

1. DocAtlas adds a conditional system-prompt section to the existing DSH Agent Loop. After `docatlas_read`, the same
   model response wraps each smallest complete factual proposition in a bounded Markdown fragment whose destination
   encodes relation plus Locator IDs. It must include subject and predicate, not only a number or value.
2. DSH's pinned safe Markdown renderer rejects fragment destinations and unwraps their children. The normal Chat answer
   therefore displays only authored answer text; no executable link, raw Locator, HTML, or second transcript exists.
3. A compiler consumes only standard `tool/call`, `tool/result`, and `assistant/message` events from the same turn. A
   result counts only when its call ID belongs to `docatlas_read`, its strict tool meta validates, and its Locator is in
   the active exact document/revision/representation/hash SourceScope.
4. Locator IDs not returned by that Read, malformed markup, duplicate identity, mixed Scope, missing exact quote, and
   all size/candidate overflows fail closed or remain explicitly unresolved. Search candidates and page numbers never
   become Evidence by resemblance.
5. Textual Read Locators become inline immutable EvidenceAtoms. `read-verified` means only that the exact current quote
   and Locator came from the authenticated Read; `relationAssertedBy: agent` records that support/refute/qualify remains
   the model's assertion until a later verifier reviews entailment.
6. Every protocol-wrapped span becomes an AnswerSegment. Ordinary surrounding text remains `unclassified/unresolved`;
   the compiler does not borrow a nearby citation. Explore mode may therefore publish a partial map, while future strict
   Verify/Publish gates must reject unresolved factual or unclassified material.
7. `agent/turn-stopping` compiles and stores the immutable AnswerManifest before `turn/end`. The per-Session
   `docatlas.answers` projection exposes only bounded message summaries after `turn/end`, so the Client never advertises
   a manifest before its store commit and cold replay yields the same actions.
8. Manifests are derived caches in the workspace Investigation SQLite file, keyed by Session + assistant message. Store
   schema v2 migrates known v1 databases idempotently and rejects unknown versions before mutation.
9. The Client contributes one per-message Sources/Evidence-gap action. Its accessible dialog renders exact structured
   segments and asks authenticated `reader/focus` to re-resolve a citation before showing the quote or original asset.
   Errors disclose no source content.
10. The current public and pinned DSH assistant-action owner supplies `messageId` but not `openView`. DocAtlas uses the
    verified in-dialog source view/original link today and accepts a typed optional `openView` seam without DOM clicking;
    when DSH threads that owner action, the same citation hands its typed Locator to the Evidence Desk focus registry.

## Consequences

- There is still one Agent, one user turn, one tool plane, and one durable DSH transcript.
- An answer with a cited amount but uncited subject/page remains visibly partial. This is intentional evidence debt, not
  a parser failure.
- M2 can expose provisional factual-span provenance before the M4 ClaimVersion/review ledger exists;
  `claimVersionIds` remains empty instead of manufacturing dangling Claim objects.
- Renderer allowlist behavior, assistant-action ownership, prompt injection, tool-call correlation, store migration,
  cold replay, real sidecar flow, and real Luna compliance are compatibility/acceptance gates.
