# ADR-053: Explicitly versioned, bounded parallel Flash enrichment

- Status: Implemented; targeted, final JavaScript/Python and real Pi/PDF browser verification passed within the bounded scope below
- Date: 2026-09-09
- Implementation verification: 2026-09-10, Batch26
- Extends: ADR-026/038/051; research/38

## Decision

Implement the useful ready-frontier/child-before-parent scheduling idea from the pinned PageIndex optimizer inside DocAtlas's existing enrichment application. This is a local recipe optimization, not a new upstream release, a second Agent Loop, a new default ingest provider or permission to upload more documents.

`EnrichmentStart.recipe` is optional and accepts `docatlas-flash-enrichment.v1` or `docatlas-flash-enrichment.v2`. Absence retains the original serial v1 implementation, including previously queued requests and exact-key recovery. New Web enrichment requests explicitly select v2. Result and read-only page contracts recognize both versions; a completed job must match its requested recipe or the implicit v1 default. Request hashes, input seals and recipe-salted enrichment IDs preserve the distinction; no existing generation/result is rewritten. Changing recipe with the same original key remains a conflict. No storage schema or vendor/source pin change is needed.

## Scheduling and resource ownership

V2 freezes its input/request and operates on cloned navigation nodes. Expansion dispatches at most two independent eligible leaves in a stable ready batch. Validate printed headings/ranges/cost exactly as before; join and commit accepted children/decisions in stable source order before opening the next frontier. Summary uses a dependency DAG: a parent becomes eligible only after all selected children are successfully summarized. Short source excerpts remain deterministic zero-model work.

The same whole-job budget bank spans expansion and summary. Before dispatch reserve calls, actual prompt scalars and worst-case in-flight output tokens/scalars. Split available output evenly, using floor shares, among the deterministic batch, respecting per-call caps (2048 output tokens/12000 scalars) and the existing 128 minimum; reduce a batch to one when two cannot be reserved. Source excerpts consume the same output-scalar budget. Charge actual joined output once, reject invalid usage or per-call reservation excess, and release reservations only after the actual provider promise settles. Response order must not change prompt inputs, allocation, node order, decisions or result identity for the same scripted outputs.

At first provider/validation failure, source revocation, cancellation or deadline, stop new dispatch and abort the job-local signal. Await all actual dispatched calls with all-settled ownership before rejecting. A provider that has not joined cannot be released by a timeout race or by another sibling's rejection. The existing host also joins its document backend before completing/cancelling the job. No partial overlay is published. The configured provider's shared request cap remains authoritative; Core has no invented visibility into remaining host capacity and does not raise that cap or create a retry ladder.

## Implementation and targeted verification

The [existing serial entry point](../../packages/core/src/document/enrichment.ts) retains v1 and dispatches only explicit v2 to the [new scheduler](../../packages/core/src/document/enrichment-v2.ts). Request, input and provider identity are frozen synchronously before the first await; provider method binding also cannot change mid-job. This is a local implementation over the existing source/provider identities, not a vendor update.

The following focused commands passed on 2026-09-10:

```bash
bash scripts/pnpmw exec vitest run packages/core/test/enrichment-v2.spec.ts packages/core/test/enrichment.spec.ts packages/core/test/document-enrichment.spec.ts --maxWorkers=2
bash scripts/pnpmw exec vitest run apps/server/test/enrichment-jobs.spec.ts apps/server/test/enrichment-parallel.spec.ts packages/runtime-pi/test/enrichment-model.spec.ts --maxWorkers=2
bash scripts/pnpmw exec oxlint --deny-warnings packages/core/src/document/enrichment.ts packages/core/src/document/enrichment-v2.ts packages/core/test/enrichment-v2.spec.ts
bash scripts/pnpmw exec oxlint --deny-warnings apps/server/test/enrichment-jobs.spec.ts apps/server/test/enrichment-parallel.spec.ts packages/runtime-pi/test/enrichment-model.spec.ts
```

- Source: **20/20 tests** across three files (13 v2, four unchanged serial cases and three navigation cases). Controlled held promises observe peak concurrency **2 for v2 versus 1 for v1**. Reverse completion produces identical result hashes; multi-level summaries match the serial scripted semantics. Coverage also includes recursive expansion frontiers, heading/cost/no-gain rules, aggregate/per-call reservations, one-call fallback, excerpts, invalid output/usage, synchronous dispatch failure, caller mutation and cancel/deadline/source revocation with an abort-ignoring sibling.
- Host/runtime: **13/13 tests** across three files (three storage, three real host lifecycle and seven model-adapter cases). Storage cases reopen absent-recipe v1 and explicit v2, retain exact seals/receipts, reject cross-recipe key reuse and roll back recipe-mismatched completion without releasing its claim. These storage vectors are contract fixtures, not PDF/model-quality results.
- Host lifecycle tests use a real generated six-page PDF, immutable ingest, namespaced cache-only document workers and actual job/control stores; only provider completion promises are held. Cancellation, failure and close keep ownership/capacity until **both the document namespace and every dispatched provider promise have joined**. They verify rejection of another job while both slots remain occupied, no partial publication and no rerun on terminal replay. The Pi adapter test separately verifies two concurrent streams have isolated cancellation and each waits for its own real result promise.
- Both focused lint commands pass. No paid-model call, upstream/source pin change or generated-vendor edit was needed.

## Remaining gates

Final integration is recorded in the [tracker](../execution-tracker.md): 210 JavaScript test files with 2828 passing/one existing opt-in skipped; the corrected Python catalog-list fixture and remaining checks passed in the separately rerun Python tail (1450 tests), followed by vendor and packed provenance checks. Both final-artifact Flash browser cases and the legacy Probe journey passed. The actual Azure synthetic-PDF citation smoke also passed with three calls; it is separate from Flash model/corpus quality. The loopback service was started and its HTTP/auth boundary checked. These combined results are not a claim that the earlier stopped full-script invocations exited successfully.

The observed concurrency is not an elapsed-time speedup benchmark. Real-model latency/cost/quality, a rights-cleared real corpus, OCR/complex layouts, full fallback quality and unclean-job recovery remain R5/R7 gates. This ADR does not change Evidence, original PDF geometry, canonical trees, source admission or the Pi transcript.
