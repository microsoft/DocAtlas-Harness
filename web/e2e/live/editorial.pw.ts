import { test, expect } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import { liveHarness } from './harness.js'

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) test(`editorial live workspace remains bilingual, accessible and contained at ${viewport.width}px`, async ({ page }, info) => {
  const fixture = await liveHarness({ documents: true })
  const httpFailures: string[] = []
  page.on('response', response => { if (response.status() >= 400) httpFailures.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  try {
    await page.setViewportSize(viewport)
    await page.goto(`${fixture.origin}/live.html`)
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.live-app')!).getPropertyValue('--accent').trim())).toBe('#47644c')
    await page.screenshot({ path: info.outputPath(`editorial-zh-${viewport.width}.png`), fullPage: true })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: 'EN', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'What would you like to understand?', exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.fonts.check('16px "DM Sans Variable"') && document.fonts.check('40px "Newsreader Variable"'))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`editorial-en-${viewport.width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await expect(page.getByLabel('Document search strategy', { exact: true })).toBeVisible()
    await page.getByLabel('Document search strategy', { exact: true }).selectOption('combined')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    expect(fixture.model.getCallCount()).toBe(0)
    expect(httpFailures).toEqual([])
  } finally { await fixture.close() }
})
