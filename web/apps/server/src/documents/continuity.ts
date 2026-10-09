import { createHash } from 'node:crypto'
import { ContinuityService, DocumentAccessError, SourceScopeStoreError, enrichmentHash, type SourceScopeStore, type StoredContinuityRecord } from '@docatlas/core'
import { productContinuityIssues, evidenceLocatorIssues, documentLocatorIssues, type AnswerManifest, type ProductBinding, type ProductContinuityAssess,
  type ProductContinuityAssessment, type ProductContinuityImpactResult,
  type ProductContinuityInspection, type ProductContinuityValue, type ProductReviewEvidence, type ProductSourceRef, type ScopedSourceIdentity,
  type ContinuityAssessRequest, type ContinuityEvidenceContext, type ContinuityLink } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import type { ProductResearch } from './research.js'
import type { ProductAnswers } from './answers.js'
import type { ProductReviews } from './reviews.js'

type Frame = NonNullable<ReturnType<SourceScopeStore['getSourceScopeVersion']>>
type Canonical = ReturnType<ProductReviews['canonicalEvidence']>
const sourceKey = (source: ProductSourceRef) => `${source.documentId}\0${source.revisionId}`
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
const denied = (message: string): never => { throw new DocumentAccessError('permission-denied', message) }
const limit = (message: string): never => { throw new SourceScopeStoreError('limit-exceeded', message) }
const uniqueSources = (sources: readonly ScopedSourceIdentity[]) => [...new Map(sources.map(source => [sourceKey(source), source])).values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)))
const MAX_MANIFEST_CANDIDATES = 128
const unavailable = (error: unknown): boolean => error instanceof Error && 'code' in error && typeof error.code === 'string'
  && ['permission-denied', 'not-found', 'stale'].includes(error.code)

/** Explicit human continuity of one selected record. No automatic semantic diff, model invocation or source admission. */
export class ProductContinuity {
  private closed = false
  private readonly pending = new Map<AbortController, Promise<ProductContinuityAssessment>>()
  constructor(private readonly domain: SourceScopeStore, private readonly control: ControlStore, private readonly actor: ProductActor,
    private readonly research: ProductResearch, private readonly answers: ProductAnswers, private readonly reviews: ProductReviews) {}

  private binding(conversationId: string, generation?: number): ProductBinding {
    if (this.closed) throw new DocumentAccessError('unavailable', 'Continuity service is closed')
    const binding = this.control.binding(this.actor, conversationId)
    if (generation !== undefined && binding.generation !== generation) throw new DocumentAccessError('stale', 'Continuity conversation changed')
    return binding
  }
  private checkBinding(binding: ProductBinding): void {
    if (enrichmentHash(this.binding(binding.conversationId)) !== enrichmentHash(binding)) throw new DocumentAccessError('stale', 'Continuity binding changed')
  }
  private investigation(binding: ProductBinding): string { return binding.investigationId ?? `investigation:${digest(binding.conversationId)}` }
  private source(binding: ProductBinding, expected: ProductSourceRef & Partial<ScopedSourceIdentity>): ScopedSourceIdentity {
    this.checkBinding(binding)
    const value = this.answers.originalDocument(binding.conversationId, expected.documentId, expected.revisionId)
    if (expected.representationId !== undefined && value.source.representationId !== expected.representationId
      || expected.representationContentHash !== undefined && value.source.representationContentHash !== expected.representationContentHash) return denied('Continuity source representation changed')
    return value.source
  }
  private frame(binding: ProductBinding, scopeVersionId: string, expectedInvestigation = this.investigation(binding)): Frame {
    const frame = this.domain.getSourceScopeVersion(binding.workspaceId, scopeVersionId)
    if (!frame || frame.scope.investigationId !== expectedInvestigation || !frame.scope.locked || frame.scope.createdBy.kind !== 'user'
      || frame.scope.createdBy.actorId !== binding.ownerActorId) return denied('Continuity scope is not owned by this authenticated conversation')
    if (frame.sources.length > 32) return limit('Continuity supports at most 32 complete source references per frame')
    for (const source of frame.sources) this.source(binding, source)
    return frame
  }
  private record(binding: ProductBinding, recordId: string): StoredContinuityRecord {
    const value = this.domain.getContinuityRecord(binding.workspaceId, recordId)
    if (!value || value.recordId !== recordId || value.workspaceId !== binding.workspaceId || value.status === 'deleted') return denied('The prior record is unavailable')
    if (value.sources.length > 32 || value.authorizationRefs.length > 1024 || value.evidenceRefs.length > 1024) return limit('The complete prior record exceeds continuity bounds')
    if (value.recordType === 'research-note' || value.recordType === 'open-question') {
      // ResearchScopeSnapshots are intentionally not native SourceScopes. Only the existing
      // authorized Notebook service may validate this special origin; Note text is never Evidence.
      const note = this.research.get(binding.conversationId, recordId)
      if (note.status === 'deleted' || note.version !== value.version || note.investigationId !== value.investigationId || note.scopeVersionId !== value.scopeVersionId) return denied('Prior Notebook record changed')
      const original = this.binding(note.sourceSessionId), scope = this.domain.getSourceScopeVersion(binding.workspaceId, note.scopeVersionId)?.scope
        ?? this.research.snapshots.get(binding.workspaceId, note.scopeVersionId)
      if (!scope || scope.workspaceId !== binding.workspaceId || scope.investigationId !== note.investigationId || scope.createdBy.kind !== 'user'
        || scope.createdBy.actorId !== binding.ownerActorId || scope.included.length > 32) return denied('Prior Notebook scope is unavailable')
      for (const source of scope.included) { this.source(binding, source); this.source(original, source) }
      for (const locator of note.locators) {
        if (documentLocatorIssues(locator).length) return denied('Prior Notebook anchor is invalid')
        this.source(binding, locator); this.source(original, locator)
      }
      if (!value.authorizationRefs.length || value.authorizationRefs.some(ref => ref.sessionId !== note.sourceSessionId
        || ref.scopeVersionId !== note.scopeVersionId || ref.investigationId !== note.investigationId
        || ref.kind !== 'selection-action' && ref.kind !== 'research-record')) return denied('Prior Notebook provenance is incomplete')
      const sources = uniqueSources(note.locators.map(locator => ({ documentId: locator.documentId, revisionId: locator.revisionId,
        representationId: locator.representationId, representationContentHash: locator.representationContentHash })))
      if (enrichmentHash(sources) !== enrichmentHash(value.sources)) return denied('Prior Notebook source references changed')
      return { ...value, sources, sourceReferencesComplete: sources.length > 0, authorizationComplete: true }
    }
    if (value.identity.kind !== 'claim-version' && value.identity.kind !== 'artifact-manifest') return denied('This prior record type is not supported by the product continuity workbench')
    if (!value.authorizationComplete || !value.authorizationRefs.length) return denied('Prior record lacks verified original authorization handles')
    for (const ref of value.authorizationRefs) {
      const original = this.binding(ref.sessionId), frame = this.frame(original, ref.scopeVersionId, ref.investigationId)
      for (const source of frame.sources) this.source(binding, source)
      if (ref.kind === 'm4-command') {
        const object = ref.recordType === 'claim-version'
          ? this.domain.getM4ClaimLedger(binding.workspaceId, ref.investigationId).claims.find(claim => claim.claimVersionId === ref.recordId)
          : this.domain.getM4ArtifactManifest(binding.workspaceId, ref.recordId)
        if (!object || object.workspaceId !== binding.workspaceId || object.investigationId !== ref.investigationId || object.createdBy.kind !== 'user'
          || object.createdBy.actorId !== binding.ownerActorId || ('claimVersionId' in object ? object.scope.sourceScopeVersionId : object.sourceScopeVersionId) !== ref.scopeVersionId) return denied('Prior M4 authority is unavailable')
      } else if (ref.kind === 'answer-read') {
        const answer = this.answers.get(ref.sessionId, ref.messageId), citation = answer.manifest?.citations.find(item => item.citationId === ref.citationId)
        if (answer.status !== 'available' || answer.manifest?.manifestId !== ref.referenceId || answer.manifest.sourceScopeVersionId !== ref.scopeVersionId
          || citation?.verificationStatus !== 'read-verified' || !citation.evidence || !value.evidenceRefs.some(item => item.evidenceId === citation.evidence!.evidenceId
            && item.investigationId === ref.investigationId && item.scopeVersionId === ref.scopeVersionId)) return denied('Prior Answer lacks its completed original publication')
        const atom = this.reviews.canonicalEvidence(ref.sessionId, ref.scopeVersionId, citation.evidence.evidenceId)
        if (enrichmentHash(atom.evidence) !== enrichmentHash(citation.evidence) || enrichmentHash(atom.locator) !== enrichmentHash(citation.locator)) return denied('Prior Answer capture changed')
      } else if (ref.kind === 'selection-action') {
        const action = this.domain.listSelectionActions(binding.workspaceId, ref.investigationId).find(item => item.actionId === ref.referenceId)
        if (!action || action.sessionId !== ref.sessionId || action.selectionContextId !== ref.selectionContextId || action.record.createdBy.kind !== 'user'
          || action.record.createdBy.actorId !== binding.ownerActorId) return denied('Prior selection authority is unavailable')
      } else return denied('Unexpected prior record authority')
    }
    for (const ref of value.evidenceRefs) {
      const atom = this.domain.getCanonicalEvidence(binding.workspaceId, ref.investigationId, ref.scopeVersionId, ref.evidenceId)
      if (!atom) return denied('Prior canonical Evidence is unavailable')
      this.source(binding, atom.locator)
    }
    for (const source of value.sources) this.source(binding, source)
    this.checkBinding(binding); return value
  }

  private available(binding: ProductBinding, manifest: AnswerManifest): Frame | undefined {
    try {
      const answer = this.answers.get(binding.conversationId, manifest.messageId)
      if (answer.status !== 'available') return undefined
      if (!answer.manifest || enrichmentHash(answer.manifest) !== enrichmentHash(manifest)) throw new DocumentAccessError('invalid-output', 'Continuity Answer publication changed')
      return this.frame(binding, manifest.sourceScopeVersionId)
    } catch (error) { if (unavailable(error)) return undefined; throw error }
  }
  private completed(binding: ProductBinding): { frames: Frame[], truncated: boolean } {
    const candidates = this.domain.listAnswerManifests(binding.workspaceId, binding.conversationId, undefined, { maxItems: MAX_MANIFEST_CANDIDATES + 1 })
    const frames = new Map<string, Frame>()
    for (const manifest of candidates.slice(0, MAX_MANIFEST_CANDIDATES)) {
      const frame = this.available(binding, manifest)
      if (frame) frames.set(frame.scope.scopeVersionId, frame)
      if (frames.size > 32) break
    }
    // The recent window is ordered by verified native turn, then actual append order;
    // no opaque ID or wall clock is used to infer chronology.
    return { frames: [...frames.values()].slice(0, 32), truncated: candidates.length > MAX_MANIFEST_CANDIDATES || frames.size > 32 }
  }
  private selected(binding: ProductBinding, scopeVersionId: string) {
    const candidates = this.domain.listAnswerManifests(binding.workspaceId, binding.conversationId, scopeVersionId, { maxItems: MAX_MANIFEST_CANDIDATES + 1 })
    const answers: AnswerManifest[] = []; let frame: Frame | undefined
    for (const manifest of candidates.slice(0, MAX_MANIFEST_CANDIDATES)) {
      const available = this.available(binding, manifest)
      if (available) { frame = available; answers.push(manifest) }
    }
    if (!frame) return denied('Continuity comparison requires an explicitly completed and published Answer scope')
    return { frame, answers, truncated: candidates.length > MAX_MANIFEST_CANDIDATES }
  }
  private fresh(binding: ProductBinding, scopeVersionId: string, evidenceId: string): Canonical {
    const atom = this.reviews.canonicalEvidence(binding.conversationId, scopeVersionId, evidenceId)
    const published = atom.origins.some(origin => {
      if (origin.kind !== 'answer-read' || origin.sessionId !== binding.conversationId) return false
      const answer = this.answers.get(origin.sessionId, origin.messageId), citation = answer.manifest?.citations.find(item => item.citationId === origin.citationId)
      return answer.status === 'available' && answer.manifest?.manifestId === origin.manifestId && answer.manifest.sourceScopeVersionId === scopeVersionId
        && citation?.verificationStatus === 'read-verified' && citation.evidence !== undefined
        && enrichmentHash(citation.evidence) === enrichmentHash(atom.evidence) && enrichmentHash(citation.locator) === enrichmentHash(atom.locator)
    })
    if (!published || atom.evidence.status !== 'current' || atom.evidence.resolutionStatus !== 'resolved' || evidenceLocatorIssues(atom.evidence, atom.locator).length) return denied('Continuity requires current resolved Evidence from the selected completed Read scope')
    return atom
  }
  private input<T extends ProductContinuityValue['kind']>(candidate: unknown, kind: T): Extract<ProductContinuityValue, { kind: T }> {
    let value: ProductContinuityValue
    try { value = parseContract('product-continuity', candidate) } catch { throw new DocumentAccessError('invalid-request', 'Invalid product continuity request') }
    if (value.kind !== kind || productContinuityIssues(value).length) throw new DocumentAccessError('invalid-request', 'Invalid product continuity request')
    return structuredClone(value) as Extract<ProductContinuityValue, { kind: T }>
  }
  private output<T extends ProductContinuityValue>(value: T): T {
    parseContract('product-continuity', value)
    if (productContinuityIssues(value).length || Buffer.byteLength(JSON.stringify(value)) > 262144) throw new DocumentAccessError('invalid-output', 'Continuity result exceeds its validated display boundary')
    return value
  }
  private fence(binding: ProductBinding) { return { schemaVersion: 1 as const, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation } }

  inspect(conversationId: string, candidate: unknown): ProductContinuityInspection {
    const input = this.input(candidate, 'continuity-inspect'), binding = this.binding(conversationId, input.expectedGeneration), record = this.record(binding, input.recordId)
    const complete = this.completed(binding), selectedId = input.scopeVersionId ?? complete.frames[0]?.scope.scopeVersionId
    const selected = selectedId ? this.selected(binding, selectedId) : undefined, options = [...complete.frames]
    let optionsTruncated = complete.truncated
    if (selected && !options.some(frame => frame.scope.scopeVersionId === selectedId)) {
      if (options.length >= 32) { options.pop(); optionsTruncated = true }; options.push(selected.frame)
    }
    const evidence: ProductReviewEvidence[] = [], candidates = new Set<string>()
    outer: for (const answer of selected?.answers ?? []) for (const citation of answer.citations) {
      if (citation.verificationStatus !== 'read-verified' || !citation.evidence) continue
      candidates.add(citation.evidence.evidenceId)
      if (candidates.size > 256) break outer
    }
    for (const id of [...candidates].slice(0, 64)) {
      const atom = this.fresh(binding, selected!.frame.scope.scopeVersionId, id), original = this.answers.originalDocument(conversationId, atom.locator.documentId, atom.locator.revisionId).original
      if (!atom.locator.physicalPage) throw new DocumentAccessError('invalid-output', 'Continuity Evidence has no original page')
      evidence.push({ evidenceId: id, documentId: atom.locator.documentId, revisionId: atom.locator.revisionId, physicalPage: atom.locator.physicalPage,
        sourceName: original.name, preview: [...(atom.evidence.content.text ?? '')].slice(0, 1500).join(''), contentHash: atom.evidence.contentHash })
    }
    this.checkBinding(binding)
    return this.output({ ...this.fence(binding), kind: 'continuity-inspection', record: { recordId: record.recordId, recordType: record.recordType, version: record.version,
      scopeVersionId: record.scopeVersionId, sourceReferencesComplete: record.sourceReferencesComplete,
      sources: record.sources.map(source => ({ documentId: source.documentId, revisionId: source.revisionId, name: this.answers.originalDocument(conversationId, source.documentId, source.revisionId).original.name })) },
    scopeVersionId: selected?.frame.scope.scopeVersionId ?? null, scopeOptions: options.map(frame => ({ scopeVersionId: frame.scope.scopeVersionId, version: frame.scope.version,
      sourceCount: frame.sources.length, current: frame.scope.scopeVersionId === complete.frames[0]?.scope.scopeVersionId })), evidence,
    truncated: selected?.truncated === true || candidates.size > evidence.length, scopeOptionsTruncated: optionsTruncated })
  }

  impact(conversationId: string, candidate: unknown): ProductContinuityImpactResult {
    const input = this.input(candidate, 'continuity-impact'), binding = this.binding(conversationId, input.expectedGeneration), record = this.record(binding, input.recordId)
    const previousSource = this.source(binding, input.previousSource), currentSource = this.source(binding, input.currentSource)
    const service = new ContinuityService({ activeScope: () => undefined, researchRecord: () => undefined, resolveEvidence: () => undefined,
      commitLink: () => { throw new DocumentAccessError('invalid-request', 'Impact inspection cannot commit continuity') },
      impactRecords: () => [{ recordId: record.recordId, sources: record.sources, previousSourceAvailability: 'available', sourceReferencesComplete: record.sourceReferencesComplete }] })
    const result = service.revisionImpact({ schemaVersion: 1, requestType: 'revision-impact', sessionId: conversationId, workspaceId: binding.workspaceId,
      investigationId: this.investigation(binding), scopeVersionId: record.scopeVersionId, previousSource, currentSource, recordIds: [record.recordId], limits: { maxItems: 1 } }).impacts[0]!
    this.checkBinding(binding)
    return this.output({ ...this.fence(binding), kind: 'continuity-impact-result', recordId: record.recordId, recordVersion: record.version,
      previousSource: input.previousSource, currentSource: input.currentSource, dependencyOnly: true, status: result.status, reason: result.reason })
  }

  async assess(conversationId: string, candidate: unknown, authorize: () => void, signal: AbortSignal): Promise<ProductContinuityAssessment> {
    if (this.pending.size >= 2) throw new DocumentAccessError('unavailable', 'Continuity verification capacity reached')
    const controller = new AbortController(), work = this.assessCurrent(conversationId, candidate, authorize, AbortSignal.any([signal, controller.signal, AbortSignal.timeout(45000)]))
    this.pending.set(controller, work)
    try { return await work } finally { this.pending.delete(controller) }
  }
  private async assessCurrent(conversationId: string, candidate: unknown, authorize: () => void, signal: AbortSignal): Promise<ProductContinuityAssessment> {
    const input = this.input(candidate, 'continuity-assess'), binding = this.binding(conversationId, input.expectedGeneration)
    const externalCheck = () => { signal.throwIfAborted(); const result: unknown = authorize(); if (result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function') {
      void Promise.resolve(result).catch(() => {}); throw new DocumentAccessError('unavailable', 'Continuity authorization must be synchronous')
    }; this.checkBinding(binding) }
    externalCheck()
    const record = this.record(binding, input.priorRecordId), selected = this.selected(binding, input.scopeVersionId), requestHash = enrichmentHash(input)
    const idempotencyKey = `continuity:${enrichmentHash([binding.ownerActorId, binding.workspaceId, conversationId, input.idempotencyKey])}`
    const old = this.domain.replayContinuityLink(binding.workspaceId, idempotencyKey, requestHash)
    if (old) {
      externalCheck(); this.record(binding, input.priorRecordId); this.selected(binding, input.scopeVersionId); this.authorizeReplay(binding, input, old.link)
      return this.output({ ...this.fence(binding), kind: 'continuity-assessment', idempotencyKey: input.idempotencyKey, requestHash,
        result: { schemaVersion: 1, resultType: 'continuity-assessed', status: 'replayed', link: old.link } })
    }
    if (record.version !== input.expectedPriorVersion) throw new DocumentAccessError('stale', 'Prior record version changed')
    const currentSources = input.currentSources.map(source => this.source(binding, source))
    if (currentSources.some(source => !selected.frame.sources.some(admitted => enrichmentHash(admitted) === enrichmentHash(source)))) return denied('Continuity cannot expand the selected Answer source scope')
    if (!record.sourceReferencesComplete && input.proposedState !== 'unknown') return denied('Incomplete prior sources cannot be marked reverified')
    const evidence = new Map<string, Canonical>()
    for (const id of new Set([...input.priorEvidenceIds, ...input.currentEvidenceIds])) evidence.set(id, this.fresh(binding, input.scopeVersionId, id))
    if (input.proposedState !== 'unknown') {
      if (record.sources.some(source => !selected.frame.sources.some(admitted => enrichmentHash(admitted) === enrichmentHash(source)))) return denied('Prior sources require fresh admission in the selected comparison scope')
      for (const [sources, ids] of [[record.sources, input.priorEvidenceIds], [currentSources, input.currentEvidenceIds]] as const) {
        if (sources.some(source => !ids.some(id => {
          const atom = evidence.get(id)!
          return atom.locator.documentId === source.documentId && atom.locator.revisionId === source.revisionId
            && atom.locator.representationId === source.representationId && atom.locator.representationContentHash === source.representationContentHash
        }))) return denied('Every compared source side requires its own fresh Read Evidence')
      }
    }
    const recordSeal = enrichmentHash(record), frameSeal = enrichmentHash(selected), evidenceSeal = enrichmentHash([...evidence])
    const check = () => {
      externalCheck()
      if (enrichmentHash(this.record(binding, input.priorRecordId)) !== recordSeal || enrichmentHash(this.selected(binding, input.scopeVersionId)) !== frameSeal
        || enrichmentHash([...evidence.keys()].map(id => [id, this.fresh(binding, input.scopeVersionId, id)])) !== evidenceSeal) throw new DocumentAccessError('stale', 'Continuity record, Read frame or authorization changed')
    }
    if (input.proposedState !== 'unknown') for (const atom of evidence.values()) {
      const focus = await this.answers.focusLocator(conversationId, atom.locator, check, signal)
      if (focus.status !== 'resolved' || focus.exactText !== atom.evidence.content.text) return denied('Continuity comparison requires fresh exact original-source resolution')
    }
    check()
    const request: ContinuityAssessRequest = { schemaVersion: 1, requestType: 'continuity-assess', sessionId: conversationId, workspaceId: binding.workspaceId,
      investigationId: selected.frame.scope.investigationId, scopeVersionId: input.scopeVersionId, priorRecordId: record.recordId, priorRecordVersion: input.expectedPriorVersion,
      priorSources: record.sources, currentSources, priorEvidenceIds: input.priorEvidenceIds, currentEvidenceIds: input.currentEvidenceIds,
      proposedState: input.proposedState, rationale: input.rationale, idempotencyKey }
    const service = new ContinuityService({ activeScope: () => { check(); return { workspaceId: binding.workspaceId, investigationId: selected.frame.scope.investigationId,
      scopeVersionId: input.scopeVersionId, sources: selected.frame.sources } }, researchRecord: (_workspace, id) => { check(); return id === record.recordId ? record : undefined },
      resolveEvidence: (_workspace, id): ContinuityEvidenceContext | undefined => { check(); const value = evidence.get(id); return value ? { evidenceId: id, scopeVersionId: input.scopeVersionId,
        source: { documentId: value.locator.documentId, revisionId: value.locator.revisionId, representationId: value.locator.representationId, representationContentHash: value.locator.representationContentHash },
        status: value.evidence.status, resolutionStatus: value.evidence.resolutionStatus } : undefined },
      commitLink: (key, hash, link) => { check(); return this.domain.commitContinuityLink(binding.workspaceId, key, hash, link) }, impactRecords: () => [] })
    const result = service.assess(request, { kind: 'user', actorId: binding.ownerActorId }, requestHash)
    check()
    return this.output({ ...this.fence(binding), kind: 'continuity-assessment', idempotencyKey: input.idempotencyKey, requestHash, result })
  }
  private authorizeReplay(binding: ProductBinding, input: ProductContinuityAssess, link: ContinuityLink): void {
    if (link.workspaceId !== binding.workspaceId || link.investigationId !== this.investigation(binding) || link.priorRecordId !== input.priorRecordId
      || link.priorRecordVersion !== input.expectedPriorVersion || link.scopeVersionId !== input.scopeVersionId || link.createdBy.kind !== 'user'
      || link.createdBy.actorId !== binding.ownerActorId) return denied('Continuity receipt belongs to another original request')
    for (const source of [...link.priorSources, ...link.currentSources]) this.source(binding, source)
    for (const id of [...link.priorEvidenceIds, ...link.currentEvidenceIds]) this.fresh(binding, link.scopeVersionId, id)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.pending.keys()) controller.abort(new Error('Continuity service closed'))
    await Promise.allSettled(this.pending.values())
  }
}
