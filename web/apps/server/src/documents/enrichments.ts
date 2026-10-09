import type { EnrichmentStart, EnrichmentJob, EnrichmentList, EnrichmentResult, ScopedSourceIdentity, ProductBinding, TreeData, TreePage, TreeNode, TreeGeneration, TreeSummaryPreview } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { treeIndexIssues, readResultIssues, pageInfoIssues } from '@docatlas/contracts'
import { enrichTree, enrichmentHash, selectedEnrichmentNodes, EnrichmentError, type DocumentInvocation, type EnrichmentInput, type EnrichmentModelPort, type SourceScopeStore } from '@docatlas/core'
import { EnrichmentJobs } from '../storage/enrichment-jobs.js'
import type { ManagedDocumentBackend } from '@docatlas/runtime-document'

export class DocumentEnrichments {
  private readonly active = new Map<string, { controller: AbortController, done: Promise<EnrichmentJob> }>()
  private readonly views = new Map<Promise<void>, () => void>()
  private closed = false
  constructor(readonly jobs: EnrichmentJobs, private readonly store: SourceScopeStore, private readonly binding: (id: string) => ProductBinding, private readonly backend: () => ManagedDocumentBackend, private readonly model: EnrichmentModelPort) {}
  accept(conversationId: string, request: EnrichmentStart): EnrichmentJob {
    this.requireOpen(); const binding = this.binding(conversationId); this.source(binding, request.documentId, request.revisionId)
    // Idempotent accepts can return terminal results, so they share the same freshness gate as GET.
    return this.get(conversationId, this.jobs.accept(binding, request).jobId)
  }
  get(conversationId: string, id: string): EnrichmentJob {
    this.requireOpen(); const binding = this.binding(conversationId), job = this.jobs.get(binding, id), current = this.source(binding, job.request.documentId, job.request.revisionId)
    if (job.result && !this.matches(job.result, current)) throw new EnrichmentError('source-changed', 'Completed enrichment source or representation changed')
    return job
  }
  async listNavigation(conversationId: string, active: DocumentInvocation, source: Readonly<ScopedSourceIdentity>): Promise<EnrichmentList['jobs']> {
    this.requireOpen(); active.assertCurrent()
    const binding = this.binding(conversationId), current = this.source(binding, source.documentId, source.revisionId), jobs: EnrichmentList['jobs'] = []
    this.assertActiveSource(active, source, current)
    for (const job of this.jobs.completed(binding)) {
      const result = job.result!
      if (result.documentId !== source.documentId || result.revisionId !== source.revisionId || !this.matches(result, current)) continue
      jobs.push({ jobId: job.jobId, enrichmentId: result.enrichmentId, baseGenerationId: result.baseGenerationId, baseTreeHash: result.baseTreeHash, mode: job.request.mode, nodeCount: result.nodes.length, resultHash: result.resultHash })
    }
    active.assertCurrent(); return jobs
  }
  async readNavigation(conversationId: string, active: DocumentInvocation, source: Readonly<ScopedSourceIdentity>, jobId: string): Promise<EnrichmentResult> {
    this.requireOpen(); active.assertCurrent()
    const current = this.source(this.binding(conversationId), source.documentId, source.revisionId)
    this.assertActiveSource(active, source, current)
    const job = this.get(conversationId, jobId)
    if (!job.result) throw new EnrichmentError('unavailable', 'Enrichment is not completed; navigation never starts jobs')
    if (job.result.documentId !== source.documentId || job.result.revisionId !== source.revisionId || !this.matches(job.result, current)) throw new EnrichmentError('source-changed', 'Enrichment does not belong to the active source')
    active.assertCurrent(); return job.result
  }
  start(conversationId: string, id: string): Promise<EnrichmentJob> {
    const job = this.get(conversationId, id), existing = this.active.get(id)
    if (existing) return existing.done
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return Promise.resolve(job)
    const binding = this.binding(conversationId), claim = this.jobs.claim(binding, id), controller = new AbortController()
    const done = this.run(binding, claim.job, claim.token, controller.signal)
    this.active.set(id, { controller, done }); void done.finally(() => this.active.delete(id)).catch(() => {})
    return done
  }
  async cancel(conversationId: string, id: string): Promise<EnrichmentJob> {
    const job = this.get(conversationId, id), active = this.active.get(id)
    if (active) { active.controller.abort(); return active.done }
    return job.state === 'queued' ? this.jobs.cancelQueued(this.binding(conversationId), id) : ['completed', 'failed', 'cancelled'].includes(job.state) ? job : this.jobs.cancelQueued(this.binding(conversationId), id)
  }
  async tree(conversationId: string, documentId: string, revisionId: string, mode: 'raw' | 'merge', signal: AbortSignal, offset = 0): Promise<{ generation: TreeGeneration, tree: TreePage, summaryPreviews: TreeSummaryPreview[] }> {
    this.requireOpen(); if (this.views.size >= 2) throw new EnrichmentError('budget-exceeded', 'Tree preview capacity reached')
    const binding = this.binding(conversationId), before = this.source(binding, documentId, revisionId), backend = this.backend(), completion = Promise.withResolvers<void>()
    const stop = () => { void backend.abortAll().catch(() => {}) }; this.views.set(completion.promise, stop); void completion.promise.catch(() => {}); signal.addEventListener('abort', stop, { once: true })
    const check = () => { this.requireOpen(); signal.throwIfAborted(); if (this.binding(conversationId).bindingId !== binding.bindingId || enrichmentHash(before) !== enrichmentHash(this.source(binding, documentId, revisionId))) throw new EnrichmentError('source-changed', 'Tree source changed') }
    let output: { generation: TreeGeneration, tree: TreePage } | undefined, failed = false, failure: unknown
    try {
      check(); const loaded = await this.loadTree(backend, documentId, revisionId, before.originalHash, mode, check, signal)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > loaded.tree.nodes.length) throw new EnrichmentError('invalid-output', 'Invalid tree preview offset')
      const nodes = loaded.tree.nodes.slice(offset, offset + 200), end = offset + nodes.length
      output = { generation: loaded.generation, tree: { schemaVersion: 1, kind: 'tree-page', generationId: loaded.generation.generationId, treeHash: loaded.generation.treeHash, offset, total: loaded.tree.nodes.length, nextOffset: end < loaded.tree.nodes.length ? end : null, nodes } }
    } catch (error) { failed = true; failure = error }
    signal.removeEventListener('abort', stop)
    try { await backend.abortAll(); completion.resolve(); this.views.delete(completion.promise) }
    catch (error) {
      // Keep the view claim if namespace join fails, and retain the original failure as well.
      completion.reject(error)
      if (failed) throw new AggregateError([failure, error], 'Tree preview and backend join failed')
      throw error
    }
    if (failed) throw failure
    check()
    const summaryPreviews = this.summaryPreviews(binding, before, output!.generation, output!.tree.nodes)
    check()
    return { ...output!, summaryPreviews }
  }
  /** Ephemeral presentation overlay. Canonical tree bytes/hashes never contain generated summaries. */
  private summaryPreviews(binding: ProductBinding, current: ReturnType<DocumentEnrichments['source']>, generation: TreeGeneration, nodes: TreeNode[]): TreeSummaryPreview[] {
    const indexed = new Map(nodes.map(node => [node.nodeId, node])), picked = new Map<string, { time: number, value: TreeSummaryPreview }>()
    for (const job of this.jobs.completed(binding)) {
      const result = job.result!
      if (result.documentId !== generation.documentId || result.revisionId !== generation.revisionId || result.baseGenerationId !== generation.generationId
        || result.baseTreeHash !== generation.treeHash || !this.matches(result, current)) continue
      for (const node of result.nodes) {
        const base = indexed.get(node.nodeId)
        if (!base || !node.summary?.trim() || !node.summaryKind || base.title !== node.title || base.startPage !== node.startPage || base.endPage !== node.endPage || base.parentId !== node.parentId) continue
        const previous = picked.get(node.nodeId), time = Date.parse(job.updatedAt)
        if (previous && (previous.time > time || previous.time === time && previous.value.jobId > job.jobId)) continue
        const chars = [...node.summary]
        picked.set(node.nodeId, { time, value: { nodeId: node.nodeId, jobId: job.jobId, resultHash: result.resultHash, preview: chars.slice(0, 240).join(''), summaryKind: node.summaryKind, truncated: chars.length > 240 } })
      }
    }
    return nodes.flatMap(node => { const value = picked.get(node.nodeId)?.value; return value ? [value] : [] })
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true
    for (const value of this.active.values()) value.controller.abort()
    for (const stop of this.views.values()) stop()
    await Promise.all([...this.active.values()].map(value => value.done)); await Promise.all(this.views.keys())
  }
  private async run(binding: ProductBinding, job: EnrichmentJob, token: string, cancelled: AbortSignal): Promise<EnrichmentJob> {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(job.request.budget.wallMs)])
    let backend: ManagedDocumentBackend | undefined, verifyFinal: (() => void) | undefined
    let result: EnrichmentJob['result'] = null, error: EnrichmentJob['error'] = null
    const stop = () => { void backend?.abortAll().catch(() => {}) }; signal.addEventListener('abort', stop, { once: true })
    try {
      backend = this.backend()
      const initial = this.source(binding, job.request.documentId, job.request.revisionId)
      const check = () => {
        signal.throwIfAborted(); this.jobs.assertOwner(binding, job.jobId, token)
        if (this.binding(binding.conversationId).bindingId !== binding.bindingId || enrichmentHash(initial) !== enrichmentHash(this.source(binding, job.request.documentId, job.request.revisionId))) throw new EnrichmentError('source-changed', 'Enrichment source permission or revision changed')
      }
      verifyFinal = check
      check()
      const base = await this.loadTree(backend, job.request.documentId, job.request.revisionId, initial.originalHash, job.request.baseMode, check, signal)
      const nodes = selectedEnrichmentNodes(job.request, base.tree), needed = new Set<number>()
      for (const node of nodes) for (let page = node.startPage; page <= node.endPage; page++) { needed.add(page); if (needed.size > job.request.budget.maxPages) throw new EnrichmentError('budget-exceeded', 'Selected subtree exceeds page budget') }
      const pages: EnrichmentInput['pages'] = []; let chars = 0
      for (const page of [...needed].sort((a, b) => a - b)) {
        let cursor: string | undefined, text = ''; const cursors = new Set<string>()
        do {
          check()
          const value = await backend.call('read', { schemaVersion: 1, requestType: 'read', mode: 'page', physicalPage: page, source: { documentId: job.request.documentId, revisionId: job.request.revisionId, representationId: initial.source.representationId }, limits: { maxItems: 200, maxChars: 20000 }, ...(cursor ? { cursor } : {}) }, signal)
          check(); parseContract('sidecar-document-rpc', value)
          if (value.resultType !== 'read' || value.mode !== 'page' || readResultIssues(value).length || pageInfoIssues(value.pageInfo).length || value.items.length > 200 || value.items.some(item => item.itemType !== 'block' || item.physicalPage !== page || item.locator.physicalPage !== page
            || item.locator.documentId !== job.request.documentId || item.locator.revisionId !== job.request.revisionId || item.locator.representationId !== initial.source.representationId || item.locator.representationContentHash !== initial.source.representationContentHash)) throw new EnrichmentError('source-changed', 'Page data identity mismatch')
          const part = value.items.map(item => item.itemType === 'block' ? item.text : '').join('\n'); chars += [...part].length + 1; text += part + '\n'
          if (chars > job.request.budget.maxInputChars) throw new EnrichmentError('budget-exceeded', 'Source text exceeds job budget')
          cursor = value.pageInfo.nextCursor
          if (cursor) { if (cursors.has(cursor) || cursors.size >= 20) throw new EnrichmentError('budget-exceeded', 'Page cursor exceeds budget'); cursors.add(cursor) }
          if (value.pageInfo.truncated && !cursor) throw new EnrichmentError('source-changed', 'Source page is incomplete')
        } while (cursor)
        pages.push({ page, text })
      }
      check()
      const input = { ...base, source: initial.source, pages }, inputHash = enrichmentHash({ input, request: job.request })
      this.jobs.generating(binding, job.jobId, token, inputHash)
      result = await enrichTree(job.request, input, job.jobId, this.model, check, signal); check()
    } catch (cause) { error = cause instanceof EnrichmentError ? cause.code : 'unavailable' }
    finally { signal.removeEventListener('abort', stop); await backend?.abortAll() }
    // Provider adapter has also joined before enrichTree returns/rejects. Never release a live claim early.
    if (cancelled.aborted || this.closed) return this.jobs.finish(binding, job.jobId, token, 'cancelled', null, null)
    if (!error) try { verifyFinal?.() } catch (cause) { error = cause instanceof EnrichmentError ? cause.code : 'unavailable' }
    if (signal.aborted) error = 'budget-exceeded'
    return this.jobs.finish(binding, job.jobId, token, error ? 'failed' : 'completed', error ? null : result, error)
  }
  private async loadTree(backend: ManagedDocumentBackend, documentId: string, revisionId: string, sourceHash: string, mode: 'raw' | 'merge', check: () => void, signal: AbortSignal): Promise<{ generation: TreeGeneration, tree: TreeData }> {
    const identity = { documentId, revisionId, sourceHash }, generation = await backend.buildTree({ schemaVersion: 1, kind: 'build-tree', ...identity, config: { mode, useEmbeddedToc: true, workers: 1 } }, signal)
    check(); parseContract('tree-index', generation)
    if (generation.documentId !== documentId || generation.revisionId !== revisionId || generation.sourceHash !== sourceHash || generation.config.mode !== mode || treeIndexIssues(generation).length) throw new EnrichmentError('source-changed', 'Tree manifest changed')
    const nodes: TreeNode[] = []
    while (nodes.length < generation.nodeCount) {
      const page = await backend.readTree({ schemaVersion: 1, kind: 'read-tree', ...identity, generationId: generation.generationId, offset: nodes.length, limit: 200 }, signal)
      check(); parseContract('tree-index', page)
      if (page.generationId !== generation.generationId || page.treeHash !== generation.treeHash || page.total !== generation.nodeCount || page.offset !== nodes.length || treeIndexIssues(page).length || !page.nodes.length) throw new EnrichmentError('source-changed', 'Tree pagination changed')
      nodes.push(...page.nodes)
    }
    const tree: TreeData = { schemaVersion: 1, kind: 'tree-data', generationId: generation.generationId, pageCount: generation.pageCount, nodes }
    if (treeIndexIssues(tree).length || enrichmentHash(tree) !== generation.treeHash) throw new EnrichmentError('source-changed', 'Base tree seal mismatch')
    return { generation, tree }
  }
  private source(binding: ProductBinding, documentId: string, revisionId: string) {
    const source = this.store.getEligibleLibrarySource(binding.workspaceId, documentId, revisionId), original = this.store.getLibraryRepresentations(binding.workspaceId, documentId, revisionId).find(item => item.kind === 'original-bytes' && item.mediaType === 'application/pdf')
    if (!source || !original || this.store.get(binding.conversationId).scope?.excluded.some(item => item.documentId === documentId && item.revisionId === revisionId && item.reason !== 'user')) throw new EnrichmentError('source-changed', 'Enrichment source is not authorized')
    return { source, originalHash: original.contentHash }
  }
  private matches(result: EnrichmentResult, current: ReturnType<DocumentEnrichments['source']>): boolean {
    return result.sourceHash === current.originalHash && result.representationId === current.source.representationId && result.representationHash === current.source.representationContentHash
  }
  private assertActiveSource(active: DocumentInvocation, source: Readonly<ScopedSourceIdentity>, current: ReturnType<DocumentEnrichments['source']>): void {
    const approved = active.source(source.documentId, source.revisionId)
    if (enrichmentHash(approved) !== enrichmentHash(source) || enrichmentHash(source) !== enrichmentHash(current.source) || active.originalHash(source) !== current.originalHash) throw new EnrichmentError('source-changed', 'Enrichment active source changed')
    active.assertCurrent()
  }
  private requireOpen(): void { if (this.closed) throw new EnrichmentError('unavailable', 'Enrichment service is closed') }
}
