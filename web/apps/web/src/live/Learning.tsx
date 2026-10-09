import { useEffect, useRef, useState } from 'react'
import type { CitationPresentation, ProductLearningCommand, ProductLearningGroup, ProductLearningOperation, ProductLearningView } from '@docatlas/contracts'
import { Drawer } from '../Drawer'
import type { LiveClient, LiveState } from './client'
import { ProbePresentations } from './ProbePresentations'
import { chooseProbeDraft, probeDraftReady, type ProbeChoiceDraft } from './probe-state'
import { acknowledgeLearning, activeLearningOffer, checkedLearningView, learningFrame, learningMaterialPin, learningOperationId, learningOwner,
  learningOwnerKey, learningReceiptMatches, learningStorageKey, readLearningPending, saveLearningPending,
  type LearningOutbox, type LearningOwner, type LearningPending } from './learning-state'
import './learning.css'

export interface LearningOpenRequest { id: number, owner: LearningOwner, messageId?: string }
type Client = Pick<LiveClient, 'state' | 'learningQuery' | 'learningCommand' | 'learningOperation'>
const modes = { explore: '探索研究', verify: '核验任务', publish: '发布任务' }
const effectName = (value: string) => value === 'evidence-first' ? '完整证据优先' : '完整回答优先'

/** Quiet invitation rendering and explicit contribution only. This component never writes on mount/refresh/close. */
export function LiveLearning({ client, state, openRequest, onCitation }: {
  client: Client, state: LiveState, openRequest?: LearningOpenRequest | undefined,
  onCitation(messageId: string, citation: CitationPresentation): Promise<void>,
}) {
  const owner = learningOwner(state), stamp = owner ? learningOwnerKey(owner) : ''
  const active = useRef(stamp); active.current = stamp
  const epoch = useRef(0), sequence = useRef(0), focusSequence = useRef(0), busy = useRef(false), seen = useRef(0)
  const [contextStamp, setContextStamp] = useState(stamp), [open, setOpen] = useState(false), [view, setView] = useState<ProductLearningView | null>(null), [messageId, setMessageId] = useState('')
  const viewRef = useRef(view); viewRef.current = view
  const profileEpoch = useRef<number | null>(null)
  const target = useRef(messageId); target.current = messageId
  const [outbox, setOutbox] = useState<LearningOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false)
  const [loading, setLoading] = useState(false), [writing, setWriting] = useState(false), [notice, setNotice] = useState(''), [settingDraft, setSettingDraft] = useState<boolean | undefined>()
  const [selected, setSelected] = useState<string | null>(null), [scope, setScope] = useState<'turn' | 'workspace'>('turn'), [last, setLast] = useState<ProductLearningOperation | null>(null)
  const [hiddenOffers, setHiddenOffers] = useState<Set<string>>(() => new Set())
  const messages = [...new Map([...(state.snapshot?.history.messages ?? []), ...(state.history.loaded ? state.history.messages : [])].filter(item => item.role === 'assistant' && item.text.trim()
    && !item.truncated && (!item.origin || item.origin.conversationId === state.selected)).map(item => [item.entryId, item])).values()]
  const completed = (state.snapshot?.runs ?? []).filter(run => run.receipt.state === 'completed').map(run => `${run.receipt.submissionId}:${run.receipt.version}`).join('|')
  const current = (token: number) => {
    const value = learningOwner(client.state())
    return token === epoch.current && active.current === stamp && !!value && learningOwnerKey(value) === stamp
  }
  function restore() {
    if (!owner) return
    try { setOutbox(readLearningPending(sessionStorage, owner)); setStorageBlocked(false) }
    catch { setStorageBlocked(true); setNotice('不能读取本标签页的学习待办；不会生成新的操作键。') }
  }
  async function load(id = target.current) {
    if (!owner) return
    const token = epoch.current, serial = ++sequence.current
    setLoading(true)
    if ((id || null) !== viewRef.current?.messageId) { viewRef.current = null; setView(null) }
    try {
      const result = await checkedLearningView(owner, await client.learningQuery(owner.conversationId, { ...learningFrame(owner), kind: 'learning-query', ...(id ? { messageId: id } : {}) }))
      if (!current(token) || serial !== sequence.current) return
      if (profileEpoch.current !== null && profileEpoch.current !== result.profileEpoch) { setLast(null); setSelected(null); setScope('turn'); setSettingDraft(undefined) }
      profileEpoch.current = result.profileEpoch
      viewRef.current = result; setView(result)
    } catch { if (current(token) && serial === sequence.current) { viewRef.current = null; setView(null); setNotice('学习状态或完整来源暂不可核对；没有过滤不可访问的相反选择，也未生成新比较。') } }
    finally { if (current(token) && serial === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    epoch.current++; sequence.current++; focusSequence.current++; busy.current = false
    setContextStamp(stamp)
    setOpen(false); setView(null); viewRef.current = null; profileEpoch.current = null; setMessageId(''); target.current = ''; setSelected(null); setScope('turn'); setLast(null)
    setLoading(false); setWriting(false); setNotice(''); setSettingDraft(undefined); setHiddenOffers(new Set()); restore()
    return () => { epoch.current++; sequence.current++; focusSequence.current++ }
  }, [stamp])
  // Read-only refresh sees invitations already created by the host's durable completion hook.
  useEffect(() => { if (owner) void load() }, [stamp, completed])
  useEffect(() => {
    if (!openRequest || !owner || seen.current === openRequest.id) return
    seen.current = openRequest.id
    if (learningOwnerKey(openRequest.owner) !== stamp) return
    const id = openRequest.messageId ?? ''; target.current = id; setMessageId(id); setSelected(null); setScope('turn'); setOpen(true); void load(id)
  }, [openRequest, stamp])
  const blocked = !owner || !view || loading || writing || storageBlocked || outbox.state !== 'empty'
  async function accept(pending: LearningPending, result: ProductLearningOperation, token: number) {
    const stillCurrent = () => current(token) && profileEpoch.current === pending.profileEpoch
    if (!await acknowledgeLearning(sessionStorage, pending, result, stillCurrent) || !stillCurrent()) throw new Error('Learning original receipt mismatch')
    restore(); setLast(result); setSelected(null); setScope('turn')
    if (pending.request.action === 'configure') setSettingDraft(undefined)
    setNotice('已核对原键的持久回执。信号、待确认候选、已采用偏好与实际生成使用是不同状态。')
    await load()
  }
  async function commit(request?: ProductLearningCommand, queryOnly = false) {
    if (!owner || !view || busy.current || storageBlocked || outbox.state === 'invalid') return
    const token = epoch.current; busy.current = true; setWriting(true)
    try {
      let pending: LearningPending
      if (request) {
        if (outbox.state !== 'empty') return
        const material = request.action === 'prepare' || request.action === 'choose' ? view.comparison?.material : null
        if ((request.action === 'prepare' || request.action === 'choose') && (!material || request.materialHash !== material.materialHash)) throw new Error('Learning material changed before freezing')
        pending = { schemaVersion: 1, owner: { ...owner }, profileId: view.profileId, profileEpoch: view.profileEpoch, request: structuredClone(request),
          material: material ? await learningMaterialPin(view.profileId, view.profileEpoch, material) : null }
        if (!current(token) || profileEpoch.current !== pending.profileEpoch) return
        saveLearningPending(sessionStorage, pending); restore()
      } else {
        if (outbox.state !== 'pending') return
        pending = structuredClone(outbox.value)
        const id = await learningOperationId(pending.owner, pending.request.idempotencyKey)
        if (!current(token)) return
        const result = await client.learningOperation(owner.conversationId, id)
        if (!current(token)) return
        if (result.receipt) { if (!await learningReceiptMatches(pending, result)) throw new Error('Original learning receipt changed'); await accept(pending, result, token); return }
        if (queryOnly || learningOwnerKey(pending.owner) !== stamp || pending.profileEpoch !== view.profileEpoch) {
          setNotice('没有匹配的原回执；待办仍保留。不会跨画像代际重发，也不将未查到当成未执行证明。'); return
        }
      }
      if (!current(token) || pending.profileEpoch !== view.profileEpoch) return
      const result = await client.learningCommand(owner.conversationId, pending.request)
      if (current(token)) await accept(pending, result, token)
    } catch { if (current(token)) { restore(); setNotice('学习操作尚未确认，或来源/设置/候选版本已变化。完整原请求仍保留；只读核对或显式原键重试。') } }
    finally { if (current(token)) { busy.current = false; setWriting(false) } }
  }
  function base() { return { ...learningFrame(owner!), kind: 'learning-command' as const, expectedProfileEpoch: view!.profileEpoch, idempotencyKey: `learning:${crypto.randomUUID()}` } }
  function dismiss(offer: ProductLearningView['offers'][number]) {
    if (blocked) return
    setHiddenOffers(values => new Set([...values, offer.offerId]))
    void commit({ ...base(), action: 'dismiss', offerId: offer.offerId, expectedOfferVersion: offer.version })
  }
  function prepare() {
    if (blocked || !view?.contributionAllowed || !view.comparison?.material) return
    void commit({ ...base(), action: 'prepare', expectedPolicyVersion: view.policyVersion, messageId: view.messageId!, materialHash: view.comparison.material.materialHash })
  }
  function choose() {
    const comparison = view?.comparison
    if (blocked || !view?.contributionAllowed || !comparison?.material || !comparison.probe || comparison.choiceReceipt
      || !probeDraftReady({ selected, scopeIntent: scope }, comparison.probe.presentationOrder, 'enabled')) return
    void commit({ ...base(), action: 'choose', expectedPolicyVersion: view.policyVersion, messageId: view.messageId!, materialHash: comparison.material.materialHash,
      probeId: comparison.probe.probeId, selected: selected!, scopeIntent: scope, reasonTags: [] })
  }
  function review(group: ProductLearningGroup, decision: 'accept' | 'reject') {
    if (blocked || group.status !== 'candidate' || !group.candidate || !group.digest) return
    void commit({ ...base(), action: 'review', groupId: group.groupId, candidateId: group.candidate.candidateId,
      expectedCandidateVersion: group.candidate.version, expectedGroupDigest: group.digest, decision })
  }
  async function focus(citation: CitationPresentation) {
    if (!owner || !view?.messageId || blocked || citation.verificationStatus !== 'read-verified') return
    const token = epoch.current, serial = ++focusSequence.current
    try { await onCitation(view.messageId, citation); if (current(token) && serial === focusSequence.current) setOpen(false) }
    catch { if (current(token) && serial === focusSequence.current) setNotice('原始 PDF 暂不可核对；未使用另一版本替代。') }
  }
  function discard() {
    if (!owner || writing || outbox.state === 'empty' || !window.confirm('只清除本标签页学习待办，不撤销服务端可能保存的信号或偏好。继续？')) return
    const key = learningStorageKey(owner)
    try { if (sessionStorage.getItem(key) !== outbox.raw) { restore(); return }; sessionStorage.removeItem(key); restore() } catch { setNotice('本地学习待办未清除。') }
  }
  const pendingDismiss = outbox.state === 'pending' && outbox.value.request.action === 'dismiss' ? outbox.value.request.offerId : null
  const offer = activeLearningOffer(state, view, hiddenOffers, pendingDismiss)
  const comparison = view?.comparison
  if (!owner || contextStamp !== stamp) return null
  return <>{offer && !open && <aside className="learning-invitation" aria-label="可选阅读顺序比较邀请" data-learning-offer={offer.offerId}><span>愿意比较这份已保存回答的阅读顺序吗？不会再调用模型。</span>
    <button className="text-action" disabled={blocked} onClick={() => { target.current = offer.original.messageId; setMessageId(offer.original.messageId); setOpen(true); void load(offer.original.messageId) }}>比较阅读顺序</button>
    <button className="text-action" disabled={blocked} onClick={() => dismiss(offer)}>不再显示这次邀请</button></aside>}
    {open && owner && <Drawer title="偏好学习" subtitle="只积累明确允许未来使用的选择；任何偏好都需要另行确认。" onClose={() => { focusSequence.current++; setOpen(false) }}><div className="live-learning">
      <p className="learning-muted">浏览、滚动、关闭或忽略提示都不表示喜欢。默认不提示，不分析文档或笔记正文来推断个人特征。</p>
      {notice && <p role="status" className="learning-notice">{notice}</p>}
      <button className="text-action" disabled={writing || loading} onClick={() => { restore(); void load() }}>刷新学习状态（只读）</button>
      {outbox.state !== 'empty' && <section aria-label="待核对的学习操作" className="learning-notice"><h3>原学习操作仍保留</h3>
        {outbox.state === 'pending' ? <><code>{outbox.value.request.idempotencyKey}</code><p>只读核对不会重新记录选择，也不会把早期空候选回执改成后来的候选。</p>
          <button disabled={writing} onClick={() => void commit(undefined, true)}>只读核对原学习操作</button>
          <button disabled={writing || !outbox.current || !view || outbox.value.profileEpoch !== view.profileEpoch} onClick={() => void commit()}>使用原键重试学习操作</button></> : <p>旧学习待办无法校验，不会修补成新请求。</p>}
        <button disabled={writing} onClick={discard}>仅清除本地学习待办</button></section>}
      {last?.receipt && <p role="status" data-learning-receipt={last.operationId}>原操作已保存 · {last.receipt.action} · v{last.receipt.targetVersion}{last.receipt.memoryVersionId ? '。已明确采用；实际使用仍需独立许可与真实生成记录。' : '。本回执不代表偏好已经生效。'}</p>}
      {view && <>
        <section aria-label="学习提示许可"><h3>偶尔建议比较</h3><label className="learning-check"><input type="checkbox" disabled={blocked} checked={settingDraft ?? view.settings.enabled} onChange={event => setSettingDraft(event.target.checked)} />允许偶尔建议阅读比较</label>
          <p className="learning-muted">独立默认关闭。开启不会打开贡献或使用开关；每项研究最多一次自动邀请，并有工作区画像10分钟冷却。邀请记录不是已观看证明。</p>
          <button disabled={blocked || settingDraft === undefined || settingDraft === view.settings.enabled} onClick={() => void commit({ ...base(), action: 'configure', expectedSettingsVersion: view.settings.version, enabled: settingDraft! })}>保存学习提示设置</button>
          <p>{view.contributionAllowed ? '本会话允许为未来偏好积累明确选择。' : '本会话尚未允许积累信号；请在「偏好」明确开启后再比较。'}使用已有偏好仍是另一个开关。</p>
        </section>
        <section aria-label="手动学习比较"><h3>主动比较一份已保存回答</h3><label>原始回答<select aria-label="用于学习比较的已保存回答" value={messageId} disabled={blocked} onChange={event => {
          const id = event.target.value; target.current = id; setMessageId(id); setSelected(null); setScope('turn'); void load(id)
        }}><option value="">选择原始回答</option>{messages.map(message => <option key={message.entryId} value={message.entryId}>{message.text.slice(0, 90)}</option>)}</select></label>
          {comparison && comparison.reason !== 'ready' && <p>这份原回答当前不适合完整比较：{comparison.reason}。正常阅读不受影响。</p>}
          {comparison?.material && !comparison.probe && <button disabled={blocked || !view.contributionAllowed} onClick={prepare}>准备这次学习比较</button>}
          {comparison?.material && comparison.probe && <>
            <ProbePresentations manifest={comparison.material.manifest} variants={comparison.probe.variants} presentationOrder={comparison.probe.presentationOrder} busy={blocked} onCitation={citation => void focus(citation)} />
            {comparison.choiceReceipt ? <section aria-label="已记录的学习信号"><p>本次选择已记录，不会自动生效。</p><p>{comparison.choiceReceipt.candidateId ? '本次原回执关联一个待确认候选。' : '本次原回执没有候选；之后的积累不会改写它。'}</p></section>
              : <LearningChoiceControls draft={{ selected, scopeIntent: scope }} presentationOrder={comparison.probe.presentationOrder}
                  contribution={view.contributionAllowed ? 'enabled' : 'disabled'} busy={blocked}
                  onChange={draft => { setSelected(draft.selected); setScope(draft.scopeIntent) }} onConfirm={choose} />}
          </>}
        </section>
        <section aria-label="跨研究学习积累"><h3>按任务模式分别积累</h3>{view.groups.map(group => <article className="learning-group" key={group.groupId} data-learning-group={group.groupId} data-learning-status={group.status}>
          <h4>{modes[group.mode]}</h4>{group.status === 'unavailable' ? <p>完整来源不可核对，不能显示部分计数或确认候选。</p> : group.status === 'suppressed' ? <p>已有偏好或已处理的学习组；不会循环利用旧选择形成新候选。</p> : <>
            <p>独立研究 {group.counts?.independentInvestigations ?? 0} 项 · 完整回答优先 {group.counts?.conclusionFirst ?? 0} · 完整证据优先 {group.counts?.evidenceFirst ?? 0}</p>
            {group.status === 'conflicted' && <p>存在相反选择，不能通过隐藏它们来确认偏好。</p>}
            {group.status === 'collecting' && <p>仍在积累，没有生效偏好。</p>}
            {group.status === 'candidate' && group.candidate && <><p>待确认候选：{effectName(group.candidate.proposedEffect.value)}。采纳为工作区默认不代表其他任务模式也更适合。</p>
              <p className="learning-muted">确认可能停止正在使用旧偏好的生成；不会自动重问。之后应用仍取决于「允许使用已有偏好」。</p>
              <button disabled={blocked} onClick={() => review(group, 'accept')}>单独确认工作区默认顺序</button><button disabled={blocked} onClick={() => review(group, 'reject')}>不采纳这个学习候选</button></>}
          </>}</article>)}</section>
      </>}
      <button className="text-action" onClick={() => setOpen(false)}>关闭且不记录新选择</button>
    </div></Drawer>}
  </>
}

/** Pure controls over the currently verified comparison. Rendering or selecting
 * never commits; a human confirmation is still required by the parent outbox. */
export function LearningChoiceControls({ draft, presentationOrder, contribution, busy, onChange, onConfirm }: {
  draft: ProbeChoiceDraft, presentationOrder: readonly string[], contribution: 'enabled' | 'disabled' | 'unavailable', busy: boolean,
  onChange(draft: ProbeChoiceDraft): void, onConfirm(): void,
}) {
  const choices = [...presentationOrder.map((key, index) => [key, `学习呈现 ${index === 0 ? 'A' : 'B'} 更合适`] as const),
    ['both', '两种都可以'], ['neither', '两种都不适合'], ['dismissed', '明确记录本次跳过']] as const
  const disabled = busy || contribution !== 'enabled'
  return <section aria-label="明确的未来学习选择">
    <fieldset disabled={disabled}><legend>只选择真正更便于理解与核验的顺序</legend>
      {choices.map(([key, label]) => <label className="learning-check" key={key}>
        <input type="radio" name="learning-choice" checked={draft.selected === key} onChange={() => onChange(chooseProbeDraft(draft, key, presentationOrder))} />{label}
      </label>)}
    </fieldset>
    <label>积累范围<select aria-label="学习选择作用范围" disabled={disabled || !draft.selected || !presentationOrder.includes(draft.selected)} value={draft.scopeIntent}
      onChange={event => onChange({ ...draft, scopeIntent: event.target.value as ProbeChoiceDraft['scopeIntent'] })}>
      <option value="turn">仅本次比较</option><option value="workspace">明确允许用于未来工作区偏好学习</option>
    </select></label>
    <p className="learning-muted">至少三个独立研究选择相同顺序、且没有相反选择，才形成候选；这不是统计置信度，仍须单独确认。</p>
    <button type="button" disabled={disabled || !probeDraftReady(draft, presentationOrder, contribution)} onClick={onConfirm}>
      {draft.scopeIntent === 'workspace' ? '记录为未来学习信号' : '仅记录本次选择'}
    </button>
  </section>
}
