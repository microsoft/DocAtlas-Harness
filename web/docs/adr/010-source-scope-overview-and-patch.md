# ADR-010: Source scope visibility is Host-aggregated and mutation is a CAS patch

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

Library membership, current Agent authorization, actual retrieval, and final citation are different facts. A Client that
paginates Library rows cannot safely count those categories or re-submit a complete SourceScope: unloaded rows would be
silently removed, and historical revisions would be confused with the Library's current revision.

## Decision

1. The Host returns one bounded Source Scope overview with exact counts for `eligible`, `included`, `used`, `cited`, and
   `excluded`. `candidate` has an explicit completeness state; until a real provider/watchlist inbox exists it reports
   `unavailable/0`, not an inferred Library count.
2. `eligible` means a non-archived workspace Library document with a current active representation. `included` and
   `excluded` come only from the active immutable SourceScopeVersion. `used` folds successful, call-ID-correlated
   DocAtlas Search/Read standard events through the ScopeVersion active at that call. `cited` comes from persisted
   AnswerManifest Locators for the same Session.
3. Overview identity is document + revision. If Library advances, the current eligible revision and an included/used/
   cited historical revision are separate rows. Historical and scope-only rows keep exact representation identity but
   cannot be newly included.
4. The Source Scope drawer never posts the complete Scope. It sends at most 100 disjoint add/remove operations, an idempotency key,
   and the last seen ScopeVersion ID. The Host selects current representations, preserves untouched sources,
   exclusions, roles and policy tags, creates a locked whole SourceScopeVersion, and commits through the existing
   append-journal/current-projection transaction.
5. Policy/permission/out-of-date/duplicate exclusions cannot be overridden by the patch route. A user exclusion may be
   re-added. Removal records a user exclusion. The active scope cannot become empty; explicit Session unbind is a
   separate two-step UI action and retains the Investigation journal.
6. Mutations require workspace membership and an idle live Agent. CAS conflict and retry are explicit; old versions
   remain immutable. Cursor snapshots bind Session, workspace, limit and a Host fingerprint, expire in five minutes,
   and fail on intervening state changes.
7. The scope drawer is a DSH Session-header utility. It shows text labels as well as counts/states, disables mutation
   while the Agent runs, and applies only loaded deltas, so pagination cannot delete hidden rows.
8. Prompt reconfiguration uses DSH's dynamic system-prompt context. At each Agent step the current locked scope is
   materialized by DSH as its ordinary superseding runtime-context user snapshot. DocAtlas does not add a custom
   Session event or a second context history.

## Consequences

- UI, tool authorization, prompt context, reader/citation states, and historical audit share the same revision identity.
- Exact counts require Host scans today (bounded by Library/manifest caps); later normalized projection tables may
  optimize this without changing the RPC.
- Candidate inbox, policy authoring, scope presets, and bulk changes beyond 100 deltas remain later capabilities and
  must not be simulated by relabeling Library files.
