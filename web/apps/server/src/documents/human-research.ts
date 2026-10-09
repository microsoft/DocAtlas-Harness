import { DocumentAccessError, enrichmentHash, type SourceScopeStore, type HumanResearchCommitContext, type ResearchVisibilityRef } from '@docatlas/core'
import { parseContract } from '@docatlas/contracts/node'
import { humanResearchIssues, type HumanResearchCommand, type HumanResearchCommandIdentity, type HumanResearchEntry,
  type HumanResearchDraft, type HumanResearchFocus, type HumanResearchFrameRequest, type HumanResearchOperation, type HumanResearchOverlay,
  type HumanResearchOverlayQuery, type HumanResearchQuery, type HumanResearchReceipt, type HumanResearchValue,
  type HumanResearchWorkspace, type ProductBinding, type ResearchGovernanceDraft, type ResearchGovernanceRequest,
  type ResearchLifecycleRequest } from '@docatlas/contracts'
import type { ProductResearch } from './research.js'
import type { ProductSelections } from './selections.js'

function denied(message: string): never { throw new DocumentAccessError('permission-denied', message) }
function invalid(message: string): never { throw new DocumentAccessError('invalid-request', message) }
const governance = (entry: { recordType: string }): entry is ResearchGovernanceDraft => entry.recordType === 'project-decision' || entry.recordType === 'research-policy'

/** Independent human research commands. No native call, Ask ticket, Evidence creation or source admission. */
export class HumanResearch {
  private closed = false
  constructor(private readonly domain: SourceScopeStore, private readonly research: ProductResearch, private readonly selections: ProductSelections) {}

  async command(conversationId: string, candidate: HumanResearchCommand, authorize: () => void, signal: AbortSignal): Promise<HumanResearchOperation> {
    const input = structuredClone(candidate)
    this.validate(input, 'human-research-command')
    const binding = this.binding(conversationId)
    const check = () => { authorize(); signal.throwIfAborted(); this.assertBinding(binding) }
    check()
    const identity: HumanResearchCommandIdentity = {
      operationId: `human-op:${enrichmentHash([binding.ownerActorId, binding.workspaceId, conversationId, input.idempotencyKey])}`,
      idempotencyKey: input.idempotencyKey, requestHash: enrichmentHash(input), actorId: binding.ownerActorId,
      workspaceId: binding.workspaceId, conversationId, bindingId: input.expectedBindingId,
      generation: input.expectedGeneration, action: input.action,
    }
    const authority: HumanResearchCommitContext = { actor: { kind: 'user', actorId: binding.ownerActorId }, command: identity, assertCurrent: check }
    if (input.expectedGeneration > binding.generation) throw new DocumentAccessError('stale', 'Human research generation is in the future')
    const replay = this.domain.replayHumanResearchCommand(authority)
    if (replay) { this.authorizeReceipt(binding, replay); check(); return this.operationResult(binding, identity.operationId, replay) }
    this.assertFrame(binding, input)

    if (input.action === 'create') {
      const entry = input.entry
      this.validateText(entry)
      const refs = new Map([...input.sourceRefs, ...input.selections].map(ref => [JSON.stringify([ref.documentId, ref.revisionId]), ref]))
      const sources = [...refs.values()].map(ref => this.research.authorizeSource(conversationId, ref))
      const checkSources = () => {
        check()
        for (const source of sources) if (enrichmentHash(this.research.authorizeSource(conversationId, source)) !== enrichmentHash(source)) throw new DocumentAccessError('stale', 'Human research source representation changed')
      }
      const anchors = input.selections.length ? await this.selections.verify(conversationId, binding.generation, input.selections, checkSources, signal) : []
      checkSources()
      for (const item of anchors) if (!sources.some(source => source.documentId === item.locator.documentId && source.revisionId === item.locator.revisionId
        && source.representationId === item.locator.representationId && source.representationContentHash === item.locator.representationContentHash)) invalid('Human research anchor changed its source identity')
      const scope = this.research.captureHumanContext(conversationId, identity.operationId, sources)
      const trusted = { ...authority, governanceSources: sources, assertCurrent: checkSources }
      checkSources()
      if (governance(entry)) {
        const request: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', sessionId: conversationId,
          workspaceId: binding.workspaceId, investigationId: scope.investigationId, scopeVersionId: scope.scopeVersionId,
          idempotencyKey: identity.operationId, action: 'create', entry }
        this.domain.mutateResearchGovernance(request, trusted)
      } else {
        this.domain.recordHumanResearch({ workspaceId: binding.workspaceId, investigationId: scope.investigationId,
          sourceSessionId: conversationId, sourceScopeVersionId: scope.scopeVersionId, entry, anchors, sourceIdentities: sources }, trusted)
      }
    } else {
      const detail = this.get(conversationId, input.recordId).entry
      const reference = this.reference(binding, input.recordId)
      const checkRecord = () => {
        check()
        if (!this.research.visibleRecord(conversationId, reference)) denied('Original human research scope is no longer authorized')
      }
      checkRecord()
      const governanceSources = this.domain.getResearchGovernanceSources(binding.workspaceId, input.recordId)
      const trusted = { ...authority, ...(governanceSources === undefined ? {} : { governanceSources }), assertCurrent: checkRecord }
      if ('kind' in detail) {
        if (input.action === 'revise') invalid('Note and Question use text editing, not governance revision')
        if (input.action === 'edit' && !input.text.trim()) invalid('Research text cannot be empty')
        const request: ResearchLifecycleRequest = { schemaVersion: 1, requestType: 'research-record-lifecycle',
          sessionId: detail.sourceSessionId, workspaceId: binding.workspaceId, investigationId: detail.investigationId,
          scopeVersionId: detail.scopeVersionId, recordId: detail.recordId, expectedVersion: input.expectedVersion,
          idempotencyKey: identity.operationId, action: input.action, ...(input.action === 'edit' ? { text: input.text } : {}) }
        this.domain.transitionResearchRecord(request, trusted.actor, trusted)
      } else {
        if (input.action === 'edit' || input.action === 'resolve') invalid('Decision and Policy require typed revision, archive or delete')
        if (input.action === 'revise') { this.validateText(input.entry); if (input.entry.recordType !== detail.recordType) invalid('Governance revision cannot change record type') }
        const request: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', sessionId: detail.sourceSessionId,
          workspaceId: binding.workspaceId, investigationId: detail.investigationId, scopeVersionId: detail.sourceScopeVersionId,
          idempotencyKey: identity.operationId, recordId: detail.recordId, expectedVersion: input.expectedVersion,
          ...(input.action === 'revise' ? { action: 'revise', entry: input.entry } : { action: input.action }) }
        this.domain.mutateResearchGovernance(request, trusted)
      }
    }
    // The same domain transaction owns both the effect and this original receipt.
    const receipt = this.domain.getHumanResearchReceipt(binding.workspaceId, binding.ownerActorId, conversationId, identity.operationId)
    if (!receipt || receipt.requestHash !== identity.requestHash) throw new DocumentAccessError('invalid-output', 'Human research commit has no matching durable receipt')
    this.authorizeReceipt(binding, receipt); check()
    return this.operationResult(binding, identity.operationId, receipt)
  }

  query(conversationId: string, input: HumanResearchQuery): HumanResearchWorkspace {
    this.validate(input, 'human-research-query')
    const binding = this.binding(conversationId); this.assertFrame(binding, input)
    const frame = this.research.inspectContext(conversationId)
    const result = this.domain.queryResearchNotebook({ schemaVersion: 1, requestType: 'research-notebook', sessionId: conversationId,
      workspaceId: binding.workspaceId, investigationId: frame.scope.investigationId, scopeVersionId: frame.scope.scopeVersionId,
      view: input.view, recordTypes: input.recordTypes, recordStatuses: input.recordStatuses,
      limits: { maxItems: input.maxItems, maxChars: input.maxChars }, ...(input.cursor ? { cursor: input.cursor } : {}) },
    frame.sources, reference => this.research.visibleRecord(conversationId, reference))
    this.assertBinding(binding)
    return this.valid({ schemaVersion: 1, kind: 'human-research-workspace', binding, result })
  }

  get(conversationId: string, recordId: string): HumanResearchEntry {
    const binding = this.binding(conversationId)
    this.requireRecord(binding, recordId)
    const governanceRecord = this.domain.getResearchGovernance(binding.workspaceId, recordId)
    const value: HumanResearchEntry = governanceRecord
      ? { schemaVersion: 1, kind: 'human-research-entry', binding, entry: governanceRecord, useStatus: 'user-governance' }
      : { schemaVersion: 1, kind: 'human-research-entry', binding, entry: this.research.get(conversationId, recordId), useStatus: 'unverified-lead' }
    this.assertBinding(binding)
    return this.valid(value)
  }

  operation(conversationId: string, operationId: string): HumanResearchOperation {
    const binding = this.binding(conversationId)
    const receipt = this.domain.getHumanResearchReceipt(binding.workspaceId, binding.ownerActorId, conversationId, operationId) ?? null
    if (receipt) this.authorizeReceipt(binding, receipt)
    this.assertBinding(binding)
    return this.operationResult(binding, operationId, receipt)
  }

  overlay(conversationId: string, input: HumanResearchOverlayQuery): HumanResearchOverlay {
    this.validate(input, 'human-research-overlay-query')
    const binding = this.binding(conversationId); this.assertFrame(binding, input)
    const source = this.research.authorizeSource(conversationId, input.source), frame = this.research.inspectContext(conversationId)
    const result = this.domain.treeOverlay({ schemaVersion: 1, requestType: 'tree-overlay-get', sessionId: conversationId,
      workspaceId: binding.workspaceId, investigationId: frame.scope.investigationId, scopeVersionId: frame.scope.scopeVersionId,
      source, ...(input.physicalPage === undefined ? {} : { physicalPage: input.physicalPage }), recordTypes: input.recordTypes,
      limits: { maxItems: input.maxItems, maxChars: input.maxChars }, ...(input.cursor ? { cursor: input.cursor } : {}) },
    reference => (input.view === 'workspace' || reference.investigationId === frame.scope.investigationId) && this.research.visibleRecord(conversationId, reference))
    this.assertBinding(binding)
    const recordVersions = [...new Set(result.items.map(item => item.recordId))].map(recordId => {
      const { entry } = this.get(conversationId, recordId)
      if (result.items.some(item => item.recordId === recordId && item.recordStatus !== entry.status)) throw new DocumentAccessError('stale', 'Research overlay version changed during reading')
      return { recordId, version: entry.version, authoredBy: 'kind' in entry ? entry.authoredBy : 'user' as const }
    })
    this.assertBinding(binding)
    return this.valid({ schemaVersion: 1, kind: 'human-research-overlay', binding, result, recordVersions })
  }

  async focus(conversationId: string, recordId: string, locatorId: string, authorize: () => void, signal: AbortSignal): Promise<HumanResearchFocus> {
    const binding = this.binding(conversationId)
    const check = () => { authorize(); signal.throwIfAborted(); this.assertBinding(binding); this.requireRecord(binding, recordId) }
    check()
    const focus = await this.research.focus(conversationId, recordId, locatorId, check, signal)
    check()
    return this.valid({ schemaVersion: 1, kind: 'human-research-focus', binding, focus })
  }

  /** Stop admission synchronously; DocumentApplication joins the shared selection/PDF readers. */
  close(): void { this.closed = true }

  private reference(binding: ProductBinding, recordId: string): ResearchVisibilityRef {
    const note = this.domain.getResearchNote(binding.workspaceId, recordId)
    if (note) return { recordId, investigationId: note.investigationId, sourceSessionId: note.sourceSessionId,
      sourceScopeVersionId: note.scopeVersionId, sourceIdentities: note.sourceIdentities }
    const record = this.domain.getResearchGovernance(binding.workspaceId, recordId)
    if (!record) return denied('Human research record is unavailable')
    return { recordId, investigationId: record.investigationId, sourceSessionId: record.sourceSessionId,
      sourceScopeVersionId: record.sourceScopeVersionId, sourceIdentities: this.domain.getResearchGovernanceSources(binding.workspaceId, recordId) ?? [] }
  }
  private requireRecord(binding: ProductBinding, recordId: string): void {
    if (!this.research.visibleRecord(binding.conversationId, this.reference(binding, recordId))) denied('Human research record is not available in this workspace')
    // Agent-authored records additionally need their private product execution provenance.
    if (this.domain.getResearchNote(binding.workspaceId, recordId)) this.research.get(binding.conversationId, recordId)
  }
  private authorizeReceipt(binding: ProductBinding, receipt: HumanResearchReceipt): void {
    if (receipt.actorId !== binding.ownerActorId || receipt.workspaceId !== binding.workspaceId || receipt.conversationId !== binding.conversationId
      || receipt.generation > binding.generation || receipt.generation === binding.generation && receipt.bindingId !== binding.bindingId) denied('Human research receipt belongs to another binding')
    this.requireRecord(binding, receipt.recordId)
  }
  private operationResult(binding: ProductBinding, operationId: string, receipt: HumanResearchReceipt | null): HumanResearchOperation {
    return this.valid({ schemaVersion: 1, kind: 'human-research-operation', binding, operationId, receipt })
  }
  private assertFrame(binding: ProductBinding, input: HumanResearchFrameRequest): void {
    if (input.expectedGeneration !== binding.generation || input.expectedBindingId !== binding.bindingId) throw new DocumentAccessError('stale', 'Human research view binding changed')
  }
  private assertBinding(binding: ProductBinding): void {
    const current = this.binding(binding.conversationId)
    if (current.bindingId !== binding.bindingId || current.generation !== binding.generation) throw new DocumentAccessError('stale', 'Human research binding changed')
  }
  private binding(conversationId: string): ProductBinding {
    if (this.closed) throw new DocumentAccessError('unavailable', 'Human research service is closed')
    return this.research.binding(conversationId)
  }
  private validateText(entry: HumanResearchDraft | ResearchGovernanceDraft): void {
    const text = 'body' in entry ? entry.body : 'question' in entry ? entry.question : 'decision' in entry ? entry.decision : entry.directive
    if (!text.trim() || 'title' in entry && !entry.title.trim()) invalid('Research content cannot be empty')
  }
  private validate(value: HumanResearchValue, kind: string): void {
    const parsed = parseContract('human-research', value)
    if (!('kind' in parsed) || parsed.kind !== kind || humanResearchIssues(parsed).length) invalid('Invalid human research request')
  }
  private valid<T extends HumanResearchValue>(value: T): T {
    parseContract('human-research', value)
    if (humanResearchIssues(value).length) throw new DocumentAccessError('invalid-output', 'Human research response failed validation')
    return value
  }
}
