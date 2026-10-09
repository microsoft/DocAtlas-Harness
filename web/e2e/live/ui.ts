import type { Locator, Page, Route } from '@playwright/test'

/** Observe a finite real response before the browser's bounded reader releases it.
 * Chromium can leave response.finished()/body() pending after reader cancellation.
 * This issues the original request once and forwards its exact bytes; it invents no result.
 */
export async function observeJsonAction(page: Page, url: string, action: () => Promise<unknown>): Promise<{ status: number, value: unknown }> {
  let captured: { status: number, body: Buffer } | undefined
  let request: ReturnType<Route['request']> | undefined
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return }
    request = route.request()
    const response = await route.fetch(), body = await response.body()
    captured = { status: response.status(), body }
    await route.fulfill({ response, body })
  }
  await page.route(url, handler)
  const delivered = page.waitForResponse(response => response.request() === request)
  void delivered.catch(() => {}) // If the action itself fails, do not leave an unhandled observation promise.
  try {
    await action()
    const response = await delivered
    if (!captured || captured.status !== response.status()) throw new Error('The original JSON response was not forwarded')
    return { status: response.status(), value: JSON.parse(captured.body.toString('utf8')) }
  } finally { await page.unroute(url, handler) }
}

/** Follow the visible secondary navigation, never force-click a hidden control. */
export async function clickHeaderAction(page: Page, name: string) {
  const action = page.getByRole('button', { name, exact: true })
  await page.getByRole('button', { name, exact: true, includeHidden: true }).waitFor({ state: 'attached' })
  if (await action.isVisible()) { await action.click(); return }
  if (['研究笔记', '结论与审阅', 'Research notes', 'Findings and review'].includes(name)) {
    await page.getByRole('button', { name: /^(研究工具|Research tools)$/u }).click()
    await action.click(); return
  }
  const more = page.getByRole('button', { name: '更多操作', exact: true })
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click()
  await page.getByRole('button', { name, exact: true }).click()
}
export async function revealDetailAction(action: Locator) {
  await action.waitFor({ state: 'attached', timeout: 60000 })
  if (await action.isVisible()) return
  const details = action.locator('xpath=ancestor::details[1]')
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
}
export async function clickDetailAction(action: Locator) {
  await revealDetailAction(action); await action.click()
}
