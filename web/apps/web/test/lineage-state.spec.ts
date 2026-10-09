import { afterEach, describe, expect, it, vi } from 'vitest'
import { acknowledgeLineageOperation, bindLineageOperation, checkedLineageInspection, checkedLineageOperation, lineageAction, lineageCanActivate, lineageDraft, lineageHeadKey,
  lineageOperationMatches, lineageOutboxPrefix, lineageStorageKey, lineageTerminalProof, mergeLineageTree, parseLineagePending, readLineageOutbox, saveLineagePending } from '../src/live/lineage-state'
import { lineageFixture } from './lineage-fixture'

afterEach(() => vi.restoreAllMocks())
describe('exact lineage ownership and original-key outbox', () => {
  it('retains the whole old selected head/body/key across a source-generation change without rebasing', async () => {
    const test = await lineageFixture(); saveLineagePending(test.storage, test.pending)
    const raw = test.values.get(lineageStorageKey(test.pending))!
    expect(parseLineagePending(raw, test.identity)).toEqual(test.pending)
    expect(readLineageOutbox(test.storage, { ...test.identity, generation: 2, bindingId: test.target.bindingId })).toMatchObject({ state: 'pending', current: false, raw, value: test.pending })
    const nextIdentity = { ...test.identity, generation: 2 }
    expect(lineageOutboxPrefix(nextIdentity)).toBe(lineageOutboxPrefix(test.identity))
    expect(readLineageOutbox(test.storage, { ...test.identity, actorId: 'actor:other' })).toEqual({ state: 'empty' })
    expect(() => saveLineagePending(test.storage, test.pending)).toThrow('still pending')
    expect(test.values.get(lineageStorageKey(test.pending))).toBe(raw)
    expect(test.pending.request.expectedHead.selectedLeafEntryId).not.toBe(test.pending.request.expectedHead.fileSeal.tailEntryId)
  })
  it('rejects modified owners, source heads, private fields and failed tab persistence', async () => {
    const test = await lineageFixture()
    for (const mutate of [
      (value: typeof test.pending) => { value.identity.actorId = 'actor:foreign' },
      (value: typeof test.pending) => { value.request.expectedGeneration++ },
      (value: typeof test.pending) => { value.request.expectedHead.fileSeal.sessionId = 'session:foreign' },
      (value: typeof test.pending) => { Reflect.set(value.request, 'editorText', 'not a human draft') },
    ]) { const value = structuredClone(test.pending); mutate(value); expect(() => parseLineagePending(JSON.stringify(value), test.identity)).toThrow() }
    expect(() => saveLineagePending({ ...test.storage, setItem() {} }, test.pending)).toThrow('not retained')
  })
  it('only clears exact succeeded or independently proven non-applied operations, not handoff/failed/unknown', async () => {
    const test = await lineageFixture(); saveLineagePending(test.storage, test.pending)
    for (const state of ['accepted', 'applying', 'handoff', 'failed', 'outcome-unknown'] as const) {
      const value = { ...test.operation, state, result: null, errorCode: state === 'failed' || state === 'outcome-unknown' ? 'execution-interrupted' as const : null }
      expect(await lineageOperationMatches(test.pending, value)).toBe(true)
      expect(lineageTerminalProof(value)).toBe(false)
      expect(await acknowledgeLineageOperation(test.storage, test.pending, value, () => true)).toBe(false)
    }
    const retained = await bindLineageOperation(test.storage, test.pending, test.operation, () => true)
    expect(retained?.request).toEqual(test.pending.request)
    expect(await acknowledgeLineageOperation(test.storage, retained!, test.operation, () => true)).toBe(true)
    expect(test.values.size).toBe(0)
  })
  it('verifies target binding, before/after proof, original owner and full request hash before offering completion', async () => {
    const test = await lineageFixture('fork')
    await expect(checkedLineageOperation(test.identity, test.operation)).resolves.toEqual(test.operation)
    for (const mutate of [
      (value: typeof test.operation) => { value.requestHash = '0'.repeat(64) },
      (value: typeof test.operation) => { value.sourceBinding.ownerActorId = 'actor:other' },
      (value: typeof test.operation) => { value.result!.targetBinding.ownerActorId = 'actor:other' },
      (value: typeof test.operation) => { value.result!.targetBinding.branchEntryId = 'entry:foreign' },
      (value: typeof test.operation) => { value.result!.proof.beforeHead.selectedLeafEntryId = 'entry:wrong' },
      (value: typeof test.operation) => { Reflect.set(value.result!, 'editorText', 'secret SDK prompt') },
    ]) { const value = structuredClone(test.operation); mutate(value); expect(await lineageOperationMatches(test.pending, value)).toBe(false) }
  })
  it('acknowledges a proved non-application without treating a cancellation signal or changed context as rollback', async () => {
    const test = await lineageFixture(), markerEntryId = 'entry:not-applied'
    const value = { ...test.operation, state: 'failed' as const, result: null, errorCode: 'execution-interrupted' as const,
      failureProof: { kind: 'native-lineage-failure' as const, operationId: test.operation.operationId, requestHash: test.operation.requestHash, action: structuredClone(test.pending.request.action),
        beforeHead: test.head, afterHead: { ...test.head, fileSeal: { ...test.head.fileSeal, transcriptHash: '4'.repeat(64), byteLength: 1400, entryCount: 6, tailEntryId: markerEntryId }, selectedLeafEntryId: markerEntryId },
        intentEntryId: 'entry:not-applied-intent', markerEntryId, reason: 'cancelled' as const } }
    saveLineagePending(test.storage, test.pending)
    expect(await lineageOperationMatches(test.pending, value)).toBe(true)
    expect(lineageTerminalProof(value)).toBe(true)
    expect(await lineageOperationMatches(test.pending, { ...value, failureProof: { ...value.failureProof, afterHead: { ...value.failureProof.afterHead, contextHash: '8'.repeat(64) } } })).toBe(false)
    expect(await acknowledgeLineageOperation(test.storage, test.pending, value, () => true)).toBe(true)
    expect(test.values.size).toBe(0)
  })
  it('rechecks actor/request ownership after deferred hashing and never deletes a newer stored body', async () => {
    const test = await lineageFixture(); saveLineagePending(test.storage, test.pending)
    let current = true
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
    const work = acknowledgeLineageOperation(test.storage, test.pending, test.operation, () => current)
    await entered.promise; current = false; release.resolve()
    expect(await work).toBe(false); expect(test.values.size).toBe(1)
    test.values.set(lineageStorageKey(test.pending), JSON.stringify({ ...test.pending, operationId: 'operation:newer' }))
    expect(await acknowledgeLineageOperation(test.storage, test.pending, test.operation, () => true)).toBe(false)
  })
  it('allows an explicit result opening only on its exact source or the same navigation target', async () => {
    const test = await lineageFixture()
    expect(lineageCanActivate(test.identity, test.operation)).toBe(true)
    expect(lineageCanActivate({ ...test.identity, bindingId: test.target.bindingId, generation: 2 }, test.operation)).toBe(true)
    expect(lineageCanActivate({ ...test.identity, bindingId: 'binding:later', generation: 3 }, test.operation)).toBe(false)
    expect(lineageCanActivate({ ...test.identity, conversationId: 'conversation:other' }, test.operation)).toBe(false)
    expect(lineageCanActivate(test.identity, { ...test.operation, state: 'handoff', result: null })).toBe(false)
  })
})

describe('public native tree and action selection', () => {
  it('keeps selected head distinct from the complete file tail and refuses stale tree pages', async () => {
    const test = await lineageFixture(), value = mergeLineageTree(test.identity, test.inspection, null, test.tree, null, 'messages')
    expect(value.entries).toEqual(test.tree.entries)
    expect(lineageHeadKey(test.head)).not.toBe(lineageHeadKey({ ...test.head, selectedLeafEntryId: test.head.fileSeal.tailEntryId }))
    expect(() => checkedLineageInspection({ ...test.identity, generation: 2 }, test.inspection)).toThrow()
    expect(() => mergeLineageTree(test.identity, test.inspection, null, { ...test.tree, head: { ...test.head, contextHash: '3'.repeat(64) } }, null, 'messages')).toThrow()
    expect(() => mergeLineageTree(test.identity, test.inspection, value, test.tree, 'cursor:foreign', 'messages')).toThrow()
  })
  it('bounds accumulation and checks parent/depth, duplicate entries, view and cursor continuity', async () => {
    const test = await lineageFixture(), first = { ...test.tree, entries: test.tree.entries.slice(0, 1), nextCursor: 'tree:next' }
    const previous = mergeLineageTree(test.identity, test.inspection, null, first, null, 'messages')
    expect(mergeLineageTree(test.identity, test.inspection, previous, { ...test.tree, entries: test.tree.entries.slice(1) }, 'tree:next', 'messages').entries).toHaveLength(2)
    expect(() => mergeLineageTree(test.identity, test.inspection, previous, first, 'tree:next', 'messages')).toThrow()
    expect(() => mergeLineageTree(test.identity, test.inspection, null, { ...test.tree, entries: [test.tree.entries[0], { ...test.tree.entries[1]!, depth: 5 }] }, null, 'messages')).toThrow('parent/depth')
    expect(() => mergeLineageTree(test.identity, test.inspection, null, { ...test.tree, view: 'all' }, null, 'messages')).toThrow()
  })
  it('exposes navigate/summary/label and SDK before/at rules without manufacturing draft text', async () => {
    const test = await lineageFixture(), user = test.tree.entries[0]!, assistant = test.tree.entries[1]!, draft = { ...lineageDraft(), summarize: true, instructions: '  保留未验证假设\n及分歧。  ', replaceInstructions: true, label: '对照支路' }
    expect(lineageAction(user, draft, 'before')).toEqual({ kind: 'fork', targetEntryId: user.entryId, position: 'before' })
    expect(lineageAction(assistant, draft, 'before')).toBeNull()
    expect(lineageAction(assistant, draft, 'at')).toEqual({ kind: 'fork', targetEntryId: assistant.entryId, position: 'at' })
    expect(lineageAction(assistant, draft, 'navigate')).toEqual({ kind: 'navigate', targetEntryId: assistant.entryId, summarize: true, instructions: draft.instructions, replaceInstructions: true, label: draft.label })
    expect(lineageAction(assistant, { ...draft, instructions: '字'.repeat(4097) }, 'navigate')).toBeNull()
    expect(lineageAction({ ...assistant, canNavigate: false }, draft, 'navigate')).toBeNull()
    expect(draft.instructions).not.toBe(user.preview)
  })
})
