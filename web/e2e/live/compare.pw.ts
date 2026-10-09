import { clickDetailAction } from './ui.js'
import { readFileSync } from 'node:fs'
import { expect, test } from './test.js'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

test('compares same-name PDF revisions with independent cursors, selection authority and narrow-screen state', async ({ page }) => {
  test.setTimeout(120000)
  const fixture = await liveHarness({ documents: true })
  try {
    await page.goto(`${fixture.origin}/live.html`)
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    const library = page.getByRole('button', { name: /^资料(?: · \d+)?$/ })
    await library.click()
    await page.locator('input[type=file]').setInputFiles({ name: '同名报告.pdf', mimeType: 'application/pdf', buffer: readFileSync('apps/web/public/documents/sample-report.pdf') })
    await expect(page.locator('[data-library-document]')).toHaveCount(1, { timeout: 60000 })
    const aId = await page.locator('[data-library-document]').getAttribute('data-library-document')
    await page.locator('input[type=file]').setInputFiles({ name: '同名报告.pdf', mimeType: 'application/pdf', buffer: longPdf() })
    await expect(page.locator('[data-library-document]')).toHaveCount(2, { timeout: 60000 })
    const a = page.locator(`[data-library-document="${aId}"]`)
    const summaries = await page.locator('[data-library-document]').evaluateAll(nodes => nodes.map(node => ({ document: node.getAttribute('data-library-document'), revision: node.getAttribute('data-library-revision') })))
    const bId = summaries.find(item => item.document !== aId)!.document!, bCard = page.locator(`[data-library-document="${bId}"]`)
    expect(new Set(summaries.map(item => item.revision)).size).toBe(2)
    await a.getByRole('checkbox').check()
    await bCard.getByRole('checkbox').uncheck() // Upload-and-ask selects each new PDF; this case deliberately asks only A.
    await clickDetailAction(a.getByRole('button', { name: '放入对照 A', exact: true, includeHidden: true }))
    const paneA = page.locator('[data-reader-pane=A]'), paneB = page.locator('[data-reader-pane=B]')
    await expect(paneA.locator('.pdf-paper[data-rendered=true]')).toBeVisible()
    await paneA.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(paneA.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
    await paneA.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(paneA.locator('.pdf-paper[data-page="3"][data-rendered=true]')).toBeVisible()
    await library.click(); await clickDetailAction(bCard.getByRole('button', { name: '放入对照 B', exact: true, includeHidden: true }))
    await expect(paneB.locator('.pdf-paper[data-rendered=true]')).toBeVisible()
    for (let current = 1; current < 4; current++) {
      await paneB.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(paneB.locator(`.pdf-paper[data-page="${current + 1}"][data-rendered=true]`)).toBeVisible()
    }
    await expect(paneA.locator('.pdf-paper')).toHaveAttribute('data-page', '3')
    await expect(library).toHaveText('资料 · 1')
    await expect(paneA.locator('[data-source-document]')).toHaveAttribute('data-source-document', aId!)
    await expect(paneB.locator('[data-source-document]')).toHaveAttribute('data-source-document', bId)
    const quote = await paneB.locator('.pdf-text-layer').evaluate(layer => {
      const text = [...layer.querySelectorAll('span')].find(node => !node.children.length && node.textContent?.includes('observation 1:'))!
      const range = document.createRange(); range.selectNodeContents(text)
      window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return text.textContent!
    })
    await paneB.getByRole('button', { name: '加入问题', exact: true }).click()
    await expect(page.locator('[data-selection-ticket]')).toHaveCount(1, { timeout: 30000 })
    const ticketId = await page.locator('[data-selection-ticket]').getAttribute('data-selection-ticket')
    const ticket = fixture.documents!.selections.get('conversation:browser', ticketId!)
    expect(ticket.items[0]!.locator).toMatchObject({ documentId: bId, revisionId: summaries.find(item => item.document === bId)!.revision, physicalPage: 4 })
    expect(ticket.items[0]!.text).toContain(quote.trim())

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '查看 A 原文', exact: true }).click()
    await expect(paneA.locator('.pdf-paper[data-page="3"][data-rendered=true]')).toBeVisible(); await expect(paneB).toBeHidden()
    await page.getByRole('button', { name: '查看 B 原文', exact: true }).click()
    await expect(paneB.locator('.pdf-paper[data-page="4"][data-rendered=true]')).toBeVisible(); await expect(paneA).toBeHidden()
    await expect(paneB.getByRole('button', { name: '加入问题', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(paneA.locator('.pdf-paper[data-page="3"][data-rendered=true]')).toBeVisible()
    await expect(paneB.locator('.pdf-paper[data-page="4"][data-rendered=true]')).toBeVisible()

    for (const dismissal of ['escape', 'button', 'backdrop', 'reduced-motion']) {
      await page.emulateMedia({ reducedMotion: dismissal === 'reduced-motion' ? 'reduce' : 'no-preference' })
      const release = Promise.withResolvers<void>(), started = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>()
      await page.route(`**/documents/${encodeURIComponent(bId)}`, async route => { const response = await route.fetch(); started.resolve(); await release.promise; await route.fulfill({ response }); delivered.resolve() })
      await library.click(); await clickDetailAction(bCard.getByRole('button', { name: '放入对照 A', exact: true, includeHidden: true })); await started.promise
      const drawer = page.getByRole('dialog', { name: /^资料(?: · \d+)?$/u })
      if (dismissal === 'button') await drawer.getByRole('button', { name: '关闭资料', exact: true }).click()
      else if (dismissal === 'backdrop') await page.locator('.drawer-backdrop').click({ position: { x: 4, y: 4 } })
      else await drawer.press('Escape')
      // Deliver immediately, including during the 120ms exit animation: the intent is already revoked.
      release.resolve(); await delivered.promise
      await page.unroute(`**/documents/${encodeURIComponent(bId)}`)
      await expect(drawer).toBeHidden()
      await expect(paneA.locator('[data-source-document]')).toHaveAttribute('data-source-document', aId!)
      await expect(paneA.locator('.pdf-paper')).toHaveAttribute('data-page', '3')
      await expect(paneB.locator('.pdf-paper')).toHaveAttribute('data-page', '4')
    }
    expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})
