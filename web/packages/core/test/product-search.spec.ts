import { describe, expect, it, vi } from 'vitest'
import { ProductSearch, mergeSearchCandidates, type ProductSearchPorts } from '../src/document/product-search.js'
import { bindDocAtlasSourceScope } from '../src/document/source-scope.js'
import type { DocumentInvocation } from '../src/document/session.js'
import type { EnrichmentModelPort } from '../src/document/enrichment.js'
import type { ProductSearchRequest, ScopedSourceIdentity, SearchCandidate, SearchResult, TreePage } from '@docatlas/contracts'

const source: ScopedSourceIdentity = { documentId: 'doc:a', revisionId: 'rev:a', representationId: 'rep:a', representationContentHash: 'a'.repeat(64) }
const candidate = (id = 'candidate:lexical', other = source): SearchCandidate => ({ candidateId: id, documentId: other.documentId, revisionId: other.revisionId, representationId: other.representationId, physicalPageStart: 3, physicalPageEnd: 3,
  blockIds: ['block:3'], title: 'Exact original block', preview: 'Liquidity risk', matchKind: 'lexical', reason: 'FTS5 block match' })
const request = (strategy: ProductSearchRequest['strategy'] = 'tree'): ProductSearchRequest => ({ schemaVersion: 1, kind: 'product-search-request', recipe: 'tree-search.v1', query: 'What are the liquidity risks?', strategy, limits: { maxItems: 10, maxChars: 6000 } })
function fixture(overrides: Partial<ProductSearchPorts> = {}) {
  let valid = true, submissionId = 'submission:a', clock = 1000
  const check = () => { if (!valid) throw new Error('revoked') }
  const active = (): DocumentInvocation => ({ submissionId, assertCurrent: check, source: () => source, originalHash: () => 'b'.repeat(64),
    scope: bindDocAtlasSourceScope({ schemaVersion: 1, scopeVersionId: 'scope:a', workspaceId: 'workspace:a', investigationId: 'investigation:a', version: 1,
      included: [{ documentId: source.documentId, revisionId: source.revisionId, role: 'primary' }], excluded: [], locked: true,
      createdBy: { kind: 'user', actorId: 'actor:a' }, createdAt: '2026-10-09T00:00:00Z' }, [source]) })
  const page: TreePage = { schemaVersion: 1, kind: 'tree-page', generationId: 'generation:a', treeHash: 'c'.repeat(64), offset: 0, total: 2, nextOffset: null,
    nodes: [1, 2].map(index => ({ nodeId: `generation:a:node${index}`, parentId: null, title: `Section ${index}`, startPage: index * 2, endPage: index * 2 + 1, sourceNodeId: null, keyItems: ['Liquidity risks'] })) }
  const lexical = vi.fn(async (): Promise<SearchResult> => ({ schemaVersion: 1, resultType: 'search', scopeVersionId: 'scope:a', queryHash: 'd'.repeat(64), candidates: [candidate()],
    pageInfo: { schemaVersion: 1, limit: 100, returned: 1, usedChars: 14, truncated: false, completeness: 'candidate' } }))
  const complete = vi.fn(async () => ({ text: JSON.stringify({ schemaVersion: 1, kind: 'tree-search-selection', nodes: [{ key: 'n0', reason: 'Liquidity chapter' }, { key: 'n1', reason: 'Funding chapter' }] }), inputTokens: 100, outputTokens: 60 }))
  const model: EnrichmentModelPort = { identity: { provider: 'test', model: 'tree' }, complete }
  const tree = vi.fn(async () => page)
  const search = new ProductSearch({ invocation: active, lexical, tree, model: () => model, ...overrides }, () => clock)
  return { search, page, lexical, tree, complete, model, revoke: () => { valid = false }, nextSubmission: () => { submissionId = 'submission:b' }, expire: () => { clock += 121000 } }
}

describe('explicit product tree search', () => {
  it('routes real catalogue keys to verified section pages, never invented block IDs or answers', async () => {
    const f = fixture(), result = await f.search.search(request())
    expect(f.lexical).not.toHaveBeenCalled(); expect(f.complete).toHaveBeenCalledTimes(1)
    expect(result.result.candidates).toHaveLength(2)
    expect(result.result.candidates[0]).toMatchObject({ documentId: source.documentId, physicalPageStart: 2, physicalPageEnd: 3, blockIds: [], matchKind: 'tree' })
    expect(result.searchExecution.treeRefs[0]).toMatchObject({ generationId: 'generation:a', treeHash: 'c'.repeat(64), sourceHash: 'b'.repeat(64), nodeId: 'generation:a:node1' })
    expect(result.searchExecution.strategies).toEqual(['tree'])
  })

  it('keeps FTS model-free even with the explicit product recipe', async () => {
    const f = fixture(), result = await f.search.search(request('fts'))
    expect(f.lexical).toHaveBeenCalledTimes(1); expect(f.complete).not.toHaveBeenCalled(); expect(f.tree).not.toHaveBeenCalled()
    expect(result.result.candidates[0]!.candidateId).toBe('candidate:lexical'); expect(result.searchExecution.model).toBeNull()
  })

  it('uses only matching completed summary excerpts and binds their sealed provenance', async () => {
    const summaries = vi.fn(async () => ({ jobId: 'job:ready', resultHash: 'e'.repeat(64), baseGenerationId: 'generation:a', baseTreeHash: 'c'.repeat(64),
      nodes: [{ nodeId: 'generation:a:node1', summary: 'Completed navigation summary: liquidity obligations' }, { nodeId: 'expanded:unmatched', summary: 'Must not attach this to another raw node' }] }))
    const f = fixture({ summaries })
    const value = await f.search.search(request())
    expect(summaries).toHaveBeenCalledTimes(1)
    const prompt = (f.complete.mock.calls[0] as unknown as [string])[0]
    expect(prompt).toContain('Completed navigation summary: liquidity obligations')
    expect(prompt).not.toContain('Must not attach this')
    expect(value.searchExecution.summaryRefs).toEqual([{ jobId: 'job:ready', resultHash: 'e'.repeat(64), baseGenerationId: 'generation:a', nodesUsed: 1 }])
    expect(f.complete).toHaveBeenCalledTimes(1)
  })

  it('rejects a different summary base before calling the model', async () => {
    const f = fixture({ summaries: async () => ({ jobId: 'job:other', resultHash: 'e'.repeat(64), baseGenerationId: 'generation:other', baseTreeHash: 'c'.repeat(64), nodes: [] }) })
    await expect(f.search.search(request())).rejects.toThrow('different tree generation')
    expect(f.complete).not.toHaveBeenCalled()
  })

  it('actually combines both routes, retaining original block and tree identities', async () => {
    const f = fixture(), result = await f.search.search(request('combined'))
    expect(f.lexical).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(1)
    expect(result.result.candidates.map(item => item.matchKind)).toEqual(['lexical', 'tree', 'tree'])
    expect(result.result.candidates[0]!.score).toBeGreaterThan(result.result.candidates[1]!.score!)
    expect(result.searchExecution.strategies).toEqual(['fts', 'tree'])
  })

  it('never boosts another revision merely because page numbers match', () => {
    const tree = { ...candidate('candidate:tree', { ...source, revisionId: 'rev:other' }), blockIds: [], matchKind: 'tree' as const }
    const result = mergeSearchCandidates([candidate()], [tree])
    expect(result.find(item => item.candidateId === 'candidate:lexical')!.score).toBe(1 / 61)
  })

  it.each(['unknown', 'duplicate', 'invented-page', 'other-operation'])('rejects planner %s output rather than upgrading metadata to authority', async kind => {
    const f = fixture()
    f.complete.mockResolvedValueOnce({ text: JSON.stringify(kind === 'other-operation' ? request() : { schemaVersion: 1, kind: 'tree-search-selection', nodes:
      kind === 'unknown' ? [{ key: 'n999', reason: 'invented' }] : kind === 'duplicate' ? [{ key: 'n0', reason: 'one' }, { key: 'n0', reason: 'two' }] : [{ key: 'n0', reason: 'one', physicalPage: 99 }] }), inputTokens: 1, outputTokens: 1 })
    await expect(f.search.search(request())).rejects.toThrow()
  })

  it('paginates the exact computed snapshot without another tree or model call', async () => {
    const f = fixture(), input = { ...request(), limits: { maxItems: 1, maxChars: 6000 } }, first = await f.search.search(input)
    const cursor = first.result.pageInfo.nextCursor!
    expect(cursor).toMatch(/^ps:/)
    const second = await f.search.search({ ...input, cursor })
    expect(second.result.candidates[0]!.candidateId).not.toBe(first.result.candidates[0]!.candidateId)
    expect(second.result.pageInfo.nextCursor).toBeUndefined(); expect(f.complete).toHaveBeenCalledTimes(1); expect(f.tree).toHaveBeenCalledTimes(1)
    await expect(f.search.search({ ...input, query: 'a different question', cursor })).rejects.toThrow(/cursor/)
    f.nextSubmission(); await expect(f.search.search({ ...input, cursor })).rejects.toThrow(/cursor/)
  })

  it('does not expose mutable cached tree provenance to a caller', async () => {
    const f = fixture(), input = { ...request(), limits: { maxItems: 1, maxChars: 6000 } }, first = await f.search.search(input)
    const original = structuredClone(first.searchExecution.treeRefs[0]!)
    first.searchExecution.treeRefs[0]!.nodeId = 'forged:node'
    const repeated = await f.search.search({ ...input, cursor: first.result.pageInfo.nextCursor!.replace(/:1$/, ':0') })
    expect(repeated.searchExecution.treeRefs[0]).toEqual(original)
    expect(f.complete).toHaveBeenCalledTimes(1)
  })

  it('keeps revisions distinct even when a provider reuses a generation and node key', async () => {
    const other = { ...source, revisionId: 'rev:b' }, sources = [source, other]
    const active: DocumentInvocation = { submissionId: 'submission:revisions', assertCurrent() {}, source: () => source, originalHash: () => 'b'.repeat(64),
      scope: bindDocAtlasSourceScope({ schemaVersion: 1, scopeVersionId: 'scope:revisions', workspaceId: 'workspace:a', investigationId: 'investigation:a', version: 1,
        included: sources.map(item => ({ documentId: item.documentId, revisionId: item.revisionId, role: 'primary' })), excluded: [], locked: true,
        createdBy: { kind: 'user', actorId: 'actor:a' }, createdAt: '2026-10-09T00:00:00Z' }, sources) }
    const f = fixture({ invocation: () => active })
    f.complete.mockResolvedValueOnce({ text: '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[{"key":"n0","reason":"first"},{"key":"n2","reason":"second"}]}', inputTokens: 1, outputTokens: 1 })
    const value = await f.search.search(request())
    expect(new Set(value.result.candidates.map(item => item.candidateId)).size).toBe(2)
    expect(value.result.candidates.map(item => item.revisionId)).toEqual(['rev:a', 'rev:b'])
  })

  it('counts each retrieval route once instead of multiplying overlapping parent/child votes', () => {
    const first = { ...candidate('candidate:parent'), blockIds: [], matchKind: 'tree' as const, physicalPageStart: 1, physicalPageEnd: 10 }
    const second = { ...first, candidateId: 'candidate:child', physicalPageStart: 3, physicalPageEnd: 3 }
    expect(mergeSearchCandidates([candidate()], [first, second]).find(item => item.candidateId === 'candidate:lexical')!.score).toBe(2 / 61)
  })

  it('independently rejects oversized model output before JSON parsing', async () => {
    const f = fixture(); f.complete.mockResolvedValueOnce({ text: ' '.repeat(30000), inputTokens: 1, outputTokens: 1 })
    await expect(f.search.search(request())).rejects.toThrow('output budget')
  })

  it('does not revive expired snapshots or disclose them after revocation', async () => {
    const f = fixture(), input = { ...request(), limits: { maxItems: 1, maxChars: 6000 } }, first = await f.search.search(input)
    f.expire(); await expect(f.search.search({ ...input, cursor: first.result.pageInfo.nextCursor! })).rejects.toThrow(/cursor/)
    f.revoke(); await expect(f.search.search(request())).rejects.toThrow('revoked')
    expect(f.complete).toHaveBeenCalledTimes(1)
  })

  it('rechecks authorization after model work and does not cache a revoked result', async () => {
    const f = fixture()
    f.complete.mockImplementationOnce(async () => { f.revoke(); return { text: '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[]}', inputTokens: 1, outputTokens: 1 } })
    await expect(f.search.search(request())).rejects.toThrow('revoked')
  })

  it('reports empty/unconfigured trees as unavailable, not FTS-only successful combined search', async () => {
    const missing = fixture({ model: () => undefined }); await expect(missing.search.search(request())).rejects.toThrow(/host model/)
    const empty = fixture(); empty.page.nodes = []; empty.page.total = 0
    await expect(empty.search.search(request('combined'))).rejects.toThrow(/no usable tree/)
    expect(empty.complete).not.toHaveBeenCalled()
  })

  it('waits for the actual model rejection/settlement after abort', async () => {
    const pending = Promise.withResolvers<{ text: string, inputTokens: number, outputTokens: number }>(), started = Promise.withResolvers<AbortSignal>()
    const model: EnrichmentModelPort = { identity: { provider: 'test', model: 'joining' }, complete: async (_prompt, _limits, signal) => { started.resolve(signal); return pending.promise } }
    const f = fixture({ model: () => model }), controller = new AbortController()
    let settled = false
    const result = f.search.search(request(), controller.signal).finally(() => { settled = true })
    const rejection = expect(result).rejects.toThrow()
    const signal = await started.promise; controller.abort(); expect(signal.aborted).toBe(true)
    await Promise.resolve(); expect(settled).toBe(false)
    pending.resolve({ text: '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[]}', inputTokens: 1, outputTokens: 1 })
    await rejection
  })
})
