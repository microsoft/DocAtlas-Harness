# ADR-044: Portable human Claim/Review application over existing domain truth

- Status: Accepted — original Core application port; bounded product integration follows in ADR-045
- Date: 2026-09-09
- Scope: `packages/core/src/research/claim-review-application.ts`

## Decision

`ClaimReviewApplication.handle(request, trustedContext)` extracts the pure authenticated assembly previously held in the DSH `handleM4Request` adapter. It delegates the same nine M4 operations to the already extracted `SourceScopeStore`: Claim record/ledger, Artifact draft/get, conflict-search assurance, deterministic Review run/get, human decision, and Artifact publication. Existing `m4-rpc` v1 fields, immutable version records, G0–G4, compare-and-swap and durable idempotent outcomes remain authoritative.

This adds no store, journal, migration, alternate Agent Loop, or automatic model tool. The historical DSH adapter and its records remain unchanged. The integration exports the application from the existing Core barrel; this does not expose a product HTTP route or model tool.

## Trusted boundaries

- The host supplies the actual human actor, conversation, workspace, Investigation, exact current immutable scope/sources, `assertCurrent`, action authorization and publication sign-off policy. Actor/time/lifecycle and human-confirmed relations are hydrated by Core, never accepted from model/browser fields.
- `authorizeHistoricalScope` grants access to a complete historical frame; `getAuthorizedEvidence` resolves and authorizes canonical saved Evidence with its original Locator and scope provenance. Core rechecks document/revision/representation hash, atom/Locator identity and text checksum. A Note, Recall lead or Profile ID is not an Evidence ID.
- Scope/Evidence authorization occurs before returning historic records and around commits. Cached request-local authorization snapshots are compared again before completion. These ports are deliberately synchronous; a Promise is rejected rather than treated as a successful authorization.
- New mutations remain bound to the current source scope. Authorized historical Claims and their lineage retain their old scope/version fields; a newer submission with a fresh scope ID does not hide the entire old ledger. Historical access does not relabel old Evidence as current support, and is not re-verification. Read-only old Artifact/Review requests name their authorized original scope.
- The deterministic ruleset is the installed M4 ruleset. Requested sign-off requirements must equal host policy, including at publication. Human approval cannot waive a failed/incomplete deterministic Review. User identity participates in the application idempotency input; a different user cannot reuse a key as an approval replay. Host DTOs must namespace new product keys deliberately; this does not reinterpret historical DSH replay keys.
- Pure human derivation activities omit optional DSH provenance. They do not manufacture Pi tool calls, model metadata, or DSH Session history.

## Verification in this slice

Focused tests use a real temporary `SourceScopeStore` and validated saved Selection Evidence, rather than substituting a second fact store. They cover:

- atomic support/refutation Claim assembly and immutable version/CAS behavior;
- Brief and Matrix drafts, deterministic failure before conflict-search assurance, G0–G4 success, required human sign-off and idempotent publication;
- rejection of a sign-off-policy downgrade, altered ruleset, foreign workspace/scope, forged model actor and cross-user replay;
- readable old ledger/Artifact after an authorized same-source new scope, while old Evidence cannot silently support a new-scope Claim or Artifact;
- representation/text hash mismatch, domain-journal tampering, Promise-returning authorization and an actor changing during authorization.

## Not completed here

There is no Pi-product Claim/Review HTTP endpoint, browser work surface, or automatic model Claim/publication entry in this ADR. Product-owned DTO/authentication, canonical Evidence access binding, cross-session UI/recovery behavior and real document/business validation must be integrated and reviewed separately. These Core tests do not complete R4-002 or prove semantic correctness of a Claim, actual completeness of a human conflict search, general Review UX, or production publishing readiness.

## Subsequent product integration

[ADR-045](045-local-human-review-workbench.md) supplies the authenticated local human workbench, canonical capture reads and six product commands without a new domain store or model tool. Its trusted context is an explicitly selected, sealed workbench frame, which may be historical; “current” refers to that human operation's frame, not permission to change Pi's native active source scope. The original historical-scope and no-relabeling constraints remain.

Core additionally accepts an optional host `commandHash` in its existing idempotency input, authorizes the actual deterministic Review closure, rejects invalid derived Claim inputs, and rechecks them at publication. Product-only latest-journal-decision enforcement and tab-local receipt reconciliation are described in ADR-045; they do not rewrite legacy sign-off/replay semantics. These extensions still do not prove arithmetic or close full R4-002 acceptance.
