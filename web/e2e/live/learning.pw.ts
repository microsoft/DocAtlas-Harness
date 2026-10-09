import { clickHeaderAction, observeJsonAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { ProductBinding, ProductLearningCommand, ProductLearningOperation, ProductLearningView, ProductPreferenceInspectionV2, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { lineageHarness } from './lineage-harness.js'

const path = (cid: string) => `/api/conversations/${encodeURIComponent(cid)}`
const panel = (page: Page) => page.getByRole('dialog', { name: '偏好学习', exact: true })
function toolResult(messages: readonly unknown[], name: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === name)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`No successful native ${name}`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('No native tool content')
  const text: unknown = content.find(value => value && typeof value === 'object' && value.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('No native tool JSON')
  return JSON.parse(text)
}
async function openLearning(page: Page) {
  if (await panel(page).isVisible()) return
  await clickHeaderAction(page, '偏好')
  await page.getByRole('button', { name: '管理偏好学习与可选比较提示', exact: true }).click()
  await expect(panel(page)).toBeVisible()
}
async function policy(page: Page) {
  await clickHeaderAction(page, '偏好')
  const preferences = page.getByRole('dialog', { name: '偏好设置', exact: true })
  await preferences.getByRole('checkbox', { name: /^允许使用已有偏好/u }).check()
  await preferences.getByRole('checkbox', { name: /^允许为未来偏好积累信号/u }).check()
  await preferences.getByRole('button', { name: '保存会话开关', exact: true }).click()
  await expect(preferences.getByRole('status')).toContainText('设置保存已确认')
  await page.getByRole('button', { name: '关闭偏好设置', exact: true }).click()
}
async function pending(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes(':@learning:')).map(([key, raw]) => ({ key, raw })))
}

/** Real application/manager/Pi, completed private Answers, PDF bytes and profile transactions.
 * Only provider replies are scripted. Comparison/suggestion/learning themselves make no model calls.
 */
test('quietly invites after completion, accumulates three real investigations, recovers the original null receipt, explicitly adopts and observes future use with the original PDF intact', async ({ page }) => {
  test.setTimeout(300000); page.setDefaultTimeout(20000)
  const pdf = readFileSync('apps/web/public/documents/sample-report.pdf'), pdfHash = createHash('sha256').update(pdf).digest('hex')
  const texts = ['第一项研究的原文包含 Q4 营收条目。', '第二项研究重新读取了 Q4 条目。', '第三项研究核对同一原始 Q4 条目。', '明确采用偏好后，仍然重新读取原始 Q4 条目。']
  let source: ScopedSourceIdentity | undefined
  const rounds = texts.flatMap(text => [
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    (messages: readonly unknown[]) => {
      const sources = toolResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[] }
      expect(sources.sources).toHaveLength(1); source = sources.sources[0]!
      return { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    },
    (messages: readonly unknown[]) => {
      const result = parseContract('sidecar-document-rpc', toolResult(messages, 'docatlas_read'))
      if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected real page Read')
      const block = result.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]!
      expect(block.locator).toMatchObject({ ...source! }); return `[${text}](#docatlas.v1.support.${block.locator.locatorId})\n还有一项判断尚无充分出处。`
    },
  ])
  const fixture = await lineageHarness({ answers: ['第一条普通任务已完成。', '第二条普通任务已完成。', ...rounds] })
  let binding = fixture.parent, loseChoice = true
  const commands: ProductLearningCommand[] = [], operations: ProductLearningOperation[] = [], views: ProductLearningView[] = [], errors: string[] = [], originals: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const inspectPreferences = async (): Promise<ProductPreferenceInspectionV2> => {
    const response = await page.request.get(`${fixture.origin}${path(binding.conversationId)}/preferences/state`)
    expect(response.status()).toBe(200)
    return parseContract('product-personalization-v2', await response.json()) as ProductPreferenceInspectionV2
  }
  const lastView = () => [...views].reverse().find(value => value.binding.conversationId === binding.conversationId)!
  const next = async (action: () => Promise<unknown>) => {
    const count = operations.length; await action(); await expect.poll(() => operations.length, { timeout: 60000 }).toBe(count + 1)
    return operations[count]!
  }
  const ask = async (question: string, answer: string) => {
    await page.getByLabel('向 DocAtlas 提问').fill(question); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const message = page.getByRole('region', { name: '会话消息', exact: true }).locator('[data-message-entry]').filter({ hasText: answer })
    await expect(message).toBeVisible({ timeout: 60000 }); await fixture.waitIdle(binding.conversationId)
    return (await message.getAttribute('data-message-entry'))!
  }
  try {
    await page.route('**/learning', async route => {
      const input = parseContract('product-learning', route.request().postDataJSON())
      if (input.kind !== 'learning-command') throw new Error('Expected real learning command')
      commands.push(input)
      const response = await route.fetch(), bytes = await response.body(); expect(response.status()).toBe(200)
      const result = parseContract('product-learning', JSON.parse(bytes.toString('utf8')))
      if (result.kind !== 'learning-operation' || !result.receipt) throw new Error('Expected durable original receipt')
      operations.push(result)
      if (loseChoice && input.action === 'choose') { loseChoice = false; await route.abort('failed'); return }
      await route.fulfill({ response, body: bytes })
    })
    await page.route('**/learning/query', async route => {
      const response = await route.fetch(), bytes = await response.body(); expect(response.status()).toBe(200)
      const value = parseContract('product-learning', JSON.parse(bytes.toString('utf8')))
      if (value.kind !== 'learning-view') throw new Error('Expected real learning view')
      views.push(value); await route.fulfill({ response, body: bytes })
    })
    await page.route('**/documents/*/*/original', async route => {
      const response = await route.fetch(), bytes = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf'); expect(response.headers().etag).toBe(`"${pdfHash}"`); expect(bytes).toEqual(pdf)
      originals.push(route.request().url()); await route.fulfill({ response, body: bytes })
    })
    await page.goto(`${fixture.origin}/live.html`);
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled({ timeout: 30000 })
    await ask('第一条普通任务。', '第一条普通任务已完成。'); await ask('第二条普通任务。', '第二条普通任务已完成。')
    await openLearning(page); await expect(panel(page).getByRole('checkbox', { name: '允许偶尔建议阅读比较', exact: true })).not.toBeChecked()
    await panel(page).getByRole('checkbox', { name: '允许偶尔建议阅读比较', exact: true }).check()
    const setting = await next(() => panel(page).getByRole('button', { name: '保存学习提示设置', exact: true }).click())
    await expect(panel(page).locator(`[data-learning-receipt="${setting.operationId}"]`)).toBeVisible()
    expect(lastView().contributionAllowed).toBe(false); expect(lastView().offers).toEqual([])
    await page.getByRole('button', { name: '关闭偏好学习', exact: true }).click(); await policy(page)
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '偏好学习原文.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：偏好学习原文.pdf', exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：偏好学习原文.pdf', exact: true }).check(); await page.getByRole('button', { name: '回到对话', exact: true }).click()
    const firstMessage = await ask('第三次任务：读取第二页 Q4 原文，引用并保留不确定判断。', texts[0]!)
    const invitation = page.getByRole('complementary', { name: '可选阅读顺序比较邀请', exact: true })
    await expect(invitation).toBeVisible(); await expect(panel(page)).toHaveCount(0); expect(fixture.model.getCallCount()).toBe(5)
    await invitation.getByRole('button', { name: '比较阅读顺序', exact: true }).click()
    await expect(panel(page)).toBeVisible(); await page.getByRole('button', { name: '关闭偏好学习', exact: true }).click()
    expect(commands.filter(command => command.action === 'choose')).toHaveLength(0)
    await next(() => invitation.getByRole('button', { name: '不再显示这次邀请', exact: true }).click())
    await expect(invitation).toHaveCount(0)

    const recordChoice = async (messageId: string) => {
      await openLearning(page)
      await panel(page).getByLabel('用于学习比较的已保存回答', { exact: true }).selectOption(messageId)
      await next(() => panel(page).getByRole('button', { name: '准备这次学习比较', exact: true }).click())
      await expect(panel(page).locator('[data-probe-position]')).toHaveCount(2)
      const view = lastView(), probe = view.comparison!.probe!
      for (const card of await panel(page).locator('[data-probe-position]').all()) await expect(card).toHaveAttribute('data-probe-manifest', view.comparison!.material!.manifest.manifestId)
      const position = probe.presentationOrder.indexOf('variant:evidence-first') === 0 ? 'A' : 'B'
      await panel(page).getByRole('radio', { name: `学习呈现 ${position} 更合适`, exact: true }).check()
      await panel(page).getByLabel('学习选择作用范围', { exact: true }).selectOption('workspace')
      return next(() => panel(page).getByRole('button', { name: '记录为未来学习信号', exact: true }).click())
    }
    const first = await recordChoice(firstMessage)
    await expect(panel(page).getByRole('region', { name: '待核对的学习操作', exact: true })).toBeVisible()
    expect(first.receipt!.candidateId).toBeNull(); const frozen = await pending(page); expect(frozen).toHaveLength(1)
    const firstPosts = commands.filter(command => command.action === 'choose').length
    await page.reload(); await openLearning(page)
    await panel(page).getByRole('button', { name: '只读核对原学习操作', exact: true }).click()
    await expect.poll(() => pending(page)).toEqual([])
    expect(commands.filter(command => command.action === 'choose')).toHaveLength(firstPosts)
    await expect(panel(page).locator('[data-learning-status=collecting]').first()).toContainText('独立研究 1 项')
    expect((await inspectPreferences()).result.memories).toEqual([])
    await page.getByRole('button', { name: '关闭偏好学习', exact: true }).click()

    const investigations = new Set([lastView().groups.find(group => group.mode === 'explore')!.members[0]!.original.investigationId])
    let thirdMessage = firstMessage
    for (let index = 1; index < 3; index++) {
      await page.getByRole('button', { name: '历史', exact: true }).click()
      const response = await observeJsonAction(page, `${fixture.origin}/api/conversations`, () => page.getByRole('button', { name: '新建会话', exact: true }).click())
      expect(response.status).toBe(201)
      const value = parseContract('product-control', response.value); if (value.kind !== 'binding') throw new Error('Expected actual manager-created binding')
      binding = value as ProductBinding; await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled({ timeout: 30000 }); await policy(page)
      await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click(); await page.getByRole('checkbox', { name: '用于提问：偏好学习原文.pdf', exact: true }).check()
      await page.getByRole('button', { name: '回到对话', exact: true }).click()
      thirdMessage = await ask('这项独立研究请重新读取第二页Q4内容，引用原PDF。', texts[index]!)
      const chosen = await recordChoice(thirdMessage)
      await expect(panel(page).locator(`[data-learning-receipt="${chosen.operationId}"]`)).toBeVisible()
      await expect(panel(page).getByRole('region', { name: '跨研究学习积累', exact: true })).toContainText(`独立研究 ${index + 1} 项`)
      lastView().groups.find(group => group.mode === 'explore')!.members.forEach(member => investigations.add(member.original.investigationId))
      if (index === 1) { expect(chosen.receipt!.candidateId).toBeNull(); await page.getByRole('button', { name: '关闭偏好学习', exact: true }).click() }
    }
    expect(investigations.size).toBe(3); expect((await inspectPreferences()).result.memories).toEqual([]); expect(fixture.model.getCallCount()).toBe(11)
    const original = fixture.documents.answers.get(binding.conversationId, thirdMessage)
    const adopted = await next(() => panel(page).getByRole('button', { name: '单独确认工作区默认顺序', exact: true }).click())
    await expect(panel(page).locator(`[data-learning-receipt="${adopted.operationId}"]`)).toBeVisible()
    expect(adopted.receipt!.memoryVersionId).toBeTruthy(); expect((await inspectPreferences()).result.counts.uses).toBe(0)
    expect(fixture.documents.answers.get(binding.conversationId, thirdMessage)).toEqual(original)
    const old = await page.request.get(`${fixture.origin}${path(fixture.parent.conversationId)}/learning/operations/${encodeURIComponent(first.operationId)}`)
    expect(old.status()).toBe(200); expect((await old.json() as ProductLearningOperation).receipt).toEqual(first.receipt)
    await page.getByRole('button', { name: '关闭偏好学习', exact: true }).click()
    const later = await ask('这是采用后的下一次明确提问；重新读取Q4并仍使用原始PDF引用。', texts[3]!)
    const usage = await inspectPreferences()
    expect(usage.result.uses).toHaveLength(1); expect(usage.result.uses[0]).toMatchObject({ memoryVersionId: adopted.receipt!.memoryVersionId, effect: { key: 'answer-order', value: 'evidence-first' } })
    await page.locator(`[data-message-entry="${later}"] .live-citation`).click()
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 }); await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    expect(originals.length).toBeGreaterThan(0); expect(fixture.model.getCallCount()).toBe(14); expect(errors).toEqual([])
  } finally { await fixture.close() }
})
