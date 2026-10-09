import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerVerificationSummary, type AnswerManifest, type MemoryCandidate, type ProductProbeChoose, type ProductProbeChoiceResult, type ProductProbeReviewResult, type ProductProbeView } from '@docatlas/contracts'
import { controlledProbeMaterial, createControlledProbe } from '../../../packages/core/src/personalization/controlled-presentation'
import { acknowledgeProbe, checkedProbeView, parseProbePending, probeAnswerPin, probeCandidatePin, probeReceiptMatches, probeStorageKey, readProbeOutbox, saveProbePending, type ProbeOwner, type ProbePending } from '../src/live/probe-state'
import type { PreferenceStorage } from '../src/live/preference-state'
import { canonicalHash } from '../src/live/state'

const answer = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/answer-manifest.json', import.meta.url), 'utf8')) as { manifest: AnswerManifest }
const memories = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m6/personalization.valid.json', import.meta.url), 'utf8')) as { commands: { reviewCandidateResult: ProductProbeReviewResult['result'] } }
afterEach(() => vi.restoreAllMocks())
function setup() {
  const material = controlledProbeMaterial(answer.manifest, 'a'.repeat(64)), probe = createControlledProbe({ profileId: 'profile:probe', profileEpoch: 0, material, evidenceFirstOnLeft: true, generatedAt: '2026-09-09T12:00:00.000Z' })
  const owner: ProbeOwner = { actorId: 'actor:probe', workspaceId: material.manifest.workspaceId, conversationId: material.manifest.sessionId, bindingId: 'binding:probe', generation: 1, messageId: material.manifest.messageId, profileId: probe.profileId, profileEpoch: 0, probeId: probe.probeId }
  const view: ProductProbeView = { schemaVersion: 1, kind: 'probe-view', conversationId: owner.conversationId, bindingId: owner.bindingId, generation: owner.generation, profileEpoch: owner.profileEpoch,
    messageId: owner.messageId, reason: 'ready', contributionAllowed: true, policyVersion: 1, material, probe, choiceReceipt: null, candidate: null }
  const request: ProductProbeChoose = { schemaVersion: 1, kind: 'probe-choose', messageId: owner.messageId, expectedGeneration: owner.generation, expectedProfileEpoch: 0, expectedPolicyVersion: 1,
    probeId: probe.probeId, idempotencyKey: 'probe-choice:original-key', selected: probe.presentationOrder[0]!, scopeIntent: 'workspace', reasonTags: ['easier-verification'] }
  const pending: ProbePending = { schemaVersion: 1, owner, original: probeAnswerPin(material), variants: probe.variants.map(value => ({ variantKey: value.variantKey, effect: { ...value.effect } })), presentationOrder: [...probe.presentationOrder], candidate: null, request }
  const candidate: MemoryCandidate = { schemaVersion: 1, recordType: 'memory-candidate', candidateId: 'candidate:probe', profileId: owner.profileId, version: 1, proposedMemoryType: 'presentation-preference',
    proposedEffect: { key: 'answer-order', value: 'evidence-first' }, proposedScope: { kind: 'workspace', profileId: owner.profileId, workspaceId: owner.workspaceId }, observationIds: ['observation:probe'], independentLineageCount: 1,
    counterObservationIds: [], formation: 'preference-probe', risk: 'low', sensitivity: 'ordinary', decision: 'pending', rationaleCode: 'controlled-probe-choice', createdAt: '2026-09-09T12:01:00.000Z' }
  const values = new Map<string, string>(), changes: string[] = []
  const storage: PreferenceStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); changes.push(`set:${key}`) }, removeItem: key => { values.delete(key); changes.push(`remove:${key}`) }, key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
  return { material, probe, owner, view, pending, candidate, values, changes, storage }
}
async function choiceReceipt(pending: ProbePending): Promise<ProductProbeChoiceResult> {
  const request = pending.request
  if (request.kind !== 'probe-choose') throw new Error('Expected choice')
  return { schemaVersion: 1, kind: 'probe-choice-result', conversationId: pending.owner.conversationId, bindingId: pending.owner.bindingId, generation: pending.owner.generation, profileEpoch: pending.owner.profileEpoch,
    messageId: request.messageId, probeId: request.probeId, status: 'created', idempotencyKey: request.idempotencyKey, requestHash: await canonicalHash(request), candidateId: request.scopeIntent === 'workspace' ? 'candidate:probe' : null,
    choice: { schemaVersion: 1, recordType: 'preference-choice-observation', choiceObservationId: 'choice:probe', probeId: request.probeId, profileId: pending.owner.profileId, sessionId: pending.owner.conversationId,
      turn: answer.manifest.turn, selected: request.selected, scopeIntent: request.scopeIntent, reasonTags: [...request.reasonTags], consent: { retention: request.scopeIntent === 'workspace' ? 'eligible' : 'session-only', basis: 'session-policy' }, occurredAt: '2026-09-09T12:01:00.000Z' } }
}
async function chosenView(test: ReturnType<typeof setup>) {
  const { idempotencyKey, requestHash, choice, candidateId } = await choiceReceipt(test.pending)
  return { ...test.view, choiceReceipt: { idempotencyKey, requestHash, choice, candidateId }, candidate: test.candidate }
}

describe('real canonical Probe view validation', () => {
  it('matches the pure Core recipe/hash/backbone while preserving an intentionally empty Claim set', async () => {
    const test = setup()
    expect(test.probe.backbone.claimVersionIds).toEqual([])
    expect(await checkedProbeView(test.owner, test.view)).toEqual(test.view)
    expect(await checkedProbeView(test.owner, await chosenView(test))).toMatchObject({ candidate: { decision: 'pending' } })
  })
  it('rejects changed actual text/native hashes, fake recipe IDs, omitted Evidence/backbone and foreign owners', async () => {
    const test = setup()
    const changes = [
      (value: ProductProbeView) => { value.material!.manifest.blocks[0]!.segments[0]!.text += ' changed' },
      (value: ProductProbeView) => { value.material!.nativeTextHash = 'f'.repeat(64) },
      (value: ProductProbeView) => { value.probe!.variants[0]!.artifactId = 'presentation:fake' },
      (value: ProductProbeView) => { value.probe!.backbone.evidenceAtomIds = [] },
      (value: ProductProbeView) => { value.probe!.backbone.uncertaintyIds = ['uncertainty:fake'] },
      (value: ProductProbeView) => { value.probe!.probeId = 'probe:fake' },
      (value: ProductProbeView) => { value.generation++ }, (value: ProductProbeView) => { value.profileEpoch++ },
      (value: ProductProbeView) => { value.bindingId = 'binding:other' }, (value: ProductProbeView) => { value.messageId = 'message:other' },
    ]
    for (const change of changes) { const value = structuredClone(test.view); change(value); await expect(checkedProbeView(test.owner, value)).rejects.toThrow() }
    const candidate = await chosenView(test); candidate.candidate.proposedScope = { kind: 'workspace', profileId: test.owner.profileId, workspaceId: 'workspace:other' }
    await expect(checkedProbeView(test.owner, candidate)).rejects.toThrow('workspace')
  })
  it('does not promote unavailable/oversize/no-evidence explanations into manufactured material', async () => {
    const test = setup()
    for (const reason of ['answer-unavailable', 'too-large', 'no-evidence'] as const) {
      const value: ProductProbeView = { ...test.view, reason, material: null, probe: null, choiceReceipt: null, candidate: null }
      expect(await checkedProbeView(test.owner, value)).toEqual(value)
      await expect(checkedProbeView(test.owner, { ...value, material: test.material })).rejects.toThrow()
    }
  })
  it('rejects oversized actual Claim/uncertainty/conflict backbones before preparation, rather than dropping weak material', async () => {
    for (const axis of ['claims', 'uncertainty', 'conflicts'] as const) {
      const test = setup(), manifest = structuredClone(test.material.manifest), base = manifest.blocks[0]!, segment = base.segments[0]!
      if (axis === 'conflicts') manifest.citations.push({ ...structuredClone(manifest.citations[0]!), citationId: 'citation:refute', ordinal: 2, relation: 'refute' })
      const segments = axis === 'claims' ? Array.from({ length: 26 }, (_, index) => ({ ...segment, segmentId: `segment:claims:${index}`, claimVersionIds: Array.from({ length: 8 }, (_, item) => `claim:${index}:${item}`) }))
        : axis === 'uncertainty' ? [segment, ...Array.from({ length: 201 }, (_, index) => ({ ...segment, segmentId: `segment:uncertain:${index}`, text: '待核验', status: 'unresolved' as const, visibleCitationIds: [] }))]
          : Array.from({ length: 200 }, (_, index) => ({ ...segment, segmentId: `segment:conflict:${index}`, status: 'contested' as const, visibleCitationIds: manifest.citations.map(citation => citation.citationId) }))
      manifest.blocks = [0, 128].filter(offset => offset < segments.length).map((offset, index) => ({ ...base, blockId: `block:bound:${index}`, sourceBlockIndex: index, segments: segments.slice(offset, offset + 128) }))
      manifest.verificationSummary = answerVerificationSummary(segments, manifest.citations); manifest.manifestStatus = axis === 'uncertainty' ? 'partial' : 'mapped'
      await expect(checkedProbeView(test.owner, { ...test.view, probe: null, material: { ...test.material, manifest } })).rejects.toThrow('cannot trim')
    }
  })
})

describe('original-answer/epoch Probe outbox and durable reconciliation', () => {
  it('retains exact original body/pins/order with no Answer or Evidence text, and reads without replay or mutation', () => {
    const test = setup(); saveProbePending(test.storage, test.pending)
    const raw = test.values.get(probeStorageKey(test.owner))!, changes = [...test.changes]
    expect(parseProbePending(raw, test.owner)).toEqual(test.pending)
    expect(raw).not.toContain(test.material.manifest.blocks[0]!.segments[0]!.text)
    expect(raw).not.toContain(test.material.manifest.citations[0]!.evidence!.content.text!)
    expect(readProbeOutbox(test.storage, test.owner, test.owner)).toMatchObject({ state: 'pending', current: true, value: test.pending })
    expect(readProbeOutbox(test.storage, { ...test.owner, generation: 2 }, { ...test.owner, generation: 2 })).toMatchObject({ state: 'pending', current: false })
    expect(readProbeOutbox(test.storage, test.owner, { ...test.owner, profileEpoch: 1 })).toMatchObject({ state: 'pending', current: false })
    expect(readProbeOutbox(test.storage, { ...test.owner, messageId: 'message:other' }, null)).toEqual({ state: 'empty' })
    expect(test.changes).toEqual(changes)
  })
  it('rejects owner/body/pin injection and prevents uncertain or non-retained requests from being replaced', () => {
    const test = setup()
    const changes = [
      (value: ProbePending) => { value.owner.actorId = 'actor:other' }, (value: ProbePending) => { value.request.expectedGeneration++ },
      (value: ProbePending) => { value.request.expectedProfileEpoch++ }, (value: ProbePending) => { value.request.messageId = 'message:other' },
      (value: ProbePending) => { value.original.materialHash = 'bad' }, (value: ProbePending) => { value.presentationOrder.reverse(); value.presentationOrder[1] = value.presentationOrder[0]! },
      (value: ProbePending) => { if (value.request.kind === 'probe-choose') value.request.selected = 'variant:other' },
      (value: ProbePending) => { Reflect.set(value, 'endpoint', '/private') },
    ]
    for (const change of changes) { const value = structuredClone(test.pending); change(value); expect(() => parseProbePending(JSON.stringify(value), test.owner)).toThrow() }
    expect(() => saveProbePending({ ...test.storage, setItem() {} }, test.pending)).toThrow('not retained')
    saveProbePending(test.storage, test.pending)
    expect(() => saveProbePending(test.storage, test.pending)).toThrow('uncertain')
    test.values.set(probeStorageKey(test.owner), '{broken')
    expect(readProbeOutbox(test.storage, test.owner, test.owner).state).toBe('invalid')
  })
  it('clears a matching real choice from read-only inspect without a POST, but not a different key/body/epoch/consent', async () => {
    const test = setup(), result = await choiceReceipt(test.pending), view = await chosenView(test)
    saveProbePending(test.storage, test.pending)
    expect(await probeReceiptMatches(test.pending, result)).toBe(true)
    expect(await probeReceiptMatches(test.pending, view)).toBe(true)
    for (const altered of [{ ...result, idempotencyKey: 'choice:other-tab' }, { ...result, requestHash: 'f'.repeat(64) }, { ...result, profileEpoch: 1 },
      { ...result, choice: { ...result.choice, selected: test.probe.presentationOrder[1]! } }, { ...result, choice: { ...result.choice, reasonTags: [] } },
      { ...result, choice: { ...result.choice, consent: { ...result.choice.consent, basis: 'user-explicit' } } }, { ...view, material: { ...test.material, nativeTextHash: 'f'.repeat(64) } }]) {
      expect(await acknowledgeProbe(test.storage, test.pending, altered, () => true)).toBe(false)
    }
    expect(test.values.size).toBe(1)
    expect(await acknowledgeProbe(test.storage, test.pending, { ...view, contributionAllowed: false, policyVersion: 2 }, () => true)).toBe(true)
    expect(test.values.size).toBe(0) // Historical durable receipt can be read after opting out; no new signal was sent.
  })
  it('requires turn-only retention and no durable candidate for both/neither/dismissed', async () => {
    const test = setup()
    for (const selected of ['both', 'neither', 'dismissed']) {
      const request = { ...test.pending.request as ProductProbeChoose, selected, scopeIntent: 'turn' as const }, pending = { ...test.pending, request }, result = await choiceReceipt(pending)
      expect(await probeReceiptMatches(pending, result)).toBe(true)
      expect(await probeReceiptMatches(pending, { ...result, candidateId: 'candidate:inferred' })).toBe(false)
      expect(await probeReceiptMatches(pending, { ...result, choice: { ...result.choice, consent: { retention: 'eligible', basis: 'session-policy' } } })).toBe(false)
    }
  })
  it('rechecks view ownership after asynchronous hashes and never clears a newer raw outbox', async () => {
    const test = setup(), result = await choiceReceipt(test.pending); saveProbePending(test.storage, test.pending)
    let current = true
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
    const acknowledging = acknowledgeProbe(test.storage, test.pending, result, () => current)
    await entered.promise; current = false; release.resolve()
    expect(await acknowledging).toBe(false); expect(test.values.size).toBe(1)
    test.values.set(probeStorageKey(test.owner), JSON.stringify({ ...test.pending, request: { ...test.pending.request, idempotencyKey: 'choice:newer' } }))
    expect(await acknowledgeProbe(test.storage, test.pending, result, () => true)).toBe(false)
  })
  it('keeps candidate confirmation independent and validates the exact advanced candidate and resulting workspace effect', async () => {
    const test = setup(), pin = probeCandidatePin(test.candidate)
    const request = { schemaVersion: 1 as const, kind: 'probe-review' as const, messageId: test.owner.messageId, expectedGeneration: 1, expectedProfileEpoch: 0, probeId: test.owner.probeId,
      candidateId: pin.candidateId, expectedCandidateVersion: 1, decision: 'accept' as const, idempotencyKey: 'review:original-key' }
    const pending: ProbePending = { ...test.pending, candidate: pin, request }, confirmed = structuredClone(memories.commands.reviewCandidateResult)
    confirmed.profileId = test.owner.profileId; confirmed.candidate = { ...test.candidate, version: 2, decision: 'promote', decidedBy: { kind: 'user', actorId: test.owner.actorId }, decidedAt: '2026-09-09T12:02:00.000Z' }
    const memory = confirmed.memoryVersion!
    if (memory.status === 'deleted') throw new Error('Expected activated preference fixture')
    memory.profileId = test.owner.profileId; memory.memoryType = 'presentation-preference'; memory.effect = { ...test.candidate.proposedEffect }; memory.scope = { ...test.candidate.proposedScope }; memory.candidateId = pin.candidateId; memory.observationIds = [...test.candidate.observationIds]
    memory.activation = { kind: 'explicit-confirmation', actor: { kind: 'user', actorId: test.owner.actorId }, activatedAt: '2026-09-09T12:02:00.000Z' }
    const result: ProductProbeReviewResult = { schemaVersion: 1, kind: 'probe-review-result', conversationId: test.owner.conversationId, bindingId: test.owner.bindingId, generation: 1, profileEpoch: 0, messageId: test.owner.messageId,
      probeId: test.owner.probeId, idempotencyKey: request.idempotencyKey, requestHash: await canonicalHash(request), result: confirmed }
    expect(parseProbePending(JSON.stringify(pending), test.owner)).toEqual(pending)
    expect(await probeReceiptMatches(pending, result)).toBe(true)
    expect(await probeReceiptMatches(pending, { ...result, result: { ...confirmed, memoryVersion: { ...memory, effect: { key: 'answer-order', value: 'conclusion-first' } } } })).toBe(false)
    expect(await probeReceiptMatches(pending, { ...result, result: { ...confirmed, candidate: { ...confirmed.candidate, version: 3 } } })).toBe(false)
    expect(await probeReceiptMatches(pending, await chosenView(test))).toBe(false) // A visible/promoted candidate is not a keyed review receipt.
  })
})
