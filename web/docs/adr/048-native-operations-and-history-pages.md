# ADR-048: Durable native controls and verified history pages

- Status: Accepted bounded implementation; real SDK/isolated worker/native history and browser journey verified, limits below
- Date: 2026-09-09
- Extends: ADR-024/029/033/035; preserves ADR-021 native Pi capabilities

## Decision

Expose host-approved model, SDK-supported thinking level, steering mode and follow-up mode as native operations, not fake questions or document submissions. The host remains the only writer and credential holder. Manual compaction, branch/fork controls and provenance across those boundaries remain separate required work; this batch must not remove or misrepresent those native capabilities.

The public `native-control.v1` protocol binds the whole action, conversation/binding/generation, native session, immutable native prefix, resource approval/version and idempotency key. The prefix has no filename or cwd. Model choices come only from the host broker catalog; browser values cannot register endpoints, credentials or resources. Accepted/applying is not success. Native configuration matching a desired value is not proof of an earlier operation.

## Native durability, including before the first question

Pi 0.85.1 does not flush a session without an assistant. Its public branch export is not a full-history persistence API. At normal worker initialization, if the exact native target does not exist, exclusively create it with `O_EXCL` from the public SessionManager header and complete entries, unchanged; fsync file and directory; reopen the same path through public `setSessionFile` and revalidate session identity, complete entries and selected leaf. Never overwrite an existing target, invent conversation entries, alter private SDK fields or rebuild history from product receipts. This requires no new Pi patch.

Metadata-only reopen must explicitly restore model and thinking from the SDK's `buildSessionContext`; queue modes restore from verified committed operation markers. Pi may append its own initialization metadata on such a reopen. Preserve that behavior rather than claiming byte-identical reopen. Empty/no-model startup means no chat/model activity, not absence of native metadata files. Inspection is read-only after ordinary runtime initialization.

Each operation uses native `appendCustomEntry` with custom type `docatlas.native-operation.v1`: a durable **intent** records the complete apply input before SDK setters; a **committed** marker links the intent and effective SDK configuration afterward. Both are metadata, never user/assistant messages. Independent host verification rereads fixed before/after prefixes, input/hash, ordered parent chain, intent/commit identity and actual native model/thinking metadata. A historical proof remains verifiable after later native metadata. Queue settings are recovered only from verified commits. Exact committed replay never repeats setter effects; intent without commit remains outcome-unknown.

## Host lifecycle and recovery

A separate private operational SQLite database stores native command/receipt metadata, not another transcript or domain store. It does not migrate ControlStore v1. Every write verifies the existing conversation WriterLease. There is at most one unsettled native operation per conversation. The SubmissionCoordinator reserves an idle native barrier synchronously before acceptance and dispatch: questions may be durably queued but cannot reach Pi during the operation. Native controls and legacy raw controls share a worker mutex.

Lifecycle is accepted → applying → succeeded/failed/outcome-unknown. Success is immutable and requires independently verified native proof. Any possibly applied or interrupted effect without proof remains unknown and blocks new native effects and submission dispatch, including after restart. Status GET never executes/retries/reconciles. An explicit exact-original-key retry may find a verified committed marker and settle its original result; it never repeats an intent-only effect or guesses from settings/TTL/PID. Safe pre-effect validation failures may fail; uncertain failures may not be relabeled failed to unblock work.

Cancellation, writer fencing and close abort and join native-operation work as well as submission tasks. Existing actual PID namespace, native-file fsync and clean-catalog-release guarantees remain mandatory. Recovery cannot clear an unclean runtime claim on a browser request.

Stop-in-flight is a separate promise/barrier, not inferred from `busy` or `paused`. A cancelled operation may settle before the actual namespace joins; no new native command or submission may resume effects in that interval. Recheck the WriterLease after the FULL-sync applying transaction returns, immediately before dispatch: COMMIT can outlast a lease.

Check cold unresolved operations **before** SDK construction or approved extension factories: model-free startup can still have `pi.exec` side effects. Inspection/observations then use verified read-only projections. Explicit original-key recovery may acquire a metadata writer and already-clean catalog claim, verify the unchanged native file/committed marker and settle the original operation without a worker or factories. Unclean claims/foreign writers remain blocked. After proof reconciliation, an explicit ordinary runtime operation may initialize trusted resources again.

## History without a second conversation store

`product-history.v1` pages come from the actual verified native checkpoint parent chain, not receipt text stitched into an invented conversation. Pages are bounded to 50 messages, 131072 displayed characters and 65536 characters per message. A normal complete message moves to the next page instead of being cut to fill the remaining page budget. Only user and assistant public text is returned; no thinking, system/provider data, tool results or native filenames.

Full native text has an independent `nativeTextHash`. Original human input is restored only by exact ControlStore native-user-entry association and its validated original payload, never text matching. Unknown/purged original inputs are explicit empty `unavailable` placeholders and never fall back to model-prepared injected text. Assistant text is native; submission-origin displayed user text intentionally need not hash to the prepared native text. Bounds are rechecked after this mapping.

Opaque, expiring cursors bind actor/workspace, binding/generation, complete checkpoint and oldest returned native entry. Authorization and head are rechecked after awaited reads. A missing checkpoint returns empty without starting a worker/model. Historical private-file resolution is host-only and does not lazily start a runtime. Cursors cannot silently cross checkpoint/branch changes. Browser history starts with the existing snapshot window and can skip bounded overlapping pages using server-issued cursors; it never replaces 100 visible messages with the newest 50. Verified older messages remain eligible for original published Answer/PDF lookup, with exact hash and checkpoint identity checks. Scroll anchoring yields to user scrolling and owner/head changes.

## Verification required

Snapshot/page projection share visible-native rules before original-user mapping; tool/thinking-only entries cannot create missing-anchor conflicts. Missing human payloads remain unavailable placeholders afterward. The browser reports its simultaneous 2000-message / 8-MiB display limit without truncating/deleting the native transcript; unlimited-history virtualization is not accepted by this batch.

An inspection can precede a later successful operation receipt. After matching and acknowledging success, read the actual settings once again; never project historical proof configuration as current settings or leave a stale busy view after clearing the outbox. Keep the original message anchor through asynchronous older-Answer/citation layout changes, releasing it on user intent or owner/head change. Final full and focused verification is recorded in execution tracker batch 22; manual compaction/fork remains outside this acceptance.

Test first-question-free native persistence/reopen; real SDK settings, unsupported model/thinking choices, full-body idempotency, lost reply/intent-only interruption, resource/binding/writer revocation, no prompt interleaving, actual cancellation joins, independent proof corruption, immutable original-result replay, metadata-only restarts, actual native paging/branch chain, original-user redaction, cursor expiry/auth/head races, page bounds and browser scroll/old PDF citations. Run focused tests before the sole shared integration build and full regression. Record actual results in the execution tracker; this design alone does not complete native parity, recovery or product deployment.
