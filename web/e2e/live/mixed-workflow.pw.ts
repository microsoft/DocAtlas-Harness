import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './test.js'
import type { ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { lineageHarness } from './lineage-harness.js'

function toolText(messages: readonly unknown[], name: string): string {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === name)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`Missing successful real ${name}`)
  const parts: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(parts)) throw new Error('Missing real tool content')
  return parts.filter(part => part && typeof part === 'object' && part.type === 'text').map(part => String(part.text)).join('\n')
}

/** Provider decisions are scripted, but Read, native file tools, Bash/Node, files,
 * original PDF and checkpoint publication are real. Native outputs are not new Evidence. */
test('reads a PDF, computes with native code, saves CSV/chart/report, then runs a document-free task without losing the original citation', async ({ page }) => {
  test.setTimeout(150000)
  const pdf = readFileSync('apps/web/public/documents/sample-report.pdf'), originalHash = createHash('sha256').update(pdf).digest('hex')
  let source: ScopedSourceIdentity | undefined, locatorId = '', inputBytes = ''
  const compute = [
    "const fs = require('node:fs'), crypto = require('node:crypto');",
    "const raw = fs.readFileSync('source.json', 'utf8'), source = JSON.parse(raw);",
    "const match = source.text.match(/Q4[^0-9]*(\\d+(?:\\.\\d+)?)/);",
    "if (!match) throw new Error('No source Q4 value');",
    "const q4 = Number(match[1]), annualized = Math.round(q4 * 4 * 100) / 100;",
    "const result = { q4, annualized, inputHash: crypto.createHash('sha256').update(raw).digest('hex'), source: source.locatorId, status: 'illustrative-not-reviewed' };",
    "fs.writeFileSync('calculation.json', JSON.stringify(result));",
    "fs.writeFileSync('analysis.csv', 'metric,value_million,status\\nQ4,' + q4 + ',source-read\\nannualized,' + annualized + ',illustrative-not-reviewed\\n');",
    "fs.writeFileSync('analysis.md', '# Illustrative calculation\\n\\nQ4: ' + q4 + ' million. Q4 multiplied by four: ' + annualized + ' million.\\nThis is not reported annual revenue or reviewed derived Evidence.\\nOriginal source: ' + source.locatorId + '\\n');",
    "fs.writeFileSync('analysis.svg', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"480\" height=\"120\"><title>Illustrative annualization, not reported annual revenue</title><rect x=\"20\" y=\"20\" width=\"' + (q4 * 4) + '\" height=\"24\" fill=\"#426d64\"/><rect x=\"20\" y=\"64\" width=\"' + (annualized * 4) + '\" height=\"24\" fill=\"#8abbb0\"/><text x=\"275\" y=\"82\">Illustrative: ' + annualized + '</text></svg>');",
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n')
  const fixture = await lineageHarness({ answers: [
    { calls: [{ name: 'docatlas_sources', args: {} }] },
    (messages: readonly unknown[]) => {
      const value = JSON.parse(toolText(messages, 'docatlas_sources')) as { sources: ScopedSourceIdentity[] }
      expect(value.sources).toHaveLength(1); source = value.sources[0]!
      return { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 2, maxItems: 30, maxChars: 8000 } }] }
    },
    (messages: readonly unknown[]) => {
      const result = parseContract('sidecar-document-rpc', JSON.parse(toolText(messages, 'docatlas_read')))
      if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected actual page Read')
      const block = result.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]!
      expect(block.locator).toMatchObject({ ...source!, physicalPage: 2 }); expect(block.text).toMatch(/Q4[^0-9]*15\.2/u)
      locatorId = block.locator.locatorId; inputBytes = JSON.stringify({ text: block.text, locatorId, source })
      return { calls: [{ name: 'write', args: { path: 'source.json', content: inputBytes } }, { name: 'write', args: { path: 'calculate.cjs', content: compute } }] }
    },
    { calls: [{ name: 'bash', args: { command: 'node calculate.cjs', timeout: 15 } }] },
    (messages: readonly unknown[]) => {
      expect(JSON.parse(toolText(messages, 'bash'))).toMatchObject({ q4: 15.2, annualized: 60.8, status: 'illustrative-not-reviewed', source: locatorId,
        inputHash: createHash('sha256').update(inputBytes).digest('hex') })
      return { calls: [{ name: 'read', args: { path: 'analysis.md' } }] }
    },
    (messages: readonly unknown[]) => {
      expect(toolText(messages, 'read')).toContain('60.8'); expect(toolText(messages, 'read')).toContain('not reported annual revenue')
      return `[原文的 Q4 收入为 15.2 million。](#docatlas.v1.support.${locatorId})\n\n代码得到示例年化值 60.8 million，已保存 CSV、SVG 和报告；这不是原文全年收入，也不是已审阅的派生证据。`
    },
    { calls: [{ name: 'bash', args: { command: 'node -e "process.stdout.write(String(21 * 2))"', timeout: 15 } }] },
    (messages: readonly unknown[]) => { expect(toolText(messages, 'bash').trim()).toBe('42'); return '无文档任务的原生计算结果为 42。' },
  ] })
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const ask = async (page: Page, question: string, expected: string) => {
    await page.getByLabel('向 DocAtlas 提问').fill(question); await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const message = page.getByRole('region', { name: '会话消息', exact: true }).locator('[data-message-entry]').filter({ hasText: expected })
    await expect(message).toBeVisible({ timeout: 60000 }); await fixture.waitIdle(fixture.parent.conversationId)
    return (await message.getAttribute('data-message-entry'))!
  }
  try {
    await page.goto(fixture.origin);
    await page.reload(); await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await page.getByRole('button', { name: /^资料(?: · [0-9]+)?$/u }).click()
    await page.locator('input[type=file]').setInputFiles({ name: '混合工作流原文.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(page.getByRole('checkbox', { name: '用于提问：混合工作流原文.pdf', exact: true })).toBeVisible({ timeout: 60000 })
    await page.getByRole('checkbox', { name: '用于提问：混合工作流原文.pdf', exact: true }).check()
    await page.getByRole('button', { name: '回到对话', exact: true }).click()
    const first = await ask(page, '读取第二页的Q4原文，用原生代码计算Q4乘四的示例年化值，保存代码、输入、CSV、SVG和说明报告。不要把计算输出冒充原文或已审阅证据。', '代码得到示例年化值 60.8')
    expect(readFileSync(join(fixture.workspaceRoot, 'source.json'), 'utf8')).toBe(inputBytes)
    expect(readFileSync(join(fixture.workspaceRoot, 'calculate.cjs'), 'utf8')).toBe(compute)
    expect(readFileSync(join(fixture.workspaceRoot, 'analysis.csv'), 'utf8')).toContain('annualized,60.8,illustrative-not-reviewed')
    expect(readFileSync(join(fixture.workspaceRoot, 'analysis.svg'), 'utf8')).toContain('Illustrative: 60.8')
    expect(JSON.parse(readFileSync(join(fixture.workspaceRoot, 'calculation.json'), 'utf8'))).toMatchObject({ inputHash: createHash('sha256').update(inputBytes).digest('hex'), source: locatorId })
    const original = fixture.documents.answers.get(fixture.parent.conversationId, first)
    const historicalScope = fixture.documents.store.get(fixture.parent.conversationId)
    expect(original.status).toBe('available'); expect(original.manifest?.citations).toHaveLength(1)
    expect(original.manifest?.citations[0]).toMatchObject({ verificationStatus: 'read-verified', locator: { locatorId, physicalPage: 2 } })
    const derived = original.manifest?.blocks.flatMap(block => block.segments).filter(segment => segment.text.includes('60.8'))
    expect(derived?.length).toBeGreaterThan(0); expect(derived?.every(segment => segment.kind === 'unclassified' && segment.status === 'unresolved')).toBe(true)
    expect(fixture.model.getCallCount()).toBe(6)
    await page.getByRole('button', { name: /^资料(?: · [0-9]+)?$/u }).click()
    await page.getByRole('checkbox', { name: '用于提问：混合工作流原文.pdf', exact: true }).uncheck()
    await page.getByRole('button', { name: '回到对话', exact: true }).click()
    await ask(page, '这次不使用任何文档，请运行原生代码计算21乘以2。', '无文档任务的原生计算结果为 42')
    expect(fixture.model.getCallCount()).toBe(8)
    // Canonical historical scopes remain immutable; the consumed runtime frame,
    // not that saved catalog, owns permission to call document tools now.
    expect(fixture.documents.store.get(fixture.parent.conversationId)).toEqual(historicalScope)
    expect(() => fixture.documents.forConversation(fixture.parent.conversationId).session.invocation()).toThrow('No document sources are active for this submission')
    expect(fixture.documents.answers.get(fixture.parent.conversationId, first)).toEqual(original)
    await page.locator(`[data-message-entry="${first}"] .live-citation`).click()
    await expect(page.locator('.pdf-paper[data-page="2"][data-rendered=true]')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('evidence-highlight').first()).toBeVisible()
    const response = await page.request.get(`${fixture.origin}/api/conversations/${encodeURIComponent(fixture.parent.conversationId)}/documents/${encodeURIComponent(source!.documentId)}/${encodeURIComponent(source!.revisionId)}/original`)
    expect(response.status()).toBe(200); expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(originalHash)
    expect(errors).toEqual([])
  } finally { await fixture.close() }
})
