import { randomInt } from 'node:crypto'
import { controlledProbeMaterial, createLearningProbe, verifyLearningProbe, learningProbeId, enrichmentHash, PersonalizationStoreError,
  type PersonalizationStore, type SourceScopeStore, type LearningAnswerRef, type LearningGuard, type LearningReceipt,
  type LearningCommandIdentity, type LearningState } from '@docatlas/core'
import { parseContract } from '@docatlas/contracts/node'
import { productLearningIssues, type ProductBinding, type ProductRunReceipt, type ProductLearningAnswerRef, type ProductLearningCommand,
  type ProductLearningComparison, type ProductLearningGroup, type ProductLearningOperation, type ProductLearningQuery,
  type ProductLearningReceipt, type ProductLearningValue, type ProductLearningView, type PersonalizationObservation,
  type PreferenceChoiceObservation, type ProductProbeMaterial } from '@docatlas/contracts'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import type { ProductAnswers } from '../documents/answers.js'
import type { SubmissionCoordinator } from '../runs/submission-coordinator.js'

function denied(message: string): never { throw new PersonalizationStoreError('permission-denied', message) }
function conflict(message: string): never { throw new PersonalizationStoreError('conflict', message) }
const operationId = (actor: ProductActor, conversationId: string, key: string) => `learning-op:${enrichmentHash([actor.actorId, actor.workspaceId, conversationId, key])}`
const publicRef = ({ workspaceId: _workspaceId, ...ref }: LearningAnswerRef): ProductLearningAnswerRef => ref

/** Optional, reference-only learning. No model execution, inferred traits or document admission. */
export class ProductLearning {
  private closed = false
  private readonly subscriptions = new Set<() => void>()
  constructor(private readonly store: PersonalizationStore, private readonly control: ControlStore, private readonly answers: ProductAnswers,
    private readonly domain: SourceScopeStore, private readonly profile: (actor: ProductActor) => string,
    private readonly changed: (actor: ProductActor, conversationId: string) => void,
    private readonly now: () => Date = () => new Date(), private readonly leftOrder: () => boolean = () => randomInt(2) === 1) {}

  /** Install before recoverQueued; completed receipt replay alone is never a new completion. */
  observe(binding: ProductBinding, coordinator: Pick<SubmissionCoordinator, 'subscribe'>): () => void {
    if (this.closed || this.subscriptions.size >= 16) return () => {}
    const running = new Map<string, number>()
    const remove = coordinator.subscribe(receipt => {
      try {
        if (this.closed || receipt.conversationId !== binding.conversationId || receipt.generation !== binding.generation) return
        if (receipt.state === 'running' || receipt.state === 'dispatching') {
          if (running.size < 100 || running.has(receipt.submissionId)) running.set(receipt.submissionId, receipt.version)
          return
        }
        if (!['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(receipt.state)) return
        const previous = running.get(receipt.submissionId); running.delete(receipt.submissionId)
        if (receipt.state === 'completed' && previous !== undefined && receipt.version > previous) this.completed(binding, receipt)
      } catch { /* Optional learning must never downgrade a durable Answer or its native execution. */ }
    })
    const unsubscribe = () => { remove(); running.clear(); this.subscriptions.delete(unsubscribe) }
    this.subscriptions.add(unsubscribe); return unsubscribe
  }

  private completed(binding: ProductBinding, receipt: ProductRunReceipt): void {
    const actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }, frame = this.frame(actor, binding.conversationId)
    if (frame.binding.bindingId !== binding.bindingId || !this.store.learningSettings(frame.profileId).enabled || !frame.profile.sessionPolicy?.contributeToFuture
      || !receipt.checkpoint || enrichmentHash(this.control.get(actor, receipt.submissionId)) !== enrichmentHash(receipt)) return
    let count = 0, cursor: string | undefined
    for (let page = 0; page < 3 && count < 3; page++) {
      const result = this.control.list(actor, binding.conversationId, 100, cursor)
      count += result.items.filter(item => item.state === 'completed' && item.checkpoint).length
      cursor = result.nextCursor
      if (!cursor) break
    }
    if (count < 3) return
    const checkpointHash = enrichmentHash(receipt.checkpoint)
    // This bounded lookup selects only a publication from THIS completion. It never manufactures historical invitations.
    for (const manifest of this.domain.listAnswerManifests(binding.workspaceId, binding.conversationId, undefined, { maxItems: 16 })) {
      const publication = this.answers.receipts.publication(binding, manifest.messageId)
      if (!publication || publication.checkpoint.submissionId !== receipt.submissionId || enrichmentHash(publication.checkpoint) !== checkpointHash) continue
      const material = this.material(frame.binding, manifest.messageId).material
      if (!material) return
      const original = this.reference(frame.profileId, frame.profile.profileEpoch, material)
      this.store.reserveLearningOffer(frame.profileId, { original, completedSubmissions: count }, this.guard(frame, frame.profile.sessionPolicy.version))
      return
    }
  }

  query(actor: ProductActor, conversationId: string, candidate: ProductLearningQuery): ProductLearningView {
    const input = this.input(candidate, 'learning-query'), frame = this.frame(actor, conversationId)
    this.assertFrame(frame.binding, input)
    const guard = this.guard(frame), settings = this.store.learningSettings(frame.profileId)
    const offers = this.store.learningOffers(frame.profileId, actor.workspaceId, conversationId, guard).map(offer => ({ offerId: offer.offerId,
      version: offer.version, original: publicRef(offer.original), status: offer.status, createdAt: offer.createdAt }))
    const groups = (['explore', 'verify', 'publish'] as const).map(mode => this.group(this.store.learningState(frame.profileId, actor.workspaceId, mode, guard)))
    let comparison: ProductLearningComparison | null = null
    if (input.messageId) {
      const material = this.material(frame.binding, input.messageId)
      const probe = material.material ? this.store.probe(frame.profileId, learningProbeId(frame.profileId, frame.profile.profileEpoch, material.material)) ?? null : null
      if (probe) verifyLearningProbe(probe, material.material!, frame.profileId, frame.profile.profileEpoch)
      const choice = probe ? this.store.learningProbeChoice(frame.profileId, probe.probeId, guard) : undefined
      comparison = { ...material, probe, choiceReceipt: choice ? { idempotencyKey: choice.receipt.command.idempotencyKey, requestHash: choice.receipt.command.requestHash,
        choice: choice.choice, candidateId: choice.receipt.candidateId, groupId: choice.receipt.groupId } : null }
    }
    frame.current()
    return this.output({ schemaVersion: 1, kind: 'learning-view', binding: frame.binding, profileId: frame.profileId, profileEpoch: frame.profile.profileEpoch,
      settings, contributionAllowed: frame.profile.sessionPolicy?.contributeToFuture === true, policyVersion: frame.profile.sessionPolicy?.version ?? 0,
      offers, groups, messageId: input.messageId ?? null, comparison })
  }

  command(actor: ProductActor, conversationId: string, candidate: ProductLearningCommand, authorize: () => void = () => {}): ProductLearningOperation {
    const input = this.input(candidate, 'learning-command'), frame = this.frame(actor, conversationId)
    authorize()
    if (input.expectedProfileEpoch !== frame.profile.profileEpoch || input.expectedGeneration > frame.binding.generation) conflict('Learning profile or generation changed')
    const guard = this.guard(frame, 'expectedPolicyVersion' in input ? input.expectedPolicyVersion : undefined, authorize)
    const command: LearningCommandIdentity = { idempotencyKey: input.idempotencyKey, requestHash: enrichmentHash(input), actorId: actor.actorId,
      workspaceId: actor.workspaceId, conversationId, bindingId: input.expectedBindingId, generation: input.expectedGeneration }
    const id = operationId(actor, conversationId, input.idempotencyKey), prior = this.store.learningReceipt(frame.profileId, id, guard)
    if (prior) {
      if (enrichmentHash(prior.command) !== enrichmentHash(command)) conflict('Learning key belongs to another complete command')
      return this.operationOutput(frame, id, prior)
    }
    this.assertFrame(frame.binding, input)
    let receipt: LearningReceipt
    if (input.action === 'configure') receipt = this.store.setLearningSettings(frame.profileId, { command, expectedVersion: input.expectedSettingsVersion, enabled: input.enabled }, guard)
    else if (input.action === 'dismiss') receipt = this.store.dismissLearningOffer(frame.profileId, { command, offerId: input.offerId, expectedOfferVersion: input.expectedOfferVersion }, guard)
    else if (input.action === 'review') {
      receipt = this.store.reviewLearningCandidate(frame.profileId, { command, groupId: input.groupId, candidateId: input.candidateId,
        expectedCandidateVersion: input.expectedCandidateVersion, expectedGroupDigest: input.expectedGroupDigest, decision: input.decision }, guard)
      if (receipt.memoryVersionId) this.changed(frame.actor, conversationId)
    } else {
      const material = this.material(frame.binding, input.messageId).material
      if (!material || material.materialHash !== input.materialHash) conflict('Original learning material changed')
      const original = this.reference(frame.profileId, frame.profile.profileEpoch, material)
      const existing = this.store.probe(frame.profileId, original.probeId)
      if (input.action === 'prepare') {
        const probe = existing ?? createLearningProbe({ profileId: frame.profileId, profileEpoch: frame.profile.profileEpoch, material,
          evidenceFirstOnLeft: this.leftOrder(), generatedAt: this.now().toISOString() })
        verifyLearningProbe(probe, material, frame.profileId, frame.profile.profileEpoch)
        receipt = this.store.prepareLearningProbe(frame.profileId, { command, probe, original }, guard)
      } else {
        if (!existing || input.probeId !== original.probeId) denied('The original learning comparison is not prepared')
        verifyLearningProbe(existing, material, frame.profileId, frame.profile.profileEpoch)
        const old = this.store.learningProbeChoice(frame.profileId, original.probeId, guard)
        const occurredAt = old?.receipt.command.idempotencyKey === input.idempotencyKey ? old.choice.occurredAt : this.now().toISOString()
        const variant = existing.variants.find(item => item.variantKey === input.selected)
        if (!variant && !['both', 'neither', 'dismissed'].includes(input.selected)) denied('Select one actual learning variant')
        const consent = { retention: input.scopeIntent === 'workspace' && variant ? 'eligible' as const : 'session-only' as const, basis: 'session-policy' as const }
        const choiceId = `choice:learning:${enrichmentHash([frame.profileId, original.probeId, input.idempotencyKey])}`
        const choice: PreferenceChoiceObservation = { schemaVersion: 1, recordType: 'preference-choice-observation', choiceObservationId: choiceId,
          profileId: frame.profileId, sessionId: conversationId, probeId: original.probeId, turn: existing.turn, selected: input.selected,
          scopeIntent: input.scopeIntent, reasonTags: input.reasonTags, consent, occurredAt }
        const observation: PersonalizationObservation = { schemaVersion: 1, recordType: 'personalization-observation', observationId: `observation:learning:${enrichmentHash([frame.profileId, choiceId])}`,
          profileId: frame.profileId, sessionId: conversationId, occurredAt, observedActor: { kind: 'user', actorId: actor.actorId },
          sourceRef: { kind: 'preference-probe', probeId: original.probeId }, lineageKey: original.investigationId, taskContext: existing.taskContext,
          scope: { kind: 'workspace', profileId: frame.profileId, workspaceId: actor.workspaceId }, consent, signal: 'pairwise-preference-choice',
          detail: { probeId: original.probeId, choiceObservationId: choiceId, selected: input.selected } }
        receipt = this.store.commitLearningChoice({ command, choice, observation, original }, guard)
      }
    }
    return this.operationOutput(frame, id, receipt)
  }

  operation(actor: ProductActor, conversationId: string, id: string): ProductLearningOperation {
    const frame = this.frame(actor, conversationId), receipt = this.store.learningReceipt(frame.profileId, id, this.guard(frame))
    if (receipt && (receipt.command.actorId !== actor.actorId || receipt.command.workspaceId !== actor.workspaceId || receipt.command.conversationId !== conversationId)) denied('Learning operation belongs to another owner')
    return this.operationOutput(frame, id, receipt ?? null)
  }
  close(): void { this.closed = true; for (const stop of this.subscriptions) stop() }

  private frame(actor: ProductActor, conversationId: string) {
    if (this.closed) conflict('Learning service is closed')
    const who = { actorId: actor.actorId, workspaceId: actor.workspaceId }, binding = this.control.binding(who, conversationId), profileId = this.profile(who)
    const profile = this.store.peekProfile(profileId, conversationId), initial = enrichmentHash(binding)
    const current = () => {
      if (this.closed || enrichmentHash(this.control.binding(who, conversationId)) !== initial || this.store.peekProfile(profileId, conversationId).profileEpoch !== profile.profileEpoch) conflict('Learning owner, binding or profile epoch changed')
    }
    return { actor: who, binding, profileId, profile, current }
  }
  private guard(frame: ReturnType<ProductLearning['frame']>, policyVersion?: number, authorize: () => void = () => {}): LearningGuard {
    const check = () => { authorize(); frame.current() }
    return { expectedProfileEpoch: frame.profile.profileEpoch, ...(policyVersion === undefined ? {} : { expectedPolicyVersion: policyVersion }), assertCurrent: check,
      authorizeOrigins: references => {
        check(); if (references.length > 64) return false
        for (const reference of references) {
          try {
            if (reference.profileEpoch !== frame.profile.profileEpoch || reference.workspaceId !== frame.actor.workspaceId) return false
            const originalBinding = this.control.binding(frame.actor, reference.conversationId), material = this.material(originalBinding, reference.messageId).material
            if (!material || enrichmentHash(this.reference(frame.profileId, frame.profile.profileEpoch, material)) !== enrichmentHash(reference)) return false
            this.authorizeSources(frame.binding, material)
            const probe = this.store.probe(frame.profileId, reference.probeId)
            if (probe) verifyLearningProbe(probe, material, frame.profileId, frame.profile.profileEpoch)
          } catch (error) {
            const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
            if (['not-found', 'permission-denied', 'stale', 'unavailable', 'limit-exceeded'].includes(String(code))) return false
            throw error
          }
        }
        check(); return true
      } }
  }
  private material(binding: ProductBinding, messageId: string): Pick<ProductLearningComparison, 'material' | 'reason'> {
    const answer = this.answers.get(binding.conversationId, messageId)
    if (answer.status !== 'available' || !answer.manifest || !answer.nativeTextHash) return { reason: 'answer-unavailable', material: null }
    if (answer.manifest.sessionId !== binding.conversationId || answer.manifest.workspaceId !== binding.workspaceId || answer.manifest.messageId !== messageId) denied('Learning requires the original Answer conversation')
    if (!answer.manifest.citations.some(item => item.verificationStatus === 'read-verified' && item.evidence)) return { reason: 'no-evidence', material: null }
    try {
      const material = controlledProbeMaterial(answer.manifest, answer.nativeTextHash); this.authorizeSources(binding, material)
      return { reason: 'ready', material }
    } catch (error) { if (error instanceof PersonalizationStoreError && error.code === 'limit-exceeded') return { reason: 'too-large', material: null }; throw error }
  }
  private authorizeSources(binding: ProductBinding, material: ProductProbeMaterial): void {
    const frame = this.domain.getSourceScopeVersion(binding.workspaceId, material.manifest.sourceScopeVersionId)
    if (!frame || frame.scope.investigationId !== material.manifest.investigationId) denied('Original learning source frame is unavailable')
    for (const source of frame.sources) {
      const current = this.domain.getEligibleLibrarySource(binding.workspaceId, source.documentId, source.revisionId)
      if (!current || enrichmentHash(current) !== enrichmentHash(source) || this.domain.get(binding.conversationId).scope?.excluded.some(item => item.documentId === source.documentId
        && item.revisionId === source.revisionId && item.reason !== 'user')) denied('Original learning source is no longer authorized')
    }
  }
  private reference(profileId: string, profileEpoch: number, material: ProductProbeMaterial): LearningAnswerRef {
    const manifest = material.manifest
    return { profileEpoch, probeId: learningProbeId(profileId, profileEpoch, material), workspaceId: manifest.workspaceId, conversationId: manifest.sessionId,
      messageId: manifest.messageId, manifestId: manifest.manifestId, investigationId: manifest.investigationId, sourceScopeVersionId: manifest.sourceScopeVersionId,
      materialHash: material.materialHash, nativeTextHash: material.nativeTextHash, mode: manifest.mode, turn: manifest.turn }
  }
  private group(value: LearningState): ProductLearningGroup {
    if (value.status === 'unavailable' || value.status === 'suppressed') return { groupId: value.groupId, mode: value.mode, axis: value.axis,
      status: value.status, digest: null, counts: null, members: [], candidate: null }
    return { groupId: value.groupId, mode: value.mode, axis: value.axis, status: value.status === 'pending' ? 'candidate' : value.status,
      digest: value.groupDigest, counts: value.independentCounts ? { conclusionFirst: value.independentCounts['conclusion-first'], evidenceFirst: value.independentCounts['evidence-first'],
        independentInvestigations: new Set(value.members.map(member => member.original.investigationId)).size } : null,
      members: value.members.map(member => ({ original: publicRef(member.original), observationId: member.observationId, value: member.selectedValue })), candidate: value.candidate }
  }
  private operationOutput(frame: ReturnType<ProductLearning['frame']>, id: string, receipt: LearningReceipt | null): ProductLearningOperation {
    frame.current()
    const value: ProductLearningReceipt | null = receipt ? { schemaVersion: 1, kind: 'learning-receipt', operationId: receipt.operationId, ...receipt.command,
      profileEpoch: receipt.profileEpoch, action: receipt.action === 'settings' ? 'configure' : receipt.action === 'choice' ? 'choose' : receipt.action,
      committedAt: receipt.committedAt, targetId: receipt.targetId, targetVersion: receipt.targetVersion,
      groupId: receipt.groupId, candidateId: receipt.candidateId, memoryVersionId: receipt.memoryVersionId } : null
    return this.output({ schemaVersion: 1, kind: 'learning-operation', binding: frame.binding, profileId: frame.profileId, profileEpoch: frame.profile.profileEpoch, operationId: id, receipt: value })
  }
  private assertFrame(binding: ProductBinding, input: { expectedBindingId: string, expectedGeneration: number }): void {
    if (binding.bindingId !== input.expectedBindingId || binding.generation !== input.expectedGeneration) conflict('Learning view binding changed')
  }
  private input<K extends 'learning-query' | 'learning-command'>(candidate: unknown, kind: K): Extract<ProductLearningValue, { kind: K }> {
    const value = parseContract('product-learning', candidate)
    if (value.kind !== kind || productLearningIssues(value).length) throw new PersonalizationStoreError('invalid-request', 'Invalid learning request')
    return structuredClone(value) as Extract<ProductLearningValue, { kind: K }>
  }
  private output<T extends ProductLearningValue>(value: T): T {
    parseContract('product-learning', value)
    if (productLearningIssues(value).length || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new PersonalizationStoreError('integrity-error', 'Invalid bounded learning response')
    return value
  }
}
