# ADR-011: Record, recall, and review are separate governed capabilities

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

DocAtlas already journals user-authorized Evidence bookmarks, Research Notes, Open Questions, and Claim Proposals.
Treating those rows as a chat transcript, a generic memory blob, or a completed Review would destroy their different
epistemic states. Conversely, leaving them queryable only inside the Session that created them prevents research from
continuing across Sessions in the same Workspace.

## Decision

1. `record`, `recall`, and `review` remain separate surfaces. Record appends a typed domain event; recall returns
   bounded candidates; review checks objects and produces issues/outcomes. Finding an old object is never a completed
   review.
2. The append-only Investigation journal is authoritative. SQLite FTS and future Tree Overlay rows are deterministic,
   disposable projections rebuilt from validated journal/current-domain rows. They cannot create or upgrade facts.
3. M3 recall begins with the four typed records already created under explicit user authority:
   EvidenceBookmark, ResearchNote, OpenQuestion, and ClaimProposal. ProjectDecision and ResearchPolicy require their
   own commands and authority checks before entering the recall index.
4. `docatlas_recall` is read-only and derives Workspace, current Investigation, ScopeVersion, and source authorization
   from the executing DSH Session. The model cannot supply a Workspace, database path, or broader source scope.
5. Every result is an `unverified-lead` with bounded preview, record identity, status, provenance, and exact source
   identities. It never returns whole prior Sessions or source files. A factual use requires current-scope re-read or an
   explicit source-inclusion decision followed by Locator resolution.
6. Cross-Session recall is allowed only inside the same authorized Workspace. Results state whether all, none, or some
   prior sources are in the current immutable SourceScope. Ranking relevance cannot override access or freshness.
7. The first ranker is deterministic Unicode lexical FTS with explicit item/character budgets and query-bound cursors.
   Semantic or hybrid retrieval may be added only after a gold recall benchmark and must preserve the same admission
   and re-verification gates.
8. `docatlas_record` will initially accept only typed checkpoint/OpenQuestion proposals that cannot create accepted
   facts or decisions. The Host derives its idempotency and provenance from the DSH tool call rather than trusting
   model-supplied routing. User-only correction, deletion, policy, decision, and review actions remain authenticated
   Host commands rather than model tools.

## Consequences

- Research Memory becomes a query projection over typed Investigation truth, not another conversation database.
- Closing personalization cannot disable Research Recall; the two ledgers and controls remain independent.
- Old notes can guide work but cannot support an answer without Evidence re-verification.
- Projection corruption can be repaired by rebuild; journal/hash/identity corruption still fails closed.

## Required verification

- v1/v2/v3 databases migrate transactionally to the recall projection and unknown versions fail closed;
- restart rebuild produces identical leads and repairs deleted/corrupt FTS rows;
- same-Workspace cross-Session recall succeeds, cross-Workspace and missing-scope access fail before query;
- item/character/cursor/type filters are deterministic and cannot escape their request;
- source-state classification uses exact document/revision/representation/hash identity;
- model-visible output says lead/unverified and never contains filesystem paths, whole records, or evidence claims.
