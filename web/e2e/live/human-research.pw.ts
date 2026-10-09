import { clickHeaderAction, observeJsonAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { HumanResearchCommand, HumanResearchOperation, ProductSubmission, ResearchRecallResult } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { lineageHarness } from './lineage-harness.js'

type Fixture = Awaited<ReturnType<typeof lineageHarness>>
const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`
const drawer = (page: Page) => page.getByRole('dialog', { name: '研究笔记', exact: true })
const editor = (page: Page) => drawer(page).getByRole('region', { name: '人类研究编辑器', exact: true })
const row = (page: Page, id: string) => drawer(page).locator(`[data-human-record="${id}"]`)
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const normalizedQuote = (value: string) => value.replace(/\s+/gu, ' ').trim()

async function pair(page: Page, fixture: Fixture) {
  // Capture and forward the actual bytes before the bounded browser reader
  // cancels/releases its response; CDP may no longer retain response.json().
  const response = await observeJsonAction(page, `${fixture.origin}${conversationPath(fixture.parent.conversationId)}/snapshot`,
    () => page.goto(`${fixture.origin}/live.html`), 'GET')
  expect(response.status).toBe(200)
  expect(parseContract('conversation-observation', response.value)).toMatchObject({ kind: 'conversation-snapshot', binding: fixture.parent })
  await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
}

async function researchRecorder(page: Page) {
  const requests: HumanResearchCommand[] = [], operations: HumanResearchOperation[] = [], gets: HumanResearchOperation[] = []
  let lose = false
  await page.route('**/research-workbench', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const input = parseContract('human-research', route.request().postDataJSON())
    if (!('kind' in input) || input.kind !== 'human-research-command') throw new Error('Expected exact human research command')
    requests.push(input)
    const response = await route.fetch(), bytes = await response.body()
    expect(response.status()).toBe(200)
    const value = parseContract('human-research', JSON.parse(bytes.toString('utf8')))
    if (!('kind' in value) || value.kind !== 'human-research-operation' || !value.receipt) throw new Error('Expected actual durable human receipt')
    operations.push(value)
    if (lose) { lose = false; await route.abort('failed'); return }
    await route.fulfill({ response, body: bytes })
  })
  await page.route('**/research-workbench/operations/*', async route => {
    expect(route.request().method()).toBe('GET')
    const response = await route.fetch(), bytes = await response.body()
    expect(response.status()).toBe(200)
    const value = parseContract('human-research', JSON.parse(bytes.toString('utf8')))
    if (!('kind' in value) || value.kind !== 'human-research-operation') throw new Error('Expected real read-only operation lookup')
    gets.push(value); await route.fulfill({ response, body: bytes })
  })
  return { requests, operations, gets, loseNext: () => { lose = true },
    next: async (action: () => Promise<unknown>, lost = false) => {
      const count = operations.length
      await action()
      await expect.poll(() => operations.length, { timeout: 60000 }).toBe(count + 1)
      const value = operations[count]!
      if (lost) await expect(drawer(page).getByRole('region', { name: '待核对人类研究操作', exact: true })).toBeVisible()
      else await expect(drawer(page).locator(`[data-human-receipt="${value.operationId}"]`)).toBeVisible()
      return value
    } }
}

async function pendingResearch(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@human-research:'))
    .map(([key, raw]) => ({ key, raw })))
}
async function askDraft(page: Page, fixture: Fixture, id: string) {
  const key = `docatlas.live.draft.v1:${encodeURIComponent(fixture.actor.actorId)}:${encodeURIComponent(fixture.actor.workspaceId)}:${encodeURIComponent(id)}`
  return page.evaluate(key => sessionStorage.getItem(key), key)
}
async function newRecord(page: Page, type: 'research-note' | 'open-question' | 'project-decision' | 'research-policy', body: string) {
  await drawer(page).getByRole('button', { name: '新增研究记录', exact: true }).click()
  await editor(page).getByLabel('新研究记录类型', { exact: true }).selectOption(type)
  if (type === 'project-decision' || type === 'research-policy') {
    await editor(page).getByLabel('研究治理标题', { exact: true }).fill(type === 'project-decision' ? '统计口径约定' : '人工核验规则')
    await editor(page).getByLabel('研究治理理由', { exact: true }).fill('这是人类研究约定，不是事实证明。')
  }
  if (type === 'research-policy') await editor(page).getByLabel('研究规则声明范围', { exact: true }).selectOption('workspace')
  await editor(page).getByLabel('人类研究完整正文', { exact: true }).fill(body)
  await editor(page).getByRole('checkbox', { name: /确认保存此研究内容与明确关联/u }).check()
}
async function selectQ4(page: Page) {
  const pane = page.locator('[data-reader-pane="A"]')
  await expect(pane.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 })
  return pane.locator('.pdf-text-layer').evaluate(layer => {
    const span = [...layer.querySelectorAll('span')].find(node => !node.children.length && node.textContent?.includes('Q4'))
    if (!span) throw new Error('The actual fixture PDF has no Q4 text-layer span')
    const range = document.createRange(); range.selectNodeContents(span)
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return span.textContent!
  })
}
function actualToolResult(messages: readonly unknown[], name: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === name)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`No successful native ${name} result`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('Missing native tool content')
  const text: unknown = content.find(item => item && typeof item === 'object' && item.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Missing native tool JSON')
  return JSON.parse(text)
}

test('authors all four free human record types without a PDF/model, edits complete versions, and recovers original metadata without resurrecting deleted prose', async ({ page }) => {
  test.setTimeout(240000); page.setDefaultTimeout(15000)
  const fixture = await lineageHarness({ answers: [] }), recorder = await researchRecorder(page), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept())
  const body = `${'逐项核验统计口径与原始来源；这里仅记录研究工作。\n'.repeat(65)}完整正文尾部：等待事实复核。`
  try {
    await pair(page, fixture)
    await expect(page.getByRole('region', { name: '原始 PDF 阅读器', exact: true })).toHaveCount(0)
    await page.getByLabel('向 DocAtlas 提问').fill('独立的未发送问题，研究编辑不能改动。')
    const initialDraft = await askDraft(page, fixture, fixture.parent.conversationId)
    await clickHeaderAction(page, '研究笔记')
    await newRecord(page, 'research-note', body)
    const note = await recorder.next(() => editor(page).getByRole('button', { name: '保存到研究', exact: true }).click())
    const noteId = note.receipt!.recordId
    await expect(editor(page).getByLabel('人类研究完整正文', { exact: true })).toHaveValue(body)
    const edited = `${body}\n第二轮补充：仍然不是新的文档 Evidence。`
    await editor(page).getByLabel('人类研究完整正文', { exact: true }).fill(edited)
    const changed = await recorder.next(() => editor(page).getByRole('button', { name: '保存研究新版本', exact: true }).click())
    expect(recorder.requests.at(-1)).toMatchObject({ action: 'edit', recordId: noteId, expectedVersion: 1, text: edited })
    expect(changed.receipt).toMatchObject({ recordId: noteId, recordVersion: 2 })
    await expect(editor(page).getByRole('heading')).toContainText('v2')
    await newRecord(page, 'open-question', '需要补充什么来源才能确认这个口径？')
    const question = await recorder.next(() => editor(page).getByRole('button', { name: '保存到研究', exact: true }).click())
    await expect(editor(page).getByRole('button', { name: '标记问题已解决', exact: true })).toBeEnabled()
    const resolved = await recorder.next(() => editor(page).getByRole('button', { name: '标记问题已解决', exact: true }).click())
    expect(resolved.receipt).toMatchObject({ recordId: question.receipt!.recordId, action: 'resolve', recordVersion: 2 })
    await newRecord(page, 'project-decision', '暂按原文财年展示，不自行混用自然年。')
    const decision = await recorder.next(() => editor(page).getByRole('button', { name: '保存到研究', exact: true }).click())
    await expect(editor(page).getByLabel('研究治理标题', { exact: true })).toHaveValue('统计口径约定')
    await editor(page).getByLabel('人类研究完整正文', { exact: true }).fill('修订约定：并列显示两种口径，并注明尚未验证的差异。')
    const revised = await recorder.next(() => editor(page).getByRole('button', { name: '保存研究新版本', exact: true }).click())
    expect(recorder.requests.at(-1)).toMatchObject({ action: 'revise', recordId: decision.receipt!.recordId, expectedVersion: 1,
      entry: { recordType: 'project-decision', decision: '修订约定：并列显示两种口径，并注明尚未验证的差异。' } })
    expect(revised.receipt!.recordVersion).toBe(2)
    await newRecord(page, 'research-policy', '涉及金额结论时先由人核对原文。此规则不自动执行。')
    const policy = await recorder.next(() => editor(page).getByRole('button', { name: '保存到研究', exact: true }).click())
    expect(recorder.requests.at(-1)).toMatchObject({ action: 'create', entry: { recordType: 'research-policy', policyScope: 'workspace' }, sourceRefs: [], selections: [] })
    for (const value of [note, question, decision, policy]) await expect(row(page, value.receipt!.recordId)).toBeVisible()
    expect(recorder.requests.filter(value => value.action === 'create').every(value => value.sourceRefs.length === 0 && value.selections.length === 0)).toBe(true)
    expect(await askDraft(page, fixture, fixture.parent.conversationId)).toBe(initialDraft)
    expect(fixture.documents.store.get(fixture.parent.conversationId).status).toBe('unbound')
    expect(fixture.documents.store.eligibleLibrarySources(fixture.actor.workspaceId)).toEqual([])
    expect(fixture.model.getCallCount()).toBe(0)

    const lostBody = '独立未知研究写入：不得在软删除之后由旧回执恢复这段正文。'
    await newRecord(page, 'research-note', lostBody); recorder.loseNext()
    const lost = await recorder.next(() => editor(page).getByRole('button', { name: '保存到研究', exact: true }).click(), true)
    const savedPending = await pendingResearch(page); expect(savedPending).toHaveLength(1)
    const posts = recorder.requests.length, gets = recorder.gets.length
    await page.reload(); await clickHeaderAction(page, '研究笔记')
    await expect(drawer(page).getByRole('button', { name: '只读核对原研究操作', exact: true })).toBeEnabled()
    expect(recorder.requests).toHaveLength(posts); expect(recorder.gets).toHaveLength(gets)
    await drawer(page).getByRole('button', { name: '只读核对原研究操作', exact: true }).click()
    await expect.poll(() => pendingResearch(page)).toEqual([])
    expect(recorder.requests).toHaveLength(posts); expect(recorder.gets.at(-1)!.receipt).toEqual(lost.receipt)
    await expect(editor(page).getByLabel('人类研究完整正文', { exact: true })).toHaveValue(lostBody)
    const deleted = await recorder.next(() => editor(page).getByRole('button', { name: '软删除研究记录', exact: true }).click())
    expect(deleted.receipt).toMatchObject({ recordId: lost.receipt!.recordId, action: 'delete', recordVersion: 2 })
    await expect(editor(page)).toContainText('当前内容已软删除')
    // Restore only bytes captured from the real uncertain request, representing a stale tab.
    // No server state, receipt, record or source is fabricated for the recovery.
    await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), savedPending[0]!)
    const afterDeletePosts = recorder.requests.length
    await page.reload(); await clickHeaderAction(page, '研究笔记')
    await drawer(page).getByRole('button', { name: '只读核对原研究操作', exact: true }).click()
    await expect.poll(() => pendingResearch(page)).toEqual([])
    await expect(editor(page)).toContainText('当前内容已软删除')
    await expect(editor(page).getByLabel('人类研究完整正文', { exact: true })).toHaveCount(0)
    await expect(drawer(page)).not.toContainText(lostBody)
    expect(recorder.requests).toHaveLength(afterDeletePosts)
    expect(recorder.gets.at(-1)!.receipt).toEqual(lost.receipt)
    expect(JSON.stringify(recorder.gets.at(-1))).not.toContain(lostBody)
    expect(fixture.documents.humanResearch.get(fixture.parent.conversationId, lost.receipt!.recordId).entry).toMatchObject({ status: 'deleted', text: null, version: 2 })
    expect(fixture.model.getCallCount()).toBe(0); expect(errors).toEqual([])
  } finally { await fixture.close() }
})

test('saves a real PDF selection independently of an uncertain Ask, revisits exact original highlights across conversations, and Pi recalls the new human record only as a lead', async ({ page }) => {
  test.setTimeout(300000); page.setDefaultTimeout(15000)
  const pdf = readFileSync('apps/web/public/documents/sample-report.pdf'), pdfHash = hash(pdf), body = 'MarginBridgeAnchor：这一段 Q4 口径仍需与其他资料核对，不是已确认结论。'
  const initialAnswer = '收到真实问题；此轮未调用 Read，也没有新原文证据。', recallAnswer = '找到了以前的人类研究笔记；它是待复核线索，没有重新读取原文，不能作为证据。'
  let recordId = '', observedRecall: ResearchRecallResult | undefined
  const fixture = await lineageHarness({ answers: [initialAnswer,
    { calls: [{ name: 'docatlas_recall', args: { query: 'MarginBridgeAnchor', recordTypes: ['research-note'] } }] },
    messages => {
      const value = parseContract('research-recall-rpc', actualToolResult(messages, 'docatlas_recall'))
      if ('requestType' in value) throw new Error('Expected actual native Recall result')
      observedRecall = value
      expect(value.leads.find(item => item.recordId === recordId)).toMatchObject({ recordType: 'research-note', verificationStatus: 'unverified-lead', sourceState: 'outside-current-scope' })
      return recallAnswer
    },
  ] })
  const parentId = fixture.parent.conversationId, recorder = await researchRecorder(page), submissions: ProductSubmission[] = [], originalUrls: string[] = [], errors: string[] = []
  let selectionPosts = 0, holdSnapshots = false
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept())
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/selections')) selectionPosts++ })
  try {
    // Block observation before connecting; no already-open SSE stream can clear the lost Ask receipt.
    await page.route('**/events', route => route.abort('failed'))
    await page.route('**/snapshot', async route => {
      if (holdSnapshots) { await route.abort('failed'); return }
      const response = await route.fetch(), bytes = await response.body()
      // Fence a snapshot already in flight when the Ask outage starts as well.
      if (holdSnapshots) { await route.abort('failed'); return }
      await route.fulfill({ response, body: bytes })
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const response = await route.fetch(), bytes = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf')
      expect(response.headers().etag).toBe(`"${pdfHash}"`); expect(bytes).toEqual(pdf)
      originalUrls.push(route.request().url()); await route.fulfill({ response, body: bytes })
    })
    await pair(page, fixture)
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '独立原文研究.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：独立原文研究.pdf', exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：独立原文研究.pdf', exact: true }).check()
    await page.getByRole('button', { name: '打开原文', exact: true }).click()
    const pane = page.locator('[data-reader-pane="A"]')
    await expect(pane.locator('.pdf-paper[data-rendered=true]')).toBeVisible({ timeout: 20000 })
    await pane.getByRole('button', { name: '下一页', exact: true }).click()
    const quote = await selectQ4(page)
    await pane.getByRole('button', { name: '加入问题', exact: true }).click()
    await expect(page.locator('[data-selection-ticket]')).toHaveCount(1, { timeout: 30000 })
    const ticketId = (await page.locator('[data-selection-ticket]').getAttribute('data-selection-ticket'))!
    expect(fixture.documents.selections.get(parentId, ticketId).state).toBe('staged')
    holdSnapshots = true
    let loseAsk = true
    await page.route('**/api/submissions', async route => {
      const value = parseContract('product-control', route.request().postDataJSON())
      if (value.kind !== 'submission') throw new Error('Expected actual browser submission')
      submissions.push(value)
      const response = await route.fetch(), bytes = await response.body()
      expect([200, 202]).toContain(response.status())
      if (loseAsk) { loseAsk = false; await route.abort('failed'); return }
      await route.fulfill({ response, body: bytes })
    })
    const question = '保留这个原问题与选区，即使响应丢失也只执行一次。'
    await page.getByLabel('向 DocAtlas 提问').fill(question)
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.getByRole('button', { name: '使用原提交键重试', exact: true })).toBeVisible()
    await fixture.waitIdle(parentId)
    expect(fixture.model.getCallCount()).toBe(1); expect(submissions).toHaveLength(1)
    const frozenAsk = await askDraft(page, fixture, parentId), afterAskTicket = fixture.documents.selections.get(parentId, ticketId), admittedBeforeSave = fixture.documents.store.get(parentId)
    expect(frozenAsk).not.toBeNull()
    expect(JSON.parse(frozenAsk!).request).toEqual(submissions[0])
    expect(submissions[0]).toMatchObject({ text: question, selectionContextIds: [ticketId], sourceRefs: [expect.anything()] })
    expect(afterAskTicket.state).toBe('consumed')

    await selectQ4(page)
    await expect(pane.getByRole('button', { name: '保存到研究', exact: true })).toBeEnabled()
    await pane.getByRole('button', { name: '保存到研究', exact: true }).click()
    await expect(editor(page).locator('[data-human-selection]')).toHaveCount(1)
    await editor(page).getByLabel('人类研究完整正文', { exact: true }).fill(body)
    await editor(page).getByRole('checkbox', { name: /确认保存此研究内容与明确关联/u }).check()
    recorder.loseNext()
    const saved = await recorder.next(() => editor(page).getByRole('button', { name: '保存到研究', exact: true }).click(), true)
    recordId = saved.receipt!.recordId
    expect(recorder.requests[0]).toMatchObject({ action: 'create', sourceRefs: [], selections: [{ quote, physicalPage: 2 }] })
    const note = fixture.documents.store.getResearchNote(fixture.actor.workspaceId, recordId)!
    expect(note).toMatchObject({ authoredBy: 'user', evidence: [], text: body, sourceSessionId: parentId })
    expect(note.anchors).toHaveLength(1); expect(normalizedQuote(note.anchors[0]!.text)).toBe(normalizedQuote(quote))
    expect(note.locators).toHaveLength(1); expect(note.sourceIdentities).toHaveLength(1)
    expect(fixture.documents.research.journal.forRecord(fixture.actor, recordId)).toBeUndefined()
    expect(await askDraft(page, fixture, parentId)).toBe(frozenAsk)
    expect(fixture.documents.selections.get(parentId, ticketId)).toEqual(afterAskTicket)
    expect(fixture.documents.store.get(parentId)).toEqual(admittedBeforeSave); expect(selectionPosts).toBe(1)
    expect(fixture.model.getCallCount()).toBe(1); expect(submissions).toHaveLength(1)

    holdSnapshots = false
    await page.unroute('**/events'); await page.unroute('**/snapshot')
    await page.reload(); await clickHeaderAction(page, '研究笔记')
    await drawer(page).getByRole('button', { name: '只读核对原研究操作', exact: true }).click()
    await expect.poll(() => pendingResearch(page)).toEqual([])
    await expect(editor(page).getByLabel('人类研究完整正文', { exact: true })).toHaveValue(body)
    expect(recorder.requests).toHaveLength(1); expect(recorder.gets.at(-1)!.receipt).toEqual(saved.receipt)
    const focused = await observeJsonAction(page, `**/research-workbench/entries/${encodeURIComponent(recordId)}/focus/*`,
      () => editor(page).getByRole('button', { name: /^回到研究原文 1 · 第 2 页/u }).click())
    expect(focused.status).toBe(200)
    expect(parseContract('human-research', focused.value)).toMatchObject({ kind: 'human-research-focus', focus: { recordId, status: 'resolved', exactText: note.anchors[0]!.text,
      locator: { locatorId: note.locators[0]!.locatorId }, original: { contentHash: pdfHash, documentId: note.locators[0]!.documentId, revisionId: note.locators[0]!.revisionId } } })
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible({ timeout: 20000 })
    await expect(page.locator('[data-focus-status=exact]')).toContainText('已定位核验选区')
    expect(fixture.model.getCallCount()).toBe(1)

    await page.getByRole('button', { name: '历史', exact: true }).click()
    const createdResponse = await observeJsonAction(page, `${fixture.origin}/api/conversations`,
      () => page.getByRole('button', { name: '新建会话', exact: true }).click())
    expect(createdResponse.status).toBe(201)
    const child = parseContract('product-control', createdResponse.value)
    if (child.kind !== 'binding') throw new Error('Expected actual manager-created conversation')
    expect(child.conversationId).not.toBe(parentId)
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled({ timeout: 30000 })
    await clickHeaderAction(page, '研究笔记')
    await drawer(page).getByLabel('研究范围', { exact: true }).selectOption('workspace')
    await expect(row(page, recordId)).toContainText('待复核研究线索 · 不是新证据')
    await row(page, recordId).getByRole('button', { name: '查看研究全文与版本', exact: true }).click()
    await expect(editor(page).getByLabel('人类研究完整正文', { exact: true })).toHaveValue(body)
    await editor(page).getByRole('button', { name: /^回到研究原文 1 · 第 2 页/u }).click()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible({ timeout: 20000 })
    await pane.getByRole('button', { name: '查看此页研究', exact: true }).click()
    const overlay = drawer(page).getByRole('region', { name: '原文研究标记', exact: true })
    await expect(overlay.locator('[data-human-overlay]')).toHaveCount(1)
    await expect(overlay).toContainText(body)
    await overlay.getByRole('button', { name: '打开标记的原始 PDF', exact: true }).click()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    await page.getByRole('button', { name: '收起阅读区', exact: true }).click()
    const secondDraft = await askDraft(page, fixture, child.conversationId)
    expect(secondDraft === null ? [] : JSON.parse(secondDraft).sources).toEqual([])
    await page.getByLabel('向 DocAtlas 提问').fill('用 docatlas_recall 查找 MarginBridgeAnchor 以前的人类研究笔记；只返回线索，不把它当成已读取证据。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const messages = page.getByRole('region', { name: '会话消息', exact: true })
    await expect(messages).toContainText(recallAnswer, { timeout: 60000 }); await fixture.waitIdle(child.conversationId)
    expect(fixture.model.getCallCount()).toBe(3); expect(observedRecall).toBeDefined()
    expect(observedRecall!.leads.find(item => item.recordId === recordId)).toMatchObject({ sourceSessionId: parentId, verificationStatus: 'unverified-lead', sourceState: 'outside-current-scope' })
    const reply = messages.locator('[data-message-entry]').filter({ hasText: recallAnswer }), entryId = (await reply.getAttribute('data-message-entry'))!
    expect(fixture.documents.answers.get(child.conversationId, entryId).status).toBe('unavailable')
    await expect(reply.locator('.live-citation')).toHaveCount(0)
    expect(submissions).toHaveLength(2); expect(submissions[1]).toMatchObject({ conversationId: child.conversationId, sourceRefs: [], selectionContextIds: [] })
    expect(fixture.contexts.flat().some(message => message && typeof message === 'object' && Reflect.get(message, 'role') === 'toolResult' && Reflect.get(message, 'toolName') === 'docatlas_read')).toBe(false)
    expect(fixture.documents.store.getResearchNote(fixture.actor.workspaceId, recordId)).toEqual(note)
    expect(originalUrls.some(url => url.includes(conversationPath(parentId)))).toBe(true)
    expect(originalUrls.some(url => url.includes(conversationPath(child.conversationId)))).toBe(true)
    expect(errors).toEqual([])
  } finally { await fixture.close() }
})
