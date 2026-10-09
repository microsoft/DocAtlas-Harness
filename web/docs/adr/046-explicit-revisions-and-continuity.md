# ADR-046: Explicit document revisions and source-grounded Continuity

- Status: Accepted bounded local implementation; real-PDF/Pi browser journeys verified, full acceptance/recovery limits below
- Date: 2026-09-09
- Extends: [ADR-036](036-live-document-admission.md), [ADR-039](039-checkpoint-backed-answer-citations.md), [ADR-045](045-local-human-review-workbench.md)

## Decision

Add explicit upload-as-new-revision and authorized history to the product, then use exact prior research versions and newly read source material for Continuity. Neither filenames nor personal preferences establish a version relationship. This is not an automatic textual/semantic diff or a change to the Pi loop.

The existing Library document/revision/representation stores remain canonical. Add the optional `LibraryImportRequest.revisionTarget = {documentId, expectedCurrentRevisionId}` to the reviewed v1 Library request; omission retains the existing import path. The complete request, including this target, participates in the existing import idempotency hash. Old payloads remain valid; older binaries may reject the new optional capability and must not receive it without the updated contract/runtime.

An authenticated product command names only an owned upload, explicit target document, expected current revision, conversation generation and idempotency key. The host supplies actor/workspace/session and a captured authorization callback. Recheck it around asynchronous materialization/ingest and immediately before committing. Final target compare-and-set, revision/source association and current-pointer update occur in one transaction. Keep immutable content-hash upload paths; do not overwrite a source file, pre-bind a path, move an existing revision to another document, or rewrite old Evidence.

Matching current bytes may reuse the exact current revision. Bytes already belonging to another document cannot be reassigned. Re-import of a historical content hash must be rejected explicitly rather than passed to `ensureCurrentIndex` with the current revision identity. Opening an existing historical revision is a separate read operation, not an implicit rollback.

## Historical original PDFs

Use exact revision and its representations, not the current document's hash/page count. Reauthorize source eligibility and the original conversation/capture where relevant before and after asynchronous reads; check PDF descriptor, byte hash, page and locator identity. A superseded but still authorized revision remains readable. Archived, denied, missing or tampered data must not be replaced by cached text or another revision.

History selection, A/B comparison and upload alone do not admit sources to Pi. Source selections use the full `(documentId, revisionId)` pair and may explicitly include old and new revisions together. A new question still follows exact native consumption; existing answers, scopes, Claims and published Artifacts retain their original references.

## Continuity correctness and authority

Canonical Answer and selection captures use their original Investigation/scope; source collection follows actual derivation inputs as well as direct citations, not unrelated predecessor/successor history. Missing captures or incomplete provenance cannot yield `unaffected`.

The trusted, non-wire `RevisionImpactRecordContext` gains optional `sourceReferencesComplete`. Omission retains the previous complete-reference assumption. The service and validator use the same order: authenticated incomplete references → `missing-source`; complete references not using the previous source → `unaffected`; otherwise missing previous source → `missing-source`, else `needs-reverify`. Missing authenticated record context is an error, not invented ownership. Cursor fingerprints include the complete context.

Product Continuity uses exact record/ClaimVersion/ArtifactManifest IDs. Trusted metadata carries the original scope, complete source/Evidence closure and verified original-conversation references without source text. The host filters authorization before display, counts or pagination; metadata existence alone is not access authority. A bare Claim-chain or Artifact ID with multiple versions is ambiguous and must not select the first convenient version.

The product always freezes `expectedPriorVersion`; Core adds optional `priorRecordVersion` to its existing request/link for backward-compatible callers. A new assessment checks the current record version, and the complete product command hash is part of durable idempotency. Exact original receipts can reconcile after a Note edit without re-assessing or rewriting the old link. They still require current permission on the original record, conversations, sources and completed Read publication. No second Continuity store or event vocabulary is introduced.

Anchored Notes use the existing `ProductResearch` authorization and immutable `ResearchScopeSnapshots` adapter. These capture scopes are not native SourceScopes; pretending they are would hide legitimate prior Notes. Verify original session/actor/scope and locator source metadata, never use Note prose as Evidence. M4 records independently authorize each original command and derivation origin, canonical Evidence and private completed Answer publication.

History enumeration is bounded before record verification, ordered by persisted turn and actual journal append order rather than IDs or wall-clock timestamps. Unrelated denied/missing/stale Answer scopes do not block a valid selected scope; integrity failures are not skipped. `scopeOptionsTruncated` describes omitted historical options separately from `truncated` selected Evidence. Selecting an older exact authorized scope is independent of the recent-options window.

`continuing`, `changed` and `conflicted` remain explicit determinations after both sides have real canonical Read Evidence in the same authorized comparison scope. Note/Recall/Profile and older-scope Evidence are leads, not fresh verification. Source references, deterministic dependency impact and human semantic judgments remain distinct. Never mutate an old published conclusion to make it look newly verified.

The host re-resolves every selected comparative Evidence item against the exact original PDF and checks exact text, record/version/frame and permissions after asynchronous work and before commit. An incomplete source closure permits only an explicit `unknown`, not a comparative state based on the remaining subset. This verifies provenance and user intent, not the correctness of the human semantic conclusion.

## Product surfaces and recovery limits

New `product-library` and `product-continuity` contracts use authenticated opaque references only. Version import/status and history are separate operations: status is strictly read-only, including when the saved intent has an older generation; a null job is not success. Library version selection and a prior-work action never silently admit sources or issue a model call. Human assessment requires an explicitly chosen completed comparison scope, both source sides and Evidence, and an immutable owner/version/body/key outbox. Reload inspects state only; retry is explicit and uses the original key.

The existing malformed legacy superseded-revision projection is accepted only if it matches the verified old shape and an actual successor chain; it is upcast in memory, not written back into historical disk objects or hashes. New revision writes always include the successor identity.

Batch 20 left a known gap between domain revision commit and Library job success. The bounded batch-21 follow-up below addresses this particular gap; status still exposes actual stored state and never repairs or ingests. General crash recovery, old-data migration and backup/restore remain separate acceptance gates.

### Reviewed recovery follow-up (batch 21, implemented and fault-tested)

Close the future domain→job gap with an optional trusted completion port on the existing record transaction: verify the accepted job/session/whole-command hash, CAS and authority inside the transaction, then commit document/aliases, fixed record receipt and job-success image atomically. Do not change the legacy record input hash or introduce a new table/wire version. A post-commit registry failure cannot retroactively mark the canonical success failed; native admission still needs its own fresh validation.

For an existing orphan, only an explicit original-key import may reconcile the same canonical `jobId:record` receipt. Reconstruct and compare the original request hash, exact fixed document/source graph and original accepted-job full command hash before filling in success. Reopened legacy jobs may already be marked failed; this is not evidence that ingest should run again. Never infer success from the latest document/current pointer, timestamps or a TTL. Missing/ambiguous proof leaves the operation unresolved. Status remains strictly read-only, with no ingest, model call, rollback, source activation or receipt repair.

Focused source/host/legacy tests now verify rollback at job-success write, preservation after post-COMMIT/registry failure, reopened orphan repair for created/updated/reused/alias-linked records, later current revisions, hash/graph/journal/authority tampering and zero repeated ingest. The actual Pi/PDF revision browser journey also passes. This is SQLite transaction/fault and reopen evidence, not proof of every abrupt-host-death or hardware-failure scenario.

## Scope and acceptance

Verification includes source association/CAS conflicts, duplicate bytes, historical PDF focus and exact bytes, old/new selection, prior-work permissions, missing derived provenance, real Pi rereads, explicit Continuity links, lost-response reconciliation/reload and unchanged old records. The two new actual Pi/PDF browser journeys passed; their model wording is scripted, not a real-model quality benchmark. Broader check failures and targeted re-verification are recorded separately in [batch 20](../execution-tracker.md), not represented as a single uninterrupted successful full-check invocation. General restart recovery and published-artifact continuity business acceptance remain open.

Series/Collections remain a separate later capability for independently imported materials. Full history paging, large-workspace impact discovery, automatic semantic comparison, general recovery, automatic personalization/Probe and public deployment stay in the full plan until their own gates pass. No new Evidence database, conversation store, Python loop or model credentials are introduced here.
