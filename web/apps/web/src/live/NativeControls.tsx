import { UiText } from './locale'
import { useEffect, useRef, useState } from 'react'
import type { NativeControlAction, ProductNativeCommand, ProductNativeInspection, ProductNativeOperation } from '@docatlas/contracts'
import { Drawer } from '../Drawer'
import type { LiveState } from './client'
import { LiveLineageControls, type LineageClient } from './LineageControls'
import { acknowledgeNativeOperation, bindNativeOperation, nextNativeInspection, nativeCompactAction, nativeControlIdentity, nativeDraftAction, nativeIdentityKey, nativeModelKey, nativeOperationHasTerminalProof, nativeOperationMatches,
  nativeSettingsDraft, nativeSettingsView, readNativeControlOutbox, saveNativeControlPending, type NativeControlOutbox, type NativeControlPending, type NativeQueueMode, type NativeSettingsDraft, type NativeSettingsView } from './native-control-state'
import './native-controls.css'

const thinkingNames: Record<string, string> = { off: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
const queueNames: Record<NativeQueueMode, string> = { all: '一起处理', 'one-at-a-time': '逐条处理' }
const operationNames = { accepted: '已接受，尚未应用', applying: '正在应用', succeeded: '已核验原生持久回执', failed: '未完成', 'outcome-unknown': '结果未知，保留原键' }
interface NativeClient extends LineageClient {
  state(): LiveState
  nativeInspect(conversationId: string): Promise<ProductNativeInspection>
  nativeCommand(conversationId: string, command: ProductNativeCommand): Promise<ProductNativeOperation>
  nativeOperation(conversationId: string, operationId: string): Promise<ProductNativeOperation>
  stop(): Promise<void>
}
const actionName = (action: NativeControlAction) => action.kind === 'set-model' ? `模型 · ${action.provider} / ${action.modelId}`
  : action.kind === 'set-thinking' ? `思考档位 · ${thinkingNames[action.level] ?? action.level}` : action.kind === 'compact' ? '压缩当前模型上下文' : `${action.queue === 'steering' ? '插入' : '跟进'}队列 · ${queueNames[action.mode]}`

export function LiveNativeControls({ client, state }: { client: NativeClient, state: LiveState }) {
  const identity = nativeControlIdentity(state), stamp = identity ? nativeIdentityKey(identity) : '', activeStamp = useRef(stamp); activeStamp.current = stamp
  const [open, setOpen] = useState(false), [contextStamp, setContextStamp] = useState(''), [inspection, setInspection] = useState<ProductNativeInspection | null>(null), [verified, setVerified] = useState(false)
  const [draft, setDraft] = useState<NativeSettingsDraft | null>(null), [outbox, setOutbox] = useState<NativeControlOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false)
  const [compactionInstructions, setCompactionInstructions] = useState('')
  const [lineageOpen, setLineageOpen] = useState(false)
  const lineageOwner = state.actor && state.selected ? JSON.stringify([state.actor.actorId, state.actor.workspaceId, state.selected]) : ''
  useEffect(() => { setLineageOpen(false) }, [lineageOwner])
  const [loading, setLoading] = useState(false), [writing, setWriting] = useState(false), [notice, setNotice] = useState(''), [operation, setOperation] = useState<ProductNativeOperation | null>(null)
  const epoch = useRef(0), sequence = useRef(0), busy = useRef(false), operationRef = useRef(operation); operationRef.current = operation
  const current = (token: number) => { const active = nativeControlIdentity(client.state()); return !!stamp && token === epoch.current && activeStamp.current === stamp && active !== null && nativeIdentityKey(active) === stamp }
  function restore(): NativeControlOutbox {
    if (!identity) return { state: 'empty' }
    try { const value = readNativeControlOutbox(sessionStorage, identity); setOutbox(value); setStorageBlocked(false); return value }
    catch { setStorageBlocked(true); setNotice('无法读取本标签页的原生配置待办；未发送更改。'); return { state: 'empty' } }
  }
  useEffect(() => {
    epoch.current++; sequence.current++; busy.current = false; setContextStamp(stamp); setOpen(false); setInspection(null); setVerified(false); setDraft(null)
    setOutbox({ state: 'empty' }); setStorageBlocked(false); setLoading(false); setWriting(false); setNotice(''); setOperation(null); setCompactionInstructions(''); operationRef.current = null; restore()
    return () => { epoch.current++; sequence.current++ }
  }, [stamp])
  async function accept(pending: NativeControlPending, value: ProductNativeOperation, isCurrent: () => boolean): Promise<boolean> {
    if (!await nativeOperationMatches(pending, value) || !isCurrent()) return false
    const previous = operationRef.current
    if (previous?.operationId === value.operationId && value.version < previous.version) return false
    let retained = pending
    if (pending.operationId === null) {
      const bound = await bindNativeOperation(sessionStorage, pending, value, isCurrent)
      if (!bound) return false
      retained = bound
    }
    if (!isCurrent()) return false
    operationRef.current = value; setOperation(value); restore()
    if (nativeOperationHasTerminalProof(value)) {
      if (!await acknowledgeNativeOperation(sessionStorage, retained, value, isCurrent)) return false
      if (!isCurrent()) return false
      restore(); setNotice(value.failureProof ? '已核验本次没有写入压缩记录。不会自动重试；原生停止确认后可继续提问。'
        : '已核对这次操作的原生持久回执。不会新增聊天回答，也未改动问题草稿或资料选择。')
    } else setNotice(value.state === 'failed' || value.state === 'outcome-unknown' ? '尚无成功的原生持久证明。保留原请求；刷新仅查询，不能把失败或未知当作已经生效。' : '原操作已接受或正在应用；尚不是成功回执。这里仅查询同一操作，不会重新发送问题。')
    return true
  }
  async function load(resetDraft = false) {
    if (!identity) return
    const token = epoch.current, serial = ++sequence.current; setLoading(true); setVerified(false)
    const isCurrent = () => current(token) && serial === sequence.current
    try {
      let value = await nextNativeInspection(identity, () => client.nativeInspect(identity.conversationId), isCurrent)
      if (!value) return
      const pending = restore()
      if (pending.state === 'pending' && pending.current) {
        const candidate = pending.value.operationId ? await client.nativeOperation(identity.conversationId, pending.value.operationId)
          : value.operations.find(item => item.request.idempotencyKey === pending.value.request.idempotencyKey)
        if (candidate && isCurrent()) {
          const matched = await accept(pending.value, candidate, isCurrent)
          if (!isCurrent()) return
          if (!matched) setNotice('原操作状态未能匹配完整请求/原生前缀，待办保留。没有换键、换会话或重复应用。')
          else if (nativeOperationHasTerminalProof(candidate)) {
            // The first inspection may precede this receipt, even if it looked idle.
            // Read once AFTER success; do not leave the form stuck on that old busy/head.
            value = await nextNativeInspection(identity, () => client.nativeInspect(identity.conversationId), isCurrent)
            if (!value) return
          }
        }
      }
      if (!isCurrent()) return
      setInspection(value); setVerified(true)
      const next = nativeSettingsView(value)
      setDraft(previous => resetDraft || !previous ? next ? nativeSettingsDraft(next) : null : previous)
    } catch { if (isCurrent()) { setVerified(false); setNotice('当前原生状态暂不能独立核对。未确认待办保留，不根据历史回执或本地选择猜测当前设置。') } }
    finally { if (isCurrent()) setLoading(false) }
  }
  async function queryOperation() {
    if (!identity || outbox.state !== 'pending' || !outbox.current || !outbox.value.operationId || busy.current || loading) return
    const token = epoch.current, serial = ++sequence.current, pending = outbox.value, isCurrent = () => current(token) && serial === sequence.current
    setLoading(true)
    try {
      const value = await client.nativeOperation(identity.conversationId, pending.operationId!)
      if (isCurrent() && await accept(pending, value, isCurrent) && nativeOperationHasTerminalProof(value) && isCurrent()) await load()
    } catch { if (isCurrent()) setNotice('尚不能读取这次原操作状态；完整原键和请求仍保留。') }
    finally { if (isCurrent()) setLoading(false) }
  }
  useEffect(() => {
    if (!open || loading || writing || outbox.state !== 'pending' || !outbox.current || !outbox.value.operationId || !operation || !['accepted', 'applying'].includes(operation.state)) return
    const timer = setTimeout(() => { void queryOperation() }, 900)
    return () => clearTimeout(timer)
  }, [open, loading, writing, outbox, operation?.state, stamp])
  const actual = inspection ? nativeSettingsView(inspection) : null
  const idle = !!inspection?.state && !inspection.busy && !inspection.queued && !inspection.state.busy && !inspection.state.nativeQueue.steering && !inspection.state.nativeQueue.followUp
  const blocked = loading || writing || !verified || !idle || storageBlocked || outbox.state !== 'empty'
  async function commit(action?: NativeControlAction) {
    if (!identity || busy.current || loading || storageBlocked || outbox.state === 'invalid') return
    const token = epoch.current; let pending: NativeControlPending
    if (action) {
      if (!inspection?.state || blocked || action.kind === 'compact' && !nativeCompactAction(action.instructions, inspection.state.compaction?.canCompact)) return
      pending = { schemaVersion: 1, identity: { ...identity }, operationId: null, request: { schemaVersion: 1, kind: 'native-command', conversationId: identity.conversationId,
        expectedBindingId: identity.bindingId, expectedGeneration: identity.generation, runtimeSessionId: identity.nativeSessionId, approvalId: inspection.resource.approvalId,
        expectedApprovalVersion: inspection.resource.version, expectedHead: structuredClone(inspection.state.head), idempotencyKey: `native-control:${crypto.randomUUID()}`, action: structuredClone(action) } }
    } else {
      if (outbox.state !== 'pending' || !outbox.current) return
      pending = outbox.value
    }
    busy.current = true; setWriting(true); sequence.current++
    try {
      if (action) { saveNativeControlPending(sessionStorage, pending); restore() }
      const value = await client.nativeCommand(identity.conversationId, pending.request)
      if (!current(token)) return
      if (!await accept(pending, value, () => current(token))) throw new Error('Native receipt differs from frozen command')
      // An explicit original-key retry can start read-only recovery of a previously unknown result.
      // Always inspect once afterward; do not resend it or infer success from this response state.
      if (current(token)) await load()
    } catch { if (current(token)) { restore(); setNotice('配置结果尚未确认；原请求、批准版本和原生前缀全部保留。只能核对原键，不会按最新状态偷偷重建命令。') } }
    finally { if (current(token)) { busy.current = false; setWriting(false) } }
  }
  function discard() {
    if (busy.current || outbox.state === 'empty' || !window.confirm('仅清除这个标签页的原生操作待办，不撤销可能已生效的设置或压缩。请先核对真实状态。继续？')) return
    try { sessionStorage.removeItem(outbox.key); restore(); setNotice('仅清除本地待办。服务端操作记录和原生会话未删除，设置未回滚。') } catch { setNotice('无法清除本地待办。') }
  }
  async function stopNative() {
    if (!identity || state.stopping) return
    const token = epoch.current
    try { await client.stop(); if (current(token)) await load() }
    catch { if (current(token)) setNotice('尚未确认原生执行已停止。保留原操作待办，不把取消请求当作成功或回滚。') }
  }
  return <><button className="header-action" disabled={!identity} onClick={() => { setOpen(true); if (!busy.current) void load() }}><UiText en="Run settings" zh="运行设置" /></button>
    {open && identity && contextStamp === stamp && <Drawer title="原生运行设置" subtitle="模型、队列与上下文管理，使用 Pi 原生能力。" onClose={() => setOpen(false)}><div className="live-native-controls">
      {notice && <p className="native-control-notice" role="status">{notice}</p>}<button className="text-action" disabled={loading || writing} onClick={() => void load()}>{loading ? '读取真实状态…' : '刷新原生状态（只读）'}</button>
      <button className="secondary-button" onClick={() => { setOpen(false); setLineageOpen(true) }}>分支／会话树</button>
      {outbox.state !== 'empty' && <section className="native-control-notice" aria-label="待核对原生配置"><h3>保留了原配置操作</h3>{outbox.state === 'pending' ? <><p>{actionName(outbox.value.request.action)}</p><code>{outbox.value.request.idempotencyKey}</code><details><summary>原批准与原生前缀（完整请求）</summary><pre>{JSON.stringify(outbox.value.request, null, 2)}</pre></details>{!outbox.current && <p>原操作属于另一代际或原生会话，不能转向当前会话重试。</p>}<button className="secondary-button" disabled={loading || writing || !outbox.current} onClick={() => void commit()}>使用原键核对配置操作</button>{outbox.value.operationId && <button className="text-action" disabled={loading || writing || !outbox.current} onClick={() => void queryOperation()}>仅查询原操作</button>}</> : <p>本地待办无法校验，未修复或覆盖，新设置已暂停。</p>}<button className="text-action" disabled={writing} onClick={discard}>仅清除本地配置待办</button></section>}
      {actual ? <><NativeSettingsSummary value={actual} />{!idle && <p className="native-control-notice">原生执行或队列尚未清空，新配置暂不可保存。不会中止任务，也不会将修改伪装成聊天消息。</p>}{draft && <NativeSettingsForm value={actual} draft={draft} disabled={blocked} onChange={setDraft} onSave={action => void commit(action)} />}<button className="text-action" disabled={blocked} onClick={() => setDraft(nativeSettingsDraft(actual))}>表单恢复为当前实际值（不提交）</button></>
        : inspection && <section className="native-settings-section"><h3>原生状态尚不可独立核验</h3><p>{inspection.busy ? '当前有执行中的工作。' : '未返回可核验的原生配置，不假设当前模型或思考档位。'} 调度待处理：{inspection.queued} 项。</p><h4>服务端批准的模型目录</h4>{inspection.models.map(model => <p key={nativeModelKey(model)}>{model.name}<small>{model.provider} / {model.id}</small></p>)}{!inspection.models.length && <p>没有返回获准模型。</p>}</section>}
      {actual && <NativeCompactionForm canCompact={actual.canCompact} disabled={blocked} instructions={compactionInstructions} onChange={setCompactionInstructions} onCompact={action => void commit(action)} />}
      {operation && <NativeOperationStatus operation={operation} stopping={state.stopping} onStop={() => void stopNative()} />}
      {inspection && <details className="native-control-history"><summary>已记录的配置操作</summary>{inspection.operations.map(item => <p key={item.operationId}>{actionName(item.request.action)} · {operationNames[item.state]}<small>{item.operationId} · v{item.version}</small></p>)}{inspection.truncated && <p>这里是有界操作记录，不是完整原生消息历史。</p>}</details>}
      <p className="native-control-muted">关闭不会撤销已提交操作。刷新只读状态；未知结果必须保留原键核对。模型凭据和真实 endpoint 始终留在服务端。</p>
    </div></Drawer>}
    <LiveLineageControls client={client} state={state} open={lineageOpen} onClose={() => setLineageOpen(false)} />
  </>
}

export function NativeOperationStatus({ operation, stopping = false, onStop }: { operation: ProductNativeOperation, stopping?: boolean, onStop?(): void }) {
  return <section className="native-control-notice" aria-label="原生配置操作回执" data-native-operation-state={operation.state}><h3>{operation.failureProof ? '已核验未应用压缩' : operationNames[operation.state]}</h3><p>{actionName(operation.request.action)}</p><code>{operation.operationId}</code>
    {operation.state === 'succeeded' && operation.result ? <><p>{operation.result.compaction ? '已核验 Pi 原生压缩记录。完整历史与原始 PDF 引用未删除；这不是新的助手回答。' : '已核验原生前缀及完成标记；这是配置回执，不是新的助手回答。'}</p>{operation.result.compaction && <><small>原生压缩记录 {operation.result.compaction.entryId}</small><small>Pi 记录的压缩前 token 数：{operation.result.compaction.tokensBefore}；不代表节省量。</small></>}<small>完成标记 {operation.result.markerEntryId}</small><small>原生前缀 {operation.result.afterHead.transcriptHash}</small></>
      : operation.failureProof ? <><p>已核验本次没有写入压缩记录。等待原生停止确认后可继续提问；不会自动重试。</p><p>这不撤销已发生的模型或扩展调用，也不是清除历史。</p><small>终止标记 {operation.failureProof.markerEntryId}</small></> : <p>还没有成功的原生持久证明，不能据此认定配置已生效。</p>}
    {onStop && ['accepted', 'applying'].includes(operation.state) && <><button type="button" className="secondary-button" disabled={stopping} onClick={onStop}>{stopping ? '等待确认原生停止…' : '停止当前原生执行'}</button><p>停止由服务端取消并等待原生工作结束；未知结果仍保留原键，不自动清除或认定回滚。</p></>}
  </section>
}

export function NativeCompactionForm({ canCompact, disabled, instructions, onChange, onCompact }: {
  canCompact: boolean | undefined, disabled: boolean, instructions: string, onChange(value: string): void, onCompact(action: Extract<NativeControlAction, { kind: 'compact' }>): void
}) {
  const action = nativeCompactAction(instructions, canCompact), count = [...instructions].length
  return <section className="native-settings-section native-compaction-section" aria-label="上下文管理"><h3>压缩模型上下文</h3>
    <p>对话较长时，让 Pi 为后续提问整理一份上下文摘要。完整聊天历史、笔记和原始 PDF 引用保留。</p>
    <p className="native-control-muted">会调用当前已配置的模型，可能产生费用。摘要可能省略细节；它不是新的事实证据、个人偏好记忆，也不是删除历史。</p>
    <label>压缩时特别保留（可选）<textarea aria-label="压缩时特别保留（可选）" rows={3} maxLength={8192} value={instructions} disabled={disabled || canCompact !== true}
      placeholder="例如：保留待核验的问题、已经做出的决定和关键文件路径" onChange={event => onChange(event.target.value)} /></label>
    <p className="native-control-muted" role="status">{count} / 4096 字符{count > 4096 ? '，请缩短后再提交。' : ''}</p>
    {canCompact !== true && <p className="native-control-muted">{canCompact === false ? '目前没有可进一步压缩的对话内容。继续对话后再刷新状态。' : '服务端未确认支持手动压缩，暂不开放此操作。'}</p>}
    <button type="button" className="secondary-button" disabled={disabled || !action} onClick={() => { if (action) onCompact(action) }}>压缩当前上下文</button>
  </section>
}

export function NativeSettingsSummary({ value }: { value: NativeSettingsView }) {
  const current = value.model ? value.models.find(model => nativeModelKey(model) === nativeModelKey(value.model!)) : undefined
  return <section className="native-settings-section" aria-label="实际原生运行状态"><h3>最近核验的原生设置</h3>
    <dl className="native-settings-summary"><div><dt>模型</dt><dd>{current?.name ?? (value.model ? `${value.model.provider} / ${value.model.id}` : '尚未读到当前模型')}{value.model && !current && <small>当前模型不在可选目录中，不代表获准重新选用。</small>}</dd></div>
      <div><dt>思考档位</dt><dd>{value.thinkingLevel === null ? '尚未读到当前档位' : thinkingNames[value.thinkingLevel] ?? value.thinkingLevel}</dd></div>
      <div><dt>插入消息</dt><dd>{queueNames[value.steeringMode]}</dd></div><div><dt>跟进消息</dt><dd>{queueNames[value.followUpMode]}</dd></div></dl>
    <div className="native-runtime-status" role="status"><span>{value.busy ? '原生任务执行中' : '原生执行当前空闲'}</span><span>{value.queued ? `另有 ${value.queued} 项待处理` : '没有待处理项'}</span></div>
    {value.nativeQueue && <p className="native-control-muted">Pi 队列：插入 {value.nativeQueue.steering} 项，跟进 {value.nativeQueue.followUp} 项。与调度队列分别展示，不叠加计数。</p>}
    <p className="native-control-muted">执行状态和待处理队列分别核对；空闲不等于没有排队工作。这里的状态来自原生会话，不是问题草稿。</p>
  </section>
}

/** Only a host-approved catalog is selectable. This form has no prompt, source, endpoint or credential input. */
export function NativeSettingsForm({ value, draft, disabled, onChange, onSave }: { value: NativeSettingsView, draft: NativeSettingsDraft, disabled: boolean, onChange(draft: NativeSettingsDraft): void, onSave(action: NativeControlAction): void }) {
  const model = value.models.find(item => nativeModelKey(item) === draft.modelKey), levels = value.thinkingLevels, selectedLevel = levels.includes(draft.thinkingLevel)
  const save = (field: 'model' | 'thinking' | 'steering' | 'follow-up', label: string) => { const action = nativeDraftAction(value, draft, field); return <button type="button" className="secondary-button" disabled={disabled || !action} onClick={() => { if (action) onSave(action) }}>{label}</button> }
  return <section className="native-settings-section" aria-label="编辑原生设置"><h3>设置下一次原生执行</h3><p className="native-control-muted">只使用服务端批准的模型目录和 Pi 实际支持的档位。保存配置不是一次问答，不修改提问草稿或文档来源。</p>
    <label>原生模型<select aria-label="原生模型" value={draft.modelKey} disabled={disabled || !value.models.length} onChange={event => onChange({ ...draft, modelKey: event.target.value })}>
      {!model && <option value={draft.modelKey} disabled>{draft.modelKey ? '当前选择不在获准目录，请明确选择' : '请选择获准模型'}</option>}{value.models.map(item => <option key={nativeModelKey(item)} value={nativeModelKey(item)}>{item.name} · {item.provider} / {item.id}</option>)}
    </select></label>{!value.models.length && <p className="native-control-notice">服务端没有返回可选模型；不会编造默认模型或接受自填 endpoint / API key。</p>}
    {save('model', '单独保存模型')}<p className="native-control-muted">只切换所选模型。Pi 可能按新模型支持情况调整档位，最终值以真实回执和刷新状态为准；这里不会把其他未保存选项一起提交。</p>
    <label>思考档位<select aria-label="原生思考档位" value={draft.thinkingLevel} disabled={disabled || !levels.length} onChange={event => onChange({ ...draft, thinkingLevel: event.target.value })}>
      {!selectedLevel && <option value={draft.thinkingLevel} disabled>{draft.thinkingLevel ? `原档位 ${thinkingNames[draft.thinkingLevel] ?? draft.thinkingLevel} 不适用于当前原生模型，请明确选择` : '请选择模型支持的档位'}</option>}{levels.map(level => <option key={level} value={level}>{thinkingNames[level] ?? level}</option>)}
    </select></label>{!levels.length && <p className="native-control-notice">尚无当前原生模型的可验证档位目录，不能保存猜测的配置。</p>}
    {save('thinking', '单独保存思考档位')}
    <label>插入消息队列<select aria-label="插入消息队列模式" value={draft.steeringMode} disabled={disabled} onChange={event => onChange({ ...draft, steeringMode: event.target.value as NativeQueueMode })}>{Object.entries(queueNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    {save('steering', '单独保存插入队列模式')}
    <label>跟进消息队列<select aria-label="跟进消息队列模式" value={draft.followUpMode} disabled={disabled} onChange={event => onChange({ ...draft, followUpMode: event.target.value as NativeQueueMode })}>{Object.entries(queueNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    {save('follow-up', '单独保存跟进队列模式')}
    <p className="native-control-muted">插入消息和跟进消息仍由 Pi 的原生队列执行；修改模式不会重新发送、删除或伪造消息。</p>
  </section>
}
