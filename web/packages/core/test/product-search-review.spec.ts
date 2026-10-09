import { describe, expect, it, vi } from 'vitest'
import type { ProductSearchRequest, ScopedSourceIdentity, SearchCandidate, SearchResult, TreeGeneration, TreePage } from '@docatlas/contracts'
import { ProductSearch, mergeSearchCandidates, type ProductSearchPorts } from '../src/document/product-search.js'
import { DocumentOperations, type DocumentOperationsPort } from '../src/document/operations.js'
import type { DocumentInvocation, DocumentSession } from '../src/document/session.js'
import { bindDocAtlasSourceScope } from '../src/document/source-scope.js'

const source: ScopedSourceIdentity = { documentId: 'doc:review', revisionId: 'rev:review', representationId: 'rep:review', representationContentHash: 'a'.repeat(64) }
const request = (strategy: ProductSearchRequest['strategy'] = 'tree'): ProductSearchRequest => ({ schemaVersion: 1, kind: 'product-search-request', recipe: 'tree-search.v1', query: 'Revenue', strategy, limits: { maxItems: 10, maxChars: 6000 } })
const node = (index: number): TreePage['nodes'][number] => ({ nodeId: `tree:review:n${index}`, parentId: null, title: `Section ${index}`, startPage: 1, endPage: 2, sourceNodeId: null, keyItems: ['Revenue'] })
const candidate = (index: number, preview = 'Revenue'): SearchCandidate => ({ candidateId: `candidate:review:${index}`, documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId, physicalPageStart: 1, physicalPageEnd: 1,
  blockIds: [`block:${index}`], title: 'Revenue', preview, reason: 'Keyword match', matchKind: 'lexical' })
function fixture(overrides: Partial<ProductSearchPorts> = {}, sourceCount = 1) {
  let hash = 'b'.repeat(64), current = true, clock = 1000
  const sources = Array.from({ length: sourceCount }, (_, index) => index ? { ...source, documentId: `doc:review:${index}` } : source)
  const active: DocumentInvocation = { submissionId: 'submission:review',
    scope: bindDocAtlasSourceScope({ schemaVersion: 1, scopeVersionId: 'scope:review', workspaceId: 'workspace:review', investigationId: 'investigation:review', version: 1,
      included: sources.map(item => ({ documentId: item.documentId, revisionId: item.revisionId, role: 'primary' })), excluded: [], locked: true,
      createdBy: { kind: 'user', actorId: 'actor:review' }, createdAt: '2026-10-09T00:00:00Z' }, sources),
    assertCurrent() { if (!current) throw new Error('Revoked source frame') }, source: () => source, originalHash: () => hash,
  }
  const page: TreePage = { schemaVersion: 1, kind: 'tree-page', generationId: 'tree:review', treeHash: 'c'.repeat(64), offset: 0, total: 2, nextOffset: null, nodes: [node(0), node(1)] }
  const lexicalResult: SearchResult = { schemaVersion: 1, resultType: 'search', scopeVersionId: 'scope:review', queryHash: 'd'.repeat(64), candidates: [candidate(0)],
    pageInfo: { schemaVersion: 1, limit: 100, returned: 1, usedChars: 7, truncated: false, completeness: 'candidate' } }
  const lexical = vi.fn(async () => structuredClone(lexicalResult)), tree = vi.fn(async () => structuredClone(page))
  const complete = vi.fn(async () => ({ text: JSON.stringify({ schemaVersion: 1, kind: 'tree-search-selection', nodes: [{ key: 'n0', reason: 'relevant' }, { key: 'n1', reason: 'also relevant' }] }), inputTokens: 100, outputTokens: 30 }))
  const model = { identity: { provider: 'test', model: 'review' }, complete }
  const ports: ProductSearchPorts = { invocation: () => active, lexical, tree, model: () => model, ...overrides }
  return { search: new ProductSearch(ports, () => clock), active, page, lexicalResult, lexical, tree, model, complete,
    changeOriginal: () => { hash = 'f'.repeat(64) }, revoke: () => { current = false }, advance: (ms: number) => { clock += ms } }
}

describe('review regressions: bounded search pages and immutable navigation', () => {
  it('preserves combined retrieval and typed planner errors through the built public Core port', async () => {
    const built = await import('@docatlas/core'), f = fixture()
    const search = new built.ProductSearch({ invocation: () => f.active, lexical: f.lexical, tree: f.tree, model: () => f.model })
    const value = await search.search(request('combined'))
    expect(value.result.candidates.map(item => item.matchKind)).toEqual(['lexical', 'tree', 'tree'])
    expect(value.result.candidates[0]!.score).toBeGreaterThan(value.result.candidates[1]!.score!)
    expect(value.searchExecution.strategies).toEqual(['fts', 'tree'])
    f.complete.mockResolvedValueOnce({ text: 'invalid planner JSON', inputTokens: 1, outputTokens: 1 })
    const failed = search.search(request())
    await expect(failed).rejects.toBeInstanceOf(built.DocumentAccessError)
    await expect(failed).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('rejects whitespace queries and another valid contract operation before retrieval', async () => {
    const f = fixture()
    await expect(f.search.search({ ...request(), query: '   ' })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(f.search.search({ schemaVersion: 1, kind: 'tree-search-selection', nodes: [] } as unknown as ProductSearchRequest)).rejects.toMatchObject({ code: 'invalid-request' })
    expect(f.tree).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled()
  })

  it('checks the source-count cap before starting either route', async () => {
    const f = fixture({}, 17)
    await expect(f.search.search(request('combined'))).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.lexical).not.toHaveBeenCalled(); expect(f.tree).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled()
  })

  it('advances across legitimate empty previews without returning a zero-progress cursor', async () => {
    const f = fixture()
    f.lexicalResult.candidates = [candidate(0, ''), candidate(1)]
    f.lexicalResult.pageInfo.returned = 2
    const input = { ...request('fts'), limits: { maxItems: 1, maxChars: 20 } }
    const first = await f.search.search(input)
    expect(first.result.candidates).toHaveLength(1)
    expect(first.result.candidates[0]!.preview).toBe('')
    const second = await f.search.search({ ...input, cursor: first.result.pageInfo.nextCursor! })
    expect(second.result.candidates[0]!.candidateId).toBe('candidate:review:1')
    expect(second.result.pageInfo.nextCursor).toBeUndefined()
    expect(f.lexical).toHaveBeenCalledTimes(1)
  })

  it('reports a clipped final preview as partial without fabricating a cursor and counts Unicode scalar characters', async () => {
    const f = fixture()
    f.lexicalResult.candidates = [candidate(0, '😀Revenue')]
    f.lexicalResult.pageInfo.usedChars = 8
    const value = await f.search.search({ ...request('fts'), limits: { maxItems: 1, maxChars: 1 } })
    expect(value.result.candidates[0]!.preview).toBe('😀')
    expect(value.result.pageInfo).toMatchObject({ returned: 1, usedChars: 1, truncated: false, completeness: 'partial' })
    expect(value.result.pageInfo.nextCursor).toBeUndefined()
  })

  it.each(['ascii', 'unicode'] as const)('bounds the entire %s tool response, then pages all candidates without another retrieval', async alphabet => {
    const f = fixture(), text = alphabet === 'ascii' ? 'x' : '😀'
    f.lexicalResult.candidates = Array.from({ length: 30 }, (_, i) => ({ ...candidate(i, text.repeat(100)), title: text.repeat(1000), reason: text.repeat(1000),
      blockIds: Array.from({ length: 64 }, (_, j) => `block:${String(j).padStart(3, '0')}:${'x'.repeat(110)}`) }))
    f.lexicalResult.pageInfo.returned = 30; f.lexicalResult.pageInfo.usedChars = 3000
    const input = { ...request('fts'), limits: { maxItems: 30, maxChars: 20000 } }, seen: string[] = []
    let cursor: string | undefined
    do {
      const value = await f.search.search({ ...input, ...(cursor ? { cursor } : {}) })
      const serialized = JSON.stringify({ ...value.result, searchExecution: value.searchExecution })
      expect(serialized.length).toBeLessThanOrEqual(30000)
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(65536)
      expect(value.result.candidates.length).toBeGreaterThan(0)
      seen.push(...value.result.candidates.map(item => item.candidateId))
      cursor = value.result.pageInfo.nextCursor
      if (seen.length > 30) throw new Error('Search cursor did not advance')
    } while (cursor)
    expect(seen).toEqual(f.lexicalResult.candidates.map(item => item.candidateId))
    expect(f.lexical).toHaveBeenCalledTimes(1); expect(f.complete).not.toHaveBeenCalled()
  })

  it('rejects original-PDF hash changes during model work even if the representation frame is unchanged', async () => {
    const f = fixture()
    f.complete.mockImplementationOnce(async () => { f.changeOriginal(); return { text: '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[]}', inputTokens: 1, outputTokens: 1 } })
    await expect(f.search.search(request())).rejects.toMatchObject({ code: 'stale' })
  })

  it('marks a bounded tree catalogue partial without inventing a continuation beyond its snapshot', async () => {
    const tree = vi.fn(async (_source: ScopedSourceIdentity, offset: number, limit: number): Promise<TreePage> => ({ schemaVersion: 1, kind: 'tree-page', generationId: 'tree:review', treeHash: 'c'.repeat(64),
      offset, total: 257, nextOffset: offset + limit, nodes: Array.from({ length: limit }, (_, index) => node(offset + index)) }))
    const f = fixture({ tree }), value = await f.search.search(request())
    expect(tree).toHaveBeenCalledTimes(4)
    expect(value.searchExecution).toMatchObject({ catalogTruncated: true, nodesConsidered: 256 })
    expect(value.result.pageInfo).toMatchObject({ truncated: false, completeness: 'partial' })
    expect(value.result.pageInfo.nextCursor).toBeUndefined()
    expect(f.complete).toHaveBeenCalledTimes(1)
  })

  it('does not leak a backend lexical cursor or claim a bounded result is complete', async () => {
    const f = fixture()
    f.lexicalResult.pageInfo.truncated = true; f.lexicalResult.pageInfo.nextCursor = 'lexical:private:cursor'
    const value = await f.search.search(request('combined'))
    expect(value.result.pageInfo).toMatchObject({ truncated: false, completeness: 'partial' })
    expect(value.result.pageInfo.nextCursor).toBeUndefined()
    expect(JSON.stringify(value)).not.toContain('lexical:private:cursor')
    expect(f.complete).toHaveBeenCalledTimes(1)
  })

  it('bounds the complete multi-source planner input before any model call', async () => {
    const tree = async (_source: ScopedSourceIdentity, offset: number, limit: number): Promise<TreePage> => ({ schemaVersion: 1, kind: 'tree-page', generationId: 'tree:review', treeHash: 'c'.repeat(64),
      offset, total: 256, nextOffset: offset + limit < 256 ? offset + limit : null,
      nodes: Array.from({ length: limit }, (_, index) => ({ ...node(offset + index), title: 't'.repeat(240), keyItems: ['k'.repeat(160), 'v'.repeat(160), 'w'.repeat(160)] })) })
    const f = fixture({ tree }, 2)
    await expect(f.search.search(request())).rejects.toMatchObject({ code: 'invalid-request' })
    expect(f.complete).not.toHaveBeenCalled()
  })

  it.each(['offset', 'window-size', 'foreign-node', 'page-zero', 'page-order', 'next-offset', 'empty-window'] as const)('rejects an inconsistent tree catalogue: %s', async kind => {
    const f = fixture()
    if (kind === 'offset') f.page.offset = 1
    if (kind === 'window-size') f.page.nodes = Array.from({ length: 65 }, (_, i) => node(i))
    if (kind === 'foreign-node') f.page.nodes[0]!.nodeId = 'tree:other:n0'
    if (kind === 'page-zero') f.page.nodes[0]!.startPage = 0
    if (kind === 'page-order') f.page.nodes[0]!.endPage = 0
    if (kind === 'next-offset') f.page.nextOffset = 1
    if (kind === 'empty-window') { f.page.nodes = []; f.page.nextOffset = 1 }
    await expect(f.search.search(request())).rejects.toMatchObject({ code: 'invalid-output' })
    expect(f.complete).not.toHaveBeenCalled()
  })

  it.each(['generation', 'hash', 'total', 'duplicate'] as const)('rejects a second catalogue page that changes %s', async kind => {
    const f = fixture(), first = { ...f.page, total: 3, nextOffset: 2 }
    const second = { ...f.page, offset: 2, total: 3, nodes: [node(2)] }
    if (kind === 'generation') second.generationId = 'tree:changed'
    if (kind === 'hash') second.treeHash = 'f'.repeat(64)
    if (kind === 'total') second.total = 4
    if (kind === 'duplicate') second.nodes = [node(0)]
    f.tree.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await expect(f.search.search(request())).rejects.toMatchObject({ code: kind === 'duplicate' ? 'invalid-output' : 'stale' })
    expect(f.complete).not.toHaveBeenCalled()
  })

  it.each(['duplicate', 'oversized', 'different-hash'] as const)('rejects an invalid completed summary: %s', async kind => {
    const summary = { jobId: 'job:summary', resultHash: 'e'.repeat(64), baseGenerationId: 'tree:review', baseTreeHash: 'c'.repeat(64), nodes: [{ nodeId: 'tree:review:n0', summary: 'Navigation only' }] }
    if (kind === 'duplicate') summary.nodes.push({ ...summary.nodes[0]! })
    if (kind === 'oversized') summary.nodes = Array.from({ length: 51 }, (_, i) => ({ nodeId: `tree:review:n${i}`, summary: 'Navigation only' }))
    if (kind === 'different-hash') summary.baseTreeHash = 'f'.repeat(64)
    const f = fixture({ summaries: async () => summary })
    await expect(f.search.search(request())).rejects.toMatchObject({ code: 'invalid-output' })
    expect(f.complete).not.toHaveBeenCalled()
  })

  it.each([undefined, { jobId: 'job:summary', resultHash: 'e'.repeat(64), baseGenerationId: 'tree:review', baseTreeHash: 'c'.repeat(64),
    nodes: [{ nodeId: 'tree:review:n0', summary: '   ' }, { nodeId: 'expanded:other', summary: 'Not this raw node' }] }])('does not invent summary provenance when no usable excerpt exists', async summary => {
    const f = fixture({ summaries: async () => summary }), value = await f.search.search(request())
    expect(value.searchExecution.summaryRefs).toEqual([])
    expect(f.complete).toHaveBeenCalledTimes(1)
  })

  it('accepts a valid empty planner selection without claiming evidence or a next page', async () => {
    const f = fixture(); f.complete.mockResolvedValueOnce({ text: '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[]}', inputTokens: 1, outputTokens: 1 })
    const value = await f.search.search(request())
    expect(value.result.candidates).toEqual([]); expect(value.searchExecution.treeRefs).toEqual([])
    expect(value.result.pageInfo).toMatchObject({ returned: 0, truncated: false, completeness: 'candidate' })
    expect(value.result.pageInfo.nextCursor).toBeUndefined()
  })

  it('uses the verified title for a node without key items', async () => {
    const f = fixture(); f.page.nodes[0]!.keyItems = []
    const value = await f.search.search(request())
    expect(value.result.candidates[0]!.preview).toBe(f.page.nodes[0]!.title)
  })

  it('orders equal route scores by opaque identity independently of input order', () => {
    const first = { ...candidate(0), candidateId: 'candidate:a', physicalPageStart: 3, physicalPageEnd: 3 }
    const last = { ...candidate(1), candidateId: 'candidate:z', matchKind: 'tree' as const }
    expect(mergeSearchCandidates([first], [last]).map(item => item.candidateId)).toEqual(['candidate:a', 'candidate:z'])
    expect(mergeSearchCandidates([last], [first]).map(item => item.candidateId)).toEqual(['candidate:a', 'candidate:z'])
  })

  it('rejects a single oversized candidate without returning a dead cursor', async () => {
    const f = fixture(); f.lexicalResult.candidates[0]!.title = 'x'.repeat(30001)
    await expect(f.search.search(request('fts'))).rejects.toMatchObject({ code: 'invalid-output' })
    expect(f.complete).not.toHaveBeenCalled()
  })

  it('continues after exhausting only the preview budget without rerunning retrieval', async () => {
    const f = fixture(); f.lexicalResult.candidates = [candidate(0, 'a'), candidate(1, 'b')]
    f.lexicalResult.pageInfo.returned = 2; f.lexicalResult.pageInfo.usedChars = 2
    const input = { ...request('fts'), limits: { maxItems: 10, maxChars: 1 } }, first = await f.search.search(input)
    const second = await f.search.search({ ...input, cursor: first.result.pageInfo.nextCursor! })
    expect(first.result.candidates[0]!.preview).toBe('a'); expect(second.result.candidates[0]!.preview).toBe('b')
    expect(second.result.pageInfo.nextCursor).toBeUndefined(); expect(f.lexical).toHaveBeenCalledTimes(1)
  })

  it('independently enforces the scalar-output cap below the UTF-16 fast bound', async () => {
    const f = fixture(); f.complete.mockResolvedValueOnce({ text: 'x'.repeat(12001), inputTokens: 1, outputTokens: 1 })
    await expect(f.search.search(request())).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it.each(['not json', '```json\n{}\n```', '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[{"key":"n0","reason":"ok","pages":[99]}]}'])('classifies invalid planner text as invalid-output, not a provider outage: %s', async text => {
    const f = fixture(); f.complete.mockResolvedValueOnce({ text, inputTokens: 1, outputTokens: 1 })
    await expect(f.search.search(request())).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('never reruns retrieval for malformed, out-of-range or changed-budget cursors', async () => {
    const f = fixture(), input = { ...request(), limits: { maxItems: 1, maxChars: 100 } }, first = await f.search.search(input)
    for (const cursor of ['not-a-cursor', first.result.pageInfo.nextCursor!.replace(/:1$/, ':9999')]) await expect(f.search.search({ ...input, cursor })).rejects.toThrow()
    await expect(f.search.search({ ...input, limits: { maxItems: 2, maxChars: 100 }, cursor: first.result.pageInfo.nextCursor! })).rejects.toThrow()
    expect(f.complete).toHaveBeenCalledTimes(1)
  })

  it('evicts old snapshots at the fixed bound without rerunning an evicted search', async () => {
    const f = fixture(), input = { ...request(), limits: { maxItems: 1, maxChars: 100 } }, first = await f.search.search(input)
    for (let i = 0; i < 16; i++) await f.search.search({ ...input, query: `Question ${i}` })
    await expect(f.search.search({ ...input, cursor: first.result.pageInfo.nextCursor! })).rejects.toThrow('cursor')
    expect(f.complete).toHaveBeenCalledTimes(17)
  })

  it('joins a real pending model promise after the whole-operation deadline before rejecting', async () => {
    vi.useFakeTimers()
    try {
      const pending = Promise.withResolvers<{ text: string, inputTokens: number, outputTokens: number }>(), started = Promise.withResolvers<AbortSignal>()
      const f = fixture({ model: () => ({ identity: { provider: 'test', model: 'deadline' }, complete: async (_prompt, _limits, signal) => { started.resolve(signal); return pending.promise } }) })
      let settled = false
      const result = f.search.search(request()).finally(() => { settled = true }), rejection = expect(result).rejects.toThrow('budget')
      const signal = await started.promise
      await vi.advanceTimersByTimeAsync(60000)
      expect(signal.aborted).toBe(true); expect(settled).toBe(false)
      pending.resolve({ text: '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[]}', inputTokens: 1, outputTokens: 1 })
      await rejection
    } finally { vi.useRealTimers() }
  })

  it('cancels before any retrieval and rejects revocation on a cached page', async () => {
    const f = fixture(), abort = AbortSignal.abort(new Error('Already cancelled'))
    await expect(f.search.search(request(), abort)).rejects.toThrow('Already cancelled')
    expect(f.tree).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled()
    const input = { ...request(), limits: { maxItems: 1, maxChars: 100 } }, first = await f.search.search(input)
    f.revoke(); await expect(f.search.search({ ...input, cursor: first.result.pageInfo.nextCursor! })).rejects.toThrow('Revoked')
    expect(f.complete).toHaveBeenCalledTimes(1)
  })
})

it('rejects a tree node beyond the exact original PDF page count before a Search or navigation result is returned', async () => {
  const f = fixture(), generationId = `tree:${'c'.repeat(64)}`
  f.page.generationId = generationId; f.page.nodes = f.page.nodes.map((item, index) => ({ ...item, nodeId: `${generationId}:n${index}` }))
  const manifest: TreeGeneration = { schemaVersion: 1, kind: 'tree-generation', generationId, parentGenerationId: null,
    documentId: source.documentId, revisionId: source.revisionId, sourceHash: 'b'.repeat(64), config: { mode: 'raw', useEmbeddedToc: true, workers: 1 },
    provider: { name: 'pageindex-flash', version: 'review', sourceCommit: 'a'.repeat(40), fingerprint: 'e'.repeat(64) }, status: 'ready', pageCount: 2, nodeCount: 2,
    treeHash: f.page.treeHash, createdAt: '2026-10-09T00:00:00Z', tocSource: 'bookmarks', warnings: [],
    optimization: { mergeCount: 0, samePageMergeCount: 0, samePageDroppedCount: 0, rounds: 0, costBefore: 0, costAfter: 0 } }
  const unused = async (): Promise<never> => { throw new Error('Unrelated operation') }
  const backend: DocumentOperationsPort = { call: unused, visualAsset: unused, buildTree: async () => manifest, readTree: async () => f.page }
  const operations = new DocumentOperations({ invocation: () => f.active } as DocumentSession, backend)
  expect(await operations.tree(source.documentId, source.revisionId, 'raw', 0, 2)).toEqual(f.page)
  f.page.nodes[0]!.endPage = 99
  await expect(operations.tree(source.documentId, source.revisionId, 'raw', 0, 2)).rejects.toMatchObject({ code: 'invalid-output' })
})
