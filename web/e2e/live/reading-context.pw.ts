import { test, expect, type Page } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import type { EnrichmentStart, QuestionContext } from '@docatlas/contracts'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

test.use({ uiLocale: 'en' })
async function original(page: Page, origin: string) {
  await page.goto(`${origin}/live.html`)
  await expect(page.getByRole('button', { name: 'Upload PDF', exact: true })).toBeEnabled()
  await page.locator('input[type=file]').setInputFiles({ name: 'Research passages.pdf', mimeType: 'application/pdf', buffer: longPdf({ nestedToc: true }) })
  await expect(page.locator('.live-upload-status')).toContainText('Document ready', { timeout: 60000 })
  await page.getByTitle('Open original PDF: Research passages.pdf', { exact: true }).click()
  await expect(page.locator('.pdf-paper[data-page="1"][data-rendered=true]')).toBeVisible()
}
test('retains the exact selected passage with the question and answer after reload, and returns to the original highlight', async ({ page }, info) => {
  test.setTimeout(180000)
  const fixture = await liveHarness({ documents: true, answers: ['The selected observations describe repeatable measurements.'] }), contexts: QuestionContext[] = []
  try {
    await page.route('**/question-context/messages/*', async route => {
      const response = await route.fetch(), body = await response.body()
      if (response.ok()) contexts.push(JSON.parse(body.toString()))
      await route.fulfill({ response, body })
    })
    await original(page, fixture.origin)
    await expect(page.locator('.pdf-text-layer')).toContainText('observation 6:')
    await page.locator('.pdf-text-layer').evaluate(layer => {
      const spans = [...layer.querySelectorAll('span')].filter(span => !span.children.length)
      const first = spans.find(span => span.textContent?.includes('observation 1:'))!, last = spans.find(span => span.textContent?.includes('observation 6:'))!
      const range = document.createRange(); range.setStartBefore(first); range.setEndAfter(last)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    await page.getByRole('button', { name: 'Ask about this', exact: true }).click()
    await expect(page.locator('[data-selection-ticket]')).toHaveCount(1)
    const ticketId = (await page.locator('[data-selection-ticket]').getAttribute('data-selection-ticket'))!
    const ticket = fixture.documents!.selections.get('conversation:browser', ticketId), text = ticket.items[0]!.text
    await page.getByRole('textbox', { name: 'Ask DocAtlas' }).fill('Explain the selected observations.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const user = page.locator('.live-message.user[data-message-saved=true]'), answer = page.locator('.live-message.assistant[data-message-saved=true]')
    await expect(answer).toContainText('The selected observations', { timeout: 30000 })
    await expect(user.locator('.question-context-quote')).toHaveText(text)
    await expect(user.locator('.question-context-source')).toContainText('Research passages.pdf')
    await expect(answer.getByRole('button', { name: /About your selection/ })).toBeVisible()
    await expect(answer.locator('.question-context-quote')).toHaveCount(0)
    await user.getByRole('button', { name: 'Read full passage', exact: true }).click()
    await expect(user.locator('.question-context-quote')).toHaveClass(/is-expanded/)
    await page.reload()
    await expect(user.locator('.question-context-quote')).toHaveText(text, { timeout: 30000 })
    await answer.getByRole('button', { name: /About your selection/ }).click()
    await expect(answer.locator('.question-context-quote')).toHaveText(text)
    await answer.getByRole('button', { name: 'Open selected passage in Research passages.pdf, page 1', exact: true }).click()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible({ timeout: 30000 })
    await expect(page.locator('[data-focus-status]')).toHaveAttribute('data-focus-status', 'exact')
    await expect(page.locator('.reader-panel .live-markdown')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to message', exact: true }).click()
    await expect(answer).toBeFocused()
    await page.getByRole('button', { name: '中文', exact: true }).click()
    await expect(user.getByRole('button', { name: /选中的原文/ })).toBeVisible()
    await expect(answer.getByRole('button', { name: /针对所选原文/ })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(user.locator('.question-context-quote')).toHaveText(text)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: info.outputPath('selected-question-mobile.png') })
    const available = contexts.filter(value => value.status === 'available')
    expect(available.length).toBeGreaterThanOrEqual(2)
    expect(available.every(value => value.passages[0]!.selectionContextId === ticketId && value.passages[0]!.text === text)).toBe(true)
    expect(fixture.documents!.selections.get('conversation:browser', ticketId).state).toBe('consumed')
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { await fixture.close() }
})

test('adds chapter summaries with explicit consent and original-key retry, then restores previews and full text without generating again', async ({ page }, info) => {
  test.setTimeout(180000)
  const summary = 'This section explains calibrated sensors and repeatable experiment observations. '.repeat(5)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: [JSON.stringify({ summary })] }), requests: EnrichmentStart[] = []
  try {
    await original(page, fixture.origin)
    await page.getByRole('region', { name: 'Original PDF reader', exact: true }).getByRole('button', { name: 'Map', exact: true }).click()
    const map = page.getByRole('dialog', { name: 'Document map', exact: true })
    await map.getByRole('button', { name: 'Select section: Section 1', exact: true }).click()
    await expect(map.getByText('No summary has been generated for this section yet.', { exact: true })).toBeVisible()
    expect(fixture.enrichmentModel!.getCallCount()).toBe(0)
    await map.getByRole('button', { name: 'Generate summary', exact: true }).click()
    expect(fixture.enrichmentModel!.getCallCount()).toBe(0)
    await page.route('**/enrichments', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      requests.push(route.request().postDataJSON()); await route.fetch(); await route.abort()
    })
    await map.getByRole('button', { name: 'Confirm and generate', exact: true }).click()
    await expect(map.getByRole('button', { name: 'Check and resume same task', exact: true })).toBeVisible()
    expect(fixture.enrichmentModel!.getCallCount()).toBe(0)
    await page.unroute('**/enrichments')
    await page.route('**/enrichments', async route => { if (route.request().method() === 'POST') requests.push(route.request().postDataJSON()); await route.continue() })
    await map.getByRole('button', { name: 'Close document map', exact: true }).click()
    await page.getByRole('region', { name: 'Original PDF reader', exact: true }).getByRole('button', { name: 'Map', exact: true }).click()
    await map.getByRole('button', { name: 'Select section: Section 1', exact: true }).click()
    expect(fixture.enrichmentModel!.getCallCount()).toBe(0)
    await map.getByRole('button', { name: 'Check and resume same task', exact: true }).click()
    await expect(map.locator('.map-summary-text')).toHaveText(summary.trim(), { timeout: 60000 })
    await expect(map.locator('.map-node.is-selected .map-node-summary')).toContainText('calibrated sensors')
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(requests[0]!.mode).toBe('summary')
    expect(fixture.enrichmentModel!.getCallCount()).toBe(1)
    await page.screenshot({ path: info.outputPath('map-summary-desktop.png') })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.reload()
    await page.getByTitle('Open original PDF: Research passages.pdf', { exact: true }).click()
    await page.getByRole('region', { name: 'Original PDF reader', exact: true }).getByRole('button', { name: 'Map', exact: true }).click()
    await map.getByRole('button', { name: 'Select section: Section 1', exact: true }).click()
    await expect(map.locator('.map-summary-text')).toHaveText(summary.trim())
    await page.setViewportSize({ width: 390, height: 844 })
    await map.getByRole('button', { name: 'Outline', exact: true }).click()
    await expect(map.locator('.map-outline-summary')).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    expect(fixture.enrichmentModel!.getCallCount()).toBe(1); expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})
