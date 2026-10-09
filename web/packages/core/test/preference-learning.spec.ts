import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AnswerManifest, PersonalizationObservation, PreferenceChoiceObservation } from '@docatlas/contracts'
import { PersonalizationStore } from '../src/storage/personalization-store.js'
import { controlledProbeId, controlledProbeMaterial, createLearningProbe, verifyControlledProbe, verifyLearningProbe } from '../src/personalization/controlled-presentation.js'
import type { LearningAnswerRef, LearningChoiceInput, LearningCommandIdentity, LearningGuard, LearningMode } from '../src/personalization/learning.js'

const sample = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/answer-manifest.json', import.meta.url), 'utf8')).manifest as AnswerManifest
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const profileId = 'profile:controlled-learning', workspaceId = 'workspace:controlled-learning', actorId = 'actor:controlled-learning'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-preference-learning-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let time = Date.parse('2026-09-09T00:00:00.000Z'), store = await PersonalizationStore.open(root, () => new Date(time))
  cleanup.push(() => store.close())
  const denied = new Set<string>()
  const guard = (): LearningGuard => ({ expectedProfileEpoch: 0, expectedPolicyVersion: 1, assertCurrent() {}, authorizeOrigins: refs => refs.every(ref => !denied.has(ref.probeId)) })
  const command = (conversationId: string, key: string, payload: unknown = key): LearningCommandIdentity => ({ idempotencyKey: `learning:test:${key}`, requestHash: hash(JSON.stringify(payload)),
    actorId, workspaceId, conversationId, bindingId: `binding:${conversationId}`, generation: 1 })
  const subject = (key: string, mode: LearningMode = 'explore', investigationId = `investigation:${key}`, conversationId = `conversation:${key}`) => {
    const manifest = { ...structuredClone(sample), workspaceId, sessionId: conversationId, investigationId, messageId: `message:${key}`, manifestId: `manifest:${key}`,
      sourceScopeVersionId: `scope:${key}`, mode }
    const material = controlledProbeMaterial(manifest, hash(`native:${key}`)), probe = createLearningProbe({ profileId, profileEpoch: 0, material, evidenceFirstOnLeft: false, generatedAt: new Date(time).toISOString() })
    const original: LearningAnswerRef = { profileEpoch: 0, probeId: probe.probeId, workspaceId, conversationId, messageId: manifest.messageId, manifestId: manifest.manifestId,
      investigationId, sourceScopeVersionId: manifest.sourceScopeVersionId, materialHash: material.materialHash, nativeTextHash: material.nativeTextHash, mode, turn: manifest.turn }
    return { key, material, probe, original }
  }
  const policy = (conversationId: string, enabled = true, expectedVersion = 0) => store.command({ schemaVersion: 1, requestType: 'personalization-command', profileId, sessionId: conversationId,
    actor: { kind: 'user', actorId }, idempotencyKey: `learning-policy:${conversationId}:${expectedVersion}`, action: 'set-session-policy', expectedVersion,
    policy: { useExisting: false, contributeToFuture: enabled } }, 0)
  const prepare = (value: ReturnType<typeof subject>) => {
    if (!store.sessionPolicy(profileId, value.original.conversationId)) policy(value.original.conversationId)
    return store.prepareLearningProbe(profileId, { probe: value.probe, original: value.original, command: command(value.original.conversationId, `prepare:${value.key}`) }, guard())
  }
  const choice = (value: ReturnType<typeof subject>, selected = 'variant:answer-first', scopeIntent: 'turn' | 'workspace' = 'workspace', key = `choose:${value.key}`): LearningChoiceInput => {
    const cmd = command(value.original.conversationId, key, { selected, scopeIntent, key }), occurredAt = new Date(time).toISOString()
    const consent = { retention: scopeIntent === 'workspace' && !['both', 'neither', 'dismissed'].includes(selected) ? 'eligible' as const : 'session-only' as const, basis: 'session-policy' as const }
    const selectedChoice: PreferenceChoiceObservation = { schemaVersion: 1, recordType: 'preference-choice-observation', profileId, probeId: value.probe.probeId,
      choiceObservationId: `choice:learning:${hash(key)}`, sessionId: value.probe.sessionId, turn: value.probe.turn, selected, scopeIntent, consent, occurredAt }
    const observation: PersonalizationObservation = { schemaVersion: 1, recordType: 'personalization-observation', profileId, observationId: `observation:learning:${hash(key)}`,
      sessionId: value.probe.sessionId, occurredAt, observedActor: { kind: 'user', actorId }, sourceRef: { kind: 'preference-probe', probeId: value.probe.probeId },
      lineageKey: value.original.investigationId, taskContext: value.probe.taskContext, scope: { kind: 'workspace', profileId, workspaceId }, consent,
      signal: 'pairwise-preference-choice', detail: { probeId: value.probe.probeId, choiceObservationId: selectedChoice.choiceObservationId, selected } }
    return { command: cmd, choice: selectedChoice, observation, original: value.original }
  }
  const vote = (value: ReturnType<typeof subject>, selected?: string, scopeIntent?: 'turn' | 'workspace') => { prepare(value); return store.commitLearningChoice(choice(value, selected, scopeIntent), guard()) }
  const state = (mode: LearningMode = 'explore') => store.learningState(profileId, workspaceId, mode, guard())
  const settings = (enabled = true, expectedVersion = 0, key = 'settings:enabled') => store.setLearningSettings(profileId, { command: command('conversation:settings', key), expectedVersion, enabled }, guard())
  const review = (decision: 'accept' | 'reject' = 'accept', mode: LearningMode = 'explore') => {
    const current = state(mode)
    return store.reviewLearningCandidate(profileId, { command: command('conversation:review', `review:${decision}:${mode}`), groupId: current.groupId, candidateId: current.candidate!.candidateId,
      expectedCandidateVersion: current.candidate!.version, expectedGroupDigest: current.groupDigest!, decision }, guard())
  }
  const base = { schemaVersion: 1 as const, requestType: 'personalization-command' as const, profileId, sessionId: 'conversation:settings', actor: { kind: 'user' as const, actorId } }
  const exported = (key: string, provenance = true) => {
    const result = store.command({ ...base, idempotencyKey: key, action: 'export', format: 'json', includeProvenanceRefs: provenance,
      includeStatuses: ['active', 'paused', 'disputed', 'superseded', 'expired', 'archived'] }, 0)
    if (result.action !== 'export') throw new Error('Expected export')
    return store.exportAsset(profileId, result.export.assetId).bytes.toString('utf8')
  }
  return { root, get store() { return store }, denied, guard, command, subject, prepare, choice, vote, state, settings, review, policy, base, exported,
    advance: (milliseconds: number) => { time += milliseconds }, reopen: async () => { store.close(); store = await PersonalizationStore.open(root, () => new Date(time)) } }
}

it('keeps missing-profile inspections default-off and read-only without a memory or document store', async () => {
  const f = await fixture()
  expect(f.store.learningSettings(profileId)).toEqual({ version: 0, enabled: false })
  expect(f.state()).toMatchObject({ status: 'collecting', members: [], independentCounts: { 'conclusion-first': 0, 'evidence-first': 0 } })
  expect(f.store.learningOffers(profileId, workspaceId, 'conversation:missing', f.guard())).toEqual([])
  expect(existsSync(f.store.databasePath(profileId))).toBe(false)
})

it('versions the independent setting and atomically preserves its exact full-command receipt', async () => {
  const f = await fixture(), receipt = f.settings()
  expect(f.store.learningSettings(profileId)).toEqual({ version: 1, enabled: true })
  expect(f.store.peekProfile(profileId, 'conversation:settings').sessionPolicy).toBeUndefined()
  expect(f.settings()).toEqual(receipt)
  expect(f.store.learningReceipt(profileId, receipt.operationId, f.guard())).toEqual(receipt)
  expect(() => f.settings(false, 0, 'settings:stale')).toThrow('version changed')
  expect(() => f.store.setLearningSettings(profileId, { command: { ...receipt.command, requestHash: hash('changed') }, expectedVersion: 0, enabled: true }, f.guard())).toThrow('different complete command')
  await f.reopen()
  expect(f.store.learningSettings(profileId)).toEqual({ version: 1, enabled: true })
  expect(f.store.learningReceipt(profileId, receipt.operationId, f.guard())).toEqual(receipt)
})

it('reserves invitations only with both independent consents, three completions, one Investigation slot and the ten-minute profile cooldown', async () => {
  const f = await fixture(), first = f.subject('offer:first')
  f.policy(first.original.conversationId, false)
  expect(f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 3 }, f.guard())).toBeUndefined()
  f.settings()
  expect(f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 3 }, f.guard())).toBeUndefined()
  f.policy(first.original.conversationId, true, 1)
  const guard = { ...f.guard(), expectedPolicyVersion: 2 }
  expect(f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 2 }, guard)).toBeUndefined()
  const offer = f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 3 }, guard)!
  expect(offer.status).toBe('offered')
  expect(f.store.probe(profileId, first.probe.probeId)).toBeUndefined()
  expect(f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 4 }, guard)).toBeUndefined()
  const second = f.subject('offer:second'); f.policy(second.original.conversationId)
  f.advance(599999)
  expect(f.store.reserveLearningOffer(profileId, { original: second.original, completedSubmissions: 3 }, f.guard())).toBeUndefined()
  f.advance(1)
  expect(f.store.reserveLearningOffer(profileId, { original: second.original, completedSubmissions: 3 }, f.guard())).toMatchObject({ status: 'offered' })
  expect(f.store.currentMemories(profileId)).toEqual([])
  await f.reopen()
  expect(f.store.learningOffers(profileId, workspaceId, first.original.conversationId, f.guard())).toEqual([offer])
})

it('shares the sole automatic slot with legacy automatic Probes in both directions', async () => {
  const f = await fixture(); f.settings()
  const first = f.subject('slot:first'); f.policy(first.original.conversationId)
  const legacy = { ...first.probe, probeId: 'probe:legacy-automatic', trigger: 'low-confidence' as const, automaticOrdinal: 1 as const }
  f.store.recordProbe(legacy, f.guard())
  expect(f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 3 }, f.guard())).toBeUndefined()
  const second = f.subject('slot:second'); f.policy(second.original.conversationId)
  expect(f.store.reserveLearningOffer(profileId, { original: second.original, completedSubmissions: 3 }, f.guard())).toBeDefined()
  expect(() => f.store.recordProbe({ ...legacy, probeId: 'probe:legacy-blocked', investigationId: second.original.investigationId }, f.guard())).toThrow('slot')
})

it('dismisses an invitation by exact CAS without recording any preference or reopening its slot', async () => {
  const f = await fixture(), value = f.subject('dismiss'); f.settings(); f.policy(value.original.conversationId)
  const offer = f.store.reserveLearningOffer(profileId, { original: value.original, completedSubmissions: 3 }, f.guard())!
  const input = { offerId: offer.offerId, expectedOfferVersion: 1, command: f.command(value.original.conversationId, 'dismiss:offer') }
  const receipt = f.store.dismissLearningOffer(profileId, input, f.guard())
  expect(f.store.dismissLearningOffer(profileId, input, f.guard())).toEqual(receipt)
  expect(f.store.learningOffers(profileId, workspaceId, value.original.conversationId, f.guard())[0]).toMatchObject({ status: 'dismissed', version: 2 })
  expect(f.store.learningProbeChoice(profileId, value.probe.probeId, f.guard())).toBeUndefined()
  f.advance(600000)
  expect(f.store.reserveLearningOffer(profileId, { original: value.original, completedSubmissions: 3 }, f.guard())).toBeUndefined()
  expect(f.state().members).toEqual([])
})

it('uses a separately tagged Probe while preserving the exact existing deterministic renderer material', async () => {
  const f = await fixture(), value = f.subject('identity')
  expect(value.probe.probeId).not.toBe(controlledProbeId(profileId, 0, value.material))
  verifyLearningProbe(value.probe, value.material, profileId, 0)
  expect(() => verifyControlledProbe(value.probe, value.material, profileId, 0)).toThrow()
  expect(() => f.store.recordProbe(value.probe, f.guard())).toThrow('original Answer reference')
  f.prepare(value)
  expect(f.store.probe(profileId, value.probe.probeId)).toEqual(value.probe)
})

it('automatically forms exactly one immutable pending candidate at the third independent Investigation without filling earlier receipts', async () => {
  const f = await fixture(), first = f.subject('accumulate:1'), one = f.vote(first)
  expect(one.candidateId).toBeNull(); expect(f.state().status).toBe('collecting')
  const two = f.vote(f.subject('accumulate:2')); expect(two.candidateId).toBeNull()
  const three = f.vote(f.subject('accumulate:3')), state = f.state()
  expect(three.candidateId).toBe(state.candidate?.candidateId)
  expect(state).toMatchObject({ status: 'pending', independentCounts: { 'conclusion-first': 3, 'evidence-first': 0 }, candidate: { version: 1, decision: 'pending', independentLineageCount: 3 } })
  expect(f.store.currentMemories(profileId)).toEqual([])
  expect(f.store.learningReceipt(profileId, one.operationId, f.guard())).toEqual(one)
  expect(f.store.commitLearningChoice(f.choice(first), f.guard())).toEqual(one)
  const originalCandidate = structuredClone(state.candidate)
  const fourth = f.vote(f.subject('accumulate:4')); expect(fourth.candidateId).toBeNull()
  expect(f.state().candidate).toEqual(originalCandidate)
  await f.reopen()
  expect(f.state().candidate).toEqual(originalCandidate)
  expect(f.store.learningProbeChoice(profileId, first.probe.probeId, f.guard())?.receipt.candidateId).toBeNull()
})

it('does not treat multiple questions, forked views or mixed task modes as three independent matching investigations', async () => {
  const f = await fixture()
  f.vote(f.subject('duplicate:1', 'explore', 'investigation:shared'))
  f.vote(f.subject('duplicate:2', 'explore', 'investigation:shared'))
  f.vote(f.subject('duplicate:3', 'explore', 'investigation:shared'))
  expect(f.state()).toMatchObject({ status: 'collecting', candidate: null, independentCounts: { 'conclusion-first': 1 } })
  f.vote(f.subject('mode:verify', 'verify'))
  expect(f.state('verify')).toMatchObject({ candidate: null, independentCounts: { 'conclusion-first': 1 } })
  const value = f.subject('fork:original'); f.prepare(value)
  expect(() => f.store.prepareLearningProbe(profileId, { probe: value.probe, original: value.original, command: f.command('conversation:forked', 'fork:fake-origin') }, f.guard())).toThrow('original Answer conversation')
})

it.each(['both', 'neither', 'dismissed', 'variant:answer-first'])('retains %s turn-only feedback without future accumulation', async selected => {
  const f = await fixture(), value = f.subject(`transient:${selected}`)
  const receipt = f.vote(value, selected, 'turn')
  expect(receipt.groupId).toBeNull(); expect(receipt.candidateId).toBeNull()
  expect(f.state()).toMatchObject({ members: [], candidate: null, independentCounts: { 'conclusion-first': 0, 'evidence-first': 0 } })
  expect(f.exported(`export:${selected}`)).not.toContain(value.probe.probeId)
})

it('keeps opposing eligible choices visible and refuses both fresh candidate creation and stale confirmation', async () => {
  const f = await fixture()
  f.vote(f.subject('opposed:1')); f.vote(f.subject('opposed:2')); f.vote(f.subject('opposed:3'))
  const candidate = f.state().candidate!, before = f.state()
  f.vote(f.subject('opposed:4'), 'variant:evidence-first')
  expect(f.state()).toMatchObject({ status: 'conflicted', independentCounts: { 'conclusion-first': 3, 'evidence-first': 1 }, candidate })
  expect(() => f.store.reviewLearningCandidate(profileId, { command: f.command('conversation:review', 'review:stale'), groupId: before.groupId, candidateId: candidate.candidateId,
    expectedCandidateVersion: 1, expectedGroupDigest: before.groupDigest!, decision: 'accept' }, f.guard())).toThrow('changed before confirmation')
  expect(() => f.review()).toThrow('unopposed')
  expect(f.store.currentMemories(profileId)).toEqual([])
  expect(f.review('reject').memoryVersionId).toBeNull()
  expect(f.state().suppression).toBe('decided-candidate')
})

it('treats an inaccessible counterexample as a whole unavailable group instead of improving apparent agreement', async () => {
  const f = await fixture(), against = f.subject('visibility:against')
  f.vote(f.subject('visibility:1')); f.vote(f.subject('visibility:2')); f.vote(against, 'variant:evidence-first')
  f.denied.add(against.probe.probeId)
  expect(f.state()).toMatchObject({ status: 'unavailable', members: [], independentCounts: null, candidate: null, groupDigest: null })
  expect(f.vote(f.subject('visibility:3')).candidateId).toBeNull()
  f.denied.clear()
  expect(f.state()).toMatchObject({ status: 'conflicted', independentCounts: { 'conclusion-first': 3, 'evidence-first': 1 } })
})

it('requires separate guarded confirmation, blocks legacy review/raw writes and never overwrites an existing workspace preference', async () => {
  const f = await fixture(), one = f.subject('confirm:1'); f.vote(one); f.vote(f.subject('confirm:2')); f.vote(f.subject('confirm:3'))
  const candidate = f.state().candidate!
  expect(() => f.store.command({ ...f.base, idempotencyKey: 'legacy:review-bypass', action: 'review-candidate', candidateId: candidate.candidateId, expectedVersion: 1, decision: 'accept' }, 0)).toThrow('learning review API')
  expect(() => f.store.recordPreferenceChoice(f.choice(one).choice)).toThrow('Raw choices')
  const raw = f.choice(one)
  expect(() => f.store.commitProbeChoice({ choice: raw.choice, observation: raw.observation, command: { idempotencyKey: 'legacy:single-choice', requestHash: hash('legacy') } }, f.guard())).toThrow('single-choice API')
  const receipt = f.review()
  expect(receipt.memoryVersionId).not.toBeNull(); expect(f.store.currentMemories(profileId)).toMatchObject([{ status: 'active', effect: { key: 'answer-order', value: 'conclusion-first' } }])
  expect(f.state().suppression).toBe('existing-preference')
  expect(f.store.learningReceipt(profileId, receipt.operationId, f.guard())).toEqual(receipt)
  await f.reopen()
  expect(f.store.learningReceipt(profileId, receipt.operationId, f.guard())).toEqual(receipt)
})

it('suppresses forgotten groups and excludes their source closure from exports without recycling old eligible votes', async () => {
  const f = await fixture(), one = f.subject('forget:1'); const first = f.vote(one); f.vote(f.subject('forget:2')); f.vote(f.subject('forget:3')); const adopted = f.review()
  const memory = f.store.currentMemories(profileId)[0]!
  f.store.command({ ...f.base, idempotencyKey: 'forget:learned-memory', action: 'forget', target: 'memory-chain', memoryVersionId: memory.memoryVersionId, expectedVersion: memory.version,
    mode: 'memory-only', provenanceHandling: 'orphan', acknowledgeExternalRetention: true }, 0)
  expect(f.store.profileEpoch(profileId)).toBe(0)
  expect(f.state()).toMatchObject({ status: 'suppressed', suppression: 'forgotten', members: [], candidate: null, independentCounts: null })
  expect(() => f.store.learningProbeChoice(profileId, one.probe.probeId, f.guard())).toThrow('Forgotten')
  expect(f.vote(f.subject('forget:4')).candidateId).toBeNull()
  const json = f.exported('export:forgotten')
  expect(json).not.toContain(one.probe.probeId); expect(json).not.toContain(adopted.memoryVersionId!)
  expect(f.store.learningReceipt(profileId, first.operationId, f.guard())).toEqual(first)
})

it('erases learning settings, offers, votes and receipts while retaining the monotonic epoch fence', async () => {
  const f = await fixture(), first = f.subject('erase:first'); f.settings(); f.policy(first.original.conversationId)
  f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 3 }, f.guard())
  f.prepare(first); const receipt = f.store.commitLearningChoice(f.choice(first), f.guard())
  f.store.command({ ...f.base, idempotencyKey: 'erase:learning-profile', action: 'forget', target: 'profile', expectedProfileRevision: f.store.ledgerRevision(profileId),
    mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true }, 0)
  expect(f.store.learningSettings(profileId)).toEqual({ version: 0, enabled: false })
  expect(() => f.store.learningReceipt(profileId, receipt.operationId, f.guard())).toThrow('epoch changed')
  expect(() => f.store.commitLearningChoice(f.choice(first), f.guard())).toThrow('erasure')
  expect(f.store.learningReceipt(profileId, receipt.operationId, { ...f.guard(), expectedProfileEpoch: 1 })).toBeUndefined()
  await f.reopen()
  expect(f.store.peekProfile(profileId, first.original.conversationId)).toEqual({ profileEpoch: 1 })
})

it('rolls back complete learning effects and receipts on final authority failure', async () => {
  const f = await fixture(), one = f.subject('rollback'); f.prepare(one)
  const choice = f.choice(one), revision = f.store.ledgerRevision(profileId)
  const guard = { ...f.guard(), assertCurrent() { if (f.store.preferenceChoice(profileId, choice.choice.choiceObservationId)) throw new Error('authority revoked after writes') } }
  expect(() => f.store.commitLearningChoice(choice, guard)).toThrow('authority revoked')
  expect(f.store.preferenceChoice(profileId, choice.choice.choiceObservationId)).toBeUndefined()
  expect(f.store.observation(profileId, choice.observation.observationId)).toBeUndefined()
  expect(f.store.ledgerRevision(profileId)).toBe(revision)
  expect(() => f.store.prepareLearningProbe(profileId, { probe: one.probe, original: one.original, command: f.command(one.original.conversationId, 'async:prepare') }, { ...f.guard(), assertCurrent: async () => {} })).toThrow('synchronous')
})

it('preserves v2 profile epoch, rows and journal hashes behind a verified backup-first v3 upgrade', async () => {
  const f = await fixture(); f.policy('conversation:migration')
  const path = f.store.databasePath(profileId); f.store.close()
  const old = new DatabaseSync(path)
  let journal: unknown
  try { old.exec('UPDATE personalization_metadata SET schema_version=2,profile_epoch=7'); journal = old.prepare('SELECT event_hash,payload_json FROM personalization_journal ORDER BY event_seq').all() } finally { old.close() }
  await f.reopen()
  expect(f.store.profileEpoch(profileId)).toBe(7)
  const migrated = new DatabaseSync(path, { readOnly: true })
  try { expect(migrated.prepare('SELECT schema_version,profile_epoch FROM personalization_metadata').get()).toMatchObject({ schema_version: 3, profile_epoch: 7 }); expect(migrated.prepare('SELECT event_hash,payload_json FROM personalization_journal ORDER BY event_seq').all()).toEqual(journal) } finally { migrated.close() }
  expect(readdirSync(join(f.root, 'profiles', 'backups')).some(name => name.includes('.v2.'))).toBe(true)
})

it('refuses altered settings/prepare/dismiss/review inputs even if a caller reuses its declared request hash', async () => {
  const f = await fixture(), setting = f.settings(), same = setting.command
  expect(() => f.store.setLearningSettings(profileId, { command: same, expectedVersion: 0, enabled: false }, f.guard())).toThrow('input changed')
  const first = f.subject('input-seal:first'); f.prepare(first)
  expect(() => f.store.prepareLearningProbe(profileId, { probe: { ...first.probe, presentationOrder: [...first.probe.presentationOrder].reverse() }, original: first.original,
    command: f.command(first.original.conversationId, `prepare:${first.key}`) }, f.guard())).toThrow('input changed')
  const offer = f.store.reserveLearningOffer(profileId, { original: first.original, completedSubmissions: 3 }, f.guard())!
  const dismiss = { offerId: offer.offerId, expectedOfferVersion: 1, command: f.command(first.original.conversationId, 'input-seal:dismiss') }
  f.store.dismissLearningOffer(profileId, dismiss, f.guard())
  expect(() => f.store.dismissLearningOffer(profileId, { ...dismiss, expectedOfferVersion: 2 }, f.guard())).toThrow('input changed')
  f.store.commitLearningChoice(f.choice(first), f.guard()); f.vote(f.subject('input-seal:2')); f.vote(f.subject('input-seal:3'))
  const before = f.state(), review = { command: f.command('conversation:review', 'input-seal:review'), groupId: before.groupId, candidateId: before.candidate!.candidateId,
    expectedCandidateVersion: 1, expectedGroupDigest: before.groupDigest!, decision: 'reject' as const }
  f.store.reviewLearningCandidate(profileId, review, f.guard())
  expect(() => f.store.reviewLearningCandidate(profileId, { ...review, expectedGroupDigest: hash('forged digest') }, f.guard())).toThrow('input changed')
})

it('fails closed on a missing settings receipt even on an already-open profile handle', async () => {
  const f = await fixture(), receipt = f.settings(), db = new DatabaseSync(f.store.databasePath(profileId))
  try { db.prepare("DELETE FROM personalization_journal WHERE event_type='learning.command.committed' AND idempotency_key=?").run(receipt.operationId) } finally { db.close() }
  expect(() => f.store.learningSettings(profileId)).toThrow('transactional receipt')
})

it('never filters an unreceipted real counterexample out of an already-open learning group', async () => {
  const f = await fixture()
  f.vote(f.subject('lost-counter:1')); f.vote(f.subject('lost-counter:2')); f.vote(f.subject('lost-counter:3'))
  const counter = f.vote(f.subject('lost-counter:opposite'), 'variant:evidence-first')
  expect(f.state().status).toBe('conflicted')
  const db = new DatabaseSync(f.store.databasePath(profileId))
  try { db.prepare("DELETE FROM personalization_journal WHERE event_type='learning.command.committed' AND idempotency_key=?").run(counter.operationId) } finally { db.close() }
  expect(() => f.state()).toThrow('counterexamples cannot be filtered out')
})

it('rolls back settings and confirmation receipts with their effects at the final authority fence', async () => {
  const f = await fixture()
  expect(() => f.store.setLearningSettings(profileId, { command: f.command('conversation:settings', 'rollback:setting'), expectedVersion: 0, enabled: true }, {
    ...f.guard(), assertCurrent() { if (f.store.learningSettings(profileId).enabled) throw new Error('setting revoked before commit') },
  })).toThrow('setting revoked')
  expect(f.store.learningSettings(profileId)).toEqual({ version: 0, enabled: false })
  f.vote(f.subject('review-rollback:1')); f.vote(f.subject('review-rollback:2')); f.vote(f.subject('review-rollback:3'))
  const state = f.state(), request = { command: f.command('conversation:review', 'rollback:confirm'), groupId: state.groupId, candidateId: state.candidate!.candidateId,
    expectedCandidateVersion: 1, expectedGroupDigest: state.groupDigest!, decision: 'accept' as const }
  expect(() => f.store.reviewLearningCandidate(profileId, request, { ...f.guard(), authorizeOrigins: () => f.store.currentMemories(profileId).length === 0 })).toThrow('changed before confirmation')
  expect(f.store.currentMemories(profileId)).toEqual([])
  expect(f.state()).toMatchObject({ status: 'pending', candidate: { version: 1, decision: 'pending' } })
})

it('keeps the one-choice guarantee across already-open profile handles', async () => {
  const f = await fixture(), first = f.subject('concurrent-choice'); f.prepare(first)
  const other = await PersonalizationStore.open(f.root); cleanup.push(() => other.close()); other.profileEpoch(profileId)
  f.store.commitLearningChoice(f.choice(first), f.guard())
  expect(() => other.commitLearningChoice(f.choice(first, 'variant:evidence-first', 'workspace', 'concurrent:other-key'), f.guard())).toThrow('one durable choice')
  expect(f.state()).toMatchObject({ independentCounts: { 'conclusion-first': 1, 'evidence-first': 0 } })
})

it('preserves consented historical choices and independent confirmation after future contribution is disabled', async () => {
  const f = await fixture(), first = f.subject('consent-history:1'), receipt = f.vote(first)
  f.vote(f.subject('consent-history:2')); f.vote(f.subject('consent-history:3'))
  f.policy(first.original.conversationId, false, 1)
  expect(f.store.commitLearningChoice(f.choice(first), f.guard())).toEqual(receipt)
  expect(() => f.store.prepareLearningProbe(profileId, { probe: first.probe, original: first.original,
    command: f.command(first.original.conversationId, 'consent-history:new-prepare') }, f.guard())).toThrow('no longer permits contribution')
  await f.reopen()
  expect(f.store.learningReceipt(profileId, receipt.operationId, f.guard())).toEqual(receipt)
  expect(f.review().memoryVersionId).not.toBeNull()
})

describe('bounded learning over already-recorded history', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => {
    f = await fixture()
    // Prepare genuine earlier transactions separately from the boundary action; no fixture rows
    // are forged, and the test/operation deadline is unchanged.
    for (let index = 0; index < 32; index++) f.vote(f.subject(`bounded:${index}`, 'explore', 'investigation:bounded', 'conversation:bounded'))
  })
  it('returns a wholly unavailable group past 64 eligible members instead of dropping later opposing votes', () => {
    for (let index = 32; index < 64; index++) f.vote(f.subject(`bounded:${index}`, 'explore', 'investigation:bounded', 'conversation:bounded'))
    expect(f.state()).toMatchObject({ status: 'collecting', independentCounts: { 'conclusion-first': 1, 'evidence-first': 0 } })
    const last = f.vote(f.subject('bounded:opposing', 'explore', 'investigation:opposing'), 'variant:evidence-first')
    expect(last.candidateId).toBeNull()
    expect(f.state()).toMatchObject({ status: 'unavailable', members: [], independentCounts: null, candidate: null, groupDigest: null })
  })
})

it('rolls back a v2-to-v3 migration failure without resetting its erasure epoch or losing the verified backup', async () => {
  const f = await fixture(); f.policy('conversation:migration-failure')
  const path = f.store.databasePath(profileId); f.store.close()
  const old = new DatabaseSync(path)
  try { old.exec("UPDATE personalization_metadata SET schema_version=2,profile_epoch=5; CREATE TRIGGER reject_learning_upgrade BEFORE UPDATE ON personalization_metadata WHEN NEW.schema_version=3 BEGIN SELECT RAISE(ABORT,'test learning migration failure'); END;") } finally { old.close() }
  await f.reopen()
  expect(() => f.store.profileEpoch(profileId)).toThrow('storage operation failed')
  const verify = new DatabaseSync(path)
  try { expect(verify.prepare('SELECT schema_version,profile_epoch FROM personalization_metadata').get()).toMatchObject({ schema_version: 2, profile_epoch: 5 }); verify.exec('DROP TRIGGER reject_learning_upgrade') } finally { verify.close() }
  expect(readdirSync(join(f.root, 'profiles', 'backups')).some(name => name.includes('.v2.'))).toBe(true)
  f.advance(1)
  expect(f.store.profileEpoch(profileId)).toBe(5)
})

it('rejects malformed v2 epochs and unsupported future schema versions instead of recreating an epoch-zero profile', async () => {
  const f = await fixture(); f.policy('conversation:missing-epoch')
  const path = f.store.databasePath(profileId); f.store.close()
  const damaged = new DatabaseSync(path)
  try { damaged.exec('UPDATE personalization_metadata SET schema_version=2; ALTER TABLE personalization_metadata DROP COLUMN profile_epoch') } finally { damaged.close() }
  await f.reopen()
  expect(() => f.store.profileEpoch(profileId)).toThrow('cannot lose')
  const future = new DatabaseSync(path)
  try { future.exec('UPDATE personalization_metadata SET schema_version=4') } finally { future.close() }
  expect(() => f.store.profileEpoch(profileId)).toThrow('unsupported')
})
