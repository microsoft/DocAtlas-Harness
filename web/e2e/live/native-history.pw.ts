import { clickHeaderAction, observeJsonAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { ConversationSnapshot, ProductHistoryPage, ProductHistoryRequest, ProductNativeCommand, ProductNativeInspection, ProductNativeOperation, ProductSubmission, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'

const conversationId = 'conversation:browser', basePath = `/api/conversations/${encodeURIComponent(conversationId)}`
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function toolResult(messages: readonly unknown[], tool: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === tool)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`Missing actual successful ${tool}`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('Missing actual tool content')
  const text = content.find(value => value && typeof value === 'object' && value.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Missing real native tool JSON')
  return JSON.parse(text)
}
async function nativeState(page: Page, origin: string): Promise<ProductNativeInspection> {
  const response = await page.request.get(`${origin}${basePath}/native`)
  expect(response.status()).toBe(200)
  const value = parseContract('native-control', await response.json())
  if (!('kind' in value) || value.kind !== 'native-inspection') throw new Error('Expected actual native inspection')
  return value
}
async function nativeOperation(page: Page, origin: string, id: string): Promise<ProductNativeOperation> {
  const response = await page.request.get(`${origin}${basePath}/native/operations/${encodeURIComponent(id)}`)
  expect(response.status()).toBe(200)
  const value = parseContract('native-control', await response.json())
  if (!('kind' in value) || value.kind !== 'native-operation') throw new Error('Expected actual native operation')
  return value
}
async function snapshot(page: Page, origin: string): Promise<ConversationSnapshot> {
  const response = await page.request.get(`${origin}${basePath}/snapshot`)
  expect(response.status()).toBe(200)
  const value = parseContract('conversation-observation', await response.json())
  if (value.kind !== 'conversation-snapshot') throw new Error('Expected actual native conversation projection')
  return value
}
async function pending(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@native-controls:')).map(([key, raw]) => ({ key, raw })))
}

/** Provider text is explicitly scripted. Model registration, SDK controls, fsynced proofs,
 * 55 real Pi turns, native history pages, original user mapping and PDF citations are not fabricated. */
test('persists approved native controls before any question, restores lost proof read-only, and pages real older Pi messages without replay or scrolling away from the reading anchor', async ({ page }) => {
  test.setTimeout(300000)
  page.setDefaultTimeout(15000) // Fail a missing control promptly; 300s is the whole 55-turn budget.
  const rounds = 55, pdf = readFileSync('apps/web/public/documents/sample-report.pdf'), answerText = '首轮真实原文列有 Q4 营收条目。', question = '首轮提问：读取第二页Q4原文并提供原始PDF引用。'
  const filler = Array.from({ length: rounds - 1 }, (_, index) => `真实原生历史回答 ${String(index + 2).padStart(3, '0')}`)
  let source: ScopedSourceIdentity | undefined, block: TextBlockItem | undefined, firstProviderStarted = false, holdFirst = true, csrf = ''
  const releaseFirst = Promise.withResolvers<void>()
  const fixture = await liveHarness({ documents: true, models: [{ id: 'native-plain', name: 'Native plain model', reasoning: false }, { id: 'native-reason', name: 'Native reasoning model', reasoning: true }],
    beforeResponse: async () => { if (holdFirst) { holdFirst = false; firstProviderStarted = true; await releaseFirst.promise } }, answers: [
      { calls: [{ name: 'docatlas_sources', args: {} }] },
      messages => {
        const result = toolResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[] }
        expect(result.sources).toHaveLength(1); source = result.sources[0]!
        return { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
      },
      messages => {
        const result = parseContract('sidecar-document-rpc', toolResult(messages, 'docatlas_read'))
        if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected actual page Read')
        block = result.items.filter((value): value is TextBlockItem => value.itemType === 'block' && value.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]
        if (!block) throw new Error('Actual PDF has no Q4 block')
        expect(block.locator).toMatchObject({ ...source }); expect(block.physicalPage).toBe(2)
        return `[${answerText}](#docatlas.v1.support.${block.locator.locatorId})`
      },
      ...filler,
    ] })
  const commands: ProductNativeCommand[] = [], operations: ProductNativeOperation[] = [], historyInputs: ProductHistoryRequest[] = [], historyPages: ProductHistoryPage[] = [], originalUrls: string[] = [], errors: string[] = []
  let dropFirstConfiguration = true
  const drawer = page.getByRole('dialog', { name: '原生运行设置', exact: true }), messages = page.getByRole('region', { name: '会话消息', exact: true })
  const openSettings = async () => {
    await clickHeaderAction(page, '运行设置')
    await expect(drawer).toBeVisible(); await expect(drawer.getByRole('button', { name: '刷新原生状态（只读）', exact: true })).toBeEnabled()
  }
  const saveSetting = async (button: string) => {
    const before = commands.length
    await drawer.getByRole('button', { name: button, exact: true }).click()
    await expect.poll(() => commands.length).toBe(before + 1)
    await expect.poll(() => pending(page), { timeout: 30000 }).toEqual([])
    await expect(drawer.getByRole('button', { name: '刷新原生状态（只读）', exact: true })).toBeEnabled()
    const value = await nativeState(page, fixture.origin), saved = value.operations.find(item => item.request.idempotencyKey === commands.at(-1)!.idempotencyKey)
    expect(saved?.state).toBe('succeeded'); expect(saved?.result?.beforeHead).toEqual(commands.at(-1)!.expectedHead)
    expect(saved?.result?.action).toEqual(commands.at(-1)!.action)
    return value
  }
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('**/api/conversations/*/native', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const input = parseContract('native-control', route.request().postDataJSON())
      if (!('kind' in input) || input.kind !== 'native-command') throw new Error('Expected frozen native command')
      commands.push(input); csrf = route.request().headers()['x-docatlas-csrf'] ?? csrf
      const response = await route.fetch(), body = await response.body(); expect([200, 202]).toContain(response.status())
      const value = parseContract('native-control', JSON.parse(body.toString('utf8')))
      if (!('kind' in value) || value.kind !== 'native-operation') throw new Error('Expected real native operation receipt')
      operations.push(value)
      if (dropFirstConfiguration) {
        dropFirstConfiguration = false
        await expect.poll(async () => (await nativeOperation(page, fixture.origin, value.operationId)).state, { timeout: 30000 }).toBe('succeeded')
        await route.abort('failed'); return // Only lose delivery after witnessing the real native commit/proof.
      }
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/history', async route => {
      const input = parseContract('product-history', route.request().postDataJSON())
      if (input.kind !== 'history-page-request') throw new Error('Expected native history cursor request')
      historyInputs.push(input)
      const response = await route.fetch(), body = await response.body(); expect(response.status()).toBe(200)
      const value = parseContract('product-history', JSON.parse(body.toString('utf8')))
      if (value.kind !== 'history-page') throw new Error('Expected actual native history page')
      for (const message of value.messages) {
        if (message.role === 'assistant') { expect(message.displayOrigin).toBe('native'); if (!message.truncated) expect(hash(message.text)).toBe(message.nativeTextHash) }
        else expect(['submission', 'unavailable']).toContain(message.displayOrigin)
      }
      historyPages.push(value); await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf'); expect(response.headers().etag).toBe(`"${hash(pdf)}"`); expect(body).toEqual(pdf)
      originalUrls.push(route.request().url()); await route.fulfill({ response, body })
    })
    await page.goto(`${fixture.origin}/live.html`);
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '原生控制历史原文.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：原生控制历史原文.pdf', exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：原生控制历史原文.pdf', exact: true }).check(); await page.getByRole('button', { name: '回到对话', exact: true }).click()
    const draft = '这条问题草稿尚未提交，配置模型不应改变它。'
    await page.getByLabel('向 DocAtlas 提问').fill(draft); await openSettings()
    const initial = await nativeState(page, fixture.origin), target = initial.models.find(model => model.id === 'native-reason')!
    expect(initial.models.map(model => model.id)).toEqual(['native-plain', 'native-reason']); expect(initial.state).not.toBeNull()
    expect(initial.state!.configuration.model.id).toBe('native-plain')
    await expect(drawer.getByLabel('原生模型', { exact: true }).locator('option')).toHaveCount(2)
    expect((await snapshot(page, fixture.origin)).history.messages).toEqual([]); expect(fixture.model.getCallCount()).toBe(0)
    await drawer.getByLabel('原生模型', { exact: true }).selectOption(JSON.stringify([target.provider, target.id]))
    await drawer.getByRole('button', { name: '单独保存模型', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '使用原键核对配置操作', exact: true })).toBeEnabled({ timeout: 30000 })
    const retained = await pending(page); expect(retained).toHaveLength(1); expect(commands).toHaveLength(1)
    expect(JSON.parse(retained[0]!.raw).request).toEqual(commands[0]); expect(commands[0]!.expectedHead).toEqual(initial.state!.head)
    expect(commands[0]).toMatchObject({ expectedBindingId: initial.binding.bindingId, expectedGeneration: initial.binding.generation, runtimeSessionId: initial.binding.runtimeSessionId,
      approvalId: initial.resource.approvalId, expectedApprovalVersion: initial.resource.version, action: { kind: 'set-model', provider: target.provider, modelId: target.id } })
    const committed = await nativeOperation(page, fixture.origin, operations[0]!.operationId)
    expect(committed).toMatchObject({ state: 'succeeded', result: { beforeHead: initial.state!.head, configuration: { model: { provider: target.provider, id: target.id } } } })
    expect(committed.result!.afterHead.entryCount).toBeGreaterThan(committed.result!.beforeHead.entryCount)
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft); await openSettings()
    await expect.poll(() => pending(page)).toEqual([]); expect(commands).toHaveLength(1)
    await expect(drawer.getByRole('region', { name: '原生配置操作回执', exact: true })).toContainText(committed.result!.markerEntryId)
    let current = await nativeState(page, fixture.origin)
    expect(current.state!.configuration.model.id).toBe(target.id)
    expect(current.state!.thinkingLevels.length).toBeGreaterThan(1)
    const level = current.state!.thinkingLevels.includes('max') ? 'max' : current.state!.thinkingLevels.at(-1)!
    expect(await drawer.getByLabel('原生思考档位', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))).toEqual(current.state!.thinkingLevels)
    await drawer.getByLabel('原生思考档位', { exact: true }).selectOption(level); current = await saveSetting('单独保存思考档位')
    expect(current.state!.configuration.thinkingLevel).toBe(level)
    const steering = current.state!.configuration.steeringMode === 'all' ? 'one-at-a-time' : 'all'
    await drawer.getByLabel('插入消息队列模式', { exact: true }).selectOption(steering); current = await saveSetting('单独保存插入队列模式')
    const followUp = current.state!.configuration.followUpMode === 'all' ? 'one-at-a-time' : 'all'
    await drawer.getByLabel('跟进消息队列模式', { exact: true }).selectOption(followUp); current = await saveSetting('单独保存跟进队列模式')
    expect(current.state!.configuration).toMatchObject({ model: { id: target.id }, thinkingLevel: level, steeringMode: steering, followUpMode: followUp })
    expect(commands).toHaveLength(4); expect(fixture.model.getCallCount()).toBe(0); expect((await snapshot(page, fixture.origin)).history.messages).toEqual([])
    await page.getByRole('button', { name: '关闭原生运行设置', exact: true }).click()
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft); await expect(page.getByRole('button', { name: '资料 · 1', exact: true })).toBeVisible()
    await page.getByLabel('向 DocAtlas 提问').fill(question); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect.poll(() => firstProviderStarted, { timeout: 30000 }).toBe(true)
    await openSettings(); const busy = await nativeState(page, fixture.origin)
    expect(busy.busy).toBe(true); expect(busy.state).toBeNull(); expect(busy.models).toEqual(initial.models)
    await expect(drawer).toContainText('当前有执行中的工作'); await expect(drawer.getByLabel('原生模型', { exact: true })).toHaveCount(0)
    expect(commands).toHaveLength(4)
    await page.getByRole('button', { name: '关闭原生运行设置', exact: true }).click(); releaseFirst.resolve()
    const firstMessage = messages.locator('[data-message-entry]').filter({ hasText: answerText })
    await expect(firstMessage.locator('.live-citation')).toHaveCount(1, { timeout: 60000 }); await fixture.coordinator.waitForIdle()
    const firstId = (await firstMessage.getAttribute('data-message-entry'))!, savedAnswer = fixture.documents!.answers.get(conversationId, firstId), manifest = savedAnswer.manifest!
    expect(fixture.model.getCallCount()).toBe(3)
    const originalQuestionId = (await snapshot(page, fixture.origin)).history.messages.find(message => message.role === 'user')!.entryId
    const focusUrl = `${fixture.origin}${basePath}/answers/${encodeURIComponent(firstId)}/citations/${encodeURIComponent(manifest.citations[0]!.citationId)}`
    const firstFocusResponse = await observeJsonAction(page, focusUrl, () => firstMessage.locator('.live-citation').click())
    expect(firstFocusResponse.status).toBe(200)
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 }); await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    await page.getByRole('button', { name: '收起原文，返回聊天', exact: true }).click()
    const laterDraft = '分页时正在编辑的下一条草稿，也不得被重发或替换。'
    await page.getByLabel('向 DocAtlas 提问').fill(laterDraft)
    // Populate a genuinely longer native branch through the authenticated product API, not by editing JSONL or making fake snapshots.
    const headers = { origin: fixture.origin, 'content-type': 'application/json', 'x-docatlas-csrf': csrf }
    for (let index = 2; index <= rounds; index++) {
      const input: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: initial.binding.generation, idempotencyKey: `native-history:question:${String(index).padStart(3, '0')}`,
        mode: 'prompt', text: `真实历史提问 ${String(index).padStart(3, '0')}`, sourceRefs: [], selectionContextIds: [] }
      const response = await page.request.post(`${fixture.origin}/api/submissions`, { headers, data: input }); expect(response.status()).toBe(202)
      const receipt = parseContract('product-control', await response.json())
      if (receipt.kind !== 'run-receipt') throw new Error('Expected real submission acceptance')
      await fixture.coordinator.waitForIdle()
      const settled = await page.request.get(`${fixture.origin}/api/submissions/${encodeURIComponent(receipt.submissionId)}`)
      expect(settled.status()).toBe(200); expect(parseContract('product-control', await settled.json())).toMatchObject({ kind: 'run-receipt', state: 'completed' })
    }
    expect(fixture.model.getCallCount()).toBe(rounds + 2)
    await clickHeaderAction(page, '刷新状态')
    await expect(messages).toContainText(filler.at(-1)!); await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toBeVisible()
    await expect(firstMessage).toHaveCount(0)
    const nativeBeforePaging = [...fixture.contexts], commandsBeforePaging = [...commands], before = await snapshot(page, fixture.origin)
    expect(before.history.hasEarlier).toBe(true); expect(before.history.messages).toHaveLength(100)
    await messages.evaluate(container => { container.scrollTop = 0 })
    const anchor = await messages.evaluate(container => {
      const bounds = container.getBoundingClientRect(), message = [...container.querySelectorAll<HTMLElement>('[data-message-entry]')].find(node => { const box = node.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom })!
      return { id: message.dataset.messageEntry!, offset: message.getBoundingClientRect().top - bounds.top }
    })
    await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
    await expect(messages.locator('[data-message-entry]')).toHaveCount(rounds * 2, { timeout: 30000 })
    await expect(firstMessage).toBeAttached(); await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0)
    // The older canonical Answer resolves asynchronously and changes message heights.
    // Verify the original anchor after that real layout work, within the same 2px bound.
    await expect(firstMessage.locator('.live-citation')).toHaveCount(1)
    await expect.poll(async () => {
      const actualOffset = await messages.evaluate((container, id) => [...container.querySelectorAll<HTMLElement>('[data-message-entry]')].find(node => node.dataset.messageEntry === id)!.getBoundingClientRect().top - container.getBoundingClientRect().top, anchor.id)
      return Math.abs(actualOffset - anchor.offset)
    }).toBeLessThan(2)
    expect(historyInputs[0]!.cursor).toBeNull(); expect(historyInputs).toHaveLength(3)
    expect(historyInputs[1]!.cursor).toBe(historyPages[0]!.nextCursor); expect(historyInputs[2]!.cursor).toBe(historyPages[1]!.nextCursor)
    expect(historyPages.every(value => value.checkpoint?.transcriptHash === before.history.checkpoint!.transcriptHash)).toBe(true)
    const oldQuestion = historyPages.flatMap(value => value.messages).find(value => value.entryId === originalQuestionId)!
    expect(oldQuestion).toMatchObject({ role: 'user', displayOrigin: 'submission', text: question, truncated: false })
    expect(historyPages.flatMap(value => value.messages).find(value => value.entryId === firstId)).toMatchObject({ role: 'assistant', displayOrigin: 'native', nativeTextHash: savedAnswer.nativeTextHash })
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(laterDraft); await expect(page.getByRole('button', { name: '资料 · 1', exact: true })).toBeVisible()
    expect(fixture.contexts).toEqual(nativeBeforePaging); expect(commands).toEqual(commandsBeforePaging)
    const oldFocusResponse = await observeJsonAction(page, focusUrl, () => firstMessage.locator('.live-citation').click())
    expect(oldFocusResponse.status).toBe(200)
    expect(parseContract('product-answer', oldFocusResponse.value)).toMatchObject({ kind: 'citation-focus', status: 'resolved', exactText: block!.text, original: { documentId: source!.documentId, revisionId: source!.revisionId, contentHash: hash(pdf) } })
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 }); await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    expect(new Set(originalUrls).size).toBe(1); expect(fixture.documents!.answers.get(conversationId, firstId)).toEqual(savedAnswer)
    await page.reload(); await openSettings()
    expect((await nativeState(page, fixture.origin)).state!.configuration).toEqual(current.state!.configuration)
    expect(commands).toHaveLength(4); expect(fixture.model.getCallCount()).toBe(rounds + 2); expect(errors).toEqual([])
  } finally { releaseFirst.resolve(); await fixture.close() }
})
