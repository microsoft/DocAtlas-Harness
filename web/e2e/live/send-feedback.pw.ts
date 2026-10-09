import { test, expect } from './test.js'
import type { ProductSubmission } from '@docatlas/contracts'
import { liveHarness } from './harness.js'

test.use({ uiLocale: 'en' })
for (const width of [1440, 390]) test(`Enter immediately shows one pending question and hands off without a size jump (${width}px)`, async ({ page }) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 })
  const fixture = await liveHarness({ answers: ['The first answer.', 'The second answer.'] }), release = Promise.withResolvers<void>(), requests: ProductSubmission[] = []
  try {
    await page.route('**/api/submissions', async route => { requests.push(route.request().postDataJSON()); await release.promise; await route.continue() })
    await page.goto(`${fixture.origin}/live.html`)
    const composer = page.getByRole('textbox', { name: 'Ask DocAtlas', exact: true }), text = 'This question should appear immediately.'
    await expect(composer).toBeEnabled(); await composer.fill(text)
    await composer.press('Shift+Enter'); await expect(composer).toHaveValue(`${text}\n`)
    await composer.fill(text)
    await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
    await expect(page.locator('[data-outgoing-key]')).toHaveCount(0)
    await composer.press('Enter')
    const outgoing = page.locator('[data-outgoing-key]')
    await expect(outgoing).toContainText(text, { timeout: 1000 })
    await expect(outgoing).toHaveAttribute('data-send-state', 'sending')
    await expect(composer).toHaveValue('')
    await expect(page.locator('.live-outbox')).toHaveCount(0)
    await expect(page.locator('.live-message.user')).toHaveCount(1)
    await composer.press('Enter'); await composer.press('Enter')
    await expect.poll(() => requests.length).toBe(1)
    expect(fixture.model.getCallCount()).toBe(0)
    const pendingSize = await outgoing.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }))
    release.resolve()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toContainText('The first answer.', { timeout: 30000 })
    await expect(page.locator('.live-message.user')).toHaveCount(1)
    await expect(page.locator('[data-outgoing-key]')).toHaveCount(0)
    await expect(page.locator('.live-message.user[data-message-saved=true]')).toContainText(text)
    const savedSize = await page.locator('.live-message.user[data-message-saved=true]').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }))
    expect(Math.abs(savedSize.height - pendingSize.height)).toBeLessThanOrEqual(2)
    expect(Math.abs(savedSize.width - pendingSize.width)).toBeLessThanOrEqual(2)
    // Equal prose is a new explicit submission, never text-based deduplication.
    await composer.fill(text); await composer.press('Enter')
    await expect(page.locator('.live-message.assistant[data-message-saved=true]').last()).toContainText('The second answer.', { timeout: 30000 })
    await expect(page.locator('.live-message.user[data-message-saved=true]')).toHaveCount(2)
    expect(requests).toHaveLength(2); expect(requests[0]!.idempotencyKey).not.toBe(requests[1]!.idempotencyKey)
    await page.reload(); await expect(page.locator('.live-message.user[data-message-saved=true]')).toHaveCount(2)
    expect(requests).toHaveLength(2)
  } finally { release.resolve(); await fixture.close() }
})
