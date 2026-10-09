import { clickHeaderAction, clickDetailAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { ProductContinuityAssess, ProductContinuityAssessment, ProductContinuityInspection, ProductContinuityImpactResult, ProductReviewCommand, ProductReviewWorkspace, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

const conversationId = 'conversation:browser', workspaceId = 'workspace:browser', basePath = `/api/conversations/${encodeURIComponent(conversationId)}`
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function toolResults(messages: readonly unknown[], name: string): unknown[] {
  return messages.flatMap(message => {
    if (!message || typeof message !== 'object' || Reflect.get(message, 'role') !== 'toolResult' || Reflect.get(message, 'toolName') !== name) return []
    if (Reflect.get(message, 'isError')) throw new Error(`Actual ${name} failed`)
    const content: unknown = Reflect.get(message, 'content')
    if (!Array.isArray(content)) throw new Error('Missing actual native tool result')
    const text = content.find(item => item && typeof item === 'object' && item.type === 'text')?.text
    if (typeof text !== 'string') throw new Error('Missing actual native JSON result')
    return [JSON.parse(text)]
  })
}
function actualBlock(candidate: unknown, source: ScopedSourceIdentity, page: number, expectedText: string): TextBlockItem {
  const value = parseContract('sidecar-document-rpc', candidate)
  if (!('resultType' in value) || value.resultType !== 'read' || value.mode !== 'page') throw new Error('Expected real page Read, not fabricated Evidence')
  expect(value.source).toMatchObject({ documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId })
  const block = value.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes(expectedText)).sort((a, b) => b.text.length - a.text.length)[0]
  if (!block) throw new Error('The real PDF page did not contain the expected source block')
  expect(block.physicalPage).toBe(page); expect(block.locator).toMatchObject({ ...source })
  return block
}
async function reviewWorkspace(page: Page, origin: string, scope: string): Promise<ProductReviewWorkspace> {
  const response = await page.request.get(`${origin}${basePath}/reviews?scopeVersionId=${encodeURIComponent(scope)}`)
  expect(response.status()).toBe(200)
  const value = parseContract('product-review', await response.json())
  if (value.kind !== 'review-workspace') throw new Error('Expected authorized saved Review records')
  expect(value.scope?.scopeVersionId).toBe(scope)
  return value
}
async function pending(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@continuity:')).map(([key, raw]) => ({ key, raw })))
}

/** Model wording is explicitly scripted. The agent loop, double Read, immutable versions,
 * citations, PDF bytes, fresh canonical Evidence and durable human judgment are all real. */
test('continues a saved Claim against two freshly read PDF revisions, preserves drafts and reconciles one human judgment without rewriting old research', async ({ page }) => {
  test.setTimeout(240000)
  const originalBytes = readFileSync('apps/web/public/documents/sample-report.pdf'), revisedBytes = longPdf({ embeddedToc: false })
  const oldAnswer = '旧版第二页包含季度营收条目。', comparisonAnswer = '新版第四页记录实验观察，需人工重新判断旧研究的适用性。'
  let firstScope = '', comparisonScope = '', oldRevision = '', newRevision = '', oldSource: ScopedSourceIdentity | undefined, newSource: ScopedSourceIdentity | undefined
  const fixture = await liveHarness({ documents: true, answers: [
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    messages => {
      const result = toolResults(messages, 'docatlas_sources').at(-1) as { sources: ScopedSourceIdentity[], scopeVersionId: string }
      expect(result.sources).toHaveLength(1); firstScope = result.scopeVersionId; oldSource = result.sources[0]!
      expect(oldSource.revisionId).toBe(oldRevision)
      return { calls: [{ name: 'docatlas_read', args: { documentId: oldSource.documentId, revisionId: oldRevision, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    },
    messages => {
      const block = actualBlock(toolResults(messages, 'docatlas_read').at(-1), oldSource!, 2, 'Q4')
      return `[${oldAnswer}](#docatlas.v1.support.${block.locator.locatorId})`
    },
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    messages => {
      const result = toolResults(messages, 'docatlas_sources').at(-1) as { sources: ScopedSourceIdentity[], scopeVersionId: string }
      expect(result.sources).toHaveLength(2); comparisonScope = result.scopeVersionId; expect(comparisonScope).not.toBe(firstScope)
      expect(result.sources.map(source => [source.documentId, source.revisionId]).sort()).toEqual([[oldSource!.documentId, oldRevision], [oldSource!.documentId, newRevision]].sort())
      expect(result.sources.find(source => source.revisionId === oldRevision)).toEqual(oldSource)
      newSource = result.sources.find(source => source.revisionId === newRevision)!
      return { calls: [
        { name: 'docatlas_read', args: { documentId: oldSource!.documentId, revisionId: oldRevision, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } },
        { name: 'docatlas_read', args: { documentId: newSource.documentId, revisionId: newRevision, mode: 'page', physicalPage: 4, maxItems: 30, maxChars: 6000 } },
      ] }
    },
    messages => {
      const actual = toolResults(messages, 'docatlas_read').slice(-2)
      const byRevision = (revision: string) => actual.find(value => value && typeof value === 'object' && Reflect.get(value, 'source')?.revisionId === revision)
      const old = actualBlock(byRevision(oldRevision), oldSource!, 2, 'Q4'), current = actualBlock(byRevision(newRevision), newSource!, 4, 'Experiment 4 observation 1:')
      return `[重新读取旧版第二页的原文。](#docatlas.v1.support.${old.locator.locatorId})\n[${comparisonAnswer}](#docatlas.v1.support.${current.locator.locatorId})`
    },
  ] })
  const inspections: ProductContinuityInspection[] = [], impacts: ProductContinuityImpactResult[] = [], commands: ProductContinuityAssess[] = [], receipts: ProductContinuityAssessment[] = [], reviewCommands: ProductReviewCommand[] = [], errors: string[] = []
  const originals = new Map<string, Buffer>(), originalRequests: string[] = []
  let dropCommittedResponse = true
  const library = page.getByRole('button', { name: /^资料(?: · \d+)?$/u }), reviews = page.getByRole('dialog', { name: '结论与审阅', exact: true }), drawer = page.getByRole('dialog', { name: '继续核验', exact: true })
  const openContinuity = async (claimId: string) => {
    await clickHeaderAction(page, '结论与审阅')
    const select = reviews.getByLabel('审阅资料范围', { exact: true })
    await expect(select).toBeEnabled()
    if (await select.inputValue() !== firstScope) await select.selectOption(firstScope)
    const row = page.locator(`[data-review-claim="${claimId}"]`)
    await expect(row.getByRole('button', { name: '继续核验', exact: true })).toBeEnabled()
    await row.getByRole('button', { name: '继续核验', exact: true }).click()
    await expect(drawer).toBeVisible(); await expect(drawer.getByRole('heading', { name: '结论版本 · v1', exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '刷新材料（不会提交判断）', exact: true })).toBeEnabled()
    await expect(reviews).toHaveCount(0)
  }
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('**/api/conversations/*/continuity/*', async route => {
      const input = parseContract('product-continuity', route.request().postDataJSON())
      if (input.kind === 'continuity-assess') commands.push(input)
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(200)
      const value = parseContract('product-continuity', JSON.parse(body.toString('utf8')))
      if (value.kind === 'continuity-inspection') inspections.push(value)
      else if (value.kind === 'continuity-impact-result') impacts.push(value)
      else if (value.kind === 'continuity-assessment') {
        receipts.push(value)
        if (dropCommittedResponse) { dropCommittedResponse = false; await route.abort('failed'); return } // Only lose delivery after the real durable commit.
      } else throw new Error('Unexpected product Continuity response')
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/reviews', async route => {
      if (route.request().method() === 'POST') {
        const command = parseContract('product-review', route.request().postDataJSON())
        if (command.kind !== 'review-command') throw new Error('Expected actual human review command')
        reviewCommands.push(command)
      }
      await route.continue()
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const revision = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!), expected = originals.get(revision)
      if (!expected) throw new Error('Unexpected original revision requested')
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf'); expect(response.headers().etag).toBe(`"${hash(expected)}"`); expect(body).toEqual(expected)
      originalRequests.push(revision); await route.fulfill({ response, body })
    })
    await page.goto(`${fixture.origin}/live.html`)
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await library.click(); await page.locator('input[type=file]').setInputFiles({ name: '原版研究.pdf', mimeType: 'application/pdf', buffer: originalBytes })
    await expect(page.locator('[data-library-document]')).toHaveCount(1, { timeout: 60000 })
    const card = page.locator('[data-library-document]'), documentId = (await card.getAttribute('data-library-document'))!
    oldRevision = (await card.getAttribute('data-library-revision'))!; originals.set(oldRevision, originalBytes)
    await card.getByRole('checkbox').check(); await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('请读取原版第二页Q4条目，并引用原始PDF。'); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.live-answer-body').filter({ hasText: oldAnswer }).locator('.live-citation')).toHaveCount(1, { timeout: 60000 })
    await fixture.coordinator.waitForIdle(); expect(fixture.model.getCallCount()).toBe(3)
    await clickHeaderAction(page, '结论与审阅')
    await expect(reviews.locator('[data-review-evidence]')).toHaveCount(1)
    await reviews.locator('[data-review-evidence] input[type=checkbox]').check()
    await reviews.getByLabel('结论正文', { exact: true }).fill('原版第二页列示 Q4 季度营收条目。')
    await reviews.getByRole('button', { name: '保存新结论', exact: true }).click()
    await expect(page.locator('[data-review-claim]')).toHaveCount(1)
    const before = await reviewWorkspace(page, fixture.origin, firstScope), savedClaim = structuredClone(before.claims[0]!), claimId = savedClaim.claimVersionId, investigationId = before.scope!.investigationId
    expect(savedClaim.version).toBe(1); expect(before.evidenceRelations).toHaveLength(1)
    const oldRecord = fixture.documents!.store.getContinuityRecord(workspaceId, claimId)
    const unsaved = '尚未保存的草稿：仍要补充其他年份资料。'
    await reviews.getByLabel('结论正文', { exact: true }).fill(unsaved)
    await page.locator(`[data-review-claim="${claimId}"]`).getByRole('button', { name: '继续核验', exact: true }).click()
    await expect(drawer.getByRole('heading', { name: '结论版本 · v1', exact: true })).toBeVisible()
    await expect(drawer.getByLabel('连续研究阅读范围', { exact: true })).toHaveValue('') // A server-default scope is not a user choice.
    await expect(drawer).not.toContainText(unsaved)
    await page.getByRole('button', { name: '关闭继续核验', exact: true }).click()
    await clickHeaderAction(page, '结论与审阅'); await expect(reviews.getByLabel('结论正文', { exact: true })).toHaveValue(unsaved)
    await page.getByRole('button', { name: '关闭结论与审阅', exact: true }).click()

    await library.click(); await clickDetailAction(card.getByRole('button', { name: '版本与更新', exact: true, includeHidden: true }))
    await expect(page.getByRole('button', { name: '选择 PDF 作为此文档新版本', exact: true })).toBeEnabled()
    await page.getByLabel('上传此文档新版本 PDF', { exact: true }).setInputFiles({ name: '新版研究.pdf', mimeType: 'application/pdf', buffer: revisedBytes })
    await expect(page.locator('[data-document-revision]')).toHaveCount(2, { timeout: 60000 })
    await expect(page.getByText('新版本已保存，旧版本仍保留。提问勾选未自动升级，请明确选择要使用的版本。', { exact: true })).toBeVisible()
    newRevision = fixture.documents!.store.getLibraryDocument(workspaceId, documentId)!.currentRevision.revisionId; expect(newRevision).not.toBe(oldRevision); originals.set(newRevision, revisedBytes)
    await page.locator(`[data-document-revision="${newRevision}"]`).getByRole('checkbox').check()
    await page.locator(`[data-document-revision="${oldRevision}"]`).getByRole('checkbox').uncheck()
    await page.getByRole('button', { name: '关闭版本与更新', exact: true }).click()
    const question = '明确读取原版第二页与新版第四页，分别提供可回到原PDF的证据。'
    await page.getByLabel('向 DocAtlas 提问').fill(question)
    await openContinuity(claimId); await drawer.getByRole('button', { name: '将旧来源加入提问', exact: true }).click()
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(question); await expect(library).toHaveText('资料 · 2')
    expect(fixture.model.getCallCount()).toBe(3); expect(commands).toHaveLength(0)
    await page.getByRole('button', { name: '关闭继续核验', exact: true }).click()
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.live-answer-body').filter({ hasText: comparisonAnswer }).locator('.live-citation')).toHaveCount(2, { timeout: 60000 })
    await fixture.coordinator.waitForIdle(); expect(fixture.model.getCallCount()).toBe(6)

    await openContinuity(claimId)
    await drawer.getByLabel('连续研究阅读范围', { exact: true }).selectOption(comparisonScope)
    await expect(drawer.getByRole('button', { name: '刷新材料（不会提交判断）', exact: true })).toBeEnabled()
    const inspected = inspections.at(-1)!
    expect(inspected.scopeVersionId).toBe(comparisonScope); expect(inspected.truncated).toBe(false); expect(inspected.record.sourceReferencesComplete).toBe(true)
    expect(inspected.record).toMatchObject({ recordId: claimId, version: 1, sources: [{ documentId, revisionId: oldRevision, name: '原版研究.pdf' }] })
    expect(inspected.evidence.map(value => value.revisionId).sort()).toEqual([oldRevision, newRevision].sort())
    const oldEvidence = inspected.evidence.find(value => value.revisionId === oldRevision)!, currentEvidence = inspected.evidence.find(value => value.revisionId === newRevision)!
    await drawer.locator('label.continuity-check').filter({ hasText: newRevision }).getByRole('checkbox').check()
    const oldSide = drawer.getByRole('region', { name: '旧侧：重新核对原记录的证据', exact: true }), currentSide = drawer.getByRole('region', { name: '本次侧：用于比较的证据', exact: true })
    await oldSide.getByRole('checkbox').check(); await currentSide.getByRole('checkbox').check()
    await expect(drawer.getByLabel('连续研究人工判断', { exact: true })).toHaveValue('unknown')
    for (const [side, revision, physicalPage] of [[oldSide, oldRevision, 2], [currentSide, newRevision, 4]] as const) {
      await side.getByRole('button', { name: '核对原始 PDF', exact: true }).click()
      await expect(page.locator(`.pdf-paper[data-document-id="${documentId}:${revision}"][data-page="${physicalPage}"][data-rendered=true]`)).toBeVisible({ timeout: 20000 })
      await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
      await openContinuity(claimId)
      await expect(oldSide.getByRole('checkbox')).toBeChecked(); await expect(currentSide.getByRole('checkbox')).toBeChecked()
    }
    expect(new Set(originalRequests)).toEqual(new Set([oldRevision, newRevision]))
    await drawer.getByText('版本依赖检查（只读）', { exact: true }).click()
    await drawer.getByLabel('依赖检查旧版本', { exact: true }).selectOption(JSON.stringify([documentId, oldRevision]))
    await drawer.getByLabel('依赖检查本次版本', { exact: true }).selectOption(JSON.stringify([documentId, newRevision]))
    await drawer.getByRole('button', { name: '检查版本依赖', exact: true }).click()
    await expect(drawer.getByText(/存在重新核验的依赖/u)).toBeVisible()
    expect(impacts).toHaveLength(1); expect(impacts[0]).toMatchObject({ recordId: claimId, recordVersion: 1, dependencyOnly: true, status: 'needs-reverify' })
    expect(commands).toHaveLength(0); expect(fixture.documents!.store.listContinuityLinks(workspaceId, investigationId)).toHaveLength(0)
    await expect(drawer.getByLabel('连续研究人工判断', { exact: true })).toHaveValue('unknown')
    const rationale = '人工核对两版原文：旧版为季度营收，新版为实验观察；当前材料的主题已变化，旧结论不能直接套用。'
    await drawer.getByLabel('连续研究人工判断', { exact: true }).selectOption('changed')
    await drawer.getByLabel('连续研究判断依据', { exact: true }).fill(rationale)
    await drawer.getByRole('button', { name: '保存这次人工判断', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '用原键核对这次判断', exact: true })).toBeEnabled({ timeout: 60000 })
    expect(commands).toHaveLength(1); expect(receipts).toHaveLength(1)
    expect(commands[0]).toMatchObject({ priorRecordId: claimId, expectedPriorVersion: 1, scopeVersionId: comparisonScope, currentSources: [{ documentId, revisionId: newRevision }],
      priorEvidenceIds: [oldEvidence.evidenceId], currentEvidenceIds: [currentEvidence.evidenceId], proposedState: 'changed', rationale })
    expect(receipts[0]!.result).toMatchObject({ status: 'created', link: { state: 'changed', verificationStatus: 'reverified', priorRecordVersion: 1, createdBy: { kind: 'user', actorId: 'actor:browser' } } })
    const retained = await pending(page); expect(retained).toHaveLength(1)
    expect(JSON.parse(retained[0]!.raw)).toMatchObject({ record: inspected.record, request: commands[0] })
    const committed = fixture.documents!.store.listContinuityLinks(workspaceId, investigationId)
    expect(committed).toHaveLength(1); expect(committed[0]).toEqual(receipts[0]!.result.link)
    await drawer.getByRole('button', { name: '刷新材料（不会提交判断）', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '刷新材料（不会提交判断）', exact: true })).toBeEnabled()
    expect(commands).toHaveLength(1); expect(await pending(page)).toEqual(retained)
    const nativeContexts = [...fixture.contexts]
    await page.reload(); await openContinuity(claimId)
    await expect(drawer.getByRole('button', { name: '用原键核对这次判断', exact: true })).toBeEnabled()
    await expect(drawer.getByLabel('连续研究阅读范围', { exact: true })).toHaveValue('')
    expect(commands).toHaveLength(1); expect(await pending(page)).toEqual(retained)
    await drawer.getByRole('button', { name: '用原键核对这次判断', exact: true }).click()
    await expect.poll(() => pending(page)).toEqual([])
    expect(commands[1]).toEqual(commands[0]); expect(receipts[1]!.result.status).toBe('replayed'); expect(receipts[1]!.result.link).toEqual(committed[0])
    await expect(drawer.getByRole('region', { name: '已保存的连续研究判断', exact: true })).toContainText(committed[0]!.continuityLinkId)
    await expect(drawer.getByRole('region', { name: '已保存的连续研究判断', exact: true })).toContainText('固定版本 v1')
    expect(fixture.documents!.store.listContinuityLinks(workspaceId, investigationId)).toEqual(committed)
    expect(fixture.documents!.store.getContinuityRecord(workspaceId, claimId)).toEqual(oldRecord)
    expect((await reviewWorkspace(page, fixture.origin, firstScope)).claims).toEqual([savedClaim])
    expect(reviewCommands).toHaveLength(1); expect(reviewCommands[0]!.action).toBe('claim-save')
    expect(fixture.model.getCallCount()).toBe(6); expect(fixture.contexts).toEqual(nativeContexts); expect(errors).toEqual([])
  } finally { await fixture.close() }
})
