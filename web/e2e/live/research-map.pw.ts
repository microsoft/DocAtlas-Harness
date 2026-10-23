import { test, expect } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import type { EnrichmentTree, HumanResearchOperation, HumanResearchFocus } from '@docatlas/contracts'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'
import { clickHeaderAction } from './ui.js'

test('saved PDF notes become added/revised research nodes, open exact originals and retract on deletion without changing the original map', async ({ page }, info) => {
  test.setTimeout(180000)
  page.setDefaultTimeout(15000)
  const fixture = await liveHarness({ documents: true, enrichmentAnswers: [] }), trees: EnrichmentTree[] = [], operations: HumanResearchOperation[] = [], focuses: HumanResearchFocus[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept())
  try {
    await page.route('**/tree', async route => { const response = await route.fetch(), body = await response.body(); if (response.ok()) trees.push(JSON.parse(body.toString())); await route.fulfill({ response, body }) })
    await page.route('**/research-workbench', async route => { const response = await route.fetch(), body = await response.body(); if (response.ok() && route.request().method() === 'POST') operations.push(JSON.parse(body.toString())); await route.fulfill({ response, body }) })
    await page.route('**/research-workbench/entries/*/focus/*', async route => {
      const response = await route.fetch(), body = await response.body()
      if (response.ok()) focuses.push(JSON.parse(body.toString()))
      await route.fulfill({ response, body })
    })
    await page.goto(`${fixture.origin}/live.html`)
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.locator('input[type=file]').setInputFiles({ name: '研究地图.pdf', mimeType: 'application/pdf', buffer: longPdf({ nestedToc: true }) })
    await expect(page.locator('.live-upload-status')).toContainText('已添加，可以提问了', { timeout: 60000 })
    await page.getByTitle('打开原始 PDF：研究地图.pdf', { exact: true }).click()
    const reader = page.getByRole('region', { name: '原始 PDF 阅读器', exact: true }), map = page.getByRole('dialog', { name: '文档地图', exact: true })
    await expect(reader.locator('.pdf-paper[data-page="1"][data-rendered=true]')).toBeVisible()
    await reader.getByRole('button', { name: '地图', exact: true }).click()
    // The first real Flash tree launches the isolated document worker; use
    // the same cold-tree deadline as document-map.pw.ts, not a DOM-only 5s wait.
    await expect(map.locator('[data-map-node]').first()).toBeVisible({ timeout: 30000 })
    const originalHash = trees[0]!.tree.treeHash, originalNodes = structuredClone(trees[0]!.tree.nodes)
    await map.getByRole('button', { name: '关闭文档地图', exact: true }).click()
    await expect(map).toBeHidden()
    await reader.locator('.pdf-text-layer').first().evaluate(layer => {
      const span = [...layer.querySelectorAll('span')].find(item => !item.children.length && item.textContent?.includes('observation 1:'))!
      const range = document.createRange(); range.selectNodeContents(span)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    await page.getByRole('button', { name: '保存到研究', exact: true }).click()
    const notes = page.getByRole('dialog', { name: '研究笔记', exact: true }), body = '需要复核这些实验观测的统计口径。'
    await notes.getByLabel('人类研究完整正文', { exact: true }).fill(body)
    await notes.getByRole('checkbox', { name: /确认保存此研究内容与明确关联/ }).check()
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/research-workbench'))
    await notes.getByRole('button', { name: '保存到研究', exact: true }).click()
    expect((await saved).ok()).toBe(true)
    await expect(notes.locator('[data-human-receipt]')).toBeVisible()
    const recordId = operations[0]!.receipt!.recordId
    await page.screenshot({ path: info.outputPath('notes-workspace.png') })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await notes.getByRole('button', { name: '关闭研究笔记', exact: true }).click()
    await reader.getByRole('button', { name: '地图', exact: true }).click()
    const node = map.locator(`[data-map-research="${recordId}"]`)
    await expect(node).toHaveClass(/change-added/)
    await node.getByRole('button').click()
    await expect(map.locator('[data-map-research-detail]')).toContainText(body)
    await map.getByRole('button', { name: '原始结构', exact: true }).click()
    await expect(node).toHaveCount(0)
    await expect(map.locator('[data-map-node]')).toHaveCount(originalNodes.length + 1)
    await map.getByRole('button', { name: /^研究视图/ }).click()
    await node.getByRole('button').click()
    await map.getByRole('button', { name: '查看笔记全文与版本', exact: true }).click()
    await expect(notes.getByLabel('人类研究完整正文', { exact: true })).toHaveValue(body)
    await notes.getByLabel('人类研究完整正文', { exact: true }).fill(`${body} 补充：记录修订。`)
    const revised = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/research-workbench'))
    await notes.getByRole('button', { name: '保存研究新版本', exact: true }).click()
    expect((await revised).ok()).toBe(true)
    await expect(notes.locator('[data-human-receipt]')).toContainText('v2')
    await notes.getByRole('button', { name: '关闭研究笔记', exact: true }).click()
    await reader.getByRole('button', { name: '地图', exact: true }).click()
    await expect(node).toHaveClass(/change-updated/)
    await node.getByRole('button').click()
    await expect(map.locator('[data-map-research-detail]')).toContainText('v2')
    await page.screenshot({ path: info.outputPath('research-map-updated.png') })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    // The authenticated resolver performs real PDF work. Its response is the
    // boundary before the unchanged 5s DOM highlight assertion, not click dispatch.
    const focused = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/research-workbench/entries/') && response.url().includes('/focus/'))
    await map.getByRole('button', { name: '回到原文位置', exact: true }).click()
    const focusResponse = await focused
    expect(focusResponse.ok()).toBe(true)
    expect(focuses.at(-1)).toMatchObject({ kind: 'human-research-focus', focus: { recordId, status: 'resolved' } })
    await expect(map).toBeHidden()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    await expect(page.locator('[data-focus-status]')).toHaveAttribute('data-focus-status', 'exact')
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByTitle('打开原始 PDF：研究地图.pdf', { exact: true }).click()
    const reopenedTree = page.waitForResponse(response => response.url().endsWith('/tree'))
    await reader.getByRole('button', { name: '地图', exact: true }).click()
    expect((await reopenedTree).ok()).toBe(true)
    await expect(node).toHaveClass(/change-updated/)
    expect(trees.every(value => value.tree.treeHash === originalHash && JSON.stringify(value.tree.nodes) === JSON.stringify(originalNodes))).toBe(true)
    await node.getByRole('button').click()
    await map.getByRole('button', { name: '查看笔记全文与版本', exact: true }).click()
    const removed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/research-workbench'))
    await notes.getByRole('button', { name: '软删除研究记录', exact: true }).click()
    expect((await removed).ok()).toBe(true)
    await expect(notes.locator('[data-human-receipt]')).toContainText('v3')
    await notes.getByRole('button', { name: '关闭研究笔记', exact: true }).click()
    await reader.getByRole('button', { name: '地图', exact: true }).click()
    await expect(map.getByRole('button', { name: '刷新研究更新', exact: true })).toBeEnabled()
    await expect(node).toHaveCount(0)
    await map.getByRole('button', { name: '关闭文档地图', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await clickHeaderAction(page, '研究笔记')
    // Inspect final contrast after both the panel and its backdrop finish fading in.
    await notes.evaluate(async element => {
      const backdrop = element.parentElement
      if (!backdrop) throw new Error('Notebook dialog has no backdrop')
      await Promise.all([...element.getAnimations(), ...backdrop.getAnimations()].map(animation => animation.finished))
    })
    expect(await notes.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await notes.getByRole('button', { name: '关闭研究笔记', exact: true }).click()
    await page.getByRole('button', { name: 'EN', exact: true }).click()
    await page.getByRole('button', { name: 'Research tools', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Research notes', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Findings and review', exact: true })).toBeVisible()
    expect(fixture.model.getCallCount()).toBe(0); expect(fixture.enrichmentModel!.getCallCount()).toBe(0); expect(errors).toEqual([])
  } finally { await fixture.close() }
})
