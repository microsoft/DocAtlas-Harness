import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LiveState } from '../src/live/client'
import { NativeCompactionForm, NativeSettingsForm, NativeSettingsSummary } from '../src/live/NativeControls'
import { captureNativeHistoryAnchor, nativeCompactAction, nativeControlIdentity, nativeControlPrefix, nativeDraftAction, nativeIdentityKey, nativeModelKey, nativeSettingsChanged, nativeSettingsDraft, nativeSettingsReady, restoreNativeHistoryAnchor, type NativeControlIdentity, type NativeSettingsView } from '../src/live/native-control-state'

function view(): NativeSettingsView {
  return { models: [{ provider: 'approved-provider', id: 'shared-model', name: 'Approved model', thinkingLevels: ['off', 'low', 'high'] },
    { provider: 'other-approved-provider', id: 'shared-model', name: 'Another approved model', thinkingLevels: ['off', 'medium'] }],
    model: { provider: 'approved-provider', id: 'shared-model' }, thinkingLevel: 'high', thinkingLevels: ['off', 'low', 'high'], steeringMode: 'one-at-a-time', followUpMode: 'all', busy: false, queued: 0 }
}
describe('host-approved native settings display and draft isolation', () => {
  it('separates provider/model pairs and does not choose an unapproved endpoint or model', () => {
    const current = view(), draft = nativeSettingsDraft(current)
    expect(nativeModelKey(current.models[0]!)).not.toBe(nativeModelKey(current.models[1]!))
    expect(nativeSettingsReady(current, draft)).toBe(true)
    expect(nativeSettingsChanged(current, draft)).toBe(false)
    expect(nativeSettingsReady(current, { ...draft, modelKey: 'https://unapproved.invalid/model' })).toBe(false)
    expect(nativeSettingsReady({ ...current, models: [] }, draft)).toBe(false)
    expect(nativeSettingsReady({ ...current, models: [...current.models, current.models[0]!] }, draft)).toBe(false)
  })
  it('retains an unsupported old thinking level for explicit correction, rather than silently downgrading it', () => {
    const current = view(), changed = { ...nativeSettingsDraft(current), modelKey: nativeModelKey(current.models[1]!) }
    expect(changed.thinkingLevel).toBe('high'); expect(nativeSettingsReady(current, changed)).toBe(false)
    expect(nativeSettingsReady(current, { ...changed, thinkingLevel: 'medium' })).toBe(true)
    expect(nativeDraftAction(current, changed, 'model')).toEqual({ kind: 'set-model', provider: 'other-approved-provider', modelId: 'shared-model' })
    expect(nativeDraftAction(current, changed, 'thinking')).toBeNull()
    const html = renderToStaticMarkup(createElement(NativeSettingsForm, { value: { ...current, thinkingLevels: ['off', 'medium'] }, draft: changed, disabled: false, onChange() {}, onSave() {} }))
    expect(html).toContain('原档位 高 不适用于当前原生模型，请明确选择')
    expect(html).not.toContain('value="max"'); expect(html).not.toContain('value="xhigh"')
    expect(html).toContain('<button type="button" class="secondary-button" disabled="">单独保存思考档位</button>')
  })
  it('displays the actual native model/thinking separately from unsaved choices', () => {
    const current = view(), draft = nativeSettingsDraft(current), before = structuredClone(current)
    draft.modelKey = nativeModelKey(current.models[1]!); draft.thinkingLevel = 'medium'
    const summary = renderToStaticMarkup(createElement(NativeSettingsSummary, { value: current }))
    expect(summary).toContain('Approved model'); expect(summary).not.toContain('Another approved model')
    expect(summary).toContain('<dt>思考档位</dt><dd>高</dd>'); expect(current).toEqual(before)
  })
  it('keeps streaming and queued work distinct, including an idle native execution with queued work', () => {
    const current = view()
    const idleQueued = renderToStaticMarkup(createElement(NativeSettingsSummary, { value: { ...current, busy: false, queued: 2 } }))
    expect(idleQueued).toContain('原生执行当前空闲'); expect(idleQueued).toContain('另有 2 项待处理')
    const busyQueued = renderToStaticMarkup(createElement(NativeSettingsSummary, { value: { ...current, busy: true, queued: 1 } }))
    expect(busyQueued).toContain('原生任务执行中'); expect(busyQueued).toContain('另有 1 项待处理')
  })
  it('does not invent defaults for missing current models/levels or empty approved catalogs', () => {
    const current = { ...view(), models: [], model: null, thinkingLevel: null }, draft = nativeSettingsDraft(current)
    expect(draft.modelKey).toBe(''); expect(draft.thinkingLevel).toBe(''); expect(nativeSettingsReady(current, draft)).toBe(false)
    const html = renderToStaticMarkup(createElement(NativeSettingsForm, { value: current, draft, disabled: false, onChange() {}, onSave() {} }))
    expect(html).toContain('服务端没有返回可选模型'); expect(html).toContain('请选择获准模型')
    expect(html).not.toContain('type="password"'); expect(html).not.toContain('<textarea'); expect(html).not.toContain('type="text"')
    expect(html).not.toContain('compact'); expect(html).not.toContain('fork')
  })
  it('offers native queue modes independently without modifying a prompt or source selection', () => {
    const current = view(), draft = nativeSettingsDraft(current), before = structuredClone(current)
    expect(nativeSettingsChanged(current, { ...draft, steeringMode: 'all' })).toBe(true)
    expect(nativeSettingsChanged(current, { ...draft, followUpMode: 'one-at-a-time' })).toBe(true)
    expect(nativeSettingsReady(current, { ...draft, followUpMode: 'one-at-a-time' })).toBe(true)
    const html = renderToStaticMarkup(createElement(NativeSettingsForm, { value: current, draft, disabled: true, onChange() {}, onSave() {} }))
    expect(html).toContain('插入消息队列模式'); expect(html).toContain('跟进消息队列模式'); expect(html).toContain('保存配置不是一次问答')
    expect(html.match(/<select[^>]*disabled=""/gu)).toHaveLength(4); expect(current).toEqual(before)
  })
  it('offers the actual SDK max thinking level when advertised, without filtering it down to xhigh', () => {
    const current = { ...view(), thinkingLevels: ['off', 'high', 'xhigh', 'max'] }, draft = { ...nativeSettingsDraft(current), thinkingLevel: 'max' }
    expect(nativeDraftAction(current, draft, 'thinking')).toEqual({ kind: 'set-thinking', level: 'max' })
    const html = renderToStaticMarkup(createElement(NativeSettingsForm, { value: current, draft, disabled: false, onChange() {}, onSave() {} }))
    expect(html).toContain('value="max" selected="">最高</option>')
  })
  it('binds actor/workspace/conversation/generation/binding/native-session identity before retaining any original operation', () => {
    const identity: NativeControlIdentity = { actorId: 'actor:one', workspaceId: 'workspace:one', conversationId: 'conversation:one', bindingId: 'binding:one', generation: 1, nativeSessionId: 'native:one' }
    const state = { phase: 'ready', actor: { actorId: identity.actorId, workspaceId: identity.workspaceId }, selected: identity.conversationId,
      snapshot: { binding: { ownerActorId: identity.actorId, workspaceId: identity.workspaceId, conversationId: identity.conversationId, bindingId: identity.bindingId, generation: 1, runtimeSessionId: identity.nativeSessionId } } } as LiveState
    expect(nativeControlIdentity(state)).toEqual(identity)
    expect(nativeControlIdentity({ ...state, phase: 'pairing' })).toBeNull(); expect(nativeControlIdentity({ ...state, selected: 'conversation:other' })).toBeNull()
    for (const key of ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'nativeSessionId'] as const) expect(nativeIdentityKey({ ...identity, [key]: 'different:id' })).not.toBe(nativeIdentityKey(identity))
    expect(nativeIdentityKey({ ...identity, generation: 2 })).not.toBe(nativeIdentityKey(identity))
    expect(nativeControlPrefix({ ...identity, generation: 2 })).toBe(nativeControlPrefix(identity))
  })
})

describe('manual compaction is explicit and separate from chat and saved preferences', () => {
  it('requires actual SDK eligibility and preserves exact optional instructions', () => {
    expect(nativeCompactAction('', true)).toEqual({ kind: 'compact', instructions: '' })
    expect(nativeCompactAction('  保留待核验项\n\n🔬  ', true)).toEqual({ kind: 'compact', instructions: '  保留待核验项\n\n🔬  ' })
    expect(nativeCompactAction('instructions', false)).toBeNull()
    expect(nativeCompactAction('instructions', undefined)).toBeNull()
    expect(nativeCompactAction('🔬'.repeat(4096), true)).not.toBeNull()
    expect(nativeCompactAction('🔬'.repeat(4097), true)).toBeNull()
  })
  it('keeps old workers and busy/empty contexts disabled without inventing capability', () => {
    for (const canCompact of [false, undefined]) {
      const html = renderToStaticMarkup(createElement(NativeCompactionForm, { canCompact, disabled: false, instructions: '', onChange() {}, onCompact() {} }))
      expect(html).toContain('disabled="">压缩当前上下文</button>')
      expect(html).toContain(canCompact === false ? '没有可进一步压缩的对话内容' : '服务端未确认支持手动压缩')
    }
    const html = renderToStaticMarkup(createElement(NativeCompactionForm, { canCompact: true, disabled: true, instructions: '', onChange() {}, onCompact() {} }))
    expect(html).toContain('disabled="">压缩当前上下文</button>')
  })
  it('explains lossy model context, retained original citations and possible model cost without fake savings', () => {
    const html = renderToStaticMarkup(createElement(NativeCompactionForm, { canCompact: true, disabled: false, instructions: '保留 <script>只是数据</script>', onChange() {}, onCompact() {} }))
    expect(html).toContain('完整聊天历史、笔记和原始 PDF 引用保留')
    expect(html).toContain('可能产生费用'); expect(html).toContain('摘要可能省略细节')
    expect(html).toContain('不是新的事实证据、个人偏好记忆，也不是删除历史')
    expect(html).toContain('&lt;script&gt;只是数据&lt;/script&gt;'); expect(html).not.toContain('<script>')
    expect(html).not.toContain('disabled="">压缩当前上下文</button>')
    expect(html).not.toContain('节省 50%')
  })
})

describe('native-history message scroll anchors', () => {
  function container() {
    const rects = new Map([['message:visible', { top: 90, bottom: 150 }], ['message:next', { top: 170, bottom: 240 }]])
    const nodes = [...rects.keys()].map(id => ({ dataset: { messageEntry: id }, getBoundingClientRect: () => rects.get(id)! }))
    const metrics = { scrollTop: 200, scrollHeight: 1000, getBoundingClientRect: () => ({ top: 100, bottom: 600 }), querySelectorAll: () => nodes }
    return { element: metrics as unknown as HTMLElement, metrics, rects, nodes }
  }
  it('restores the same partially visible message after prepending older native messages', () => {
    const test = container(), anchor = captureNativeHistoryAnchor(test.element, 'native:owner/head', 0)
    expect(anchor).toMatchObject({ entryId: 'message:visible', offset: -10, scrollTop: 200 })
    test.rects.set('message:visible', { top: 390, bottom: 450 }); test.metrics.scrollHeight = 1300
    expect(restoreNativeHistoryAnchor(test.element, anchor, 'native:owner/head', 0)).toBe(true)
    expect(test.element.scrollTop).toBe(500)
  })
  it('does not double-compensate browser overflow anchoring', () => {
    const test = container(), anchor = captureNativeHistoryAnchor(test.element, 'native:owner/head', 0)
    test.element.scrollTop = 500; test.metrics.scrollHeight = 1300
    expect(restoreNativeHistoryAnchor(test.element, anchor, 'native:owner/head', 0)).toBe(true)
    expect(test.element.scrollTop).toBe(500)
  })
  it('abandons a stale anchor after owner/head change or a new user scroll intent', () => {
    const test = container(), anchor = captureNativeHistoryAnchor(test.element, 'native:owner/head', 0)
    expect(restoreNativeHistoryAnchor(test.element, anchor, 'native:other/head', 0)).toBe(false)
    expect(restoreNativeHistoryAnchor(test.element, anchor, 'native:owner/head', 1)).toBe(false)
    expect(test.element.scrollTop).toBe(200)
    test.nodes.splice(0, 1)
    expect(restoreNativeHistoryAnchor(test.element, anchor, 'native:owner/head', 0)).toBe(false)
  })
})
