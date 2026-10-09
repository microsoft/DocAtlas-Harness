import { readFileSync } from 'node:fs'
import { test, expect, type Page } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import { liveHarness } from './harness.js'
import { clickHeaderAction } from './ui.js'

const pdf = { name: '我的第一份文档.pdf', mimeType: 'application/pdf', buffer: readFileSync('apps/web/public/documents/sample-report.pdf') }

async function expectUnifiedComposer(page: Page) {
  const box = await page.locator('.live-composer-shell').boundingBox(), input = await page.getByLabel('向 DocAtlas 提问').boundingBox()
  const upload = await page.getByRole('button', { name: '上传 PDF', exact: true }).boundingBox(), send = await page.getByRole('button', { name: '发送问题', exact: true }).boundingBox()
  expect(box && input && upload && send).toBeTruthy()
  for (const item of [input!, upload!, send!]) {
    expect(item.x).toBeGreaterThanOrEqual(box!.x); expect(item.x + item.width).toBeLessThanOrEqual(box!.x + box!.width + 1)
    expect(item.y).toBeGreaterThanOrEqual(box!.y); expect(item.y + item.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
  }
  expect(upload!.y).toBeGreaterThanOrEqual(input!.y + input!.height)
  expect(Math.abs(upload!.y + upload!.height / 2 - send!.y - send!.height / 2)).toBeLessThan(3)
  expect(upload!.x + upload!.width).toBeLessThan(send!.x)
}

async function firstVisit(page: Page, fixture: Awaited<ReturnType<typeof liveHarness>>) {
  // Empty first-page projection exercises an account with no selected conversation.
  // Creation, upload, parsing, source selection and native calls still use real APIs.
  await page.route('**/api/conversations', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), items: [], nextCursor: null } })
  })
  await page.goto(`${fixture.origin}/live.html`)
  await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
  expect(await page.context().cookies()).toEqual([])
}

test('first visit: visible upload creates a conversation, selects only the committed PDF and opens its original', async ({ page }) => {
  test.setTimeout(120000)
  const fixture = await liveHarness({ documents: true }), creations: string[] = [], submissions: unknown[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/conversations') creations.push(request.postData()!); if (request.url().endsWith('/api/submissions')) submissions.push(request.postDataJSON()) })
  try {
    await firstVisit(page, fixture)
    await expect(page.locator('[data-chat-layout=landing]')).toBeVisible()
    await expect(page.getByRole('button', { name: '上传 PDF', exact: true })).toBeInViewport()
    await expect(page.getByRole('button', { name: '运行设置', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: '结论与审阅', exact: true })).toBeHidden()
    await page.getByLabel('向 DocAtlas 提问').fill('先保留这个问题')
    await expectUnifiedComposer(page)
    await page.screenshot({ path: '.cache/simple-entry-desktop.png' })
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传 PDF', exact: true }).click()
    await (await chooser).setFiles(pdf)
    await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeDisabled()
    const chips = page.getByLabel('本次提问的文档')
    await expect(chips).toContainText(pdf.name, { timeout: 60000 })
    expect(creations).toHaveLength(1); expect(fixture.model.getCallCount()).toBe(0); expect(submissions).toEqual([])
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('先保留这个问题')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.pdf-paper')).toHaveCount(0)
    await chips.getByRole('button', { name: pdf.name, exact: true }).click()
    await expect(page.locator('.pdf-paper[data-rendered=true]')).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '收起原文，返回聊天', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: '上传 PDF', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '上传 PDF', exact: true })).toBeInViewport()
    await expectUnifiedComposer(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect((await new AxeBuilder({ page }).analyze()).violations.filter(value => ['critical', 'serious'].includes(value.impact ?? ''))).toEqual([])
    await page.screenshot({ path: '.cache/simple-entry-mobile.png' })
    await page.getByRole('button', { name: `移除提问文档：${pdf.name}` }).click()
    await expect(chips).toHaveCount(0)
    expect(fixture.documents!.store.listLibraryDocuments('workspace:browser')).toHaveLength(1)
    await clickHeaderAction(page, '偏好')
    await expect(page.getByRole('dialog', { name: '偏好设置', exact: true })).toBeVisible()
  } finally { await fixture.close() }
})

test('first typed question creates its conversation only on send and preserves the question', async ({ page }) => {
  const fixture = await liveHarness({ answers: ['收到首屏问题。'] })
  try {
    await firstVisit(page, fixture)
    await page.getByLabel('向 DocAtlas 提问').fill('不上传文档也能直接问吗？')
    expect(fixture.model.getCallCount()).toBe(0)
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.getByText('收到首屏问题。', { exact: true })).toBeVisible({ timeout: 30000 })
    expect(fixture.contexts.at(-1)).toContain('不上传文档也能直接问吗？')
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { await fixture.close() }
})

test('lost first-creation receipt retries the same key; no upload or model runs before confirmation', async ({ page }) => {
  test.setTimeout(120000)
  const fixture = await liveHarness({ documents: true }), keys: string[] = []
  try {
    await firstVisit(page, fixture)
    await page.route('**/api/conversations', async route => {
      if (route.request().method() !== 'POST') { await route.fallback(); return }
      keys.push(route.request().postDataJSON().idempotencyKey)
      const response = await route.fetch()
      if (keys.length === 1) await route.abort(); else await route.fulfill({ response })
    })
    await page.getByLabel('向 DocAtlas 提问').fill('创建失败也保留草稿')
    await page.getByLabel('上传 PDF 文件').setInputFiles(pdf)
    await expect(page.getByRole('alert')).toContainText('新会话创建结果未确认')
    expect(fixture.documents!.store.listLibraryDocuments('workspace:browser')).toHaveLength(0)
    expect(fixture.model.getCallCount()).toBe(0)
    await page.getByLabel('上传 PDF 文件').setInputFiles(pdf)
    await expect(page.getByLabel('本次提问的文档')).toContainText(pdf.name, { timeout: 60000 })
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('创建失败也保留草稿')
  } finally { await fixture.close() }
})

test('drag upload is direct and an invalid file never becomes a question source', async ({ page }) => {
  test.setTimeout(120000)
  const fixture = await liveHarness({ documents: true })
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await firstVisit(page, fixture)
    await expect(page.getByRole('button', { name: '上传 PDF', exact: true })).toBeInViewport()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeInViewport()
    await page.getByLabel('上传 PDF 文件').setInputFiles({ name: 'not-a-pdf.txt', mimeType: 'text/plain', buffer: Buffer.from('not a pdf') })
    await expect(page.getByRole('status')).toContainText('请选择不超过 25 MB')
    expect(fixture.documents!.store.listLibraryDocuments('workspace:browser')).toHaveLength(0)
    const transfer = await page.evaluateHandle(bytes => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], '拖入的文档.pdf', { type: 'application/pdf' })); return transfer }, [...pdf.buffer])
    await page.locator('.live-app').dispatchEvent('drop', { dataTransfer: transfer })
    await expect(page.getByLabel('本次提问的文档')).toContainText('拖入的文档.pdf', { timeout: 60000 })
    expect(fixture.model.getCallCount()).toBe(0)
    await transfer.dispose()
  } finally { await fixture.close() }
})
