# DocAtlas Core

Status: storage extraction and bounded product integrations implemented. Five existing source/library/research/claim/review/continuity/profile
modules initially moved byte-identically with their pure tests into src/storage. The legacy DSH files remain re-exports.
Library/Scope application and document operations/ports are now extracted/implemented under src/document. Preparation
pins source snapshots; native consumption activates the current frame. Read/image/tree results are checked against
scope/hash/policy before delivery. Verified selections, host-attested Answer compilation, research/Recall, human Claim/Review,
Continuity and explicit personalization have product adapters; full native attribution, quality and recovery acceptance remain open.

ADR-052 adds independent human Note/Question and governed Decision/Policy authoring, complete reads, exact-source overlays and
same-transaction minimal command receipts. SourceScopeStore schema v5→v6 adds projections to the existing domain database and canonical
journal, with a verified v5 backup before upgrade and atomic rollback on failure. Original source identity/hash and conversation authority
survive later revisions; legacy mutation APIs cannot bypass the trusted human receipt path. Soft deletion is not privacy erasure.
Migration/rollback tests use temporary databases only; no user's existing data was migrated. Never relabel a v6 database for an old v5 binary.

ADR-053 adds explicitly requested v2 Flash enrichment with stable two-call frontier/DAG batches, one shared reservation bank and
actual-provider joins; missing recipe remains serial v1. ADR-054 adds reference-only invitation and accumulated-choice records to
the existing profile journal. Profile metadata v2→v3 is backup-first and preserves the erasure epoch; malformed v2+ epochs are rejected.
Three unopposed independent investigations may form a pending candidate, never automatic activation. Old command receipts and
candidate support snapshots stay immutable; missing counters/receipts cannot improve apparent agreement, and legacy review paths
cannot bypass the current learning-group checks. See the task board for exact targeted, full and browser verification.

Owns documents/source scope, Evidence/Selection/Answer, research/claims/review/artifacts/continuity, governed
personalization, workflow policy, journals and their runtime/document ports. These are first-class product capabilities,
not state owned by a Pi extension. Planned source areas: `documents`, `evidence`, `research`, `personalization`,
`workflows`, `storage`, `ports`.

Dependencies may include `@docatlas/contracts` and required platform/storage primitives. Core must not import Pi, DSH,
React, a client package, or the legacy plugin. Extract behavior with its tests before renaming schemas or splitting stores.

[Architecture](../../docs/architecture/docatlas-core.md) · [Exact migration inputs](../../docs/migration/dsh-to-core.md)
· [Human research contract](../../docs/adr/052-human-research-authoring.md)
