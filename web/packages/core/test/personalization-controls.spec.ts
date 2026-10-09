import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryUse, PersonalizationCommandResult } from '@docatlas/contracts'
import { PersonalizationStore, PersonalizationStoreError } from '../src/storage/personalization-store.js'
import { PersonalizationControls, type ExplicitPreferenceDraft, type TrustedPersonalizationIdentity } from '../src/personalization/controls.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const timestamp = '2026-09-09T12:00:00.000Z', profileId = 'profile:controls', sessionId = 'conversation:controls', workspaceId = 'workspace:controls'
const preference: ExplicitPreferenceDraft = { effect: { key: 'answer-order', value: 'evidence-first' }, scope: 'global' }
const human = { kind: 'user' as const, actorId: 'actor:controls' }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-personalization-controls-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = await PersonalizationStore.open(root, () => new Date(timestamp)); cleanup.push(() => store.close())
  const identity: TrustedPersonalizationIdentity = { profileId, sessionId, workspaceId, actor: human, assertCurrent: () => {} }
  const controls = new PersonalizationControls(store, () => identity)
  return { root, store, controls, identity }
}
function memory(result: PersonalizationCommandResult) {
  if (!('memoryVersion' in result) || !result.memoryVersion || result.memoryVersion.status === 'deleted') throw new Error('Expected a live memory version')
  return result.memoryVersion
}

describe('explicit personalization Core controls', () => {
  it('keeps both session switches independent, with settings saved but no implied application', async () => {
    const { store, controls } = await fixture(), compile = vi.spyOn(store, 'compileDecision'), use = vi.spyOn(store, 'recordMemoryUse')
    expect(controls.inspect()).toMatchObject({ counts: { memories: 0, decisions: 0, uses: 0 } })
    expect(controls.inspect().sessionPolicy).toBeUndefined()
    let expectedVersion = 0
    for (const [useExisting, contributeToFuture] of [[false, false], [true, false], [false, true], [true, true]]) {
      const result = controls.command({ action: 'set-session-policy', idempotencyKey: `switches:${expectedVersion}`, expectedVersion,
        policy: { useExisting, contributeToFuture } })
      expect(result).toMatchObject({ action: 'set-session-policy', sessionPolicy: { useExisting, contributeToFuture, version: ++expectedVersion } })
    }
    controls.command({ action: 'set-session-policy', idempotencyKey: 'switches:off', expectedVersion, policy: { useExisting: false, contributeToFuture: false } })
    const created = memory(controls.command({ action: 'set-preference', idempotencyKey: 'explicit:setting', preference }))
    expect(created).toMatchObject({ status: 'active', sensitivity: 'ordinary', policy: { apply: 'disclose' },
      activation: { kind: 'explicit-setting', actor: human }, scope: { kind: 'global', profileId } })
    expect(controls.whyUsed()).toEqual([])
    expect(controls.inspect()).toMatchObject({ counts: { memories: 1, decisions: 0, uses: 0 } })
    expect(compile).not.toHaveBeenCalled(); expect(use).not.toHaveBeenCalled()
    expect(Reflect.get(controls, 'recordCandidate')).toBeUndefined()
    expect(Reflect.get(controls, 'recordMemoryUse')).toBeUndefined()
    expect(Reflect.get(controls, 'compileDecision')).toBeUndefined()
  })

  it('retains command idempotency and immutable CAS versions for edit, pause, resume and logical forget', async () => {
    const { controls } = await fixture(), command = { action: 'set-preference', idempotencyKey: 'create:preference', preference }
    const first = memory(controls.command(command))
    expect(controls.command(command)).toMatchObject({ status: 'replayed', memoryVersion: { memoryVersionId: first.memoryVersionId } })
    expect(() => controls.command({ ...command, preference: { ...preference, scope: 'workspace' } })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const paused = memory(controls.command({ action: 'pause', idempotencyKey: 'pause:preference', memoryVersionId: first.memoryVersionId, expectedVersion: 1 }))
    expect(paused).toMatchObject({ version: 2, status: 'paused', previousMemoryVersionId: first.memoryVersionId })
    expect(() => controls.command({ action: 'pause', idempotencyKey: 'pause:stale', memoryVersionId: first.memoryVersionId, expectedVersion: 1 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const edited = memory(controls.command({ action: 'edit', idempotencyKey: 'edit:preference', memoryVersionId: paused.memoryVersionId, expectedVersion: 2,
      replacement: { effect: { key: 'answer-order', value: 'conclusion-first' }, scope: 'workspace' }, statusAfterEdit: 'paused' }))
    expect(edited).toMatchObject({ version: 3, status: 'paused', effect: { key: 'answer-order', value: 'conclusion-first' }, scope: { kind: 'workspace', profileId, workspaceId } })
    const resumed = memory(controls.command({ action: 'resume', idempotencyKey: 'resume:preference', memoryVersionId: edited.memoryVersionId, expectedVersion: 3 }))
    expect(resumed).toMatchObject({ status: 'active', version: 4 })
    const forgotten = controls.command({ action: 'forget', idempotencyKey: 'forget:preference', target: 'memory-chain', memoryVersionId: resumed.memoryVersionId, expectedVersion: 4,
      mode: 'memory-only', provenanceHandling: 'orphan', acknowledgeExternalRetention: true })
    expect(forgotten).toMatchObject({ action: 'forget', receipt: { activeProjectionRemoved: true, sessionLogChanged: false, providerCopiesChanged: false } })
    expect(controls.inspect().memories).toEqual([expect.objectContaining({ status: 'deleted', version: 5 })])
    expect(controls.whyUsed()).toEqual([])
  })

  it('exports the same private profile and provides explicit profile erasure receipts without claiming transcript deletion', async () => {
    const { controls, store } = await fixture()
    controls.command({ action: 'set-preference', idempotencyKey: 'create:exported', preference })
    const result = controls.command({ action: 'export', idempotencyKey: 'export:profile', format: 'json', includeProvenanceRefs: false, includeStatuses: ['active'] })
    if (result.action !== 'export') throw new Error('Expected export')
    const asset = controls.exportAsset(result.export.assetId)
    expect(asset.descriptor).toEqual(result.export)
    expect(createHash('sha256').update(asset.bytes).digest('hex')).toBe(asset.descriptor.contentHash)
    expect(JSON.parse(asset.bytes.toString('utf8'))).toMatchObject({ exportType: 'docatlas-personalization', profileId, memories: [expect.objectContaining({ summary: 'answer-order: evidence-first' })] })
    const revision = controls.inspect().profileRevision
    const erased = controls.command({ action: 'forget', idempotencyKey: 'erase:profile', target: 'profile', expectedProfileRevision: revision,
      mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true })
    expect(erased).toMatchObject({ action: 'forget', receipt: { backupDisposition: 'compacted', sessionLogChanged: false, providerCopiesChanged: false } })
    expect(controls.inspect()).toMatchObject({ counts: { memories: 0, decisions: 0, uses: 0 } })
    expect(() => controls.exportAsset(result.export.assetId)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    expect(readFileSync(store.databasePath(profileId)).includes(Buffer.from('answer-order: evidence-first'))).toBe(false)
  })

  it('rejects model authority, hidden identity fields, inference and unsupported preference axes before persistence', async () => {
    const { store, identity, controls } = await fixture(), write = vi.spyOn(store, 'command')
    const basic = { action: 'set-preference', idempotencyKey: 'rejected:preference', preference }
    for (const value of [
      { ...basic, profileId: 'profile:foreign' }, { ...basic, workspaceId: 'workspace:foreign' },
      { ...basic, sessionId: 'conversation:foreign' }, { ...basic, actor: human },
      { ...basic, preference: { ...preference, summary: 'A model-inferred personal trait' } },
      { ...basic, preference: { ...preference, sensitivity: 'sensitive' } },
      { ...basic, preference: { ...preference, scope: { kind: 'global', profileId } } },
      { ...basic, preference: { effect: { key: 'challenge-depth', value: 'extra-counterevidence' }, scope: 'global' } },
      { ...basic, preference: { effect: { key: 'preferred-representation', value: 'markdown' }, scope: 'global' } },
      { ...basic, preference: { effect: { key: 'answer-order', value: 'invent-new-facts' }, scope: 'global' } },
      { action: 'review-candidate', idempotencyKey: 'review:forbidden', candidateId: 'candidate:inferred', expectedVersion: 1, decision: 'accept' },
      { action: 'pause', idempotencyKey: 'pause:until', memoryVersionId: 'memory:unknown', expectedVersion: 1, until: timestamp },
    ]) expect(() => controls.command(value)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const agentControls = new PersonalizationControls(store, () => ({ ...identity, actor: { kind: 'agent', actorId: 'model:untrusted' } } as unknown as TrustedPersonalizationIdentity))
    expect(() => agentControls.command(basic)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(write).not.toHaveBeenCalled()
    expect(() => controls.inspect(0)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(() => controls.exportAsset('/private/export.json')).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
  })

  it('reports why-used only after a matching recorded use and excludes other conversation activity', async () => {
    const { store, controls, identity } = await fixture()
    controls.command({ action: 'set-session-policy', idempotencyKey: 'policy:use', expectedVersion: 0, policy: { useExisting: true, contributeToFuture: false } })
    const saved = memory(controls.command({ action: 'set-preference', idempotencyKey: 'create:used', preference }))
    const decision = store.compileDecision({ profileId, sessionId, turn: 1, taskContext: { mode: 'explore', workspaceId }, sourceScopeVersionId: 'scope:unchanged', baselineDigest: 'a'.repeat(64) })!
    expect(controls.inspect().decisions).toHaveLength(1)
    expect(controls.whyUsed()).toEqual([])
    const use: MemoryUse = { schemaVersion: 1, recordType: 'memory-use', memoryUseId: 'use:actually-recorded', decisionId: decision.decisionId,
      memoryVersionId: saved.memoryVersionId, profileId, sessionId, turn: 1, effect: saved.effect, affectedActions: ['answer-render'], usedAt: timestamp }
    store.recordMemoryUse(use)
    expect(controls.whyUsed()).toEqual([{ use, decision }])
    expect(decision.why).toEqual([{ memoryVersionId: saved.memoryVersionId, reason: 'explicit-setting' }])
    const other = new PersonalizationControls(store, () => ({ ...identity, sessionId: 'conversation:other' }))
    expect(other.inspect()).toMatchObject({ counts: { memories: 1, decisions: 0, uses: 0 } })
    expect(other.whyUsed()).toEqual([])
    expect(JSON.stringify(other.inspect())).not.toContain('use:actually-recorded')
    expect(JSON.stringify(other.inspect())).not.toContain('scope:unchanged')
    controls.command({ action: 'pause', idempotencyKey: 'pause:used', memoryVersionId: saved.memoryVersionId, expectedVersion: 1 })
    expect(controls.whyUsed()).toEqual([{ use, decision }]) // Historical application remains truthful after pausing future use.
  })

  it('rechecks trusted access for every operation without returning a foreign inspection', async () => {
    const { store, identity } = await fixture()
    const controls = new PersonalizationControls(store, () => ({ ...identity, assertCurrent: () => { throw new PersonalizationStoreError('permission-denied', 'revoked') } }))
    const inspect = vi.spyOn(store, 'inspect')
    expect(() => controls.inspect()).toThrow('revoked')
    expect(() => controls.command({ action: 'set-preference', idempotencyKey: 'revoked:write', preference })).toThrow('revoked')
    expect(inspect).not.toHaveBeenCalled()
  })
})
