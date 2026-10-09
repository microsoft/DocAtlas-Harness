import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, ProductNativeInspection } from '@docatlas/contracts'
import { nextNativeInspection, type NativeControlIdentity } from '../src/live/native-control-state'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: ConversationSnapshot[] }
function setup() {
  const binding = structuredClone(fixture.valid.find(value => value.kind === 'conversation-snapshot')!.binding)
  const identity: NativeControlIdentity = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, nativeSessionId: binding.runtimeSessionId }
  const models = [{ provider: 'approved', id: 'model', name: 'Approved model', thinkingLevels: ['off', 'low', 'high'] as Array<'off' | 'low' | 'high'>, contextWindow: 32000, maxTokens: 8000 }]
  const inspection: ProductNativeInspection = { schemaVersion: 1, kind: 'native-inspection', binding, resource: { approvalId: 'resource:approval', version: 1, manifestHash: 'c'.repeat(64) }, models,
    state: { head: { version: 1, sessionId: binding.runtimeSessionId, transcriptHash: 'b'.repeat(64), byteLength: 2000, entryCount: 6, leafEntryId: 'entry:completed-marker' },
      configuration: { model: { provider: 'approved', id: 'model' }, thinkingLevel: 'high', steeringMode: 'one-at-a-time', followUpMode: 'all' },
      models, thinkingLevels: ['off', 'low', 'high'], busy: false, nativeQueue: { steering: 0, followUp: 0 } }, busy: false, queued: 0, operations: [], truncated: false }
  return { identity, inspection }
}

describe('causal native inspection readback', () => {
  it('waits for exactly one fresh inspection without reusing the earlier busy snapshot', async () => {
    const test = setup(), deferred = Promise.withResolvers<ProductNativeInspection>(), read = vi.fn(() => deferred.promise)
    const earlier: ProductNativeInspection = { ...test.inspection, busy: true, state: null }
    let published: ProductNativeInspection | null = earlier
    const work = nextNativeInspection(test.identity, read, () => true).then(value => { published = value })
    expect(read).toHaveBeenCalledTimes(1); expect(published).toBe(earlier)
    deferred.resolve(test.inspection); await work
    expect(published).toEqual(test.inspection); expect(published?.state?.configuration.thinkingLevel).toBe('high')
    expect(read).toHaveBeenCalledTimes(1); expect(earlier.state).toBeNull()
  })

  it('also replaces a readable but stale pre-operation head with the causal readback', async () => {
    const test = setup(), earlier = { ...test.inspection, state: { ...test.inspection.state!, head: { ...test.inspection.state!.head, transcriptHash: 'a'.repeat(64), entryCount: 3, byteLength: 1000 }, configuration: { ...test.inspection.state!.configuration, thinkingLevel: 'low' as const } } }
    const read = vi.fn(async () => test.inspection)
    const value = await nextNativeInspection(test.identity, read, () => true)
    expect(value?.state?.head.transcriptHash).not.toBe(earlier.state.head.transcriptHash)
    expect(value?.state?.configuration.thinkingLevel).toBe('high'); expect(read).toHaveBeenCalledTimes(1)
  })

  it('discards a deferred response after the owning epoch or request serial changes', async () => {
    const test = setup(), deferred = Promise.withResolvers<ProductNativeInspection>()
    let current = true
    const work = nextNativeInspection(test.identity, () => deferred.promise, () => current)
    current = false; deferred.resolve(test.inspection)
    expect(await work).toBeNull()
  })

  it('propagates failed reads instead of treating an earlier value or proof as verified state', async () => {
    const test = setup(), deferred = Promise.withResolvers<ProductNativeInspection>(), error = new Error('inspection unavailable')
    const work = nextNativeInspection(test.identity, () => deferred.promise, () => true)
    const assertion = expect(work).rejects.toBe(error)
    deferred.reject(error); await assertion
  })

  it('validates the fresh response owner and returns a genuinely busy response without another poll', async () => {
    const test = setup(), foreign = { ...test.inspection, binding: { ...test.inspection.binding, generation: test.identity.generation + 1 } }
    await expect(nextNativeInspection(test.identity, async () => foreign, () => true)).rejects.toThrow('another owner')
    const busy: ProductNativeInspection = { ...test.inspection, busy: true, state: null }, read = vi.fn(async () => busy)
    expect(await nextNativeInspection(test.identity, read, () => true)).toEqual(busy)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
