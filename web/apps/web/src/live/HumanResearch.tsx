import { UiText, useUi } from './locale'
import { useEffect, useRef, useState } from 'react'
import type { DocumentLocator, HumanResearchCommand, HumanResearchEntry, HumanResearchOperation, HumanResearchOverlay, HumanResearchOverlayQuery, HumanResearchQuery, HumanResearchRecordStatus, HumanResearchRecordType, ProductSelectionProposal, ProductSourceRef, ResearchFocus, TreeOverlayItem } from '@docatlas/contracts'
import { Drawer } from '../Drawer'
import { Icon } from '../icons'
import type { LiveClient, LiveState } from './client'
import type { ContinuityTarget } from './continuity-state'
import { canonical } from './state'
import { acknowledgeHumanResearch, emptyHumanResearchEditor, humanResearchAccountKey, humanResearchBinding, humanResearchEditorCommand, humanResearchEntryEditor,
  humanResearchFrame, humanResearchNames, humanResearchOperationId, humanResearchOwner, humanResearchOwnerKey, humanResearchReceiptMatches, humanResearchStorageKey,
  humanResearchTextLimit, humanResearchTypes, mergeHumanResearchPages, readHumanResearchOutbox, saveHumanResearchPending,
  type HumanResearchEditor, type HumanResearchListing, type HumanResearchOutbox, type HumanResearchOwner, type HumanResearchPending } from './human-research-state'
import './human-research.css'

export type HumanResearchOpenRequest = { id: number, owner: HumanResearchOwner } & (
  { kind: 'selection', selection: ProductSelectionProposal } | { kind: 'overlay', source: ProductSourceRef, physicalPage: number } | { kind: 'entry', recordId: string })
const statuses = { active: '使用中', open: '待解决', resolved: '已标记解决', archived: '已归档', deleted: '已软删除', superseded: '已有后续版本', proposed: '待研究提案' }
type Client = Pick<LiveClient, 'state' | 'humanResearchQuery' | 'humanResearchEntry' | 'humanResearchCommand' | 'humanResearchOperation' | 'humanResearchOverlay' | 'humanResearchFocus'>
const sameAnchor = (a: DocumentLocator, b: DocumentLocator) => ['locatorId', 'documentId', 'revisionId', 'representationId', 'representationContentHash', 'physicalPage'].every(key => Reflect.get(a, key) === Reflect.get(b, key))

export function LiveHumanResearch({ client, state, onFocus, onContinue, onLegacy, openRequest, onAvailability, onChanged }: {
  client: Client, state: LiveState, onFocus(focus: ResearchFocus): void, onContinue?(target: ContinuityTarget): void, onLegacy(): void,
  openRequest?: HumanResearchOpenRequest | undefined, onAvailability?(available: boolean): void, onChanged?(): void,
}) {
  const { t } = useUi()
  const owner = humanResearchOwner(state), stamp = owner ? humanResearchOwnerKey(owner) : '', account = owner ? humanResearchAccountKey(owner) : ''
  const active = useRef(stamp); active.current = stamp
  const epoch = useRef(0), listSequence = useRef(0), detailSequence = useRef(0), focusSequence = useRef(0), overlaySequence = useRef(0), writingLock = useRef(false), seenOpen = useRef(0)
  const [open, setOpen] = useState(false), [view, setView] = useState<HumanResearchQuery['view']>('working')
  const [type, setType] = useState<'all' | HumanResearchRecordType>('all'), [status, setStatus] = useState<'all' | HumanResearchRecordStatus>('all')
  const [listing, setListing] = useState<HumanResearchListing | null>(null), [loading, setLoading] = useState(false), [notice, setNotice] = useState('')
  const [entry, setEntry] = useState<HumanResearchEntry | null>(null), [editor, setEditor] = useState(false), [draft, setDraft] = useState(emptyHumanResearchEditor)
  const baseline = useRef(canonical(emptyHumanResearchEditor())), [confirmed, setConfirmed] = useState(false)
  const [outbox, setOutbox] = useState<HumanResearchOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false), [writing, setWriting] = useState(false)
  const [lastOperation, setLastOperation] = useState<HumanResearchOperation | null>(null)
  const [overlayRequest, setOverlayRequest] = useState<HumanResearchOverlayQuery | null>(null), [overlay, setOverlay] = useState<HumanResearchOverlay | null>(null), [overlayItems, setOverlayItems] = useState<TreeOverlayItem[]>([]), [overlayLoading, setOverlayLoading] = useState(false)
  const blocked = !owner || writing || storageBlocked || outbox.state !== 'empty'
  function current(token: number) { const now = humanResearchOwner(client.state()); return !!now && token === epoch.current && active.current === stamp && humanResearchOwnerKey(now) === stamp }
  function restore() {
    if (!owner) return
    try { setOutbox(readHumanResearchOutbox(sessionStorage, owner)); setStorageBlocked(false) }
    catch { setStorageBlocked(true); setNotice('无法读取本标签页研究待办；未发送新操作。') }
  }
  useEffect(() => { setOpen(false); seenOpen.current = 0 }, [account])
  useEffect(() => {
    epoch.current++; listSequence.current++; detailSequence.current++; focusSequence.current++; overlaySequence.current++; writingLock.current = false
    setListing(null); setEntry(null); setEditor(false); setDraft(emptyHumanResearchEditor()); baseline.current = canonical(emptyHumanResearchEditor()); setConfirmed(false)
    setLoading(false); setWriting(false); setOverlay(null); setOverlayItems([]); setOverlayRequest(null); setOverlayLoading(false); setLastOperation(null); setNotice(''); restore()
    return () => { epoch.current++ }
  }, [stamp])
  useEffect(() => { onAvailability?.(!blocked); return () => onAvailability?.(false) }, [blocked, onAvailability])
  useEffect(() => { if (open && owner) void load() }, [open, stamp, view, type, status])
  useEffect(() => {
    if (!openRequest || !owner || seenOpen.current === openRequest.id) return
    seenOpen.current = openRequest.id
    if (humanResearchOwnerKey(openRequest.owner) !== stamp) return
    focusSequence.current++
    setOpen(true)
    if (openRequest.kind === 'overlay') { void loadOverlay({ ...humanResearchFrame(owner), kind: 'human-research-overlay-query', source: structuredClone(openRequest.source), physicalPage: openRequest.physicalPage,
      view: 'workspace', recordTypes: [...humanResearchTypes], maxItems: 20, maxChars: 6000 }); return }
    if (blocked || writingLock.current) { setNotice('先核对独立研究待办；问题草稿与票据没有改变。'); return }
    if (openRequest.kind === 'entry') { void inspect(openRequest.recordId); return }
    if (editor && (entry || ['project-decision', 'research-policy'].includes(draft.recordType)) && !window.confirm('打开新的原文笔记会替换当前尚未保存的研究编辑表单，问题草稿不受影响。继续？')) return
    const base = editor && !entry && ['research-note', 'open-question'].includes(draft.recordType) ? draft : emptyHumanResearchEditor()
    const selected = structuredClone(openRequest.selection), selections = base.selections.some(item => canonical(item) === canonical(selected)) ? base.selections : [...base.selections, selected]
    if (selections.length > 8 || selections.reduce((sum, item) => sum + [...item.quote].length, 0) > 8000) { setNotice('一条研究记录最多关联8段、8000字原文；原草稿未替换。'); return }
    detailSequence.current++; setEntry(null); setEditor(true); setDraft({ ...base, selections }); setConfirmed(false)
    setNotice('选区仅加入独立研究草稿；保存时服务端核验。没有加入问题、创建证据或调用模型。')
  }, [openRequest, stamp])
  async function load(cursor?: string) {
    if (!owner) return
    const token = epoch.current, sequence = ++listSequence.current, previous = listing
    const request: HumanResearchQuery = { ...humanResearchFrame(owner), kind: 'human-research-query', view, recordTypes: type === 'all' ? [...humanResearchTypes] : [type],
      recordStatuses: status === 'all' ? ['active', 'open', 'resolved', 'archived'] : [status], maxItems: 20, maxChars: 6000, ...(cursor ? { cursor } : {}) }
    setLoading(true); if (!cursor) setListing(null)
    try { const result = await client.humanResearchQuery(owner.conversationId, request); if (current(token) && sequence === listSequence.current) setListing(mergeHumanResearchPages(previous, result, request, owner)) }
    catch { if (current(token) && sequence === listSequence.current) setNotice('研究列表或游标暂不可核对；刷新不会重新执行研究写入。') }
    finally { if (current(token) && sequence === listSequence.current) setLoading(false) }
  }
  async function inspect(id: string, force = false) {
    if (!owner || !force && editor && canonical(draft) !== baseline.current && !window.confirm('读取另一记录会替换尚未保存的研究表单，继续？')) return
    const token = epoch.current, sequence = ++detailSequence.current; focusSequence.current++
    setEntry(null); setEditor(false)
    try {
      const value = await client.humanResearchEntry(owner.conversationId, id)
      if (!current(token) || sequence !== detailSequence.current) return
      if (!humanResearchBinding(owner, value.binding) || value.entry.recordId !== id) throw new Error('Research detail identity changed')
      const next = humanResearchEntryEditor(value); baseline.current = canonical(next); setDraft(next); setEntry(value); setEditor(true); setConfirmed(false)
    } catch { if (current(token) && sequence === detailSequence.current) setNotice('不能读取这条记录的完整当前版本；没有用列表预览替代正文。') }
  }
  async function focus(recordId: string, locator: DocumentLocator) {
    if (!owner) return
    const token = epoch.current, sequence = ++focusSequence.current
    try {
      const value = await client.humanResearchFocus(owner.conversationId, recordId, locator.locatorId)
      if (!current(token) || sequence !== focusSequence.current) return
      if (!humanResearchBinding(owner, value.binding) || value.focus.recordId !== recordId || !sameAnchor(value.focus.locator, locator)) throw new Error('Research source changed')
      onFocus(value.focus); setOpen(false)
    } catch { if (current(token) && sequence === focusSequence.current) setNotice('原始来源暂不可授权或定位；没有使用旧笔记或另一版本替代原文。') }
  }
  async function loadOverlay(request: HumanResearchOverlayQuery) {
    if (!owner) return
    const token = epoch.current, sequence = ++overlaySequence.current, previous = overlay, previousItems = overlayItems
    setOverlayLoading(true)
    if (!request.cursor) { setOverlayItems([]); setOverlay(null); setOverlayRequest(structuredClone(request)) }
    try {
      const result = await client.humanResearchOverlay(owner.conversationId, request)
      if (!current(token) || sequence !== overlaySequence.current) return
      if (request.cursor && (!previous || previous.result.queryHash !== result.result.queryHash || previous.result.pageInfo.nextCursor !== request.cursor)) throw new Error('Overlay cursor changed')
      const items = request.cursor ? [...previousItems, ...result.result.items] : result.result.items
      if (items.length > 200 || new Set(items.map(item => item.overlayId)).size !== items.length) throw new Error('Overlay display bound')
      setOverlay(result); setOverlayItems(items)
    } catch { if (current(token) && sequence === overlaySequence.current) setNotice('原文研究标记暂不可核对；没有修改原目录或绘制猜测锚点。') }
    finally { if (current(token) && sequence === overlaySequence.current) setOverlayLoading(false) }
  }
  async function accept(pending: HumanResearchPending, value: HumanResearchOperation, token: number) {
    if (!await acknowledgeHumanResearch(sessionStorage, pending, value, () => current(token)) || !current(token)) throw new Error('Research receipt not matched')
    restore(); setLastOperation(value); setConfirmed(false); setEditor(false)
    if (value.receipt) onChanged?.()
    setNotice('已核对原键与持久记录版本。研究文字不是新证据；规则仅记录，不自动执行。')
    void load(); if (value.receipt) void inspect(value.receipt.recordId, true)
    if (overlayRequest) { const { cursor: _cursor, ...request } = overlayRequest; void loadOverlay(request) }
  }
  async function commit(request?: HumanResearchCommand, queryOnly = false) {
    if (!owner || writingLock.current || storageBlocked || outbox.state === 'invalid') return
    const token = epoch.current; writingLock.current = true; setWriting(true)
    detailSequence.current++; focusSequence.current++; listSequence.current++; overlaySequence.current++; setLoading(false); setOverlayLoading(false)
    if (request) setLastOperation(null)
    try {
      let pending: HumanResearchPending
      if (request) {
        if (outbox.state !== 'empty') return
        pending = { schemaVersion: 1, owner: { ...owner }, request: structuredClone(request) }
        saveHumanResearchPending(sessionStorage, pending); restore()
      } else {
        if (outbox.state !== 'pending') return
        pending = structuredClone(outbox.value)
        const id = await humanResearchOperationId(pending.owner, pending.request.idempotencyKey)
        if (!current(token)) return
        const previous = await client.humanResearchOperation(owner.conversationId, id)
        if (!current(token)) return
        if (previous.receipt) { if (!await humanResearchReceiptMatches(pending, previous)) throw new Error('Original research receipt mismatch'); await accept(pending, previous, token); return }
        if (queryOnly || humanResearchOwnerKey(pending.owner) !== stamp) { setNotice('没有查到可核验的原提交回执。待办保留；未跨代际重发，也不把未查到当作未执行证明。'); return }
      }
      if (!current(token)) return
      const value = await client.humanResearchCommand(owner.conversationId, pending.request)
      if (current(token)) await accept(pending, value, token)
    } catch { if (current(token)) { restore(); setNotice('研究操作结果未确认或版本冲突。完整原请求仍保留；只读核对或显式使用原键重试，不自动发送问题。') } }
    finally { if (current(token)) { writingLock.current = false; setWriting(false) } }
  }
  function discard() {
    if (!owner || writingLock.current || outbox.state === 'empty' || !window.confirm('只清除此标签页的研究待办，不撤销服务端可能保存的记录，也不删除历史。继续？')) return
    const raw = outbox.raw, key = humanResearchStorageKey(owner)
    try { if (sessionStorage.getItem(key) !== raw) { restore(); return }; sessionStorage.removeItem(key); restore(); setNotice('仅清除了本地研究待办；问题草稿和服务端记录没有改变。') } catch { setNotice('无法清除本地研究待办。') }
  }
  function create() {
    if (blocked || editor && canonical(draft) !== baseline.current && !window.confirm('放弃当前尚未保存的研究表单，创建自由记录？')) return
    detailSequence.current++; focusSequence.current++
    const next = emptyHumanResearchEditor(); baseline.current = canonical(next); setDraft(next); setEntry(null); setEditor(true); setConfirmed(false)
  }
  function mutate(action: 'resolve' | 'archive' | 'delete') {
    if (!owner || !entry || blocked || entry.entry.status === 'deleted' || !window.confirm(action === 'delete' ? '软删除只隐藏当前记录，历史仍保留，不是隐私擦除。确认？' : action === 'resolve' ? '仅标记研究问题已解决，不代表事实核验。确认？' : '归档这条研究记录，历史仍保留。确认？')) return
    void commit({ ...humanResearchFrame(owner), kind: 'human-research-command', idempotencyKey: `human:${crypto.randomUUID()}`, action, recordId: entry.entry.recordId, expectedVersion: entry.entry.version })
  }
  const command = owner ? humanResearchEditorCommand(owner, draft, 'human:validation', entry) : null
  return <><button className="header-action" disabled={!owner} onClick={() => setOpen(true)}><Icon name="note" size={17} /><UiText en="Research notes" zh="研究笔记" /></button>
    {open && <Drawer workspace title="研究笔记" subtitle="独立保存理解、问题和研究决策；需要时回到原始 PDF。" onClose={() => { focusSequence.current++; setOpen(false) }}><div className="human-research">
      <div className="research-workspace-intro"><div><h3>{t('Keep the thinking that matters', '把重要的思考留下来')}</h3><p>{t('Capture an observation, a question or a decision. Original passages stay linked; your interpretation stays yours.', '记录理解、疑问与研究决策。保留原文关联，也区分原文与你的判断。')}</p></div><div className="research-counts"><span><strong>{listing?.items.length ?? 0}</strong>{t('loaded records', '条已加载记录')}</span><span><strong>{listing?.items.filter(item => item.recordStatus === 'open').length ?? 0}</strong>{t('open questions', '个待解决问题')}</span></div></div>
      {notice && <p role="status" className="human-notice">{notice}</p>}
      <p className="human-muted">手动保存不发送问题、不消费选区票据，也不更改 Agent 研究许可或个人偏好。</p>
      {outbox.state !== 'empty' && <section className="human-notice" aria-label="待核对人类研究操作"><h3>原研究操作已保留</h3>
        {outbox.state === 'pending' ? <><code>{outbox.value.request.idempotencyKey}</code>{!outbox.current && <p>来自先前代际，只能查询同一原操作；不会改写旧请求。</p>}
          <details><summary>完整冻结的研究请求</summary><pre>{JSON.stringify(outbox.value.request, null, 2)}</pre></details>
          <button disabled={writing} onClick={() => void commit(undefined, true)}>只读核对原研究操作</button><button disabled={writing || !outbox.current} onClick={() => void commit()}>使用原键重试研究操作</button></> : <p>旧待办无法校验；没有修补或自动执行。</p>}
        <button disabled={writing} onClick={discard}>仅清除本地研究待办</button></section>}
      {lastOperation?.receipt && <p className="human-muted" role="status" data-human-receipt={lastOperation.operationId}>已保存原操作 · {lastOperation.receipt.recordId} · v{lastOperation.receipt.recordVersion}。回执不包含已删除正文。</p>}
      <div className="human-toolbar"><button className="primary-button" disabled={blocked} onClick={create}>新增研究记录</button><button className="text-action" disabled={loading} onClick={() => void load()}>刷新研究（只读）</button>
        <button className="text-action" onClick={() => { focusSequence.current++; setOpen(false); onLegacy() }}>Agent 研究设置与托盘笔记</button></div>
      <div className="human-notebook-columns"><div className={`human-notebook-detail ${editor ? '' : 'is-empty'}`}>
      {editor && <section className="human-editor" aria-label="人类研究编辑器"><h3>{entry ? `${humanResearchNames[entry.entry.recordType]} · v${entry.entry.version}` : '新建独立研究记录'}</h3>
        {entry && <p className="human-muted">{statuses[entry.entry.status]} · {entry.entry.recordId}。这里读取完整当前版本；保存以 v{entry.entry.version} 为条件。</p>}
        {entry?.entry.status === 'deleted' ? <p>当前内容已软删除；历史保留，原提交回执不会恢复旧正文。</p> : <>
          <HumanResearchForm draft={draft} editing={!!entry} disabled={blocked} availableSources={state.sourceRefs} onChange={value => { setDraft(value); setConfirmed(false) }} />
          {!entry && <label className="human-check"><input type="checkbox" checked={confirmed} disabled={blocked} onChange={event => setConfirmed(event.target.checked)} />确认保存此研究内容与明确关联；原文位置不是事实支持证明。</label>}
          <div className="human-actions"><button className="primary-button" disabled={blocked || !command || !entry && !confirmed || !!entry && canonical(draft) === baseline.current} onClick={() => { if (owner) { const input = humanResearchEditorCommand(owner, draft, `human:${crypto.randomUUID()}`, entry); if (input) void commit(input) } }}>{writing ? '正在核对保存…' : entry ? '保存研究新版本' : '保存到研究'}</button>
            {entry && <><button disabled={blocked || entry.entry.status === 'archived'} onClick={() => mutate('archive')}>归档研究记录</button>{entry.entry.recordType === 'open-question' && entry.entry.status === 'open' && <button disabled={blocked} onClick={() => mutate('resolve')}>标记问题已解决</button>}<button disabled={blocked} onClick={() => mutate('delete')}>软删除研究记录</button><button onClick={() => void inspect(entry.entry.recordId, true)}>重新读取完整版本</button></>}
          </div>
          {entry && 'kind' in entry.entry && <div className="human-source-links">{entry.entry.locators.length ? entry.entry.locators.map((locator, index) => <button className="text-action" key={locator.locatorId} onClick={() => void focus(entry.entry.recordId, locator)}>回到研究原文 {index + 1} · 第 {locator.physicalPage} 页 · 版本 {locator.revisionId.slice(-10)}</button>) : <p className="human-muted">此记录没有原文锚点，不会猜测页码或生成引用。</p>}
            {onContinue && entry.entry.recordType === 'research-note' && <button className="text-action" onClick={() => { setOpen(false); onContinue({ recordId: entry.entry.recordId, recordVersion: entry.entry.version, label: draft.text.slice(0, 500) }) }}>继续核验原研究版本</button>}</div>}
        </>}
      </section>}
      {!editor && <div className="human-notebook-empty"><Icon name="note" size={34} /><h3>{t('A place for your understanding', '独立记录你的理解')}</h3><p>{t('Select a record to read its full text and sources, or start a note without sending a chat message.', '选择记录查看完整正文与来源，或直接写下笔记，不必先发起问答。')}</p><div className="human-note-types"><span>{t('Notes & hypotheses', '评论与假设')}</span><span>{t('Questions', '待研究问题')}</span><span>{t('Decisions & rules', '决策与规则')}</span></div><button className="primary-button" disabled={blocked} onClick={create}>{t('Write a note', '写一条笔记')}</button></div>}
      </div><aside className="human-notebook-list" aria-label={t('Research record collection', '研究记录集合')}>
      <div className="human-filters"><label>范围<select aria-label="研究范围" value={view} onChange={event => setView(event.target.value as typeof view)}><option value="working">当前研究</option><option value="workspace">工作区历史</option></select></label>
        <label>类型<select aria-label="研究类型筛选" value={type} onChange={event => setType(event.target.value as typeof type)}><option value="all">全部类型</option>{humanResearchTypes.map(value => <option key={value} value={value}>{humanResearchNames[value]}</option>)}</select></label>
        <label>状态<select aria-label="研究状态筛选" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">全部可见状态</option>{(['active', 'open', 'resolved', 'archived'] as const).map(value => <option key={value} value={value}>{statuses[value]}</option>)}</select></label></div>
      {loading && <p role="status">正在读取研究记录…</p>}{listing && !listing.items.length && <p>当前筛选没有可见研究记录。</p>}
      <div className="human-records">{listing?.items.map(item => <article key={item.recordId} data-human-record={item.recordId} data-record-type={item.recordType} className={entry?.entry.recordId === item.recordId ? 'is-selected' : ''}><header><strong>{humanResearchNames[item.recordType as HumanResearchRecordType]}</strong><span>{statuses[item.recordStatus]} · v{item.recordVersion}</span></header><p>{item.preview}</p>
        <small>{item.useStatus === 'user-governance' ? '用户研究治理 · 不是事实证据或自动执行规则' : '待复核研究线索 · 不是新证据'}{item.sourceState === 'none' ? ' · 无关联来源' : ' · 保留明确来源版本'}</small>
        <button className="text-action" onClick={() => void inspect(item.recordId)}>查看研究全文与版本</button></article>)}</div>
      {listing?.latest.result.pageInfo.nextCursor && <button disabled={loading || listing.items.length >= 200} onClick={() => void load(listing.latest.result.pageInfo.nextCursor!)}>更多研究记录</button>}
      {listing && listing.items.length >= 200 && <p className="human-muted">已到本页200条显示上限；不是完整研究历史。</p>}
      </aside></div>
      {overlayRequest && <section className="human-overlay" aria-label="原文研究标记"><h3>此页的研究记录</h3><p className="human-muted">第 {overlayRequest.physicalPage} 页 · 版本 {overlayRequest.source.revisionId}。只有精确原文锚点，不修改文档目录，也不代表笔记解释已核验。</p>
        <label>标记范围<select aria-label="原文标记范围" value={overlayRequest.view} disabled={overlayLoading} onChange={event => { const { cursor: _cursor, ...request } = overlayRequest; void loadOverlay({ ...request, view: event.target.value as HumanResearchOverlayQuery['view'] }) }}><option value="working">当前研究</option><option value="workspace">工作区历史</option></select></label>
        <button disabled={overlayLoading} onClick={() => { const { cursor: _cursor, ...request } = overlayRequest; void loadOverlay(request) }}>刷新此页研究标记</button>
        {overlayLoading && <p role="status">正在核对原文标记…</p>}{overlay && !overlayItems.length && <p>此来源／页面没有可见的精确研究标记。</p>}
        {overlayItems.map(item => <article key={item.overlayId} data-human-overlay={item.overlayId}><p>{item.preview}</p><small>{humanResearchNames[item.recordType as HumanResearchRecordType]} · {statuses[item.recordStatus]} · 仅位置关联</small><button onClick={() => void inspect(item.recordId)}>查看对应研究记录</button><button onClick={() => void focus(item.recordId, item.locator)}>打开标记的原始 PDF</button></article>)}
        {overlay?.result.pageInfo.nextCursor && <button disabled={overlayLoading || overlayItems.length >= 200} onClick={() => void loadOverlay({ ...overlayRequest, cursor: overlay.result.pageInfo.nextCursor! })}>更多原文研究标记</button>}
      </section>}
      <p className="research-workspace-help">{t('Anchored notes and questions also appear in the document map’s Research view. Revisions update their markers; deleting a record retracts them. The original outline is unchanged.', '带原文锚点的笔记与问题也会出现在文档地图的研究视图中。修订会更新标记，删除会撤回标记，原始目录保持不变。')}</p>
    </div></Drawer>}
  </>
}

export function HumanResearchForm({ draft, editing, disabled, availableSources, onChange }: { draft: HumanResearchEditor, editing: boolean, disabled: boolean, availableSources: ProductSourceRef[], onChange(value: HumanResearchEditor): void }) {
  const governance = draft.recordType === 'project-decision' || draft.recordType === 'research-policy'
  const sources = new Map([...availableSources, ...draft.sourceRefs].map(source => [canonical(source), source]))
  return <><label>记录类型<select aria-label="新研究记录类型" value={draft.recordType} disabled={disabled || editing} onChange={event => onChange({ ...draft, recordType: event.target.value as HumanResearchRecordType })}>
    {humanResearchTypes.map(type => <option key={type} value={type} disabled={draft.selections.length > 0 && ['project-decision', 'research-policy'].includes(type)}>{humanResearchNames[type]}</option>)}</select></label>
    {governance && <><label>标题<input aria-label="研究治理标题" value={draft.title} maxLength={500} disabled={disabled} onChange={event => onChange({ ...draft, title: event.target.value })} /></label><p className="human-muted">用户记录的研究约定，不是事实证明、人类审阅签署或个人偏好。规则不会自动继承或执行。</p></>}
    {draft.recordType === 'research-note' && !editing && <label>笔记语义<select aria-label="研究笔记语义" value={draft.noteKind} disabled={disabled} onChange={event => onChange({ ...draft, noteKind: event.target.value as HumanResearchEditor['noteKind'] })}><option value="commentary">评论与理解</option><option value="hypothesis">待验证假设</option><option value="scratch">研究草记</option></select></label>}
    <label>{draft.recordType === 'open-question' ? '待研究的问题' : draft.recordType === 'project-decision' ? '决策内容' : draft.recordType === 'research-policy' ? '研究规则内容' : '研究笔记正文'}<textarea aria-label="人类研究完整正文" rows={5} value={draft.text} maxLength={humanResearchTextLimit(draft.recordType, editing)} disabled={disabled} onChange={event => onChange({ ...draft, text: event.target.value })} /></label>
    {governance && <label>理由（可选）<textarea aria-label="研究治理理由" value={draft.rationale} maxLength={8000} rows={3} disabled={disabled} onChange={event => onChange({ ...draft, rationale: event.target.value })} /></label>}
    {draft.recordType === 'research-policy' && <label>规则的声明范围<select aria-label="研究规则声明范围" value={draft.policyScope} disabled={disabled} onChange={event => onChange({ ...draft, policyScope: event.target.value as HumanResearchEditor['policyScope'] })}><option value="investigation">当前研究</option><option value="workspace">本工作区</option></select></label>}
    {!editing && <><div className="human-selections">{draft.selections.map((selection, index) => <div key={canonical(selection)} data-human-selection={index}><blockquote>{selection.quote}</blockquote><small>资料 {selection.documentId.slice(-10)} · 版本 {selection.revisionId.slice(-10)} · 第 {selection.physicalPage} 页 · 保存时重新核验</small><button disabled={disabled} onClick={() => onChange({ ...draft, selections: draft.selections.filter((_, item) => item !== index) })}>移除研究选区 {index + 1}</button></div>)}</div>
      <p className="human-muted">{draft.selections.length ? '选区与问题托盘独立；保存不会创建新的 Evidence。' : '自由记录默认无来源，不继承阅读器或下一问题的资料。'}</p>
      {sources.size > 0 && <details><summary>明确关联资料（可选，不改变提问）</summary>{[...sources].map(([key, source]) => <label className="human-check" key={key}><input type="checkbox" disabled={disabled} checked={draft.sourceRefs.some(item => canonical(item) === key)} onChange={event => onChange({ ...draft, sourceRefs: event.target.checked ? [...draft.sourceRefs, structuredClone(source)] : draft.sourceRefs.filter(item => canonical(item) !== key) })} />资料 {source.documentId} · 版本 {source.revisionId}</label>)}</details>}
    </>}
  </>
}
