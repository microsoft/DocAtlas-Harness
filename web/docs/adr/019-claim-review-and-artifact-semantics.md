# ADR-019: Claims, deterministic review, and published artifacts retain separate truth

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

M2 can map an exploratory answer span to a Locator-bound EvidenceAtom, but an atom states only what an immutable source
revision contains. It does not prove entailment, settle conflicting sources, preserve a calculation, or authorize a
deliverable. Likewise, a fluent answer, a human preference, and an Agent recommendation cannot replace a repeatable
publication check.

M4 needs a language-neutral foundation for a Claim Ledger, real Review, and Brief/Matrix artifacts without creating a
second Agent Loop or silently promoting the existing `ClaimProposal` record into an accepted fact.

## Decision

1. `ClaimVersion` is immutable and uses separate chain/version identity. Editing creates the next version; published
   work continues to pin the exact old version. A chain has at most one `current` version.
2. Claim basis is explicit: `document-supported`, `derived-from-claims`, `user-assumption`, `project-decision`, or
   `external-knowledge`. Assumptions, decisions, external knowledge, Research Recall, and Personal Memory cannot
   masquerade as document Evidence.
3. Epistemic status, review status, and lifecycle status are orthogonal. For example,
   `contested + accepted + current` means a human accepted that the scoped materials conflict; it does not collapse the
   conflict into truth. A scalar model confidence does not replace these dimensions.
4. `EvidenceRelation` is the explicit many-to-many assertion between one EvidenceAtom and one ClaimVersion. It records
   support, refutation, qualification, context, definition, or derived input plus coverage. Machine proposals remain
   distinct from a named human confirmation/rejection.
5. `DerivationActivity` pins inputs and outputs, operation, actor, time, and optional tool/model/DSH provenance.
   Calculation additionally requires a reproducible expression and rounding policy. Agent inference pins provider,
   model, and prompt hash.
6. Deterministic Review always exposes the ordered gates `G0-integrity`, `G1-grounding`, `G2-scope`, `G3-conflict`, and
   `G4-publication`. Every issue has a stable code, fixed owning gate, severity, rule, and checked subject. A gate fails
   exactly when it has an open blocker; coverage and the overall decision are derived, not model-authored prose.
7. A deterministic `ReviewResult` is rule-authored and immutable. Its decision is `fail` when a blocker exists,
   `incomplete` when an applicable required check did not run, `needs-human` when all deterministic checks pass but
   policy requires sign-off, and otherwise `pass`. A non-applicable gate is explicit and differs from `not-run`. Agent
   challenge and human `ReviewDecision` are later, separate records; neither may
   erase or rewrite a deterministic failure.
8. M4 artifact content is limited to `brief` and `matrix`. Each material factual span/cell uses Unicode-scalar offsets
   to pin a `ClaimVersion` and visible Evidence IDs. Matrix rows, columns, and cells share the same Claim/Evidence ledger
   as Briefs instead of creating another fact store.
9. Claim uses disclose their basis. Assertions and conflict disclosures include visible Evidence; assumptions,
   project decisions, and external knowledge use explicit kinds and cannot cite document Evidence as if it supported
   them. A conflict disclosure exposes at least one supporting and one refuting atom.
10. A non-draft `ArtifactManifest` pins source-scope version, content hash, deterministic ReviewResult, publication
    actor/time, and any required separate human decision. Failed or incomplete review cannot publish. Subsequent source
    or Claim revisions mark impact and require a new artifact version; they never rewrite a published manifest.
11. `personalizationUseIds` may explain presentation choices, but they never appear in EvidenceRelation or satisfy G0–G4.
    The same facts, relations, derivations, and deterministic gate outcomes must result with personalization disabled.
12. These contracts define domain semantics only. Runtime tools, authenticated commands, journal events, storage
    migration, and UI are integrated separately while DSH remains the sole Agent Loop and Session owner.

## Consequences

- A citation can be source-correct yet fail grounding; a reviewed Claim can remain contested; a polished Brief can
  remain unpublishable. The UI can state each condition precisely.
- Brief and Matrix become reproducible projections over pinned facts, not one-shot model outputs.
- Human sign-off grants publication authority after deterministic eligibility; it is not a waiver that hides broken
  integrity, grounding, scope, or conflict checks.
- Artifact style may be personalized without changing the evidence graph or verifier result.
- Runtime storage must preserve immutable versions and cross-references, and must fail closed on dangling or
  cross-workspace identities.

## Required verification

- strict JSON Schema rejects unknown fields, invalid version lineage, forged human relation review, non-reproducible
  calculation, reordered gates, and draft/publication state mixing;
- semantic validation rejects dangling Evidence/Claim/Derivation references, cross-workspace identity, impossible
  epistemic status, multiple current chain versions, and Personal Memory used as Evidence;
- gate issue ownership, blocker status, coverage arithmetic, decision, and sign-off requirement recompute exactly;
- Brief and Matrix reject dangling rows/columns, duplicate coordinates, out-of-range Unicode spans, hidden conflict,
  stale/rejected/unreviewed published ClaimVersions, and visible Evidence without a valid relation;
- publication binds the exact manifest ID/content hash/source scope and cannot proceed from `fail` or `incomplete`.
