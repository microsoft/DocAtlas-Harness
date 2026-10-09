import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, ProductNativeInspection, ProductNativeOperation } from '@docatlas/contracts'
import { NativeOperationStatus } from '../src/live/NativeControls'
import { acknowledgeNativeOperation, bindNativeOperation, checkedNativeInspection, nativeControlStorageKey, nativeOperationHasTerminalProof, nativeOperationMatches, nativeSettingsView, parseNativeControlPending,
  readNativeControlOutbox, saveNativeControlPending, type NativeControlIdentity, type NativeControlPending, type NativeControlStorage } from '../src/live/native-control-state'
import { canonicalHash } from '../src/live/state'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: ConversationSnapshot[] }
afterEach(() => vi.restoreAllMocks())
function setup() {
  const binding = structuredClone(fixture.valid.find(value => value.kind === 'conversation-snapshot')!.binding)
  const identity: NativeControlIdentity = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, nativeSessionId: binding.runtimeSessionId }
  const head = { version: 1 as const, sessionId: binding.runtimeSessionId, transcriptHash: 'a'.repeat(64), byteLength: 1000, entryCount: 3, leafEntryId: 'entry:prior' }
  const pending: NativeControlPending = { schemaVersion: 1, identity, operationId: null, request: { schemaVersion: 1, kind: 'native-command', conversationId: binding.conversationId, expectedBindingId: binding.bindingId, expectedGeneration: binding.generation,
    runtimeSessionId: binding.runtimeSessionId, approvalId: 'resource:approval', expectedApprovalVersion: 1, expectedHead: head, idempotencyKey: 'native-control:original-key', action: { kind: 'set-thinking', level: 'low' } } }
  const configuration = { model: { provider: 'approved', id: 'model' }, thinkingLevel: 'high' as const, steeringMode: 'one-at-a-time' as const, followUpMode: 'all' as const }
  const models = [{ provider: 'approved', id: 'model', name: 'Approved model', thinkingLevels: ['off', 'low', 'high'] as Array<'off' | 'low' | 'high'>, contextWindow: 32000, maxTokens: 8000 }]
  const inspection: ProductNativeInspection = { schemaVersion: 1, kind: 'native-inspection', binding, resource: { approvalId: 'resource:approval', version: 1, manifestHash: 'c'.repeat(64) }, models,
    state: { head, configuration, models, thinkingLevels: ['off', 'low', 'high'], busy: false, nativeQueue: { steering: 0, followUp: 0 } }, busy: false, queued: 0, operations: [], truncated: false }
  const values = new Map<string, string>(), changes: string[] = []
  const storage: NativeControlStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); changes.push(`set:${key}`) }, removeItem: key => { values.delete(key); changes.push(`remove:${key}`) }, key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
  return { binding, identity, pending, inspection, configuration, values, changes, storage }
}
async function operation(test: ReturnType<typeof setup>, state: ProductNativeOperation['state'] = 'accepted'): Promise<ProductNativeOperation> {
  const requestHash = await canonicalHash(test.pending.request), operationId = 'operation:native:one'
  return { schemaVersion: 1, kind: 'native-operation', operationId, conversationId: test.identity.conversationId, bindingId: test.identity.bindingId, generation: test.identity.generation,
    runtimeSessionId: test.identity.nativeSessionId, requestHash, request: structuredClone(test.pending.request), state, version: state === 'accepted' ? 1 : 2,
    createdAt: '2026-09-09T12:00:00.000Z', updatedAt: '2026-09-09T12:00:01.000Z', errorCode: state === 'failed' ? 'stale-state' : state === 'outcome-unknown' ? 'execution-interrupted' : null,
    result: state === 'succeeded' ? { operationId, requestHash, action: structuredClone(test.pending.request.action), beforeHead: structuredClone(test.pending.request.expectedHead),
      afterHead: { ...test.pending.request.expectedHead, transcriptHash: 'b'.repeat(64), byteLength: 2000, entryCount: 6, leafEntryId: 'entry:completed-marker' },
      intentEntryId: 'entry:control-intent', markerEntryId: 'entry:completed-marker', configuration: { ...test.configuration, thinkingLevel: 'low' } } : null }
}

describe('independently verified native state', () => {
  it('keeps a busy/unverified native state null while preserving the real approved model directory', () => {
    const test = setup(), value = { ...test.inspection, state: null, busy: true, queued: 2 }
    expect(checkedNativeInspection(test.identity, value)).toEqual(value)
    expect(nativeSettingsView(value)).toBeNull()
    expect(value.models).toEqual(test.inspection.models)
    expect(checkedNativeInspection(test.identity, test.inspection).state?.configuration.thinkingLevel).toBe('high')
  })
  it('rejects changed actors, bindings, generations, native sessions and duplicate catalog pairs', () => {
    const test = setup()
    for (const binding of [{ ownerActorId: 'actor:other' }, { workspaceId: 'workspace:other' }, { conversationId: 'conversation:other' }, { bindingId: 'binding:other' }, { generation: test.binding.generation + 1 }, { runtimeSessionId: 'native:other' }]) {
      expect(() => checkedNativeInspection(test.identity, { ...test.inspection, binding: { ...test.binding, ...binding } })).toThrow()
    }
    expect(() => checkedNativeInspection(test.identity, { ...test.inspection, models: [...test.inspection.models, test.inspection.models[0]!] })).toThrow()
  })
  it('does not double-count native queue entries as additional product queued submissions', () => {
    const test = setup(), state = test.inspection.state!
    const value = nativeSettingsView({ ...test.inspection, queued: 2, state: { ...state, nativeQueue: { steering: 1, followUp: 1 } } })!
    expect(value.queued).toBe(2); expect(value.nativeQueue).toEqual({ steering: 1, followUp: 1 })
  })
  it('preserves absent versus explicitly unavailable versus eligible manual compaction', () => {
    const test = setup()
    expect(nativeSettingsView(test.inspection)?.canCompact).toBeUndefined()
    for (const canCompact of [true, false]) expect(nativeSettingsView({ ...test.inspection, state: { ...test.inspection.state!, compaction: { canCompact } } })?.canCompact).toBe(canCompact)
  })
})

describe('manual compact terminal proofs and original-key retention', () => {
  function compact() {
    const test = setup(); test.pending.request.action = { kind: 'compact', instructions: '  保留关键路径\n与尚未核验的假设。  ' }
    return test
  }
  async function notApplied(test: ReturnType<typeof compact>): Promise<ProductNativeOperation> {
    const value = await operation(test, 'failed'), action = test.pending.request.action
    if (action.kind !== 'compact') throw new Error('Expected compact fixture')
    return { ...value, errorCode: 'execution-interrupted', failureProof: { operationId: value.operationId, requestHash: value.requestHash,
      action: structuredClone(action), beforeHead: structuredClone(test.pending.request.expectedHead),
      afterHead: { ...test.pending.request.expectedHead, transcriptHash: 'b'.repeat(64), byteLength: 2400, entryCount: test.pending.request.expectedHead.entryCount + 2, leafEntryId: 'entry:not-applied' },
      intentEntryId: 'entry:compact-intent', markerEntryId: 'entry:not-applied', reason: 'cancelled' } }
  }
  it('matches and clears a proved compact result without turning its summary into a new answer', async () => {
    const test = compact(), value = await operation(test, 'succeeded')
    value.result!.compaction = { entryId: 'entry:compact', firstKeptEntryId: 'entry:prior', tokensBefore: 32768, summaryHash: 'd'.repeat(64) }
    saveNativeControlPending(test.storage, test.pending)
    expect(await nativeOperationMatches(test.pending, value)).toBe(true)
    expect(await acknowledgeNativeOperation(test.storage, test.pending, value, () => true)).toBe(true)
    expect(test.values.size).toBe(0)
    const html = renderToStaticMarkup(createElement(NativeOperationStatus, { operation: value }))
    expect(html).toContain('已核验 Pi 原生压缩记录'); expect(html).toContain('不是新的助手回答')
    expect(html).toContain('不代表节省量'); expect(html).not.toContain('class="live-message assistant"')
  })
  it('only acknowledges an independently bound known non-application, without mislabeling it as success', async () => {
    const test = compact(), value = await notApplied(test); saveNativeControlPending(test.storage, test.pending)
    expect(nativeOperationHasTerminalProof(value)).toBe(true)
    expect(await nativeOperationMatches(test.pending, value)).toBe(true)
    const retained = await bindNativeOperation(test.storage, test.pending, value, () => true)
    expect(retained!.request.action).toEqual(test.pending.request.action)
    expect(await acknowledgeNativeOperation(test.storage, retained!, value, () => true)).toBe(true); expect(test.values.size).toBe(0)
    const html = renderToStaticMarkup(createElement(NativeOperationStatus, { operation: value }))
    expect(html).toContain('已核验未应用压缩'); expect(html).toContain('不会自动重试')
    expect(html).not.toContain('已核验 Pi 原生压缩记录'); expect(html).not.toContain('已核验原生持久回执')
  })
  it('retains unknown/missing/changed non-application proof rather than blindly clearing a cancelled outbox', async () => {
    const test = compact(), value = await notApplied(test); saveNativeControlPending(test.storage, test.pending)
    for (const mutate of [
      (copy: ProductNativeOperation) => { copy.failureProof!.action.instructions = 'different' },
      (copy: ProductNativeOperation) => { copy.failureProof!.requestHash = 'f'.repeat(64) },
      (copy: ProductNativeOperation) => { copy.failureProof!.afterHead.entryCount++ },
      (copy: ProductNativeOperation) => { copy.failureProof!.beforeHead.byteLength++ },
      (copy: ProductNativeOperation) => { copy.failureProof!.afterHead.leafEntryId = 'entry:other' },
      (copy: ProductNativeOperation) => { copy.state = 'outcome-unknown' },
    ]) {
      const changed = structuredClone(value); mutate(changed)
      expect(await nativeOperationMatches(test.pending, changed)).toBe(false)
      expect(await acknowledgeNativeOperation(test.storage, test.pending, changed, () => true)).toBe(false)
    }
    const missing = structuredClone(value); delete missing.failureProof
    expect(nativeOperationHasTerminalProof(missing)).toBe(false)
    expect(await acknowledgeNativeOperation(test.storage, test.pending, missing, () => true)).toBe(false)
    expect(await acknowledgeNativeOperation(test.storage, test.pending, value, () => false)).toBe(false)
    expect(test.values.size).toBe(1)
  })
})

describe('full original native configuration outbox', () => {
  it('freezes approval/head/session/body/key before submission and restores without writing or retargeting', () => {
    const test = setup(); saveNativeControlPending(test.storage, test.pending)
    const raw = test.values.get(nativeControlStorageKey(test.pending))!, changes = [...test.changes]
    expect(parseNativeControlPending(raw, test.identity)).toEqual(test.pending)
    expect(readNativeControlOutbox(test.storage, test.identity)).toMatchObject({ state: 'pending', current: true, value: test.pending })
    expect(readNativeControlOutbox(test.storage, { ...test.identity, generation: test.identity.generation + 1 })).toMatchObject({ state: 'pending', current: false, value: test.pending })
    expect(readNativeControlOutbox(test.storage, { ...test.identity, nativeSessionId: 'native:other' })).toMatchObject({ state: 'pending', current: false })
    expect(readNativeControlOutbox(test.storage, { ...test.identity, conversationId: 'conversation:other' })).toEqual({ state: 'empty' })
    expect(test.changes).toEqual(changes)
    expect(() => saveNativeControlPending(test.storage, { ...test.pending, request: { ...test.pending.request, expectedApprovalVersion: 2, expectedHead: { ...test.pending.request.expectedHead, transcriptHash: 'd'.repeat(64) } } })).toThrow('uncertain')
  })
  it('rejects malformed owners, private fields, rewritten head sessions and non-retained writes', () => {
    const test = setup()
    for (const mutate of [
      (value: NativeControlPending) => { value.identity.actorId = 'actor:other' }, (value: NativeControlPending) => { value.request.expectedGeneration++ },
      (value: NativeControlPending) => { value.request.expectedHead.sessionId = 'native:other' }, (value: NativeControlPending) => { value.operationId = '../escape' },
      (value: NativeControlPending) => { Reflect.set(value.request, 'endpoint', 'https://unapproved.invalid') }, (value: NativeControlPending) => { Reflect.set(value.request, 'apiKey', 'not-accepted') },
    ]) { const value = structuredClone(test.pending); mutate(value); expect(() => parseNativeControlPending(JSON.stringify(value), test.identity)).toThrow() }
    expect(() => saveNativeControlPending({ ...test.storage, setItem() {} }, test.pending)).toThrow('not retained')
    test.values.set(nativeControlStorageKey(test.pending), '{broken')
    expect(readNativeControlOutbox(test.storage, test.identity).state).toBe('invalid')
    expect(() => saveNativeControlPending(test.storage, test.pending)).toThrow('uncertain')
  })
  it('binds a discovered real operation ID without changing the original command or executing it again', async () => {
    const test = setup(), value = await operation(test); saveNativeControlPending(test.storage, test.pending)
    const bound = await bindNativeOperation(test.storage, test.pending, value, () => true)
    expect(bound).toEqual({ ...test.pending, operationId: value.operationId })
    expect(readNativeControlOutbox(test.storage, test.identity)).toMatchObject({ value: bound })
    expect(await bindNativeOperation(test.storage, bound!, { ...value, operationId: 'operation:different' }, () => true)).toBeNull()
  })
  it('never acknowledges accepted/applying/failed/unknown as an applied configuration', async () => {
    const test = setup(); saveNativeControlPending(test.storage, test.pending)
    for (const state of ['accepted', 'applying', 'failed', 'outcome-unknown'] as const) {
      const value = await operation(test, state)
      expect(await nativeOperationMatches(test.pending, value)).toBe(true)
      expect(await acknowledgeNativeOperation(test.storage, test.pending, value, () => true)).toBe(false)
      const html = renderToStaticMarkup(createElement(NativeOperationStatus, { operation: value }))
      expect(html).toContain('还没有成功的原生持久证明'); expect(html).not.toContain('class="live-message assistant"')
    }
    expect(test.values.size).toBe(1)
  })
  it('exposes actual native cancellation while accepted/applying even without any chat run, but not a false terminal-state stop', async () => {
    const test = setup()
    for (const state of ['accepted', 'applying', 'succeeded', 'failed', 'outcome-unknown'] as const) {
      const value = await operation(test, state), html = renderToStaticMarkup(createElement(NativeOperationStatus, { operation: value, onStop() {} }))
      expect(html.includes('停止当前原生执行')).toBe(state === 'accepted' || state === 'applying')
      if (state === 'accepted') {
        expect(renderToStaticMarkup(createElement(NativeOperationStatus, { operation: value, stopping: true, onStop() {} }))).toContain('disabled="">等待确认原生停止…')
      }
    }
  })
  it('requires exact beforeHead/action/hash/marker/session and the requested actual setting for successful proof', async () => {
    const test = setup(), value = await operation(test, 'succeeded'); saveNativeControlPending(test.storage, test.pending)
    expect(await nativeOperationMatches(test.pending, value)).toBe(true)
    const proof = value.result!
    for (const altered of [
      { ...value, requestHash: 'f'.repeat(64) }, { ...value, result: null }, { ...value, result: { ...proof, beforeHead: { ...proof.beforeHead, byteLength: 999 } } },
      { ...value, result: { ...proof, afterHead: { ...proof.afterHead, entryCount: proof.beforeHead.entryCount } } },
      { ...value, result: { ...proof, afterHead: { ...proof.afterHead, leafEntryId: 'entry:other-marker' } } },
      { ...value, result: { ...proof, intentEntryId: proof.markerEntryId } }, { ...value, result: { ...proof, configuration: test.configuration } },
    ]) { expect(await nativeOperationMatches(test.pending, altered)).toBe(false); expect(await acknowledgeNativeOperation(test.storage, test.pending, altered as ProductNativeOperation, () => true)).toBe(false) }
    expect(test.values.size).toBe(1)
    expect(await acknowledgeNativeOperation(test.storage, test.pending, value, () => true)).toBe(true); expect(test.values.size).toBe(0)
  })
  it('rechecks current owner after async hashing and refuses to clear or overwrite a newer retained command', async () => {
    const test = setup(), value = await operation(test, 'succeeded'); saveNativeControlPending(test.storage, test.pending)
    let current = true
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
    const work = acknowledgeNativeOperation(test.storage, test.pending, value, () => current)
    await entered.promise; current = false; release.resolve()
    expect(await work).toBe(false); expect(test.values.size).toBe(1)
    test.values.set(nativeControlStorageKey(test.pending), JSON.stringify({ ...test.pending, request: { ...test.pending.request, idempotencyKey: 'native:newer-key' } }))
    expect(await acknowledgeNativeOperation(test.storage, test.pending, value, () => true)).toBe(false)
    expect(await bindNativeOperation(test.storage, test.pending, value, () => true)).toBeNull()
  })
})
