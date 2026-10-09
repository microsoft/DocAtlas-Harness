import { test, expect } from './test.js'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'
import { parseContract } from '../../packages/contracts/lib/node.js'
import type { ProductSearchExecution, ProductSubmission, SearchResult, TextBlockItem } from '@docatlas/contracts'

function result(messages: readonly unknown[], name: string): Record<string, unknown> {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === name)
  if (!message || typeof message !== 'object') throw new Error(`Missing actual native result: ${name}`)
  const content = Reflect.get(message, 'content') as Array<{ type: string, text?: string }>
  return JSON.parse(content.filter(item => item.type === 'text').map(item => item.text).join(''))
}

test('explicit Web tree search uses real Flash nodes, then Read and the exact original PDF', async ({ page }, info) => {
  test.setTimeout(180000)
  const submissions: ProductSubmission[] = []
  let search: SearchResult | undefined, execution: ProductSearchExecution | undefined, read: TextBlockItem | undefined
  const fixture = await liveHarness({ documents: true,
    searchAnswers: ['{"schemaVersion":1,"kind":"tree-search-selection","nodes":[{"key":"n0","reason":"The first experiment section"}]}'],
    answers: [
      { calls: [{ name: 'docatlas_search', args: { query: 'experiment observation', strategy: 'fts' } }] },
      messages => {
        const { searchExecution, ...value } = result(messages, 'docatlas_search')
        const parsed = parseContract('sidecar-document-rpc', value), policy = parseContract('product-search', searchExecution)
        if (!('resultType' in parsed) || parsed.resultType !== 'search' || policy.kind !== 'product-search-execution') throw new Error('Unexpected search response')
        search = parsed; execution = policy
        expect(policy.strategies).toEqual(['tree']); expect(policy.treeRefs).toHaveLength(1)
        const candidate = parsed.candidates[0]!
        expect(candidate.blockIds).toEqual([]); expect(candidate.matchKind).toBe('tree')
        return { calls: [{ name: 'docatlas_read', args: { documentId: candidate.documentId, revisionId: candidate.revisionId, mode: 'page', physicalPage: candidate.physicalPageStart, maxChars: 6000 } }] }
      },
      messages => {
        const parsed = parseContract('sidecar-document-rpc', result(messages, 'docatlas_read'))
        if (!('resultType' in parsed) || parsed.resultType !== 'read') throw new Error('Missing Read')
        read = parsed.items.find((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes('observation'))
        if (!read) throw new Error('The actual PDF has no observation passage')
        return `The section records experiment observations. [Inspect the original passage](#docatlas.v1.support.${read.locator.locatorId})`
      },
    ] })
  try {
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/submissions')) submissions.push(request.postDataJSON()) })
    await page.goto(`${fixture.origin}/live.html`)
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.locator('input[type=file]').setInputFiles({ name: 'tree-search.pdf', mimeType: 'application/pdf', buffer: longPdf({ nestedToc: true }) })
    await expect(page.locator('.live-upload-status')).toContainText('已添加，可以提问了', { timeout: 60000 })
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByLabel('文档检索方式', { exact: true }).selectOption('tree')
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('Find the first experiment section and read its observations.')
    await page.getByLabel('向 DocAtlas 提问').press('Enter')
    await expect(page.locator('.live-citation:not(:disabled)').first()).toBeVisible({ timeout: 90000 })
    expect(submissions[0]?.documentSearch).toEqual({ recipe: 'tree-search.v1', strategy: 'tree' })
    expect(fixture.searchModel!.getCallCount()).toBe(1)
    expect(search!.candidates[0]!.documentId).toBe(read!.locator.documentId)
    expect(execution!.treeRefs[0]!.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    await page.locator('.live-citation:not(:disabled)').first().click()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible({ timeout: 15000 })
    await page.screenshot({ path: info.outputPath('tree-search-original.png') })
  } finally { await fixture.close() }
})
