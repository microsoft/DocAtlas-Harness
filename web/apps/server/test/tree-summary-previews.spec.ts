import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { enrichmentHash, type EnrichmentModelPort, type SourceScopeStore } from '@docatlas/core'
import type { ManagedDocumentBackend } from '@docatlas/runtime-document'
import type { EnrichmentJob, EnrichmentResult, EnrichmentStart, EnrichmentTree, ProductBinding, TreeData, TreeNode } from '@docatlas/contracts'
import type { EnrichmentJobs } from '../src/storage/enrichment-jobs.js'
import { DocumentEnrichments } from '../src/documents/enrichments.js'

it('adds bounded summaries from the exact completed generation while leaving the canonical tree unchanged and never calling a model', async () => {
  const bases = JSON.parse(readFileSync('contracts/fixtures/document/enrichment.json', 'utf8')).bases as { tree: EnrichmentTree, result: EnrichmentResult, request: EnrichmentStart }
  const binding = JSON.parse(readFileSync('contracts/fixtures/product/control.json', 'utf8')).valid[0] as ProductBinding
  const generation = structuredClone(bases.tree.generation), node: TreeNode = { nodeId: `${generation.generationId}:test`, parentId: null, title: 'Experiment', startPage: 1, endPage: 1, sourceNodeId: null, keyItems: [] }
  const tree: TreeData = { schemaVersion: 1, kind: 'tree-data', generationId: generation.generationId, pageCount: generation.pageCount, nodes: [node] }
  generation.nodeCount = 1; generation.treeHash = enrichmentHash(tree)
  const makeJob = (id: string, text: string, time: string): EnrichmentJob => {
    const result: EnrichmentResult = { ...bases.result, documentId: generation.documentId, revisionId: generation.revisionId, sourceHash: generation.sourceHash,
      baseGenerationId: generation.generationId, baseTreeHash: generation.treeHash, nodes: [{ ...node, summary: text, summaryKind: 'model' }], decisions: [] }
    const { resultHash: _old, ...unsigned } = result; result.resultHash = enrichmentHash(unsigned)
    return { schemaVersion: 1, kind: 'enrichment-job', jobId: id, conversationId: binding.conversationId, bindingId: binding.bindingId, runtimeSessionId: binding.runtimeSessionId, actorId: binding.ownerActorId, workspaceId: binding.workspaceId, generation: binding.generation,
      request: bases.request, state: 'completed', createdAt: time, updatedAt: time, result, error: null }
  }
  const old = makeJob('job:old', 'Old summary', '2026-09-11T00:00:00Z'), latest = makeJob('job:new', '章节摘要🙂'.repeat(100), '2026-09-11T01:00:00Z')
  const wrong = makeJob('job:foreign', 'Wrong-generation summary', '2026-09-11T02:00:00Z'); wrong.result!.baseTreeHash = 'f'.repeat(64)
  const wrongSource = makeJob('job:source', 'Wrong source', '2026-09-11T02:00:00Z'); wrongSource.result!.sourceHash = 'e'.repeat(64)
  const wrongNode = makeJob('job:node', 'Different paragraph', '2026-09-11T02:00:00Z'); wrongNode.result!.nodes[0]!.startPage = 2
  const jobs = { completed: () => [old, latest, wrong, wrongSource, wrongNode] } as unknown as EnrichmentJobs
  let revoked = false
  const store = { getEligibleLibrarySource: () => revoked ? undefined : ({ documentId: generation.documentId, revisionId: generation.revisionId, representationId: bases.result.representationId, representationContentHash: bases.result.representationHash }),
    getLibraryRepresentations: () => [{ kind: 'original-bytes', mediaType: 'application/pdf', contentHash: generation.sourceHash }], get: () => ({ scope: { excluded: [] } }) } as unknown as SourceScopeStore
  const backend = { buildTree: async () => generation, readTree: async () => ({ schemaVersion: 1, kind: 'tree-page', generationId: generation.generationId, treeHash: generation.treeHash, total: 1, offset: 0, nextOffset: null, nodes: [node] }), abortAll: async () => {} } as unknown as ManagedDocumentBackend
  const model = new Proxy({}, { get: () => { throw new Error('Reading the map must never invoke a model') } }) as EnrichmentModelPort
  const service = new DocumentEnrichments(jobs, store, () => binding, () => backend, model), before = enrichmentHash(tree)
  try {
    const view = await service.tree(binding.conversationId, generation.documentId, generation.revisionId, 'merge', new AbortController().signal)
    expect(view.summaryPreviews).toEqual([{ nodeId: node.nodeId, jobId: latest.jobId, resultHash: latest.result!.resultHash, preview: [...latest.result!.nodes[0]!.summary!].slice(0, 240).join(''), summaryKind: 'model', truncated: true }])
    expect([...view.summaryPreviews[0]!.preview]).toHaveLength(240); expect(enrichmentHash(tree)).toBe(before); expect(view.generation.treeHash).toBe(before)
    revoked = true
    await expect(service.tree(binding.conversationId, generation.documentId, generation.revisionId, 'merge', new AbortController().signal)).rejects.toThrow('not authorized')
  } finally { await service.close() }
})
