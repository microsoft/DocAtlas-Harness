import { readFileSync } from 'node:fs'
import { test, expect } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import { liveHarness } from './harness.js'

test('uploads real PDF bytes, selects a committed source, uses Pi/Flash/Read and opens the same original', async ({ page }) => {
  test.setTimeout(120000)
  const tree = { documentId: 'pending', mode: 'merge' }, read = { documentId: 'pending', mode: 'page', physicalPage: 2 }
  const fixture = await liveHarness({ documents: true, answers: [{ calls: [{ name: 'docatlas_sources', args: {} }] }, { calls: [{ name: 'docatlas_tree', args: tree }] }, { calls: [{ name: 'docatlas_read', args: read }] }, '测试模型已接收真实文档工具结果。此处未生成核验引用。'] })
  const csp: string[] = []
  page.on('console', message => { if (/violates.*Content Security Policy/i.test(message.text())) csp.push(message.text().slice(0, 160)) })
  try {
    expect((await page.request.post(`${fixture.origin}/api/conversations/conversation:browser/uploads`, { headers: { Origin: fixture.origin }, data: {} })).status()).toBe(403)
    await page.goto(`${fixture.origin}/live.html`)
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByLabel('向 DocAtlas 提问').fill('保留此草稿，先读文档')
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.route('**/uploads/*', async route => { if (route.request().method() === 'PUT') { await route.fetch(); await route.abort() } else await route.continue() })
    await page.locator('input[type=file]').setInputFiles({ name: '真实上传.pdf', mimeType: 'application/pdf', buffer: readFileSync('apps/web/public/documents/sample-report.pdf') })
    await expect(page.getByRole('button', { name: '继续处理', exact: true })).toBeEnabled()
    expect(fixture.documents!.store.listLibraryDocuments('workspace:browser')).toHaveLength(0)
    await page.unroute('**/uploads/*')
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('保留此草稿，先读文档')
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.getByRole('button', { name: '继续处理', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '用于提问：真实上传.pdf' })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：真实上传.pdf' }).check()
    const document = fixture.documents!.store.listLibraryDocuments('workspace:browser')[0]!
    const forbidden = await page.request.get(`${fixture.origin}/api/conversations/conversation:foreign/documents/${document.documentId}/${document.currentRevision.revisionId}/original`)
    expect(forbidden.status()).toBe(404)
    const stale = await page.request.get(`${fixture.origin}/api/conversations/conversation:browser/documents/${document.documentId}/revision:stale/original`)
    expect(stale.status()).toBe(409)
    tree.documentId = document.documentId; read.documentId = document.documentId
    await page.getByRole('button', { name: '打开原文', exact: true }).click()
    await expect(page.locator('.pdf-paper[data-rendered=true]')).toBeVisible({ timeout: 15000 })
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('保留此草稿，先读文档')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
    expect(await page.evaluate(() => window.document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    expect((await new AxeBuilder({ page }).analyze()).violations.filter(value => value.impact === 'critical' || value.impact === 'serious')).toEqual([])
    await page.getByRole('button', { name: '收起原文，返回聊天', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByLabel('向 DocAtlas 提问').fill('阅读第二页并解释营收变化')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible({ timeout: 60000 })
    expect(fixture.model.getCallCount()).toBe(4)
    expect(fixture.contexts.at(-1)).toContain('15.2')
    expect(fixture.contexts.at(-1)).toContain('tree-page')
    await page.reload()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible()
    expect(fixture.model.getCallCount()).toBe(4)
    await expect(page.getByRole('button', { name: '资料 · 1', exact: true })).toBeVisible()
    expect(csp).toEqual([])
  } finally { await fixture.close() }
})
test('does not make a malformed uploaded PDF eligible or discard the question draft', async ({ page }) => {
  test.setTimeout(90000)
  const fixture = await liveHarness({ documents: true })
  try {
    await page.goto(`${fixture.origin}/live.html`)
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByLabel('向 DocAtlas 提问').fill('这段草稿必须保留')
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '损坏.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnot a valid PDF file') })
    await expect(page.getByText('资料解析失败或已取消，未加入可提问来源。请检查文件后重新上传。', { exact: true })).toBeVisible({ timeout: 60000 })
    expect(fixture.documents!.store.listLibraryDocuments('workspace:browser')).toHaveLength(0)
    await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('这段草稿必须保留')
    expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})
