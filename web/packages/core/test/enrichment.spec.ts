import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { EnrichmentStart, TreeGeneration, TreeData } from '@docatlas/contracts'
import { enrichTree, enrichmentHash, expansionCost, type EnrichmentInput, type EnrichmentModelPort } from '../src/document/enrichment.js'

function fixture(mode: EnrichmentStart['mode'] = 'full') {
  const values = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document/tree-index.json', import.meta.url), 'utf8')) as { valid: Array<TreeGeneration | TreeData> }
  const generation = structuredClone(values.valid.find(value => value.kind === 'tree-generation')!) as TreeGeneration
  const tree = structuredClone(values.valid.find(value => value.kind === 'tree-data')!) as TreeData
  tree.pageCount = 8; tree.nodes = [{ ...tree.nodes[0]!, title: '完整报告', startPage: 1, endPage: 8 }]
  generation.pageCount = 8; generation.nodeCount = 1; generation.treeHash = enrichmentHash(tree)
  const input: EnrichmentInput = { generation, tree, source: { documentId: generation.documentId, revisionId: generation.revisionId, representationId: 'rep:text', representationContentHash: 'b'.repeat(64) },
    pages: Array.from({ length: 8 }, (_, index) => ({ page: index + 1, text: `${index === 0 ? '方法' : index === 4 ? '结果' : '普通正文'}\n${'This is a long source paragraph about the experiment. '.repeat(12)}` })) }
  const request: EnrichmentStart = { schemaVersion: 1, kind: 'enrichment-start', idempotencyKey: 'enrichment:core-case', documentId: generation.documentId, revisionId: generation.revisionId, nodeIds: [tree.nodes[0]!.nodeId], baseMode: 'raw', mode,
    budget: { maxNodes: 16, maxPages: 12, maxInputChars: 40000, maxModelCalls: 8, maxOutputTokens: 4096, maxOutputChars: 12000, wallMs: 60000 } }
  return { input, request }
}
function model(answers: string[]) {
  const prompts: string[] = []
  const port: EnrichmentModelPort = { identity: { provider: 'test', model: 'faux' }, async complete(prompt) {
    prompts.push(prompt); const text = answers[prompts.length - 1]; if (text === undefined) throw new Error('Unexpected model call'); return { text, inputTokens: 100, outputTokens: 50 }
  } }
  return { prompts, port }
}
it('expands only printed Unicode headings when cost improves, summarizes bottom-up, and preserves the base bytes', async () => {
  const { input, request } = fixture(), before = JSON.stringify(input), { port, prompts } = model(['{"subsections":[{"title":"方法","page":1},{"title":"结果","page":5}]}', '{"summary":"方法介绍"}', '{"summary":"结果介绍"}', '{"summary":"完整报告导航"}'])
  const result = await enrichTree(request, input, 'job:test', port, () => {}, new AbortController().signal)
  expect(result.nodes).toHaveLength(3); expect(result.nodes[0]!.summary).toBe('完整报告导航')
  expect(result.nodes[1]).toMatchObject({ title: '方法', startPage: 1, endPage: 5, parentId: input.tree.nodes[0]!.nodeId })
  expect(result.nodes[2]).toMatchObject({ title: '结果', startPage: 5, endPage: 8 })
  expect(result.decisions).toEqual([{ nodeId: input.tree.nodes[0]!.nodeId, decision: 'expanded', costBefore: 8, costAfter: 6 }])
  expect(prompts[3]).toContain('方法介绍'); expect(prompts[3]).toContain('结果介绍'); expect(result.usage.calls).toBe(4)
  expect(result.navigationOnly).toBe(true); expect(JSON.stringify(input)).toBe(before)
  const { resultHash, ...unsigned } = result; expect(enrichmentHash(unsigned)).toBe(resultHash)
})
it('keeps collapsed empty/no-gain expansion and rejects fabricated headings and malformed JSON', async () => {
  const { input, request } = fixture('expand')
  const empty = await enrichTree(request, input, 'job:empty', model(['{"subsections":[]}']).port, () => {}, new AbortController().signal)
  expect(empty.decisions[0]).toMatchObject({ decision: 'kept-collapsed', costAfter: 8 }); expect(empty.nodes).toHaveLength(1)
  for (const answer of ['{"subsections":[{"title":"编造标题","page":1}]}', '{"subsections":[{"title":"方法","page":7}]}', '```json\n{"subsections":[]}\n```']) {
    await expect(enrichTree(request, input, 'job:bad', model([answer]).port, () => {}, new AbortController().signal)).rejects.toThrow()
  }
})
it('enforces aggregate budgets, source seals, cancellation and zero-model short-leaf reuse', async () => {
  const { input, request } = fixture('summary')
  const constrained = { ...request, budget: { ...request.budget, maxInputChars: 1000 } }, unused = model([])
  await expect(enrichTree(constrained, input, 'job:budget', unused.port, () => {}, new AbortController().signal)).rejects.toThrow('budget')
  expect(unused.prompts).toHaveLength(0)
  const tampered = structuredClone(input); tampered.tree.nodes[0]!.title = 'changed'
  await expect(enrichTree(request, tampered, 'job:tamper', unused.port, () => {}, new AbortController().signal)).rejects.toThrow('seal')
  const cancelled = new AbortController(); cancelled.abort()
  await expect(enrichTree(request, input, 'job:cancel', unused.port, () => {}, cancelled.signal)).rejects.toThrow()
  for (const page of input.pages) page.text = 'short'
  const small = await enrichTree(request, input, 'job:small', unused.port, () => {}, new AbortController().signal)
  expect(small.usage.calls).toBe(0); expect(small.nodes[0]!.summaryKind).toBe('source-excerpt')
})
it('matches Flash routing-plus-worst-scan page cost including residual and overlapping boundary pages', () => {
  expect(expansionCost(1, 12, [{ startPage: 3, endPage: 7 }, { startPage: 7, endPage: 12 }])).toBe(7)
  expect(expansionCost(1, 6, [{ startPage: 1, endPage: 6 }])).toBe(7)
  expect(expansionCost(1, 10, [{ startPage: 7, endPage: 8 }])).toBe(9)
})
