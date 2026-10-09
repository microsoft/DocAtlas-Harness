import { createHash } from 'node:crypto'
import { assetDescriptorIssues, pageInfoIssues, readResultIssues, searchResultIssues, treeIndexIssues,
  enrichmentIssues, type EnrichmentList, type EnrichmentPage, type EnrichmentResult, type ScopedSourceIdentity,
  type AssetDescriptor, type ReadResult, type SearchResult, type SidecarMethodMap, type TreeBuildRequest, type TreeGeneration, type TreePage, type TreeReadRequest } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { DocumentAccessError, DocumentSession, type DocumentInvocation } from './session.js'
import { enrichmentHash, type EnrichmentModelPort } from './enrichment.js'
import { ProductSearch, type SearchSummary } from './product-search.js'
import type { ProductSearchExecution } from '@docatlas/contracts'

export interface DocumentOperationsPort {
  call<K extends 'search' | 'read'>(method: K, params: SidecarMethodMap[K]['params'], signal?: AbortSignal): Promise<SidecarMethodMap[K]['result']>
  visualAsset(assetId: string, invocation: DocumentInvocation, signal?: AbortSignal): Promise<{ descriptor: AssetDescriptor, bytes: Uint8Array }>
  buildTree(request: TreeBuildRequest, signal?: AbortSignal): Promise<TreeGeneration>
  readTree(request: TreeReadRequest, signal?: AbortSignal): Promise<TreePage>
}
export interface DocumentReadOutput { scopeVersionId: string, result: ReadResult, images: Array<{ mediaType: 'image/png' | 'image/jpeg', bytes: Uint8Array }> }
/** Read-only host access to explicit, completed overlays. It cannot start a model job. */
export interface DocumentEnrichmentPort {
  list(active: DocumentInvocation, source: Readonly<ScopedSourceIdentity>): Promise<EnrichmentList['jobs']>
  get(active: DocumentInvocation, source: Readonly<ScopedSourceIdentity>, jobId: string): Promise<EnrichmentResult>
}
export interface DocumentReadReceiptPort { record(active: DocumentInvocation, callId: string, result: ReadResult): void }
export class DocumentOperations {
  private searchModel: EnrichmentModelPort | undefined
  private searchSummariesAvailable: () => boolean = () => false
  private productSearch: ProductSearch | undefined
  constructor(private readonly session: DocumentSession, private readonly backend: DocumentOperationsPort, private readonly enrichments?: DocumentEnrichmentPort, private readonly receipts?: DocumentReadReceiptPort) {}
  /** Trusted composition only; never a browser-selected model/provider. */
  enableTreeSearch(model: EnrichmentModelPort, summariesAvailable: () => boolean = () => false): void { this.searchModel = model; this.searchSummariesAvailable = summariesAvailable }
  sources() { return this.session.invocation().scope }
  assertRuntime(runtimeSessionId: string): void { this.session.assertRuntime(runtimeSessionId) }

  async search(fields: Record<string, unknown>, signal?: AbortSignal): Promise<{ scopeVersionId: string, result: SearchResult, searchExecution?: ProductSearchExecution }> {
    const policy = this.session.invocation().searchPolicy
    if (policy) fields = { ...structuredClone(fields), ...policy }
    if (fields.recipe !== undefined) {
      const request = parseContract('product-search', { ...structuredClone(fields), schemaVersion: 1, kind: 'product-search-request' })
      if (request.kind !== 'product-search-request') throw invalid()
      this.productSearch ??= new ProductSearch({ invocation: () => this.session.invocation(), model: () => this.searchModel,
        lexical: async (query, signal) => (await this.searchLegacy({ query, strategy: 'fts', limits: { maxItems: 100, maxChars: 20000 } }, signal)).result,
        tree: (source, offset, limit, signal) => this.tree(source.documentId, source.revisionId, 'raw', offset, limit, signal),
        summaries: (source, generationId, treeHash, signal) => this.searchSummary(source, generationId, treeHash, signal) })
      return this.productSearch.search(request, signal)
    }
    return this.searchLegacy(fields, signal)
  }

  private async searchLegacy(fields: Record<string, unknown>, signal?: AbortSignal): Promise<{ scopeVersionId: string, result: SearchResult }> {
    const active = this.session.invocation()
    signal?.throwIfAborted()
    const request = parseContract('sidecar-document-rpc', { ...structuredClone(fields), schemaVersion: 1, requestType: 'search',
      scopeVersionId: active.scope.scope.scopeVersionId, sources: active.scope.sources.map(({ documentId, revisionId, representationId }) => ({ documentId, revisionId, representationId })) })
    if (!('requestType' in request) || request.requestType !== 'search') throw invalid()
    const value = await this.backend.call('search', request, signal)
    signal?.throwIfAborted(); active.assertCurrent()
    const result = parseContract('sidecar-document-rpc', value)
    if (!('resultType' in result) || result.resultType !== 'search' || searchResultIssues(result).length || pageInfoIssues(result.pageInfo).length
      || result.scopeVersionId !== request.scopeVersionId || result.candidates.length > request.limits.maxItems
      || result.candidates.reduce((sum, item) => sum + [...item.preview].length, 0) > request.limits.maxChars
      || result.candidates.some(item => !request.sources.some(source => sourceKey(source) === sourceKey(item)))) throw invalid()
    return { scopeVersionId: request.scopeVersionId, result }
  }

  private async searchSummary(source: Readonly<ScopedSourceIdentity>, generationId: string, treeHash: string, signal: AbortSignal): Promise<SearchSummary | undefined> {
    if (!this.searchSummariesAvailable()) return undefined
    const listing = await this.enrichment(source.documentId, source.revisionId, undefined, 0, 50, 20000, signal)
    if (listing.kind !== 'enrichment-list') throw invalid()
    const job = listing.jobs.find(job => job.baseGenerationId === generationId && job.baseTreeHash === treeHash)
    if (!job) return undefined
    const page = await this.enrichment(source.documentId, source.revisionId, job.jobId, 0, 50, 20000, signal)
    if (page.kind !== 'enrichment-page' || page.resultHash !== job.resultHash || page.baseGenerationId !== generationId || page.baseTreeHash !== treeHash) throw invalid()
    return { jobId: page.jobId, resultHash: page.resultHash, baseGenerationId: page.baseGenerationId, baseTreeHash: page.baseTreeHash,
      nodes: page.nodes.flatMap(node => node.summary ? [{ nodeId: node.nodeId, summary: node.summary }] : []) }
  }

  async read(documentId: string, revisionId: string | undefined, fields: Record<string, unknown>, signal?: AbortSignal, callId?: string): Promise<DocumentReadOutput> {
    const active = this.session.invocation()
    const source = active.source(documentId, revisionId)
    signal?.throwIfAborted()
    const request = parseContract('sidecar-document-rpc', { ...structuredClone(fields), schemaVersion: 1, requestType: 'read',
      source: { documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId } })
    if (!('requestType' in request) || request.requestType !== 'read') throw invalid()
    const value = await this.backend.call('read', request, signal)
    signal?.throwIfAborted(); active.assertCurrent()
    const result = parseContract('sidecar-document-rpc', value)
    if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== request.mode || sourceKey(result.source) !== sourceKey(source)
      || readResultIssues(result).length || pageInfoIssues(result.pageInfo).length || result.items.length > request.limits.maxItems
      || result.items.reduce((sum, item) => sum + (item.itemType === 'block' ? [...item.text].length : 0), 0) > request.limits.maxChars
      || result.items.some(item => sourceKey(item.locator) !== sourceKey(source) || item.locator.representationContentHash !== source.representationContentHash)) throw invalid()
    if ('physicalPage' in request && request.physicalPage !== undefined && result.items.some(item => item.physicalPage !== request.physicalPage)) throw invalid()
    if (request.mode === 'blocks' && result.items.some(item => item.itemType !== 'block' || !request.blockIds.includes(item.blockId))) throw invalid()
    const images: DocumentReadOutput['images'] = []
    for (const item of result.items) if (item.itemType === 'visual') {
      if (request.mode !== 'visual' || item.asset.width * item.asset.height > (request.maxPixels ?? 40_000_000)) throw invalid()
      const { descriptor, bytes } = await this.backend.visualAsset(item.asset.assetId, active, signal)
      signal?.throwIfAborted(); active.assertCurrent()
      parseContract('asset-descriptor', descriptor)
      if (assetDescriptorIssues(descriptor).length || descriptor.kind === 'original-bytes' || sourceKey(descriptor) !== sourceKey(source)
        || descriptor.representationContentHash !== source.representationContentHash || descriptor.assetId !== item.asset.assetId
        || descriptor.contentHash !== item.asset.contentHash || descriptor.byteLength !== item.asset.byteLength || descriptor.mediaType !== item.asset.mediaType
        || descriptor.width !== item.asset.width || descriptor.height !== item.asset.height
        || descriptor.physicalPage !== item.physicalPage || descriptor.byteLength !== bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024
        || createHash('sha256').update(bytes).digest('hex') !== descriptor.contentHash || (descriptor.mediaType !== 'image/png' && descriptor.mediaType !== 'image/jpeg')) throw invalid()
      images.push({ mediaType: descriptor.mediaType, bytes })
    }
    signal?.throwIfAborted(); active.assertCurrent()
    if (this.receipts && callId !== undefined && request.mode !== 'locate') this.receipts.record(active, callId, result)
    signal?.throwIfAborted(); active.assertCurrent()
    return { scopeVersionId: active.scope.scope.scopeVersionId, result, images }
  }

  async tree(documentId: string, revisionId: string | undefined, mode: 'raw' | 'merge', offset: number, limit: number, signal?: AbortSignal): Promise<TreePage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 20000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new DocumentAccessError('invalid-request', 'Invalid tree navigation window')
    const active = this.session.invocation(), source = active.source(documentId, revisionId)
    const identity = { documentId: source.documentId, revisionId: source.revisionId, sourceHash: active.originalHash(source) }
    const request: TreeBuildRequest = { schemaVersion: 1, kind: 'build-tree', ...identity, config: { mode, useEmbeddedToc: true, workers: 1 } }
    parseContract('tree-index', request)
    signal?.throwIfAborted()
    const manifest = await this.backend.buildTree(request, signal)
    signal?.throwIfAborted(); active.assertCurrent(); parseContract('tree-index', manifest)
    if (manifest.kind !== 'tree-generation' || treeIndexIssues(manifest).length || manifest.documentId !== identity.documentId || manifest.revisionId !== identity.revisionId
      || manifest.sourceHash !== identity.sourceHash || manifest.config.mode !== mode || manifest.config.useEmbeddedToc !== true || manifest.config.workers !== 1) throw invalid()
    const read: TreeReadRequest = { schemaVersion: 1, kind: 'read-tree', ...identity, generationId: manifest.generationId, offset, limit }
    parseContract('tree-index', read)
    const page = await this.backend.readTree(read, signal)
    signal?.throwIfAborted(); active.assertCurrent(); parseContract('tree-index', page)
    if (page.kind !== 'tree-page' || treeIndexIssues(page).length || page.generationId !== manifest.generationId || page.treeHash !== manifest.treeHash
      || page.total !== manifest.nodeCount || page.offset !== offset || page.nodes.length > limit) throw invalid()
    return page
  }

  async enrichment(documentId: string, revisionId: string | undefined, jobId: string | undefined, offset: number, limit: number, maxChars: number, signal?: AbortSignal): Promise<EnrichmentList | EnrichmentPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || !Number.isSafeInteger(maxChars) || maxChars < 1024 || maxChars > 20000) throw new DocumentAccessError('invalid-request', 'Invalid enrichment navigation window')
    const active = this.session.invocation(), source = active.source(documentId, revisionId)
    if (!this.enrichments) throw new DocumentAccessError('unavailable', 'Enrichment navigation is not configured')
    signal?.throwIfAborted()
    const identity = { schemaVersion: 1 as const, scopeVersionId: active.scope.scope.scopeVersionId, documentId: source.documentId, revisionId: source.revisionId,
      sourceHash: active.originalHash(source), representationId: source.representationId, representationHash: source.representationContentHash, navigationOnly: true as const }
    const check = () => { signal?.throwIfAborted(); active.assertCurrent(); if (active.originalHash(source) !== identity.sourceHash) throw new DocumentAccessError('stale', 'Original PDF changed during enrichment navigation') }
    let value: EnrichmentList | EnrichmentPage
    if (jobId === undefined) {
      const jobs = await this.enrichments.list(active, source)
      check()
      if (jobs.length > 256) throw invalid()
      value = fitNavigation(jobs, offset, limit, maxChars, (items, nextOffset) => ({ ...identity, kind: 'enrichment-list', offset, total: jobs.length, nextOffset, jobs: items }))
    } else {
      if (!jobId || jobId.length > 256) throw new DocumentAccessError('invalid-request', 'Invalid enrichment job reference')
      const result = await this.enrichments.get(active, source, jobId)
      check(); parseContract('enrichment', result)
      const { resultHash, ...unsigned } = result
      if (enrichmentIssues(result).length || result.documentId !== source.documentId || result.revisionId !== source.revisionId || result.sourceHash !== identity.sourceHash
        || result.representationId !== source.representationId || result.representationHash !== source.representationContentHash || enrichmentHash(unsigned) !== resultHash) throw invalid()
      value = fitNavigation(result.nodes, offset, limit, maxChars, (nodes, nextOffset) => ({ ...identity, kind: 'enrichment-page', jobId, enrichmentId: result.enrichmentId,
        baseGenerationId: result.baseGenerationId, baseTreeHash: result.baseTreeHash, inputHash: result.inputHash, resultHash: result.resultHash, recipe: result.recipe,
        offset, total: result.nodes.length, nextOffset, nodes }))
    }
    parseContract('enrichment', value)
    if (enrichmentIssues(value).length) throw invalid()
    check()
    return value
  }
}
function fitNavigation<T, P extends EnrichmentList | EnrichmentPage>(items: T[], offset: number, limit: number, maxChars: number, project: (items: T[], nextOffset: number | null) => P): P {
  if (offset > items.length) throw new DocumentAccessError('invalid-request', 'Enrichment offset exceeds result count')
  let count = Math.min(limit, items.length - offset)
  while (true) {
    const end = offset + count, value = project(items.slice(offset, end), end < items.length ? end : null), text = JSON.stringify(value)
    if (text.length <= maxChars && Buffer.byteLength(text) <= 65536 && (count > 0 || offset === items.length)) return value
    if (count <= 1) throw new DocumentAccessError('invalid-request', 'Enrichment node exceeds presentation budget; increase maxChars')
    count--
  }
}
function sourceKey(value: { documentId: string, revisionId: string, representationId: string }): string { return `${value.documentId}\0${value.revisionId}\0${value.representationId}` }
function invalid(): DocumentAccessError { return new DocumentAccessError('invalid-output', 'Document result failed source or budget validation') }
