import { clickDetailAction } from './ui.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { AnswerResponse, CitationFocus, ProductRevisionHistory, ProductRevisionImport, ProductRevisionImportState, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

const conversationId = 'conversation:browser', workspaceId = 'workspace:browser'
const basePath = `/api/conversations/${encodeURIComponent(conversationId)}`
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function toolResults(messages: readonly unknown[], name: string): unknown[] {
  return messages.flatMap(message => {
    if (!message || typeof message !== 'object' || Reflect.get(message, 'role') !== 'toolResult' || Reflect.get(message, 'toolName') !== name) return []
    if (Reflect.get(message, 'isError')) throw new Error(`Actual ${name} failed`)
    const content: unknown = Reflect.get(message, 'content')
    if (!Array.isArray(content)) throw new Error('Native tool result has no content')
    const text = content.find(item => item && typeof item === 'object' && item.type === 'text')?.text
    if (typeof text !== 'string') throw new Error('Native tool result has no JSON text')
    return [JSON.parse(text)]
  })
}
function readBlock(value: unknown, expected: ScopedSourceIdentity, page: number, text: string): TextBlockItem {
  const result = parseContract('sidecar-document-rpc', value)
  if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected an actual native page Read result')
  expect(result.source).toMatchObject({ documentId: expected.documentId, revisionId: expected.revisionId, representationId: expected.representationId })
  const item = result.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes(text)).sort((a, b) => b.text.length - a.text.length)[0]
  if (!item) throw new Error(`Actual page ${page} Read has no expected source text`)
  expect(item.physicalPage).toBe(page)
  expect(item.locator).toMatchObject({ ...expected })
  expect(item.locator.selectors.some(selector => selector.type === 'text-quote' && selector.exact === item.text)).toBe(true)
  return item
}
async function versionPending(page: Page) {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@revision:'))
    .map(([key, raw]) => ({ key, raw })))
}
async function history(page: Page, origin: string, documentId: string): Promise<ProductRevisionHistory> {
  const response = await page.request.get(`${origin}${basePath}/documents/${encodeURIComponent(documentId)}/revisions`)
  expect(response.status()).toBe(200)
  const value = parseContract('product-library', await response.json())
  if (value.kind !== 'revision-history') throw new Error('Expected actual immutable Library history')
  return value
}

/** Faux provider output is explicit; every source, Read, scope, import, receipt, PDF byte and
 * highlight below comes from the real local Pi/product/document/Browser path, never Demo data. */
test('same-document revisions preserve old citations, recover imports read-only, and feed two exact native source versions', async ({ page }) => {
  test.setTimeout(240000)
  const oldBytes = readFileSync('apps/web/public/documents/sample-report.pdf'), newBytes = longPdf({ embeddedToc: false })
  const firstText = '旧版保留 Q4 营收条目。', compareOldText = '旧版第二页列出季度营收。', compareNewText = '新版第四页记录实验观察。'
  let oldSource: ScopedSourceIdentity | undefined, newSource: ScopedSourceIdentity | undefined, firstBlock: TextBlockItem | undefined
  let oldRevision = '', newRevision = '', firstScope = '', comparedScope = ''
  const expectedOriginals = new Map<string, Buffer>(), originalRequests: string[] = [], answers: AnswerResponse[] = [], focuses: CitationFocus[] = []
  const imports: ProductRevisionImport[] = [], statuses: ProductRevisionImport[] = [], statusReceipts: ProductRevisionImportState[] = [], mutationRequests: string[] = [], errors: string[] = []
  let dropImport = true, holdStatus = false, statusHeld = false, csrf = ''
  const releaseStatus = Promise.withResolvers<void>()
  const fixture = await liveHarness({ documents: true, answers: [
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    messages => {
      const result = toolResults(messages, 'docatlas_sources').at(-1) as { sources: ScopedSourceIdentity[], scopeVersionId: string }
      expect(result.sources).toHaveLength(1); oldSource = result.sources[0]!; firstScope = result.scopeVersionId
      expect(oldSource.revisionId).toBe(oldRevision); expect(firstScope).toBeTruthy()
      return { calls: [{ name: 'docatlas_read', args: { documentId: oldSource.documentId, revisionId: oldRevision, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    },
    messages => {
      firstBlock = readBlock(toolResults(messages, 'docatlas_read').at(-1), oldSource!, 2, 'Q4')
      return `[${firstText}](#docatlas.v1.support.${firstBlock.locator.locatorId})`
    },
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    messages => {
      const result = toolResults(messages, 'docatlas_sources').at(-1) as { sources: ScopedSourceIdentity[], scopeVersionId: string }
      expect(result.sources).toHaveLength(2)
      expect(result.sources.map(item => item.documentId)).toEqual([oldSource!.documentId, oldSource!.documentId])
      expect(result.sources.map(item => item.revisionId).sort()).toEqual([oldRevision, newRevision].sort())
      expect(result.sources.find(item => item.revisionId === oldRevision)).toEqual(oldSource)
      newSource = result.sources.find(item => item.revisionId === newRevision)!; comparedScope = result.scopeVersionId
      expect(comparedScope).not.toBe(firstScope)
      return { calls: [
        { name: 'docatlas_read', args: { documentId: oldSource!.documentId, revisionId: oldRevision, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } },
        { name: 'docatlas_read', args: { documentId: newSource.documentId, revisionId: newRevision, mode: 'page', physicalPage: 4, maxItems: 30, maxChars: 6000 } },
      ] }
    },
    messages => {
      const actual = toolResults(messages, 'docatlas_read').slice(-2)
      const byRevision = (revision: string) => actual.find(value => value && typeof value === 'object' && Reflect.get(value, 'source')?.revisionId === revision)
      const old = readBlock(byRevision(oldRevision), oldSource!, 2, 'Q4'), current = readBlock(byRevision(newRevision), newSource!, 4, 'Experiment 4 observation 1:')
      expect(old.locator.locatorId).toBe(firstBlock!.locator.locatorId)
      expect(current.locator.representationId).not.toBe(old.locator.representationId)
      return `[${compareOldText}](#docatlas.v1.support.${old.locator.locatorId})\n[${compareNewText}](#docatlas.v1.support.${current.locator.locatorId})`
    },
  ] })
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(`${basePath}/uploads`) && request.method() !== 'GET' && !path.endsWith('/revision-status')) mutationRequests.push(`${request.method()} ${path}`)
  })
  const library = page.getByRole('button', { name: /^资料(?: · \d+)?$/u })
  const openVersions = async (documentId: string) => {
    await library.click()
    await clickDetailAction(page.locator(`[data-library-document="${documentId}"]`).getByRole('button', { name: '版本与更新', exact: true, includeHidden: true }))
    await expect(page.getByRole('dialog', { name: '版本与更新', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择 PDF 作为此文档新版本', exact: true }).or(page.getByRole('button', { name: '重新选择原 PDF 续传', exact: true }))).toBeEnabled({ timeout: 30000 })
  }
  try {
    await page.route('**/api/conversations/*/uploads/*/revision-*', async route => {
      const request = parseContract('product-library', route.request().postDataJSON())
      if (request.kind !== 'revision-import') throw new Error('Expected frozen revision command')
      csrf = route.request().headers()['x-docatlas-csrf'] ?? csrf
      const writing = new URL(route.request().url()).pathname.endsWith('/revision-import')
      if (writing) imports.push(request); else statuses.push(request)
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(writing ? 202 : 200)
      const state = parseContract('product-library', JSON.parse(body.toString('utf8')))
      if (state.kind !== 'revision-import-state') throw new Error('Expected real revision receipt')
      expect(state.request).toEqual(request)
      if (!writing) statusReceipts.push(state)
      if (writing && dropImport) {
        dropImport = false
        await fixture.documents!.library.whenIdle() // Witness actual commit before deliberately losing its HTTP delivery.
        expect(fixture.documents!.store.getLibraryDocument(workspaceId, request.targetDocumentId)?.revisionCount).toBe(2)
        await route.abort('failed'); return
      }
      if (!writing && holdStatus) { holdStatus = false; statusHeld = true; await releaseStatus.promise }
      await route.fulfill({ response, body }) // Every non-dropped response is forwarded unchanged.
    })
    await page.route('**/api/conversations/*/answers/**', async route => {
      const response = await route.fetch(), body = await response.body()
      if (response.ok()) { const value = parseContract('product-answer', JSON.parse(body.toString('utf8'))); if (value.kind === 'answer-response') answers.push(value); else focuses.push(value) }
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const revision = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!), expected = expectedOriginals.get(revision)
      if (!expected) throw new Error('Browser requested an unknown original revision')
      const response = await route.fetch(), body = await response.body()
      expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf')
      expect(body).toEqual(expected); expect(response.headers().etag).toBe(`"${hash(expected)}"`)
      originalRequests.push(revision); await route.fulfill({ response, body })
    })
    await page.goto(`${fixture.origin}/live.html`)
    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await library.click()
    await page.locator('input[type=file]').setInputFiles({ name: '原版分析.pdf', mimeType: 'application/pdf', buffer: oldBytes })
    await expect(page.locator('[data-library-document]')).toHaveCount(1, { timeout: 60000 })
    const card = page.locator('[data-library-document]'), documentId = (await card.getAttribute('data-library-document'))!
    oldRevision = (await card.getAttribute('data-library-revision'))!; expectedOriginals.set(oldRevision, oldBytes)
    await card.getByRole('checkbox').check(); await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('请读取原版第二页Q4条目，并引用原始PDF。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const firstAnswer = page.locator('.live-answer-body').filter({ hasText: firstText }), firstCitation = firstAnswer.locator('.live-citation')
    await expect(firstCitation).toBeVisible({ timeout: 60000 }); await fixture.coordinator.waitForIdle()
    const firstManifest = answers.find(value => value.status === 'available' && value.manifest?.sourceScopeVersionId === firstScope)!.manifest!
    expect(fixture.model.getCallCount()).toBe(3)
    await firstCitation.click()
    await expect(page.locator(`.pdf-paper[data-document-id="${documentId}:${oldRevision}"][data-page="2"][data-rendered=true]`)).toBeVisible()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()

    await openVersions(documentId)
    await page.getByLabel('上传此文档新版本 PDF', { exact: true }).setInputFiles({ name: '新版分析.pdf', mimeType: 'application/pdf', buffer: newBytes })
    await expect(page.getByRole('button', { name: '使用原键继续同一版本导入', exact: true })).toBeEnabled({ timeout: 60000 })
    expect(imports).toHaveLength(1); expect(imports[0]).toMatchObject({ targetDocumentId: documentId, expectedCurrentRevisionId: oldRevision })
    const retained = await versionPending(page); expect(retained).toHaveLength(1)
    const committed = await history(page, fixture.origin, documentId)
    newRevision = committed.currentRevisionId; expectedOriginals.set(newRevision, newBytes)
    expect(newRevision).not.toBe(oldRevision); expect(committed.versions).toHaveLength(2)
    expect(committed.versions.every(value => value.revision.documentId === documentId)).toBe(true)
    expect(committed.versions[0]!.revision.previousRevisionId).toBe(oldRevision)
    expect(fixture.documents!.store.listLibraryDocuments(workspaceId)).toHaveLength(1)
    expect(fixture.documents!.store.get(conversationId).scope?.scopeVersionId).toBe(firstScope)
    const mutationsBeforeReload = [...mutationRequests]
    holdStatus = true
    await page.reload(); await openVersions(documentId)
    await expect.poll(() => statusHeld).toBe(true)
    expect(await versionPending(page)).toEqual(retained); expect(mutationRequests).toEqual(mutationsBeforeReload); expect(imports).toHaveLength(1)
    expect(statuses.at(-1)).toEqual(imports[0])
    releaseStatus.resolve()
    await expect.poll(() => versionPending(page)).toEqual([])
    await expect(page.locator('[data-document-revision]')).toHaveCount(2)
    expect(statusReceipts.some(value => value.job?.status === 'succeeded' && value.request.idempotencyKey === imports[0]!.idempotencyKey)).toBe(true)
    const oldCard = page.locator(`[data-document-revision="${oldRevision}"]`), newCard = page.locator(`[data-document-revision="${newRevision}"]`)
    await expect(oldCard.getByRole('checkbox')).toBeChecked(); await expect(newCard.getByRole('checkbox')).not.toBeChecked()
    expect(mutationRequests).toEqual(mutationsBeforeReload); expect(fixture.model.getCallCount()).toBe(3)

    // A separately keyed stale CAS is rejected; the readonly status endpoint does not create a job.
    const stale = { ...imports[0]!, idempotencyKey: 'revision:browser:stale-precondition' }
    const headers = { origin: fixture.origin, 'content-type': 'application/json', 'x-docatlas-csrf': csrf }
    const stalePath = `${fixture.origin}${basePath}/uploads/${encodeURIComponent(stale.uploadId)}`
    expect((await page.request.post(`${stalePath}/revision-import`, { headers, data: stale })).status()).toBe(409)
    const absent = await page.request.post(`${stalePath}/revision-status`, { headers, data: stale }); expect(absent.status()).toBe(200)
    expect(parseContract('product-library', await absent.json())).toMatchObject({ kind: 'revision-import-state', request: stale, job: null })

    await page.getByLabel('上传此文档新版本 PDF', { exact: true }).setInputFiles({ name: '新版分析.pdf', mimeType: 'application/pdf', buffer: newBytes })
    await expect(page.getByText('已确认复用当前版本的相同内容，没有新增版本，也未更改提问来源。', { exact: true })).toBeVisible({ timeout: 60000 })
    await expect.poll(() => versionPending(page)).toEqual([])
    expect(imports).toHaveLength(2); expect(imports[1]!.expectedCurrentRevisionId).toBe(newRevision)
    expect((await history(page, fixture.origin, documentId)).versions).toHaveLength(2)
    await expect(oldCard.getByRole('checkbox')).toBeChecked(); await expect(newCard.getByRole('checkbox')).not.toBeChecked()
    await newCard.getByRole('checkbox').check(); await expect(oldCard.getByRole('checkbox')).toBeChecked()
    await clickDetailAction(oldCard.getByRole('button', { name: '放入对照 A', exact: true, includeHidden: true }))
    const paneA = page.locator('[data-reader-pane=A]'), paneB = page.locator('[data-reader-pane=B]')
    await expect(paneA.locator('[data-source-revision]')).toHaveAttribute('data-source-revision', oldRevision)
    await openVersions(documentId); await clickDetailAction(newCard.getByRole('button', { name: '放入对照 B', exact: true, includeHidden: true }))
    await expect(paneB.locator('[data-source-revision]')).toHaveAttribute('data-source-revision', newRevision)
    await expect(paneB.locator('.pdf-paper[data-page="1"][data-rendered=true]')).toBeVisible()
    for (let number = 2; number <= 4; number++) { await paneB.getByRole('button', { name: '下一页', exact: true }).click(); await expect(paneB.locator(`.pdf-paper[data-page="${number}"][data-rendered=true]`)).toBeVisible() }
    await expect(paneB.locator('.pdf-text-layer')).toContainText('Experiment 4 observation 1:')
    await expect(library).toHaveText('资料 · 2')
    expect(fixture.documents!.store.get(conversationId).scope?.scopeVersionId).toBe(firstScope)
    await paneA.getByRole('button', { name: /^A ·/u }).click(); await firstCitation.click()
    await expect(paneA.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
    await expect(paneA.getByTestId('evidence-highlight').first()).toBeVisible()
    await expect(paneB.locator('[data-source-revision]')).toHaveAttribute('data-source-revision', newRevision)
    expect(focuses.at(-1)).toMatchObject({ original: { revisionId: oldRevision, contentHash: hash(oldBytes), name: '原版分析.pdf' } })

    await page.getByLabel('向 DocAtlas 提问').fill('并排核对两个已选版本：原版第二页Q4、新版第四页实验观察，各自引用原文。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const comparison = page.locator('.live-answer-body').filter({ hasText: compareNewText })
    await expect(comparison.locator('.live-citation')).toHaveCount(2, { timeout: 60000 }); await fixture.coordinator.waitForIdle()
    expect(fixture.model.getCallCount()).toBe(6)
    const active = fixture.documents!.store.get(conversationId)
    expect(active.scope?.scopeVersionId).toBe(comparedScope)
    expect(active.sources?.map(value => [value.documentId, value.revisionId]).sort()).toEqual([[documentId, oldRevision], [documentId, newRevision]].sort())
    const compared = answers.find(value => value.status === 'available' && value.manifest?.sourceScopeVersionId === comparedScope)!.manifest!
    expect(compared.citations.map(value => value.locator.revisionId).sort()).toEqual([oldRevision, newRevision].sort())
    expect(compared.citations.every(value => value.verificationStatus === 'read-verified')).toBe(true)
    await paneA.getByRole('button', { name: /^A ·/u }).click(); await comparison.getByRole('button', { name: '引用 1 · 支持 · 第 2 页，打开原始 PDF', exact: true }).click()
    await expect(paneA.locator(`.pdf-paper[data-document-id="${documentId}:${oldRevision}"][data-page="2"][data-rendered=true]`)).toBeVisible()
    await expect(paneA.getByTestId('evidence-highlight').first()).toBeVisible()
    await paneB.getByRole('button', { name: /^B ·/u }).click(); await comparison.getByRole('button', { name: '引用 2 · 支持 · 第 4 页，打开原始 PDF', exact: true }).click()
    await expect(paneB.locator(`.pdf-paper[data-document-id="${documentId}:${newRevision}"][data-page="4"][data-rendered=true]`)).toBeVisible()
    await expect(paneB.getByTestId('evidence-highlight').first()).toBeVisible()
    expect(new Set(originalRequests)).toEqual(new Set([oldRevision, newRevision]))
    const nativeBeforeReload = [...fixture.contexts], mutationsAtEnd = [...mutationRequests]
    await page.reload(); await expect(page.locator('.live-citation')).toHaveCount(3, { timeout: 30000 })
    await firstCitation.click()
    await expect(page.locator(`.pdf-paper[data-document-id="${documentId}:${oldRevision}"][data-page="2"][data-rendered=true]`)).toBeVisible()
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    expect(fixture.model.getCallCount()).toBe(6); expect(fixture.contexts).toEqual(nativeBeforeReload); expect(mutationRequests).toEqual(mutationsAtEnd)
    expect(fixture.documents!.answers.get(conversationId, firstManifest.messageId).manifest).toEqual(firstManifest)
    expect((await history(page, fixture.origin, documentId)).versions).toHaveLength(2)
    await expect(library).toHaveText('资料 · 2'); expect(errors).toEqual([])
  } finally { releaseStatus.resolve(); await fixture.close() }
})
