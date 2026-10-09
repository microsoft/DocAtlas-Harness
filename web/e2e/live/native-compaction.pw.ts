import { clickHeaderAction, observeJsonAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { ConversationSnapshot, NativeControlApply, ProductNativeCommand, ProductNativeInspection, ProductNativeOperation, ProductSubmission, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { verifyNativeControlProof } from '../../packages/runtime-pi/lib/worker/index.js'
import { liveHarness } from './harness.js'

const conversationId = 'conversation:browser', basePath = `/api/conversations/${encodeURIComponent(conversationId)}`
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function toolResult(messages: readonly unknown[], tool: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === tool)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`Missing successful native ${tool}`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('Missing actual tool content')
  const text = content.find(value => value && typeof value === 'object' && value.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Missing native tool JSON')
  return JSON.parse(text)
}
async function inspection(page: Page, origin: string): Promise<ProductNativeInspection> {
  const response = await page.request.get(`${origin}${basePath}/native`); expect(response.status()).toBe(200)
  const value = parseContract('native-control', await response.json())
  if (!('kind' in value) || value.kind !== 'native-inspection') throw new Error('Missing actual native inspection')
  return value
}
async function operation(page: Page, origin: string, id: string): Promise<ProductNativeOperation> {
  const response = await page.request.get(`${origin}${basePath}/native/operations/${encodeURIComponent(id)}`); expect(response.status()).toBe(200)
  const value = parseContract('native-control', await response.json())
  if (!('kind' in value) || value.kind !== 'native-operation') throw new Error('Missing actual native operation')
  return value
}
async function history(page: Page, origin: string): Promise<ConversationSnapshot['history']> {
  const response = await page.request.get(`${origin}${basePath}/snapshot`); expect(response.status()).toBe(200)
  const value = parseContract('conversation-observation', await response.json())
  if (value.kind !== 'conversation-snapshot') throw new Error('Missing actual native history projection')
  return value.history
}
async function pending(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@native-controls:')).map(([key, raw]) => ({ key, raw })))
}

/** Provider text and summary are scripted, not a model-quality evaluation. Native Pi turns,
 * manual compact, policy bypass, fsynced proofs, real PDF Read and citations are exercised end to end. */
test('compacts genuine Pi context from the Web without losing original PDF citations, replaying a lost response, or treating a summary as new evidence', async ({ page }) => {
  test.setTimeout(240000); page.setDefaultTimeout(15000)
  const pdf = readFileSync('apps/web/public/documents/sample-report.pdf'), instructions = '保留待核验问题、文档版本和原始引用；摘要不能替代重新读取。'
  const firstText = '压缩前已读取第二页的 Q4 原文。', unsupportedText = '摘要记得旧引用，但这轮尚未重新读取。', freshText = '压缩后重新读取了同一版 PDF 的 Q4 原文。'
  const summarySentinel = 'NATIVE_COMPACTION_CONTEXT_ONLY', rounds = 6
  let phase: 'initial' | 'filler' | 'compact' | 'unsupported' | 'fresh' = 'initial', stage = 0, filler = 0, csrf = ''
  let source: ScopedSourceIdentity | undefined, oldBlock: TextBlockItem | undefined, freshBlock: TextBlockItem | undefined
  const commands: ProductNativeCommand[] = [], receipts: ProductNativeOperation[] = [], originals: string[] = [], errors: string[] = []
  const respond = (messages: readonly unknown[]) => {
    if (phase === 'filler') return `真实背景工作记录 ${++filler}：${'X'.repeat(15900)}`
    if (phase === 'compact') return `${summarySentinel}: 已完成文档阅读；尚待重新核验。[旧阅读结果](#docatlas.v1.support.${oldBlock!.locator.locatorId})`
    if (phase === 'unsupported') return `[${unsupportedText}](#docatlas.v1.support.${oldBlock!.locator.locatorId})`
    if (stage++ === 0) return { calls: [{ name: 'docatlas_sources', args: {} }] }
    if (stage === 2) {
      const result = toolResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[] }
      expect(result.sources).toHaveLength(1)
      if (source) expect(result.sources[0]).toEqual(source); else source = result.sources[0]!
      return { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    }
    const read = parseContract('sidecar-document-rpc', toolResult(messages, 'docatlas_read'))
    if (!('resultType' in read) || read.resultType !== 'read' || read.mode !== 'page') throw new Error('Expected actual PDF page Read')
    const item = read.items.filter((value): value is TextBlockItem => value.itemType === 'block' && value.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]
    if (!item) throw new Error('Missing actual Q4 text block')
    expect(item.physicalPage).toBe(2); expect(item.locator).toMatchObject({ ...source! })
    if (phase === 'initial') oldBlock = item; else freshBlock = item
    return `[${phase === 'initial' ? firstText : freshText}](#docatlas.v1.support.${item.locator.locatorId})`
  }
  const fixture = await liveHarness({ documents: true, tokenSize: 8192, answers: Array.from({ length: 32 }, () => respond) })
  const messages = page.getByRole('region', { name: '会话消息', exact: true }), drawer = page.getByRole('dialog', { name: '原生运行设置', exact: true })
  const openSettings = async () => { await clickHeaderAction(page, '运行设置'); await expect(drawer.getByRole('button', { name: '刷新原生状态（只读）', exact: true })).toBeEnabled() }
  const send = async (text: string) => {
    const response = await observeJsonAction(page, `${fixture.origin}/api/submissions`, async () => {
      await page.getByLabel('向 DocAtlas 提问').fill(text); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    })
    expect(response.status).toBe(202)
    const receipt = parseContract('product-control', response.value); if (receipt.kind !== 'run-receipt') throw new Error('Missing actual user submission receipt')
    return receipt
  }
  const message = (text: string) => messages.locator('[data-message-entry]').filter({ hasText: text })
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST' && request.url() === `${fixture.origin}/api/submissions`) csrf = request.headers()['x-docatlas-csrf'] ?? csrf })
  try {
    await page.route('**/api/conversations/*/native', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const command = parseContract('native-control', route.request().postDataJSON())
      if (!('kind' in command) || command.kind !== 'native-command') throw new Error('Expected frozen compact command')
      commands.push(command)
      const response = await route.fetch(), value = parseContract('native-control', await response.json())
      expect([200, 202]).toContain(response.status())
      if (!('kind' in value) || value.kind !== 'native-operation') throw new Error('Expected durable native command receipt')
      receipts.push(value)
      await expect.poll(async () => (await operation(page, fixture.origin, value.operationId)).state, { timeout: 30000 }).toBe('succeeded')
      await route.abort('failed') // Drop only delivery, after the real SDK compaction and native proof have committed.
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const response = await route.fetch(), bytes = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf'); expect(response.headers().etag).toBe(`"${hash(pdf)}"`); expect(bytes).toEqual(pdf)
      originals.push(route.request().url()); await route.fulfill({ response, body: bytes })
    })
    await page.goto(`${fixture.origin}/live.html`);
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '压缩与原文连续性.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：压缩与原文连续性.pdf', exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：压缩与原文连续性.pdf', exact: true }).check(); await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await send('阅读第二页 Q4 条目，并提供原始 PDF 引用。')
    await expect(message(firstText).locator('.live-citation')).toHaveCount(1, { timeout: 60000 }); await fixture.coordinator.waitForIdle()
    const firstId = (await message(firstText).getAttribute('data-message-entry'))!, savedAnswer = fixture.documents!.answers.get(conversationId, firstId)
    expect(savedAnswer.manifest?.citations).toHaveLength(1)
    const citation = savedAnswer.manifest!.citations[0]!, focusUrl = `${fixture.origin}${basePath}/answers/${encodeURIComponent(firstId)}/citations/${encodeURIComponent(citation.citationId)}`
    const openOldCitation = async () => {
      const response = await observeJsonAction(page, focusUrl, () => message(firstText).locator('.live-citation').click())
      expect(response.status).toBe(200)
      expect(parseContract('product-answer', response.value)).toMatchObject({ kind: 'citation-focus', status: 'resolved', exactText: oldBlock!.text,
        original: { documentId: source!.documentId, revisionId: source!.revisionId, contentHash: hash(pdf) } })
      await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 }); await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    }
    await openOldCitation(); await page.getByRole('button', { name: '收起原文，返回聊天', exact: true }).click()
    phase = 'filler'
    const initial = await inspection(page, fixture.origin), headers = { origin: fixture.origin, 'content-type': 'application/json', 'x-docatlas-csrf': csrf }
    // Genuine product submissions exceed the SDK's unchanged 20k keepRecentTokens. No JSONL edits or invented messages.
    for (let index = 0; index < rounds; index++) {
      const input: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: initial.binding.generation, idempotencyKey: `compact:context:${index}`,
        mode: 'prompt', text: `记录第 ${index + 1} 轮正常工作背景，稍后将测试原生上下文压缩。`, sourceRefs: [], selectionContextIds: [] }
      const response = await page.request.post(`${fixture.origin}/api/submissions`, { headers, data: input }); expect(response.status()).toBe(202)
      const receipt = parseContract('product-control', await response.json()); if (receipt.kind !== 'run-receipt') throw new Error('Missing real submission receipt')
      await fixture.coordinator.waitForIdle()
      const settled = await page.request.get(`${fixture.origin}/api/submissions/${encodeURIComponent(receipt.submissionId)}`)
      expect(parseContract('product-control', await settled.json())).toMatchObject({ kind: 'run-receipt', state: 'completed' })
    }
    const beforeHistory = await history(page, fixture.origin), file = fixture.worker.verifiedFile!, beforeBytes = readFileSync(file), beforeRows = beforeBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
    const calls = fixture.model.getCallCount(), policyCalls = fixture.getPolicyPrepareCount(), draft = '这条草稿还未提交，压缩或刷新不得重发。'
    expect(calls).toBe(rounds + 3); expect(policyCalls).toBe(calls)
    await page.getByLabel('向 DocAtlas 提问').fill(draft); await openSettings()
    expect((await inspection(page, fixture.origin)).state?.compaction?.canCompact).toBe(true)
    await drawer.getByLabel('压缩时特别保留（可选）', { exact: true }).fill(instructions); phase = 'compact'
    await drawer.getByRole('button', { name: '压缩当前上下文', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '使用原键核对配置操作', exact: true })).toBeEnabled({ timeout: 30000 })
    const retained = await pending(page); expect(retained).toHaveLength(1); expect(commands).toHaveLength(1)
    expect(JSON.parse(retained[0]!.raw).request).toEqual(commands[0]); expect(commands[0]!.action).toEqual({ kind: 'compact', instructions })
    const committed = await operation(page, fixture.origin, receipts[0]!.operationId), proof = committed.result!, effect = proof.compaction!
    expect(committed.state).toBe('succeeded'); expect(proof.action).toEqual(commands[0]!.action)
    const input: NativeControlApply = { operationId: committed.operationId, requestHash: committed.requestHash, expectedHead: commands[0]!.expectedHead, action: commands[0]!.action }
    expect(verifyNativeControlProof(file, input, { status: 'applied', proof }, fixture.model.models)).toEqual({ status: 'applied', proof })
    const afterBytes = readFileSync(file), rows = afterBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string, id?: string, summary?: string })
    expect(afterBytes.subarray(0, beforeBytes.length).equals(beforeBytes)).toBe(true)
    expect(rows.slice(beforeRows.length).map(row => row.type)).toEqual(['custom', 'compaction', 'custom'])
    const compaction = rows.find(row => row.id === effect.entryId)!; expect(compaction.summary).toContain(summarySentinel); expect(hash(compaction.summary!)).toBe(effect.summaryHash)
    expect(rows.filter(row => row.type === 'message')).toHaveLength(beforeRows.filter(row => row.type === 'message').length)
    expect(fixture.model.getCallCount()).toBeGreaterThan(calls); expect(fixture.getPolicyPrepareCount()).toBe(policyCalls) // Genuine auxiliary generation bypasses answer-personalization policy.
    expect(hash(JSON.stringify(await history(page, fixture.origin)))).toBe(hash(JSON.stringify(beforeHistory)))
    const callsAfterCompact = fixture.model.getCallCount()
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft); await openSettings()
    await expect.poll(() => pending(page)).toEqual([]); expect(commands).toHaveLength(1); expect(fixture.model.getCallCount()).toBe(callsAfterCompact)
    await expect(drawer.getByRole('region', { name: '原生配置操作回执', exact: true })).toContainText(effect.entryId)
    await page.getByRole('button', { name: '关闭原生运行设置', exact: true }).click(); await expect(messages).not.toContainText(summarySentinel)
    await expect(message(firstText).locator('.live-citation')).toHaveCount(1); await openOldCitation()
    expect(fixture.documents!.answers.get(conversationId, firstId)).toEqual(savedAnswer)
    await page.getByRole('button', { name: '收起原文，返回聊天', exact: true }).click()
    const beforeUnsupportedCount = readFileSync(file, 'utf8').trim().split('\n').length
    phase = 'unsupported'; const unsupportedReceipt = await send('摘要提到了旧引用；本轮还未读取，请区分上下文与证据。')
    await expect(message(unsupportedText)).toBeVisible({ timeout: 30000 }); await fixture.coordinator.waitForIdle()
    const unsupportedSettled = await page.request.get(`${fixture.origin}/api/submissions/${encodeURIComponent(unsupportedReceipt.submissionId)}`)
    expect(parseContract('product-control', await unsupportedSettled.json())).toMatchObject({ kind: 'run-receipt', state: 'completed' })
    const unsupportedRows = readFileSync(file, 'utf8').trim().split('\n').slice(beforeUnsupportedCount).map(line => JSON.parse(line) as { type: string, message?: { role: string, content?: Array<{ type: string }> } })
    expect(unsupportedRows.filter(row => row.type === 'message').map(row => row.message?.role)).toEqual(['user', 'assistant'])
    expect(unsupportedRows.some(row => row.message?.role === 'toolResult' || Array.isArray(row.message?.content) && row.message.content.some(block => block.type === 'toolCall'))).toBe(false)
    await expect(message(unsupportedText)).toContainText('当前回答没有可用的引用记录，尚不能点击核对原文。')
    await expect(message(unsupportedText).locator('.live-citation')).toHaveCount(0)
    const unsupportedId = (await message(unsupportedText).getAttribute('data-message-entry'))!, unsupported = fixture.documents!.answers.get(conversationId, unsupportedId)
    expect(unsupported.manifest?.citations ?? []).toEqual([])
    phase = 'fresh'; stage = 0; await send('现在重新读取第二页 Q4 原文，并提供本轮的新核验引用。')
    await expect(message(freshText).locator('.live-citation')).toHaveCount(1, { timeout: 60000 }); await fixture.coordinator.waitForIdle()
    expect(freshBlock?.text).toBe(oldBlock!.text); expect(freshBlock?.locator.locatorId).toBe(oldBlock!.locator.locatorId)
    const freshId = (await message(freshText).getAttribute('data-message-entry'))!, freshAnswer = fixture.documents!.answers.get(conversationId, freshId)
    expect(freshId).not.toBe(firstId); expect(freshAnswer.manifest?.citations[0]?.locator.locatorId).toBe(freshBlock!.locator.locatorId)
    expect(fixture.model.getCallCount()).toBe(callsAfterCompact + 4); expect(fixture.getPolicyPrepareCount()).toBe(policyCalls + 4)
    await page.setViewportSize({ width: 390, height: 844 }); await openSettings()
    await expect(drawer.getByRole('button', { name: '压缩当前上下文', exact: true })).toBeVisible()
    // Visibility is not animation stability: measure the real final layout after
    // this drawer's finite reveal animation, without disabling motion or relaxing bounds.
    await drawer.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))) })
    const bounds = await drawer.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await page.getByRole('button', { name: '关闭原生运行设置', exact: true }).click(); await message(freshText).locator('.live-citation').click()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible({ timeout: 20000 })
    expect(new Set(originals).size).toBe(1); expect(commands).toHaveLength(1); expect(errors).toEqual([])
  } finally { await fixture.close() }
})
