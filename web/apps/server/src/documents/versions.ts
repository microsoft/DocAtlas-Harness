import { randomUUID } from 'node:crypto'
import { DocumentAccessError, LibraryServiceError, enrichmentHash, type LibraryService, type SourceScopeStore } from '@docatlas/core'
import { productLibraryIssues, type LibraryImportRequest, type ProductBinding, type ProductLibraryValue,
  type ProductRevisionHistory, type ProductRevisionImport, type ProductRevisionImportState, type UploadReceipt } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { UploadStore } from './uploads.js'
import type { ProductAnswers } from './answers.js'

const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const deny = (message: string): never => { throw new DocumentAccessError('permission-denied', message) }
interface HistoryCursor { owner: string, digest: string, offset: number, expiresAt: number }

/** Explicit Library revision intent. Neither uploads nor history inspection activate a Pi source scope. */
export class ProductLibrary {
  private readonly cursors = new Map<string, HistoryCursor>()
  constructor(private readonly store: SourceScopeStore, private readonly library: LibraryService, private readonly uploads: UploadStore,
    private readonly binding: (conversationId: string) => ProductBinding, private readonly answers: Pick<ProductAnswers, 'originalDocument'>,
    private readonly now: () => number = Date.now) {}

  private current(binding: ProductBinding): void {
    const value = this.binding(binding.conversationId)
    if (value.ownerActorId !== binding.ownerActorId || value.workspaceId !== binding.workspaceId || value.bindingId !== binding.bindingId
      || value.generation !== binding.generation || value.runtimeSessionId !== binding.runtimeSessionId
      || value.ownerActorId !== this.uploads.actor.actorId || value.workspaceId !== this.uploads.actor.workspaceId) throw new DocumentAccessError('stale', 'Library conversation identity changed')
  }
  private source(binding: ProductBinding, documentId: string, revisionId: string) {
    this.current(binding)
    const source = this.store.getEligibleLibrarySource(binding.workspaceId, documentId, revisionId)
    if (!source || this.store.get(binding.conversationId).scope?.excluded.some(value => value.documentId === documentId && value.revisionId === revisionId && value.reason !== 'user')) return deny('The requested Library source is not authorized')
    return source
  }
  private document(binding: ProductBinding, documentId: string) {
    if (!opaque(documentId)) throw new DocumentAccessError('invalid-request', 'Invalid Library document reference')
    this.current(binding)
    const document = this.store.getLibraryDocument(binding.workspaceId, documentId)
    if (!document || document.workspaceId !== binding.workspaceId || document.status === 'archived' || document.mediaType !== 'application/pdf') return deny('The requested PDF document is not available')
    this.source(binding, documentId, document.currentRevision.revisionId)
    return document
  }
  private command(conversationId: string, candidate: unknown) {
    let value: ProductLibraryValue
    try { value = parseContract('product-library', candidate) } catch { throw new DocumentAccessError('invalid-request', 'Invalid revision import intent') }
    if (value.kind !== 'revision-import' || productLibraryIssues(value).length) throw new DocumentAccessError('invalid-request', 'Invalid revision import intent')
    const request: ProductRevisionImport = structuredClone(value), binding = this.binding(conversationId)
    const document = this.document(binding, request.targetDocumentId)
    this.source(binding, request.targetDocumentId, request.expectedCurrentRevisionId)
    const upload = this.uploads.get(conversationId, request.uploadId)
    const input: LibraryImportRequest = { schemaVersion: 1, requestType: 'library-import', sessionId: conversationId, workspaceId: binding.workspaceId,
      candidateId: request.uploadId, sourceRole: document.sourceRole,
      idempotencyKey: `revision:${enrichmentHash([binding.ownerActorId, binding.workspaceId, conversationId, request.idempotencyKey])}`,
      revisionTarget: { documentId: request.targetDocumentId, expectedCurrentRevisionId: request.expectedCurrentRevisionId } }
    return { request, binding, upload, input }
  }
  private authority(binding: ProductBinding, request: ProductRevisionImport, upload: UploadReceipt) {
    const uploadHash = enrichmentHash(upload)
    return { commandHash: enrichmentHash(request), assertCurrent: () => {
      this.current(binding); this.document(binding, request.targetDocumentId); this.source(binding, request.targetDocumentId, request.expectedCurrentRevisionId)
      if (enrichmentHash(this.uploads.get(binding.conversationId, request.uploadId)) !== uploadHash) throw new DocumentAccessError('stale', 'Revision upload reservation changed')
    } }
  }
  import(conversationId: string, candidate: unknown): ProductRevisionImportState {
    const { request, binding, upload, input } = this.command(conversationId, candidate), authority = this.authority(binding, request, upload)
    if (request.expectedGeneration !== binding.generation) throw new DocumentAccessError('stale', 'Revision import belongs to another conversation generation')
    // Only an explicit import retry may close an old domain/job gap. Do this before current
    // revision CAS: the already-committed original revision must never be retargeted or ingested.
    const existing = this.library.reconcileImport(input, authority)
    if (!existing || existing.status === 'queued' || existing.status === 'running') {
      if (upload.status !== 'stored') throw new DocumentAccessError('stale', 'Upload bytes are not committed')
      if (this.document(binding, request.targetDocumentId).currentRevision.revisionId !== request.expectedCurrentRevisionId) throw new DocumentAccessError('stale', 'The current document revision changed; the original import intent was not retargeted')
      this.library.acceptImport(input, authority)
    }
    const job = this.library.lookupImport(input, authority)
    if (!job) throw new DocumentAccessError('invalid-output', 'Accepted revision import has no durable job')
    return this.valid({ schemaVersion: 1, kind: 'revision-import-state', conversationId, bindingId: binding.bindingId, generation: binding.generation,
      request, requestHash: enrichmentHash(request), job })
  }
  status(conversationId: string, candidate: unknown): ProductRevisionImportState {
    const { request, binding, upload, input } = this.command(conversationId, candidate)
    // Inspection may reconcile an old generation, but never changes that intent or resumes a job.
    const job = this.library.lookupImport(input, this.authority(binding, request, upload)) ?? null
    return this.valid({ schemaVersion: 1, kind: 'revision-import-state', conversationId, bindingId: binding.bindingId, generation: binding.generation,
      request, requestHash: enrichmentHash(request), job })
  }
  history(conversationId: string, documentId: string, cursor?: string): ProductRevisionHistory {
    const binding = this.binding(conversationId), document = this.document(binding, documentId)
    const all = this.store.getLibraryRevisions(binding.workspaceId, documentId).filter(item => {
      try { this.source(binding, documentId, item.revision.revisionId); return true }
      catch (error) { if (error instanceof DocumentAccessError && error.code === 'permission-denied') return false; throw error }
    }).reverse()
    if (all.length > 4096) throw new LibraryServiceError('limit-exceeded', 'Revision history exceeds its bounded inspection window')
    const owner = enrichmentHash([binding.ownerActorId, binding.workspaceId, conversationId, binding.bindingId, binding.generation, binding.runtimeSessionId, documentId])
    const digest = enrichmentHash(all), time = this.now()
    for (const [id, item] of this.cursors) if (item.expiresAt <= time) this.cursors.delete(id)
    let offset = 0
    if (cursor !== undefined) {
      if (!opaque(cursor)) throw new DocumentAccessError('invalid-request', 'Invalid history cursor')
      const item = this.cursors.get(cursor)
      if (!item || item.owner !== owner || item.digest !== digest || item.expiresAt <= time) throw new DocumentAccessError('stale', 'Revision history or its authorization changed; restart the list')
      offset = item.offset
    }
    const slice = all.slice(offset, offset + 32)
    const versions: ProductRevisionHistory['versions'] = slice.map(item => {
      const source = this.source(binding, documentId, item.revision.revisionId)
      let original: ProductRevisionHistory['versions'][number]['original'] = null
      try {
        const metadata = this.answers.originalDocument(conversationId, documentId, item.revision.revisionId).original
        if (metadata.byteLength <= 26214400) original = metadata
      }
      catch (error) { if (!(error instanceof DocumentAccessError) || !['not-found', 'stale', 'permission-denied'].includes(error.code)) throw error }
      return { revision: item.revision, source, original }
    })
    const truncated = offset + slice.length < all.length
    let nextCursor: string | null = null
    if (truncated) {
      if (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!)
      nextCursor = `revisions:${randomUUID()}`
      this.cursors.set(nextCursor, { owner, digest, offset: offset + slice.length, expiresAt: time + 300000 })
    }
    this.current(binding)
    return this.valid({ schemaVersion: 1, kind: 'revision-history', conversationId, bindingId: binding.bindingId, generation: binding.generation,
      documentId, currentRevisionId: document.currentRevision.revisionId, versions, nextCursor, truncated })
  }
  private valid<T extends ProductLibraryValue>(value: T): T {
    parseContract('product-library', value)
    if (productLibraryIssues(value).length || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new DocumentAccessError('invalid-output', 'Invalid revision response')
    return value
  }
}
