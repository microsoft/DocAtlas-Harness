# ADR-045: Authenticated local Claim/Review workbench

- Status: Accepted — bounded local product integration; full release acceptance remains open
- Date: 2026-09-09
- Builds on: [ADR-044](044-portable-human-claim-review.md), [ADR-039](039-checkpoint-backed-answer-citations.md)
- Scope: `ProductReviews`, `product-review` v1, live `Reviews` and the existing Core/M4 stores

## Decision

Connect the portable human Claim/Review application to the authenticated DocAtlas product and its optional Web drawer. This is a human workbench over existing domain truth, not a new Pi tool, a second Agent Loop, an Evidence database, or an automatic learning workflow. Default chat-first/PDF-only navigation remains unchanged.

The product protocol has six explicit commands:

| Command | Durable effect and boundary |
|---|---|
| `claim-save` | Create a ClaimVersion or CAS revision with explicit support/refutation/qualification/derived-input relations and derivation inputs. Human acceptance is not proof of factual truth. |
| `artifact-create` | Organize selected fixed ClaimVersions into a new Brief or Matrix draft. No automatic review, sign-off, publication or arbitrary rich-text execution. |
| `review-attest` | Persist the human declaration that the listed relevant evidence was reviewed, pinned to the exact Claim/Evidence set. It is not proof that all external conflicts were searched. |
| `review-run` | Execute the installed G0–G4 ruleset. Product callers cannot choose a weaker ruleset or remove required human sign-off. |
| `review-decide` | Append an independent human approval/rejection of one fixed ReviewResult. It does not alter deterministic gates. |
| `artifact-publish` | Publish a local immutable Artifact only through the exact successful Review and required current approving decision. It sends nothing externally. |

Read models are a bounded `review-workspace`, a domain-backed `review-result`, and original-PDF `review-focus`. The shared schema/parser guards reject unknown authority fields, inconsistent owners/scopes, duplicate display identities and invalid focus states. They do not turn well-shaped opaque IDs, request hashes or client fields into authority. Python consumes the shared wire shapes only; it does not acquire a Review service or human authority.

## Frozen workbench scope is not native source admission

The authenticated host supplies actor/workspace/conversation/Investigation, generation, sign-off policy and a sealed immutable workbench frame. Users may explicitly select an authorized historical frame and create/review work in that frame. All new mutations name that exact selected frame; historical references retain their original ownership and scope.

`assertCurrent` means the selected human workbench frame and product binding remain valid throughout this operation. It does **not** mean the user has switched Pi's active document frame. Opening this drawer, selecting history, saving a Claim or publishing an Artifact never calls native source admission, reconsumes a selection ticket, submits a question, or changes the native transcript. A new question still follows the existing exact native-consumption boundary.

Default selection prefers a completed published Answer scope when available. Otherwise a prepared authorized frame may be inspected, but its presence is not advertised as proof of native consumption; only an actual completed Answer gets the corresponding UI label. Empty/unavailable states never use Demo answers or sample research records.

## Canonical Evidence and original-document authorization

- `SourceScopeStore.getCanonicalEvidence(workspace, investigation, scope, evidenceId)` reads the existing AnswerManifest citations or selection-action records. It returns original Evidence/Locator values, original scope identity and capture origins; it creates no second Evidence store and never relabels an old atom for a new scope.
- The read validates contracts, original scope journal identity/hash, selection journal/projection consistency, exact source/revision/representation, text/hash/Locator agreement and capture provenance. Identical presentations may share origins; conflicting same-scope atoms are rejected instead of selecting convenient provenance. Repeated reads in different scopes retain their own captures.
- Product authorization rechecks current source permission, exact representation hash, ownership of the locked scope and access to the original conversation. Answer-origin Evidence additionally passes `ProductAnswers.get`: the private publication must match the same **completed** ControlStore/Pi checkpoint and canonical manifest. Persisted but unpublished manifests are not product Evidence authority.
- Selection-origin atoms remain explicit saved document captures. A Note's body, Recall lead, personal preference, tree summary or arbitrary browser quote is never a substitute for canonical Evidence. A saved Note may reference its distinct original Evidence without becoming that Evidence itself.
- Focus reauthorizes before and after asynchronous source resolution and checks the same capture identity. It opens only the original PDF revision/page; unique verified text can highlight, otherwise page-only/ambiguous/denied remains explicit. No Markdown fallback or browser-supplied filesystem path is accepted.

Private enumeration ports (`listSourceScopeVersions`, scoped `listAnswerManifests`, `getM4WorkspaceSnapshot`) verify the original stores and return detached records to the host. They are not public ACLs or a browser-wide database dump. Product response caps and `truncated` remain explicit; the UI does not offer a complete-material attestation from a truncated list.

Workspace snapshots preserve verified journal order for Reviews/decisions and first-creation order for Artifacts; publication updates the existing Artifact in place in that enumeration, not its durable content/history. Opaque IDs and timestamps do not select the latest Review or the bounded recent window. Legacy standalone Artifact enumeration keeps its original sorting semantics.

## Commands, durability and sign-off

The host hashes the **whole** product command and supplies `commandHash` to Core. Core includes that digest alongside the hydrated M4 request and trusted actor in the existing idempotency input. Product keys are namespaced by actor/workspace/conversation; two distinct product bodies that map to the same narrower M4 action cannot share a successful receipt. Legacy callers may omit the additional digest, preserving their existing replay semantics.

The Web outbox retains the exact body/key plus actor/workspace/conversation/binding/generation/scope in tab-local storage. Refresh does not send it automatically; changing scope never retargets or rekeys it. Only a matching durable receipt or explicit local discard clears it. A local discard does not undo a server commit, and a superseded request cannot clear a newer draft. Session/generation changes fence delayed reads, focuses and results.

The client also rechecks actor/workspace, ready state, binding/native session and generation after asynchronous HTTP/hash work. An old request's 401 cannot expire a newly paired identity. References must be opaque strings, and the receipt's M4 result type must match the original product action before reaching the UI's full effect checks.

Product publication uses the **latest verified journal-order** decision for the pinned Review, including equal timestamps. An older approving ID cannot bypass a later rejection. The existing M4 store does not acquire this stronger product-only policy for legacy callers. After a publication already committed, the exact original body/key may reconcile its original immutable receipt; a new key still fails draft CAS. Rejection does not rewrite or retract already-published history.

## Deterministic checks are not semantic or arithmetic proof

Core retains Claim CAS, provenance, G0–G4 and required sign-off. Review authorizes the actual Claim lineage it consumes, including successors when the deterministic closure requires them; frozen Artifact reads do not automatically expand to all later work. Historical Review access authorizes its recorded checked Claim identities.

Derived Claims must not hide rejected/unreviewed/needs-changes, non-current, proposed/unresolved/stale/withdrawn or cross-scope input Claims behind an accepted output. The deterministic gate follows actual derived input edges, not version-history links alone, and publication checks those input states again after Review. This does not execute or prove arithmetic expressions, propagate every uncertainty automatically, establish semantic entailment, or prove conflict-search completeness. Human decisions and expression/rounding metadata remain visible assertions with provenance.

## Verification and remaining gates

Reported focused checks: Core application 14; canonical Evidence/related store gates group 51 (including 21 canonical cases, strengthened for same-clock/unsorted-ID/reopen ordering); product host 10; Web state/UI 17 and client 28, run together as 45/45; shared Node/static-browser contract checks 90 and Python shape/classification checks 90. Groups overlap and are not an additive acceptance total.

The actual HTTP/Pi integration passed 1/1 (23.36s; journey 19.47s), and the new real browser journey passed 1/1 (39.3s): actual PDF/Read/Pi, authenticated server/storage/original PDF, Brief and Matrix, a committed response dropped then original-key replay, reload, and approve→reject blocking→fresh approval. The provider is explicitly faux; these results do not prove real-model answer quality or human UX acceptance.

The [execution tracker](../execution-tracker.md) records exact whole-workspace and browser results, including targeted follow-up for two legacy test setup/readiness failures. The staged checks must not be described as a single uninterrupted `scripts/check.sh` success. R4-002 remains in progress for broader business/recovery validation. Continuity/revision impact, automatic learning/Probe, full native controls/parity, arithmetic execution provenance, migration/backup recovery and public deployment remain open. This adds local publication, not team sign-off, external distribution or a completed R4–R7 release.
