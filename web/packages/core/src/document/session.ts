import { createHash } from 'node:crypto'
import type { ProductPreparedSubmission, ProductRunReceipt, ProductSubmission, SourceScopeVersion, ScopedSourceIdentity } from '@docatlas/contracts'
import { SourceScopeStore } from '../storage/source-scope-store.js'
import { bindDocAtlasSourceScope, type ActiveDocAtlasSourceScope } from './source-scope.js'
import { documentModelText } from './model-context.js'

export class DocumentAccessError extends Error {
  constructor(readonly code: 'permission-denied' | 'stale' | 'unavailable' | 'invalid-request' | 'invalid-output', message: string) { super(message) }
}
export interface DocumentSessionIdentity { conversationId: string, workspaceId: string, actorId: string, investigationId?: string, runtimeSessionId?: string }
export interface SelectionAdmissionPort { prepare(request: ProductSubmission, receipt: ProductRunReceipt): { modelText: string, consume(): void } }
export interface DocumentInvocation {
  readonly submissionId: string
  readonly scope: ActiveDocAtlasSourceScope
  readonly searchPolicy?: NonNullable<ProductSubmission['documentSearch']>
  assertCurrent(): void
  source(documentId: string, revisionId?: string): Readonly<ScopedSourceIdentity>
  originalHash(source: Readonly<ScopedSourceIdentity>): string
}

/** Staging a submission never changes the source frame used by an already executing Pi turn. */
export class DocumentSession {
  private current: { submissionId: string, scope: ActiveDocAtlasSourceScope | undefined, searchPolicy?: NonNullable<ProductSubmission['documentSearch']> } | undefined
  readonly identity: Readonly<DocumentSessionIdentity>
  constructor(private readonly store: SourceScopeStore, identity: Readonly<DocumentSessionIdentity>, private readonly authorize: () => void, private readonly selections?: SelectionAdmissionPort) { this.identity = Object.freeze({ ...identity }) }

  prepare(request: ProductSubmission, receipt: ProductRunReceipt): { prepared: ProductPreparedSubmission, modelText: string, onConsumed: () => void } {
    this.authorize()
    if (request.conversationId !== this.identity.conversationId || receipt.conversationId !== request.conversationId || receipt.generation !== request.expectedGeneration) throw new DocumentAccessError('permission-denied', 'Submission context mismatch')
    if (request.selectionContextIds.length && !this.selections) throw new DocumentAccessError('unavailable', 'Selection admission is not connected yet')
    const selected = request.selectionContextIds.length ? this.selections!.prepare(request, receipt) : undefined
    let scope: ActiveDocAtlasSourceScope | undefined
    if (request.sourceRefs.length) {
      const scopeId = `scope:${digest(`${receipt.submissionId}\0${receipt.requestHash}`)}`
      const sources = request.sourceRefs.map(ref => this.eligible(ref.documentId, ref.revisionId))
      const restored = this.store.getSourceScopeVersion(this.identity.workspaceId, scopeId)
      if (restored) scope = bindDocAtlasSourceScope(restored.scope, restored.sources)
      else {
        const previous = this.store.get(this.identity.conversationId)
        if (previous.scope && previous.scope.workspaceId !== this.identity.workspaceId) throw new DocumentAccessError('permission-denied', 'Domain context belongs to another workspace')
        const base = previous.scope ?? (this.identity.investigationId === undefined ? undefined : this.store.getCurrentSourceScope(this.identity.workspaceId, this.identity.investigationId)?.scope)
        const excluded = (base?.excluded ?? []).filter(item => !request.sourceRefs.some(ref => ref.documentId === item.documentId && ref.revisionId === item.revisionId))
        if (base?.excluded.some(item => item.reason !== 'user' && request.sourceRefs.some(ref => ref.documentId === item.documentId && ref.revisionId === item.revisionId))) throw new DocumentAccessError('permission-denied', 'Policy-excluded source cannot be admitted')
        for (const item of base?.included ?? []) if (!request.sourceRefs.some(ref => ref.documentId === item.documentId && ref.revisionId === item.revisionId)) excluded.push({ documentId: item.documentId, revisionId: item.revisionId, reason: 'user' })
        const next: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: scopeId, workspaceId: this.identity.workspaceId,
          investigationId: base?.investigationId ?? this.identity.investigationId ?? `investigation:${digest(this.identity.conversationId)}`,
          version: (base?.version ?? 0) + 1, ...(base ? { previousScopeVersionId: base.scopeVersionId } : {}),
          included: request.sourceRefs.map(ref => ({ ...ref, role: this.store.getLibraryDocument(this.identity.workspaceId, ref.documentId)!.sourceRole })),
          excluded, locked: true, ...(base?.policyTags ? { policyTags: [...base.policyTags] } : {}), createdBy: { kind: 'user', actorId: this.identity.actorId }, createdAt: receipt.createdAt }
        const committed = this.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: this.identity.conversationId,
          idempotencyKey: `prepare:${receipt.submissionId}`, ...(base ? { expectedScopeVersionId: base.scopeVersionId } : {}), scope: next, sources })
        scope = bindDocAtlasSourceScope(committed.scope, committed.sources)
      }
      if (scope.sources.length !== sources.length || scope.sources.some(item => !sources.some(source => sameSource(item, source)))) throw new DocumentAccessError('stale', 'Prepared source mapping has changed')
    }
    const frame = { submissionId: receipt.submissionId, scope, ...(request.documentSearch ? { searchPolicy: Object.freeze(structuredClone(request.documentSearch)) } : {}) }
    const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
      bindingGeneration: receipt.generation, scopeVersionId: scope?.scope.scopeVersionId ?? null,
      sourceRefs: structuredClone(request.sourceRefs), selectionContextIds: [...request.selectionContextIds] }
    const searchGuidance = request.documentSearch ? `\n\n[DocAtlas retrieval setting: ${request.documentSearch.strategy}, recipe tree-search.v1. The host applies this setting to document searches for this question. Search returns navigation candidates; use Read before factual claims.]` : ''
    return { prepared, modelText: documentModelText(selected?.modelText ?? request.text, scope?.sources ?? []) + searchGuidance, onConsumed: () => { this.authorize(); if (scope) this.checkSources(scope); selected?.consume(); this.current = frame } }
  }
  invalidate(): void { this.current = undefined }
  assertRuntime(runtimeSessionId: string): void {
    this.authorize()
    if (this.identity.runtimeSessionId !== undefined && this.identity.runtimeSessionId !== runtimeSessionId) throw new DocumentAccessError('stale', 'Native session does not own this document context')
  }
  invocation(): DocumentInvocation {
    this.authorize()
    const frame = this.current
    if (!frame?.scope) throw new DocumentAccessError('permission-denied', 'No document sources are active for this submission')
    const scope = frame.scope
    const assertCurrent = () => {
      this.authorize()
      if (this.current !== frame) throw new DocumentAccessError('stale', 'Document submission changed during execution')
      this.checkSources(scope)
    }
    assertCurrent()
    return { submissionId: frame.submissionId, scope, ...(frame.searchPolicy ? { searchPolicy: frame.searchPolicy } : {}), assertCurrent, source: (documentId, revisionId) => {
      assertCurrent()
      const candidates = scope.sources.filter(source => source.documentId === documentId && (revisionId === undefined || revisionId === source.revisionId))
      if (candidates.length !== 1) throw new DocumentAccessError('permission-denied', 'Choose one approved document revision')
      return candidates[0]!
    }, originalHash: source => {
      assertCurrent()
      const original = this.store.getLibraryRepresentations(this.identity.workspaceId, source.documentId, source.revisionId).find(item => item.kind === 'original-bytes' && item.mediaType === 'application/pdf')
      if (!original) throw new DocumentAccessError('unavailable', 'This source has no original PDF representation')
      return original.contentHash
    } }
  }
  private eligible(documentId: string, revisionId: string): ScopedSourceIdentity {
    const source = this.store.getEligibleLibrarySource(this.identity.workspaceId, documentId, revisionId)
    if (!source) throw new DocumentAccessError('permission-denied', 'Source revision is not eligible in this workspace')
    return source
  }
  private checkSources(scope: ActiveDocAtlasSourceScope): void {
    const policy = this.store.get(this.identity.conversationId).scope?.excluded ?? []
    if (scope.sources.some(source => policy.some(item => item.reason !== 'user' && item.documentId === source.documentId && item.revisionId === source.revisionId))) throw new DocumentAccessError('permission-denied', 'Source permission was revoked')
    for (const source of scope.sources) if (!sameSource(source, this.eligible(source.documentId, source.revisionId))) throw new DocumentAccessError('stale', 'Source representation changed; prepare again')
  }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function sameSource(a: Readonly<ScopedSourceIdentity>, b: Readonly<ScopedSourceIdentity>): boolean { return a.documentId === b.documentId && a.revisionId === b.revisionId && a.representationId === b.representationId && a.representationContentHash === b.representationContentHash }
