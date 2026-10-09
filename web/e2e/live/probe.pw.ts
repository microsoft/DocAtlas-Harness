import { clickDetailAction, clickHeaderAction, observeJsonAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import AxeBuilder from '@axe-core/playwright'
import type { ProductPreferenceInspectionV2, ProductProbeChoose, ProductProbeChoiceResult, ProductProbePrepare, ProductProbeReview, ProductProbeReviewResult, ProductProbeView, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'

const conversationId = 'conversation:browser', basePath = `/api/conversations/${encodeURIComponent(conversationId)}`
function actualResult(messages: readonly unknown[], tool: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === tool)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`Missing successful real ${tool} result`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('Missing real tool content')
  const text = content.find(value => value && typeof value === 'object' && value.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Missing native JSON tool content')
  return JSON.parse(text)
}
function actualBlock(messages: readonly unknown[], source: ScopedSourceIdentity): TextBlockItem {
  const result = parseContract('sidecar-document-rpc', actualResult(messages, 'docatlas_read'))
  if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected genuine native page Read')
  const block = result.items.filter((value): value is TextBlockItem => value.itemType === 'block' && value.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]
  if (!block) throw new Error('No Q4 block in actual original PDF')
  expect(block.locator).toMatchObject({ ...source }); expect(block.physicalPage).toBe(2)
  return block
}
async function preferences(page: Page, origin: string): Promise<ProductPreferenceInspectionV2> {
  const response = await page.request.get(`${origin}${basePath}/preferences/state`)
  expect(response.status()).toBe(200)
  const result = parseContract('product-personalization-v2', await response.json())
  if (result.kind !== 'preference-inspection') throw new Error('Expected real profile inspection')
  return result
}
async function pending(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@probe:')).map(([key, raw]) => ({ key, raw })))
}

/** Only provider wording is scripted. A/B is NOT another generated answer: both views
 * consume the same real saved Answer, Evidence and warnings; all choices and uses are durable host records. */
test('compares one canonical Answer, restores a lost choice read-only, independently confirms a workspace candidate, and observes its future Pi use with original PDF citations intact', async ({ page }) => {
  test.skip(true, 'ADR-062: the user removed Answer options and its standalone comparison panel. Retained as the retired UI journey; API/outbox/learning tests remain active, and answers.pw.ts checks absence.')
  test.setTimeout(210000)
  const pdf = readFileSync('apps/web/public/documents/sample-report.pdf'), pdfHash = createHash('sha256').update(pdf).digest('hex')
  const firstText = '第二页真实原文列有 Q4 营收。', unresolvedText = '这一补充判断尚未找到出处。', laterText = '下一次独立问题仍可核对同一份 Q4 原文。'
  let source: ScopedSourceIdentity | undefined, firstBlock: TextBlockItem | undefined
  const fixture = await liveHarness({ documents: true, answers: [
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    messages => {
      const result = actualResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[] }
      expect(result.sources).toHaveLength(1); source = result.sources[0]!
      return { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    },
    messages => {
      firstBlock = actualBlock(messages, source!)
      return `[${firstText}](#docatlas.v1.support.${firstBlock.locator.locatorId})\n[${unresolvedText}](#docatlas.v1.support.loc:unknown-probe-source)`
    },
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    messages => {
      const result = actualResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[] }
      expect(result.sources).toEqual([source])
      return { calls: [{ name: 'docatlas_read', args: { documentId: source!.documentId, revisionId: source!.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    },
    messages => {
      const block = actualBlock(messages, source!); expect(block.locator.locatorId).toBe(firstBlock!.locator.locatorId)
      return `[${laterText}](#docatlas.v1.support.${block.locator.locatorId})`
    },
  ] })
  const prepared: ProductProbePrepare[] = [], choices: ProductProbeChoose[] = [], chosen: ProductProbeChoiceResult[] = [], reviews: ProductProbeReview[] = [], reviewed: ProductProbeReviewResult[] = [], views: ProductProbeView[] = [], originalUrls: string[] = [], errors: string[] = []
  let dropChoice = true
  const drawer = page.getByRole('dialog', { name: '比较两种呈现', exact: true }), preferenceDrawer = page.getByRole('dialog', { name: '偏好设置', exact: true })
  const originalMessage = page.locator('.live-message.assistant').filter({ hasText: firstText })
  const openProbe = async () => {
    await clickDetailAction(originalMessage.getByRole('button', { name: '比较两种呈现', exact: true, includeHidden: true }))
    await expect(drawer).toBeVisible(); await expect(drawer.getByRole('button', { name: '刷新比较状态（只读）', exact: true })).toBeEnabled()
  }
  const setContribution = async (enabled: boolean) => {
    await clickHeaderAction(page, '偏好')
    const existing = preferenceDrawer.getByRole('checkbox', { name: /允许使用已有偏好/u }), contribution = preferenceDrawer.getByRole('checkbox', { name: /允许为未来偏好积累信号/u })
    await expect(existing).toBeEnabled(); await existing.check()
    if (enabled) await contribution.check(); else await contribution.uncheck()
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${fixture.origin}${basePath}/preferences`)
    await preferenceDrawer.getByRole('button', { name: '保存会话开关', exact: true }).click()
    const response = await responsePromise; expect(response.status()).toBe(200); expect(await response.finished()).toBeNull()
    await expect.poll(async () => (await preferences(page, fixture.origin)).result.sessionPolicy).toMatchObject({ useExisting: true, contributeToFuture: enabled })
    await expect(preferenceDrawer.getByRole('button', { name: '保存会话开关', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '关闭偏好设置', exact: true }).click()
  }
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('**/preferences/probes/*', async route => {
      const input = parseContract('product-probe', route.request().postDataJSON())
      if (input.kind === 'probe-prepare') prepared.push(input)
      else if (input.kind === 'probe-choose') choices.push(input)
      else if (input.kind === 'probe-review') reviews.push(input)
      const response = await route.fetch(), body = await response.body(); expect(response.status()).toBe(200)
      const value = parseContract('product-probe', JSON.parse(body.toString('utf8')))
      if (value.kind === 'probe-view') views.push(value)
      else if (value.kind === 'probe-choice-result') {
        chosen.push(value)
        if (dropChoice) { dropChoice = false; await route.abort('failed'); return } // The server has committed; only delivery is lost.
      } else if (value.kind === 'probe-review-result') reviewed.push(value)
      else throw new Error('Unexpected Probe response')
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf'); expect(response.headers().etag).toBe(`"${pdfHash}"`); expect(body).toEqual(pdf)
      originalUrls.push(route.request().url()); await route.fulfill({ response, body })
    })
    await page.goto(`${fixture.origin}/live.html`);
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await setContribution(false)
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '呈现比较原文.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：呈现比较原文.pdf', exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：呈现比较原文.pdf', exact: true }).check(); await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('请基于第二页Q4原文回答，并保留尚不能核验的判断。'); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(originalMessage.locator('.live-citation')).toHaveCount(1, { timeout: 60000 }); await fixture.coordinator.waitForIdle()
    expect(fixture.model.getCallCount()).toBe(3)
    await openProbe(); await expect(drawer.getByRole('button', { name: '准备这份回答的两种呈现', exact: true })).toBeDisabled()
    expect(views.at(-1)).toMatchObject({ reason: 'ready', contributionAllowed: false, probe: null, choiceReceipt: null, candidate: null })
    expect(prepared).toHaveLength(0); expect(choices).toHaveLength(0)
    await page.getByRole('button', { name: '关闭比较两种呈现', exact: true }).click()
    await setContribution(true); await openProbe()
    await drawer.getByRole('button', { name: '准备这份回答的两种呈现', exact: true }).click()
    await expect(drawer.locator('[data-probe-position]')).toHaveCount(2)
    const first = views.at(-1)!, manifest = structuredClone(first.material!.manifest), probe = structuredClone(first.probe!)
    expect(prepared).toHaveLength(1); expect(fixture.model.getCallCount()).toBe(3) // A/B made zero additional provider requests.
    expect(probe.backbone.evidenceAtomIds).toHaveLength(1); expect(probe.backbone.claimVersionIds).toEqual([]); expect(probe.backbone.uncertaintyIds.length).toBeGreaterThan(0)
    for (const [index, position] of ['A', 'B'].entries()) {
      const card = drawer.locator(`[data-probe-position="${position}"]`), variant = probe.variants.find(value => value.variantKey === probe.presentationOrder[index])!
      await expect(card).toHaveAttribute('data-probe-manifest', manifest.manifestId)
      await expect(card.getByText(firstText, { exact: false })).toBeVisible(); await expect(card).toContainText(unresolvedText)
      expect(await card.locator('[data-probe-section]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-probe-section')))).toEqual(variant.effect.value === 'conclusion-first' ? ['answer', 'evidence'] : ['evidence', 'answer'])
    }
    await expect(drawer.locator('[data-probe-warning="unknown-locator"]')).toHaveCount(2)
    expect((await new AxeBuilder({ page }).include('.live-probe').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(drawer).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.live-probe').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
    await page.setViewportSize({ width: 1440, height: 1000 })
    const canonicalBefore = fixture.documents!.answers.get(conversationId, manifest.messageId)
    const citation = manifest.citations[0]!, citationPath = `${fixture.origin}${basePath}/answers/${encodeURIComponent(manifest.messageId)}/citations/${encodeURIComponent(citation.citationId)}`
    const focusResponse = await observeJsonAction(page, citationPath,
      () => drawer.locator('[data-probe-position="A"]').getByRole('button', { name: '核对完整出处 1 · 支持 · 原始 PDF', exact: true }).click())
    expect(focusResponse.status).toBe(200)
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 }); await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    await expect(drawer).toHaveCount(0); await openProbe()
    expect(views.at(-1)!.probe).toEqual(probe); expect(prepared).toHaveLength(1)
    const selectedPosition = probe.presentationOrder.indexOf('variant:evidence-first') === 0 ? 'A' : 'B'
    await drawer.getByRole('radio', { name: `更容易理解呈现 ${selectedPosition}`, exact: true }).check()
    await drawer.getByLabel('呈现选择作用范围', { exact: true }).selectOption('workspace')
    await drawer.getByRole('checkbox', { name: '核验更容易', exact: true }).check()
    await drawer.getByRole('button', { name: '关闭且不记录新选择', exact: true }).click()
    expect(choices).toHaveLength(0); expect((await preferences(page, fixture.origin)).result.memories).toHaveLength(0)
    await openProbe(); await expect(drawer.getByRole('radio', { name: `更容易理解呈现 ${selectedPosition}`, exact: true })).toBeChecked()
    await drawer.getByRole('button', { name: '记录为待确认候选', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '使用原键核对呈现操作', exact: true })).toBeEnabled()
    expect(choices).toHaveLength(1); expect(chosen).toHaveLength(1); expect(chosen[0]!.status).toBe('created')
    expect(choices[0]).toMatchObject({ messageId: manifest.messageId, probeId: probe.probeId, selected: 'variant:evidence-first', scopeIntent: 'workspace', reasonTags: ['easier-verification'], expectedProfileEpoch: first.profileEpoch, expectedPolicyVersion: first.policyVersion })
    const retained = await pending(page); expect(retained).toHaveLength(1)
    expect(JSON.parse(retained[0]!.raw).request).toEqual(choices[0]); expect(retained[0]!.raw).not.toContain(firstBlock!.text)
    const beforeConfirmation = await preferences(page, fixture.origin)
    expect(beforeConfirmation.result.memories).toHaveLength(0); expect(beforeConfirmation.result.counts.uses).toBe(0); expect(reviews).toHaveLength(0)
    await page.reload(); await openProbe()
    await expect.poll(() => pending(page)).toEqual([])
    await expect(drawer.getByRole('region', { name: '已保存的呈现选择', exact: true })).toBeVisible()
    await expect(drawer.getByRole('region', { name: '独立确认工作区偏好', exact: true })).toBeVisible()
    expect(choices).toHaveLength(1); expect(prepared).toHaveLength(1); expect(reviews).toHaveLength(0)
    expect(views.at(-1)).toMatchObject({ choiceReceipt: { idempotencyKey: choices[0]!.idempotencyKey, requestHash: chosen[0]!.requestHash, candidateId: chosen[0]!.candidateId }, candidate: { decision: 'pending', version: 1 } })
    expect(fixture.model.getCallCount()).toBe(3)
    await page.getByRole('button', { name: '关闭比较两种呈现', exact: true }).click()
    await setContribution(false); await openProbe() // Historical choice remains readable; confirmation is a separate explicit authority.
    expect(views.at(-1)!.contributionAllowed).toBe(false)
    await expect(drawer.getByRole('button', { name: '单独确认此工作区偏好', exact: true })).toBeEnabled()
    await drawer.getByRole('button', { name: '单独确认此工作区偏好', exact: true }).click()
    await expect(drawer.getByRole('region', { name: '候选确认的持久回执', exact: true })).toBeVisible()
    await expect.poll(() => pending(page)).toEqual([])
    expect(reviews).toHaveLength(1); expect(reviewed).toHaveLength(1)
    const activated = reviewed[0]!.result.memoryVersion!
    expect(activated).toMatchObject({ status: 'active', candidateId: chosen[0]!.candidateId, effect: { key: 'answer-order', value: 'evidence-first' }, scope: { kind: 'workspace', workspaceId: 'workspace:browser' } })
    expect(reviewed[0]!.result.candidate).toMatchObject({ version: 2, decision: 'promote' })
    expect(fixture.documents!.answers.get(conversationId, manifest.messageId)).toEqual(canonicalBefore)
    expect((await preferences(page, fixture.origin)).result.counts.uses).toBe(0); expect(fixture.model.getCallCount()).toBe(3)
    await page.getByRole('button', { name: '关闭比较两种呈现', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('这是下一次独立提问，请再次读取Q4原文并保留原始PDF引用。'); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const later = page.locator('.live-message.assistant').filter({ hasText: laterText })
    await expect(later.locator('.live-citation')).toHaveCount(1, { timeout: 60000 }); await fixture.coordinator.waitForIdle()
    const used = await preferences(page, fixture.origin)
    expect(used.useSemantics).toBe('observed-answer-generation'); expect(used.result.uses).toHaveLength(1)
    expect(used.result.uses[0]).toMatchObject({ memoryVersionId: activated.memoryVersionId, effect: { key: 'answer-order', value: 'evidence-first' } })
    expect(used.result.decisions.find(value => value.decisionId === used.result.uses[0]!.decisionId)?.why.some(value => value.memoryVersionId === activated.memoryVersionId)).toBe(true)
    expect(fixture.model.getCallCount()).toBe(6)
    const laterResponse = await observeJsonAction(page, '**/answers/*/citations/*', () => later.locator('.live-citation').click())
    expect(laterResponse.status).toBe(200)
    const original = parseContract('product-answer', laterResponse.value)
    expect(original).toMatchObject({ kind: 'citation-focus', status: 'resolved', exactText: firstBlock!.text, original: { documentId: source!.documentId, revisionId: source!.revisionId, contentHash: pdfHash } })
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 }); await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    expect(originalUrls.length).toBeGreaterThan(0); expect(new Set(originalUrls).size).toBe(1)
    await clickHeaderAction(page, '偏好')
    const uses = page.getByRole('region', { name: '偏好生成阶段使用记录', exact: true })
    await expect(uses).toContainText('回答顺序 · 先看证据'); await expect(uses).toContainText('不证明模型遵从、事实正确或页面已展示')
    await page.reload(); await clickHeaderAction(page, '偏好'); await expect(uses.locator('li')).toHaveCount(1)
    expect(fixture.model.getCallCount()).toBe(6); expect(choices).toHaveLength(1); expect(reviews).toHaveLength(1); expect(errors).toEqual([])
  } finally { await fixture.close() }
})
