import { revealDetailAction, clickDetailAction } from './ui.js'
import { expect, test } from './test.js'
import type { EnrichmentStart, EnrichmentTree } from '@docatlas/contracts'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

test('runs a real PDF Flash summary job through Pi and reopens the same saved overlay without another model call', async ({ page }) => {
  test.setTimeout(120000)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: Array.from({ length: 16 }, () => '{"summary":"模型生成的报告导航摘要，不是证据。"}') })
  const requests: EnrichmentStart[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/enrichments')) requests.push(request.postDataJSON() as EnrichmentStart) })
  try {
    await page.goto(`${fixture.origin}/live.html`)
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '增强报告.pdf', mimeType: 'application/pdf', buffer: longPdf() })
    await revealDetailAction(page.getByRole('button', { name: 'Flash 增强', exact: true, includeHidden: true }))
    await clickDetailAction(page.getByRole('button', { name: 'Flash 增强', exact: true, includeHidden: true }))
    // Forward the real response unchanged; CDP can discard its response-body cache even after the UI consumed it.
    let tree: EnrichmentTree | undefined
    await page.route('**/documents/*/*/tree', async route => {
      const response = await route.fetch(), body = await response.body()
      expect(response.ok()).toBe(true)
      tree = JSON.parse(body.toString('utf8')) as EnrichmentTree
      await route.fulfill({ response, body })
    })
    await page.getByRole('button', { name: '读取基础树', exact: true }).click()
    await expect(page.locator('.live-tree-targets input')).not.toHaveCount(0, { timeout: 30000 })
    expect(tree?.generation.tocSource).toBe('hybrid')
    expect(tree?.generation.nodeCount).toBeGreaterThan(0)
    await page.getByLabel('Flash 增强方式').selectOption('summary')
    await page.getByRole('button', { name: '开始增强', exact: true }).click()
    await expect(page.locator('[data-enrichment-state=completed]')).toBeVisible({ timeout: 60000 })
    await expect(page.getByRole('region', { name: '增强导航结果' })).toBeVisible()
    expect(requests).toHaveLength(1); expect(requests[0]!.recipe).toBe('docatlas-flash-enrichment.v2')
    await expect(page.getByRole('region', { name: '增强导航结果' })).toContainText('docatlas-flash-enrichment.v2')
    const calls = fixture.enrichmentModel!.getCallCount()
    expect(calls).toBeGreaterThan(0); expect(fixture.model.getCallCount()).toBe(0)
    await page.reload()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await clickDetailAction(page.getByRole('button', { name: 'Flash 增强', exact: true, includeHidden: true }))
    await page.getByRole('button', { name: '核对并继续同一作业', exact: true }).click()
    await expect(page.locator('[data-enrichment-state=completed]')).toBeVisible()
    expect(fixture.enrichmentModel!.getCallCount()).toBe(calls)
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
  } finally { await fixture.close() }
})

test('reports a readable PDF with no detected tree instead of offering an empty enhancement', async ({ page }) => {
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: ['{"summary":"This must not be requested."}'] })
  try {
    await page.goto(`${fixture.origin}/live.html`)
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '无目录报告.pdf', mimeType: 'application/pdf', buffer: longPdf({ embeddedToc: false }) })
    await revealDetailAction(page.getByRole('button', { name: 'Flash 增强', exact: true, includeHidden: true }))
    await clickDetailAction(page.getByRole('button', { name: 'Flash 增强', exact: true, includeHidden: true }))
    await page.getByRole('button', { name: '读取基础树', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Flash 增强' }).getByRole('status')).toContainText('未识别到可增强的目录节点', { timeout: 30000 })
    await expect(page.locator('.live-tree-targets input')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '开始增强', exact: true })).toBeDisabled()
    expect(fixture.enrichmentModel!.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})
