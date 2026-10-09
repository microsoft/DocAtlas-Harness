import { clickHeaderAction } from './ui.js'
import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { ProductReviewCommand, ProductReviewResult, ProductReviewWorkspace, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'

const reviewPath = '/api/conversations/conversation%3Abrowser/reviews'
function actualToolResult(messages: readonly unknown[], name: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === name)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error('Missing actual successful native tool result')
  const content = Reflect.get(message, 'content') as Array<{ type: string, text?: string }>
  const text = content.find(item => item.type === 'text')?.text
  if (!text) throw new Error('Missing actual Read JSON')
  return JSON.parse(text)
}
async function workspace(page: Page, origin: string): Promise<ProductReviewWorkspace> {
  const response = await page.request.get(`${origin}${reviewPath}`)
  expect(response.status()).toBe(200)
  const value = parseContract('product-review', await response.json())
  if (value.kind !== 'review-workspace') throw new Error('Expected real review workspace')
  return value
}
async function pending(page: Page): Promise<Array<{ key: string, raw: string }>> {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@reviews:'))
    .map(([key, raw]) => ({ key, raw })))
}

test('real Pi evidence becomes a human Claim and reviewed immutable Brief/Matrix, with original-key recovery and original PDF citations', async ({ page }, info) => {
  test.setTimeout(180000)
  const pdf = readFileSync('apps/web/public/documents/sample-report.pdf')
  let source: ScopedSourceIdentity | undefined, block: TextBlockItem | undefined
  const fixture = await liveHarness({ documents: true, answers: [
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    messages => {
      const result = actualToolResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[] }
      source = result.sources[0]!
      return { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    },
    messages => {
      const result = parseContract('sidecar-document-rpc', actualToolResult(messages, 'docatlas_read'))
      if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected real page Read')
      block = result.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]
      if (!block) throw new Error('Real PDF has no Q4 source block')
      return `[第二页列有季度营收条目。](#docatlas.v1.support.${block.locator.locatorId})`
    },
  ] })
  const commands: ProductReviewCommand[] = [], receipts: ProductReviewResult[] = [], errors: string[] = []
  let dropClaim = true
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('**/api/conversations/*/reviews', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const command = parseContract('product-review', route.request().postDataJSON())
      if (command.kind !== 'review-command') throw new Error('Expected human command')
      commands.push(command)
      const response = await route.fetch(), bytes = await response.body()
      expect(response.ok()).toBe(true)
      const receipt = parseContract('product-review', JSON.parse(bytes.toString('utf8')))
      if (receipt.kind !== 'review-result') throw new Error('Expected durable M4 receipt')
      receipts.push(receipt)
      if (command.action === 'claim-save' && dropClaim) { dropClaim = false; await route.abort('failed') }
      else await route.fulfill({ response, body: bytes }) // No fabricated success or review gate.
    })
    await page.goto(`${fixture.origin}/live.html`)

    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await clickHeaderAction(page, '结论与审阅')
    await expect(page.getByText('当前尚无已准备的资料范围。请先基于文档发起研究，再回到此处整理证据。', { exact: true })).toBeVisible()
    expect(fixture.model.getCallCount()).toBe(0)
    await page.getByRole('button', { name: '关闭结论与审阅', exact: true }).click()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '人工审阅报告.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：人工审阅报告.pdf' })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：人工审阅报告.pdf' }).check()
    await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('核对第二页Q4营收条目，给出原始PDF引用。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.live-answer-body .live-citation')).toHaveCount(1, { timeout: 60000 })
    await fixture.coordinator.waitForIdle()
    expect(fixture.model.getCallCount()).toBe(3)
    const nativeContexts = [...fixture.contexts]
    await clickHeaderAction(page, '结论与审阅')
    await expect(page.locator('[data-review-evidence]')).toHaveCount(1)
    const before = await workspace(page, fixture.origin), evidence = before.evidence[0]!
    expect(evidence.documentId).toBe(source!.documentId)
    expect(evidence.physicalPage).toBe(2)
    await page.getByRole('checkbox', { name: `选择证据 ${evidence.evidenceId}`, exact: true }).check()
    await page.getByRole('button', { name: '核对原始 PDF', exact: true }).click()
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    await clickHeaderAction(page, '结论与审阅')
    const statement = '第二页原文列示了 Q4 的营收条目。'
    await page.getByLabel('结论正文', { exact: true }).fill(statement)
    await page.getByLabel('结论证据判断', { exact: true }).selectOption('supported')
    await page.getByLabel('结论人工审阅状态', { exact: true }).selectOption('accepted')
    await page.getByRole('button', { name: '保存新结论', exact: true }).click()
    await expect(page.getByRole('button', { name: '使用原键核对操作', exact: true })).toBeEnabled()
    const retained = await pending(page)
    expect(retained).toHaveLength(1)
    const committed = await workspace(page, fixture.origin)
    expect(committed.claims).toHaveLength(1)
    expect(committed.evidenceRelations[0]).toMatchObject({ evidenceId: evidence.evidenceId, reviewStatus: 'human-confirmed' })
    const claimId = committed.claims[0]!.claimVersionId
    expect(commands).toHaveLength(1)
    await page.reload()
    await clickHeaderAction(page, '结论与审阅')
    await expect(page.getByRole('button', { name: '使用原键核对操作', exact: true })).toBeEnabled()
    expect(commands).toHaveLength(1); expect(await pending(page)).toEqual(retained)
    await page.getByRole('button', { name: '使用原键核对操作', exact: true }).click()
    await expect.poll(() => pending(page)).toEqual([])
    expect(commands[1]).toEqual(commands[0])
    expect(receipts[1]!.result).toMatchObject({ resultType: 'm4-claim-record', status: 'replayed', claim: { claimVersionId: claimId } })
    await expect(page.locator('[data-review-claim]')).toHaveCount(1)
    await page.getByRole('button', { name: /^成果与审阅/u }).click()
    for (const kind of ['brief', 'matrix'] as const) {
      await page.getByLabel('成果标题', { exact: true }).fill(`Q4 核对 ${kind}`)
      await page.getByLabel('成果形式', { exact: true }).selectOption(kind)
      await page.getByRole('group', { name: '选择结论及其用途', exact: true }).getByRole('checkbox').check()
      await page.getByRole('button', { name: '创建成果草稿', exact: true }).click()
      await expect.poll(() => pending(page)).toEqual([])
      await expect(page.getByRole('article', { name: '不可变成果内容', exact: true })).toContainText(`Q4 核对 ${kind}`)
      await page.getByRole('button', { name: '运行 G0–G4 审阅', exact: true }).click()
      await expect.poll(() => pending(page)).toEqual([])
      if (kind === 'brief') {
        await expect(page.getByRole('region', { name: '确定性审阅结果', exact: true })).toContainText('存在阻塞项')
        await expect(page.getByRole('button', { name: '人工批准此审阅', exact: true })).toBeDisabled()
      }
      await page.getByRole('checkbox', { name: /我已核对当前列出的支持/u }).check()
      await page.getByRole('button', { name: '保存材料核对声明', exact: true }).click()
      await expect.poll(() => pending(page)).toEqual([])
      await page.getByRole('button', { name: '运行 G0–G4 审阅', exact: true }).click()
      await expect.poll(() => pending(page)).toEqual([])
      await expect(page.getByRole('region', { name: '确定性审阅结果', exact: true })).toContainText('需要人工签署')
      await expect(page.locator('[data-review-gate]')).toHaveCount(5)
      page.once('dialog', async dialog => { await dialog.accept() })
      await page.getByRole('button', { name: '人工批准此审阅', exact: true }).click()
      await expect(page.getByRole('button', { name: '发布本地成果', exact: true })).toBeEnabled()
      if (kind === 'brief') {
        await page.getByRole('button', { name: '人工拒绝此审阅', exact: true }).click()
        await expect.poll(() => pending(page)).toEqual([])
        await expect(page.getByRole('button', { name: '发布本地成果', exact: true })).toBeDisabled()
        page.once('dialog', async dialog => { await dialog.accept() })
        await page.getByRole('button', { name: '人工批准此审阅', exact: true }).click()
        await expect(page.getByRole('button', { name: '发布本地成果', exact: true })).toBeEnabled()
      }
      page.once('dialog', async dialog => { await dialog.accept() })
      await page.getByRole('button', { name: '发布本地成果', exact: true }).click()
      await expect.poll(() => pending(page)).toEqual([])
      await expect(page.getByRole('article', { name: '不可变成果内容', exact: true })).toContainText('本地已发布')
    }
    const saved = await workspace(page, fixture.origin)
    expect(saved.artifacts).toHaveLength(2)
    expect(saved.artifacts.every(value => value.status === 'published' && value.publication?.humanReviewDecisionId)).toBe(true)
    await page.getByRole('button', { name: '关系图', exact: true }).click()
    await expect(page.locator('[data-review-graph-node]')).toHaveCount(6)
    await page.locator(`[data-review-graph-node="c:${claimId}"]`).click()
    await expect(page.getByRole('list', { name: '已保存的直接关系', exact: true })).toContainText('支持')
    await page.screenshot({ path: info.outputPath('review-relationships.png') })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.locator(`[data-review-graph-node="e:${evidence.evidenceId}"]`).click()
    await page.getByRole('button', { name: '核对原始 PDF', exact: true }).click()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    await page.reload(); await clickHeaderAction(page, '结论与审阅')
    await page.getByRole('button', { name: /^成果与审阅/u }).click()
    await page.getByRole('button', { name: /Q4 核对 matrix/u }).click()
    await expect(page.getByRole('region', { name: '成果对照表', exact: true })).toContainText(statement)
    await page.getByRole('button', { name: `核对成果引用 ${evidence.evidenceId}`, exact: true }).click()
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    const recovered = await workspace(page, fixture.origin)
    expect(recovered.artifacts.map(value => [value.artifactManifestId, value.contentHash])).toEqual(saved.artifacts.map(value => [value.artifactManifestId, value.contentHash]))
    expect(fixture.contexts).toEqual(nativeContexts)
    expect(fixture.model.getCallCount()).toBe(3)
    expect(errors).toEqual([])
  } finally { await fixture.close() }
})
