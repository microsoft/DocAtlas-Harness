import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalizationStore, type ExplicitPreferenceEffect } from '@docatlas/core'
import type { ModelRequestPolicy, PreparedModelRequestPolicy } from '@docatlas/runtime-pi/worker'
import { ControlStore } from '../src/storage/control-store.js'
import { PersonalizationService, workspaceProfileId } from '../src/personalization/service.js'
import { ProductPersonalization } from '../src/personalization/application.js'
import type { ConsumedResearchFrame } from '../src/documents/research.js'

type Input = Parameters<ModelRequestPolicy['prepare']>[0]
type Answer = Parameters<NonNullable<PreparedModelRequestPolicy['onResult']>>[0]
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:preference-host', workspaceId: 'workspace:preference-host' }
const conversationId = 'conversation:preference-host'
const nativeContext: Input['context'] = { systemPrompt: 'NATIVE_SYSTEM_PROMPT_UNCHANGED',
  messages: [{ role: 'user', content: 'Compare the same verified facts. RAW_SOURCE_FACT', timestamp: 1 }],
  tools: [{ name: 'read', description: 'Native file reading remains available.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }
function answer(text = 'Observed generated text', stopReason: Answer['stopReason'] = 'stop'): Answer {
  return { role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: 'openai-responses', model: 'fixture', provider: 'fixture',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() }
}
const delta = (text: string) => ({ type: 'text_delta' as const, contentIndex: 0, delta: text, partial: answer(text) })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-preference-host-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const binding = control.createConversation(actor, { conversationId, runtimeSessionId: randomUUID() })
  const store = await PersonalizationStore.open(join(root, 'profiles')); cleanup.push(() => store.close())
  const service = new PersonalizationService(store, control), profileId = workspaceProfileId(actor), snapshots = vi.fn()
  let serial = 0, authorized = true, current: ConsumedResearchFrame | undefined
  // A trusted consumed-frame port is controlled here; the actual Pi consumption path has a separate integration test.
  function consume() {
    const receipt = control.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: binding.generation,
      idempotencyKey: `test:submission:${++serial}`, mode: 'prompt', text: 'Same facts and source evidence.', sourceRefs: [], selectionContextIds: [] }).receipt
    const frame: ConsumedResearchFrame = { binding, submissionId: receipt.submissionId, scopeVersionId: 'scope:consumed-facts',
      assertCurrent: () => { if (!authorized || current !== frame) throw new Error('Consumed source frame is no longer authorized') }, ensureSnapshot: snapshots }
    current = frame
    return receipt
  }
  const research = { consumedFrame: vi.fn(() => current) }
  const application = new ProductPersonalization(store, service, control, actor, research); cleanup.push(() => application.close())
  function policy(useExisting: boolean, contributeToFuture = false) {
    return service.command(actor, conversationId, { action: 'set-session-policy', idempotencyKey: `test:policy:${++serial}`,
      expectedVersion: store.sessionPolicy(profileId, conversationId)?.version ?? 0, policy: { useExisting, contributeToFuture } })
  }
  function preference(effect: ExplicitPreferenceEffect = { key: 'answer-order', value: 'evidence-first' }) {
    const command = { action: 'set-preference', idempotencyKey: `test:preference:${++serial}`, preference: { effect, scope: 'workspace' } }
    const result = service.command(actor, conversationId, command)
    if (result.action !== 'set-preference' || result.memoryVersion.status === 'deleted') throw new Error('Expected saved preference')
    return { memory: result.memoryVersion, command }
  }
  const input = (callId = `call:host:${++serial}`): Input => ({ callId, model: { provider: 'fixture', id: 'fixture' }, context: structuredClone(nativeContext), signal: new AbortController().signal })
  const prepare = (callId?: string) => application.policy(binding).prepare(input(callId))
  return { root, store, control, service, application, binding, profileId, snapshots, research, consume, policy, preference, input, prepare,
    inspect: () => service.inspect(actor, conversationId, 50), revokeFrame: () => { authorized = false } }
}

describe('host-only ephemeral personalization', () => {
  it('leaves native requests unchanged without an exactly consumed frame, consent, or eligible memory', async () => {
    for (const mode of ['startup', 'no-policy', 'off', 'empty', 'ineligible'] as const) {
      const value = await fixture()
      if (mode !== 'startup') value.consume()
      if (mode !== 'no-policy') value.policy(mode !== 'off')
      if (mode !== 'empty') {
        const { memory } = value.preference()
        if (mode === 'ineligible') vi.spyOn(value.store, 'currentMemories').mockReturnValue([{ ...memory, effect: { key: 'preferred-representation', value: 'markdown' } }])
      }
      const prepared = await value.prepare()
      expect(prepared).toEqual({ context: nativeContext })
      expect(value.snapshots).not.toHaveBeenCalled()
      expect(value.inspect().counts.decisions).toBe(0); expect(value.inspect().counts.uses).toBe(0)
    }
  })

  it('preserves native messages/tools/system prefix and only appends six bounded, fixed-enum presentation effects', async () => {
    const value = await fixture(), receipt = value.consume(); value.policy(true)
    const effects: ExplicitPreferenceEffect[] = [
      { key: 'answer-order', value: 'evidence-first' }, { key: 'explanation-depth', value: 'brief' },
      { key: 'preferred-representation', value: 'pdf' }, { key: 'terminology-depth', value: 'explain-on-first-use' },
      { key: 'artifact-format', value: 'matrix' }, { key: 'comparison-layout', value: 'stacked' },
    ]
    const memories = effects.map(effect => value.preference(effect).memory)
    const input = value.input(), before = structuredClone(input.context), prepared = await value.application.policy(value.binding).prepare(input)
    expect(input.context).toEqual(before)
    expect(prepared.context.messages).toEqual(before.messages); expect(prepared.context.tools).toEqual(before.tools)
    const instruction = prepared.context.systemPrompt!.slice(nativeContext.systemPrompt!.length)
    expect(prepared.context.systemPrompt!.startsWith(nativeContext.systemPrompt!)).toBe(true)
    expect(Buffer.byteLength(instruction)).toBeLessThanOrEqual(8192)
    for (const forbidden of ['RAW_SOURCE_FACT', value.profileId, actor.actorId, conversationId, receipt.submissionId, 'scope:consumed-facts', ...memories.map(memory => memory.memoryVersionId)]) expect(instruction).not.toContain(forbidden)
    expect(value.snapshots).toHaveBeenCalledOnce()
    expect(value.inspect().decisions[0]).toMatchObject({ effects: expect.arrayContaining(effects), factTraceGuard: { sourceScopeVersionId: 'scope:consumed-facts', evidenceSupportInvariant: true } })
    expect(value.inspect().counts.uses).toBe(0)
    await prepared.close?.()
  })

  it('records one actual observed use per selected memory and provider call, never on preparation or empty/tool-only output', async () => {
    const value = await fixture(); value.consume(); value.policy(true); value.preference()
    const prepared = await value.prepare('call:observed')
    await prepared.onEvent?.({ type: 'start', partial: answer('') })
    await prepared.onEvent?.(delta('  \n'))
    await prepared.onResult?.(answer('', 'toolUse'))
    expect(value.inspect().counts.uses).toBe(0)
    await prepared.onEvent?.(delta('Actual generated text'))
    const recorded = value.inspect().uses[0]!
    expect(recorded).toMatchObject({ affectedActions: ['answer-render'], outcome: { status: 'unknown' }, turn: 1 })
    await prepared.onEvent?.(delta('More generated text')); await prepared.onResult?.(answer())
    expect(value.inspect().uses).toEqual([recorded])
    await prepared.close?.()
    const nextCall = await value.prepare('call:next-generation')
    await nextCall.onResult?.(answer('Final-text fallback'))
    expect(value.inspect().counts.uses).toBe(2)
    expect(new Set(value.inspect().uses.map(use => use.memoryUseId)).size).toBe(2)
    await nextCall.close?.()
  })

  it.each(['error', 'aborted'] as const)('does not treat a %s final message as an observed answer without an earlier text delta', async stopReason => {
    const value = await fixture(); value.consume(); value.policy(true); value.preference()
    const prepared = await value.prepare()
    await prepared.onResult?.(answer('Provider error text, not an answer.', stopReason))
    expect(value.inspect().counts.uses).toBe(0)
    await prepared.close?.()
  })

  it('does not invalidate for contribution-only changes, export, or idempotent mutation replay', async () => {
    const value = await fixture(); value.consume(); value.policy(true)
    const { command } = value.preference(), prepared = await value.prepare()
    value.policy(true, true)
    const other = value.control.createConversation(actor, { conversationId: 'conversation:other-preferences', runtimeSessionId: randomUUID() })
    value.service.command(actor, other.conversationId, { action: 'set-session-policy', idempotencyKey: 'test:other-session-policy', expectedVersion: 0, policy: { useExisting: true, contributeToFuture: false } })
    value.service.command(actor, conversationId, { action: 'export', idempotencyKey: 'test:export', format: 'json', includeProvenanceRefs: false, includeStatuses: ['active'] })
    expect(value.service.command(actor, conversationId, command).status).toBe('replayed')
    expect(prepared.signal!.aborted).toBe(false)
    await prepared.onEvent?.(delta('Generation continues with the authorized existing preference'))
    expect(value.inspect().counts.uses).toBe(1)
    await prepared.close?.()
  })

  it.each(['disable', 'pause', 'edit', 'forget', 'erase'] as const)('aborts %s and refuses hidden same-submission retries, while a new submission can proceed', async change => {
    const value = await fixture(); value.consume(); value.policy(true)
    const { memory } = value.preference(), prepared = await value.prepare()
    if (change === 'disable') value.policy(false)
    if (change === 'pause') value.service.command(actor, conversationId, { action: 'pause', idempotencyKey: 'test:pause', memoryVersionId: memory.memoryVersionId, expectedVersion: 1 })
    if (change === 'edit') value.service.command(actor, conversationId, { action: 'edit', idempotencyKey: 'test:edit', memoryVersionId: memory.memoryVersionId, expectedVersion: 1,
      replacement: { effect: { key: 'answer-order', value: 'conclusion-first' }, scope: 'workspace' }, statusAfterEdit: 'active' })
    if (change === 'forget') value.service.command(actor, conversationId, { action: 'forget', idempotencyKey: 'test:forget', target: 'memory-chain', memoryVersionId: memory.memoryVersionId, expectedVersion: 1,
      mode: 'memory-only', provenanceHandling: 'orphan', acknowledgeExternalRetention: true })
    if (change === 'erase') value.service.command(actor, conversationId, { action: 'forget', idempotencyKey: 'test:erase', target: 'profile', expectedProfileRevision: value.store.ledgerRevision(value.profileId),
      mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true })
    expect(prepared.signal!.aborted).toBe(true)
    await expect(Promise.resolve().then(() => prepared.onEvent?.(delta('Late revoked answer')))).rejects.toThrow()
    await prepared.close?.()
    if (change === 'disable') value.policy(true) // Off→on cannot revive the already admitted request.
    await expect(Promise.resolve().then(() => value.prepare())).rejects.toThrow('new user submission')
    expect(value.inspect().counts.uses).toBe(0)
    value.consume()
    const next = await value.prepare()
    expect(next.context.systemPrompt?.includes('DocAtlas explicit response-presentation')).toBe(change === 'edit' || change === 'disable')
    await next.close?.()
  })

  it('makes expiry and frame revocation sticky even when no controls notification occurs', async () => {
    for (const change of ['expiry', 'frame'] as const) {
      const value = await fixture(); value.consume(); value.policy(true)
      const { memory } = value.preference(), prepared = await value.prepare()
      if (change === 'expiry') vi.spyOn(value.store, 'currentMemories').mockReturnValue([{ ...memory, validTime: { until: '2000-01-01T00:00:00.000Z' } }])
      else value.revokeFrame()
      await expect(Promise.resolve().then(() => prepared.onEvent?.(delta('Do not forward stale generation')))).rejects.toThrow()
      expect(prepared.signal!.aborted).toBe(true)
      await prepared.close?.()
      await expect(Promise.resolve().then(() => value.prepare())).rejects.toThrow('new user submission')
      expect(value.inspect().counts.uses).toBe(0)
    }
  })

  it('retains honest pre-revocation historical uses, but privacy erasure cannot be undone by a late callback', async () => {
    const value = await fixture(); value.consume(); value.policy(true); value.preference()
    const prepared = await value.prepare(); await prepared.onEvent?.(delta('A real provider observation'))
    expect(value.inspect().counts.uses).toBe(1)
    value.policy(false)
    expect(value.inspect().counts.uses).toBe(1)
    value.service.command(actor, conversationId, { action: 'forget', idempotencyKey: 'test:erase-after-use', target: 'profile', expectedProfileRevision: value.store.ledgerRevision(value.profileId),
      mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true })
    await expect(Promise.resolve().then(() => prepared.onResult?.(answer('Late completion')))).rejects.toThrow()
    expect(value.inspect().counts).toMatchObject({ uses: 0, decisions: 0, memories: 0 })
    await prepared.close?.()
  })

  it('does not let a late older frame overwrite the sticky revocation of a newer consumed submission', async () => {
    const value = await fixture(); value.consume(); value.policy(true); value.preference()
    const older = await value.prepare()
    value.consume()
    const newer = await value.prepare()
    value.policy(false)
    await expect(Promise.resolve().then(() => older.onEvent?.(delta('Late old-frame callback')))).rejects.toThrow()
    await older.close?.(); await newer.close?.()
    await expect(Promise.resolve().then(() => value.prepare())).rejects.toThrow('new user submission')
    expect(value.inspect().counts.uses).toBe(0)
    value.consume()
    expect(await value.prepare()).toEqual({ context: nativeContext })
  })

  it('retains revocation through a native-tool gap after the previous provider call has joined', async () => {
    const value = await fixture(); value.consume(); value.policy(true); value.preference()
    const prepared = await value.prepare()
    await prepared.onResult?.(answer('', 'toolUse')); await prepared.close?.()
    value.policy(false)
    await expect(Promise.resolve().then(() => value.prepare())).rejects.toThrow('new user submission')
    value.policy(true)
    await expect(Promise.resolve().then(() => value.prepare())).rejects.toThrow('new user submission')
    expect(value.inspect().counts.uses).toBe(0)
    value.consume()
    const next = await value.prepare()
    expect(next.context.systemPrompt).toContain('DocAtlas explicit response-presentation')
    await next.close?.()
  })

  it('rejects foreign or stale bindings and disconnects only after application close', async () => {
    const value = await fixture(); value.consume(); value.policy(true); value.preference()
    expect(value.service.modelApplication).toBe('host-ephemeral')
    expect(() => value.service.connectModelApplication()).toThrow('already connected')
    for (const mutation of [{ ownerActorId: 'actor:foreign' }, { workspaceId: 'workspace:foreign' }, { runtimeSessionId: randomUUID() }, { generation: 2 }]) {
      expect(() => value.application.policy({ ...value.binding, ...mutation })).toThrow('authenticated runtime binding')
    }
    const prepared = await value.prepare(); value.application.close()
    expect(prepared.signal!.aborted).toBe(true); expect(value.service.modelApplication).toBe('not-connected')
    await expect(Promise.resolve().then(() => value.prepare())).rejects.toThrow('closed')
    await prepared.close?.()
  })
})
