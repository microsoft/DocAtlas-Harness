# ADR-007: Library source admission uses opaque, expiring Host candidates

- Status: Accepted
- Date: 2026-08-30
- Owners: DocAtlas maintainers

## Context

The Evidence Desk must admit local PDF, Markdown, and text sources without exposing Host paths to browser code. The
pinned DSH Connection provides authenticated exact Fetch routes only for `GET`/`HEAD`; it has no general document-upload
blob seam. Sending a server path or a large base64 document through JSON RPC would weaken trust and resource controls.

## Decision

1. An operator configures absolute `sourceRoots` and `cacheRoot` values on the Host.
2. `library/discover` performs a bounded recursive, no-symlink scan and returns only an opaque random candidate ID,
   configured root alias, basename, media type, size, timestamps, and expiry. It never returns a path.
3. Candidates and pagination cursors are stateful, Session/workspace-bound, capped, and expire after five minutes.
4. Import reopens a candidate with `O_NOFOLLOW` when available, verifies discovery stat identity, hashes the open handle,
   and checks its post-read identity. The sidecar independently enforces root containment, length, media type, and hash.
5. Import is a durable, idempotent background job with `queued → hashing → ingesting → committing → complete` phases.
   Interrupted jobs become visible retryable failures on recovery.
6. Successful document/revision commits and Library projections share the workspace Investigation SQLite database.
   Events are append-only and hash-checked. Exact bytes reuse a logical document; changed bytes at one source binding
   create a new immutable revision.
7. Library membership establishes workspace eligibility only. A separate SourceScope CAS remains required before tools
   or asset delivery can use a revision.

## Consequences

- The first M2 UI browses configured Host roots. Browser upload/drag-drop stays unavailable rather than being emulated
  with an unsafe path or unbounded JSON payload.
- A future authenticated upload seam can become another candidate producer without changing Library, job, deduplication,
  SourceScope, or reader contracts.
- Root aliases and filenames are visible metadata; canonical and relative Host paths remain private.
- A deployment needing more than the M2 10,000-document workspace cap must add operator migration and larger-scale
  pagination before raising it.
