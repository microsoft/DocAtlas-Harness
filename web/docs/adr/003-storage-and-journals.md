# ADR-003: Storage and journals

> Status: Accepted
> Date: 2026-08-30
> Owners: DocAtlas Host domain persistence

## Context

DocAtlas needs durable versions, relations, full-text lookup, transactions, migrations, audit, deletion, and selective
projection for Evidence, Claims, Notes, Reviews, Artifacts, Research Memory, and Personalization. DSH already has an
append-only Session log and a storage-domain abstraction, while the Python sidecar needs content/block caches.

Using one of those stores for every state would blur different lifecycles:

- conversation events are not relational domain transactions;
- document indexes are rebuildable caches, not human review truth;
- Research state is workspace/matter scoped;
- Personalization is profile scoped and must be independently paused, exported, or forgotten;
- browser state is transient and cannot be authoritative.

## Decision

### Use separate truth stores by domain

```text
DSH Session Log
  messages, tool calls/results, approvals, steering, cancellation

DocAtlas Investigation SQLite (workspace scoped)
  source-scope versions, Evidence refs, Claims, Notes, Questions,
  Decisions, Reviews, Artifacts, Research Memory events/projections

DocAtlas Personalization SQLite (profile scoped)
  observations, candidates, memory versions, decisions, uses/outcomes,
  probes, consent/session-policy history

Python document cache/index (revision/representation scoped)
  block maps, FTS, PageIndex trees, extracted text/tables/figures,
  OCR/render cache; reproducible from immutable source + generator config

Private blob store
  source bytes, page images, figures, exported artifacts
```

Investigation and Personalization ledgers are physically separate SQLite databases. The Host may keep a small DSH
storage-domain projection for startup/config discovery, but it is not the complete ledger or Evidence truth.

The DSH-provided Host home or an explicit operator-configured private root determines physical placement. Browser input,
document display names, and model output never choose database or filesystem paths.

### Investigation database scope

Use one database per workspace/matter boundary. Every row includes a workspace identity even when physically isolated;
this is an integrity fence and supports export/import checks. Cross-workspace Research Recall queries are Host-mediated,
permission-filtered reads over explicit databases and are deferred beyond the first release.

### Personalization database scope

Use one database per local profile identity. It contains no source bytes or factual Evidence content. Memory versions
may reference provenance IDs in DSH/Investigation stores, but a reference is not copied source text and cannot support a
Claim. Profile deletion can therefore remove Personalization without deleting workspace research.

### Journal plus projections

Each domain database uses:

1. an append-only event/journal table with stable event ID, aggregate ID/version, actor, timestamp, causation,
   correlation/idempotency key, event type, payload version, and canonical JSON payload;
2. transactional current-state tables for query/read performance;
3. FTS/projection tables that can be rebuilt from accepted domain state;
4. migration metadata and projection checkpoints.

An accepted command appends the event and updates current projections in one transaction. Projection rebuild must be
deterministic. Tree Overlay and Research Recall indexes are projections, never independent truths.

### Concurrency and durability

- one serialized writer queue per database in the Host process;
- `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, bounded `busy_timeout`, and explicit synchronous policy;
- optimistic aggregate versions/compare-and-set for UI edits;
- unique idempotency keys for retried tool/command effects;
- read transactions for consistent snapshot/query responses;
- startup integrity check and migration before serving commands;
- unknown/newer schema versions fail closed rather than being downgraded;
- migrations are transactional where SQLite permits and backup-first for destructive rewrites;
- WAL-aware backup/checkpoint and documented restore verification.

The exact synchronous level and checkpoint cadence are measured under M3 load tests; durability is not weakened silently
to improve benchmark latency.

### Deletion and retention

- ordinary edit creates a new aggregate version/event;
- user-visible delete first creates an auditable tombstone and removes the object from active projections;
- privacy erasure runs a separate authorized compaction/redaction workflow covering main DB, FTS, blobs, WAL/backups,
  and orphaned cross-store references;
- source deletion does not silently make old Claims appear supported; impacted objects become missing/stale/redacted;
- no claim of encryption at rest is made unless an actual encrypted-store implementation and key lifecycle are shipped.

### Boundary with Session and sidecar

- DSH Session records model/user/tool chronology; Investigation records domain truth.
- They cross-reference session/turn/step/call and domain IDs/hashes, not full duplicated payloads.
- A domain write commits before its successful DSH tool result is returned.
- If a process dies after commit but before result, idempotency lookup resolves the unknown outcome.
- Python may return immutable document/index metadata but cannot write Investigation or Personalization databases.
- Client mutations go through authenticated Host commands with versions; Client/localStorage is never journal truth.

### M2 selection-action journal slice

Schema v3 adds the first user-authored Investigation records as `selection-action.recorded` aggregates. Each aggregate
has version 1 and stores a hash-verified immutable action result, exact SelectionContext, Locators, and EvidenceAtoms.
The request nonce is never persisted; only the canonical request hash is kept for idempotent lost-response replay.
Evidence bookmarks, ResearchNote v1, OpenQuestion v1, and ClaimProposal are distinct record types. A ClaimProposal is
deliberately not an accepted ClaimVersion; edits, tombstones, recall/FTS, and Review promotion remain governed M3/M4
lifecycle work. v1/v2 stores migrate additively to v3; unknown versions still fail before mutation.

### M3 Research Record/Recall and Tree Overlay journal slice

Schema v4 added Agent-authored `research-record.created` aggregates for only unverified checkpoints and Open Questions.
Each record binds the exact Session, ScopeVersion and DSH tool call; its call-derived idempotency key resolves a commit
whose tool result was lost. It cannot represent Evidence, an accepted Claim, Decision, Policy or Review outcome.

`research_recall_records` and its FTS5 table are disposable projections over validated selection-action and research
record rows. Startup deletes and rebuilds them deterministically, so missing/tampered recall rows cannot become truth.
Evidence bookmark source text is deliberately excluded from cross-scope FTS to prevent Recall becoming a content
oracle. Workspace backups use SQLite's live backup API, checkpoint WAL, verify quick-check/workspace/journal identity,
and are written mode 0600. v1/v2/v3 stores migrate additively to v4; destructive restore remains an explicit operator
workflow rather than an automatic startup overwrite.

Schema v5 unifies the user-only versioned lifecycle across Agent checkpoint/OpenQuestion records and selection-authored
ResearchNote/OpenQuestion records. Selection lifecycle events advance their original selection-action aggregate rather
than inventing a second version-1 truth. Edit, resolve, archive and delete append `research-record.lifecycle`;
compare-and-set rejects stale clients, and a delete stores a tombstone with no current text and retracts Recall and Tree
Overlay together. The v4 foreign-key layout is rewritten transactionally only after a verified mode-0600 migration
backup; v1-v3 upgrades remain additive.

`research_tree_overlays` is another disposable startup-rebuilt projection. It contains only exact Locators already
validated in selection actions; unanchored Agent records never receive inferred anchors. Current-Investigation rows are
the Working layer and prior-Investigation rows are the Research layer. Query cursors hash every matching projection row,
so edits/deletes invalidate stale pagination. Live backup restore verifies schema/workspace/journal/foreign keys and
refuses to overwrite an existing target database.

## Consequences

### Positive

- clean workspace/profile privacy and deletion boundaries;
- transactional Claim/Review/Artifact state without abusing chat events;
- Research Memory and Tree overlays are rebuildable;
- Personalization can be disabled or deleted independently;
- document caches can be discarded/rebuilt without losing human decisions;
- unknown outcomes and retries can be resolved with idempotency keys.

### Costs

- multiple databases require lifecycle, migration, backup, health, and resource limits;
- cross-workspace queries need explicit orchestration rather than one global SQL join;
- Session and Journal reconciliation needs integrity tooling;
- privacy erasure must traverse projections, WAL/backups, blobs, and references;
- team/cloud sync needs a future replication protocol rather than copying SQLite files while open.

## Rejected alternatives

1. **All state in DSH Session events.** Human UI/domain mutations need relational transactions and the current event
   vocabulary is not an extensible domain database.
2. **All state in one global SQLite file.** It weakens workspace/profile deletion and permission fences and creates a
   larger corruption/migration blast radius.
3. **Research and Personalization in one memory table.** They have different authority, scope, retention, and factual
   non-interference rules.
4. **Python owns the journal.** It would give a document worker user/session policy and browser command authority.
5. **Browser IndexedDB/localStorage is authoritative.** It cannot support Host tools, multi-client consistency, audit,
   or reliable backup.
6. **Vector database as truth.** Embeddings are lossy derived indexes and cannot represent versioned relations/review.

## Required M3/K0 verification

- transactional migration success/failure and unknown-version fail-closed;
- concurrent command serialization, optimistic conflict, and idempotent retry;
- crash points before/after event append/projection/tool result;
- deterministic rebuild of current, FTS, Research Recall, and Tree Overlay projections;
- WAL-aware backup/restore and corrupt-file behavior;
- workspace/profile isolation and cross-scope rejection;
- delete/tombstone/redact/orphan behavior;
- Session ↔ Journal reconciliation and cold replay;
- no Python or Client direct write path;
- no source text in Personalization ledger fixtures.
