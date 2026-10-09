import { test, expect, type Page } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import type { EnrichmentTree } from '@docatlas/contracts'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

test.use({ uiLocale: 'en' })
async function openPdf(page: Page, origin: string, name = 'Chapter atlas.pdf') {
  await page.goto(`${origin}/live.html`)
  await expect(page.getByRole('button', { name: 'Upload PDF', exact: true })).toBeEnabled()
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: longPdf({ nestedToc: true }) })
  await expect(page.locator('.live-upload-status')).toContainText('Document ready', { timeout: 60000 })
  await page.getByTitle(`Open original PDF: ${name}`, { exact: true }).click()
  await expect(page.locator('.pdf-paper[data-page="1"][data-rendered=true]')).toBeVisible()
}

test('explores real PDF hierarchy, shares its tree with contents, and returns to the original without a new download or model call', async ({ page }, info) => {
  test.setTimeout(150000)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: [] }), requests: string[] = [], failures: string[] = []
  let tree: EnrichmentTree | undefined
  page.on('request', request => requests.push(request.url())); page.on('pageerror', error => failures.push(error.message))
  try {
    await page.route('**/tree', async route => { const response = await route.fetch(), body = await response.body(); if (response.ok()) tree = JSON.parse(body.toString()); await route.fulfill({ response, body }) })
    await openPdf(page, fixture.origin)
    expect(requests.some(url => url.includes('/DocumentMap-'))).toBe(false)
    const reader = page.getByRole('region', { name: 'Original PDF reader', exact: true })
    await reader.getByRole('button', { name: 'Document contents', exact: true }).click()
    await expect(page.locator('[data-outline-node]').first()).toBeVisible({ timeout: 30000 })
    const actual = tree!.tree.nodes, nested = actual.find(node => actual.some(child => child.parentId === node.nodeId))
    expect(nested).toBeDefined(); expect(actual.length).toBeGreaterThan(4)
    await reader.getByRole('button', { name: 'Close contents', exact: true }).click()
    await reader.getByRole('button', { name: 'Map', exact: true }).click()
    const map = page.getByRole('dialog', { name: 'Document map', exact: true })
    await expect(map).toBeVisible(); await expect(map.locator('[data-map-node]')).toHaveCount(actual.length + 1)
    await expect(map.locator('svg.map-connections path')).toHaveCount(actual.length)
    await map.getByRole('button', { name: `Toggle branch: ${nested!.title}`, exact: true }).click()
    await expect(map.getByRole('button', { name: `Toggle branch: ${nested!.title}`, exact: true })).toHaveAttribute('aria-expanded', 'false')
    expect(await map.locator('[data-map-node]').count()).toBeLessThan(actual.length + 1)
    await map.getByRole('button', { name: 'Show all', exact: true }).click()
    await expect(map.locator('[data-map-node]')).toHaveCount(actual.length + 1)
    const zoom = await map.locator('.map-canvas-controls > span').innerText()
    await map.getByRole('button', { name: 'Zoom in map', exact: true }).click()
    await expect(map.locator('.map-canvas-controls > span')).not.toHaveText(zoom)
    const target = actual.find(node => node.startPage === 3)!
    await map.getByRole('textbox', { name: 'Search document map', exact: true }).fill(target.title)
    await map.locator('.map-outline-view button').filter({ hasText: target.title }).first().click()
    await expect(map.getByRole('complementary', { name: 'Selected section', exact: true })).toContainText(target.title)
    await map.getByRole('button', { name: 'Focus this branch', exact: true }).click()
    await expect(map.locator(`[data-map-node="${target.nodeId}"]`)).toBeVisible()
    await map.getByRole('button', { name: 'Whole document', exact: true }).click()
    await map.getByRole('button', { name: 'Fit', exact: true }).click()
    await page.screenshot({ path: info.outputPath('map-desktop.png') })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await map.getByRole('button', { name: 'Read this section', exact: true }).click()
    await expect(map).toBeHidden(); await expect(reader.locator('.pdf-paper[data-page="3"][data-rendered=true]')).toBeVisible()
    await reader.getByRole('button', { name: 'Map', exact: true }).click()
    await expect(map).toBeVisible(); await map.press('Escape'); await expect(map).toBeHidden()
    await expect(reader.getByRole('button', { name: 'Map', exact: true })).toBeFocused()
    expect(requests.filter(url => url.endsWith('/tree'))).toHaveLength(1)
    expect(requests.filter(url => url.endsWith('/original'))).toHaveLength(1)
    expect(fixture.model.getCallCount()).toBe(0); expect(fixture.enrichmentModel!.getCallCount()).toBe(0)
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
    await reader.getByRole('button', { name: 'Map', exact: true }).click()
    await expect(map.getByRole('button', { name: 'Outline', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(map.locator('.map-outline-view')).toBeVisible()
    expect(await map.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: info.outputPath('map-mobile.png') })
    for (const size of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size)
      expect(await map.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
      await expect(map.getByRole('button', { name: 'Close document map', exact: true })).toBeVisible()
    }
    await map.getByRole('button', { name: 'Close document map', exact: true }).click()
    expect(failures).toEqual([])
  } finally { await fixture.close() }
})

test('rejects a changed source hash in the map and lets the user retry without affecting the PDF', async ({ page }) => {
  test.setTimeout(120000)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: [] })
  try {
    await openPdf(page, fixture.origin)
    let corrupt = true
    await page.route('**/tree', async route => { const response = await route.fetch(), value = await response.json(); if (corrupt && response.ok()) value.generation.sourceHash = 'f'.repeat(64); await route.fulfill({ response, json: value }) })
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    const map = page.getByRole('dialog', { name: 'Document map', exact: true })
    await expect(map.getByRole('heading', { name: 'The map is unavailable' })).toBeVisible({ timeout: 30000 })
    await expect(map.locator('[data-map-node]')).toHaveCount(0)
    corrupt = false; await map.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(map.locator('[data-map-node]').first()).toBeVisible({ timeout: 30000 })
    await map.press('Escape'); await expect(page.locator('.pdf-paper[data-page="1"][data-rendered=true]')).toBeVisible()
    expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})

test('paints a real loading shell before the heavy application code and preserves a long question behind a reversible collapse', async ({ page }) => {
  const fixture = await liveHarness({ answers: ['A short answer after a long question.'] }), release = Promise.withResolvers<void>()
  try {
    await page.route('**/assets/LiveApp-*.js', async route => { await release.promise; await route.continue() })
    await page.goto(`${fixture.origin}/live.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.boot-shell')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0)
    release.resolve()
    const input = page.getByRole('textbox', { name: 'Ask DocAtlas' })
    await expect(input).toBeEnabled()
    const text = 'This original question must remain complete.\n'.repeat(25) + 'Exact final sentence.'
    await input.fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const question = page.locator('.live-message.user[data-message-saved=true]')
    await expect(question).toBeVisible(); await expect(question.locator('p')).toHaveText(text)
    await expect(question.locator('.question-content')).toHaveClass(/is-collapsed/)
    expect((await question.boundingBox())!.height).toBeLessThan(220)
    await question.getByRole('button', { name: 'Show full question' }).click()
    await expect(question.locator('.question-content')).not.toHaveClass(/is-collapsed/)
    await expect(question.locator('p')).toHaveText(text)
    expect(fixture.contexts[0]).toContain('Exact final sentence.')
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { release.resolve(); await fixture.close() }
})

test('a late tree response cannot replace another original’s map', async ({ page }) => {
  test.setTimeout(150000)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: [] }), release = Promise.withResolvers<void>(), firstReady = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>()
  let firstId = '', secondId = '', calls = 0
  try {
    await openPdf(page, fixture.origin, 'First atlas.pdf')
    await page.route('**/tree', async route => {
      const number = ++calls, response = await route.fetch(), bytes = await response.body(), value = JSON.parse(bytes.toString()) as EnrichmentTree
      if (number === 1) { firstId = value.generation.generationId; firstReady.resolve(); await release.promise }
      else secondId = value.generation.generationId
      await route.fulfill({ response, body: bytes }).catch(() => {})
      if (number === 1) delivered.resolve()
    })
    await page.getByRole('button', { name: 'Map', exact: true }).click(); await firstReady.promise
    await page.getByRole('button', { name: 'Close document map', exact: true }).click()
    await page.getByRole('button', { name: 'Close PDF and return to chat', exact: true }).click()
    await page.locator('input[type=file]').setInputFiles({ name: 'Second atlas.pdf', mimeType: 'application/pdf', buffer: longPdf({ nestedToc: true, typography: true }) })
    await expect(page.getByTitle('Open original PDF: Second atlas.pdf', { exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByTitle('Open original PDF: Second atlas.pdf', { exact: true }).click()
    await expect(page.locator('.pdf-paper[data-rendered=true]')).toBeVisible()
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    const map = page.getByRole('dialog', { name: 'Document map', exact: true })
    await expect(map.locator('[data-map-node]').first()).toBeVisible({ timeout: 30000 })
    expect(firstId).not.toBe(secondId); release.resolve(); await delivered.promise
    await expect(map.locator('.map-identity')).toContainText('Second atlas.pdf')
    expect(await map.locator('[data-map-node]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-map-node')).filter(id => id !== '@document'))).toEqual(expect.arrayContaining([expect.stringContaining(secondId)]))
    expect(await map.locator('[data-map-node]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-map-node')))).not.toEqual(expect.arrayContaining([expect.stringContaining(firstId)]))
    expect(calls).toBe(2); expect(fixture.model.getCallCount()).toBe(0)
  } finally { release.resolve(); await fixture.close() }
})

test('respects reduced motion while the full-screen map is still loading', async ({ page }) => {
  test.setTimeout(120000)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: [] }), release = Promise.withResolvers<void>()
  try {
    await openPdf(page, fixture.origin)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('**/tree', async route => { await release.promise; await route.continue() })
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    const map = page.getByRole('dialog', { name: 'Document map', exact: true })
    await expect(map.getByRole('heading', { name: 'Connecting the chapters' })).toBeVisible()
    expect(await map.locator('.working-orbit i').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none')
    release.resolve(); await expect(map.locator('[data-map-node]').first()).toBeVisible({ timeout: 30000 })
    expect(fixture.model.getCallCount()).toBe(0)
  } finally { release.resolve(); await fixture.close() }
})
