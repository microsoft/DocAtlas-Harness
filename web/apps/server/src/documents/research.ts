import { createHash } from 'node:crypto'
import { DocumentAccessError, ResearchOperations, ResearchScopeSnapshots, enrichmentHash, type SourceScopeStore, type ResearchRecordLineage, type ResearchVisibilityRef } from '@docatlas/core'
import { parseContract } from '@docatlas/contracts/node'
import { productResearchIssues, type NoteSave, type NoteSaved, type NotebookEntry, type NotebookMutation, type NotebookQuery, type NotebookResponse, type NotebookUpdated,
  type ProductBinding, type ProductPreparedSubmission, type ProductRunReceipt, type ProductSubmission, type ResearchFocus, type ResearchRecordRequest, type ResearchLifecycleRequest, type ResearchSourceIdentity,
  type SelectionActionRequest, type SelectionActionResult, type SelectionContext, type SourceScopeVersion, type ScopedSourceIdentity, type ProductSourceRef } from '@docatlas/contracts'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import { ResearchJournal } from '../storage/research-journal.js'
import type { ProductSelections } from './selections.js'
import type { ProductAnswers } from './answers.js'

interface Frame { binding: ProductBinding, submissionId: string, scope: SourceScopeVersion, sources: ScopedSourceIdentity[] }
export interface ConsumedResearchFrame {
  binding: ProductBinding, submissionId: string, scopeVersionId: string,
  assertCurrent(): void, ensureSnapshot(): void
}
const textHash = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (message: string): never => { throw new DocumentAccessError('permission-denied', message) }

/** Product-owned research composition. Neither a Note nor a Recall lead is a current source attestation. */
export class ProductResearch {
  private readonly frames = new Map<string, Frame>()
  private closed = false
  constructor(private readonly domain: SourceScopeStore, private readonly control: ControlStore, private readonly actor: ProductActor,
    readonly snapshots: ResearchScopeSnapshots, readonly journal: ResearchJournal, private readonly selections: ProductSelections, private readonly answers: ProductAnswers) {}
  binding(conversationId: string): ProductBinding {
    if (this.closed) throw new DocumentAccessError('unavailable', 'Research service is closed')
    return this.control.binding(this.actor, conversationId)
  }
  /** Trusted host ports for human authoring; none admits sources or invokes an Agent tool. */
  authorizeSource(conversationId: string, reference: ProductSourceRef): ScopedSourceIdentity {
    const binding = this.binding(conversationId), source = this.domain.getEligibleLibrarySource(binding.workspaceId, reference.documentId, reference.revisionId)
    if (!source) return fail('Research source is no longer authorized')
    return this.source(binding, source)
  }
  visibleRecord(conversationId: string, reference: ResearchVisibilityRef): boolean { return this.visible(this.binding(conversationId), reference) }
  /** Inspection may use an in-memory empty frame, but never persists a capture. */
  inspectContext(conversationId: string): { scope: SourceScopeVersion, sources: ScopedSourceIdentity[] } {
    const binding = this.binding(conversationId), frame = this.frames.get(conversationId)
    if (frame?.binding.bindingId === binding.bindingId) return { scope: structuredClone(frame.scope), sources: structuredClone(frame.sources) }
    return { scope: this.capture(binding, `scope:research-browse:${enrichmentHash(conversationId).slice(0, 32)}`, [], new Date().toISOString(), false), sources: [] }
  }
  /** Call only for an actual human create, after exact proposal verification and before its domain commit. */
  captureHumanContext(conversationId: string, operationId: string, sources: ScopedSourceIdentity[]): SourceScopeVersion {
    const binding = this.binding(conversationId)
    for (const source of sources) this.source(binding, source)
    return this.capture(binding, `scope:research-human:${enrichmentHash(operationId).slice(0, 32)}`, sources, new Date().toISOString())
  }
  /** Execution identity only; does not confer research write/recall authority or admit any document. */
  consumedFrame(conversationId: string): ConsumedResearchFrame | undefined {
    const binding = this.binding(conversationId), frame = this.frames.get(conversationId)
    if (!frame || frame.binding.bindingId !== binding.bindingId) return undefined
    const current = this.control.get(this.actor, frame.submissionId)
    if (current.conversationId !== conversationId || current.generation !== binding.generation || !['dispatching', 'running'].includes(current.state)) return undefined
    const assertCurrent = () => {
      if (this.frames.get(conversationId) !== frame || this.binding(conversationId).bindingId !== binding.bindingId) throw new DocumentAccessError('stale', 'Consumed input frame changed')
      const receipt = this.control.get(this.actor, frame.submissionId)
      if (receipt.conversationId !== conversationId || receipt.generation !== binding.generation || !['dispatching', 'running'].includes(receipt.state)) throw new DocumentAccessError('stale', 'No matching model input is executing')
      for (const source of frame.sources) this.source(binding, source)
    }
    assertCurrent()
    return { binding: structuredClone(binding), submissionId: frame.submissionId, scopeVersionId: frame.scope.scopeVersionId,
      assertCurrent, ensureSnapshot: () => { assertCurrent(); this.ensureCaptured(frame); assertCurrent() } }
  }
  forConversation(conversationId: string): ResearchOperations {
    this.binding(conversationId)
    return new ResearchOperations({
      recordResearch: (request, lineage, check) => this.record(conversationId, request, lineage, check),
      recallResearch: (request, sources, check) => {
        check(); const binding = this.binding(conversationId)
        let maximum = request.limits.maxItems
        for (;;) {
          const result = this.domain.recallResearch({ ...request, limits: { ...request.limits, maxItems: maximum } }, sources, reference => this.visible(binding, reference))
          const current = new Set(sources.map(source => enrichmentHash(this.identity(source))))
          for (const lead of result.leads) {
            if (lead.sourceIdentities.length || !lead.sourceScopeVersionId) continue
            const captured = this.domain.getSourceScopeVersion(binding.workspaceId, lead.sourceScopeVersionId)
            if (!captured?.sources.length) continue
            // These are associated source candidates, not claims that the checkpoint actually read them.
            lead.sourceIdentities = captured.sources.map(source => this.identity(source))
            const included = lead.sourceIdentities.filter(source => current.has(enrichmentHash(source))).length
            lead.sourceState = included === lead.sourceIdentities.length ? 'current-scope' : included ? 'mixed' : 'outside-current-scope'
            lead.reason = 'Checkpoint associated with this captured source frame, not proof that these documents were read. Explicitly include and re-read originals before factual use.'
          }
          result.pageInfo.limit = request.limits.maxItems
          const text = JSON.stringify(result)
          if (text.length <= 28000 && Buffer.byteLength(text) <= 60000) { check(); return result }
          if (result.leads.length <= 1) throw new DocumentAccessError('unavailable', 'This research source frame exceeds the navigation budget; open it in the Notebook')
          maximum = result.leads.length - 1
        }
      },
    }, () => {
      const binding = this.binding(conversationId), frame = this.frames.get(conversationId)
      if (!frame || frame.binding.bindingId !== binding.bindingId) return fail('No consumed research input is active')
      const assertCurrent = () => {
        if (this.frames.get(conversationId) !== frame || this.binding(conversationId).bindingId !== binding.bindingId) throw new DocumentAccessError('stale', 'Research execution frame changed')
        const receipt = this.control.get(this.actor, frame.submissionId)
        if (receipt.generation !== binding.generation || receipt.conversationId !== conversationId || !['dispatching', 'running'].includes(receipt.state)) throw new DocumentAccessError('stale', 'Research call is outside an executing submission')
        for (const source of frame.sources) this.source(binding, source)
      }
      assertCurrent()
      return { conversationId, runtimeSessionId: binding.runtimeSessionId, submissionId: frame.submissionId, workspaceId: binding.workspaceId,
        investigationId: frame.scope.investigationId, scopeVersionId: frame.scope.scopeVersionId, currentSources: frame.sources, assertCurrent,
        authorizeRecord: () => { if (!this.journal.policy(binding).contributeResearchState) fail('Research contribution is disabled for this conversation'); this.ensureCaptured(frame) },
        authorizeRecall: () => { if (!this.journal.policy(binding).recallPriorResearch) fail('Prior research recall is disabled for this conversation'); this.ensureCaptured(frame) } }
    })
  }
  prepare(request: ProductSubmission, receipt: ProductRunReceipt, prepared: ProductPreparedSubmission): () => void {
    const binding = this.binding(request.conversationId)
    if (request.expectedGeneration !== binding.generation || receipt.conversationId !== binding.conversationId || receipt.generation !== binding.generation
      || prepared.submissionId !== receipt.submissionId || prepared.requestHash !== receipt.requestHash) throw new DocumentAccessError('stale', 'Research preparation binding changed')
    let scope: SourceScopeVersion, sources: ScopedSourceIdentity[]
    if (prepared.scopeVersionId) {
      const source = this.domain.getSourceScopeVersion(binding.workspaceId, prepared.scopeVersionId)
      if (!source || source.scope.workspaceId !== binding.workspaceId) return fail('Research input source frame is unavailable')
      if (this.snapshots.get(binding.workspaceId, prepared.scopeVersionId) || source.sources.length !== request.sourceRefs.length
        || source.sources.some(item => !request.sourceRefs.some(ref => ref.documentId === item.documentId && ref.revisionId === item.revisionId))) return fail('Research preparation source identity changed')
      scope = source.scope; sources = source.sources
    } else {
      if (request.sourceRefs.length) return fail('Research preparation dropped selected sources')
      scope = this.capture(binding, `scope:research-empty:${enrichmentHash([receipt.submissionId, receipt.requestHash]).slice(0, 32)}`, [], receipt.createdAt, false)
      sources = []
    }
    const frame: Frame = { binding, submissionId: receipt.submissionId, scope, sources }
    return () => {
      if (this.binding(binding.conversationId).bindingId !== binding.bindingId) throw new DocumentAccessError('stale', 'Research binding changed before native consumption')
      for (const source of sources) this.source(binding, source)
      this.frames.set(binding.conversationId, frame)
    }
  }
  query(conversationId: string, input: NotebookQuery): NotebookResponse {
    this.validateInput(input, 'notebook-query')
    const binding = this.binding(conversationId); this.generation(binding, input.expectedGeneration)
    const frame = this.context(binding)
    const result = this.domain.queryResearchNotebook({ schemaVersion: 1, requestType: 'research-notebook', sessionId: conversationId, workspaceId: binding.workspaceId,
      investigationId: frame.scope.investigationId, scopeVersionId: frame.scope.scopeVersionId, view: input.view, recordTypes: ['research-note', 'open-question'],
      recordStatuses: ['active', 'open', 'resolved', 'archived'], limits: { maxItems: input.maxItems, maxChars: input.maxChars }, ...(input.cursor ? { cursor: input.cursor } : {}) },
    frame.sources, reference => this.visible(binding, reference))
    return this.valid({ schemaVersion: 1, kind: 'notebook-response', conversationId, result })
  }
  get(conversationId: string, recordId: string): NotebookEntry {
    const binding = this.binding(conversationId), note = this.domain.getResearchNote(binding.workspaceId, recordId)
    if (!note || !this.visible(binding, { recordId, investigationId: note.investigationId, sourceSessionId: note.sourceSessionId,
      sourceScopeVersionId: note.scopeVersionId, sourceIdentities: note.sourceIdentities ?? note.locators.map(locator => this.identity(locator)) })) return fail('Research note is not available to this workspace')
    if (note.authoredBy === 'agent' && !this.journal.forRecord(this.actor, recordId)) return fail('Research note has no product execution provenance')
    return this.valid({ schemaVersion: 1, kind: 'notebook-entry', conversationId, recordId, recordType: note.recordType, investigationId: note.investigationId,
      sourceSessionId: note.sourceSessionId, scopeVersionId: note.scopeVersionId, version: note.version, status: note.status, text: note.text,
      locators: note.locators, evidence: note.evidence, authoredBy: note.authoredBy, verificationStatus: 'unverified-lead' })
  }
  save(conversationId: string, input: NoteSave): NoteSaved {
    this.validateInput(input, 'note-save')
    if (!input.body.trim()) throw new DocumentAccessError('invalid-request', 'Note text cannot be empty')
    const binding = this.binding(conversationId); this.generation(binding, input.expectedGeneration)
    const key = `note-save:${enrichmentHash([binding.ownerActorId, binding.workspaceId, conversationId, input.idempotencyKey])}`
    const request: SelectionActionRequest = { schemaVersion: 1, requestType: 'selection-action', sessionId: conversationId, selectionContextId: input.selectionContextId,
      idempotencyKey: key, nonce: `seln_${enrichmentHash([binding.bindingId, input.selectionContextId, key]).slice(0, 32)}`, action: 'create-note', noteKind: input.noteKind, body: input.body }
    const replay = this.domain.replaySelectionAction(binding.workspaceId, request)
    if (replay) {
      if (replay.record.recordType !== 'research-note' || this.get(conversationId, replay.record.noteId).version !== 1) throw new DocumentAccessError('stale', 'The saved note has since changed; refresh the Notebook')
      for (const locator of replay.locators) this.source(binding, locator)
      return this.valid({ schemaVersion: 1, kind: 'note-saved', conversationId, result: replay })
    }
    const ticket = this.selections.get(conversationId, input.selectionContextId)
    if (ticket.state !== 'staged' || ticket.submissionId !== null) throw new DocumentAccessError('stale', 'Save requires an unexpired, unbound verified selection')
    const sources = [...new Map(ticket.items.map(item => { const source = this.source(binding, item.locator); return [`${source.documentId}:${source.revisionId}`, source] })).values()]
    const scope = this.capture(binding, `scope:research-note:${enrichmentHash([key, sources]).slice(0, 32)}`, sources, ticket.createdAt)
    const actor = { kind: 'user' as const, actorId: binding.ownerActorId }, actionId = `action:note:${enrichmentHash(key).slice(0, 32)}`, locators = ticket.items.map(item => item.locator)
    const context: SelectionContext = { schemaVersion: 1, selectionContextId: ticket.selectionContextId, sessionId: conversationId, workspaceId: binding.workspaceId,
      investigationId: scope.investigationId, scopeVersionId: scope.scopeVersionId, intent: 'ask', sourcePolicy: 'focus', retention: 'investigation-focus',
      selections: ticket.items.map((item, index) => ({ selectionId: `selection-item:${enrichmentHash([key, index]).slice(0, 32)}`, kind: 'text', ...this.identity(item.locator), locators: [item.locator],
        content: { mediaType: 'text/plain', text: item.text, contentHash: textHash(item.text), actualLength: [...item.text].length, lengthUnit: 'unicode-scalar', completeness: 'complete', truncated: false }, createdAt: ticket.createdAt })),
      createdBy: actor, createdAt: ticket.createdAt }
    const evidence = ticket.items.map((item, index) => ({ schemaVersion: 1 as const, evidenceId: `evidence:note:${enrichmentHash([key, index]).slice(0, 32)}`,
      documentId: item.locator.documentId, revisionId: item.locator.revisionId, representationId: item.locator.representationId, locatorId: item.locator.locatorId,
      kind: 'quote' as const, content: { mediaType: 'text/plain', text: item.text }, contentHash: textHash(item.text),
      sourceRole: this.domain.getLibraryDocument(binding.workspaceId, item.locator.documentId)!.sourceRole, resolutionStatus: 'resolved' as const, status: 'current' as const,
      createdBy: actor, provenanceActivityId: actionId, createdAt: ticket.createdAt }))
    const result: SelectionActionResult = { schemaVersion: 1, resultType: 'selection-action-recorded', sessionId: conversationId, selectionContextId: ticket.selectionContextId, actionId,
      action: 'create-note', status: 'created', locators, evidence, record: { schemaVersion: 1, recordType: 'research-note', noteId: `note:${enrichmentHash(key).slice(0, 32)}`,
        workspaceId: binding.workspaceId, investigationId: scope.investigationId, selectionContextId: ticket.selectionContextId, evidenceIds: evidence.map(item => item.evidenceId), locatorIds: locators.map(item => item.locatorId),
        version: 1, noteKind: input.noteKind, body: input.body, status: 'active', createdBy: actor, createdAt: ticket.createdAt } }
    if (Buffer.byteLength(JSON.stringify(result)) > 131072) throw new DocumentAccessError('invalid-request', 'Saved note source group exceeds output budget')
    for (const source of sources) this.source(binding, source)
    const saved = this.domain.recordSelectionAction(binding.workspaceId, request, context, result)
    return this.valid({ schemaVersion: 1, kind: 'note-saved', conversationId, result: saved })
  }
  mutate(conversationId: string, input: NotebookMutation): NotebookUpdated {
    this.validateInput(input, 'notebook-mutate'); const binding = this.binding(conversationId); this.generation(binding, input.expectedGeneration)
    const note = this.get(conversationId, input.recordId)
    const request: ResearchLifecycleRequest = { schemaVersion: 1, requestType: 'research-record-lifecycle', sessionId: conversationId, workspaceId: binding.workspaceId,
      investigationId: note.investigationId, scopeVersionId: note.scopeVersionId, recordId: input.recordId, expectedVersion: input.expectedVersion, action: input.action,
      idempotencyKey: `note-edit:${enrichmentHash([binding.ownerActorId, binding.workspaceId, conversationId, input.idempotencyKey])}`,
      ...('text' in input ? { text: input.text } : {}) }
    const result = this.domain.transitionResearchRecord(request, { kind: 'user', actorId: binding.ownerActorId })
    return this.valid({ schemaVersion: 1, kind: 'notebook-updated', conversationId, result })
  }
  async focus(conversationId: string, recordId: string, locatorId: string, authorize: () => void, signal: AbortSignal): Promise<ResearchFocus> {
    const note = this.get(conversationId, recordId), locator = note.locators.find(item => item.locatorId === locatorId)
    if (!locator) return fail('Note has no available original source anchor')
    const check = () => { signal.throwIfAborted(); authorize(); if (this.get(conversationId, recordId).version !== note.version) throw new DocumentAccessError('stale', 'Note changed during original-source navigation') }
    check(); const focus = await this.answers.focusLocator(conversationId, locator, check, signal); check()
    return this.valid({ schemaVersion: 1, kind: 'research-focus', conversationId, recordId, ...focus })
  }
  close(): void { this.closed = true; this.frames.clear(); this.journal.close(); this.snapshots.close() }
  private record(conversationId: string, request: ResearchRecordRequest, lineage: Readonly<ResearchRecordLineage>, check: () => void) {
    check(); const binding = this.binding(conversationId)
    const pending = this.journal.begin(binding, { schemaVersion: 1, kind: 'research-call-provenance', ...lineage, actorId: binding.ownerActorId,
      bindingId: binding.bindingId, generation: binding.generation, requestHash: enrichmentHash(request), recordId: null })
    check()
    if (pending.recordId && this.domain.getResearchNote(binding.workspaceId, pending.recordId)?.version !== 1) throw new DocumentAccessError('stale', 'The research record has since changed')
    const result = this.domain.recordResearch(request)
    // The domain effect already committed. Publish its durable attribution even if delivery is then cancelled.
    this.journal.complete(binding, pending, result.record.recordId); check(); return result
  }
  private visible(binding: ProductBinding, reference: ResearchVisibilityRef): boolean {
    this.binding(binding.conversationId)
    let originalBinding: ProductBinding
    try { originalBinding = this.control.binding(this.actor, reference.sourceSessionId) } catch { return false }
    if (originalBinding.workspaceId !== binding.workspaceId || !reference.sourceScopeVersionId) return false
    const captured = this.domain.getSourceScopeVersion(binding.workspaceId, reference.sourceScopeVersionId), researchScope = this.snapshots.get(binding.workspaceId, reference.sourceScopeVersionId)
    if (captured && researchScope) throw new DocumentAccessError('invalid-output', 'Research scope has two conflicting authorities')
    const snapshot = captured?.scope ?? researchScope
    if (!snapshot || snapshot.investigationId !== reference.investigationId) return false
    if (reference.provenanceCallId) {
      const provenance = this.journal.forRecord(this.actor, reference.recordId)
      if (!provenance || provenance.conversationId !== reference.sourceSessionId || provenance.investigationId !== reference.investigationId
        || provenance.scopeVersionId !== reference.sourceScopeVersionId || provenance.wireCallId !== reference.provenanceCallId) return false
    }
    // Agent checkpoints have no asserted citations; their WHOLE captured source frame still gates visibility.
    const sources = reference.sourceIdentities.length ? reference.sourceIdentities : captured?.sources ?? []
    try {
      for (const source of sources) { this.source(binding, source); this.source(originalBinding, source) }
      for (const item of snapshot.included) {
        const source = this.domain.getEligibleLibrarySource(binding.workspaceId, item.documentId, item.revisionId)
        if (!source) return false
        this.source(binding, source); this.source(originalBinding, source)
      }
    } catch (error) { if (error instanceof DocumentAccessError) return false; throw error }
    return true
  }
  private context(binding: ProductBinding): { scope: SourceScopeVersion, sources: ScopedSourceIdentity[] } {
    const frame = this.frames.get(binding.conversationId)
    if (frame?.binding.bindingId === binding.bindingId) return frame
    return { scope: this.capture(binding, `scope:research-browse:${enrichmentHash(binding.conversationId).slice(0, 32)}`, [], new Date().toISOString()), sources: [] }
  }
  private capture(binding: ProductBinding, scopeVersionId: string, sources: ScopedSourceIdentity[], createdAt: string, persist = true): SourceScopeVersion {
    if (this.domain.getSourceScopeVersion(binding.workspaceId, scopeVersionId)) throw new DocumentAccessError('invalid-output', 'Research capture cannot duplicate an admitted scope')
    const previous = this.snapshots.get(binding.workspaceId, scopeVersionId)
    const investigationId = binding.investigationId ?? `investigation:${textHash(binding.conversationId).slice(0, 32)}`
    const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId, workspaceId: binding.workspaceId, investigationId, version: 1,
      included: sources.map(source => ({ documentId: source.documentId, revisionId: source.revisionId, role: this.domain.getLibraryDocument(binding.workspaceId, source.documentId)!.sourceRole })),
      excluded: [], locked: true, createdBy: { kind: 'user', actorId: binding.ownerActorId }, createdAt: previous?.createdAt ?? createdAt }
    return persist ? this.snapshots.record(scope).scope : scope
  }
  private ensureCaptured(frame: Frame): void {
    // Capture only for an authorized research operation or an eligible, consented fact-trace decision.
    const admitted = this.domain.getSourceScopeVersion(frame.binding.workspaceId, frame.scope.scopeVersionId)
    if (!admitted) this.snapshots.record(frame.scope)
    else if (this.snapshots.get(frame.binding.workspaceId, frame.scope.scopeVersionId)) throw new DocumentAccessError('invalid-output', 'Research scope has two authorities')
  }
  private source(binding: ProductBinding, expected: ResearchSourceIdentity): ScopedSourceIdentity {
    this.binding(binding.conversationId)
    const source = this.domain.getEligibleLibrarySource(binding.workspaceId, expected.documentId, expected.revisionId)
    if (!source || source.representationId !== expected.representationId || source.representationContentHash !== expected.representationContentHash
      || this.domain.get(binding.conversationId).scope?.excluded.some(item => item.documentId === expected.documentId && item.revisionId === expected.revisionId && item.reason !== 'user')) return fail('Research source is no longer authorized')
    return source
  }
  private identity(locator: ResearchSourceIdentity): ResearchSourceIdentity { return { documentId: locator.documentId, revisionId: locator.revisionId, representationId: locator.representationId, representationContentHash: locator.representationContentHash } }
  private generation(binding: ProductBinding, generation: number): void { if (binding.generation !== generation) throw new DocumentAccessError('stale', 'Research view generation changed') }
  private validateInput(value: unknown, kind: string): void { const parsed = parseContract('product-research', value); if (parsed.kind !== kind || productResearchIssues(parsed).length) throw new DocumentAccessError('invalid-request', 'Invalid research command') }
  private valid<T extends NotebookResponse | NotebookEntry | NoteSaved | NotebookUpdated | ResearchFocus>(value: T): T {
    parseContract('product-research', value); if (productResearchIssues(value).length) throw new DocumentAccessError('invalid-output', 'Research response failed validation'); return value
  }
}
