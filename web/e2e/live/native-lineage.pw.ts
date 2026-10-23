import { clickHeaderAction, observeJsonAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { AnswerResponse, ProductLineageCommand, ProductLineageOperation, ProductNativeTreePage, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { lineageHarness } from './lineage-harness.js'

const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`
function toolResult(messages: readonly unknown[], tool: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === tool)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`Missing actual successful ${tool}`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('Missing actual tool content')
  const text = content.find(value => value && typeof value === 'object' && value.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Missing native tool JSON')
  return JSON.parse(text)
}
async function operation(page: Page, origin: string, conversationId: string, id: string): Promise<ProductLineageOperation> {
  const response = await page.request.get(`${origin}${conversationPath(conversationId)}/lineage/operations/${encodeURIComponent(id)}`)
  expect(response.status()).toBe(200)
  const value = parseContract('native-lineage', await response.json())
  if (!('kind' in value) || value.kind !== 'lineage-operation') throw new Error('Expected actual native lineage operation')
  return value
}
async function lineagePending(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@lineage:'))
    .map(([key, raw]) => ({ key, raw })))
}
async function openTree(page: Page) {
  await clickHeaderAction(page, '运行设置')
  await page.getByRole('button', { name: '分支／会话树', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '分支与会话树', exact: true })
  await expect(drawer).toBeVisible()
  return drawer
}
async function pair(page: Page, fixture: Awaited<ReturnType<typeof lineageHarness>>) {
  await page.goto(`${fixture.origin}/live.html`)

  const initialSnapshot = page.waitForEvent('requestfinished', {
    predicate: request => request.method() === 'GET' && request.url() === `${fixture.origin}${conversationPath(fixture.parent.conversationId)}/snapshot`,
    timeout: 30000,
  })
  await page.reload()
  // Reload can cancel an in-flight snapshot after its headers arrive. Observe a
  // completed request from the lazily started runtime before checking its binding.
  const response = await (await initialSnapshot).response()
  if (!response) throw new Error('Completed native snapshot has no response')
  expect(response.status()).toBe(200); expect(await response.finished()).toBeNull()
  expect(parseContract('conversation-observation', await response.json())).toMatchObject({ kind: 'conversation-snapshot', binding: fixture.parent })
  await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
}

/** Actual application, RuntimeManager, Pi SDK/JSONL, durable handoff, Read receipts,
 * authenticated HTTP and PDF bytes. No fixed fake CID/generation/head transitions. */
test('recovers a lost real navigation receipt, preserves original PDF citations across refresh and fork, and reads anew in the distinct child', async ({ page }) => {
  test.setTimeout(240000); page.setDefaultTimeout(15000)
  const pdf = readFileSync('apps/web/public/documents/sample-report.pdf'), hash = createHash('sha256').update(pdf).digest('hex')
  const firstText = '父会话原文列有 Q4 营收条目。', childText = '子会话重新读取的原文列有 Q4 营收条目。', fillerText = '这条后续回答不属于切换后的所选路径。'
  const sourceReads: Array<{ source: ScopedSourceIdentity, block: TextBlockItem, toolCallId: string }> = []
  let source: ScopedSourceIdentity | undefined
  const readSources = (messages: readonly unknown[]) => {
    const result = toolResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[], scopeVersionId: string }
    expect(result.sources).toHaveLength(1); expect(result.scopeVersionId).toBeTruthy(); source = result.sources[0]!
    return { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
  }
  const citeRead = (text: string) => (messages: readonly unknown[]) => {
    const result = parseContract('sidecar-document-rpc', toolResult(messages, 'docatlas_read'))
    if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected actual page Read')
    const block = result.items.filter((value): value is TextBlockItem => value.itemType === 'block' && value.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]
    if (!block || !source) throw new Error('Actual PDF has no Q4 block')
    expect(block.physicalPage).toBe(2); expect(block.locator).toMatchObject({ ...source })
    const receipt = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === 'docatlas_read')!
    const toolCallId: unknown = Reflect.get(receipt as object, 'toolCallId')
    expect(typeof toolCallId).toBe('string')
    sourceReads.push({ source: { ...source }, block, toolCallId: toolCallId as string })
    return `[${text}](#docatlas.v1.support.${block.locator.locatorId})`
  }
  const fixture = await lineageHarness({ answers: [
    { calls: [{ name: 'docatlas_sources', args: {} }] }, readSources, citeRead(firstText), fillerText,
    { calls: [{ name: 'docatlas_sources', args: {} }] }, readSources, citeRead(childText),
  ] })
  const parentId = fixture.parent.conversationId, initialBinding = fixture.binding(parentId)
  const commands: ProductLineageCommand[] = [], received: ProductLineageOperation[] = [], trees: ProductNativeTreePage[] = [], answerResponses: AnswerResponse[] = [], originalUrls: string[] = [], errors: string[] = []
  const messages = page.getByRole('region', { name: '会话消息', exact: true })
  let dropNavigation = true, holdReconciliation = false, navigationDeliveryLost = false
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('**/api/conversations/*/lineage', async route => {
      if (route.request().method() !== 'POST') {
        if (holdReconciliation) await route.abort('failed'); else await route.continue()
        return
      }
      const request = parseContract('native-lineage', route.request().postDataJSON())
      if (!('kind' in request) || request.kind !== 'lineage-command') throw new Error('Expected complete real lineage command')
      commands.push(request)
      const response = await route.fetch(), body = await response.body(); expect([200, 202]).toContain(response.status())
      const value = parseContract('native-lineage', JSON.parse(body.toString('utf8')))
      if (!('kind' in value) || value.kind !== 'lineage-operation') throw new Error('Expected real handoff acceptance')
      received.push(value)
      if (dropNavigation && request.action.kind === 'navigate') {
        dropNavigation = false
        await expect.poll(async () => (await operation(page, fixture.origin, parentId, value.operationId)).state, { timeout: 60000 }).toBe('succeeded')
        // Simulate a short browser transport outage only after actual durable handoff.
        // Trusted page.request polling above reaches the real operation, not a fabricated response.
        holdReconciliation = true; navigationDeliveryLost = true
        await route.abort('failed'); return
      }
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/lineage/tree', async route => {
      const response = await route.fetch(), body = await response.body()
      if (response.ok()) {
        const value = parseContract('native-lineage', JSON.parse(body.toString('utf8')))
        if (!('kind' in value) || value.kind !== 'native-tree-page') throw new Error('Expected actual native tree projection')
        trees.push(value)
      }
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/answers/**', async route => {
      const response = await route.fetch(), body = await response.body()
      if (response.ok()) {
        const value = parseContract('product-answer', JSON.parse(body.toString('utf8')))
        if (value.kind === 'answer-response') answerResponses.push(value)
      }
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf'); expect(response.headers().etag).toBe(`"${hash}"`)
      expect(body).toEqual(pdf); originalUrls.push(route.request().url()); await route.fulfill({ response, body })
    })
    await pair(page, fixture)
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '分支引用原文.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：分支引用原文.pdf', exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：分支引用原文.pdf', exact: true }).check()
    await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('读取第二页 Q4 内容并给出原始 PDF 引用。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const firstMessage = messages.locator('[data-message-entry]').filter({ hasText: firstText })
    await expect(firstMessage.locator('.live-citation')).toHaveCount(1, { timeout: 60000 }); await fixture.waitIdle(parentId)
    const firstId = (await firstMessage.getAttribute('data-message-entry'))!, original = fixture.documents.answers.get(parentId, firstId)
    expect(original.status).toBe('available'); expect(original.origin).toBeUndefined(); expect(original.manifest!.sessionId).toBe(parentId)
    expect(sourceReads).toHaveLength(1); expect(fixture.model.getCallCount()).toBe(3)
    const firstCitationId = original.manifest!.citations[0]!.citationId
    const openCitation = async (viewId: string, entryId = firstId, citationId = firstCitationId, block = sourceReads[0]!.block) => {
      const url = `${fixture.origin}${conversationPath(viewId)}/answers/${encodeURIComponent(entryId)}/citations/${encodeURIComponent(citationId)}`
      const response = await observeJsonAction(page, url, () => messages.locator(`[data-message-entry="${entryId}"] .live-citation`).click())
      expect(response.status).toBe(200)
      expect(parseContract('product-answer', response.value)).toMatchObject({ kind: 'citation-focus', status: 'resolved', conversationId: viewId,
        messageId: entryId, citationId, physicalPage: 2, exactText: block.text, locator: { locatorId: block.locator.locatorId },
        original: { documentId: sourceReads[0]!.source.documentId, revisionId: sourceReads[0]!.source.revisionId, contentHash: hash } })
      await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 })
      await expect(page.locator('[data-focus-status=exact]')).toContainText('已定位引用原文')
      await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
      await page.getByRole('button', { name: '收起原文，返回聊天', exact: true }).click()
    }
    await openCitation(parentId)
    await page.getByLabel('向 DocAtlas 提问').fill('添加一条之后可以离开的独立后续消息。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(messages).toContainText(fillerText, { timeout: 30000 }); await fixture.waitIdle(parentId)
    expect(fixture.model.getCallCount()).toBe(4)
    const draft = '尚未发送的父会话草稿，不能被树预览或 SDK 文本覆盖。'
    await page.getByLabel('向 DocAtlas 提问').fill(draft)
    let drawer = await openTree(page)
    await drawer.getByRole('button', { name: `选择原生节点 ${firstId}`, exact: true }).click()
    const sourceTree = trees.at(-1)!
    expect(sourceTree.binding).toEqual(initialBinding)
    expect(sourceTree.entries.find(entry => entry.entryId === firstId)).toMatchObject({ type: 'assistant', onSelectedBranch: true, canNavigate: true, canForkAt: true })
    await expect(drawer.getByLabel('切换时让 Pi 生成分支摘要')).not.toBeChecked()
    await drawer.getByRole('button', { name: '切换到这个原生位置', exact: true }).click()
    await expect.poll(() => navigationDeliveryLost, { timeout: 60000 }).toBe(true)
    await expect(drawer.getByRole('region', { name: '待核对分支操作', exact: true })).toBeVisible()
    expect(commands).toHaveLength(1); const frozenNavigation = commands[0]!
    expect(frozenNavigation).toMatchObject({ conversationId: parentId, expectedBindingId: initialBinding.bindingId, expectedGeneration: initialBinding.generation,
      runtimeSessionId: initialBinding.runtimeSessionId, expectedHead: sourceTree.head, action: { kind: 'navigate', targetEntryId: firstId, summarize: false } })
    const pending = await lineagePending(page); expect(pending).toHaveLength(1)
    expect(JSON.parse(pending[0]!.raw).request).toEqual(frozenNavigation)
    const navigation = await operation(page, fixture.origin, parentId, received[0]!.operationId)
    expect(navigation.state).toBe('succeeded'); expect(navigation.result!.proof.kind).toBe('native-navigation-proof')
    const navigated = fixture.binding(parentId)
    expect(navigated).toEqual(navigation.result!.targetBinding)
    expect(navigated).toMatchObject({ conversationId: parentId, runtimeSessionId: initialBinding.runtimeSessionId, generation: initialBinding.generation + 1 })
    expect(navigated.bindingId).not.toBe(initialBinding.bindingId)
    expect(fixture.model.getCallCount()).toBe(4)

    holdReconciliation = false
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft)
    drawer = await openTree(page)
    await expect(drawer.locator('[data-lineage-state="succeeded"]')).toBeVisible({ timeout: 30000 })
    await expect.poll(() => lineagePending(page)).toEqual([])
    expect(commands).toHaveLength(1) // Lost delivery is reconciled with GET, never SDK replay or a replacement key.
    await drawer.getByRole('button', { name: '刷新到已核验的当前分支', exact: true }).click()
    await page.getByRole('button', { name: '关闭分支与会话树', exact: true }).click()
    await expect(firstMessage.locator('.live-citation')).toHaveCount(1)
    await expect(messages).not.toContainText(fillerText)
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft)
    const afterNavigation = fixture.documents.answers.get(parentId, firstId)
    expect(afterNavigation.manifest).toEqual(original.manifest); expect(afterNavigation.nativeTextHash).toBe(original.nativeTextHash)
    expect(afterNavigation.origin).toEqual({ conversationId: parentId, bindingId: initialBinding.bindingId, generation: initialBinding.generation, runtimeSessionId: initialBinding.runtimeSessionId, entryId: firstId })
    await openCitation(parentId)
    await page.reload(); await expect(firstMessage.locator('.live-citation')).toHaveCount(1)
    await openCitation(parentId); expect(fixture.model.getCallCount()).toBe(4)

    drawer = await openTree(page)
    await drawer.getByRole('button', { name: `选择原生节点 ${firstId}`, exact: true }).click()
    await drawer.getByRole('button', { name: '从此节点创建子会话', exact: true }).click()
    await expect.poll(() => received.length).toBe(2)
    await expect(drawer.getByRole('region', { name: '分支操作回执', exact: true })).toContainText(received[1]!.operationId)
    await expect(drawer.locator('[data-lineage-state="succeeded"]')).toBeVisible({ timeout: 60000 })
    expect(commands).toHaveLength(2)
    const fork = await operation(page, fixture.origin, parentId, received[1]!.operationId)
    expect(fork.request).toMatchObject({ expectedBindingId: navigated.bindingId, expectedGeneration: navigated.generation, action: { kind: 'fork', targetEntryId: firstId, position: 'at' } })
    expect(fork.result!.proof.kind).toBe('native-fork-proof')
    const child = fork.result!.targetBinding
    expect(child.conversationId).not.toBe(parentId); expect(child.runtimeSessionId).not.toBe(navigated.runtimeSessionId)
    expect(child.generation).toBe(1); expect(fixture.binding(parentId)).toEqual(navigated); expect(fixture.binding(child.conversationId)).toEqual(child)
    // Creating a child is not opening it and does not consume the parent's draft or re-run a question.
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft); expect(fixture.model.getCallCount()).toBe(4)
    await drawer.getByRole('button', { name: '打开已核验的子会话', exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue('')
    await expect(firstMessage.locator('.live-citation')).toHaveCount(1, { timeout: 30000 })
    const inherited = fixture.documents.answers.get(child.conversationId, firstId)
    expect(inherited.conversationId).toBe(child.conversationId); expect(inherited.manifest).toEqual(original.manifest)
    expect(inherited.nativeTextHash).toBe(original.nativeTextHash); expect(inherited.origin).toEqual(afterNavigation.origin)
    await openCitation(child.conversationId)
    await expect(page.getByRole('button', { name: /^资料(?: · \d+)?$/u })).toBeVisible()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await expect(page.getByRole('checkbox', { name: '用于提问：分支引用原文.pdf', exact: true })).not.toBeChecked()
    await page.getByRole('checkbox', { name: '用于提问：分支引用原文.pdf', exact: true }).check()
    await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('在这个子会话中重新读取第二页 Q4 内容并给出新的引用回答。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const childMessage = messages.locator('[data-message-entry]').filter({ hasText: childText })
    await expect(childMessage.locator('.live-citation')).toHaveCount(1, { timeout: 60000 }); await fixture.waitIdle(child.conversationId)
    const childEntry = (await childMessage.getAttribute('data-message-entry'))!, childAnswer = fixture.documents.answers.get(child.conversationId, childEntry)
    expect(childAnswer.status).toBe('available'); expect(childAnswer.manifest!.sessionId).toBe(child.conversationId); expect(childAnswer.origin).toBeUndefined()
    expect(childEntry).not.toBe(firstId); expect(sourceReads).toHaveLength(2)
    expect(sourceReads[1]!.source).toEqual(sourceReads[0]!.source)
    expect(sourceReads[1]!.toolCallId).not.toBe(sourceReads[0]!.toolCallId) // Fresh actual Read, not a copied receipt; stable locators may legitimately match.
    expect(fixture.model.getCallCount()).toBe(7)
    await openCitation(child.conversationId, childEntry, childAnswer.manifest!.citations[0]!.citationId, sourceReads[1]!.block)
    const parentAfterChild = fixture.documents.answers.get(parentId, firstId)
    expect(parentAfterChild.manifest).toEqual(original.manifest); expect(parentAfterChild.nativeTextHash).toBe(original.nativeTextHash)
    expect(answerResponses.some(value => value.conversationId === child.conversationId && value.messageId === firstId && value.origin?.bindingId === initialBinding.bindingId)).toBe(true)
    expect(originalUrls.some(url => url.includes(conversationPath(parentId)))).toBe(true)
    expect(originalUrls.some(url => url.includes(conversationPath(child.conversationId)))).toBe(true)
    expect(commands).toHaveLength(2); expect(errors).toEqual([])
  } finally { await fixture.close() }
})

test('navigates to the parent of the first real user message and forks before it without replaying or copying that user text', async ({ page }) => {
  test.setTimeout(120000); page.setDefaultTimeout(15000)
  const firstQuestion = '第一条完整用户问题，不得被自动复制成新草稿。', firstAnswer = '第一条真实原生回答。', secondAnswer = '稍后分支之外的第二条回答。', freshAnswer = '空分支中新提交的问题得到了新回答。'
  const fixture = await lineageHarness({ answers: [firstAnswer, secondAnswer, freshAnswer] }), parentId = fixture.parent.conversationId
  const receipts: ProductLineageOperation[] = [], messages = page.getByRole('region', { name: '会话消息', exact: true })
  try {
    await page.route('**/api/conversations/*/lineage', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const response = await route.fetch(), body = await response.body(); expect([200, 202]).toContain(response.status())
      const value = parseContract('native-lineage', JSON.parse(body.toString('utf8')))
      if (!('kind' in value) || value.kind !== 'lineage-operation') throw new Error('Expected real native lineage operation')
      receipts.push(value); await route.fulfill({ response, body })
    })
    await pair(page, fixture)
    await page.getByLabel('向 DocAtlas 提问').fill(firstQuestion); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(messages).toContainText(firstAnswer, { timeout: 30000 }); await fixture.waitIdle(parentId)
    const firstUser = (await messages.locator('[data-message-entry]').filter({ hasText: firstQuestion }).getAttribute('data-message-entry'))!
    await page.getByLabel('向 DocAtlas 提问').fill('第二条完整用户问题。'); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(messages).toContainText(secondAnswer, { timeout: 30000 }); await fixture.waitIdle(parentId)
    const before = fixture.binding(parentId), draft = '独立保留的下一条草稿。'
    await page.getByLabel('向 DocAtlas 提问').fill(draft)
    let drawer = await openTree(page)
    await drawer.getByRole('button', { name: `选择原生节点 ${firstUser}`, exact: true }).click()
    await expect(drawer.locator(`[data-lineage-entry="${firstUser}"] .lineage-preview`)).toHaveText(firstQuestion)
    await drawer.getByRole('button', { name: '切换到这个原生位置', exact: true }).click()
    await expect(drawer.locator('[data-lineage-state="succeeded"]')).toBeVisible({ timeout: 60000 })
    expect(receipts).toHaveLength(1)
    const navigation = await operation(page, fixture.origin, parentId, receipts[0]!.operationId)
    expect(navigation.result!.proof).toMatchObject({ kind: 'native-navigation-proof', action: { kind: 'navigate', targetEntryId: firstUser, summarize: false } })
    const navigated = fixture.binding(parentId)
    expect(navigated.generation).toBe(before.generation + 1); expect(navigated.runtimeSessionId).toBe(before.runtimeSessionId)
    await drawer.getByRole('button', { name: '刷新到已核验的当前分支', exact: true }).click()
    await page.getByRole('button', { name: '关闭分支与会话树', exact: true }).click()
    await expect(messages.locator('[data-message-entry]')).toHaveCount(0)
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft)
    const projectedResponse = await page.request.get(`${fixture.origin}${conversationPath(parentId)}/snapshot`)
    expect(projectedResponse.status()).toBe(200)
    const projected = parseContract('conversation-observation', await projectedResponse.json())
    if (projected.kind !== 'conversation-snapshot') throw new Error('Expected actual selected native snapshot')
    expect(projected.history.messages).toEqual([])
    // The selected prefix contains real bootstrap/handoff metadata. An empty human
    // context is not a fabricated selectedLeaf=null and still has a verified seal.
    expect(navigation.result!.proof.targetHead.fileSeal.entryCount).toBeGreaterThan(0)
    await page.reload(); await expect(messages.locator('[data-message-entry]')).toHaveCount(0)
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(draft); expect(fixture.model.getCallCount()).toBe(2)
    drawer = await openTree(page)
    await drawer.getByRole('button', { name: `选择原生节点 ${firstUser}`, exact: true }).click()
    await drawer.getByRole('button', { name: '在此用户消息之前创建子会话', exact: true }).click()
    await expect.poll(() => receipts.length).toBe(2)
    await expect(drawer.getByRole('region', { name: '分支操作回执', exact: true })).toContainText(receipts[1]!.operationId)
    await expect(drawer.locator('[data-lineage-state="succeeded"]')).toBeVisible({ timeout: 60000 })
    const fork = await operation(page, fixture.origin, parentId, receipts[1]!.operationId), child = fork.result!.targetBinding
    expect(fork.result!.proof).toMatchObject({ kind: 'native-fork-proof', action: { kind: 'fork', position: 'before', targetEntryId: firstUser } })
    expect(child.conversationId).not.toBe(parentId); expect(child.runtimeSessionId).not.toBe(before.runtimeSessionId)
    expect(fixture.binding(parentId)).toEqual(navigated)
    await drawer.getByRole('button', { name: '打开已核验的子会话', exact: true }).click()
    await expect(drawer).toHaveCount(0); await expect(messages.locator('[data-message-entry]')).toHaveCount(0)
    await expect(page.getByLabel('向 DocAtlas 提问')).toHaveValue(''); expect(fixture.model.getCallCount()).toBe(2)
    await page.getByLabel('向 DocAtlas 提问').fill('这是用户明确提交的子会话新问题。'); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(messages).toContainText(freshAnswer, { timeout: 30000 }); await fixture.waitIdle(child.conversationId)
    await expect(messages).not.toContainText(firstQuestion); await expect(messages).not.toContainText(firstAnswer); await expect(messages).not.toContainText(secondAnswer)
    expect(fixture.model.getCallCount()).toBe(3); expect(receipts).toHaveLength(2)
  } finally { await fixture.close() }
})

test('pins browser Stop to the current binding, joins the actually cancelled provider turn, and accepts a new question afterward', async ({ page }) => {
  test.setTimeout(120000); page.setDefaultTimeout(15000)
  const firstText = '停止前已经完成并保存的回答。', heldText = '被停止的提供方不应产生这条回答。', freshText = '停止完成后明确提交的新问题已正常完成。'
  let providerCalls = 0, providerAborted = false, providerJoined = false, stops = 0
  const fixture = await lineageHarness({ answers: [firstText, heldText, freshText], beforeResponse: async signal => {
    if (++providerCalls !== 2) return
    if (!signal) throw new Error('Actual provider request has no cancellation signal')
    try {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { providerAborted = true; reject(new Error('Actual held provider request cancelled')) }
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })
    } finally { providerJoined = true }
  } })
  const conversationId = fixture.parent.conversationId, messages = page.getByRole('region', { name: '会话消息', exact: true })
  const send = async (text: string) => {
    const response = await observeJsonAction(page, `${fixture.origin}/api/submissions`, async () => {
      await page.getByLabel('向 DocAtlas 提问').fill(text); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    })
    expect(response.status).toBe(202)
    const value = parseContract('product-control', response.value)
    if (value.kind !== 'run-receipt') throw new Error('Expected actual product submission acceptance')
    // The client must acknowledge the actual receipt and leave its sending state.
    await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    return value
  }
  try {
    await pair(page, fixture)
    const first = await send('先完成这一轮，再测试停止另一轮。')
    await expect(messages).toContainText(firstText, { timeout: 30000 }); await fixture.waitIdle(conversationId)
    const savedFirst = fixture.control.get(fixture.actor, first.submissionId)
    expect(savedFirst.state).toBe('completed'); expect(savedFirst.checkpoint).not.toBeNull()
    const held = await send('让这轮实际进入提供方，然后由用户点击停止。')
    await expect.poll(() => providerCalls, { timeout: 30000 }).toBe(2)
    const binding = fixture.binding(conversationId), running = await fixture.manager.get(fixture.actor, conversationId)
    expect(running.worker.busy).toBe(true); expect(providerAborted).toBe(false); expect(providerJoined).toBe(false)
    const stopUrl = `${fixture.origin}${conversationPath(conversationId)}/stop`
    await page.route(stopUrl, async route => {
      stops++
      expect(route.request().method()).toBe('POST')
      expect(route.request().headers()['if-match']).toBe(JSON.stringify(binding.bindingId))
      expect(route.request().postData()).toBe('{}')
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(200)
      expect(parseContract('product-http', JSON.parse(body.toString('utf8')))).toEqual({ schemaVersion: 1, kind: 'runtime-stopped', conversationId, generation: binding.generation })
      // Verify the actual provider cancellation and native join before forwarding
      // the complete server receipt, as observeJsonAction does for submissions.
      expect(providerAborted).toBe(true); expect(providerJoined).toBe(true)
      const stopped = await fixture.manager.get(fixture.actor, conversationId)
      expect(stopped.worker.busy).toBe(false); expect(stopped.coordinator.busy).toBe(false); expect(stopped.native.activeCount).toBe(0)
      expect(fixture.control.get(fixture.actor, held.submissionId).state).toBe('cancelled')
      await route.fulfill({ response, body })
    })
    const responseReady = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === stopUrl)
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    expect((await responseReady).status()).toBe(200)
    // The bounded JSON reader can release Chromium's response before Playwright
    // observes completion. Require the client to finish Stop without an error.
    await expect(page.locator('.stop-button')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText('已停止', { exact: true })).toBeVisible()
    expect(stops).toBe(1); expect(fixture.binding(conversationId)).toEqual(binding)
    const receiptResponse = await page.request.get(`${fixture.origin}/api/submissions/${encodeURIComponent(held.submissionId)}`)
    expect(receiptResponse.status()).toBe(200)
    expect(parseContract('product-control', await receiptResponse.json())).toMatchObject({ kind: 'run-receipt', submissionId: held.submissionId, state: 'cancelled', generation: binding.generation })
    expect(fixture.control.get(fixture.actor, first.submissionId)).toEqual(savedFirst)
    await expect(messages).not.toContainText(heldText)
    const fresh = await send('停止已经完成，现在明确提出一个新问题。')
    await expect(messages).toContainText(freshText, { timeout: 30000 }); await fixture.waitIdle(conversationId)
    expect(fixture.control.get(fixture.actor, fresh.submissionId).state).toBe('completed')
    expect(fixture.control.get(fixture.actor, held.submissionId).state).toBe('cancelled')
    expect(fixture.control.get(fixture.actor, first.submissionId)).toEqual(savedFirst)
    expect(fixture.model.getCallCount()).toBe(3); expect(stops).toBe(1)
    await expect(messages).toContainText(firstText); await expect(messages).not.toContainText(heldText)
  } finally { await fixture.close() }
})
