# Native controls and lineage gaps after the first research workflow

> 2026-09-09 · Read-only current-code audit, not implementation or native-parity acceptance.
> Target remains full Pi capabilities in the DocAtlas-owned product. Installed SDK: 0.85.1 with the reviewed 24-file patch.
> Follow-up: the bounded model/thinking/queue/history portion is implemented under [ADR-048](../docs/adr/048-native-operations-and-history-pages.md).
> Manual compaction/instructions/provable non-application and its PDF browser workflow are now implemented under [ADR-049](../docs/adr/049-manual-native-compaction.md).
> This table records the earlier audit, not current completion; exact verification and remaining automatic in-turn compaction/fork/lineage work are in batches 22–23 of the [tracker](../docs/execution-tracker.md).

## What is present

| Capability | Current implementation | Missing product path |
|---|---|---|
| Model / thinking | SDK supports both; worker has `runtime.setModel` | Thinking handler, IsolatedPiWorker wrappers, authorized catalog, durable command/state/HTTP/Web |
| Compaction | Native automatic compaction retained; minimal worker `runtime.compact` | Instructions, operation-specific cancellation, lifecycle/receipt/checkpoint, source attribution |
| Branch / fork | SDK supports navigateTree and runtime fork | Worker session replacement, selected-head durability, manager/catalog CAS, publication lineage |
| History | Text-only projection from a verified native prefix | Cursor paging beyond 100 messages / 262144 characters |
| Steer / follow-up | Real Web/coordinator/driver/native consumption path | Native queue state/modes and full cross-boundary Read/Answer attribution |

Current source anchors: [worker handlers](../packages/runtime-pi/src/worker/entry.ts),
[isolated host worker](../apps/server/src/execution/pi-worker.ts),
[product driver](../packages/runtime-pi/src/product-driver.ts),
[scheduler](../apps/server/src/runs/submission-coordinator.ts),
[history projection](../packages/runtime-pi/src/worker/checkpoint.ts).

## Constraints that change implementation order

1. A model/thinking/compact operation is not a question. Existing `ProductPiCheckpoint` requires submission/user/answer identity. Add a reviewed native-operation contract and exact native-state seal; never manufacture user messages or pretend an old Answer checkpoint proves a new operation.
2. [inspectNativeSession](../packages/runtime-pi/src/worker/session-file.ts) currently seals the last appended JSONL row as its leaf. SDK `SessionManager.branch()` may only change the selected in-memory leaf. Directly exposing navigation would restore the wrong head after close/reopen. Separate immutable file-prefix integrity from selected-head identity before enabling it.
3. [Answer projector](../packages/runtime-pi/src/answer-projector.ts) intentionally returns a gap for compaction, branch summary and additional steering-user boundaries. Keep that fail-closed protection until native consumption → source frame → Read attestation → final Answer attribution is proven. Do not disable native compaction/steering to avoid the gap.
4. Current [RuntimeManager](../apps/server/src/runs/runtime-manager.ts) and [RuntimeCatalog](../apps/server/src/storage/runtime-catalog.ts) bind one worker/session to a binding and clean-restart seal. `ControlStore.rebind()` alone cannot replace this lifecycle. Branch/fork needs per-conversation shutdown/join, verified head, CAS/rebind, driver/document-bridge reconstruction and SSE generation transition.
5. Historical Answer publication remains bound to its original actor/conversation/binding/generation/checkpoint. A branch may inherit a newly authorized read-only history reference, never copy an old attestation into “new Read” Evidence. Trusted resources keep their immutable snapshot lease and approval scope.

## Next implementation sequence

- Shared native-control operation channel and model/thinking controls, serialized with submissions under one writer. Return the actual SDK-effective model and clamped thinking level. Expose only the host broker's authorized model catalog, no caller endpoints/provider objects/credentials.
- In parallel, read-only history paging bound to native prefix/hash/head/generation and native queue state keyed by actual submission/message identity. Existing run-receipt paging is not message history paging; `runtime.snapshot.entries` is not a public response.
- Manual compaction over that lifecycle, retaining SDK instructions/hooks, explicit cancellation, auxiliary model purpose and no automatic replay of an interrupted turn. Compaction summaries remain non-Evidence and create no answer-generation MemoryUse.
- Branch/navigation/fork only after selected-head and replacement/reopen/authorization contracts are implemented together. Keep every native feature in scope instead of offering a misleading smaller substitute.
- Queue mode and exact queued-message operations; never implement individual deletion/editing as “clear all then resend,” and never reconsume one-shot selections.

The audit does not resolve public deployment, provider credentials beyond the configured catalog, cross-workspace resource grants, or unclean runtime takeover. Those retain their explicit plan gates.
