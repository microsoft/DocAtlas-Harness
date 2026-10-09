# ADR-008: Reader focus is Host-resolved and user/Agent cursors are independent

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

DSH tool results already persist bounded, revision-bound Locators. A citation or Agent Read should make its source easy
to inspect, but it must not let an untrusted browser page number select evidence, move a user's reader unexpectedly, or
highlight a plausible-looking passage after a revision changes. DSH 0.1.2 adds an opaque one-shot View focus handoff;
the public rc.2 baseline still exposes the View and Session projection without that handoff.

## Decision

1. `userCursor` and `agentCursor` are different presentation states. The user cursor owns the main reader. The Agent
   cursor is derived from the latest standard `docatlas.tools` projection and survives cold replay.
2. Agent Reads never move the user cursor by default. “Follow once” moves for one verified result; persistent Follow is
   opt-in and pauses as soon as the user changes document or page.
3. A DSH focus value remains opaque to the View shell. The current vertical slice uses the immutable `locatorId` as the
   focus ID and looks it up only in typed, authenticated projection data. It never decodes JSON or a filesystem path
   from the focus string.
4. The Client sends `focusId + DocumentLocator` to authenticated `reader/focus`. The equality between focus and locator
   IDs is a contract invariant; the Locator is an assertion, not authority.
5. The Host rechecks live Session/Workspace membership and exact document/revision/representation/hash authorization
   against either the active SourceScope or the current Library revision before calling sidecar `resolve`.
6. Candidate disclosure is fixed at five. A resolved target, every candidate, and optional Library document metadata
   must remain in the requested source/workspace identity. Permission errors disclose no filename or quote.
7. Only `resolved` moves to an exact target; `page-only` may move to the verified physical page. `stale`, `ambiguous`,
   `missing`, and `denied` never move or highlight. Ambiguous candidates require an explicit second activation.
8. A unique exact match in an original Markdown/plain-text source may be highlighted. PDF focus is completed by the
   controlled bitmap + extracted-text rail defined in ADR-017; it must not claim a region overlay without real
   coordinates.
9. Client loading, focus resolution, document changes, and asset reads are abortable and generation-checked. A late
   result cannot overwrite a newer cursor.

## Consequences

- Citation actions added by AnswerManifest can call `openView('docatlas', locatorId)` without defining another
  navigation plane.
- The same durable tool projection powers the Agent cursor in rc.2; the one-shot cross-View handoff is additive when a
  newer DSH runtime supplies it.
- Library read permission and Agent SourceScope remain distinct even when the Host reports `access: both`.
- Full PDF bbox/table/figure focus and measured click-to-source latency remain later provider/performance work. The
  controlled Reader shipped in M2-010 is honest about this instead of producing a wrong highlight.

## Required verification

- same page number in two documents cannot cross-focus;
- wrong Session/workspace/revision/representation/hash fails before sidecar execution;
- malformed focus/locator identity and sidecar identity drift fail closed;
- default Agent Read leaves the user cursor unchanged; follow-on, follow-once, and manual-pause transitions are tested;
- stale/ambiguous/missing/denied never produce a highlight;
- exact text highlight requires one unique match in original bytes;
- cold projection exposes the same Agent cursor after reload.
