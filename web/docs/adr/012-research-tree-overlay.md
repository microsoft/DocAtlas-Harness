# ADR-012: Research state overlays exact document Locators without mutating the canonical tree

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

Research Notes, Open Questions, saved Evidence, and Claim Proposals are easier to resume when visible beside the
source section that created them. Writing these objects back into the parser's canonical document tree would mix
human/Agent research state with source structure, make deletion and correction ambiguous, and recreate the legacy
wrong-document `Page N` failure. Semantic similarity is useful for discovery but is not a safe anchor.

## Decision

1. The canonical parser tree and Block Map remain immutable source-derived data. Research state lives in a separate
   `Research Tree Overlay` read model owned by the Host Investigation database.
2. An overlay item exists only when a journaled selection action already contains a full Locator bound to exact
   document, revision, representation, representation hash, physical page, and selector. No page-only, title-only,
   fuzzy-text, or model-invented anchor is accepted.
3. A record with several Locators produces one deterministic overlay item per Locator. The item says only that the
   research record was anchored there; it does not assert that the record's interpretation is true. Items from the
   current Investigation are the Working layer; same-Workspace items from prior Investigations are the Research layer.
4. The projector consumes validated selection-action records plus current lifecycle state. Edit changes only the
   overlay preview/status. Delete retracts every item for that record. Resolve/archive remain visible with explicit
   status. Unanchored Agent checkpoints remain available through Recall but never appear on the source tree.
5. Overlay tables are disposable projections. Startup deletes and deterministically rebuilds them from the
   hash-verified journal/current rows. Projection damage never changes domain truth.
6. Query authorization is derived from the live DSH Session and exact active SourceScope. Browser input may select
   only an exact source already in that scope, optional physical page, typed record filters, and bounded item/character
   limits. It cannot submit parent/child/tree mutations or filesystem paths.
7. Pagination cursors bind Workspace, Investigation, ScopeVersion, exact source/page, filters, and a hash of every
   matching projection row. Any edit, deletion, or rebuild-visible change invalidates an old cursor.
8. This M3 slice exposes the exact Research Overlay. Working-plan overlays and semantic “possibly related” links may
   be added later, but must use distinct types and cannot masquerade as exact anchors.

## Consequences

- Opening two documents on physical page 2 cannot cross-link their Notes because representation identity is part of
  every query and item.
- Correction/delete immediately changes both Recall and Tree Overlay without rewriting source data.
- A corrupt or missing overlay table is repaired on restart; a corrupt journal or current lifecycle row still fails
  closed.
- The UI can remain minimal while Host behavior, permissions, and future navigation semantics are stable.

## Required verification

- exact document/revision/representation/hash/page and record-type filtering;
- multiple records and Locators paginate deterministically under item/character budgets;
- wrong-source and forged tree mutation requests fail before projection access;
- selection Note edit survives restart and delete retracts overlay and Recall together;
- projection deletion/tampering is repaired from authoritative rows;
- Agent records without Locators never receive guessed overlay anchors;
- canonical document/block tables and sidecar indexes are unchanged by overlay operations.
