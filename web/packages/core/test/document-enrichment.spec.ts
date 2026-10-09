import { expect, it, vi } from 'vitest'
import type { EnrichmentResult, ScopedSourceIdentity } from '@docatlas/contracts'
import { DocumentOperations, type DocumentEnrichmentPort, type DocumentOperationsPort } from '../src/document/operations.js'
import { DocumentSession, type DocumentInvocation } from '../src/document/session.js'
import { enrichmentHash } from '../src/document/enrichment.js'
import { bindDocAtlasSourceScope } from '../src/document/source-scope.js'

const source: ScopedSourceIdentity = { documentId: 'doc:one', revisionId: 'rev:one', representationId: 'rep:one', representationContentHash: 'a'.repeat(64) }
function fixture() {
  let current = true, originalHash = 'b'.repeat(64)
  const assertCurrent = vi.fn(() => { if (!current) throw new Error('source frame changed') })
  const active: DocumentInvocation = { submissionId: 'submission:one', scope: bindDocAtlasSourceScope({
    schemaVersion: 1, scopeVersionId: 'scope:one', workspaceId: 'workspace:one', investigationId: 'investigation:one', version: 1,
    included: [{ documentId: source.documentId, revisionId: source.revisionId, role: 'primary' }], excluded: [], locked: true,
    createdBy: { kind: 'user', actorId: 'actor:one' }, createdAt: '2026-09-09T00:00:00Z',
  }, [source]), assertCurrent,
    source: (documentId: string, revisionId?: string) => { assertCurrent(); if (documentId !== source.documentId || revisionId && revisionId !== source.revisionId) throw new Error('source not active'); return source },
    originalHash: () => { assertCurrent(); return originalHash },
  }
  const session = { invocation: () => { assertCurrent(); return active } } as DocumentSession
  const result: EnrichmentResult = { schemaVersion: 1, kind: 'tree-enrichment', enrichmentId: 'enrichment:one', baseGenerationId: 'tree:one', baseTreeHash: 'c'.repeat(64), documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId,
    sourceHash: 'b'.repeat(64), representationHash: source.representationContentHash, recipe: 'docatlas-flash-enrichment.v1', navigationOnly: true,
    inputHash: 'd'.repeat(64), resultHash: 'e'.repeat(64), provider: { provider: 'test', model: 'fixture' }, upstreamCommit: 'ae169566b3148792776531d987f543edcad92321',
    nodes: Array.from({ length: 3 }, (_, i) => ({ nodeId: `tree:one:n${i}`, parentId: null, title: `Section ${i}`, startPage: i + 1, endPage: i + 1, sourceNodeId: null, keyItems: [], summary: '文档导航😀'.repeat(40), summaryKind: 'model' as const })),
    usage: { calls: 3, inputChars: 2000, outputChars: 900, inputTokens: 300, outputTokens: 100 }, decisions: [],
  }
  const { resultHash: _ignored, ...unsigned } = result; result.resultHash = enrichmentHash(unsigned)
  const descriptor = { jobId: 'job:one', enrichmentId: result.enrichmentId, baseGenerationId: result.baseGenerationId, baseTreeHash: result.baseTreeHash, mode: 'summary' as const, nodeCount: 3, resultHash: result.resultHash }
  const port: DocumentEnrichmentPort = { list: vi.fn(async () => [descriptor]), get: vi.fn(async () => structuredClone(result)) }
  const unused = vi.fn(async () => { throw new Error('Navigation must not call backend/model') })
  const backend: DocumentOperationsPort = { call: unused, visualAsset: unused, buildTree: unused, readTree: unused }
  return { operations: new DocumentOperations(session, backend, port), result, port, unused, assertCurrent, invalidate: () => { current = false }, changeOriginal: () => { originalHash = 'f'.repeat(64) } }
}

it('lists only navigation descriptors and pages complete overlay nodes within a whole-result character budget', async () => {
  const { operations, result, unused } = fixture()
  const list = await operations.enrichment(source.documentId, undefined, undefined, 0, 10, 12000)
  expect(list).toMatchObject({ kind: 'enrichment-list', scopeVersionId: 'scope:one', total: 1, nextOffset: null, navigationOnly: true })
  const first = await operations.enrichment(source.documentId, undefined, 'job:one', 0, 1, 12000)
  const budget = Math.max(1024, JSON.stringify(first).length)
  const bounded = await operations.enrichment(source.documentId, undefined, 'job:one', 0, 3, budget)
  expect(bounded).toEqual(first); expect(bounded.kind === 'enrichment-page' && bounded.nodes[0]).toEqual(result.nodes[0])
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(budget)
  const next = await operations.enrichment(source.documentId, undefined, 'job:one', 1, 3, 12000)
  expect(next).toMatchObject({ offset: 1, total: 3, nextOffset: null, resultHash: result.resultHash, nodes: result.nodes.slice(1) })
  expect(unused).not.toHaveBeenCalled()
})

it('rejects invalid windows, inactive revisions, undersized single-node budgets and modified source/result seals', async () => {
  const { operations, port, result } = fixture()
  for (const args of [[-1, 1, 12000], [257, 1, 12000], [0, 0, 12000], [0, 51, 12000], [0, 1, 1023], [0, 1, 20001], [4, 1, 12000]]) {
    await expect(operations.enrichment(source.documentId, undefined, 'job:one', args[0]!, args[1]!, args[2]!)).rejects.toThrow()
  }
  await expect(operations.enrichment(source.documentId, 'rev:other', 'job:one', 0, 1, 12000)).rejects.toThrow('not active')
  await expect(operations.enrichment(source.documentId, undefined, 'job:one', 0, 1, 1024)).rejects.toThrow('budget')
  for (const patch of [{ sourceHash: 'f'.repeat(64) }, { representationHash: 'f'.repeat(64) }, { resultHash: 'f'.repeat(64) }]) {
    port.get = async () => ({ ...result, ...patch })
    await expect(operations.enrichment(source.documentId, undefined, 'job:one', 0, 1, 12000)).rejects.toThrow('validation')
  }
})

it('rechecks the exact active invocation and cancellation after asynchronous navigation lookup', async () => {
  const first = fixture()
  first.port.get = async () => { first.invalidate(); return first.result }
  await expect(first.operations.enrichment(source.documentId, undefined, 'job:one', 0, 1, 12000)).rejects.toThrow('frame changed')
  const second = fixture(), controller = new AbortController()
  second.port.list = async () => { controller.abort(new Error('cancelled navigation')); return [] }
  await expect(second.operations.enrichment(source.documentId, undefined, undefined, 0, 1, 12000, controller.signal)).rejects.toThrow('cancelled navigation')
  const third = fixture()
  third.port.get = async () => { third.changeOriginal(); return third.result }
  await expect(third.operations.enrichment(source.documentId, undefined, 'job:one', 0, 1, 12000)).rejects.toThrow('Original PDF changed')
})
