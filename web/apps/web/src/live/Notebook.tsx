import { UiText } from './locale'
import { useEffect, useRef, useState } from 'react'
import type { NotebookEntry, NotebookMutation, NoteSave, ResearchFocus, ResearchNotebookItem, ResearchNotebookResult, ResearchSessionPolicy } from '@docatlas/contracts'
import { Drawer } from '../Drawer'
import { Icon } from '../icons'
import type { LiveClient, LiveState } from './client'
import { currentNotebookPending, eligibleNoteTicket, notebookCommandPath, notebookContextCurrent, notebookOwnerKey, notebookReceiptMatches, notebookStorageKey, parseNotebookPending,
  type NotebookCommand, type NotebookOwner, type NotebookPending } from './notebook-state'
import './Notebook.css'
import type { ContinuityTarget } from './continuity-state'

const recordNames = { 'research-note': '研究笔记', 'open-question': '待研究问题', 'project-decision': '研究决策', 'research-policy': '研究规则', 'evidence-bookmark': '原文书签', 'claim-proposal': '结论提案' }
const statusNames = { active: '使用中', open: '待解决', proposed: '待研究提案', superseded: '已有后续版本', resolved: '已标记解决', archived: '已归档', deleted: '已软删除' }
function ownerOf(state: LiveState): NotebookOwner | null {
  return state.phase === 'ready' && state.actor && state.selected && state.snapshot ? { ...state.actor, conversationId: state.selected, bindingId: state.snapshot.binding.bindingId, generation: state.snapshot.binding.generation } : null
}

export function LiveNotebook({ client, state, onFocus, onContinue, openRequest, hideTrigger = false }: { client: LiveClient, state: LiveState, onFocus(focus: ResearchFocus): void, onContinue?(target: ContinuityTarget): void, openRequest?: { id: number, owner: NotebookOwner } | undefined, hideTrigger?: boolean }) {
  const owner = ownerOf(state), stamp = owner ? notebookOwnerKey(owner) : '', key = owner ? notebookStorageKey(owner) : ''
  const ownerRef = useRef(owner); ownerRef.current = owner
  const epoch = useRef(0), listSequence = useRef(0), entrySequence = useRef(0), focusSequence = useRef(0), policySequence = useRef(0)
  const writingLock = useRef(false)
  const [open, setOpen] = useState(false), [view, setView] = useState<'working' | 'workspace'>('working')
  const [list, setList] = useState<ResearchNotebookResult | null>(null), [entry, setEntry] = useState<NotebookEntry | null>(null), [editText, setEditText] = useState('')
  const [items, setItems] = useState<ResearchNotebookItem[]>([])
  const [loading, setLoading] = useState(false), [writing, setWriting] = useState(false), [notice, setNotice] = useState('')
  const [pending, setPending] = useState<NotebookPending | null>(null), [invalidPending, setInvalidPending] = useState(false)
  const [ticketId, setTicketId] = useState(''), [noteKind, setNoteKind] = useState<NoteSave['noteKind']>('commentary'), [noteText, setNoteText] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [policy, setPolicy] = useState<ResearchSessionPolicy | null>(null), [recall, setRecall] = useState(false), [contribute, setContribute] = useState(false)
  const blocked = writing || pending !== null || invalidPending, eligible = owner ? state.selections.filter(ticket => eligibleNoteTicket(ticket, owner)) : []
  function current(token: number, expected = stamp): boolean { return notebookContextCurrent(expected, ownerRef.current, token, epoch.current) }
  useEffect(() => {
    epoch.current++; listSequence.current++; entrySequence.current++; focusSequence.current++; policySequence.current++
    writingLock.current = false
    setOpen(false); setView('working'); setList(null); setItems([]); setEntry(null); setPolicy(null); setRecall(false); setContribute(false); setNotice(''); setWriting(false); setLoading(false); setConfirmed(false); setNoteKind('commentary'); setNoteText(''); setTicketId(''); setEditText(''); setInvalidPending(false); setPending(null)
    if (owner) try { setPending(parseNotebookPending(sessionStorage.getItem(key), owner)) } catch { setInvalidPending(true); setNotice('此标签页的旧笔记操作无法校验，未自动执行或覆盖。') }
    return () => { epoch.current++; focusSequence.current++ }
  }, [stamp, key])
  useEffect(() => { if (openRequest && owner && notebookOwnerKey(openRequest.owner) === stamp) { setOpen(true); void load(view); void loadPolicy() } }, [openRequest])

  async function load(requestedView = view, cursor?: string) {
    if (!owner) return
    const token = epoch.current, sequence = ++listSequence.current, previous = list, previousItems = items
    setLoading(true)
    if (!cursor) { setList(null); setItems([]) }
    try {
      const value = await client.researchRequest(owner.conversationId, 'query', { schemaVersion: 1, kind: 'notebook-query', expectedGeneration: owner.generation, view: requestedView, maxItems: 20, maxChars: 6000, ...(cursor ? { cursor } : {}) })
      if (!current(token) || sequence !== listSequence.current) return
      if (value.kind !== 'notebook-response' || value.result.workspaceId !== owner.workspaceId || value.result.view !== requestedView
        || cursor && (!previous || previous.view !== requestedView || previous.queryHash !== value.result.queryHash)) throw new Error('Notebook query changed')
      const nextItems = cursor ? [...previousItems, ...value.result.items] : value.result.items
      if (nextItems.length > 200 || new Set(nextItems.map(item => item.recordId)).size !== nextItems.length) throw new Error('Notebook page limit or identity conflict')
      setList(value.result); setItems(nextItems)
    } catch { if (current(token) && sequence === listSequence.current) setNotice('研究列表暂不可用或分页范围已变化，请刷新；没有重新执行任何写入。') }
    finally { if (current(token) && sequence === listSequence.current) setLoading(false) }
  }
  async function loadPolicy() {
    if (!owner) return
    const token = epoch.current, sequence = ++policySequence.current
    try {
      const value = await client.researchRequest(owner.conversationId, 'policy')
      if (!current(token) || sequence !== policySequence.current) return
      if (value.kind !== 'research-session-policy') throw new Error('Invalid research policy')
      setPolicy(value); setRecall(value.recallPriorResearch); setContribute(value.contributeResearchState)
    } catch { if (current(token) && sequence === policySequence.current) setNotice('尚不能核对研究开关；未假设默认策略，也未更改已有记录。') }
  }
  async function inspect(recordId: string) {
    if (!owner) return
    const token = epoch.current, sequence = ++entrySequence.current; focusSequence.current++; setEntry(null); setEditText('')
    try {
      const value = await client.researchRequest(owner.conversationId, `notes/${encodeURIComponent(recordId)}`)
      if (!current(token) || sequence !== entrySequence.current) return
      if (value.kind !== 'notebook-entry' || value.recordId !== recordId) throw new Error('Invalid Notebook entry')
      setEntry(value); setEditText(value.text ?? '')
    } catch { if (current(token) && sequence === entrySequence.current) setNotice('无法读取这条记录的完整当前版本；未用列表摘要替代编辑正文。') }
  }
  async function focus(locatorId: string) {
    if (!owner || !entry) return
    const token = epoch.current, sequence = ++focusSequence.current, record = entry
    const locator = record.locators.find(item => item.locatorId === locatorId)
    if (!locator) return
    try {
      const value = await client.researchRequest(owner.conversationId, `notes/${encodeURIComponent(record.recordId)}/focus/${encodeURIComponent(locatorId)}`, {})
      if (!current(token) || sequence !== focusSequence.current) return
      if (value.kind !== 'research-focus' || value.recordId !== record.recordId || value.locator.locatorId !== locatorId
        || value.locator.documentId !== locator.documentId || value.locator.revisionId !== locator.revisionId || value.locator.representationId !== locator.representationId
        || value.locator.representationContentHash !== locator.representationContentHash || value.physicalPage !== locator.physicalPage) throw new Error('Research source changed')
      onFocus(value); setOpen(false)
    } catch { if (current(token) && sequence === focusSequence.current) setNotice('研究原文目前无法核对，未跳到其他版本或以旧笔记代替原文。') }
  }
  async function commit(command?: NotebookCommand) {
    if (!owner || writingLock.current || writing || invalidPending) return
    writingLock.current = true
    const token = epoch.current
    let request = pending
    try {
      if (!request) {
        if (!command) return
        request = { version: 1, confirmed: true, owner: { ...owner }, command }
        parseNotebookPending(JSON.stringify(request), owner)
        sessionStorage.setItem(key, JSON.stringify(request)); setPending(request)
      }
      if (!currentNotebookPending(request, owner)) { setNotice('旧操作属于另一会话代际；请核对已保存记录，不会替换旧键或自动重放。'); return }
      setWriting(true); setNotice('正在核对这次研究操作的持久回执…'); policySequence.current++; focusSequence.current++; entrySequence.current++
      const result = await client.researchRequest(owner.conversationId, notebookCommandPath(request.command), request.command)
      if (!current(token)) return
      if (!notebookReceiptMatches(request, result)) throw new Error('Notebook receipt mismatch')
      const retained = parseNotebookPending(sessionStorage.getItem(key), owner)
      if (!retained || JSON.stringify(retained) !== JSON.stringify(request)) throw new Error('Notebook local receipt key changed')
      sessionStorage.removeItem(key); setPending(null); setNotice('研究操作已保存。笔记仍是待复核研究线索，不代表事实已核验。')
      if (result.kind === 'research-session-policy') { setPolicy(result); setRecall(result.recallPriorResearch); setContribute(result.contributeResearchState) }
      else if (result.kind === 'note-saved') { setNoteText(''); setConfirmed(false); if (result.result.record.recordType === 'research-note') void inspect(result.result.record.noteId) }
      else if (result.kind === 'notebook-updated') void inspect(result.result.state.recordId)
      void load(view)
    } catch { if (current(token)) setNotice('操作结果尚未确认或版本已变化。保留原键；先刷新记录，再决定核对原操作或清除本地待办，不会生成另一份笔记。') }
    finally { if (current(token)) { writingLock.current = false; setWriting(false) } }
  }
  function save() {
    if (!owner || blocked || !confirmed || !noteText.trim() || !state.selections.some(ticket => ticket.selectionContextId === ticketId && eligibleNoteTicket(ticket, owner))) return
    void commit({ schemaVersion: 1, kind: 'note-save', expectedGeneration: owner.generation, idempotencyKey: `research:${crypto.randomUUID()}`, selectionContextId: ticketId, noteKind, body: noteText })
  }
  function mutate(action: NotebookMutation['action']) {
    if (!owner || !entry || blocked || entry.status === 'deleted' || action === 'edit' && !editText.trim()) return
    if (action !== 'edit' && !window.confirm(action === 'delete' ? '这将软删除当前记录。历史版本仍然保留，不是隐私数据的彻底清除。确认继续？' : action === 'archive' ? '确认归档这条研究记录？历史版本仍保留。' : '只标记研究问题已解决，不代表相关结论已被事实核验。确认继续？')) return
    void commit({ schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: owner.generation, idempotencyKey: `research:${crypto.randomUUID()}`, recordId: entry.recordId,
      expectedVersion: entry.version, ...(action === 'edit' ? { action, text: editText } : { action }) })
  }
  function discard() {
    if (writingLock.current || writing || !window.confirm('仅清除此标签页的待核对操作；不会撤销服务端可能已经保存的记录，也不会删除历史。继续？')) return
    try { sessionStorage.removeItem(key); setPending(null); setInvalidPending(false); setNotice('仅清除了本地待办。请刷新 Notebook 核对服务端记录；没有撤销任何已保存研究。') } catch { setNotice('浏览器未能清除本地待办。') }
  }
  return <>{!hideTrigger && <button className="header-action" disabled={!owner} onClick={() => { setOpen(true); void load(view); void loadPolicy() }}><Icon name="note" size={17} /><UiText en="Research notes" zh="研究笔记" /></button>}
    {open && <Drawer title="研究笔记" subtitle="积累已完成的研究工作，保留原文来路；笔记不是新的事实证据。" onClose={() => { focusSequence.current++; setOpen(false) }}><div className="live-notebook">
      {notice && <p role="status" className="notebook-notice">{notice}</p>}
      {(pending || invalidPending) && <section className="notebook-pending" aria-label="待核对研究操作"><p>{pending ? `已保留原操作键：${pending.command.idempotencyKey}。刷新不会自动执行。` : '旧本地操作无法校验，写入已暂停。'}</p>
        {pending && <details><summary>查看已确认的操作</summary><p>{pending.command.kind === 'note-save' ? pending.command.body : pending.command.kind === 'notebook-mutate' ? pending.command.action === 'edit' ? pending.command.text : `${pending.command.action} · ${pending.command.recordId}` : `允许召回：${pending.command.recallPriorResearch ? '是' : '否'}；允许贡献：${pending.command.contributeResearchState ? '是' : '否'}`}</p></details>}
        {pending && <button disabled={writing || !owner || !currentNotebookPending(pending, owner)} onClick={() => void commit()}>{writing ? '正在核对…' : '使用原键核对操作'}</button>}<button disabled={writing} onClick={discard}>仅清除本地待办</button></section>}
      <details className="notebook-policy"><summary>Agent 的研究记忆开关</summary><p>这是当前会话的研究策略，不是个人偏好。关闭不会删除旧记录；你明确手动保存笔记仍然可用。</p>
        {!policy && <p className="notebook-muted">尚未读到当前策略；下方禁用状态不是默认策略回执。</p>}
        <label><input type="checkbox" checked={recall} disabled={blocked || !policy} onChange={event => setRecall(event.target.checked)} />允许 Agent 召回旧研究</label>
        <label><input type="checkbox" checked={contribute} disabled={blocked || !policy} onChange={event => setContribute(event.target.checked)} />允许 Agent 贡献研究记录</label>
        <button className="secondary-button" disabled={blocked || !policy || policy.recallPriorResearch === recall && policy.contributeResearchState === contribute} onClick={() => { if (owner && policy) void commit({ schemaVersion: 1, kind: 'research-policy-set', expectedGeneration: owner.generation, idempotencyKey: `research:${crypto.randomUUID()}`, expectedVersion: policy.version, recallPriorResearch: recall, contributeResearchState: contribute }) }}>确认研究开关</button>
      </details>
      <section className="notebook-create" aria-label="从已核验选区保存笔记"><h3>从原文选区保存笔记</h3><p>只使用当前已核验、未绑定到问题的选区；保存笔记不会消费或移除问题中的选区票据。</p>
        <label>关联的已核验选区<select aria-label="笔记关联选区" value={ticketId} disabled={blocked} onChange={event => { setTicketId(event.target.value); setConfirmed(false) }}><option value="">请选择选区</option>{eligible.map((ticket, index) => <option key={ticket.selectionContextId} value={ticket.selectionContextId}>{index + 1} · {ticket.items.map(item => `资料 ${item.locator.documentId.slice(-8)} / 版本 ${item.locator.revisionId.slice(-8)} / 第 ${item.locator.physicalPage} 页`).join('、')} · {ticket.items[0]?.text.slice(0, 50)}</option>)}</select></label>
        {!eligible.length && <p className="notebook-muted">请先在原始 PDF 中选中文字，并核验加入问题；这里不会把未核验文本当作来源。</p>}
        <label>笔记类型<select aria-label="笔记类型" value={noteKind} disabled={blocked} onChange={event => { setNoteKind(event.target.value as NoteSave['noteKind']); setConfirmed(false) }}><option value="commentary">评论与理解</option><option value="hypothesis">待验证假设</option><option value="scratch">研究草记</option></select></label>
        <label>笔记正文<textarea aria-label="新笔记正文" value={noteText} maxLength={4000} rows={4} disabled={blocked} onChange={event => { setNoteText(event.target.value); setConfirmed(false) }} /></label>
        <label className="notebook-confirm"><input type="checkbox" checked={confirmed} disabled={blocked} onChange={event => setConfirmed(event.target.checked)} />我确认保存这段研究记录及其原文关联；它仍是待复核线索。</label>
        <button className="primary-button" disabled={blocked || !confirmed || !noteText.trim() || !eligible.some(ticket => ticket.selectionContextId === ticketId)} onClick={save}>保存已确认笔记</button>
      </section>
      <div className="notebook-view" role="group" aria-label="笔记范围"><button aria-pressed={view === 'working'} onClick={() => { setView('working'); void load('working') }}>当前研究</button><button aria-pressed={view === 'workspace'} onClick={() => { setView('workspace'); void load('workspace') }}>工作区历史</button><button disabled={loading} onClick={() => void load(view)}>刷新笔记</button></div>
      {loading && <p role="status">正在读取研究记录…</p>}{list && !items.length && <p className="notebook-muted">此范围目前没有研究记录。</p>}
      <div className="notebook-records">{items.map(item => <article key={item.recordId} data-notebook-record={item.recordId}><header><strong>{recordNames[item.recordType]}</strong><span>{statusNames[item.recordStatus]} · v{item.recordVersion}</span></header><p>{item.preview}</p><small>{item.layer === 'working' ? '当前研究' : '工作区历史'} · {item.useStatus === 'unverified-lead' ? '待复核研究线索，不是新证据' : '用户治理记录'}{item.sourceState === 'outside-current-scope' || item.sourceState === 'mixed' ? ' · 含当前问题范围外的来源' : ''}</small>
        {(item.recordType === 'research-note' || item.recordType === 'open-question') && <button className="text-action" onClick={() => void inspect(item.recordId)}>查看全文与版本</button>}{onContinue && item.recordType === 'research-note' && <button className="text-action" disabled={writing} onClick={() => { focusSequence.current++; setOpen(false); onContinue({ recordId: item.recordId, recordVersion: item.recordVersion, label: item.preview }) }}>继续核验</button>}</article>)}</div>
      {list?.pageInfo.nextCursor && <button className="secondary-button" disabled={loading || items.length >= 200} onClick={() => void load(view, list.pageInfo.nextCursor)}>更多研究记录</button>}
      {list && items.length >= 200 && <p className="notebook-muted">本次列表已到 200 条显示上限；没有把截断当作完整研究历史。</p>}
      {entry && <section className="notebook-entry" aria-label="完整研究记录"><header><h3>{recordNames[entry.recordType]} · v{entry.version}</h3><span>{statusNames[entry.status]} · {entry.authoredBy === 'user' ? '用户记录' : 'Agent 记录'}</span></header>
        <p className="notebook-muted">{entry.recordId} · 完整当前版本，编辑按 v{entry.version} 条件提交；列表预览不会作为编辑正文。来源仍须重新读取，不能直接支持新结论。</p>
        {onContinue && entry.recordType === 'research-note' && entry.status !== 'deleted' && <button className="text-action" disabled={writing} onClick={() => { focusSequence.current++; setOpen(false); onContinue({ recordId: entry.recordId, recordVersion: entry.version, ...(entry.text ? { label: entry.text.slice(0, 500) } : {}) }) }}>继续核验已保存版本</button>}
        {entry.status === 'deleted' ? <p>当前记录已软删除，历史版本仍保留。</p> : <><label>完整正文<textarea aria-label="编辑笔记完整正文" rows={6} maxLength={8000} value={editText} disabled={blocked} onChange={event => setEditText(event.target.value)} /></label><div className="notebook-actions"><button disabled={blocked || !editText.trim() || editText === entry.text} onClick={() => mutate('edit')}>保存当前版本修改</button><button disabled={blocked || entry.status === 'archived'} onClick={() => mutate('archive')}>归档记录</button>{entry.recordType === 'open-question' && entry.status === 'open' && <button disabled={blocked} onClick={() => mutate('resolve')}>标记问题已解决</button>}<button disabled={blocked} onClick={() => mutate('delete')}>软删除（保留历史）</button><button onClick={() => void inspect(entry.recordId)}>重新读取版本</button></div>
          <div className="notebook-source-links">{entry.locators.map((locator, index) => <button key={locator.locatorId} className="text-action" onClick={() => void focus(locator.locatorId)}>回到来源 {index + 1} · 第 {locator.physicalPage} 页 · 版本 {locator.revisionId.slice(-10)}</button>)}</div></>}
      </section>}
    </div></Drawer>}
  </>
}
