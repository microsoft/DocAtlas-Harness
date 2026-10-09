import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryCandidate, PersonalizationCommandRequest, PersonalizationObservation, PreferenceChoiceObservation, PreferenceProbe } from '@docatlas/contracts'
import { PersonalizationStore, type ProbeChoiceCommit, type PersonalizationTransactionGuard } from '../src/storage/personalization-store.js'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m6/personalization.valid.json', import.meta.url), 'utf8')) as {
  preferenceProbe: PreferenceProbe, preferenceChoice: PreferenceChoiceObservation, pairwiseObservation: PersonalizationObservation,
}
const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const requestedProbe = (probe: PreferenceProbe, probeId: string): PreferenceProbe => {
  const value = { ...structuredClone(probe), probeId, trigger: 'user-requested' as const }; delete value.automaticOrdinal; return value
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-controlled-probe-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = await PersonalizationStore.open(root, () => new Date('2026-09-09T00:00:00Z')); cleanup.push(() => store.close())
  const probe = structuredClone(fixture.preferenceProbe), choice = structuredClone(fixture.preferenceChoice), observation = structuredClone(fixture.pairwiseObservation)
  const base = { schemaVersion: 1 as const, requestType: 'personalization-command' as const, profileId: probe.profileId, sessionId: probe.sessionId, actor: { kind: 'user' as const, actorId: 'user:local' } }
  const policy = (enabled: boolean, expectedVersion: number) => store.command({ ...base, action: 'set-session-policy', idempotencyKey: `policy:${expectedVersion}`,
    expectedVersion, policy: { useExisting: true, contributeToFuture: enabled } })
  policy(true, 0)
  const guard: PersonalizationTransactionGuard = { expectedProfileEpoch: 0, expectedPolicyVersion: 1, assertCurrent() {} }
  const candidate: MemoryCandidate = { schemaVersion: 1, recordType: 'memory-candidate', candidateId: 'candidate:probe:one', profileId: probe.profileId, version: 1,
    proposedMemoryType: 'presentation-preference', proposedEffect: probe.variants.find(variant => variant.variantKey === choice.selected)!.effect,
    proposedScope: observation.scope, observationIds: [observation.observationId], independentLineageCount: 1, counterObservationIds: [], formation: 'preference-probe',
    risk: 'low', sensitivity: 'ordinary', decision: 'pending', rationaleCode: 'controlled-probe-choice', createdAt: observation.occurredAt }
  const input = (): ProbeChoiceCommit => structuredClone({ command: { idempotencyKey: 'product:choice:one', requestHash: hash('complete original product body') }, choice, observation, candidate })
  const inspect = () => store.probeChoice(probe.profileId, probe.probeId)
  const review = (decision: 'accept' | 'reject' = 'accept'): PersonalizationCommandRequest => ({ ...base, action: 'review-candidate', idempotencyKey: 'product:review:one',
    candidateId: candidate.candidateId, expectedVersion: 1, decision })
  const erase = (): PersonalizationCommandRequest => ({ ...base, action: 'forget', idempotencyKey: 'erase:profile', target: 'profile', expectedProfileRevision: store.ledgerRevision(probe.profileId),
    mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true })
  const exported = (key: string, includeProvenanceRefs = true, format: 'json' | 'markdown' = 'json'): string => {
    const result = store.command({ ...base, action: 'export', idempotencyKey: key, includeProvenanceRefs, includeStatuses: ['active', 'paused', 'disputed', 'superseded', 'expired', 'archived'], format })
    if (result.action !== 'export') throw new Error('Expected export receipt')
    return store.exportAsset(probe.profileId, result.export.assetId).bytes.toString('utf8')
  }
  return { root, store, probe, choice, observation, candidate, base, guard, input, policy, inspect, review, erase, exported }
}

describe('controlled preference probe transactions in the existing profile ledger', () => {
  it('atomically records one choice, observation and pending candidate, then replays its original receipt after candidate review and reopen', async () => {
    const f = await setup(), input = f.input()
    f.store.recordProbe(f.probe, f.guard)
    const before = f.store.ledgerRevision(f.probe.profileId), result = f.store.commitProbeChoice(input, f.guard)
    expect(result).toEqual({ status: 'created', choice: f.choice, candidateId: f.candidate.candidateId })
    expect(f.store.ledgerRevision(f.probe.profileId)).toBe(before + 1)
    expect(f.store.currentMemories(f.probe.profileId)).toEqual([])
    expect(f.inspect()).toEqual({ command: input.command, choice: f.choice, observation: f.observation, candidateId: f.candidate.candidateId })
    expect(f.store.candidate(f.probe.profileId, f.candidate.candidateId)).toEqual(f.candidate)
    const reviewed = f.store.command(f.review(), 0, hash('complete product review body'))
    expect(reviewed).toMatchObject({ candidate: { version: 2, decision: 'promote' }, memoryVersion: { status: 'active' } })
    expect(f.store.commitProbeChoice(input, f.guard)).toEqual({ ...result, status: 'replayed' })
    expect(f.inspect()).not.toHaveProperty('candidate')
    f.store.close()
    const reopened = await PersonalizationStore.open(f.root); cleanup.push(() => reopened.close())
    expect(reopened.probeChoice(f.probe.profileId, f.probe.probeId)).toEqual({ command: input.command, choice: f.choice, observation: f.observation, candidateId: f.candidate.candidateId })
    expect(reopened.commitProbeChoice(input, f.guard)).toMatchObject({ status: 'replayed', candidateId: f.candidate.candidateId })
  })

  it('rolls back every row and journal event when final authorization fails, and rejects asynchronous guards before writes', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard)
    const revision = f.store.ledgerRevision(f.probe.profileId); let checks = 0
    expect(() => f.store.commitProbeChoice(f.input(), { ...f.guard, assertCurrent() { if (++checks === 3) throw new Error('source authorization revoked') } })).toThrow('source authorization revoked')
    expect(f.store.preferenceChoice(f.probe.profileId, f.choice.choiceObservationId)).toBeUndefined()
    expect(f.store.observation(f.probe.profileId, f.observation.observationId)).toBeUndefined()
    expect(f.store.candidate(f.probe.profileId, f.candidate.candidateId)).toBeUndefined()
    expect(f.inspect()).toBeUndefined(); expect(f.store.ledgerRevision(f.probe.profileId)).toBe(revision)
    expect(() => f.store.commitProbeChoice(f.input(), { ...f.guard, assertCurrent: async () => {} })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const next = requestedProbe(f.probe, 'probe:async')
    expect(() => f.store.recordProbe(next, { ...f.guard, assertCurrent: async () => {} })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(f.store.probe(next.profileId, next.probeId)).toBeUndefined()
    expect(f.store.ledgerRevision(f.probe.profileId)).toBe(revision)
  })

  it('checks epoch and contribution inside the transaction, but exact historical replay remains read-only after policy revocation', async () => {
    const f = await setup(), input = f.input(); f.store.recordProbe(f.probe, f.guard)
    f.policy(false, 1)
    expect(() => f.store.commitProbeChoice(input, f.guard)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(f.inspect()).toBeUndefined()
    expect(f.store.recordProbe(f.probe, f.guard)).toEqual(f.probe)
    expect(() => f.store.recordProbe(requestedProbe(f.probe, 'probe:disabled'), f.guard)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    f.policy(true, 2)
    expect(() => f.store.commitProbeChoice(input, f.guard)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    f.store.commitProbeChoice(input, { ...f.guard, expectedPolicyVersion: 3 }); f.policy(false, 3)
    const revision = f.store.ledgerRevision(f.probe.profileId)
    expect(f.store.commitProbeChoice(input, f.guard)).toMatchObject({ status: 'replayed' })
    expect(f.store.ledgerRevision(f.probe.profileId)).toBe(revision)
    expect(() => f.store.commitProbeChoice(input, { ...f.guard, assertCurrent() { throw new Error('session revoked') } })).toThrow('session revoked')
    expect(() => f.store.commitProbeChoice(input, { ...f.guard, expectedProfileEpoch: 1 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })

  it('admits only one complete vote across already-open store handles and never mistakes raw partial rows for a controlled receipt', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard)
    const second = await PersonalizationStore.open(f.root); cleanup.push(() => second.close())
    second.profileEpoch(f.probe.profileId)
    f.store.commitProbeChoice(f.input(), f.guard)
    const competing = f.input(); competing.command.idempotencyKey = 'product:competing'; competing.choice.choiceObservationId = 'choice:competing'
    competing.observation.observationId = 'observation:competing'; competing.candidate!.candidateId = 'candidate:competing'
    expect(() => second.commitProbeChoice(competing, f.guard)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => second.recordPreferenceChoice(competing.choice)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(second.recordPreferenceChoice(f.choice)).toEqual(f.choice)
    const legacy = requestedProbe(f.probe, 'probe:legacy')
    f.store.recordProbe(legacy)
    const rawChoice = { ...f.choice, probeId: legacy.probeId, choiceObservationId: 'choice:legacy:first' }
    f.store.recordPreferenceChoice(rawChoice); f.store.recordPreferenceChoice({ ...rawChoice, choiceObservationId: 'choice:legacy:second' })
    expect(f.store.probeChoice(legacy.profileId, legacy.probeId)).toBeUndefined()
    const partial = f.input(); partial.choice = rawChoice
    expect(() => f.store.commitProbeChoice(partial, f.guard)).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })

  it('rejects changed command bodies and cross-probe, actor, axis, consent, source and scope substitutions without partial writes', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard)
    const mutations: Array<(value: ProbeChoiceCommit) => void> = [
      value => { value.choice.turn++ }, value => { value.choice.selected = 'variant:invented' },
      value => { value.observation.sessionId = 'session:foreign' }, value => { value.observation.observedActor = { kind: 'rule', actorId: 'rule:inferred' } },
      value => { value.observation.taskContext.workspaceId = 'workspace:foreign' },
      value => { value.observation.scope = { kind: 'global', profileId: f.probe.profileId } },
      value => { value.observation.consent.retention = 'session-only' },
      value => { value.candidate!.proposedEffect = { key: 'explanation-depth', value: 'brief' } },
      value => { value.candidate!.observationIds = ['observation:unrelated'] }, value => { value.candidate!.version = 2 },
      value => { value.candidate!.decision = 'promote' }, value => { value.candidate!.proposedScope = { kind: 'global', profileId: f.probe.profileId } },
    ]
    for (const mutate of mutations) { const value = f.input(); mutate(value); expect(() => f.store.commitProbeChoice(value, f.guard)).toThrowError(expect.objectContaining({ code: 'invalid-request' })) }
    expect(f.inspect()).toBeUndefined(); expect(f.store.candidate(f.probe.profileId, f.candidate.candidateId)).toBeUndefined()
    f.store.commitProbeChoice(f.input(), f.guard)
    const different = f.input(); different.command.requestHash = hash('different original product body')
    expect(() => f.store.commitProbeChoice(different, f.guard)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const differentInputs = f.input(); differentInputs.choice.reasonTags = ['faster-understanding']
    expect(() => f.store.commitProbeChoice(differentInputs, f.guard)).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })

  it('keeps turn and reserved feedback session-only, derives bounded task-family scope, and never promotes at choice time', async () => {
    const f = await setup()
    for (const [index, selected] of ['both', 'neither', 'dismissed', f.choice.selected].entries()) {
      const probe = requestedProbe(f.probe, `probe:transient:${index}`); f.store.recordProbe(probe, f.guard)
      const value = f.input(); value.command.idempotencyKey = `choice:transient:${index}`; value.choice.probeId = probe.probeId
      value.choice.choiceObservationId = `choice:transient:${index}`; value.choice.selected = selected; value.choice.scopeIntent = 'turn'; value.choice.consent.retention = 'session-only'
      value.observation.observationId = `observation:transient:${index}`; value.observation.sourceRef = { kind: 'preference-probe', probeId: probe.probeId }
      if (value.observation.signal !== 'pairwise-preference-choice') throw new Error('Expected pairwise observation')
      value.observation.detail = { probeId: probe.probeId, choiceObservationId: value.choice.choiceObservationId, selected }; value.observation.consent.retention = 'session-only'
      expect(() => f.store.commitProbeChoice(value, f.guard)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
      delete value.candidate
      expect(f.store.commitProbeChoice(value, f.guard)).toEqual({ status: 'created', choice: value.choice })
    }
    const family = f.input(); f.store.recordProbe(f.probe, f.guard); family.choice.scopeIntent = 'task-family'
    family.observation.scope = { kind: 'task-family', profileId: f.probe.profileId, taskFamily: f.probe.taskContext.taskFamily!, workspaceId: f.probe.taskContext.workspaceId! }
    family.candidate!.proposedScope = family.observation.scope
    expect(f.store.commitProbeChoice(family, f.guard)).toMatchObject({ candidateId: family.candidate!.candidateId })
    expect(f.store.currentMemories(f.probe.profileId)).toEqual([])
    expect(f.exported('export:transient')).not.toContain('probe:transient:')
  })

  it('binds full product command hashes without changing legacy replay and preserves the exact one-epoch erasure exception', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard); f.store.commitProbeChoice(f.input(), f.guard)
    const command = f.review('reject'), commandHash = hash('review product envelope')
    f.store.command(command, 0, commandHash)
    expect(f.store.command(command, 0, commandHash)).toMatchObject({ status: 'replayed' })
    expect(() => f.store.command(command, 0, hash('changed envelope'))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.command(command, 0)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.command(command, 0, 'bad')).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const erase = f.erase(), eraseHash = hash('erase full body'); f.store.command(erase, 0, eraseHash)
    expect(f.store.command(erase, 0, eraseHash)).toMatchObject({ status: 'replayed' })
    expect(() => f.store.command(erase, 0, hash('changed erase body'))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.inspect()).toBeUndefined(); expect(f.store.probe(f.probe.profileId, f.probe.probeId)).toBeUndefined()
    expect(f.store.peekProfile(f.probe.profileId, f.probe.sessionId)).toEqual({ profileEpoch: 1 })
    expect(() => f.store.commitProbeChoice(f.input(), f.guard)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.recordProbe(f.probe, f.guard)).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })

  it('reauthorizes explicit candidate review inside its transaction and on replay without requiring future contribution', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard); f.store.commitProbeChoice(f.input(), f.guard); f.policy(false, 1)
    const request = f.review(), commandHash = hash('independent explicit review'), revision = f.store.ledgerRevision(f.probe.profileId)
    let checks = 0
    expect(() => f.store.command(request, 0, commandHash, () => { if (++checks === 3) throw new Error('original answer unavailable') })).toThrow('original answer unavailable')
    expect(f.store.currentMemories(f.probe.profileId)).toEqual([])
    expect(f.store.candidate(f.probe.profileId, f.candidate.candidateId)).toEqual(f.candidate)
    expect(f.store.ledgerRevision(f.probe.profileId)).toBe(revision)
    expect(() => f.store.command(request, 0, commandHash, async () => {})).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(f.store.command(request, 0, commandHash, () => {})).toMatchObject({ candidate: { decision: 'promote' } })
    expect(() => f.store.command(request, 0, commandHash, () => { throw new Error('actor revoked') })).toThrow('actor revoked')
    expect(f.store.command(request, 0, commandHash, () => {})).toMatchObject({ status: 'replayed' })
    expect(() => f.store.command(f.erase(), 0, hash('erase'), () => {})).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
  })

  it('preserves historical session-policy consent after opt-out and reopening, without admitting new contributions', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard)
    const input = f.input(); input.choice.consent.basis = 'session-policy'; input.observation.consent.basis = 'session-policy'
    f.store.commitProbeChoice(input, f.guard); f.policy(false, 1); f.store.close()
    const reopened = await PersonalizationStore.open(f.root); cleanup.push(() => reopened.close())
    expect(reopened.commitProbeChoice(input, f.guard)).toMatchObject({ status: 'replayed' })
    expect(reopened.peekProfile(f.probe.profileId, f.probe.sessionId)).toMatchObject({ profileEpoch: 0, sessionPolicy: { version: 2, contributeToFuture: false } })
    expect(() => reopened.recordProbe(requestedProbe(f.probe, 'probe:after-opt-out'), f.guard)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
  })

  it('exports eligible unpromoted work and choices in JSON/Markdown while redacting provenance and excluding the forgotten source closure', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard); f.store.commitProbeChoice(f.input(), f.guard)
    const pending = JSON.parse(f.exported('export:pending')) as { candidates: MemoryCandidate[], observations: PersonalizationObservation[], choices: PreferenceChoiceObservation[], probes: PreferenceProbe[] }
    expect(pending).toMatchObject({ candidates: [f.candidate], observations: [f.observation], choices: [f.choice], probes: [f.probe] })
    const markdown = f.exported('export:markdown', true, 'markdown')
    expect(markdown).toContain(JSON.stringify(f.choice, null, 2).split('\n')[1]!.trim())
    expect(markdown).toContain(f.candidate.candidateId); expect(markdown).toContain(f.observation.observationId)
    const redacted = f.exported('export:redacted', false)
    expect(redacted).not.toContain('factTraceDigest'); expect(redacted).not.toContain('sourceRef'); expect(redacted).not.toContain('reasonTags')
    const sibling = { ...f.candidate, candidateId: 'candidate:forgotten-sibling' }; f.store.recordCandidate(sibling)
    const accepted = f.store.command(f.review(), 0)
    if (accepted.action !== 'review-candidate' || !accepted.memoryVersion) throw new Error('Expected explicit memory acceptance')
    f.store.command({ ...f.base, action: 'forget', idempotencyKey: 'forget:chain', target: 'memory-chain', memoryVersionId: accepted.memoryVersion.memoryVersionId,
      expectedVersion: 1, mode: 'memory-only', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true }, 0)
    const forgotten = f.exported('export:forgotten'), forgottenMarkdown = f.exported('export:forgotten:markdown', true, 'markdown')
    for (const id of [f.probe.probeId, f.choice.choiceObservationId, f.observation.observationId, f.candidate.candidateId, sibling.candidateId]) {
      expect(forgotten).not.toContain(id); expect(forgottenMarkdown).not.toContain(id)
    }
  })

  it('returns detached exact records without creating absent profiles and rejects corrupt original receipt payloads', async () => {
    const f = await setup(); f.store.recordProbe(f.probe, f.guard); f.store.commitProbeChoice(f.input(), f.guard)
    const value = f.inspect()!; value.command.requestHash = '0'.repeat(64); value.observation.lineageKey = 'lineage:caller-changed'
    expect(f.inspect()!.command.requestHash).toBe(f.input().command.requestHash)
    expect(f.store.observation(f.probe.profileId, f.observation.observationId)).toEqual(f.observation)
    expect(f.store.probe('profile:absent', f.probe.probeId)).toBeUndefined()
    expect(f.store.preferenceChoice('profile:absent', f.choice.choiceObservationId)).toBeUndefined()
    expect(f.store.observation('profile:absent', f.observation.observationId)).toBeUndefined()
    expect(f.store.probeChoice('profile:absent', f.probe.probeId)).toBeUndefined()
    expect(f.store.peekProfile('profile:absent', f.probe.sessionId)).toEqual({ profileEpoch: 0 })
    expect(existsSync(f.store.databasePath('profile:absent'))).toBe(false)
    const database = new DatabaseSync(f.store.databasePath(f.probe.profileId))
    try { database.prepare("UPDATE personalization_journal SET payload_json = '{}' WHERE event_type = 'preference-choice.committed'").run() } finally { database.close() }
    expect(() => f.inspect()).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    expect(() => f.store.commitProbeChoice(f.input(), f.guard)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })
})
