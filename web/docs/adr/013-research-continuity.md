# ADR-013: Cross-Investigation recall is a lead-to-reverify workflow

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

Research Memory becomes dangerous when an old Note, Claim, Decision, or citation is injected into a new answer as if
it still described the current source revision. The same record can be useful as a lead while being stale, outside the
current SourceScope, contradicted by a new revision, or missing its original source. Continuity must preserve that
difference and must not silently broaden the user's selected sources.

## Decision

1. Recall returns bounded typed leads. A lead can influence the plan, but factual use requires exact source admission,
   Locator resolution against its recorded revision, and current evidence re-reading.
2. A `ContinuityLink` connects one prior typed record to one current Investigation and records one state:
   `continuing`, `changed`, `conflicted`, or `unknown`. It separately records verification state:
   `reverified`, `needs-reverify`, `missing-source`, or `outside-scope`.
3. `continuing` is not inferred from lexical similarity. It requires resolved prior provenance plus current evidence;
   `changed` and `conflicted` require explicit old/new Evidence references; otherwise the state is `unknown`.
4. Source inclusion is a user/policy decision through the existing immutable SourceScope CAS command. Continuity may
   recommend inclusion but cannot mutate scope.
5. A new DocumentRevision produces deterministic impact candidates for records referencing the previous revision.
   Candidates mark `needs-reverify`; they do not silently rewrite Claim, Decision, Review, or Artifact status.
6. Accepted continuity and impact decisions are append-only, versioned, idempotent Investigation events. Model output
   remains a proposal until deterministic provenance checks and any required human decision pass.
7. Deletes and source permission loss retract active continuity projections while retaining the minimum audit
   tombstone required by policy. Cross-Workspace lookup is denied before relevance ranking.
8. `Continue OpenQuestion` is a typed transition: the old question remains immutable, and the new Investigation links
   it through continuity rather than copying chat prose.

### State and verification matrix

The state answers a proposition-level question; verification describes whether that answer is currently admissible.
They are not two independent confidence labels.

| State | Required comparison | Allowed verification |
|---|---|---|
| `continuing` | resolved prior Evidence and freshly read current Evidence support the same material proposition under the same relevant basis | `reverified` |
| `changed` | resolved prior and current Evidence show a material value, term, time, definition, or status change | `reverified` |
| `conflicted` | resolved prior and current Evidence cannot both hold under the stated common interpretation; a mere difference in date or definition is not enough | `reverified` |
| `unknown` | the comparison is incomplete, the basis is incompatible, or admission/resolution failed | `needs-reverify`, `missing-source`, or `outside-scope` |

Consequently, a comparative state without both prior and current Evidence is invalid rather than a low-confidence
comparison. Evidence IDs must resolve to current, non-withdrawn `EvidenceAtom`s and exact resolved Locators. Their
document, revision, representation, and representation content hash must match the corresponding source side.
`ResearchRecallLead`, Note text, previews, similarity, and model confidence never satisfy this gate.

### Authenticated SourceScope gate

The wire object names a `scopeVersionId`, but a client-supplied ID is not proof of admission. Before accepting
`reverified`, the Host loads the active immutable `SourceScopeVersion` through the authenticated DSH Connection and
checks all prior and current source identities against it. The Host also checks that the scope belongs to the exact
Workspace and current Investigation. Evidence is freshly read under that same scope version. The semantic contract
therefore accepts a Host-only validation context containing IDs, source identities, and resolution/status fields but
never quote text, paths, or credentials.

If any required old revision is outside the active scope, continuity returns `unknown/outside-scope` and may propose a
normal SourceScope CAS action. It cannot include the source itself. If the source is admitted later, assessment is a
new idempotent request over the new scope version. A missing or denied source remains `unknown/missing-source`; cached
text cannot upgrade it.

### Revision impact and cursor identity

Revision impact classifies an immutable, stable-order snapshot of record IDs against one exact predecessor and one
exact successor source identity. The Host resolves each record's durable source references before classification:

- an exact predecessor reference that is available becomes `needs-reverify`;
- an exact predecessor reference that is no longer available becomes `missing-source`;
- a record with no exact predecessor reference is `unaffected`.

No status is inferred from display name, page number, or document similarity. Pages preserve request order, contain no
duplicate or foreign record IDs, report a stable total, and use an opaque cursor bound to Workspace, both full source
identities, record order, limit, and snapshot. A cursor replay with any changed identity fails; a complete scan
classifies every requested record exactly once. Impact classification only marks downstream records stale or pending;
it never rewrites their conclusions or silently attaches the successor revision.

## Consequences

- Prior work can reduce repeated search without becoming self-supporting evidence.
- A revision change has a bounded, auditable blast radius instead of forcing a full workspace regeneration.
- `unknown`, `not-found`, and `negative` remain distinct outcomes.
- Longitudinal evaluations can score admission, re-resolution, change/conflict detection, and abstention separately.

## Required verification

- same-Workspace cross-Session and cross-Investigation continuity succeeds; cross-Workspace fails before ranking;
- outside-scope lead cannot become `reverified` without a matching committed SourceScopeVersion;
- continuing/changed/conflicted states require current, resolved, source-matching prior and current Evidence references;
- `unknown/reverified` and comparative/non-`reverified` pairs fail closed;
- new revision impact marks only records that reference its predecessor revision;
- paginated impact results retain exact source/request identity and classify the stable record snapshot once;
- deleted/missing/stale sources never produce a current factual support edge;
- financial, contract, research, and audit longitudinal fixtures distinguish all four continuity states.
