import { readFileSync } from 'node:fs'
import type { ConversationSnapshot, NativeSelectedHead, ProductLineageInspection, ProductLineageOperation, ProductNativeTreePage } from '@docatlas/contracts'
import type { LiveState } from '../src/live/client'
import type { NativeControlIdentity, NativeControlStorage } from '../src/live/native-control-state'
import type { LineagePending } from '../src/live/lineage-state'
import { canonicalHash } from '../src/live/state'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: ConversationSnapshot[] }
export async function lineageFixture(kind: 'navigate' | 'fork' = 'navigate') {
  const binding = structuredClone(fixture.valid.find(value => value.kind === 'conversation-snapshot')!.binding)
  binding.generation = 1; binding.version = 1
  const identity: NativeControlIdentity = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId, conversationId: binding.conversationId,
    bindingId: binding.bindingId, generation: binding.generation, nativeSessionId: binding.runtimeSessionId }
  const head: NativeSelectedHead = { version: 1, fileSeal: { version: 1, sessionId: identity.nativeSessionId, transcriptHash: 'a'.repeat(64), byteLength: 1000, entryCount: 4, tailEntryId: 'entry:tail' },
    selectedLeafEntryId: 'entry:prior', contextHash: 'b'.repeat(64) }
  const action = kind === 'navigate' ? { kind: 'navigate' as const, targetEntryId: 'entry:target', summarize: false, instructions: '', replaceInstructions: false, label: null }
    : { kind: 'fork' as const, targetEntryId: 'entry:target', position: 'at' as const }
  const pending: LineagePending = { schemaVersion: 1, identity, operationId: null, request: { schemaVersion: 1, kind: 'lineage-command', conversationId: identity.conversationId,
    expectedBindingId: identity.bindingId, expectedGeneration: 1, runtimeSessionId: identity.nativeSessionId, approvalId: 'approval:lineage', expectedApprovalVersion: 1,
    expectedHead: head, idempotencyKey: 'lineage:original-frozen-key', action } }
  const requestHash = await canonicalHash(pending.request), operationId = 'operation:lineage:one'
  const sourceAfterHead: NativeSelectedHead = { version: 1, fileSeal: { ...head.fileSeal, transcriptHash: 'c'.repeat(64), byteLength: 1600, entryCount: 6, tailEntryId: 'entry:source-marker' },
    selectedLeafEntryId: 'entry:source-marker', contextHash: kind === 'navigate' ? 'd'.repeat(64) : head.contextHash }
  const targetHead: NativeSelectedHead = kind === 'navigate' ? sourceAfterHead : { version: 1,
    fileSeal: { version: 1, sessionId: 'session:child', transcriptHash: 'e'.repeat(64), byteLength: 1200, entryCount: 4, tailEntryId: 'entry:child-marker' }, selectedLeafEntryId: 'entry:child-marker', contextHash: 'f'.repeat(64) }
  const target = { ...binding, bindingId: 'binding:lineage:target', conversationId: kind === 'navigate' ? binding.conversationId : 'conversation:child',
    runtimeSessionId: targetHead.fileSeal.sessionId, branchEntryId: targetHead.selectedLeafEntryId, generation: kind === 'navigate' ? 2 : 1, version: kind === 'navigate' ? 2 : 1 }
  const configuration = { model: { provider: 'approved', id: 'model' }, thinkingLevel: 'high' as const, steeringMode: 'one-at-a-time' as const, followUpMode: 'all' as const }
  const base = { operationId, requestHash, beforeHead: head, sourceAfterHead, targetHead, intentEntryId: 'entry:intent', sourceMarkerEntryId: 'entry:source-marker',
    targetMarkerEntryId: targetHead.selectedLeafEntryId!, sourceConfiguration: configuration, configuration }
  const operation: ProductLineageOperation = { schemaVersion: 1, kind: 'lineage-operation', operationId, sourceBinding: binding, requestHash, request: structuredClone(pending.request),
    state: 'succeeded', version: 3, createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:01Z', errorCode: null,
    result: { targetBinding: target, proof: kind === 'navigate' ? { ...base, kind: 'native-navigation-proof', action: action as Extract<typeof action, { kind: 'navigate' }>, landingEntryId: 'entry:target', summary: null }
      : { ...base, kind: 'native-fork-proof', action: action as Extract<typeof action, { kind: 'fork' }>, forkBasisSeal: { ...head.fileSeal, entryCount: 5, byteLength: 1300, transcriptHash: '1'.repeat(64), tailEntryId: 'entry:intent' }, inheritedEntryCount: 2, inheritanceHash: '2'.repeat(64) } } }
  const inspection: ProductLineageInspection = { schemaVersion: 1, kind: 'lineage-inspection', binding, resource: { approvalId: 'approval:lineage', version: 1, manifestHash: '9'.repeat(64) }, head, busy: false, queued: 0, operations: [operation], truncated: false }
  const tree: ProductNativeTreePage = { schemaVersion: 1, kind: 'native-tree-page', binding, head, view: 'messages', nextCursor: null, entries: [
    { entryId: 'entry:question', parentId: null, type: 'user', preview: '这里只是用户消息预览，不是完整草稿', label: null, depth: 0, onSelectedBranch: true, canNavigate: true, canForkBefore: true, canForkAt: true, origin: null },
    { entryId: 'entry:target', parentId: 'entry:question', type: 'assistant', preview: 'A bounded source-backed answer preview.', label: 'Review branch', depth: 1, onSelectedBranch: true, canNavigate: true, canForkBefore: false, canForkAt: true, origin: null },
  ] }
  const snapshot: ConversationSnapshot = { schemaVersion: 1, kind: 'conversation-snapshot', binding, cursor: { streamId: '11111111-2222-4333-8444-555555555555', sequence: 0 },
    runs: [], nextRunsCursor: null, history: { checkpoint: null, messages: [], hasEarlier: false }, live: [], activity: [], liveIncomplete: false }
  const state = { phase: 'ready', actor: { actorId: identity.actorId, workspaceId: identity.workspaceId }, selected: identity.conversationId, snapshot } as LiveState
  const values = new Map<string, string>(), storage: NativeControlStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) },
    key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
  return { identity, binding, head, target, targetHead, pending, operation, inspection, tree, snapshot, state, storage, values }
}
