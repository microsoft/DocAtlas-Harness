import { UiText } from './locale'
import { useEffect, useRef, useState } from 'react'
import type { MemoryVersion, PersonalizationExportDescriptor, ProductPreferenceInspectionV2 } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { Drawer } from '../Drawer'
import type { LiveClient, LiveState } from './client'
import { acknowledgePreference, canRetryPreferenceAtEpoch, preferenceAxes, preferenceExportUrl, preferenceIdentity, preferenceKey, preferenceLabel,
  readPreferenceOutbox, recordedPreferenceUses, savePendingPreference, type PendingPreference, type PreferenceOutbox } from './preference-state'
import './preferences.css'

type LiveMemory = Exclude<MemoryVersion, { status: 'deleted' }>
export function LivePreferences({ client, state, onLearning }: { client: LiveClient, state: LiveState, onLearning?(): void }) {
  const identity = preferenceIdentity(state), key = identity ? preferenceKey(identity) : ''
  const [open, setOpen] = useState(false), [inspection, setInspection] = useState<ProductPreferenceInspectionV2 | null>(null)
  const [outbox, setOutbox] = useState<PreferenceOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false)
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [notice, setNotice] = useState('')
  const [axis, setAxis] = useState<string>('answer-order'), [choice, setChoice] = useState<string>('conclusion-first'), [scope, setScope] = useState<'global' | 'workspace'>('workspace')
  const [editing, setEditing] = useState<LiveMemory | null>(null), [useExisting, setUseExisting] = useState(false), [contribute, setContribute] = useState(false)
  const [format, setFormat] = useState<'json' | 'markdown'>('json'), [exported, setExported] = useState<PersonalizationExportDescriptor | null>(null)
  const visible = useRef(key), loadSequence = useRef(0)
  visible.current = key
  useEffect(() => () => { visible.current = ''; loadSequence.current++ }, [])
  const current = (expected: string) => {
    const active = preferenceIdentity(client.state())
    return !!expected && visible.current === expected && active !== null && preferenceKey(active) === expected
  }
  function restore() {
    if (!identity) return
    try { setOutbox(readPreferenceOutbox(sessionStorage, identity)); setStorageBlocked(false) }
    catch { setStorageBlocked(true); setNotice('此标签页的偏好草稿无法读取；未发送任何设置。') }
  }
  async function load(expected = key): Promise<boolean> {
    if (!identity || !current(expected)) return false
    const sequence = ++loadSequence.current
    setLoading(true)
    try {
      const value = await client.preferenceRequest(identity.conversationId)
      if (!current(expected) || sequence !== loadSequence.current) return false
      if (value.schemaVersion !== 2 || value.kind !== 'preference-inspection' || value.conversationId !== identity.conversationId) throw new Error('Preference inspection mismatch')
      setInspection(value); setUseExisting(value.result.sessionPolicy?.useExisting ?? false); setContribute(value.result.sessionPolicy?.contributeToFuture ?? false)
      return true
    } catch { if (current(expected)) setNotice('暂时无法读取偏好。已保存的设置和未确认请求都保留。'); return false }
    finally { if (current(expected) && sequence === loadSequence.current) setLoading(false) }
  }
  useEffect(() => {
    loadSequence.current++; setInspection(null); setEditing(null); setExported(null); setNotice(''); setBusy(false); setLoading(false)
    setOutbox({ state: 'empty' }); restore()
  }, [key])
  useEffect(() => { if (open && identity) void load(key) }, [open, key])
  async function commit(pending: PendingPreference) {
    const expected = preferenceKey(pending.identity)
    if (!identity || !current(expected) || !inspection || pending.profileId !== inspection.result.profileId || !canRetryPreferenceAtEpoch(pending, inspection.profileEpoch)) return
    setBusy(true); setNotice('正在核对偏好保存回执…')
    try {
      const value = await client.preferenceRequest(identity.conversationId, pending.request)
      if (!current(expected)) return
      if (value.kind !== 'preference-result' || !acknowledgePreference(sessionStorage, pending, value)) throw new Error('Preference receipt mismatch')
      setOutbox({ state: 'empty' }); setEditing(null)
      if (value.result.action === 'export') setExported(value.result.export)
      if (value.result.action === 'forget') setExported(null)
      const refreshed = await load(expected)
      if (current(expected)) setNotice(refreshed ? '设置保存已确认。是否用于回答生成，请查看下方记录。' : '设置保存已确认，但列表刷新失败；可以重新读取。')
    } catch { if (current(expected)) { restore(); await load(expected); if (current(expected)) setNotice('操作结果尚未确认；原请求和原键已保留。请手动核对，不会自动重发。') } }
    finally { if (current(expected)) setBusy(false) }
  }
  async function send(fields: Record<string, unknown>) {
    if (!identity || !inspection || busy || loading || storageBlocked || outbox.state !== 'empty' || !current(key)) return
    try {
      const request = parseBrowserContract('product-personalization-v2', { schemaVersion: 2, kind: 'preference-command', expectedGeneration: identity.generation,
        expectedProfileEpoch: inspection.profileEpoch,
        command: { ...fields, idempotencyKey: `preference:${crypto.randomUUID()}` } })
      if (request.kind !== 'preference-command') throw new Error('Invalid preference command')
      const pending: PendingPreference = { schemaVersion: 1, identity, profileId: inspection.result.profileId, request }
      savePendingPreference(sessionStorage, pending)
      setOutbox({ state: 'pending', key, value: pending, current: true })
      await commit(pending)
    } catch { if (current(key)) { restore(); setNotice('无法校验或保存本地请求；本次设置未发送。请检查标签页存储。') } }
  }
  function discard() {
    if (outbox.state === 'empty' || busy || !identity || !current(key)) return
    if (!window.confirm('只清除此标签页的未确认请求，不会撤销服务器可能已保存的设置。请重新读取设置核对。继续？')) return
    try { sessionStorage.removeItem(outbox.key); restore(); setNotice('已清除这条本地请求，没有撤销服务端设置。'); void load() }
    catch { setNotice('无法清除本地请求，原记录仍保留。') }
  }
  const disabled = busy || loading || !inspection || storageBlocked || outbox.state !== 'empty'
  const axisDefinition = preferenceAxes.find(value => value.key === axis) ?? preferenceAxes[0]
  function edit(memory: LiveMemory) {
    if (!preferenceAxes.some(value => value.key === memory.effect.key && value.values.some(item => item[0] === memory.effect.value)) || !['global', 'workspace'].includes(memory.scope.kind)) return
    setEditing(memory); setAxis(memory.effect.key); setChoice(memory.effect.value); setScope(memory.scope.kind as 'global' | 'workspace')
  }
  return <><button className="header-action" disabled={!identity} onClick={() => setOpen(true)}><UiText en="Preferences" zh="偏好" /></button>
    {open && identity && <Drawer title="偏好设置" subtitle="只保存你明确选择的理解方式。事实、证据和原始 PDF 引用不会被偏好改写。" onClose={() => setOpen(false)}>
      <div className="live-preferences">
        <PreferenceConnectionBoundary inspection={inspection} />
        <p className="preference-scope-note">当前个人工作区内使用，不跨其他工作区共享画像。</p>
        {onLearning && <button className="text-action" onClick={() => { setOpen(false); onLearning() }}>管理偏好学习与可选比较提示</button>}
        <button className="text-action" disabled={busy || loading} onClick={() => { restore(); void load() }}>{loading ? '读取中…' : '重新读取偏好'}</button>
        {notice && <p className="live-notice" role="status">{notice}</p>}
        {outbox.state !== 'empty' && <section className="preference-pending" aria-label="未确认的偏好请求"><h3>有一条操作尚未核对</h3><p>刷新不会重新发送；只有匹配的保存回执才能清除原键。</p>
          {outbox.state === 'pending' && !outbox.current && <p>这是旧会话版本的请求，不能换成当前版本重试。</p>}
          {outbox.state === 'pending' && inspection && !canRetryPreferenceAtEpoch(outbox.value, inspection.profileEpoch) && <p>画像已清除过；这条旧请求不能恢复旧设置。请清除此草稿后重新选择。</p>}
          {outbox.state === 'invalid' && <p>旧请求无法完整校验，未修复或发送。</p>}
          <div className="preference-actions"><button className="secondary-button" disabled={busy || loading || outbox.state !== 'pending' || !outbox.current || !inspection || outbox.value.profileId !== inspection.result.profileId || !canRetryPreferenceAtEpoch(outbox.value, inspection.profileEpoch)}
            onClick={() => { if (outbox.state === 'pending') void commit(outbox.value) }}>使用原键重试偏好操作</button><button className="text-action" disabled={busy} onClick={discard}>清除这条本地请求</button></div>
        </section>}
        <section className="preference-section" aria-labelledby="preference-switches"><h3 id="preference-switches">当前对话的两个独立开关</h3>
          <label className="preference-switch"><input type="checkbox" disabled={disabled} checked={useExisting} onChange={event => setUseExisting(event.target.checked)} /><span>允许使用已有偏好<small>仅允许在回答生成时使用符合条件的偏好，不改变事实与证据。</small></span></label>
          <label className="preference-switch"><input type="checkbox" disabled={disabled} checked={contribute} onChange={event => setContribute(event.target.checked)} /><span>允许为未来偏好积累信号<small>只积累你明确提交的选择；提示另行许可，候选仍需人工确认。关闭不妨碍手动设置。</small></span></label>
          <button className="secondary-button" disabled={disabled} onClick={() => void send({ action: 'set-session-policy', expectedVersion: inspection?.result.sessionPolicy?.version ?? 0, policy: { useExisting, contributeToFuture: contribute } })}>保存会话开关</button>
        </section>
        <section className="preference-section" aria-labelledby="preference-editor"><h3 id="preference-editor">{editing ? '修改这条偏好' : '添加明确偏好'}</h3>
          <div className="preference-fields"><label>偏好项目<select tabIndex={0} aria-label="偏好项目" value={axis} disabled={disabled} onChange={event => { const selected = preferenceAxes.find(item => item.key === event.target.value)!; setAxis(selected.key); setChoice(selected.values[0][0]) }}>{preferenceAxes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
            <label>我的选择<select tabIndex={0} aria-label="我的偏好选择" value={choice} disabled={disabled} onChange={event => setChoice(event.target.value)}>{axisDefinition.values.map(item => <option key={item[0]} value={item[0]}>{item[1]}</option>)}</select></label>
            <label>作用范围<select tabIndex={0} aria-label="偏好作用范围" value={scope} disabled={disabled} onChange={event => setScope(event.target.value as 'global' | 'workspace')}><option value="workspace">当前工作区</option><option value="global">此个人工作区的全部任务</option></select></label></div>
          <p className="preference-help">只记录枚举选择，不推断能力、身份或敏感特征。所有引用仍回到原始 PDF。</p>
          <div className="preference-actions"><button className="primary-button" disabled={disabled} onClick={() => void send(editing
            ? { action: 'edit', memoryVersionId: editing.memoryVersionId, expectedVersion: editing.version, replacement: { effect: { key: axis, value: choice }, scope }, statusAfterEdit: editing.status === 'paused' ? 'paused' : 'active' }
            : { action: 'set-preference', preference: { effect: { key: axis, value: choice }, scope } })}>{editing ? '保存修改' : '保存偏好'}</button>
            {editing && <button className="text-action" disabled={busy} onClick={() => setEditing(null)}>取消修改</button>}</div>
        </section>
        {inspection && <>
          <PreferenceMemoryList memories={inspection.result.memories} modelApplication={inspection.modelApplication} disabled={disabled} onEdit={edit} onAction={(memory, action) => {
            if (action === 'forget' && !window.confirm('忘记后不再将这条偏好列为生效偏好，可能中止正在使用它的生成，不会自动重问；这不会删除原生会话、已下载的导出或供应商副本。继续？')) return
            void send(action === 'forget' ? { action, target: 'memory-chain', memoryVersionId: memory.memoryVersionId, expectedVersion: memory.version, mode: 'memory-only', provenanceHandling: 'orphan', acknowledgeExternalRetention: true }
              : { action, memoryVersionId: memory.memoryVersionId, expectedVersion: memory.version })
          }} />
          <PreferenceUseHistory inspection={inspection} />
          {(inspection.result.truncated.memories || inspection.result.truncated.decisions || inspection.result.truncated.uses) && <p className="preference-help">当前列表为有界预览；部分历史未展示，可导出完整个人偏好记录。</p>}
        </>}
        <section className="preference-section"><h3>导出与忘记</h3><div className="preference-actions"><label>导出格式<select tabIndex={0} aria-label="偏好导出格式" value={format} disabled={disabled} onChange={event => setFormat(event.target.value as 'json' | 'markdown')}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <button className="secondary-button" disabled={disabled} onClick={() => void send({ action: 'export', format, includeProvenanceRefs: false, includeStatuses: ['active', 'paused', 'disputed', 'superseded', 'expired', 'archived'] })}>生成偏好导出</button></div>
          {exported && <a className="preference-download" href={preferenceExportUrl(identity.conversationId, exported.assetId)} download={`docatlas-preferences.${exported.format === 'json' ? 'json' : 'md'}`}>下载偏好记录 · {exported.byteLength} 字节（链接短时有效）</a>}
          <p className="preference-help">导出只包含个人偏好记录，不导出原始文档正文。Markdown 是导出格式，不是引用跳转目标。</p>
          <button className="preference-danger" disabled={disabled} onClick={() => {
            if (!window.confirm('确认清除当前个人工作区画像及其个性化记录、受管备份和导出？可能中止正在使用偏好的生成，不会自动重问。研究笔记、原始文档和原生会话不会被删除；已下载文件和供应商副本不能被撤回。')) return
            void send({ action: 'forget', target: 'profile', expectedProfileRevision: inspection!.result.profileRevision, mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true })
          }}>清除当前个人工作区画像</button>
        </section>
      </div>
    </Drawer>}
  </>
}

export function PreferenceConnectionBoundary({ inspection }: { inspection: ProductPreferenceInspectionV2 | null }) {
  return <p className="preference-boundary" role="note">{!inspection ? '正在核对模型应用连接状态。' : inspection.modelApplication === 'host-ephemeral'
    ? '偏好已连接回答生成：仅在服务端临时加入呈现指导，不写入原生会话。' : '偏好控制已接入，模型应用尚未连接。'} 保存设置不代表回答已经采用；生成阶段采用也不等于模型遵从、事实正确或页面已展示。回答布局偏好不会自动重排阅读器。自动学习与风格对比实验尚未开启。关闭、修改、暂停或忘记偏好可能中止正在使用它的生成，不会自动重问。</p>
}
export function PreferenceMemoryList({ memories, modelApplication, disabled, onEdit, onAction }: { memories: MemoryVersion[], modelApplication: ProductPreferenceInspectionV2['modelApplication'], disabled: boolean, onEdit(memory: LiveMemory): void, onAction(memory: LiveMemory, action: 'pause' | 'resume' | 'forget'): void }) {
  return <section className="preference-section" aria-label="已保存的偏好"><h3>已保存的偏好</h3>{!memories.length && <p className="preference-help">还没有保存偏好。这里不会自动生成你的画像。</p>}
    <div className="preference-memory-list">{memories.map(memory => memory.status === 'deleted' ? <p className="preference-help" key={memory.memoryVersionId}>一条偏好已忘记 · 版本 {memory.version}</p>
      : <article key={memory.memoryVersionId} data-preference-id={memory.memoryVersionId}><strong>{preferenceLabel(memory.effect)}</strong><small>版本 {memory.version} · {memory.status === 'active' ? modelApplication === 'host-ephemeral' ? '已启用 · 授权后可用于生成' : '已启用的设置（尚未接模型）' : memory.status === 'paused' ? '已暂停' : memory.status} · {memory.scope.kind === 'global' ? '此个人工作区全部任务' : memory.scope.kind === 'workspace' ? '当前工作区' : '既有特殊作用域'}</small>
        <div className="preference-actions"><button className="text-action" disabled={disabled || !['active', 'paused', 'disputed'].includes(memory.status) || !['global', 'workspace'].includes(memory.scope.kind) || !preferenceAxes.some(axis => axis.key === memory.effect.key && axis.values.some(item => item[0] === memory.effect.value))} onClick={() => onEdit(memory)}>修改</button>
          {(memory.status === 'active' || memory.status === 'disputed') && <button className="text-action" disabled={disabled} onClick={() => onAction(memory, 'pause')}>暂停</button>}
          {memory.status === 'paused' && <button className="text-action" disabled={disabled} onClick={() => onAction(memory, 'resume')}>恢复</button>}
          <button className="text-action" disabled={disabled} onClick={() => onAction(memory, 'forget')}>忘记这条偏好</button></div>
      </article>)}</div>
  </section>
}
export function PreferenceUseHistory({ inspection }: { inspection: ProductPreferenceInspectionV2 }) {
  const uses = recordedPreferenceUses(inspection.result)
  return <section className="preference-section" aria-label="偏好生成阶段使用记录"><h3>为什么在生成时使用这些偏好</h3><p className="preference-help">记录表示服务端观察到已开始生成回答，不证明模型遵从、事实正确或页面已展示。</p>{!uses.length ? <p className="preference-help">当前没有可配对的生成阶段使用记录。已保存偏好或计划中的决定不等于已经应用。</p>
    : <ul className="preference-use-list">{uses.map(({ use, decision }) => <li key={use.memoryUseId}><strong>{preferenceLabel(use.effect)}</strong><span>提交序号 {use.turn} · {use.usedAt}</span><small>{decision.why.find(item => item.memoryVersionId === use.memoryVersionId)?.reason ?? '已有生成阶段记录'} · 仅回溯记录，不改变证据支持关系。</small></li>)}</ul>}</section>
}
