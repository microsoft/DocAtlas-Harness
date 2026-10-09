import { randomInt } from 'node:crypto'
import { controlledProbeId, controlledProbeMaterial, createControlledProbe, verifyControlledProbe, enrichmentHash,
  PersonalizationStoreError, type PersonalizationStore, type StoredProbeChoice } from '@docatlas/core'
import { parseContract } from '@docatlas/contracts/node'
import { productProbeIssues, type MemoryCandidate, type PersonalizationObservation, type PreferenceChoiceObservation, type PreferenceProbe,
  type ProductBinding, type ProductProbeChoose, type ProductProbeChoiceReceipt, type ProductProbeChoiceResult, type ProductProbeMaterial,
  type ProductProbeReviewResult, type ProductProbeValue, type ProductProbeView } from '@docatlas/contracts'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import type { ProductAnswers } from '../documents/answers.js'

const conflict = (message: string): never => { throw new PersonalizationStoreError('conflict', message) }
const denied = (message: string): never => { throw new PersonalizationStoreError('permission-denied', message) }

/** Human controlled-renderer choices. No model/loop, source admission, or automatic activation. */
export class ProductProbes {
  constructor(private readonly store: PersonalizationStore, private readonly control: ControlStore, private readonly answers: ProductAnswers,
    private readonly profile: (actor: ProductActor) => string, private readonly changed: (actor: ProductActor, conversationId: string) => void,
    private readonly now: () => Date = () => new Date(), private readonly leftOrder: () => boolean = () => randomInt(2) === 1) {}

  private input<K extends ProductProbeValue['kind']>(candidate: unknown, kind: K): Extract<ProductProbeValue, { kind: K }> {
    let value: ProductProbeValue
    try { value = parseContract('product-probe', candidate) } catch { throw new PersonalizationStoreError('invalid-request', 'Invalid controlled-presentation request') }
    if (value.kind !== kind || productProbeIssues(value).length) throw new PersonalizationStoreError('invalid-request', 'Invalid controlled-presentation request')
    return structuredClone(value) as Extract<ProductProbeValue, { kind: K }>
  }
  private frame(actor: ProductActor, conversationId: string, generation: number) {
    const who = { actorId: actor.actorId, workspaceId: actor.workspaceId }, binding = this.control.binding(who, conversationId), profileId = this.profile(who)
    if (binding.generation !== generation) return conflict('Presentation conversation generation changed')
    const initial = enrichmentHash(binding), profile = this.store.peekProfile(profileId, conversationId)
    const current = () => {
      if (enrichmentHash(this.control.binding(who, conversationId)) !== initial || this.store.peekProfile(profileId, conversationId).profileEpoch !== profile.profileEpoch) return conflict('Presentation owner, binding or profile erasure epoch changed')
    }
    return { actor: who, binding, profileId, profile, current }
  }
  private material(binding: ProductBinding, messageId: string): { reason: ProductProbeView['reason'], material: ProductProbeMaterial | null } {
    const answer = this.answers.get(binding.conversationId, messageId)
    if (answer.status !== 'available' || !answer.manifest || !answer.nativeTextHash) return { reason: 'answer-unavailable', material: null }
    if (answer.manifest.workspaceId !== binding.workspaceId || answer.manifest.sessionId !== binding.conversationId || answer.manifest.messageId !== messageId) return denied('Controlled presentation original Answer changed')
    if (!answer.manifest.citations.some(citation => citation.verificationStatus === 'read-verified' && citation.evidence)) return { reason: 'no-evidence', material: null }
    try { return { reason: 'ready', material: controlledProbeMaterial(answer.manifest, answer.nativeTextHash) } }
    catch (error) { if (error instanceof PersonalizationStoreError && error.code === 'limit-exceeded') return { reason: 'too-large', material: null }; throw error }
  }
  private requiredMaterial(binding: ProductBinding, messageId: string): ProductProbeMaterial {
    const value = this.material(binding, messageId)
    if (!value.material) return denied('This Answer is not eligible for controlled presentation')
    return value.material
  }
  private receipt(value: StoredProbeChoice): ProductProbeChoiceReceipt {
    return { idempotencyKey: value.command.idempotencyKey, requestHash: value.command.requestHash, choice: value.choice, candidateId: value.candidateId ?? null }
  }
  private savedProbe(profileId: string, profileEpoch: number, material: ProductProbeMaterial, expectedId?: string): PreferenceProbe {
    const id = controlledProbeId(profileId, profileEpoch, material)
    if (expectedId !== undefined && expectedId !== id) return conflict('Presentation request belongs to another original Answer or epoch')
    const probe = this.store.probe(profileId, id)
    if (!probe) throw new PersonalizationStoreError('not-found', 'The original controlled presentation was not prepared')
    verifyControlledProbe(probe, material, profileId, profileEpoch)
    return probe
  }
  private response(binding: ProductBinding, profileEpoch: number, messageId: string) {
    return { schemaVersion: 1 as const, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, profileEpoch, messageId }
  }
  private output<T extends ProductProbeValue>(value: T): T {
    parseContract('product-probe', value)
    if (productProbeIssues(value).length || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new PersonalizationStoreError('integrity-error', 'Invalid controlled-presentation response')
    return value
  }

  inspect(actor: ProductActor, conversationId: string, candidate: unknown): ProductProbeView {
    const input = this.input(candidate, 'probe-inspect'), frame = this.frame(actor, conversationId, input.expectedGeneration), { reason, material } = this.material(frame.binding, input.messageId)
    const probe = material ? this.store.probe(frame.profileId, controlledProbeId(frame.profileId, frame.profile.profileEpoch, material)) ?? null : null
    if (probe) verifyControlledProbe(probe, material!, frame.profileId, frame.profile.profileEpoch)
    const receipt = probe ? this.store.probeChoice(frame.profileId, probe.probeId) : undefined
    const memoryCandidate = receipt?.candidateId ? this.store.candidate(frame.profileId, receipt.candidateId) : undefined
    if (receipt?.candidateId && !memoryCandidate) throw new PersonalizationStoreError('integrity-error', 'Controlled choice candidate is unavailable')
    frame.current()
    return this.output({ ...this.response(frame.binding, frame.profile.profileEpoch, input.messageId), kind: 'probe-view', reason,
      contributionAllowed: frame.profile.sessionPolicy?.contributeToFuture === true, policyVersion: frame.profile.sessionPolicy?.version ?? 0,
      material, probe, choiceReceipt: receipt ? this.receipt(receipt) : null, candidate: memoryCandidate ?? null })
  }

  prepare(actor: ProductActor, conversationId: string, candidate: unknown): ProductProbeView {
    const input = this.input(candidate, 'probe-prepare'), frame = this.frame(actor, conversationId, input.expectedGeneration)
    if (frame.profile.profileEpoch !== input.expectedProfileEpoch) return conflict('Presentation profile was erased')
    const material = this.requiredMaterial(frame.binding, input.messageId), originalHash = material.materialHash
    const current = () => { frame.current(); if (this.requiredMaterial(frame.binding, input.messageId).materialHash !== originalHash) return conflict('Original presentation material changed') }
    const probe = this.store.probe(frame.profileId, controlledProbeId(frame.profileId, input.expectedProfileEpoch, material))
      ?? createControlledProbe({ profileId: frame.profileId, profileEpoch: input.expectedProfileEpoch, material, evidenceFirstOnLeft: this.leftOrder(), generatedAt: this.now().toISOString() })
    verifyControlledProbe(probe, material, frame.profileId, input.expectedProfileEpoch)
    this.store.recordProbe(probe, { expectedProfileEpoch: input.expectedProfileEpoch, expectedPolicyVersion: input.expectedPolicyVersion, assertCurrent: current })
    current()
    return this.inspect(actor, conversationId, { schemaVersion: 1, kind: 'probe-inspect', expectedGeneration: input.expectedGeneration, messageId: input.messageId })
  }

  choose(actor: ProductActor, conversationId: string, candidate: unknown): ProductProbeChoiceResult {
    const input = this.input(candidate, 'probe-choose'), frame = this.frame(actor, conversationId, input.expectedGeneration)
    if (frame.profile.profileEpoch !== input.expectedProfileEpoch) return conflict('Presentation profile was erased')
    const material = this.requiredMaterial(frame.binding, input.messageId), probe = this.savedProbe(frame.profileId, input.expectedProfileEpoch, material, input.probeId)
    const current = () => { frame.current(); const actual = this.requiredMaterial(frame.binding, input.messageId); this.savedProbe(frame.profileId, input.expectedProfileEpoch, actual, input.probeId) }
    const old = this.store.probeChoice(frame.profileId, probe.probeId), occurredAt = old?.command.idempotencyKey === input.idempotencyKey ? old.choice.occurredAt : this.now().toISOString()
    const { choice, observation, memoryCandidate } = this.choiceInputs(frame.actor, frame.profileId, input, probe, occurredAt)
    const requestHash = enrichmentHash(input)
    const result = this.store.commitProbeChoice({ choice, observation, ...(memoryCandidate ? { candidate: memoryCandidate } : {}), command: { idempotencyKey: input.idempotencyKey, requestHash } },
      { expectedProfileEpoch: input.expectedProfileEpoch, expectedPolicyVersion: input.expectedPolicyVersion, assertCurrent: current })
    current()
    return this.output({ ...this.response(frame.binding, input.expectedProfileEpoch, input.messageId), kind: 'probe-choice-result', probeId: input.probeId,
      status: result.status, idempotencyKey: input.idempotencyKey, requestHash, choice: result.choice, candidateId: result.candidateId ?? null })
  }
  private choiceInputs(actor: ProductActor, profileId: string, input: ProductProbeChoose, probe: PreferenceProbe, occurredAt: string) {
    const variant = probe.variants.find(value => value.variantKey === input.selected)
    if (!variant && !['both', 'neither', 'dismissed'].includes(input.selected)) throw new PersonalizationStoreError('invalid-request', 'Choose an original presentation variant')
    const durable = input.scopeIntent === 'workspace' && !!variant, scope = { kind: 'workspace' as const, profileId, workspaceId: actor.workspaceId }
    const consent = { retention: durable ? 'eligible' as const : 'session-only' as const, basis: 'session-policy' as const }
    const choiceId = `choice:${enrichmentHash([profileId, probe.sessionId, input.idempotencyKey])}`
    const choice: PreferenceChoiceObservation = { schemaVersion: 1, recordType: 'preference-choice-observation', choiceObservationId: choiceId, probeId: probe.probeId, profileId,
      sessionId: probe.sessionId, turn: probe.turn, selected: input.selected, scopeIntent: input.scopeIntent, reasonTags: input.reasonTags, consent, occurredAt }
    const observation: PersonalizationObservation = { schemaVersion: 1, recordType: 'personalization-observation', observationId: `observation:${enrichmentHash([profileId, choiceId])}`,
      profileId, sessionId: probe.sessionId, occurredAt, observedActor: { kind: 'user', actorId: actor.actorId }, sourceRef: { kind: 'preference-probe', probeId: probe.probeId },
      lineageKey: probe.probeId, taskContext: probe.taskContext, scope, consent, signal: 'pairwise-preference-choice',
      detail: { probeId: probe.probeId, choiceObservationId: choiceId, selected: input.selected } }
    const memoryCandidate: MemoryCandidate | undefined = durable ? { schemaVersion: 1, recordType: 'memory-candidate', candidateId: `candidate:${enrichmentHash([profileId, choiceId])}`,
      profileId, version: 1, proposedMemoryType: 'presentation-preference', proposedEffect: variant!.effect, proposedScope: scope,
      observationIds: [observation.observationId], independentLineageCount: 1, counterObservationIds: [], formation: 'preference-probe', risk: 'low', sensitivity: 'ordinary',
      decision: 'pending', rationaleCode: 'controlled-probe-choice', createdAt: occurredAt } : undefined
    return { choice, observation, memoryCandidate }
  }

  review(actor: ProductActor, conversationId: string, candidate: unknown): ProductProbeReviewResult {
    const input = this.input(candidate, 'probe-review'), frame = this.frame(actor, conversationId, input.expectedGeneration)
    if (frame.profile.profileEpoch !== input.expectedProfileEpoch) return conflict('Presentation profile was erased')
    const current = () => {
      frame.current()
      const material = this.requiredMaterial(frame.binding, input.messageId), probe = this.savedProbe(frame.profileId, input.expectedProfileEpoch, material, input.probeId)
      const receipt = this.store.probeChoice(frame.profileId, probe.probeId), memoryCandidate = this.store.candidate(frame.profileId, input.candidateId)
      const effect = probe.variants.find(value => value.variantKey === receipt?.choice.selected)?.effect
      if (!receipt || receipt.candidateId !== input.candidateId || receipt.choice.scopeIntent !== 'workspace' || !memoryCandidate || !effect
        || memoryCandidate.profileId !== frame.profileId || memoryCandidate.formation !== 'preference-probe' || memoryCandidate.sensitivity !== 'ordinary' || memoryCandidate.risk !== 'low'
        || memoryCandidate.proposedMemoryType !== 'presentation-preference' || enrichmentHash(memoryCandidate.proposedEffect) !== enrichmentHash(effect)
        || enrichmentHash(memoryCandidate.proposedScope) !== enrichmentHash({ kind: 'workspace', profileId: frame.profileId, workspaceId: frame.actor.workspaceId })
        || enrichmentHash(memoryCandidate.observationIds) !== enrichmentHash([receipt.observation.observationId])) return denied('Only this controlled low-risk workspace candidate may be confirmed')
    }
    current()
    const requestHash = enrichmentHash(input)
    const result = this.store.command({ schemaVersion: 1, requestType: 'personalization-command', profileId: frame.profileId, sessionId: conversationId,
      actor: { kind: 'user', actorId: frame.actor.actorId }, idempotencyKey: `probe-confirm:${enrichmentHash([frame.profileId, conversationId, input.idempotencyKey])}`,
      action: 'review-candidate', candidateId: input.candidateId, expectedVersion: input.expectedCandidateVersion, decision: input.decision }, input.expectedProfileEpoch, requestHash, current)
    if (result.action !== 'review-candidate') throw new PersonalizationStoreError('integrity-error', 'Unexpected candidate confirmation receipt')
    current()
    if (result.status !== 'replayed' && result.memoryVersion) this.changed(frame.actor, conversationId)
    return this.output({ ...this.response(frame.binding, input.expectedProfileEpoch, input.messageId), kind: 'probe-review-result', probeId: input.probeId,
      idempotencyKey: input.idempotencyKey, requestHash, result })
  }
}
