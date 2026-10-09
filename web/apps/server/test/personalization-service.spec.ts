import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalizationStore } from '@docatlas/core'
import type { MemoryUse } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'
import { PersonalizationService, workspaceProfileId } from '../src/personalization/service.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:personal', workspaceId: 'workspace:personal' }
const otherWorkspace = { actorId: actor.actorId, workspaceId: 'workspace:other' }
const stranger = { actorId: 'actor:stranger', workspaceId: actor.workspaceId }
const conversationId = 'conversation:personal', otherConversation = 'conversation:other-task', foreignConversation = 'conversation:foreign'
const preference = { action: 'set-preference', idempotencyKey: 'explicit:user:preference', preference: { effect: { key: 'explanation-depth', value: 'brief' }, scope: 'workspace' } }
const timestamp = '2026-09-09T12:00:00.000Z'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-personalization-service-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  control.createConversation(actor, { conversationId, runtimeSessionId: randomUUID() })
  control.createConversation(actor, { conversationId: otherConversation, runtimeSessionId: randomUUID() })
  control.createConversation(otherWorkspace, { conversationId: foreignConversation, runtimeSessionId: randomUUID() })
  const profileRoot = join(root, 'personal-profile-domain'), researchRoot = join(root, 'research-domain')
  mkdirSync(researchRoot); writeFileSync(join(researchRoot, 'research-sentinel'), 'Research evidence must remain independent.')
  const store = await PersonalizationStore.open(profileRoot, () => new Date(timestamp)); cleanup.push(() => store.close())
  return { root, control, store, profileRoot, researchRoot, service: new PersonalizationService(store, control) }
}

describe('host-authorized personalization controls', () => {
  it('derives the workspace profile and conversation session only after binding authorization', async () => {
    const { service, store, profileRoot, researchRoot } = await fixture()
    const result = service.command(actor, conversationId, preference)
    const expected = `profile:pi:${createHash('sha256').update(JSON.stringify([actor.actorId, actor.workspaceId])).digest('hex').slice(0, 32)}`
    expect(result.profileId).toBe(expected)
    if (result.action !== 'set-preference' || result.memoryVersion.status === 'deleted') throw new Error('Expected explicit preference')
    expect(result.memoryVersion).toMatchObject({ scope: { kind: 'workspace', profileId: expected, workspaceId: actor.workspaceId },
      activation: { actor: { kind: 'user', actorId: actor.actorId } }, sensitivity: 'ordinary', summary: 'explanation-depth: brief' })
    expect(service.inspect(actor, conversationId)).toMatchObject({ profileId: expected, sessionId: conversationId, counts: { memories: 1, decisions: 0, uses: 0 } })
    expect(service.inspect(actor, otherConversation)).toMatchObject({ profileId: expected, sessionId: otherConversation })
    expect(store.databasePath(expected)).toContain(join(profileRoot, 'profiles'))
    expect(store.databasePath(expected)).not.toContain(researchRoot)
    expect(readFileSync(join(researchRoot, 'research-sentinel'), 'utf8')).toBe('Research evidence must remain independent.')
    expect(service.whyUsed(actor, conversationId)).toEqual([])
    expect(Reflect.get(service, 'compileDecision')).toBeUndefined()
    expect(Reflect.get(service, 'recordMemoryUse')).toBeUndefined()
  })

  it('rejects foreign actors, conversations and body-supplied authority without touching another profile', async () => {
    const { service, store } = await fixture(), write = vi.spyOn(store, 'command'), inspect = vi.spyOn(store, 'inspect')
    for (const [who, conversation] of [[stranger, conversationId], [actor, foreignConversation], [otherWorkspace, conversationId]] as const) {
      expect(() => service.command(who, conversation, preference)).toThrowError(expect.objectContaining({ code: 'not-found' }))
      expect(() => service.inspect(who, conversation)).toThrowError(expect.objectContaining({ code: 'not-found' }))
      expect(() => service.exportAsset(who, conversation, 'asset:any')).toThrowError(expect.objectContaining({ code: 'not-found' }))
    }
    for (const extra of [{ profileId: workspaceProfileId(otherWorkspace) }, { actor: { kind: 'user', actorId: stranger.actorId } }, { workspaceId: otherWorkspace.workspaceId }, { sessionId: foreignConversation }]) {
      expect(() => service.command(actor, conversationId, { ...preference, ...extra })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    }
    expect(write).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
    expect(() => workspaceProfileId({ actorId: '../foreign', workspaceId: actor.workspaceId })).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
  })

  it('preserves independent policy switches, idempotent receipts and version conflicts through the host adapter', async () => {
    const { service } = await fixture()
    const policy = { action: 'set-session-policy', idempotencyKey: 'policy:one', expectedVersion: 0, policy: { useExisting: false, contributeToFuture: true } }
    expect(service.command(actor, conversationId, policy)).toMatchObject({ action: 'set-session-policy', sessionPolicy: { useExisting: false, contributeToFuture: true, version: 1, sessionId: conversationId } })
    expect(service.command(actor, conversationId, policy)).toMatchObject({ status: 'replayed' })
    expect(() => service.command(actor, conversationId, { ...policy, policy: { useExisting: true, contributeToFuture: false } })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => service.command(actor, conversationId, { ...policy, idempotencyKey: 'policy:stale' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(service.command(actor, conversationId, { ...policy, idempotencyKey: 'policy:two', expectedVersion: 1, policy: { useExisting: true, contributeToFuture: false } }))
      .toMatchObject({ sessionPolicy: { useExisting: true, contributeToFuture: false, version: 2 } })
    service.command(actor, conversationId, preference)
    expect(service.command(actor, conversationId, preference)).toMatchObject({ status: 'replayed' })
    expect(() => service.command(actor, otherConversation, preference)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const foreign = service.command(otherWorkspace, foreignConversation, preference)
    expect(foreign.profileId).not.toBe(workspaceProfileId(actor))
    expect(service.inspect(otherWorkspace, foreignConversation).sessionPolicy).toBeUndefined()
    expect(service.inspect(actor, conversationId)).toMatchObject({ counts: { memories: 1, decisions: 0, uses: 0 } })
    expect(service.whyUsed(actor, conversationId)).toEqual([])
  })

  it('filters other conversation decisions and recorded uses while preserving explicit profile export boundaries', async () => {
    const { service, store } = await fixture()
    service.command(actor, conversationId, { action: 'set-session-policy', idempotencyKey: 'policy:use', expectedVersion: 0, policy: { useExisting: true, contributeToFuture: false } })
    const created = service.command(actor, conversationId, preference)
    if (created.action !== 'set-preference' || created.memoryVersion.status === 'deleted') throw new Error('Expected saved preference')
    const profileId = created.profileId, decision = store.compileDecision({ profileId, sessionId: conversationId, turn: 1,
      taskContext: { mode: 'explore', workspaceId: actor.workspaceId }, sourceScopeVersionId: 'scope:private-conversation', baselineDigest: 'a'.repeat(64) })!
    const use: MemoryUse = { schemaVersion: 1, recordType: 'memory-use', memoryUseId: 'use:private-conversation', decisionId: decision.decisionId,
      memoryVersionId: created.memoryVersion.memoryVersionId, profileId, sessionId: conversationId, turn: 1, effect: created.memoryVersion.effect, affectedActions: ['answer-render'], usedAt: timestamp }
    expect(service.whyUsed(actor, conversationId)).toEqual([])
    store.recordMemoryUse(use) // Test-only seam: the adapter itself has no application/use writer.
    expect(service.whyUsed(actor, conversationId)).toEqual([{ use, decision }])
    const inspected = service.inspect(actor, otherConversation)
    expect(inspected).toMatchObject({ counts: { memories: 1, decisions: 0, uses: 0 } })
    expect(JSON.stringify(inspected)).not.toContain('scope:private-conversation')
    expect(JSON.stringify(inspected)).not.toContain('use:private-conversation')
    const exported = service.command(actor, conversationId, { action: 'export', idempotencyKey: 'export:personal', format: 'json', includeProvenanceRefs: false, includeStatuses: ['active'] })
    if (exported.action !== 'export') throw new Error('Expected export')
    expect(service.exportAsset(actor, conversationId, exported.export.assetId).descriptor.contentHash).toBe(exported.export.contentHash)
    expect(() => service.exportAsset(otherWorkspace, foreignConversation, exported.export.assetId)).toThrowError(expect.objectContaining({ code: 'not-found' }))
  })

  it('rechecks the bound conversation before a write rather than trusting a cached human identity', async () => {
    const { service, store, control } = await fixture(), binding = control.binding.bind(control), write = vi.spyOn(store, 'command')
    let calls = 0
    vi.spyOn(control, 'binding').mockImplementation((who, conversation) => {
      const value = binding(who, conversation)
      return ++calls > 1 ? { ...value, generation: value.generation + 1 } : value
    })
    expect(() => service.command(actor, conversationId, preference)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(write).not.toHaveBeenCalled()
  })
})
