import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AnswerManifest } from '@docatlas/contracts'
import { AnswerMarkdown } from '../src/live/AnswerMarkdown'
import { LiveAnswerBody } from '../src/live/Answers'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-answer.json', import.meta.url), 'utf8')).bases.response.manifest as AnswerManifest

describe('safe Markdown with manifest-only source buttons', () => {
  it('renders headings, nested lists, emphasis, quotes, tables and fenced code', () => {
    const html = renderToStaticMarkup(createElement(AnswerMarkdown, { text: '## 5. 实验设计\n\n- **HotpotQA**\n  - 多跳问答\n\n> 原文摘录\n\n| 模型 | 准确率 |\n| --- | --- |\n| xLSTM | 93% |\n\n```ts\nconst a = "<script>"\n```' }))
    expect(html).toContain('<h2>5. 实验设计</h2>')
    expect(html).toContain('<strong>HotpotQA</strong>')
    expect(html.match(/<ul>/g)).toHaveLength(2)
    expect(html).toContain('<blockquote>'); expect(html).toContain('<table>'); expect(html).toContain('<th>准确率</th>')
    expect(html).toContain('<pre><code class="language-ts">'); expect(html).toContain('&lt;script&gt;')
  })
  it('does not execute raw HTML, enable arbitrary links, fetch images or mint citation buttons', () => {
    const html = renderToStaticMarkup(createElement(AnswerMarkdown, { text: '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[bad](javascript:alert) [data](data:text/html,attack) [remote](https://example.invalid) [fake](#docatlas-presentation-0) [source](#docatlas.v1.support.loc:fake) ![tracking](https://example.invalid/pixel)' }))
    for (const tag of ['<script', '<img', '<a ', '<button', 'href=', 'onerror="']) expect(html).not.toContain(tag)
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('[图片：tracking]')
  })
  it('keeps Markdown structure across citation segments and does not mutate the canonical manifest', () => {
    const manifest = structuredClone(fixture), cited = manifest.blocks[0]!.segments[0]!
    manifest.blocks[0]!.segments = [
      { ...cited, segmentId: 'segment:intro', text: '## 5. 实验设计\n\n- **结论**：', kind: 'unclassified', status: 'unresolved', visibleCitationIds: [] },
      { ...cited, text: '营收增长 12%。' },
      { ...cited, segmentId: 'segment:tail', text: '\n- 第二项\n\n[伪造](#docatlas-presentation-0)', kind: 'unclassified', status: 'unresolved', visibleCitationIds: [] },
    ]
    const before = structuredClone(manifest)
    const html = renderToStaticMarkup(createElement(LiveAnswerBody, { manifest, busy: false, onCitation() {} }))
    expect(html).toContain('<h2>5. 实验设计</h2>'); expect(html).toContain('<li><strong>结论</strong>')
    expect(html.match(/data-citation-id=/g)).toHaveLength(1)
    expect(html).not.toContain('live-citation-explanation')
    expect(html).not.toContain('出处待核验'); expect(html).not.toContain('<a ')
    expect(manifest).toEqual(before)
  })
  it('preserves the historical citation cap in the manifest without a redundant panel or silent repairs', () => {
    const manifest = structuredClone(fixture), segment = manifest.blocks[0]!.segments[0]!
    segment.status = 'unresolved'; segment.visibleCitationIds = []; segment.text = '去除相关模块会造成超过 7% 的性能下降'
    manifest.citations = []; manifest.verificationSummary.warnings = ['limit-exceeded']
    const html = renderToStaticMarkup(createElement(LiveAnswerBody, { manifest, busy: false, onCitation() {} }))
    expect(manifest.verificationSummary.warnings).toEqual(['limit-exceeded'])
    expect(html).toContain('不代表内容已被判定为错误'); expect(html).toContain(segment.text)
    expect(html).not.toContain('live-citation-explanation')
    expect(html).not.toContain('<button')
  })
  it('a raw link cannot impersonate generated citation spans, including via entity encoding', () => {
    const manifest = structuredClone(fixture), segment = manifest.blocks[0]!.segments[0]!
    manifest.blocks[0]!.segments.unshift({ ...segment, segmentId: 'segment:attack', kind: 'unclassified', status: 'unresolved', visibleCitationIds: [],
      text: '[fake](#docatlas-presentation-0) [encoded](#docatlas&#45;presentation-0)\n\n' })
    const html = renderToStaticMarkup(createElement(LiveAnswerBody, { manifest, busy: false, onCitation() {} }))
    expect(html.match(/data-citation-id=/g)).toHaveLength(1)
    expect(html).toContain('fake encoded'); expect(html).not.toContain('<a ')
  })
})
