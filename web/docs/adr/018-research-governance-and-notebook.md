# ADR-018: Research governance is user-authored and Notebook is a bounded projection

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

Research Notes and Open Questions are not enough to represent a project choice or a mandatory research rule. Treating
either as free-form Note text would hide authority, scope, version history, and lifecycle. At the same time, automatically
applying a workspace policy would prematurely decide the still-open inheritance and enforcement design.

## Decision

1. `ProjectDecision` and `ResearchPolicy` are separate typed records created and changed only through authenticated
   browser commands. The Agent-facing `docatlas_record` tool cannot create them.
2. Every mutation must match the live Session's exact Workspace, Investigation, and immutable ScopeVersion. Creation,
   revision, archive, and deletion append a user-authored, versioned Investigation Journal event and use idempotency plus
   compare-and-set for later versions.
3. A Project Decision belongs to the Investigation that created it. A Research Policy records an explicit intended
   `investigation` or `workspace` scope. M3 stores and displays that scope but does not automatically inherit or enforce
   the policy. Those application rules remain a later contract/ADR decision.
4. Deletion leaves a content-free current tombstone while preserving the append-only audit chain. Deleted records are
   removed from Recall and Notebook projections immediately.
5. Research Recall may return either record as an `unverified-lead`: this allows discovery but never turns a decision or
   policy into source evidence. Its reason must keep factual proof and user governance distinct.
6. The minimal Research Notebook is an authenticated, read-only, bounded projection. It supports current-Investigation
   (`working`) and same-Workspace views, typed/status filters, item and character budgets, and generation-bound cursors.
   It returns previews and exact source identities, never filesystem paths, full Sessions, or source content.
7. Notebook labels Note/Evidence/Question/Claim rows as `unverified-lead` and ProjectDecision/ResearchPolicy rows as
   `user-governance`. Neither label is an EvidenceRelation or Review outcome.

## Consequences

- Governance survives Sessions without being conflated with personalization or document truth.
- A future enforcement engine can consume explicit versioned policy records without changing the M3 journal history.
- The first Notebook backend is useful before visual redesign and remains reconstructible from authoritative rows.

## Required verification

- model-authored or path-shaped browser mutations fail shape/authority checks;
- idempotent replay, same-key conflict, stale CAS, archive, deletion, restart verification, and projection rebuild work;
- working and Workspace queries remain isolated, bounded, typed, and cursor-invalidated by projection changes;
- deleting a governance record retracts Recall and Notebook results without mutating canonical document trees.
