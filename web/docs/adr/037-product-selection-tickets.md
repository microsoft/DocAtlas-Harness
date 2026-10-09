# ADR-037: Verified one-shot selection tickets for native Pi submissions

> Status: Internal implementation; complete selection/Compare/evidence acceptance remains open
> Date: 2026-09-09

The browser proposes text, physical page and an exact Library revision. Core verifies the proposal against bounded current
page text, maps whitespace-only layout differences to Unicode scalar positions, then asks the existing resolver to check
those positions against the same representation. Missing, ambiguous, stale, incomplete or cross-page results cannot become
tickets. Verification does not activate a runtime source scope or create Evidence/Note/Claim records.
Each stage owns a cache-only sidecar, never the ingestion source grants. Cancellation retains its concurrency slot until
the actual namespace has joined, without stopping a different conversation or Library import.

The product persists bounded expiring tickets in private application control storage, separate from native history and
canonical evidence stores. Each ticket binds actor/workspace/conversation/binding generation, immutable resolved locators
and verified text. A submission must explicitly include every selected source revision. Preparation atomically binds ALL
tickets to its submission ID/hash; native consumption rechecks the complete group and marks consumption transactionally.
No expiry lease or failed/cancelled run makes the tickets reusable by a different submission. An explicit new selection may
be staged if the user wants a new question. Pre-dispatch recovery can re-prepare the same binding; unknown dispatch never
automatically replays. Ticket expiry, revocation or changed source/policy blocks the whole selection group.

Verified quotes enter Pi as clearly delimited untrusted source data beside the original question, not as system instructions
or a second agent transcript. Failed consumption fences the pipe before subsequent model/document frames. Native
entry identity/checkpoint remains authoritative. Trusted resource startup/input hooks retain their separately approved
capabilities; this is not a claim that extension preflight has no native effects. Existing DSH selection markers and
transient legacy service stay unchanged.

Live offers a bounded multi-selection tray with explicit add, discard, return-to-original and send. Selection IDs participate
in the exact persisted submission/outbox hash, and the tray is locked during uncertain submission. Browser text is not
substituted for expired server tickets. Durable receipt acknowledgement removes one-shot selections from the next question.
No automatic Note, evidence claim or selection pin is implied. Image/table-region tickets, durable investigation focus,
structured answer citations, full Compare and TTL/retention administration remain separate work.
