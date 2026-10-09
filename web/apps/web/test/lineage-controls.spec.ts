import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LineageActionForm, LineageOperationStatus, LineageTreeList } from '../src/live/LineageControls'
import { lineageDraft, mergeLineageTree } from '../src/live/lineage-state'
import { lineageFixture } from './lineage-fixture'

it('keeps the tree a bounded parent/depth projection with escaped previews, not a replacement question', async () => {
  const test = await lineageFixture(), tree = mergeLineageTree(test.identity, test.inspection, null, test.tree, null, 'messages')
  tree.entries[0]!.preview = '<script>not executable</script>'
  const html = renderToStaticMarkup(createElement(LineageTreeList, { tree, selected: tree.entries[0]!.entryId, onSelect() {} }))
  expect(html).toContain('aria-label="原生会话树"'); expect(html).toContain('data-lineage-parent="entry:question"')
  expect(html).toContain('data-lineage-depth="1"'); expect(html).toContain('当前路径'); expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<textarea')
})
it('supports native summary/instructions/replace/label without filling the form from SDK previews', async () => {
  const test = await lineageFixture(), entry = test.tree.entries[0]!
  const html = renderToStaticMarkup(createElement(LineageActionForm, { entry, draft: lineageDraft(), disabled: false, onChange() {}, onAction() {} }))
  expect(html).toContain('分支摘要说明'); expect(html).toContain('替换默认摘要说明'); expect(html).toContain('分支位置标签')
  expect(html).toContain('当前草稿不自动替换'); expect(html).toContain('父会话保持不变')
  expect(html).not.toContain(`>${entry.preview}</textarea>`)
  expect(html).toContain('切换到这个原生位置'); expect(html).toContain('在此用户消息之前创建子会话')
})
it('disables before-user fork on assistant nodes and blocks all writes while a pending operation exists', async () => {
  const test = await lineageFixture(), entry = test.tree.entries[1]!
  const html = renderToStaticMarkup(createElement(LineageActionForm, { entry, draft: lineageDraft(), disabled: true, onChange() {}, onAction() {} }))
  expect(html.match(/<button[^>]*disabled=""/gu)).toHaveLength(3)
  expect(html).toContain('不把 SDK 文本或预览复制到子会话'); expect(html).not.toContain('type="password"')
})
it('never calls handoff/unknown/missing-result ready or offers an unfinished target', async () => {
  const test = await lineageFixture('fork')
  for (const state of ['accepted', 'applying', 'handoff', 'failed', 'outcome-unknown', 'succeeded'] as const) {
    const html = renderToStaticMarkup(createElement(LineageOperationStatus, { operation: { ...test.operation, state, result: null }, canOpen: false, onOpen() {} }))
    expect(html).not.toContain('打开已核验的子会话'); expect(html).not.toContain('完整原生证明与产品目标绑定已完成')
    if (state === 'handoff') expect(html).toContain('产品交接尚未完成')
    if (state === 'succeeded') expect(html).toContain('缺少完整交接证明')
  }
})
it('shows completed metadata with an explicit, identity-gated opening and actual stop while pending', async () => {
  const test = await lineageFixture('fork')
  const completed = renderToStaticMarkup(createElement(LineageOperationStatus, { operation: test.operation, canOpen: false, onOpen() {} }))
  expect(completed).toContain('打开已核验的子会话'); expect(completed).toContain('disabled=""'); expect(completed).toContain('不会用旧回执把你强行切回')
  const pending = renderToStaticMarkup(createElement(LineageOperationStatus, { operation: { ...test.operation, state: 'applying', result: null }, canOpen: false, onOpen() {}, canStop: true, onStop() {} }))
  expect(pending).toContain('停止当前原生分支执行'); expect(pending).not.toContain('打开已核验的子会话')
})
