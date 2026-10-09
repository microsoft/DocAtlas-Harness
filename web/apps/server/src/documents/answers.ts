import { documentLocatorIssues, productAnswerIssues, resolveResultIssues, type AnswerResponse, type CitationFocus, type DocumentLocator, type ProductBinding, type ProductPiCheckpoint, type ProductPreparedSubmission, type ScopedSourceIdentity, type SourceRepresentation } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { DocumentAccessError, enrichmentHash, type SourceScopeStore, type SelectionResolverPort } from '@docatlas/core'
import { projectCheckpointAnswer } from '@docatlas/runtime-pi'
import { checkpointConversation } from '@docatlas/runtime-pi/worker'
import { AnswerReceipts, answerHash } from '../storage/answer-receipts.js'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import type { HistoricalAnswerOrigins } from '../runs/lineage-history.js'

/** Product-owned publication gate; neither provisional text nor worker metadata is a Read receipt. */
export class ProductAnswers {
  private readonly readers = new Set<SelectionResolverPort & { close(): Promise<void> }>()
  private closed = false
  private historical: HistoricalAnswerOrigins | undefined
  constructor(readonly receipts: AnswerReceipts, private readonly domain: SourceScopeStore, private readonly control: ControlStore,
    private readonly actor: ProductActor, private readonly createReader: () => SelectionResolverPort & { close(): Promise<void> }) {}
  /** Trusted composition only; the browser cannot supply origin bindings or a lineage resolver. */
  enableHistoricalOrigins(port: HistoricalAnswerOrigins): void {
    if (this.closed || this.historical) throw new DocumentAccessError('unavailable', 'Historical Answer access is already configured or closed')
    this.historical = port
  }
  binding(conversationId: string): ProductBinding {
    if (this.closed) throw new DocumentAccessError('unavailable', 'Answer service is closed')
    return this.control.binding(this.actor, conversationId)
  }
  capture(conversationId: string, file: string, checkpoint: ProductPiCheckpoint, prepared: ProductPreparedSubmission): void {
    const binding = this.binding(conversationId), receipt = this.control.get(this.actor, checkpoint.submissionId)
    if (receipt.conversationId !== conversationId || receipt.generation !== binding.generation || receipt.requestHash !== checkpoint.requestHash || checkpoint.runtimeSessionId !== binding.runtimeSessionId
      || prepared.submissionId !== checkpoint.submissionId || prepared.requestHash !== checkpoint.requestHash || prepared.bindingGeneration !== binding.generation) throw new DocumentAccessError('stale', 'Answer execution binding changed')
    if (!prepared.scopeVersionId) return
    const scoped = this.domain.getSourceScopeVersion(binding.workspaceId, prepared.scopeVersionId)
    if (!scoped) throw new DocumentAccessError('stale', 'Answer source frame is missing')
    const reads = this.receipts.reads(binding, checkpoint.submissionId, prepared.scopeVersionId)
    const manifest = projectCheckpointAnswer(file, checkpoint, { sessionId: conversationId, turn: this.control.submissionOrdinal(this.actor, checkpoint.submissionId), ...scoped, reads })
    if (!manifest) return
    const native = checkpointConversation(file, checkpoint).messages.find(message => message.entryId === manifest.messageId && message.role === 'assistant')
    if (!native || native.truncated) return
    for (const citation of manifest.citations) this.source(binding, citation.locator)
    this.binding(conversationId)
    // Publish the execution link last; an orphan canonical manifest is not a browser-visible answer.
    this.domain.recordAnswerManifest(manifest)
    this.receipts.publish(binding, { messageId: manifest.messageId, manifestId: manifest.manifestId, manifestHash: enrichmentHash(manifest),
      nativeTextHash: answerHash(native.text), scopeVersionId: manifest.sourceScopeVersionId, checkpoint })
  }
  get(conversationId: string, messageId: string): AnswerResponse {
    const binding = this.binding(conversationId)
    const absent: AnswerResponse = { schemaVersion: 1, kind: 'answer-response', conversationId, messageId, status: 'unavailable', nativeTextHash: null, manifest: null }
    const own = this.published(binding, binding, messageId)
    if (own) return own
    for (const origin of this.historical?.frames(conversationId) ?? []) {
      if (origin.bindingId === binding.bindingId) continue
      if (origin.conversationId !== conversationId) throw new DocumentAccessError('invalid-output', 'Historical publication frame changed conversation')
      const result = this.published(binding, origin, messageId)
      if (result) return result
    }
    for (const origin of this.historical?.origins(conversationId, messageId) ?? []) {
      if (origin.binding.conversationId === conversationId) continue
      if (origin.entryId !== messageId) throw new DocumentAccessError('invalid-output', 'Inherited native message identity changed')
      const result = this.published(binding, origin.binding, messageId, origin.nativeTextHash)
      if (result) return result
    }
    return absent
  }
  private published(view: ProductBinding, binding: ProductBinding, messageId: string, inheritedHash?: string): AnswerResponse | undefined {
    const currentOrigin = this.binding(binding.conversationId)
    if (binding.ownerActorId !== view.ownerActorId || binding.workspaceId !== view.workspaceId || currentOrigin.ownerActorId !== binding.ownerActorId
      || currentOrigin.workspaceId !== binding.workspaceId || binding.generation > currentOrigin.generation) throw new DocumentAccessError('permission-denied', 'Original Answer conversation is no longer authorized')
    const publication = this.receipts.publication(binding, messageId)
    if (!publication) return undefined
    if (inheritedHash !== undefined && inheritedHash !== publication.nativeTextHash) throw new DocumentAccessError('invalid-output', 'Inherited native text differs from its original publication')
    const receipt = this.control.get(this.actor, publication.checkpoint.submissionId)
    if (receipt.conversationId !== binding.conversationId || receipt.generation !== binding.generation || receipt.state !== 'completed' || !receipt.checkpoint || enrichmentHash(receipt.checkpoint) !== enrichmentHash(publication.checkpoint)) return undefined
    const manifest = this.domain.getAnswerManifest(binding.workspaceId, binding.conversationId, messageId)
    if (!manifest || manifest.manifestId !== publication.manifestId || manifest.sourceScopeVersionId !== publication.scopeVersionId || enrichmentHash(manifest) !== publication.manifestHash) throw new DocumentAccessError('invalid-output', 'Answer manifest does not match its publication')
    const scoped = this.domain.getSourceScopeVersion(binding.workspaceId, publication.scopeVersionId)
    if (!scoped) throw new DocumentAccessError('stale', 'Answer source frame disappeared')
    for (const citation of manifest.citations) {
      const source = this.source(binding, citation.locator)
      this.source(view, citation.locator)
      if (!scoped.sources.some(item => item.documentId === source.documentId && item.revisionId === source.revisionId && item.representationId === source.representationId && item.representationContentHash === source.representationContentHash)) throw new DocumentAccessError('stale', 'Answer citation is outside its source frame')
    }
    if (this.binding(view.conversationId).bindingId !== view.bindingId) throw new DocumentAccessError('stale', 'Current Answer view changed')
    const value: AnswerResponse = { schemaVersion: 1, kind: 'answer-response', conversationId: view.conversationId, messageId, status: 'available', nativeTextHash: publication.nativeTextHash, manifest,
      ...(binding.bindingId === view.bindingId ? {} : { origin: { conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, runtimeSessionId: binding.runtimeSessionId, entryId: messageId } }) }
    parseContract('product-answer', value); if (productAnswerIssues(value).length) throw new DocumentAccessError('invalid-output', 'Invalid answer response')
    return value
  }
  async focus(conversationId: string, messageId: string, citationId: string, authorize: () => void, signal: AbortSignal): Promise<CitationFocus> {
    const answer = this.get(conversationId, messageId)
    const citation = answer.manifest?.citations.find(item => item.citationId === citationId)
    if (!citation || citation.verificationStatus !== 'read-verified' || documentLocatorIssues(citation.locator).length) throw new DocumentAccessError('permission-denied', 'Citation has no attested original source')
    const focused = await this.focusLocator(conversationId, citation.locator, authorize, signal)
    const current = this.get(conversationId, messageId)
    if (current.status !== 'available' || current.nativeTextHash !== answer.nativeTextHash || enrichmentHash(current.manifest) !== enrichmentHash(answer.manifest)
      || JSON.stringify(current.origin) !== JSON.stringify(answer.origin)) throw new DocumentAccessError('stale', 'Historical citation origin changed during verification')
    const value: CitationFocus = { schemaVersion: 1, kind: 'citation-focus', conversationId, messageId, citationId, ...focused }
    parseContract('product-answer', value); if (productAnswerIssues(value).length) throw new DocumentAccessError('invalid-output', 'Invalid citation focus')
    return value
  }
  /** Trusted host callers must supply a persisted, authorized anchor. Never exposed as a browser locator RPC. */
  async focusLocator(conversationId: string, locator: DocumentLocator, authorize: () => void, signal: AbortSignal): Promise<Pick<CitationFocus, 'status' | 'locator' | 'physicalPage' | 'exactText' | 'original'>> {
    const binding = this.binding(conversationId)
    parseContract('document-locator', locator)
    if (documentLocatorIssues(locator).length) throw new DocumentAccessError('invalid-output', 'Invalid original source anchor')
    const source = this.source(binding, locator), original = this.original(binding, locator)
    const check = () => {
      signal.throwIfAborted(); authorize()
      if (this.binding(conversationId).bindingId !== binding.bindingId || JSON.stringify(this.source(binding, locator)) !== JSON.stringify(source) || JSON.stringify(this.original(binding, locator)) !== JSON.stringify(original)) throw new DocumentAccessError('stale', 'Citation source changed')
    }
    check()
    if (!locator.physicalPage || locator.physicalPage > original.pageCount) throw new DocumentAccessError('invalid-output', 'Citation has no valid physical PDF page')
    if (this.readers.size >= 4) throw new DocumentAccessError('unavailable', 'Citation verification capacity reached')
    const reader = this.createReader(); this.readers.add(reader)
    const stop = () => { void reader.close().catch(() => {}) }; signal.addEventListener('abort', stop, { once: true })
    let status: CitationFocus['status'] = 'page-only', exactText: string | null = null
    try {
      check()
      const request = { schemaVersion: 1 as const, requestType: 'resolve' as const, locator, allowCandidates: false, maxCandidates: 1 }
      const result = await reader.call('resolve', request, signal); check(); parseContract('sidecar-document-rpc', result)
      if (resolveResultIssues(result, request).length || result.checkedRepresentationHash !== source.representationContentHash || result.documentId !== locator.documentId || result.revisionId !== locator.revisionId || result.representationId !== locator.representationId) throw new DocumentAccessError('stale', 'Citation resolution identity changed')
      const resolved = result.resolvedLocator, quote = locator.selectors.find(selector => selector.type === 'text-quote')
      if (result.status === 'resolved' && resolved && quote?.type === 'text-quote' && result.exactText === quote.exact && answerHash(result.exactText) === quote.normalizedHash
        && resolved.locatorId === locator.locatorId && resolved.physicalPage === locator.physicalPage && resolved.representationContentHash === source.representationContentHash
        && resolved.documentId === locator.documentId && resolved.revisionId === locator.revisionId && resolved.representationId === locator.representationId
        && [...result.exactText].length <= 20000 && !documentLocatorIssues(resolved).length) { status = 'resolved'; exactText = result.exactText }
      else if (result.status === 'ambiguous') status = 'ambiguous'
    } finally { signal.removeEventListener('abort', stop); await reader.close(); this.readers.delete(reader) }
    check()
    return { status, locator, physicalPage: locator.physicalPage, exactText, original }
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.readers].map(reader => reader.close())) }
  private source(binding: ProductBinding, locator: DocumentLocator) {
    const source = this.domain.getEligibleLibrarySource(binding.workspaceId, locator.documentId, locator.revisionId)
    if (!source || source.representationId !== locator.representationId || source.representationContentHash !== locator.representationContentHash
      || this.domain.get(binding.conversationId).scope?.excluded.some(item => item.documentId === locator.documentId && item.revisionId === locator.revisionId && item.reason !== 'user')) throw new DocumentAccessError('permission-denied', 'Citation source is no longer authorized')
    return source
  }
  /** Trusted Library/history access. Metadata permission is not proof that original bytes were read. */
  originalDocument(conversationId: string, documentId: string, revisionId: string): {
    source: ScopedSourceIdentity, original: CitationFocus['original'], representation: SourceRepresentation,
  } {
    const binding = this.binding(conversationId)
    const check = () => {
      const current = this.binding(conversationId)
      if (current.bindingId !== binding.bindingId || current.generation !== binding.generation || current.runtimeSessionId !== binding.runtimeSessionId
        || current.ownerActorId !== binding.ownerActorId || current.workspaceId !== binding.workspaceId) throw new DocumentAccessError('stale', 'Original document binding changed')
    }
    const document = this.domain.getLibraryDocument(binding.workspaceId, documentId)
    if (!document || document.workspaceId !== binding.workspaceId || document.documentId !== documentId || document.status === 'archived') throw new DocumentAccessError('permission-denied', 'Original document is no longer authorized')
    const saved = this.domain.getLibraryRevisions(binding.workspaceId, documentId).find(item => item.revision.revisionId === revisionId)
    if (!saved) throw new DocumentAccessError('stale', 'Original citation PDF revision is not available')
    const source = this.domain.getEligibleLibrarySource(binding.workspaceId, documentId, revisionId)
    if (!source || this.domain.get(conversationId).scope?.excluded.some(item => item.documentId === documentId && item.revisionId === revisionId && item.reason !== 'user')) throw new DocumentAccessError('permission-denied', 'Original document source is no longer authorized')
    const revision = saved?.revision, originals = saved?.representations.filter(item => item.kind === 'original-bytes') ?? [], representation = originals[0]
    if (!revision || revision.documentId !== documentId || !['active', 'superseded'].includes(revision.status) || revision.mediaType !== 'application/pdf'
      || originals.length !== 1 || !representation || representation.documentId !== documentId || representation.revisionId !== revisionId
      || representation.status !== 'current' || representation.mediaType !== 'application/pdf' || representation.contentHash !== revision.contentHash
      || representation.byteLength !== revision.byteLength || !representation.pageCount || representation.pageCount !== revision.pageCount
      || source.documentId !== documentId || source.revisionId !== revisionId || !saved!.representations.some(item => item.representationId === source.representationId
        && item.contentHash === source.representationContentHash && item.status === 'current')) throw new DocumentAccessError('stale', 'Original citation PDF is not available')
    check()
    return structuredClone({ source, representation, original: { documentId, revisionId, name: revision.displayName, contentHash: revision.contentHash, byteLength: revision.byteLength, pageCount: revision.pageCount! } })
  }
  private original(binding: ProductBinding, locator: DocumentLocator): CitationFocus['original'] {
    const value = this.originalDocument(binding.conversationId, locator.documentId, locator.revisionId), current = this.binding(binding.conversationId)
    if (current.bindingId !== binding.bindingId || current.generation !== binding.generation || current.runtimeSessionId !== binding.runtimeSessionId
      || value.source.representationId !== locator.representationId || value.source.representationContentHash !== locator.representationContentHash) throw new DocumentAccessError('stale', 'Original citation source changed')
    return value.original
  }
}
