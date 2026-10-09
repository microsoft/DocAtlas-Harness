import { test, expect } from './test.js'
import type { Locator } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

test.use({ uiLocale: 'en' })

/** Every mounted page needs the invisible, selectable PDF overlay, not only the current page. */
async function expectOriginalOnly(reader: Locator) {
  await expect(reader.locator('.pdf-sheet[data-current=false] .pdf-page-text span').first()).toBeAttached()
  await expect.poll(() => reader.locator('.pdf-page-text').evaluateAll(layers => {
    const problems: string[] = []
    for (const layer of layers) {
      const style = getComputedStyle(layer), paper = layer.parentElement!, page = paper.dataset.page
      if (style.position !== 'absolute' || style.overflow !== 'clip' || style.zIndex !== '2') problems.push(`page ${page}: overlay layout`)
      if (style.display === 'none' || style.visibility !== 'visible' || style.opacity !== '1') problems.push(`page ${page}: selection disabled`)
      const bounds = layer.getBoundingClientRect(), sheet = paper.getBoundingClientRect()
      if (Math.abs(bounds.width - sheet.width) > 1 || Math.abs(bounds.height - sheet.height) > 1) problems.push(`page ${page}: overlay bounds`)
      for (const span of layer.querySelectorAll('span:not(.markedContent)')) {
        const textStyle = getComputedStyle(span)
        if (textStyle.color !== 'rgba(0, 0, 0, 0)' || textStyle.position !== 'absolute' || textStyle.userSelect !== 'text') problems.push(`page ${page}: visible or unselectable text`)
      }
    }
    return [...new Set(problems)]
  })).toEqual([])
  await expect(reader.locator('.live-markdown, pre')).toHaveCount(0)
}

test('English-first interface switches without translating content, resending questions or losing the draft', async ({ page }) => {
  const release = Promise.withResolvers<void>(), fixture = await liveHarness({ answers: ['## Findings\n\n原文保持不变。 **Evidence first.**'], beforeResponse: async () => { await release.promise } })
  try {
    await page.goto(`${fixture.origin}/live.html`)
    await expect(page.getByRole('heading', { name: 'What would you like to understand?' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.getByRole('textbox', { name: 'Ask DocAtlas' }).fill('不要翻译这条草稿')
    await page.getByRole('button', { name: '中文', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '向 DocAtlas 提问' })).toHaveValue('不要翻译这条草稿')
    await page.getByRole('button', { name: 'EN', exact: true }).click()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.live-thinking .working-indicator')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.live-message.user header')).toHaveCount(0)
    await expect(page.getByText('正在处理你的问题…', { exact: true })).toHaveCount(0)
    release.resolve()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toContainText('原文保持不变。')
    await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible()
    await page.getByRole('button', { name: '中文', exact: true }).click()
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toContainText('原文保持不变。')
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { release.resolve(); await fixture.close() }
})

test('scrolls a whole original PDF with a bounded canvas window, chapter tree, retained zoom and bilingual controls', async ({ page }) => {
  test.setTimeout(150000)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: [] }), originals: string[] = []
  page.on('request', request => { if (request.url().endsWith('/original')) originals.push(request.url()) })
  try {
    await page.goto(`${fixture.origin}/live.html`)
    await expect(page.getByRole('button', { name: 'Upload PDF', exact: true })).toBeEnabled()
    await page.locator('input[type=file]').setInputFiles({ name: 'Research 原文.pdf', mimeType: 'application/pdf', buffer: longPdf({ typography: true }) })
    await expect(page.locator('.live-upload-status')).toContainText('Document ready', { timeout: 60000 })
    await page.getByTitle('Open original PDF: Research 原文.pdf', { exact: true }).click()
    const reader = page.getByRole('region', { name: /^(Original PDF reader|原始 PDF 阅读器)$/u }), scroller = reader.getByRole('region', { name: 'PDF document scrolling area', exact: true })
    await expect(reader.locator('.pdf-paper[data-rendered=true][data-page="1"]')).toBeVisible()
    await expectOriginalOnly(reader)
    expect(await reader.locator('canvas').count()).toBeLessThanOrEqual(5)
    await scroller.hover(); await page.mouse.wheel(0, 1000)
    await expect(reader.getByRole('textbox', { name: 'Page number' })).not.toHaveValue('1')
    await expectOriginalOnly(reader)
    await reader.getByRole('textbox', { name: 'Page number' }).fill('6'); await reader.getByRole('textbox', { name: 'Page number' }).press('Enter')
    await expect(reader.locator('.pdf-paper[data-rendered=true][data-page="6"]')).toBeVisible()
    await expectOriginalOnly(reader)
    expect(await reader.locator('canvas').count()).toBeLessThanOrEqual(5)
    await reader.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect(reader.getByRole('button', { name: 'Fit to width', exact: true })).toHaveText('125%')
    await expect(reader.locator('.pdf-paper[data-rendered=true][data-page="6"]')).toBeVisible()
    await expectOriginalOnly(reader)
    await reader.getByRole('button', { name: 'Document contents', exact: true }).click()
    await expect(page.locator('[data-outline-node]').first()).toBeVisible({ timeout: 30000 })
    await page.getByRole('button', { name: 'Section 3 3', exact: true }).click()
    await expect(reader.locator('.pdf-paper[data-rendered=true][data-page="3"]')).toBeVisible()
    await reader.getByRole('button', { name: 'Close contents', exact: true }).click()
    await page.getByRole('button', { name: '中文', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '页码', exact: true })).toHaveValue('3')
    await expect(page.getByRole('button', { name: '恢复适合宽度', exact: true })).toHaveText('125%')
    await expect(page.locator('.reader-file-title')).toContainText('Research 原文.pdf')
    expect(originals).toHaveLength(1); expect(fixture.model.getCallCount()).toBe(0); expect(fixture.enrichmentModel!.getCallCount()).toBe(0)
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.pdf-paper[data-rendered=true][data-page="3"]')).toBeVisible()
    await expectOriginalOnly(reader)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  } finally { await fixture.close() }
})
