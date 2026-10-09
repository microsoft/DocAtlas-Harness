# ADR-014: Personalization is profile-scoped, governed, and fact-trace invariant

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas Personalization Kernel

## Context

DocAtlas should learn how a user prefers to find, read, verify, and present document evidence. That state is not a
document fact, an Investigation Note, a Project Decision, or conversation history. A generic profile summary injected
into every prompt would erase provenance and scope, make preference drift difficult to correct, and could allow user
history to change Evidence/Claim verification.

K0-K3 need a contract foundation before any automatic adaptation is enabled. The foundation must support explicit
preferences and controlled pairwise probes while preserving DeepSeek Harness as the only Agent Loop and the existing
G0-G4 Fact Trace semantics.

## Decision

1. **DocAtlas owns the personalization domain; DSH owns execution.** The Personalization Kernel validates lifecycle,
   scope, consent, recall admission, decisions, and use audit. Model-assisted extraction or reranking, if introduced,
   runs through the observable DSH Agent Loop. The Python document sidecar never receives profiles or model credentials.
2. **Profile identity is explicit.** A local installation creates/selects a DocAtlas profile such as `local-default`.
   A DSH anonymous-home UUID, filesystem path, browser state, or document identity is not a person identity. Team/cloud
   identity is deferred until an authenticated actor and ACL exist.
3. **Personalization and Investigation are physically separate truth stores.** Following ADR-003, each local profile has
   its own Personalization SQLite ledger. It contains observations, candidates, immutable memory versions, decisions,
   uses/outcomes, probes, and session policies. It contains no source bytes, document text, Locator, EvidenceRelation,
   Claim support, or Review truth. Opaque provenance IDs may point to DSH or Investigation records but cannot support a
   Claim.
4. **The governed lifecycle is explicit:**

   ```text
   Observation -> Candidate -> user/policy review -> immutable MemoryVersion
       -> scope/consent/status admission -> bounded PersonalizationDecision
       -> MemoryUse -> independent Outcome -> correction/supersession/forget
   ```

   Candidate frequency is not truth. Independent lineage, counter-observations, and outcomes remain separate fields.
   A candidate has no effect until it becomes an active version. Exactly one version in a chain may be current/active;
   edits create a new version and retire the prior version atomically.
5. **Session use and contribution are independent controls.** `MemorySessionPolicy` records `useExisting` and
   `contributeToFuture` as two booleans under direct user authority. All four combinations are valid. Temporary mode is
   `false/false`; disabling use does not delete existing memory, and disabling contribution does not erase provenance
   already retained under an earlier policy.
6. **Every observation has explicit profile, task context, scope, consent, lineage, actor, time, and a bounded source
   reference.** `eligible`, `session-only`, and `ineligible` are distinct retention states. Only eligible observations
   from the same profile can contribute to future memory. A session-policy-based eligible observation is admitted only
   while that exact Session permits contribution. Agent output, PDF/Web/tool text, and repeated model behavior cannot
   identify the user's preference.
7. **Secrets never become Personal Memory.** `secret` is intentionally absent from the durable sensitivity enum, and
   Host-side scanning occurs before persistence. Sensitive content may be stored only when declared by the user,
   explicitly confirmed, and configured for confirmation on every use. An implicitly inferred sensitive candidate can
   only be rejected or held for review; it cannot be promoted. Rule activation is limited to ordinary, low-risk
   renderer preferences.
8. **Memory effects are typed and bounded.** v1 supports answer order, explanation/terminology depth, evidence
   presentation/density, preferred reader representation, artifact format, comparison layout, and challenge depth.
   Personalization may select a renderer or add verification effort. It cannot edit canonical trees, source scope,
   Locators, quotes, EvidenceRelations, epistemic status, contradictions, deterministic Review, or publication gates.
   Source ranking and reading-plan adaptation remain disabled until the M6 non-regression gate passes.
9. **Recall compiles to a `PersonalizationDecision`, never a free-form instruction.** A decision binds the exact active
   memory version IDs, profile, Session/turn/task context, finite effects, one why-used reason per memory, expiry turn,
   exact SourceScope ID, and a baseline Fact Trace digest. Its guard asserts that Evidence support, contradiction
   disclosure, publication gates, and source scope are invariant with personalization on or off. No safe match means no
   decision; recent or semantically similar memory is not a fallback.
10. **Use and utility are separately observable.** Every applied effect creates `MemoryUse`. Preference acceptance,
    correction, dismissal, time-to-evidence, saved steps, and caused-miss are outcome data; use frequency never increases
    source quality. Corrected/dismissed uses point to a new feedback observation.
11. **`PreferenceProbe` is a controlled renderer experiment, not a second answer.** Exactly two variants share the same
    SourceScope, ClaimVersion set, EvidenceAtom set, uncertainty set, conflict set, and Fact Trace digest. They differ on
    one declared axis and both pass the invariant check. Stable variant keys are stored independently of randomized
    presentation order. `both`, `neither`, and `dismissed` cannot create a broader preference. v1 allows at most one
    automatically triggered probe per Investigation; user-triggered comparison is not charged to that budget.
12. **Mutation is user-commanded.** Authenticated Host commands cover session policy, explicit preference, candidate
    review, pause/resume, edit, forget, and export. They use idempotency and optimistic versions. An Agent may later
    propose a candidate through a standard tool event, but it cannot activate, edit, forget, or export the profile.
    No custom DSH Session event vocabulary is introduced.
13. **Inspection is bounded and authenticated.** Personalization Center reads only the active profile's current memory,
    current Session policy, and same-Session Decision/Use history through `personalization-inspect.v1`. It returns
    truthful totals/truncation and never exposes paths, source text, Evidence, or another Session/profile.

The canonical v1 wire roots are `personalization-core.v1`, `personalization-command.v1`, and
`personalization-inspect.v1`. Shape validation and the
TypeScript semantic issue registry are both required; shape success alone does not authorize a state transition.

## Consequences

- A user can receive different document-reading and presentation behavior while the underlying fact graph and Review
  result remain byte-for-byte comparable.
- Preference drift is represented by immutable versions and corrections rather than an overwritten profile summary.
- Why-used, pause, edit, and forget can name the exact state that affected a turn.
- Profile storage, migrations, recall, and user controls add product cost; simple prompt injection is deliberately not a
  supported shortcut.
- Automatic formation thresholds and semantic retrieval remain experimental. v1 can ship useful explicit preferences
  and probes without claiming that unvalidated behavior inference is reliable.

## Required verification

- all four session-policy combinations and exact profile/Session identity;
- unknown fields/versions fail closed, with no browser paths or URLs in commands;
- observation consent, provenance, same-profile scope, independent lineage, and counter-observation checks;
- no secret representation and no implicit sensitive promotion/use;
- immutable version lineage, one current version per chain, CAS conflict, and idempotent retry;
- admission rejects paused/disputed/superseded/deleted, expired, cross-profile, and cross-scope memory;
- every decision has bounded effects, complete why-used mapping, turn expiry, and invariant Fact Trace guard;
- every MemoryUse resolves the exact decision/version/effect and records utility separately from preference;
- mutation tests prove Probe variants cannot change Claim/Evidence/uncertainty/conflict sets or factual gates;
- paired personalization off/on evaluation preserves EvidenceRelations, citation precision, contradictions, G0-G4, and
  publication eligibility.
