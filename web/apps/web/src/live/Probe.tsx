import { useEffect, useRef, useState } from 'react'
import type { AnswerManifest, AnswerManifestWarning, CitationPresentation, ProductProbeChoose, ProductProbeChoiceResult, ProductProbeInspect, ProductProbePrepare, ProductProbeReview, ProductProbeReviewResult, ProductProbeView } from '@docatlas/contracts'
import { Drawer } from '../Drawer'
import { LiveAnswerBody } from './Answers'
import type { LiveState } from './client'
import { acknowledgeProbe, blankProbeChoice, checkedProbeView, chooseProbeDraft, probeAnswerOwner, probeAnswerOwnerKey, probeAnswerPin, probeCandidatePin, probeDraftReady, probeOwnerKey, probePresentations, readProbeOutbox, saveProbePending,
  type ProbeChoiceDraft, type ProbeOutbox, type ProbeOwner, type ProbePending, type ProbePresentation, type ProbeVariantInput } from './probe-state'
import { canonical } from './state'
import './probe.css'

const relationNames = { support: '支持', refute: '反驳', qualify: '限定' }
const warningNames: Record<AnswerManifestWarning, string> = {
  'unclassified-text': '含尚未分类的文本', 'unknown-locator': '含无法识别的出处', 'malformed-marker': '含格式不完整的引用标记',
  'scope-conflict': '存在来源范围冲突', 'locator-without-text': '部分出处没有已读取的文字', 'limit-exceeded': '原回答映射触及上限，不能视为资料完备',
}
export interface ProbeOpenRequest { id: number, messageId: string }
interface ProbeClient {
  state(): LiveState
  probeInspect(conversationId: string, request: ProductProbeInspect): Promise<ProductProbeView>
  probePrepare(conversationId: string, request: ProductProbePrepare): Promise<ProductProbeView>
  probeChoose(conversationId: string, request: ProductProbeChoose): Promise<ProductProbeChoiceResult>
  probeReview(conversationId: string, request: ProductProbeReview): Promise<ProductProbeReviewResult>
}
const reasonNames = { 'faster-understanding': '理解更快', 'easier-verification': '核验更容易', 'better-deliverable': '更便于使用研究结果', 'less-cognitive-load': '阅读负担更小' }
const choiceLabel = (view: ProductProbeView, selected: string) => selected === 'both' ? '两种都可以' : selected === 'neither' ? '两种都不适合' : selected === 'dismissed' ? '明确跳过'
  : `呈现 ${view.probe?.presentationOrder.indexOf(selected) === 0 ? 'A' : 'B'}`

export function LiveProbe({ client, state, openRequest, onCitation }: { client: ProbeClient, state: LiveState, openRequest?: ProbeOpenRequest | undefined, onCitation(messageId: string, citation: CitationPresentation): Promise<void> }) {
  const identity = probeAnswerOwner(state, openRequest?.messageId ?? ''), stamp = identity ? probeAnswerOwnerKey(identity) : ''
  const activeStamp = useRef(stamp); activeStamp.current = stamp
  const [contextStamp, setContextStamp] = useState(''), [open, setOpen] = useState(false), [view, setView] = useState<ProductProbeView | null>(null), [verified, setVerified] = useState(false)
  const [draft, setDraft] = useState<ProbeChoiceDraft>(blankProbeChoice), [reasonTags, setReasonTags] = useState<ProductProbeChoose['reasonTags']>([])
  const [outbox, setOutbox] = useState<ProbeOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false)
  const [loading, setLoading] = useState(false), [writing, setWriting] = useState(false), [focusing, setFocusing] = useState(false), [notice, setNotice] = useState(''), [reviewResult, setReviewResult] = useState<ProductProbeReviewResult | null>(null)
  const epoch = useRef(0), sequence = useRef(0), focusSequence = useRef(0), busy = useRef(false), seen = useRef<number | undefined>(undefined)
  const ownerFor = (value: ProductProbeView | null): ProbeOwner | null => identity && value?.probe ? { ...identity, probeId: value.probe.probeId, profileId: value.probe.profileId, profileEpoch: value.profileEpoch } : null
  const owner = ownerFor(view), ownerRef = useRef(owner); ownerRef.current = owner
  const current = (token: number) => {
    const active = probeAnswerOwner(client.state(), identity?.messageId ?? '')
    return token === epoch.current && !!stamp && activeStamp.current === stamp && active !== null && probeAnswerOwnerKey(active) === stamp
  }
  function restore(value = view): ProbeOutbox {
    if (!identity) return { state: 'empty' }
    try { const restored = readProbeOutbox(sessionStorage, identity, ownerFor(value)); setOutbox(restored); setStorageBlocked(false); return restored }
    catch { setStorageBlocked(true); setNotice('无法读取标签页的原选择待办，已暂停提交；不会生成另一操作键。'); return { state: 'empty' } }
  }
  useEffect(() => {
    epoch.current++; sequence.current++; focusSequence.current++; busy.current = false
    setContextStamp(stamp); setOpen(false); setView(null); setVerified(false); setDraft(blankProbeChoice()); setReasonTags([]); setOutbox({ state: 'empty' }); setStorageBlocked(false)
    setLoading(false); setWriting(false); setFocusing(false); setNotice(''); setReviewResult(null); restore(null)
    return () => { epoch.current++; sequence.current++; focusSequence.current++ }
  }, [stamp])
  async function load() {
    if (!identity) return
    const token = epoch.current, serial = ++sequence.current; focusSequence.current++; setFocusing(false); setLoading(true); setVerified(false)
    try {
      const value = await checkedProbeView(identity, await client.probeInspect(identity.conversationId, { schemaVersion: 1, kind: 'probe-inspect', expectedGeneration: identity.generation, messageId: identity.messageId }))
      if (!current(token) || serial !== sequence.current) return
      const nextOwner = ownerFor(value), previousOwner = ownerRef.current
      if (previousOwner && (!nextOwner || probeOwnerKey(previousOwner) !== probeOwnerKey(nextOwner))) { setDraft(blankProbeChoice()); setReasonTags([]); setReviewResult(null) }
      setView(value); ownerRef.current = nextOwner; setVerified(true)
      const pending = restore(value)
      if (pending.state === 'pending' && pending.current && pending.value.request.kind === 'probe-choose' && value.choiceReceipt) {
        const acknowledged = await acknowledgeProbe(sessionStorage, pending.value, value, () => current(token) && serial === sequence.current && ownerRef.current !== null && probeOwnerKey(ownerRef.current) === probeOwnerKey(pending.value.owner))
        if (!current(token) || serial !== sequence.current) return
        if (acknowledged) { restore(value); setNotice('已从只读回执核对原选择。没有再次提交，也没有自动确认工作区偏好。') }
        else setNotice('服务端已有选择，但不能匹配此标签页的完整原请求。保留待办，不替换原键或改写已记录选择。')
      }
    } catch { if (current(token) && serial === sequence.current) setNotice('暂不能核对原回答、比较版本或当前贡献开关；未发起呈现实验，也没有记录选择。') }
    finally { if (current(token) && serial === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    if (!identity || !openRequest || seen.current === openRequest.id) return
    seen.current = openRequest.id; setOpen(true); void load()
  }, [stamp, openRequest?.id])
  const contribution = !verified || !view ? 'unavailable' : view.contributionAllowed ? 'enabled' : 'disabled'
  const blocked = loading || writing || focusing || !verified || storageBlocked || outbox.state !== 'empty'
  async function prepare() {
    if (!identity || !view?.material || view.probe || !view.contributionAllowed || blocked || busy.current) return
    const token = epoch.current, original = probeAnswerPin(view.material), expectedEpoch = view.profileEpoch
    busy.current = true; setWriting(true); focusSequence.current++
    try {
      const result = await client.probePrepare(identity.conversationId, { schemaVersion: 1, kind: 'probe-prepare', expectedGeneration: identity.generation, expectedProfileEpoch: view.profileEpoch, expectedPolicyVersion: view.policyVersion, messageId: identity.messageId })
      const value = await checkedProbeView(identity, result)
      if (!current(token)) return
      if (!value.probe || !value.material || value.profileEpoch !== expectedEpoch || canonical(probeAnswerPin(value.material)) !== canonical(original)) throw new Error('Prepared Probe retargeted the original Answer')
      setView(value); setVerified(true); ownerRef.current = ownerFor(value); restore(value); setNotice('两种呈现已准备；只重排已保存材料，没有生成第二个回答，也尚未记录任何选择。')
    } catch { if (current(token)) setNotice('准备结果尚未确认。可先刷新只读状态核对；再次明确准备仍针对同一原回答和画像代际，不生成随机比较键。') }
    finally { if (current(token)) { busy.current = false; setWriting(false) } }
  }
  async function commit(request?: ProductProbeChoose | ProductProbeReview) {
    if (!identity || !owner || !view?.probe || !view.material || busy.current || loading || !verified || storageBlocked || outbox.state === 'invalid') return
    const token = epoch.current, expectedOwner = probeOwnerKey(owner)
    let pending: ProbePending
    if (request) {
      if (outbox.state !== 'empty') return
      pending = { schemaVersion: 1, owner: { ...owner }, original: probeAnswerPin(view.material), variants: view.probe.variants.map(variant => ({ variantKey: variant.variantKey, effect: { ...variant.effect } })), presentationOrder: [...view.probe.presentationOrder],
        candidate: request.kind === 'probe-review' && view.candidate ? probeCandidatePin(view.candidate) : null, request }
    } else {
      if (outbox.state !== 'pending' || !outbox.current) return
      pending = outbox.value
      if (canonical(pending.original) !== canonical(probeAnswerPin(view.material))) { setNotice('当前原回答与冻结材料不一致；不会将旧操作转向新的回答。'); return }
    }
    if (pending.request.kind === 'probe-choose' && !view.contributionAllowed) { setNotice('贡献开关已关闭，不能再提交选择。刷新仍可只读核对已经保存的原回执。'); return }
    busy.current = true; setWriting(true); focusSequence.current++; setFocusing(false)
    const stillCurrent = () => current(token) && ownerRef.current !== null && probeOwnerKey(ownerRef.current) === expectedOwner
    try {
      if (request) { saveProbePending(sessionStorage, pending); restore() }
      const result = pending.request.kind === 'probe-choose' ? await client.probeChoose(identity.conversationId, pending.request) : await client.probeReview(identity.conversationId, pending.request)
      if (!stillCurrent()) return
      if (!await acknowledgeProbe(sessionStorage, pending, result, stillCurrent)) throw new Error('Probe receipt did not match the original operation')
      if (!stillCurrent()) return
      if (result.kind === 'probe-review-result') setReviewResult(result)
      restore(); setNotice(result.kind === 'probe-choice-result' ? '本次选择已保存。工作区候选仍需下方独立确认，不会自动成为生效偏好。' : '独立确认回执已保存；未来是否使用仍由会话开关、适用范围和生成记录决定。')
      await load()
    } catch { if (stillCurrent()) { restore(); setNotice('操作结果尚未确认或画像/策略/候选版本已变化。保留原请求和原键；刷新只读核对，明确原键重试不生成替代选择。') } }
    finally { if (current(token)) { busy.current = false; setWriting(false) } }
  }
  function choose() {
    if (!identity || !view?.probe || !owner || blocked || view.choiceReceipt || !probeDraftReady(draft, view.probe.presentationOrder, contribution)) return
    void commit({ schemaVersion: 1, kind: 'probe-choose', expectedGeneration: owner.generation, expectedProfileEpoch: owner.profileEpoch, expectedPolicyVersion: view.policyVersion,
      messageId: identity.messageId, probeId: owner.probeId, idempotencyKey: `probe-choice:${crypto.randomUUID()}`, selected: draft.selected!, scopeIntent: draft.scopeIntent, reasonTags: [...reasonTags] })
  }
  function review(decision: ProductProbeReview['decision']) {
    if (!owner || !view?.candidate || blocked || !['pending', 'needs-review'].includes(view.candidate.decision)) return
    void commit({ schemaVersion: 1, kind: 'probe-review', expectedGeneration: owner.generation, expectedProfileEpoch: owner.profileEpoch, messageId: owner.messageId, probeId: owner.probeId,
      candidateId: view.candidate.candidateId, expectedCandidateVersion: view.candidate.version, decision, idempotencyKey: `probe-review:${crypto.randomUUID()}` })
  }
  async function focus(citation: CitationPresentation) {
    if (!identity || !view?.material || !verified || writing || focusing || citation.verificationStatus !== 'read-verified') return
    const token = epoch.current, serial = ++focusSequence.current; setFocusing(true)
    try { await onCitation(identity.messageId, citation); if (current(token) && serial === focusSequence.current) setOpen(false) }
    catch { if (current(token) && serial === focusSequence.current) setNotice('原始 PDF 引用暂不能核对。未用 Markdown、另一版本或未核验线索替代。') }
    finally { if (current(token) && serial === focusSequence.current) setFocusing(false) }
  }
  const close = () => { focusSequence.current++; setFocusing(false); setOpen(false) }
  function discard() {
    if (outbox.state === 'empty' || busy.current || !window.confirm('只清除此标签页的原操作待办，不撤销已经保存的选择或偏好。继续？')) return
    try { sessionStorage.removeItem(outbox.key); restore(); setNotice('仅清除了本地待办。没有撤销服务端已有选择，也没有重发问题。') } catch { setNotice('本地待办未能清除。') }
  }
  if (!open || !identity || contextStamp !== stamp) return null
  return <Drawer title="比较两种呈现" subtitle="事实和原文不变，看看哪一种顺序更适合你。仅在主动选择后记录。" onClose={close}><div className="live-probe">
    {notice && <p className="probe-notice" role="status">{notice}</p>}
    <button className="text-action" disabled={loading || writing} onClick={() => void load()}>{loading ? '正在核对原材料…' : '刷新比较状态（只读）'}</button>
    {outbox.state !== 'empty' && <section className="probe-notice" aria-label="待核对的呈现操作"><h3>保留了一次原操作</h3>{outbox.state === 'pending' ? <><p>{outbox.value.request.kind === 'probe-choose' ? '选择记录' : '候选确认'} · 原回答 {outbox.value.owner.messageId} · 画像代际 {outbox.value.owner.profileEpoch}</p><code>{outbox.value.request.idempotencyKey}</code><details><summary>完整冻结请求</summary><pre>{JSON.stringify(outbox.value.request, null, 2)}</pre></details>{!outbox.current && <p>原操作属于另一会话、比较或画像代际，不能转向当前版本重试。</p>}<button className="secondary-button" disabled={loading || writing || !verified || !outbox.current || outbox.value.request.kind === 'probe-choose' && contribution !== 'enabled'} onClick={() => void commit()}>使用原键核对呈现操作</button></> : <p>旧待办无法校验，新的提交已暂停，未覆盖或自动修复。</p>}<button className="text-action" disabled={writing} onClick={discard}>仅清除本地待办</button></section>}
    {view && <>
      {view.reason !== 'ready' && <p className="probe-notice">{{ 'answer-unavailable': '此条已保存回答目前无法核对，不能创建比较。', 'no-evidence': '此回答没有已保存的真实证据，本批呈现比较不适用。', 'too-large': '这份原材料超过可完整对照的显示边界；不会截掉证据再比较。' }[view.reason]}</p>}
      {view.material && !view.probe && <section className="probe-introduction"><h3>只比较一种变量：阅读顺序</h3><p>一边先展示完整已保存回答，另一边先展示完整证据集合。没有第二次模型生成；字号、颜色和内容全部相同。</p><p className="probe-muted">需要当前会话明确允许积累偏好信号；准备呈现不会替你选择，也不创建生效偏好。</p><button className="primary-button" disabled={blocked || !view.contributionAllowed} onClick={() => void prepare()}>准备这份回答的两种呈现</button>{!view.contributionAllowed && <p className="probe-notice">贡献开关未开启。请关闭此面板后，在「偏好」中明确开启再刷新。</p>}</section>}
      {view.material && view.probe && <><ProbePresentations manifest={view.material.manifest} variants={view.probe.variants} presentationOrder={view.probe.presentationOrder} busy={loading || writing || focusing || !verified} onCitation={citation => void focus(citation)} />
        {view.choiceReceipt ? <section className="probe-recorded" aria-label="已保存的呈现选择"><h3>已记录：{choiceLabel(view, view.choiceReceipt.choice.selected)}</h3><p>{view.choiceReceipt.choice.scopeIntent === 'workspace' ? '工作区意向：只形成候选，未由选择本身自动生效。' : '仅本次比较，不推断长期偏好。'}</p><code>{view.choiceReceipt.choice.choiceObservationId}</code><p className="probe-muted">一个固定比较只记录一次选择；刷新不会重新选择或重发问题。</p></section>
          : <><fieldset className="probe-reasons" disabled={blocked || contribution !== 'enabled'}><legend>为什么这样选（可选）</legend>{Object.entries(reasonNames).map(([key, label]) => <label className="probe-radio" key={key}><input type="checkbox" checked={reasonTags.includes(key as ProductProbeChoose['reasonTags'][number])} onChange={event => setReasonTags(event.target.checked ? [...reasonTags, key as ProductProbeChoose['reasonTags'][number]] : reasonTags.filter(value => value !== key))} />{label}</label>)}</fieldset><ProbeChoiceControls draft={draft} presentationOrder={view.probe.presentationOrder} contribution={contribution} busy={blocked} onChange={setDraft} onConfirm={choose} onClose={close} /></>}
        {view.candidate && <section className="probe-candidate" aria-label="独立确认工作区偏好"><h3>工作区偏好候选 · v{view.candidate.version}</h3><p>{view.candidate.proposedEffect.value === 'conclusion-first' ? '完整回答优先，再看证据' : '完整证据优先，再看回答'}</p><p className="probe-muted">只适用于当前工作区。不改变事实和证据；确认后能否用于以后生成，仍受「允许使用已有偏好」开关和任务适用性约束。若已有同范围偏好，请在偏好中心编辑；这里不会自动覆盖。</p><code>{view.candidate.candidateId}</code>{['pending', 'needs-review'].includes(view.candidate.decision) ? <div className="probe-actions"><button className="primary-button" disabled={blocked} onClick={() => review('accept')}>单独确认此工作区偏好</button><button className="secondary-button" disabled={blocked} onClick={() => review('reject')}>不采纳此候选</button></div> : <p>{view.candidate.decision === 'promote' ? '此候选已单独确认；当前偏好状态请在「偏好」中核对。' : '此候选已拒绝，不能据此推断生效偏好。'}</p>}</section>}
      </>}
    </>}
    {reviewResult && <section className="probe-recorded" aria-label="候选确认的持久回执"><h3>独立确认操作已保存</h3><p>{reviewResult.result.candidate.decision === 'promote' ? '确认此候选' : '拒绝此候选'} · v{reviewResult.result.candidate.version}</p>{reviewResult.result.memoryVersion && <code>{reviewResult.result.memoryVersion.memoryVersionId}</code>}<p className="probe-muted">此回执不证明模型已经使用偏好；实际生成应用请查看「偏好」中的使用记录。</p></section>}
    <p className="probe-muted">比较由你主动开启。关闭、浏览原文或刷新不会暗中记作选择；已明确提交的原操作不会因关窗被撤销。</p>
  </div></Drawer>
}

/** Pure controlled comparison. No provider call, local randomization, preference mutation or hidden recording. */
export function ProbePresentations({ manifest, variants, presentationOrder, busy, onCitation }: {
  manifest: AnswerManifest, variants: readonly ProbeVariantInput[], presentationOrder: readonly string[], busy: boolean, onCitation(citation: CitationPresentation): void,
}) {
  const pair = probePresentations(manifest, variants, presentationOrder)
  return <div className="probe-presentations" role="group" aria-label="同一已保存回答的两种呈现">{pair.map(presentation => <ProbePresentationCard key={presentation.variantKey} presentation={presentation} busy={busy} onCitation={onCitation} />)}</div>
}

export function ProbePresentationCard({ presentation, busy, onCitation }: { presentation: ProbePresentation, busy: boolean, onCitation(citation: CitationPresentation): void }) {
  const { manifest } = presentation
  return <article className="probe-presentation" aria-label={`呈现 ${presentation.position}`} data-probe-position={presentation.position} data-probe-variant={presentation.variantKey} data-probe-manifest={manifest.manifestId}>
    <h3 className="probe-position">呈现 {presentation.position}</h3>
    <div className="probe-sections">{presentation.sections.map(section => section === 'answer'
      ? <section key="answer" className="probe-section" aria-label={`呈现 ${presentation.position} 的已保存回答`} data-probe-section="answer"><h4>已保存回答</h4><LiveAnswerBody manifest={manifest} busy={busy} onCitation={onCitation} /></section>
      : <section key="evidence" className="probe-section" aria-label={`呈现 ${presentation.position} 的完整证据集合`} data-probe-section="evidence"><h4>完整证据集合</h4><ProbeEvidenceCollection citations={manifest.citations} busy={busy} onCitation={onCitation} /><ProbeUncertainty manifest={manifest} /></section>)}</div>
  </article>
}

export function ProbeEvidenceCollection({ citations, busy, onCitation }: { citations: readonly CitationPresentation[], busy: boolean, onCitation(citation: CitationPresentation): void }) {
  return <div className="probe-evidence-collection"><p className="probe-muted">保留本回答的全部支持、反驳、限定和未核验定位线索；这些关系是 Agent 的判断，不代表事实已核验。</p>
    {!citations.length && <p className="probe-muted">此回答没有保存的出处；不会为比较生成或补写证据。</p>}
    {citations.map(citation => {
      const quote = citation.locator.selectors.find(selector => selector.type === 'text-quote')
      const verified = citation.verificationStatus === 'read-verified' && citation.evidence !== undefined
      return <article className="probe-evidence" key={citation.citationId} data-probe-citation={citation.citationId} data-probe-relation={citation.relation} data-probe-verification={citation.verificationStatus}>
        <header><strong>出处 {citation.ordinal} · {relationNames[citation.relation]}</strong><span>第 {citation.locator.physicalPage} 页</span></header>
        <p className="probe-evidence-text">{verified ? citation.evidence!.content.text : quote?.type === 'text-quote' ? quote.exact : '没有已读取的原文文字。'}</p>
        <small>文档 {citation.locator.documentId}<br />版本 {citation.locator.revisionId}</small>
        {verified ? <button type="button" className="text-action" disabled={busy} aria-label={`核对完整出处 ${citation.ordinal} · ${relationNames[citation.relation]} · 原始 PDF`} onClick={() => onCitation(citation)}>核对原始 PDF</button>
          : <p className="probe-weak">仅定位线索 · 尚未通过真实 Read 核验，不能当作已验证证据；不启用原文引用跳转。</p>}
      </article>
    })}
  </div>
}

export function ProbeUncertainty({ manifest }: { manifest: AnswerManifest }) {
  const summary = manifest.verificationSummary
  return <aside className="probe-uncertainty" aria-label="此回答的核验边界" data-probe-verification-summary={manifest.manifestId}>
    <p>事实段落 {summary.factualSegments} · 已映射 {summary.mappedFactualSegments} · 有支持 {summary.supportedSegments} · 有限定 {summary.qualifiedSegments} · 存在争议 {summary.contestedSegments} · 未解决 {summary.unresolvedSegments} · 未分类 {summary.unclassifiedSegments} · 出处 {summary.citationCount}</p>
    <p>{summary.complete ? '这份回答的出处映射完整；不代表语义结论或外部资料已穷尽核验。' : '这份回答的出处映射不完整；未解决、冲突和不确定内容原样保留。'}</p>
    {!!summary.warnings.length && <ul>{summary.warnings.map(warning => <li key={warning} data-probe-warning={warning}>{warningNames[warning]}</li>)}</ul>}
  </aside>
}

/** Confirmation is explicit. Merely changing a radio, opening the view or closing it never records a choice. */
export function ProbeChoiceControls({ draft, presentationOrder, contribution, busy, onChange, onConfirm, onClose }: {
  draft: ProbeChoiceDraft, presentationOrder: readonly string[], contribution: 'enabled' | 'disabled' | 'unavailable', busy: boolean,
  onChange(draft: ProbeChoiceDraft): void, onConfirm(): void, onClose(): void,
}) {
  const choices = [...presentationOrder.map((key, index) => [key, `更容易理解呈现 ${index === 0 ? 'A' : 'B'}`] as const), ['both', '两种都可以'], ['neither', '两种都不适合'], ['dismissed', '明确记录：本次跳过']] as const
  const variantSelected = draft.selected !== null && presentationOrder.includes(draft.selected)
  return <section className="probe-choice" aria-label="明确选择呈现方式"><h3>哪一种更便于你理解和核验？</h3><p className="probe-muted">同一份文字、证据和不确定性，只交换两个完整章节的顺序。不是两个独立回答。</p>
    {contribution !== 'enabled' && <p className="probe-notice">{contribution === 'disabled' ? '当前会话未允许积累偏好信号，选择不会记录。可在偏好设置中明确开启。' : '尚未核对当前会话的贡献开关，不能记录选择。'}</p>}
    <fieldset disabled={busy || contribution !== 'enabled'}><legend>你的选择</legend>{choices.map(([key, label]) => <label className="probe-radio" key={key}><input type="radio" name="probe-choice" checked={draft.selected === key} onChange={() => onChange(chooseProbeDraft(draft, key, presentationOrder))} />{label}</label>)}</fieldset>
    <label className="probe-scope">希望作用于<select aria-label="呈现选择作用范围" value={draft.scopeIntent} disabled={busy || contribution !== 'enabled' || !variantSelected} onChange={event => onChange({ ...draft, scopeIntent: event.target.value as ProbeChoiceDraft['scopeIntent'] })}><option value="turn">仅本次比较</option><option value="workspace">此工作区（待单独确认）</option></select></label>
    <p className="probe-muted">{draft.scopeIntent === 'workspace' ? '只形成待确认偏好候选。之后还需独立确认才会生效，不会一选就成为全局 Memory。' : '不会据此设置跨任务或全局偏好；“都可以”“都不适合”和“跳过”不推断长期倾向。'}</p>
    <div className="probe-actions"><button type="button" className="primary-button" disabled={busy || !probeDraftReady(draft, presentationOrder, contribution)} onClick={onConfirm}>{draft.scopeIntent === 'workspace' ? '记录为待确认候选' : '记录本次选择'}</button><button type="button" className="text-action" onClick={onClose}>关闭且不记录新选择</button></div>
  </section>
}
