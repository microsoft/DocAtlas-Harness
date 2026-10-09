# ADR-015: Personalization privacy controls disclose the real deletion boundary

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas privacy and persistence maintainers

## Context

Personalization persists user-derived state across Sessions, so pause, deletion, provenance, backup, and export must be
more precise than a generic “clear memory” button. The profile ledger may refer to a DSH message, Investigation record,
or external model interaction that has a different owner and retention policy. SQLite WAL files and backups can also
outlive a logical row deletion. Claiming complete erasure while those copies remain would be misleading.

The product also needs a safe way to export and inspect the profile without exposing local paths or copying document
evidence into Personal Memory.

## Decision

1. **Local-only is the default.** A profile ledger and its exports stay under the DSH Host's private, operator-selected
   data root. Browser input, display names, model output, and profile values never choose a filesystem path. Cloud sync,
   team profiles, telemetry, and external personalization providers require a later opt-in capability contract that
   states transmitted fields, retention, identity, ACL, and deletion behavior.
2. **At-rest claims match the implementation.** Plain SQLite/JSON depends on operating-system permissions and disk
   encryption. DocAtlas does not advertise encrypted memory until it ships and tests a key lifecycle. Database files,
   backups, and exports are owner-only where the platform supports permissions.
3. **Retention is decided before writing.** Host secret detection and sensitivity policy run before a durable
   observation, candidate, version, or export is committed. Error messages report only a category and never echo a
   detected value. `session-only` and `ineligible` observations cannot enter future-memory projections. Imported memory
   requires explicit profile, scope, consent, safety scanning, and provenance; import is not trusted because it came from
   a prior DocAtlas export.
4. **Pause is not deletion.** Pause creates the next immutable `MemoryVersion` with `paused` status and removes the chain
   from recall/adaptation. History and provenance remain visible and the user may resume through another version.
5. **Edit is not deletion.** Edit creates a new active or paused version and supersedes the prior current version in one
   transaction. Published artifacts continue to pin any old `personalizationUseIds`; edits do not rewrite history.
6. **Memory-only forget is immediate logical removal.** A user-authorized, CAS-bound command writes a tombstone and
   removes the chain from active, FTS, stable-profile, recall, and pending-decision projections in the same transaction.
   It does not delete DSH Sessions, Investigation records, source documents, provider copies, or historical artifacts.
7. **Profile privacy erasure is a separate authorized workflow.** It immediately disables the profile and removes active
   projections, then compacts/redacts the profile database, FTS tables, WAL/checkpoint state, generated export assets,
   derived excerpts, and managed backups according to retention policy. It fails closed on unknown schema versions or a
   corrupt backup. Completion is not reported until verification succeeds; a scheduled job reports `accepted` rather
   than pretending to be complete.
8. **Cross-store provenance uses an explicit policy.** The user chooses `orphan` (keep an opaque unavailable-source
   reference) or `redact-derived-excerpts` (remove DocAtlas-held derived snippets while retaining an auditable redaction
   marker). A Personalization command never cascades into deletion of a DSH Session, Investigation, source document, or
   model-provider record. The UI may link to the owning system's separate deletion control.
9. **Every forget response is a truthful receipt.** It states target (`memory-chain` or `profile`), mode
   (`memory-only` or `privacy-erasure`), provenance handling, whether active projection removal occurred, and WAL/backup
   disposition. It explicitly states that the DSH Session and provider copies were unchanged. The user must acknowledge
   this external-retention boundary before the command is accepted.
10. **Export is versioned and reference-only.** JSON and Markdown exports contain typed scope, status, version chain,
    consent, use/outcome, and optional opaque provenance references. They do not embed source bytes, document text,
    Locators, EvidenceAtoms, Session transcripts, secrets, filesystem paths, or provider credentials. The Host returns an
    opaque, expiring authenticated asset descriptor with hash and byte length—never a path or bearer URL. Deleted content
    is excluded; a separate audit receipt may state that a tombstone existed. Download uses a same-origin authenticated
    exact-Fetch route bound again to Session, profile, and opaque asset ID with `private, no-store` caching.
11. **Backups are WAL-aware and profile-scoped.** Backup first checkpoints/copies a consistent database, records schema
    and profile identity, uses restrictive permissions, and verifies restore into a non-existing target. A live database
    is never overwritten by an automatic restore. Backup retention and compaction deadlines are shown in privacy-erasure
    receipts.
12. **Memory use never grants authority.** Recalled profile content is untrusted data, cannot request tools or override
    the current user, and never becomes Evidence. Pausing or erasing Personalization does not delete Research Memory;
    deleting Research Memory does not silently alter the profile without the selected provenance policy.

## Consequences

- “Forget” has a smaller but immediate and testable meaning; “privacy erasure” is slower but covers DocAtlas-managed
  physical copies.
- Users see which data owners DocAtlas cannot erase, rather than receiving a false universal deletion promise.
- Investigation and source history remain usable when a profile is deleted, and profile state remains separately
  controllable when a workspace is archived.
- Supporting verified erasure across WAL, backups, exports, and orphaned references requires jobs, receipts, and restore
  tests; a simple row delete is insufficient.

## Required verification

- server-side secret fixtures are rejected without reflecting secret values in logs or errors;
- session-only/ineligible observations never appear in candidates, memory versions, FTS, exports, or prompt context;
- pause/resume/edit produce immutable CAS versions and retract/reinstate recall deterministically;
- memory-only forget atomically writes a tombstone and retracts active/FTS/decision projections;
- privacy erasure covers main DB, FTS, WAL, managed backups, exports, and derived excerpts, including crash recovery;
- corrupt/newer databases fail closed and restore refuses an existing target;
- orphan/redact behavior is explicit for every cross-store provenance reference;
- receipts never claim DSH Session or provider deletion and distinguish accepted, completed, and replayed outcomes;
- export round-trip preserves supported v1 fields, rejects unknown versions, uses an authenticated expiring asset, and
  contains no path, URL, source text, Locator, EvidenceAtom, token, or credential;
- profile A cannot pause, inspect, export, or erase profile B, including under concurrent and replayed commands.
