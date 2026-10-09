import { useEffect, useRef, useState } from 'react'
import type { NativeLineageAction, ProductLineageCommand, ProductLineageInspection, ProductLineageOperation, ProductNativeTreeEntry, ProductNativeTreePage, ProductNativeTreeRequest } from '@docatlas/contracts'
import { Drawer } from '../Drawer'
import type { LiveState } from './client'
import { nativeControlIdentity, nativeIdentityKey } from './native-control-state'
import { acknowledgeLineageOperation, bindLineageOperation, checkedLineageInspection, checkedLineageOperation, lineageAction, lineageBindingMatches, lineageCanActivate,
  lineageDraft, lineageOperationMatches, lineageScopeKey, lineageTerminalProof, mergeLineageTree, readLineageOutbox, saveLineagePending,
  type LineageDraft, type LineageOutbox, type LineagePending, type LineageTree } from './lineage-state'
import './lineage-controls.css'

export interface LineageClient {
  state(): LiveState
  lineageInspect(conversationId: string): Promise<ProductLineageInspection>
  lineageTree(conversationId: string, request: ProductNativeTreeRequest): Promise<ProductNativeTreePage>
  lineageCommand(conversationId: string, request: ProductLineageCommand, recoveryOperationId?: string): Promise<ProductLineageOperation>
  lineageOperation(conversationId: string, operationId: string): Promise<ProductLineageOperation>
  loadConversations(after?: string): Promise<void>
  select(conversationId: string): Promise<void>
  refresh(): Promise<void>
  stop(): Promise<void>
}
const states = { accepted: '已接受，等待执行', applying: '正在执行原生操作', handoff: '正在完成会话交接', succeeded: '已核验完整交接回执', failed: '未完成', 'outcome-unknown': '结果未知，保留原键' }
const roles = { user: '用户', assistant: '助手', 'tool-result': '工具记录', compaction: '上下文压缩', 'branch-summary': '分支摘要', label: '标签', metadata: '原生元数据', 'custom-message': '扩展消息' }
const actionName = (action: NativeLineageAction) => action.kind === 'navigate' ? '切换当前原生分支' : action.position === 'before' ? '在用户消息之前创建子会话' : '从所选节点创建子会话'

export function LiveLineageControls({ client, state, open, onClose }: { client: LineageClient, state: LiveState, open: boolean, onClose(): void }) {
  const identity = nativeControlIdentity(state), stamp = identity ? nativeIdentityKey(identity) : ''
  const owner = state.phase === 'ready' && state.actor && state.selected ? { ...state.actor, conversationId: state.selected } : null
  const scope = owner ? lineageScopeKey(owner) : '', activeScope = useRef(scope), activeStamp = useRef(stamp)
  activeScope.current = scope; activeStamp.current = stamp
  const epoch = useRef(0), sequence = useRef(0), busy = useRef(false)
  const [inspection, setInspection] = useState<ProductLineageInspection | null>(null), [tree, setTree] = useState<LineageTree | null>(null), [verified, setVerified] = useState(false)
  const [view, setView] = useState<ProductNativeTreePage['view']>('messages'), [selected, setSelected] = useState<string | null>(null), [draft, setDraft] = useState(lineageDraft)
  const [outbox, setOutbox] = useState<LineageOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false)
  const [operation, setOperation] = useState<ProductLineageOperation | null>(null), operationRef = useRef(operation); operationRef.current = operation
  const [loading, setLoading] = useState(false), [writing, setWriting] = useState(false), [activating, setActivating] = useState(false), [notice, setNotice] = useState('')
  const current = (token: number) => {
    const now = client.state()
    return !!scope && token === epoch.current && activeScope.current === scope && now.phase === 'ready' && !!now.actor && now.selected === owner?.conversationId
      && now.actor.actorId === owner?.actorId && now.actor.workspaceId === owner?.workspaceId
  }
  const exact = (token: number) => { const now = nativeControlIdentity(client.state()); return current(token) && !!now && activeStamp.current === stamp && nativeIdentityKey(now) === stamp }
  function restore(): LineageOutbox {
    const now = nativeControlIdentity(client.state()), context = now ?? identity
    if (!context || lineageScopeKey(context) !== scope) return { state: 'empty' }
    try {
      let value = readLineageOutbox(sessionStorage, context)
      if (!now && value.state === 'pending') value = { ...value, current: false }
      setOutbox(value); setStorageBlocked(false); return value
    } catch { setStorageBlocked(true); setNotice('无法读取本标签页的分支待办；未发送新操作。'); return { state: 'empty' } }
  }
  useEffect(() => {
    epoch.current++; sequence.current++; busy.current = false; setInspection(null); setTree(null); setVerified(false); setSelected(null); setDraft(lineageDraft()); setView('messages')
    setOutbox({ state: 'empty' }); setStorageBlocked(false); setOperation(null); operationRef.current = null; setLoading(false); setWriting(false); setActivating(false); setNotice('')
    return () => { epoch.current++; sequence.current++ }
  }, [scope])
  useEffect(() => {
    sequence.current++; setInspection(null); setTree(null); setVerified(false); setSelected(null); setLoading(false); restore()
    if (open && identity && !busy.current) void load()
  }, [open, stamp, view, writing])
  async function accept(pending: LineagePending, value: ProductLineageOperation, isCurrent: () => boolean): Promise<boolean> {
    if (!await lineageOperationMatches(pending, value) || !isCurrent()) return false
    const previous = operationRef.current
    if (previous?.operationId === value.operationId && previous.version > value.version) return false
    let retained = pending
    if (pending.operationId === null) {
      const bound = await bindLineageOperation(sessionStorage, pending, value, isCurrent)
      if (!bound) return false
      retained = bound
    }
    if (!isCurrent()) return false
    operationRef.current = value; setOperation(value); restore()
    if (lineageTerminalProof(value)) {
      if (!await acknowledgeLineageOperation(sessionStorage, retained, value, isCurrent) || !isCurrent()) return false
      restore(); setInspection(null); setVerified(false); setTree(null); setSelected(null)
      setNotice(value.state === 'succeeded' ? '完整原键、原生证明与目标会话已核验。请明确打开结果；问题草稿没有被预览或 SDK 文本替换。'
        : '已核验此次操作没有应用，不等于切换或创建成功。不会自动重试；可只读刷新实际会话树。')
    } else setNotice(value.state === 'failed' || value.state === 'outcome-unknown'
      ? '没有完整成功或未应用证明。原请求仍保留，只能核对同一原操作；不会猜测成功或更换原生前缀。'
      : '原操作仍未完成产品交接。这里只查询原操作，不自动重发，也不打开尚未就绪的会话。')
    return true
  }
  async function load() {
    if (!identity || busy.current) return
    const token = epoch.current, serial = ++sequence.current, isCurrent = () => current(token) && serial === sequence.current
    const isExact = () => exact(token) && serial === sequence.current
    setLoading(true); setVerified(false)
    try {
      const value = checkedLineageInspection(identity, await client.lineageInspect(identity.conversationId))
      if (!isExact()) return
      setInspection(value)
      const retained = restore()
      if (retained.state === 'pending') {
        const candidate = retained.value.operationId ? await client.lineageOperation(identity.conversationId, retained.value.operationId)
          : value.operations.find(item => item.request.idempotencyKey === retained.value.request.idempotencyKey)
        if (candidate && isCurrent()) {
          if (!await accept(retained.value, candidate, isCurrent) && isCurrent()) setNotice('原操作未能匹配完整请求与原生证明；待办未删除，也未重新发送。')
          if (lineageTerminalProof(candidate)) return
        }
      }
      if (!isExact() || !value.head || value.busy || value.queued) { if (isExact()) setTree(null); return }
      const page = await client.lineageTree(identity.conversationId, { schemaVersion: 1, kind: 'native-tree-request', expectedGeneration: identity.generation, view, cursor: null })
      if (!isExact()) return
      setTree(mergeLineageTree(identity, value, null, page, null, view)); setVerified(true)
    } catch { if (isCurrent()) { setVerified(false); setNotice('会话树暂时无法核验，可能正在交接或所选前缀已变化。保留原操作，刷新只读状态不会执行新任务。') } }
    finally { if (isCurrent()) setLoading(false) }
  }
  async function more() {
    if (!identity || !inspection || !tree?.nextCursor || loading || busy.current) return
    const token = epoch.current, serial = ++sequence.current, before = tree, cursor = tree.nextCursor, isCurrent = () => exact(token) && serial === sequence.current
    setLoading(true)
    try {
      const page = await client.lineageTree(identity.conversationId, { schemaVersion: 1, kind: 'native-tree-request', expectedGeneration: identity.generation, view, cursor })
      if (isCurrent()) setTree(mergeLineageTree(identity, inspection, before, page, cursor, view))
    } catch { if (isCurrent()) { setVerified(false); setNotice('会话树游标、前缀或显示上限发生变化。请只读刷新，不继续拼接不同分支。') } }
    finally { if (isCurrent()) setLoading(false) }
  }
  async function query() {
    if (!owner || outbox.state !== 'pending' || !outbox.value.operationId || busy.current || loading) return
    const token = epoch.current, serial = ++sequence.current, pending = outbox.value, isCurrent = () => current(token) && serial === sequence.current
    setLoading(true)
    try {
      const value = await client.lineageOperation(owner.conversationId, pending.operationId!)
      if (isCurrent() && !await accept(pending, value, isCurrent) && isCurrent()) setNotice('收到的原操作不能匹配完整待办；保留原键。')
    } catch { if (isCurrent()) setNotice('尚不能读取原操作；待办与完整原键保留，没有重新执行。') }
    finally { if (isCurrent()) setLoading(false) }
  }
  useEffect(() => {
    if (!open || loading || writing || outbox.state !== 'pending' || !outbox.value.operationId || !operation || !['accepted', 'applying', 'handoff'].includes(operation.state)) return
    const timer = setTimeout(() => { void query() }, 900)
    return () => clearTimeout(timer)
  }, [open, loading, writing, outbox, operation?.state, scope, stamp])
  const blocked = !identity || !verified || loading || writing || activating || storageBlocked || !inspection?.head || inspection.busy || !!inspection.queued || outbox.state !== 'empty'
  async function commit(action?: NativeLineageAction) {
    if (!identity || busy.current || loading || storageBlocked || outbox.state === 'invalid') return
    const token = epoch.current
    let pending: LineagePending
    if (action) {
      if (blocked || !inspection?.head || !exact(token)) return
      pending = { schemaVersion: 1, identity: { ...identity }, operationId: null, request: { schemaVersion: 1, kind: 'lineage-command', conversationId: identity.conversationId,
        expectedBindingId: identity.bindingId, expectedGeneration: identity.generation, runtimeSessionId: identity.nativeSessionId,
        approvalId: inspection.resource.approvalId, expectedApprovalVersion: inspection.resource.version, expectedHead: structuredClone(inspection.head),
        idempotencyKey: `lineage:${crypto.randomUUID()}`, action: structuredClone(action) } }
    } else {
      if (outbox.state !== 'pending' || !outbox.current && !outbox.value.operationId) return
      pending = outbox.value
    }
    busy.current = true; sequence.current++; setWriting(true); setVerified(false)
    try {
      if (action) { saveLineagePending(sessionStorage, pending); restore() }
      const value = await client.lineageCommand(identity.conversationId, pending.request, action ? undefined : pending.operationId ?? undefined)
      if (current(token) && !await accept(pending, value, () => current(token)) && current(token)) setNotice('操作回执无法匹配冻结请求；原待办保留。')
    } catch { if (current(token)) { restore(); setNotice('结果尚未确认。完整原键、原批准及所选前缀全部保留；继续完成原操作前会先只读核对，不会重建新命令。') } }
    finally { if (current(token)) { busy.current = false; setWriting(false) } }
  }
  function discard() {
    const token = epoch.current
    if (!current(token) || busy.current || outbox.state === 'empty' || !window.confirm('只清除此标签页待办，不撤销可能已生效的分支操作，也不删除服务端会话。继续？') || !current(token)) return
    try {
      if (sessionStorage.getItem(outbox.key) !== outbox.raw) { restore(); return }
      sessionStorage.removeItem(outbox.key); restore(); setNotice('仅清除本地待办；原生历史、服务端回执及可能已创建的子会话都没有删除。')
    } catch { setNotice('无法清除本地待办。') }
  }
  async function activate() {
    if (!operation || !owner || activating || !lineageCanActivate(nativeControlIdentity(client.state()), operation)) return
    const token = epoch.current, value = operation
    setActivating(true)
    try {
      const verifiedOperation = await checkedLineageOperation(owner, value, value.operationId)
      if (!current(token) || !lineageCanActivate(nativeControlIdentity(client.state()), verifiedOperation) || !verifiedOperation.result) return
      const target = verifiedOperation.result.targetBinding
      if (verifiedOperation.request.action.kind === 'navigate') {
        await client.refresh()
        if (current(token)) {
          const now = nativeControlIdentity(client.state())
          setNotice(now && lineageBindingMatches(now, target) ? '已刷新到这次核验的所选分支。原问题草稿保留，请自行决定下一问。' : '交接回执已完成，但当前快照尚未对应目标，或用户已继续切换；没有强制切回。')
        }
      } else {
        const original = nativeControlIdentity(client.state())!, originalStamp = nativeIdentityKey(original), seen = new Set<string>()
        await client.loadConversations()
        for (let pages = 0; pages < 32; pages++) {
          const now = nativeControlIdentity(client.state())
          if (!current(token) || !now || nativeIdentityKey(now) !== originalStamp || !lineageCanActivate(now, verifiedOperation)) return
          const found = client.state().conversations.find(binding => binding.conversationId === target.conversationId)
          if (found) {
            if (found.bindingId !== target.bindingId || found.generation !== target.generation || found.runtimeSessionId !== target.runtimeSessionId || found.version !== target.version || found.branchEntryId !== target.branchEntryId
              || found.ownerActorId !== owner.actorId || found.workspaceId !== owner.workspaceId) throw new Error('Target binding changed')
            await client.select(target.conversationId); return
          }
          const cursor = client.state().nextConversation
          if (!cursor || seen.has(cursor)) throw new Error('Target is not in the bounded authorized conversation directory')
          seen.add(cursor); await client.loadConversations(cursor)
        }
        throw new Error('Conversation directory bound reached')
      }
    } catch { if (current(token)) setNotice('无法核对或打开这次操作的准确目标；没有强行切换会话。完整服务端回执仍保留。') }
    finally { if (current(token)) setActivating(false) }
  }
  async function stop() {
    const now = nativeControlIdentity(client.state()), latest = operationRef.current
    if (!now || !latest || !['accepted', 'applying', 'handoff'].includes(latest.state) || !lineageBindingMatches(now, latest.sourceBinding) || client.state().stopping) return
    const token = epoch.current
    try { await client.stop(); if (current(token)) setNotice('停止由服务端等待真实原生工作结束；仍需查询原操作证明，不将停止请求当作回滚。') }
    catch { if (current(token)) setNotice('尚未确认原生执行已停止；保留原操作待办。') }
  }
  if (!open || !owner) return null
  const entry = tree?.entries.find(item => item.entryId === selected)
  return <Drawer title="分支与会话树" subtitle="查看原生历史路径；切换当前上下文，或从历史位置创建独立子会话。" onClose={onClose}><div className="live-lineage-controls">
    <p className="native-control-muted">预览最多 1000 字，不是完整用户原话或文档证据。不会将预览或 SDK 编辑文本自动填入问题草稿。</p>
    {notice && <p className="native-control-notice" role="status">{notice}</p>}
    <div className="lineage-toolbar"><button className="secondary-button" disabled={!identity || loading || writing} onClick={() => void load()}>{loading ? '核对原生树…' : '刷新分支树（只读）'}</button>
      <label>显示范围<select aria-label="会话树显示范围" value={view} disabled={loading || writing} onChange={event => setView(event.target.value as ProductNativeTreePage['view'])}><option value="messages">用户与助手消息</option><option value="all">全部公开原生条目</option></select></label></div>
    {!identity && <p className="native-control-notice">等待当前会话的已核验快照；旧操作待办没有丢弃。</p>}
    {outbox.state !== 'empty' && <section className="native-control-notice" aria-label="待核对分支操作"><h3>保留了原分支操作</h3>{outbox.state === 'pending' ? <><p>{actionName(outbox.value.request.action)}</p><code>{outbox.value.request.idempotencyKey}</code>
      {!outbox.current && <p>原操作属于先前代际。只能查询同一操作；显式继续时先核对原回执，再提交完全相同的旧键与旧前缀。</p>}
      <details><summary>完整冻结请求与所选前缀</summary><pre>{JSON.stringify(outbox.value.request, null, 2)}</pre></details>
      {outbox.value.operationId && <button className="text-action" disabled={!identity || loading || writing} onClick={() => void query()}>仅查询原分支操作</button>}
      <button className="secondary-button" disabled={!identity || loading || writing || !outbox.current && !outbox.value.operationId} onClick={() => void commit()}>核对／继续完成原操作</button></> : <p>本地待办无法校验，新操作暂停；不会按当前树猜测或修补旧请求。</p>}
      <button className="text-action" disabled={writing} onClick={discard}>仅清除本地分支待办</button></section>}
    {operation && <LineageOperationStatus operation={operation} canOpen={lineageCanActivate(identity, operation)} opening={activating} onOpen={() => void activate()}
      stopping={state.stopping} canStop={!!identity && lineageBindingMatches(identity, operation.sourceBinding)} onStop={() => void stop()} />}
    {inspection && <p className="native-control-muted">代际 {inspection.binding.generation} · {inspection.busy ? '原生执行／交接中' : '当前空闲'} · 待处理 {inspection.queued} 项。{!inspection.head && ' 当前所选原生前缀尚不可核验。'}</p>}
    {tree && <><LineageTreeList tree={tree} selected={selected} onSelect={setSelected} />{tree.nextCursor && <button className="text-action" disabled={loading || writing} onClick={() => void more()}>加载更多原生节点</button>}
      {!tree.entries.length && <p>当前筛选没有可显示的原生节点。</p>}</>}
    {entry && <LineageActionForm entry={entry} draft={draft} disabled={blocked} onChange={setDraft} onAction={action => void commit(action)} />}
    {inspection?.operations.length ? <details className="native-control-history"><summary>已记录的分支操作</summary>{inspection.operations.map(item => <button type="button" className="lineage-record text-action" key={item.operationId} onClick={() => { setOperation(item); operationRef.current = item }}>
      {actionName(item.request.action)} · {states[item.state]}<small>{item.operationId} · v{item.version}</small></button>)}{inspection.truncated && <p>这里只显示有界记录，不是全部操作历史。</p>}</details> : null}
    <p className="native-control-muted">分支摘要只是模型上下文，不是新答案、Evidence 或个人记忆。关闭面板不撤销已提交操作；父会话与研究记录不会因 fork 被删除。</p>
  </div></Drawer>
}

export function LineageTreeList({ tree, selected, onSelect }: { tree: LineageTree, selected: string | null, onSelect(id: string): void }) {
  return <ol className="lineage-tree" aria-label="原生会话树">{tree.entries.map(entry => <li key={entry.entryId} data-lineage-entry={entry.entryId} data-lineage-parent={entry.parentId ?? ''} data-lineage-depth={entry.depth}>
    <button type="button" aria-label={`选择原生节点 ${entry.entryId}`} aria-pressed={selected === entry.entryId} onClick={() => onSelect(entry.entryId)} style={{ marginInlineStart: Math.min(entry.depth, 8) * 10 }}>
      <span className="lineage-node-heading"><span>{roles[entry.type]}</span>{entry.onSelectedBranch && <span className="lineage-path-tag">当前路径</span>}</span>
      {entry.label && <strong>{entry.label}</strong>}<span className="lineage-preview">{entry.preview || '此节点没有公开文本预览'}</span>
      <small>深度 {entry.depth} · {entry.entryId}</small>
    </button></li>)}</ol>
}
export function LineageActionForm({ entry, draft, disabled, onChange, onAction }: { entry: ProductNativeTreeEntry, draft: LineageDraft, disabled: boolean, onChange(value: LineageDraft): void, onAction(action: NativeLineageAction): void }) {
  const navigate = lineageAction(entry, draft, 'navigate'), before = lineageAction(entry, draft, 'before'), at = lineageAction(entry, draft, 'at')
  return <section className="native-settings-section lineage-actions" aria-label="所选节点的分支操作"><h3>从这个位置继续</h3><code>{entry.entryId}</code><small>父节点：{entry.parentId ?? '原生根节点'} · 深度 {entry.depth}</small>
    <details><summary>所选节点的有界预览</summary><p className="lineage-full-preview">{entry.preview || '没有公开文本预览'}</p></details>
    <p className="native-control-muted">切换到用户消息时，Pi 选择其父位置；这里不把该消息预览恢复成完整问题。当前草稿不自动替换。</p>
    <label className="lineage-check"><input type="checkbox" checked={draft.summarize} disabled={disabled} onChange={event => onChange({ ...draft, summarize: event.target.checked })} />切换时让 Pi 生成分支摘要</label>
    <label>摘要说明<textarea aria-label="分支摘要说明" rows={3} value={draft.instructions} maxLength={8192} disabled={disabled || !draft.summarize} onChange={event => onChange({ ...draft, instructions: event.target.value })} /></label>
    <label className="lineage-check"><input type="checkbox" checked={draft.replaceInstructions} disabled={disabled || !draft.summarize} onChange={event => onChange({ ...draft, replaceInstructions: event.target.checked })} />用上述说明替换默认摘要说明</label>
    <label>可选位置标签（留空不更改）<input aria-label="分支位置标签" value={draft.label} maxLength={512} disabled={disabled} onChange={event => onChange({ ...draft, label: event.target.value })} /></label>
    {([...draft.instructions].length > 4096 || [...draft.label].length > 256) && <p role="status">摘要说明最多 4096 字，标签最多 256 字。</p>}
    <button type="button" className="primary-button" disabled={disabled || !navigate} onClick={() => { if (navigate) onAction(navigate) }}>切换到这个原生位置</button>
    <div className="lineage-fork-actions"><button type="button" className="secondary-button" disabled={disabled || !at} onClick={() => { if (at) onAction(at) }}>从此节点创建子会话</button>
      <button type="button" className="secondary-button" disabled={disabled || !before} onClick={() => { if (before) onAction(before) }}>在此用户消息之前创建子会话</button></div>
    <p className="native-control-muted">子会话使用 Pi 的真实继承路径，父会话保持不变。当前父会话草稿留在原会话，不把 SDK 文本或预览复制到子会话。</p>
  </section>
}
export function LineageOperationStatus({ operation, canOpen, opening = false, onOpen, canStop = false, stopping = false, onStop }: {
  operation: ProductLineageOperation, canOpen: boolean, opening?: boolean, onOpen(): void, canStop?: boolean, stopping?: boolean, onStop?(): void
}) {
  const succeeded = operation.state === 'succeeded' && operation.result, knownFailure = operation.state === 'failed' && operation.failureProof
  return <section className="native-control-notice" aria-label="分支操作回执" data-lineage-state={operation.state}><h3>{knownFailure ? '已核验分支操作未应用' : operation.state === 'succeeded' && !succeeded ? '缺少完整交接证明' : states[operation.state]}</h3>
    <p>{actionName(operation.request.action)}</p><code>{operation.operationId}</code>
    {succeeded ? <><p>完整原生证明与产品目标绑定已完成，不是仅执行原生后的临时状态。</p><small>目标会话 {succeeded.targetBinding.conversationId} · 代际 {succeeded.targetBinding.generation}</small>
      <small>所选前缀 {succeeded.proof.targetHead.contextHash}</small><button type="button" className="secondary-button" disabled={!canOpen || opening} onClick={onOpen}>{opening ? '核对目标会话…' : operation.request.action.kind === 'navigate' ? '刷新到已核验的当前分支' : '打开已核验的子会话'}</button>
      {!canOpen && <p>当前来源会话或代际已继续变化；不会用旧回执把你强行切回。</p>}</>
      : knownFailure ? <p>真实终止记录证明没有应用本次切换／fork。不是成功，也不会自动重试。</p>
        : <p>{operation.state === 'handoff' ? '产品交接尚未完成，不能把目标视为可继续使用。' : '尚无完整成功或未应用证明；待办保留。'}</p>}
    {onStop && canStop && ['accepted', 'applying', 'handoff'].includes(operation.state) && <button type="button" className="secondary-button" disabled={stopping} onClick={onStop}>{stopping ? '等待确认原生停止…' : '停止当前原生分支执行'}</button>}
  </section>
}
