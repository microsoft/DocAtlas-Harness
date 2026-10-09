import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from './test.js'
import type { AnswerResponse, CitationFocus, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'
import { longPdf } from './long-pdf.js'

/** Consume the real Pi tool-result message, not a second direct document API. */
function toolResult(messages: readonly unknown[], name: string): unknown {
  const message = [...messages].reverse().find(value => value !== null && typeof value === 'object'
    && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === name)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`Missing successful ${name} receipt`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('Tool receipt has no content')
  const text = content.find(value => value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'text')
  if (!text || typeof text.text !== 'string') throw new Error('Tool receipt has no JSON text')
  return JSON.parse(text.text)
}

for (const typography of [false, true]) test(`maps real Read citations to Markdown and original PDF after refresh${typography ? ' with split superscript typography' : ''}`, async ({ page }) => {
  test.setTimeout(120000)
  const bytes = typography ? longPdf({ typography: true }) : readFileSync('apps/web/public/documents/sample-report.pdf'), originalHash = createHash('sha256').update(bytes).digest('hex')
  let selected: ScopedSourceIdentity | undefined, readItem: TextBlockItem | undefined
  const answers: AnswerResponse[] = [], focuses: CitationFocus[] = [], originals: string[] = [], failures: string[] = []
  const fixture = await liveHarness({ documents: true, answers: [
    messages => {
      const current = JSON.stringify([...messages].reverse().find(message => message && typeof message === 'object' && Reflect.get(message, 'role') === 'user'))
      expect(current).toContain('docatlas-current-attachments')
      expect(current).toContain('already uploaded and prepared')
      expect(current).toContain('阅读第二页 Q4 相关条目')
      return { calls: [{ name: 'docatlas_sources', args: {} }] }
    },
    messages => {
      const result = toolResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[], scopeVersionId: string }
      expect(result.sources).toHaveLength(1); expect(result.scopeVersionId).toBeTruthy()
      selected = result.sources[0]!
      return { calls: [{ name: 'docatlas_read', args: { documentId: selected.documentId, revisionId: selected.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
    },
    messages => {
      const result = parseContract('sidecar-document-rpc', toolResult(messages, 'docatlas_read'))
      if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected the actual page Read result')
      expect(result.source.documentId).toBe(selected!.documentId); expect(result.source.revisionId).toBe(selected!.revisionId)
      readItem = result.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes('Q4'))
        .sort((left, right) => right.text.length - left.text.length)[0]
      if (!readItem) throw new Error(`The sample PDF has no Q4 block: ${JSON.stringify(result.items).slice(0, 2000)}`)
      expect(readItem.physicalPage).toBe(2)
      if (typography) expect(readItem.text).toContain('BERT36')
      expect(readItem.locator.selectors.some(selector => selector.type === 'text-quote' && selector.exact === readItem!.text)).toBe(true)
      return `## 5. 实验设计\n\n- **报告**：[原文包含 Q4 营收条目。](#docatlas.v1.support.${readItem.locator.locatorId})\n- [不存在的独立结论。](#docatlas.v1.support.loc:unknown-citation)\n\n| 指标 | 状态 |\n| --- | --- |\n| Q4 | 已读 |`
    },
  ] })
  page.on('pageerror', error => failures.push(error.message))
  try {
    // Capture real authenticated responses and forward the same bytes unchanged.
    await page.route('**/api/conversations/*/answers/**', async route => {
      const response = await route.fetch(), body = await response.body()
      if (response.ok()) {
        const value = parseContract('product-answer', JSON.parse(body.toString('utf8')))
        if (value.kind === 'answer-response') answers.push(value); else { expect(response.status()).toBe(200); focuses.push(value) }
      }
      await route.fulfill({ response, body })
    })
    await page.route('**/api/conversations/*/documents/*/*/original', async route => {
      const response = await route.fetch(), body = await response.body()
      expect(response.ok()).toBe(true); expect(response.headers()['content-type']).toContain('application/pdf')
      expect(body.equals(bytes)).toBe(true); originals.push(route.request().url())
      await route.fulfill({ response, body })
    })
    await page.goto(`${fixture.origin}/live.html`)

    await page.reload()
    await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByRole('button', { name: /^资料(?: · \d+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '引用验证报告.pdf', mimeType: 'application/pdf', buffer: bytes })
    await expect(page.getByRole('checkbox', { name: '用于提问：引用验证报告.pdf' })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：引用验证报告.pdf' }).check()
    await page.getByRole('button', { name: '回到对话', exact: true }).click()
    expect(originals).toHaveLength(0)
    await page.getByLabel('向 DocAtlas 提问').fill('阅读第二页 Q4 相关条目，给出可回到原文的引用。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible({ timeout: 60000 })
    const citation = page.getByRole('button', { name: '引用 1 · 支持 · 第 2 页，打开原始 PDF', exact: true })
    await expect(citation).toBeVisible({ timeout: 30000 })
    expect(fixture.model.getCallCount()).toBe(3)
    await expect(page.locator('.live-citation')).toHaveCount(1)
    await expect(page.locator('.live-message.provisional .live-citation')).toHaveCount(0)
    const unknown = page.locator('[data-answer-segment=unresolved]').filter({ hasText: '不存在的独立结论。' })
    await expect(unknown).toHaveAttribute('title', /尚未关联可点击的原文出处/)
    await expect(page.locator('.live-citation-explanation, .live-answer-actions, .live-probe')).toHaveCount(0)
    await expect(page.getByText('Citations lead to the original.', { exact: false })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '5. 实验设计', exact: true })).toBeVisible()
    await expect(page.locator('.live-answer-body table')).toBeVisible()
    await expect(page.locator('.live-answer-body li strong')).toHaveText('报告')
    await expect(unknown.locator('button,a')).toHaveCount(0)
    await expect(page.locator('a[href*="docatlas"]')).toHaveCount(0)
    expect(originals).toHaveLength(0)

    const saved = answers.find(value => value.status === 'available')!
    expect(saved.manifest?.citations).toHaveLength(1)
    expect(saved.manifest?.citations[0]?.locator.locatorId).toBe(readItem!.locator.locatorId)
    expect(saved.manifest?.verificationSummary.warnings).toContain('unknown-locator')
    const citationId = await citation.getAttribute('data-citation-id')
    expect(citationId).toBe(saved.manifest!.citations[0]!.citationId)
    const openVerifiedCitation = async () => {
      const count = focuses.length
      await citation.click()
      // The route recorder already awaits the complete real HTTP body and checks 200.
      // Chromium can omit loadingFinished for a fulfilled response after reload even
      // when the app consumed it; assert that body and the actual PDF/DOM below instead.
      await expect.poll(() => focuses.length, { timeout: 30000 }).toBe(count + 1)
      expect(focuses[count]).toMatchObject({ kind: 'citation-focus', status: 'resolved', conversationId: saved.conversationId,
        messageId: saved.messageId, citationId, locator: { locatorId: readItem!.locator.locatorId }, physicalPage: 2, exactText: readItem!.text })
    }
    await openVerifiedCitation()
    await expect(page.getByRole('region', { name: '原始 PDF 阅读器', exact: true })).toBeVisible()
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
    await expect(page.locator('[data-focus-status=exact]')).toContainText('已定位引用原文', { timeout: 15000 })
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    expect(focuses.at(-1)).toMatchObject({ status: 'resolved', exactText: readItem!.text, locator: { locatorId: readItem!.locator.locatorId },
      original: { documentId: selected!.documentId, revisionId: selected!.revisionId, contentHash: originalHash } })
    await expect(page.locator('.pdf-paper')).toHaveAttribute('data-document-id', `${selected!.documentId}:${selected!.revisionId}`)
    expect(originals).toHaveLength(1)

    // Following a citation is reversible and never erases the user's later reading position.
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.locator('.pdf-paper[data-page="3"][data-rendered=true]')).toBeVisible()
    await openVerifiedCitation()
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible()
    await page.getByRole('button', { name: '返回 A 上一处', exact: true }).click()
    await expect(page.locator('.pdf-paper[data-page="3"][data-rendered=true]')).toBeVisible()
    expect(originals).toHaveLength(1)

    await page.reload()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible()
    await expect(citation).toBeVisible()
    await expect(citation).toHaveAttribute('data-citation-id', citationId!)
    await expect(unknown.locator('button,a')).toHaveCount(0)
    await openVerifiedCitation()
    await expect(page.locator('[data-focus-status=exact]')).toContainText('已定位引用原文', { timeout: 15000 })
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    expect(originals).toHaveLength(2); expect(new Set(originals).size).toBe(1)
    expect(focuses.at(-1)?.locator.locatorId).toBe(readItem!.locator.locatorId)
    expect(answers.filter(value => value.status === 'available').every(value => value.manifest?.manifestId === saved.manifest!.manifestId && value.nativeTextHash === saved.nativeTextHash)).toBe(true)
    expect(fixture.model.getCallCount()).toBe(3)
    expect(failures).toEqual([])
  } finally { await fixture.close() }
})
