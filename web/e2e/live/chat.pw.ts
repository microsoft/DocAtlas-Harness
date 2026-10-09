import { test, expect, type Page } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import { liveHarness } from './harness.js'
import { parseContract } from '../../packages/contracts/lib/node.js'

async function pair(page: Page, fixture: Awaited<ReturnType<typeof liveHarness>>) {
  await page.goto(`${fixture.origin}/live.html`)

  await page.reload()
  await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeVisible()
  await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
}
test('creates an authorized conversation idempotently and restores the selected new chat', async ({ page }) => {
  const fixture = await liveHarness({ answers: ['新建会话的真实通路回答'] })
  try {
    await pair(page, fixture)
    await page.getByRole('button', { name: '历史', exact: true }).click()
    await page.route('**/api/conversations', async route => { if (route.request().method() === 'POST') { await route.fetch(); await route.abort() } else await route.continue() })
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试新建会话', exact: true })).toBeEnabled()
    expect(fixture.model.getCallCount()).toBe(0)
    await page.unroute('**/api/conversations')
    const creation = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${fixture.origin}/api/conversations`).then(async response => {
      expect(response.status()).toBe(200); expect(await response.finished()).toBeNull()
      const binding = parseContract('product-control', await response.json())
      if (binding.kind !== 'binding') throw new Error('Expected the original idempotent conversation binding')
      return binding
    })
    // Header receipt is not body completion: reconnect/resync can abandon an initial
    // snapshot while a subsequent one succeeds. Await a completed exact-binding request.
    const snapshotReady = page.waitForEvent('requestfinished', async request => {
      if (request.method() !== 'GET' || new URL(request.url()).origin !== fixture.origin) return false
      const binding = await creation
      return request.url() === `${fixture.origin}/api/conversations/${encodeURIComponent(binding.conversationId)}/snapshot`
    }).then(async request => {
      const response = await request.response()
      if (!response) throw new Error('Completed native snapshot has no response')
      return response
    })
    const [created, snapshotResponse] = await Promise.all([creation, snapshotReady, page.getByRole('button', { name: '重试新建会话', exact: true }).click()])
    expect(snapshotResponse.status()).toBe(200); expect(await snapshotResponse.finished()).toBeNull()
    expect(parseContract('conversation-observation', await snapshotResponse.json())).toMatchObject({ kind: 'conversation-snapshot',
      binding: { conversationId: created.conversationId, bindingId: created.bindingId, generation: created.generation } })
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await expect(page.getByRole('dialog', { name: '历史会话' })).toBeHidden()
    await page.getByRole('button', { name: '历史', exact: true }).click()
    await expect(page.getByRole('button', { name: /^会话 \d/ })).toHaveCount(2)
    await page.getByRole('dialog', { name: '历史会话' }).press('Escape')
    await page.getByLabel('向 DocAtlas 提问').fill('这是新会话')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.getByText('新建会话的真实通路回答', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText('新建会话的真实通路回答', { exact: true })).toBeVisible()
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { await fixture.close() }
})
test('starts with a centered chat, opens history on demand and preserves the draft through keyboard dismissal', async ({ page }) => {
  const fixture = await liveHarness({ answers: ['保留草稿后的真实回答'] })
  try {
    await pair(page, fixture)
    await expect(page.getByRole('heading', { name: '这份文档，你想了解什么？' })).toBeVisible()
    await expect(page.locator('[data-chat-layout=landing]')).toBeVisible()
    await expect(page.getByRole('complementary', { name: '会话列表' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '原始 PDF 阅读器' })).toHaveCount(0)
    const input = page.getByLabel('向 DocAtlas 提问'), bounds = await input.boundingBox()
    expect(bounds).not.toBeNull()
    expect(Math.abs(bounds!.x + bounds!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2)
    expect(bounds!.y).toBeGreaterThan(200)
    expect(bounds!.y + bounds!.height).toBeLessThan(page.viewportSize()!.height - 200)
    await input.fill('这一条草稿保留在当前会话')
    const history = page.getByRole('button', { name: '历史', exact: true })
    await history.click()
    await expect(page.getByRole('dialog', { name: '历史会话' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: '会话列表' })).toBeVisible()
    await page.getByRole('dialog', { name: '历史会话' }).press('Escape')
    await expect(history).toBeFocused(); await expect(input).toHaveValue('这一条草稿保留在当前会话')
    await input.press('Enter')
    await expect(page.getByText('保留草稿后的真实回答', { exact: true })).toBeVisible()
    await expect(page.locator('[data-chat-layout=conversation]')).toBeVisible()
    await expect(page.getByRole('complementary', { name: '会话列表' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '原始 PDF 阅读器' })).toHaveCount(0)
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { await fixture.close() }
})
test('opens without login, persists a real native answer and reloads without replay or an account screen', async ({ page }, testInfo) => {
  const fixture = await liveHarness(), failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  try {
    await pair(page, fixture)
    await page.getByLabel('向 DocAtlas 提问').fill('请给我一个真实通路回答')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible()
    await expect(page.getByRole('region', { name: '会话消息' })).toContainText('这是真实 Pi 通路的测试回答。<script>window.untrusted = true</script>')
    expect(await page.evaluate(() => Reflect.get(window, 'untrusted'))).toBeUndefined()
    expect(fixture.model.getCallCount()).toBe(1)
    await page.screenshot({ path: testInfo.outputPath('live-desktop.png'), fullPage: true })
    await page.reload()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible()
    expect(fixture.model.getCallCount()).toBe(1)
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    await expect(page.getByRole('button', { name: '注销', exact: true })).toHaveCount(0)
    await expect(page.locator('input[type=password]')).toHaveCount(0)
    expect(await page.context().cookies()).toEqual([])
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible()
    expect(failures).toEqual([])
  } finally { await fixture.close() }
})
test('retains an uncertain submission key and only retries on an explicit action', async ({ page }) => {
  const fixture = await liveHarness()
  try {
    await page.route('**/events', route => route.abort())
    await pair(page, fixture)
    await page.route('**/snapshot', route => route.abort())
    await page.route('**/api/submissions', async route => { await route.fetch(); await route.abort() })
    await page.getByLabel('向 DocAtlas 提问').fill('只应执行一次的问题')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.getByRole('button', { name: '使用原提交键重试', exact: true })).toBeVisible()
    await fixture.coordinator.waitForIdle()
    expect(fixture.model.getCallCount()).toBe(1)
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('只应执行一次的问题')
    await page.unroute('**/api/submissions')
    await page.getByRole('button', { name: '使用原提交键重试', exact: true }).click()
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('')
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { await fixture.close() }
})
test('confirms actual stop and remains keyboard/mobile accessible', async ({ page }, testInfo) => {
  let aborted = false
  const fixture = await liveHarness({ beforeResponse: signal => new Promise((_resolve, reject) => {
    const stop = () => { aborted = true; reject(new Error('cancelled')) }
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true })
  }) })
  try {
    await pair(page, fixture)
    await page.getByLabel('向 DocAtlas 提问').fill('停止这次请求')
    await page.getByLabel('向 DocAtlas 提问').press('Enter')
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
    await expect.poll(() => fixture.model.getCallCount()).toBe(1)
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(page.getByText('已停止', { exact: true })).toBeVisible()
    expect(aborted).toBe(true); expect(fixture.native.activeCount).toBe(0)
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
      const result = await new AxeBuilder({ page }).analyze()
      expect(result.violations.filter(value => value.impact === 'critical' || value.impact === 'serious')).toEqual([])
      if (width === 390) await page.screenshot({ path: testInfo.outputPath('live-mobile.png'), fullPage: true })
    }
  } finally { await fixture.close() }
})
