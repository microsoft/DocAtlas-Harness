import { clickHeaderAction } from './ui.js'
import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Route } from './test.js'
import type { NoteSave, NoteSaved, NotebookMutation } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'

const originalPdf = readFileSync('apps/web/public/documents/sample-report.pdf')
type Fixture = Awaited<ReturnType<typeof liveHarness>>
const notebook = (page: Page) => page.getByRole('dialog', { name: '研究笔记', exact: true })
const noteRow = (page: Page, id: string) => page.locator(`[data-notebook-record="${id}"]`)
async function openNotebook(page: Page) {
  await clickHeaderAction(page, '研究笔记')
  await notebook(page).getByRole('button', { name: 'Agent 研究设置与托盘笔记', exact: true }).click()
  await expect(notebook(page).getByText('Agent 的研究记忆开关', { exact: true })).toBeVisible()
}

/** Preserve real server bytes before Chromium may evict its response-body cache; never synthesize an API result. */
async function captureNext(page: Page, pattern: string, method = 'POST') {
  const receipt = Promise.withResolvers<{ status: number, body: Buffer, request: unknown, contentType: string }>()
  const handler = async (route: Route) => {
    if (route.request().method() !== method) { await route.continue(); return }
    try {
      const response = await route.fetch(), body = await response.body()
      const captured = { status: response.status(), body, request: method === 'POST' ? route.request().postDataJSON() as unknown : null, contentType: response.headers()['content-type'] ?? '' }
      await route.fulfill({ response, body }); receipt.resolve(captured)
    } catch (error) { receipt.reject(error); await route.abort().catch(() => {}) }
  }
  await page.route(pattern, handler)
  return { result: receipt.promise, stop: () => page.unroute(pattern, handler) }
}

async function explicitlyDisableContribution(page: Page) {
  const checkbox = notebook(page).getByRole('checkbox', { name: '允许 Agent 贡献研究记录', exact: true })
  await expect(checkbox).toBeEnabled()
  async function persist(expected: boolean) {
    const exchange = await captureNext(page, '**/research/policy')
    await notebook(page).getByRole('button', { name: '确认研究开关', exact: true }).click()
    const response = await exchange.result; await exchange.stop()
    expect(response.status).toBe(200)
    expect(parseContract('product-research', JSON.parse(response.body.toString('utf8')))).toMatchObject({ kind: 'research-session-policy', contributeResearchState: expected })
    await expect(checkbox).toBeEnabled()
  }
  // Observe the loaded policy; don't assume either default is part of this workflow's protocol.
  if (!(await checkbox.isChecked())) { await checkbox.check(); await persist(true) }
  await checkbox.uncheck(); await persist(false); await expect(checkbox).not.toBeChecked()
}

/** Real PDF bytes, native PDF.js text layer and server-issued selection ticket; no invented locator. */
async function prepareSelection(page: Page, fixture: Fixture) {
  await page.goto(`${fixture.origin}/live.html`)

  await page.reload()
  await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
  await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
  await page.locator('input[type=file]').setInputFiles({ name: '研究笔记来源.pdf', mimeType: 'application/pdf', buffer: originalPdf })
  await expect(page.getByRole('button', { name: '打开原文', exact: true })).toBeVisible({ timeout: 60000 })
  await page.getByRole('button', { name: '打开原文', exact: true }).click()
  await expect(page.locator('.pdf-paper[data-rendered=true]')).toBeVisible()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
  const quote = await page.locator('.pdf-text-layer').evaluate(layer => {
    const span = [...layer.querySelectorAll('span')].find(node => !node.children.length && node.textContent?.includes('Q4'))
    if (!span) throw new Error('Synthetic report has no Q4 text span')
    const range = document.createRange(); range.selectNodeContents(span)
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return span.textContent!
  })
  await page.locator('[data-reader-pane=A]').getByRole('button', { name: '加入问题', exact: true }).click()
  await expect(page.locator('[data-selection-ticket]')).toHaveCount(1, { timeout: 30000 })
  const ticketId = (await page.locator('[data-selection-ticket]').getAttribute('data-selection-ticket'))!
  const ticket = fixture.documents!.selections.get('conversation:browser', ticketId)
  expect(ticket).toMatchObject({ state: 'staged', submissionId: null })
  expect(ticket.items[0]!.locator.physicalPage).toBe(2)
  return { ticketId, quote, locator: ticket.items[0]!.locator }
}

async function confirmNote(page: Page, ticketId: string, text: string) {
  await openNotebook(page)
  await notebook(page).getByLabel('笔记关联选区').selectOption(ticketId)
  await notebook(page).getByLabel('笔记类型', { exact: true }).selectOption('hypothesis')
  await notebook(page).getByLabel('新笔记正文', { exact: true }).fill(text)
  await expect(notebook(page).getByRole('button', { name: '保存已确认笔记', exact: true })).toBeDisabled()
  await notebook(page).getByRole('checkbox', { name: /我确认保存这段研究记录/ }).check()
}

test('saves a verified source note with explicit consent and reconciles a lost committed response across refresh without duplicating or consuming the question ticket', async ({ page }) => {
  test.setTimeout(120000)
  // Pi provider is registered for the real app boundary, but this manual research workflow must make zero model calls.
  const fixture = await liveHarness({ documents: true, answers: [] }), requests: NoteSave[] = [], receipts: NoteSaved[] = []
  let loseResponse = true
  try {
    const selected = await prepareSelection(page, fixture), body = '待验证假设：Q4 的变化需要结合全年口径复核；这条笔记不是已验证结论。'
    await page.route('**/research/notes', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const input = parseContract('product-research', route.request().postDataJSON())
      if (input.kind !== 'note-save') throw new Error('Expected real NoteSave command')
      requests.push(input)
      const response = await route.fetch(), responseBody = await response.body()
      expect(response.status()).toBe(200)
      const value = parseContract('product-research', JSON.parse(responseBody.toString('utf8')))
      if (value.kind !== 'note-saved') throw new Error('Expected real saved-note receipt')
      receipts.push(value)
      if (loseResponse) { loseResponse = false; await route.abort(); return }
      await route.fulfill({ response, body: responseBody })
    })
    await confirmNote(page, selected.ticketId, body)
    await notebook(page).getByText('Agent 的研究记忆开关', { exact: true }).click()
    await explicitlyDisableContribution(page)
    await notebook(page).getByRole('button', { name: '保存已确认笔记', exact: true }).click()
    await expect(notebook(page).getByRole('button', { name: '使用原键核对操作', exact: true })).toBeEnabled()
    expect(requests).toHaveLength(1); expect(receipts).toHaveLength(1)
    const record = receipts[0]!.result.record
    if (record.recordType !== 'research-note') throw new Error('Expected a real research-note record')
    const id = record.noteId
    expect(fixture.documents!.research.get('conversation:browser', id)).toMatchObject({ recordId: id, text: body, version: 1, verificationStatus: 'unverified-lead' })
    expect(fixture.documents!.selections.get('conversation:browser', selected.ticketId)).toMatchObject({ state: 'staged', submissionId: null })

    await page.reload()
    await openNotebook(page)
    await expect(notebook(page).getByRole('button', { name: '使用原键核对操作', exact: true })).toBeEnabled()
    expect(requests).toHaveLength(1) // Refresh only restores the outbox; it does not resubmit it.
    await notebook(page).getByRole('button', { name: '使用原键核对操作', exact: true }).click()
    await expect(noteRow(page, id)).toBeVisible()
    await expect(notebook(page).getByRole('region', { name: '待核对研究操作' })).toHaveCount(0)
    expect(requests).toHaveLength(2); expect(requests).toEqual([requests[0], requests[0]])
    expect(receipts.map(receipt => receipt.result.status)).toEqual(['created', 'replayed'])
    expect(receipts.every(receipt => receipt.result.record.recordType === 'research-note' && receipt.result.record.noteId === id)).toBe(true)
    const listing = fixture.documents!.research.query('conversation:browser', { schemaVersion: 1, kind: 'notebook-query', expectedGeneration: 1, view: 'working', maxItems: 20, maxChars: 6000 })
    expect(listing.result.items.filter(item => item.recordId === id)).toHaveLength(1)
    await expect(page.locator('[data-selection-ticket]')).toHaveCount(1)
    expect(fixture.documents!.selections.get('conversation:browser', selected.ticketId)).toMatchObject({ state: 'staged', submissionId: null })

    await page.reload()
    await openNotebook(page)
    await expect(noteRow(page, id)).toBeVisible()
    await noteRow(page, id).getByRole('button', { name: '查看全文与版本', exact: true }).click()
    await expect(notebook(page).getByLabel('编辑笔记完整正文', { exact: true })).toHaveValue(body)
    expect(requests).toHaveLength(2); expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})

test('continues a saved source note from another conversation, edits the full CAS version, revisits the original PDF and archives then soft-deletes without claiming history erasure', async ({ page }) => {
  test.setTimeout(150000)
  const fixture = await liveHarness({ documents: true, answers: [] })
  try {
    const selected = await prepareSelection(page, fixture)
    const body = `${'逐项核对年度营收口径，并保留原文出处。\n'.repeat(40)}完整正文末尾：这里只记录待验证假设。`
    await confirmNote(page, selected.ticketId, body)
    const savedExchange = await captureNext(page, '**/research/notes')
    await notebook(page).getByRole('button', { name: '保存已确认笔记', exact: true }).click()
    const savedResponse = await savedExchange.result; await savedExchange.stop(); expect(savedResponse.status).toBe(200)
    const saved = parseContract('product-research', JSON.parse(savedResponse.body.toString('utf8')))
    if (saved.kind !== 'note-saved' || saved.result.record.recordType !== 'research-note') throw new Error('Expected real saved source note')
    const id = saved.result.record.noteId
    await expect(noteRow(page, id)).toBeVisible()
    await page.getByRole('button', { name: '关闭研究笔记', exact: true }).click()
    await page.getByRole('button', { name: '历史', exact: true }).click()
    const createdExchange = await captureNext(page, '**/api/conversations')
    // Creation commits the binding; the first real snapshot also waits for the cold runtime.
    const readySnapshot = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname.endsWith('/snapshot')
      && !response.url().includes(`/conversations/${encodeURIComponent('conversation:browser')}/`), { timeout: 30000 })
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    const createdResponse = await createdExchange.result; await createdExchange.stop(); expect(createdResponse.status).toBe(201)
    const binding = parseContract('product-control', JSON.parse(createdResponse.body.toString('utf8')))
    if (binding.kind !== 'binding') throw new Error('Expected real conversation binding')
    expect(binding.conversationId).not.toBe('conversation:browser')
    const ready = await readySnapshot
    expect(ready.status()).toBe(200)
    expect(new URL(ready.url()).pathname).toBe(`/api/conversations/${encodeURIComponent(binding.conversationId)}/snapshot`)
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await expect(page.getByRole('dialog', { name: '历史会话', exact: true })).toBeHidden()
    await openNotebook(page)
    await expect(notebook(page).getByText('此范围目前没有研究记录。', { exact: true })).toBeVisible()
    await notebook(page).getByRole('button', { name: '工作区历史', exact: true }).click()
    await expect(noteRow(page, id)).toContainText('待复核研究线索，不是新证据')
    await noteRow(page, id).getByRole('button', { name: '查看全文与版本', exact: true }).click()
    await expect(notebook(page).getByLabel('编辑笔记完整正文', { exact: true })).toHaveValue(body)
    const edited = `${body}\n第二轮研究：仍需补充对照资料，不能把笔记当作证据。`
    await notebook(page).getByLabel('编辑笔记完整正文', { exact: true }).fill(edited)
    const editExchange = await captureNext(page, `**/research/notes/${encodeURIComponent(id)}`)
    await notebook(page).getByRole('button', { name: '保存当前版本修改', exact: true }).click()
    const editResponse = await editExchange.result; await editExchange.stop(); expect(editResponse.status).toBe(200)
    const editInput = editResponse.request as NotebookMutation, changed = parseContract('product-research', JSON.parse(editResponse.body.toString('utf8')))
    expect(editInput).toMatchObject({ action: 'edit', expectedVersion: 1, recordId: id, text: edited })
    expect(changed).toMatchObject({ kind: 'notebook-updated', result: { state: { recordId: id, previousVersion: 1, version: 2, text: edited, epistemicStatus: 'unverified' } } })
    await expect(notebook(page).getByRole('region', { name: '完整研究记录', exact: true }).getByRole('heading')).toContainText('v2')
    await expect(notebook(page).getByLabel('编辑笔记完整正文', { exact: true })).toHaveValue(edited)

    const focusExchange = await captureNext(page, `**/research/notes/${encodeURIComponent(id)}/focus/*`)
    const originalExchange = await captureNext(page, `**/conversations/${encodeURIComponent(binding.conversationId)}/documents/*/*/original`, 'GET')
    await notebook(page).getByRole('button', { name: /^回到来源 1 · 第 2 页/ }).click()
    const focusResponse = await focusExchange.result; await focusExchange.stop(); expect(focusResponse.status).toBe(200)
    const focus = parseContract('product-research', JSON.parse(focusResponse.body.toString('utf8')))
    expect(focus).toMatchObject({ kind: 'research-focus', conversationId: binding.conversationId, recordId: id, status: 'resolved', physicalPage: 2,
      original: { documentId: selected.locator.documentId, revisionId: selected.locator.revisionId } })
    const original = await originalExchange.result; await originalExchange.stop(); expect(original.status).toBe(200)
    expect(original.contentType).toContain('application/pdf'); expect(original.body.equals(originalPdf)).toBe(true)
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
    await expect(page.locator('[data-focus-status=exact]')).toBeVisible()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    await page.getByRole('button', { name: '收起原文，返回聊天', exact: true }).click()
    await openNotebook(page)
    await expect(noteRow(page, id)).toBeVisible()
    await noteRow(page, id).getByRole('button', { name: '查看全文与版本', exact: true }).click()
    await expect(notebook(page).getByLabel('编辑笔记完整正文', { exact: true })).toHaveValue(edited)

    page.once('dialog', async dialog => { expect(dialog.message()).toContain('历史版本仍保留'); await dialog.accept() })
    await notebook(page).getByRole('button', { name: '归档记录', exact: true }).click()
    await expect(noteRow(page, id)).toContainText('已归档 · v3')
    await expect(notebook(page).getByRole('region', { name: '完整研究记录', exact: true }).getByRole('heading')).toContainText('v3')
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('历史版本仍然保留'); await dialog.accept() })
    await notebook(page).getByRole('button', { name: '软删除（保留历史）', exact: true }).click()
    await expect(noteRow(page, id)).toHaveCount(0)
    await expect(notebook(page).getByText('当前记录已软删除，历史版本仍保留。', { exact: true })).toBeVisible()
    expect(fixture.documents!.research.get(binding.conversationId, id)).toMatchObject({ version: 4, status: 'deleted', text: null, locators: [], evidence: [] })
    expect(fixture.documents!.selections.get('conversation:browser', selected.ticketId)).toMatchObject({ state: 'staged', submissionId: null })
    expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})
