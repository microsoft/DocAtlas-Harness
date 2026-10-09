import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { EnrichmentJob, EnrichmentResult, EnrichmentStart, EnrichmentTree, TreeSummaryPreview } from '@docatlas/contracts'
import { checkedNodeSummary, verifiedNodeSummary, parseMapSummaryOutbox, MAP_SUMMARY_BUDGET, type SummaryOutbox } from '../src/live/MapNodeSummary'
import { canonicalHash } from '../src/live/state'
import { PassageText } from '../src/live/QuestionContext'
import { UiLocaleProvider } from '../src/live/locale'

const bases = JSON.parse(readFileSync('contracts/fixtures/document/enrichment.json', 'utf8')).bases as { result: EnrichmentResult, request: EnrichmentStart, tree: EnrichmentTree }
const result = bases.result, node = result.nodes[0]!, generation = { ...bases.tree.generation, generationId: result.baseGenerationId, treeHash: result.baseTreeHash }
const source = { id: 'pdf:one', name: 'Original.pdf', kind: 'server' as const, bytes: 1024, pages: 6, url: '/original', sha256: result.sourceHash, serverRevision: { documentId: result.documentId, revisionId: result.revisionId } }
const job: EnrichmentJob = { schemaVersion: 1, kind: 'enrichment-job', jobId: 'job:summary', conversationId: 'conversation:one', bindingId: 'binding:one', runtimeSessionId: 'pi:one', actorId: 'actor:one', workspaceId: 'workspace:one', generation: 1,
  request: bases.request, state: 'completed', createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z', result, error: null }
const preview: TreeSummaryPreview = { nodeId: node.nodeId, jobId: job.jobId, resultHash: result.resultHash, preview: [...node.summary!].slice(0, 240).join(''), summaryKind: node.summaryKind!, truncated: [...node.summary!].length > 240 }
const differentHash = (hash: string) => `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`
it('uses only the same original, tree generation, node and sealed full summary', async () => {
  expect(checkedNodeSummary(source, generation, node, job, preview)).toBe(node.summary)
  const sealed = structuredClone(job), { resultHash: _old, ...unsigned } = sealed.result!
  sealed.result!.resultHash = await canonicalHash(unsigned)
  expect(await verifiedNodeSummary(source, generation, node, sealed)).toBe(node.summary)
  sealed.result!.nodes[0]!.summary += ' altered tail'
  await expect(verifiedNodeSummary(source, generation, node, sealed)).rejects.toThrow('seal')
  for (const value of [{ ...preview, jobId: 'job:foreign' }, { ...preview, resultHash: differentHash(preview.resultHash) }, { ...preview, preview: 'unrelated' }, { ...preview, truncated: !preview.truncated }]) expect(() => checkedNodeSummary(source, generation, node, job, value)).toThrow()
  expect(() => checkedNodeSummary({ ...source, sha256: differentHash(source.sha256) }, generation, node, job)).toThrow()
  expect(() => checkedNodeSummary(source, { ...generation, treeHash: differentHash(generation.treeHash) }, node, job)).toThrow()
  expect(() => checkedNodeSummary(source, generation, { ...node, endPage: node.endPage + 1 }, job)).toThrow()
})
it('restores the exact original summary request but refuses a changed source, node, recipe or budget', () => {
  const pending: SummaryOutbox = { generationId: generation.generationId, treeHash: generation.treeHash, jobId: null,
    request: { ...bases.request, documentId: source.serverRevision.documentId, revisionId: source.serverRevision.revisionId, mode: 'summary', baseMode: 'merge', nodeIds: [node.nodeId], recipe: 'docatlas-flash-enrichment.v2', budget: { ...MAP_SUMMARY_BUDGET } } }
  expect(parseMapSummaryOutbox(JSON.stringify(pending), source, generation, node)).toEqual(pending)
  for (const change of [
    (value: SummaryOutbox) => { value.request.budget.maxModelCalls = 64 },
    (value: SummaryOutbox) => { value.request.revisionId = 'revision:other' },
    (value: SummaryOutbox) => { value.request.nodeIds = ['node:other'] },
    (value: SummaryOutbox) => { value.request.recipe = 'docatlas-flash-enrichment.v1' },
    (value: SummaryOutbox) => { value.generationId = 'generation:other' },
    (value: SummaryOutbox) => { value.jobId = '../../private' },
  ]) { const value = structuredClone(pending); change(value); expect(() => parseMapSummaryOutbox(JSON.stringify(value), source, generation, node)).toThrow() }
  expect(() => parseMapSummaryOutbox('{', source, generation, node)).toThrow()
  expect(() => parseMapSummaryOutbox(JSON.stringify({ ...pending, extra: true }), source, generation, node)).toThrow()
})
it('retains the complete original quote, escapes markup and offers reversible expansion', () => {
  const text = '<script>do not execute</script>\n原始选区。'.repeat(30)
  const html = renderToStaticMarkup(createElement(UiLocaleProvider, { initialLocale: 'en', children: createElement(PassageText, { text }) }))
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>')
  expect(html).toContain('Read full passage'); expect(html).toContain('原始选区。')
  expect(html.match(/原始选区。/gu)).toHaveLength(30)
})
