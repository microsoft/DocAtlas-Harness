import { useEffect, useRef, useState } from 'react'
import type { ProductContinuityAssess, ProductContinuityAssessment, ProductContinuityImpact, ProductContinuityImpactResult, ProductContinuityInspect, ProductContinuityInspection, ProductReviewEvidence, ProductReviewFocus, ProductSourceRef } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { Drawer } from '../Drawer'
import type { LiveState } from './client'
import { acknowledgeContinuity, continuityOwner, continuityOwnerKey, continuityReadiness, continuityReadSources, continuitySourceKey, mergeContinuitySources, readContinuityOutbox, saveContinuityPending,
  type ContinuityOpenRequest, type ContinuityOutbox, type ContinuityPending } from './continuity-state'
import './continuity.css'

interface ContinuityClient {
  state(): LiveState
  setSources(sources: ProductSourceRef[]): void
  continuityInspect(conversationId: string, input: ProductContinuityInspect): Promise<ProductContinuityInspection>
  continuityImpact(conversationId: string, input: ProductContinuityImpact): Promise<ProductContinuityImpactResult>
  continuityAssess(conversationId: string, input: ProductContinuityAssess): Promise<ProductContinuityAssessment>
  reviewFocus(conversationId: string, scopeVersionId: string, evidenceId: string): Promise<ProductReviewFocus>
}
export const continuityStateNames = { continuing: '仍然适用', changed: '已有变化', conflicted: '存在冲突', unknown: '尚不能判断' }
const verificationNames = { reverified: '已按原文证据重新核验', 'needs-reverify': '仍需核验', 'missing-source': '原始来源不完整', 'outside-scope': '含范围外来源' }
const recordNames = { 'research-note': '研究笔记', 'open-question': '待研究问题', 'project-decision': '研究决策', 'research-policy': '研究规则', 'evidence-bookmark': '原文书签', 'claim-proposal': '结论提案', 'claim-version': '结论版本', 'artifact-brief': '简报成果', 'artifact-matrix': '对照表成果' }
const toggle = (values: string[], value: string, checked: boolean) => checked ? [...new Set([...values, value])] : values.filter(item => item !== value)

export function LiveContinuity({ client, state, openRequest, onFocus }: { client: ContinuityClient, state: LiveState, openRequest?: ContinuityOpenRequest | undefined, onFocus(focus: ProductReviewFocus): void }) {
  const owner = continuityOwner(state, openRequest?.recordId ?? ''), ownerStamp = owner ? continuityOwnerKey(owner) : ''
  const stamp = JSON.stringify([ownerStamp, openRequest?.recordVersion]), stampRef = useRef(stamp); stampRef.current = stamp
  const [contextStamp, setContextStamp] = useState('')
  const [open, setOpen] = useState(false), [inspection, setInspection] = useState<ProductContinuityInspection | null>(null), [scope, setScope] = useState('')
  const [sources, setSources] = useState<ProductSourceRef[]>([]), [priorIds, setPriorIds] = useState<string[]>([]), [currentIds, setCurrentIds] = useState<string[]>([])
  const [proposed, setProposed] = useState<ProductContinuityAssess['proposedState']>('unknown'), [rationale, setRationale] = useState('')
  const [loading, setLoading] = useState(false), [verified, setVerified] = useState(false), [writing, setWriting] = useState(false), [notice, setNotice] = useState('')
  const [outbox, setOutbox] = useState<ContinuityOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false)
  const [assessment, setAssessment] = useState<ProductContinuityAssessment | null>(null), [impact, setImpact] = useState<ProductContinuityImpactResult | null>(null)
  const [previousKey, setPreviousKey] = useState(''), [currentKey, setCurrentKey] = useState(''), [impactLoading, setImpactLoading] = useState(false)
  const epoch = useRef(0), sequence = useRef(0), focusSequence = useRef(0), impactSequence = useRef(0), busy = useRef(false), seenOpen = useRef<number | undefined>(undefined)
  const scopeRef = useRef(scope); scopeRef.current = scope
  const current = (token: number, expected = stamp) => {
    const active = continuityOwner(client.state(), owner?.recordId ?? '')
    return !!owner && token === epoch.current && expected === stampRef.current && active !== null && continuityOwnerKey(active) === ownerStamp
  }
  function restore() {
    if (!owner) return
    try { setOutbox(readContinuityOutbox(sessionStorage, owner)); setStorageBlocked(false) }
    catch { setStorageBlocked(true); setNotice('无法读取此标签页的待核对操作；没有发送判断。') }
  }
  useEffect(() => {
    epoch.current++; sequence.current++; focusSequence.current++; impactSequence.current++; busy.current = false
    setContextStamp(stamp)
    setOpen(false); setInspection(null); setScope(''); scopeRef.current = ''; setSources([]); setPriorIds([]); setCurrentIds([]); setProposed('unknown'); setRationale('')
    setLoading(false); setVerified(false); setWriting(false); setNotice(''); setOutbox({ state: 'empty' }); setStorageBlocked(false); setAssessment(null); setImpact(null); setPreviousKey(''); setCurrentKey(''); setImpactLoading(false); restore()
    return () => { epoch.current++; sequence.current++; focusSequence.current++; impactSequence.current++ }
  }, [stamp])
  async function load(requestedScope?: string) {
    if (!owner) return
    const token = epoch.current, request = ++sequence.current
    focusSequence.current++; impactSequence.current++; setImpact(null); setImpactLoading(false); setLoading(true); setVerified(false)
    try {
      const candidate = await client.continuityInspect(owner.conversationId, { schemaVersion: 1, kind: 'continuity-inspect', expectedGeneration: owner.generation, recordId: owner.recordId, ...(requestedScope ? { scopeVersionId: requestedScope } : {}) })
      if (!current(token) || request !== sequence.current) return
      const value = parseBrowserContract('product-continuity', candidate)
      if (value.kind !== 'continuity-inspection' || value.conversationId !== owner.conversationId || value.bindingId !== owner.bindingId || value.generation !== owner.generation || value.record.recordId !== owner.recordId
        || requestedScope && value.scopeVersionId !== requestedScope) throw new Error('Continuity inspection changed identity')
      setInspection(value); setVerified(true); restore()
      if (value.record.version !== openRequest?.recordVersion) setNotice('原记录版本已变化。此草稿不会转向新版本；请返回原记录读取最新保存版本，再重新进入。已发送的原键仍可单独核对。')
    } catch { if (current(token) && request === sequence.current) setNotice('无法核对这条记录或所选已完成回答范围。没有把旧笔记当作证据，也没有写入判断。') }
    finally { if (current(token) && request === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    if (!owner || !openRequest || seenOpen.current === openRequest.id) return
    seenOpen.current = openRequest.id; setOpen(true); void load(scopeRef.current || undefined)
  }, [stamp, openRequest?.id])
  const sameVersion = inspection?.record.version === openRequest?.recordVersion
  const blocked = loading || writing || !verified || !owner || !sameVersion || storageBlocked || outbox.state !== 'empty'
  const available = inspection ? continuityReadSources(inspection) : []
  const ready = inspection ? continuityReadiness(inspection, scope, sources, priorIds, currentIds) : { unknown: false, comparative: false }
  const priorKeys = new Set(inspection?.record.sources.map(continuitySourceKey)), currentKeys = new Set(sources.map(continuitySourceKey))
  const oldEvidence = inspection?.evidence.filter(item => priorKeys.has(continuitySourceKey(item))) ?? [], newEvidence = inspection?.evidence.filter(item => currentKeys.has(continuitySourceKey(item))) ?? []
  const previous = inspection?.record.sources.find(source => continuitySourceKey(source) === previousKey), currentSource = sources.find(source => continuitySourceKey(source) === currentKey)
  function chooseScope(value: string) {
    if (writing || outbox.state !== 'empty') return
    setScope(value); scopeRef.current = value; setSources([]); setPriorIds([]); setCurrentIds([]); setProposed('unknown'); setPreviousKey(''); setCurrentKey(''); setAssessment(null)
    void load(value || undefined)
  }
  function chooseSource(source: ProductSourceRef, selected: boolean) {
    if (selected && sources.length >= 32) { setNotice('一次判断最多明确选择 32 个来源；没有自动替换已选版本。'); return }
    setSources(selected ? mergeContinuitySources(sources, [source]) : sources.filter(value => continuitySourceKey(value) !== continuitySourceKey(source)))
    if (!selected) { setCurrentIds(currentIds.filter(id => !inspection?.evidence.some(item => item.evidenceId === id && continuitySourceKey(item) === continuitySourceKey(source)))); setCurrentKey(''); setImpact(null); impactSequence.current++ }
  }
  function addOriginals() {
    if (!owner || !inspection || !verified || !current(epoch.current)) return
    const active = client.state()
    if (active.request || active.sending) return
    try {
      client.setSources(mergeContinuitySources(active.sourceRefs, inspection.record.sources))
      setNotice('已将这些精确旧版本合并到提问来源，保留其他来源和问题草稿。尚未发送问题，也未自动成为已完成的阅读范围。')
    } catch { setNotice('无法合并旧来源，请检查提问是否正在发送或来源是否超限；没有替换其他来源。') }
  }
  async function focus(evidence: ProductReviewEvidence) {
    if (!owner || !inspection || !scope || !verified || inspection.scopeVersionId !== scope) return
    const token = epoch.current, request = ++focusSequence.current, requestedScope = scope
    try {
      const candidate = await client.reviewFocus(owner.conversationId, requestedScope, evidence.evidenceId)
      if (!current(token) || request !== focusSequence.current || scopeRef.current !== requestedScope) return
      const value = parseBrowserContract('product-review', candidate)
      if (value.kind !== 'review-focus' || value.conversationId !== owner.conversationId || value.scopeVersionId !== requestedScope || value.evidenceId !== evidence.evidenceId
        || value.locator.documentId !== evidence.documentId || value.locator.revisionId !== evidence.revisionId || value.physicalPage !== evidence.physicalPage) throw new Error('Continuity PDF target changed')
      onFocus(value); setOpen(false)
    } catch { if (current(token) && request === focusSequence.current) setNotice('原始 PDF 的此处证据暂不能核验；不会跳到另一版本或 Markdown。') }
  }
  async function inspectImpact() {
    if (!owner || !inspection || !previous || !currentSource || previous.documentId !== currentSource.documentId || previous.revisionId === currentSource.revisionId || blocked) return
    const token = epoch.current, request = ++impactSequence.current, recordVersion = inspection.record.version
    const command: ProductContinuityImpact = { schemaVersion: 1, kind: 'continuity-impact', expectedGeneration: owner.generation, recordId: owner.recordId,
      previousSource: { documentId: previous.documentId, revisionId: previous.revisionId }, currentSource: { ...currentSource } }
    setImpactLoading(true); setImpact(null)
    try {
      const candidate = await client.continuityImpact(owner.conversationId, command)
      if (!current(token) || request !== impactSequence.current) return
      const value = parseBrowserContract('product-continuity', candidate)
      if (value.kind !== 'continuity-impact-result' || value.conversationId !== owner.conversationId || value.bindingId !== owner.bindingId || value.generation !== owner.generation
        || value.recordId !== owner.recordId || value.recordVersion !== recordVersion || continuitySourceKey(value.previousSource) !== continuitySourceKey(command.previousSource)
        || continuitySourceKey(value.currentSource) !== continuitySourceKey(command.currentSource)) throw new Error('Continuity dependency context changed')
      setImpact(value)
    } catch { if (current(token) && request === impactSequence.current) setNotice('暂不能核对版本依赖；没有推断内容变化或修改判断。') }
    finally { if (current(token) && request === impactSequence.current) setImpactLoading(false) }
  }
  async function assess(reconcile = false) {
    if (!owner || busy.current || storageBlocked || outbox.state === 'invalid') return
    const token = epoch.current; let pending: ContinuityPending
    if (reconcile) {
      if (outbox.state !== 'pending' || !outbox.current) return
      pending = outbox.value
    } else {
      if (blocked || !inspection || !ready.unknown || proposed !== 'unknown' && !ready.comparative || !rationale.trim()) return
      pending = { schemaVersion: 1, owner: { ...owner }, record: structuredClone(inspection.record), request: { schemaVersion: 1, kind: 'continuity-assess', expectedGeneration: owner.generation,
        scopeVersionId: scope, priorRecordId: inspection.record.recordId, expectedPriorVersion: inspection.record.version, currentSources: structuredClone(sources), priorEvidenceIds: [...priorIds], currentEvidenceIds: [...currentIds],
        proposedState: proposed, rationale, idempotencyKey: `continuity:${crypto.randomUUID()}` } }
    }
    busy.current = true; setWriting(true); focusSequence.current++; impactSequence.current++; setImpactLoading(false)
    try {
      if (!reconcile) { saveContinuityPending(sessionStorage, pending); restore() }
      const result = await client.continuityAssess(owner.conversationId, pending.request)
      if (!current(token)) return
      if (!await acknowledgeContinuity(sessionStorage, pending, result, () => current(token))) throw new Error('Continuity receipt did not match the original request')
      if (!current(token)) return
      setAssessment(result); restore(); setNotice('已保存这次独立人工判断及版本钉选；没有重写旧记录，也没有学习个人偏好。')
    } catch { if (current(token)) { restore(); setNotice('判断结果尚未确认或原记录版本已变化。保留完整原请求和原键；刷新只读材料，只有你点击原键核对才会重试。') } }
    finally { if (current(token)) { busy.current = false; setWriting(false) } }
  }
  function discard() {
    if (busy.current || outbox.state === 'empty' || !window.confirm('仅清除这个标签页的待核对判断，不撤销服务端可能已经保存的记录。确认继续？')) return
    try { sessionStorage.removeItem(outbox.key); restore(); setNotice('仅清除了本地待办，没有删除或撤销服务端判断。') } catch { setNotice('浏览器未能清除本地待办。') }
  }
  // Effects reset drafts after an owner change; never render the previous owner's panel in that intervening frame.
  if (!open || !owner || contextStamp !== stamp) return null
  return <Drawer title="继续核验" subtitle="重新读取原文，再判断旧研究是否仍然适用；旧笔记本身不是新证据。" onClose={() => { focusSequence.current++; setOpen(false) }}><div className="live-continuity">
    {notice && <p className="continuity-notice" role="status">{notice}</p>}
    {outbox.state !== 'empty' && <section className="continuity-pending" aria-label="待核对的连续研究判断"><h3>这次判断尚待核对</h3>{outbox.state === 'pending' ? <><p>原记录 v{outbox.value.record.version} · {outbox.value.record.recordId}</p><p>原范围 {outbox.value.request.scopeVersionId}</p><code>{outbox.value.request.idempotencyKey}</code><details><summary>查看完整冻结请求</summary><pre>{JSON.stringify(outbox.value.request, null, 2)}</pre></details><button className="secondary-button" disabled={writing || !outbox.current} onClick={() => void assess(true)}>用原键核对这次判断</button>{!outbox.current && <p>会话代际已变化，不能将旧请求转向当前会话。</p>}</> : <p>本地记录无法校验，新的写入已暂停；不会自动覆盖。</p>}<button className="text-action" disabled={writing} onClick={discard}>仅清除本地待办</button></section>}
    {loading && <p role="status">正在读取已授权记录和真实阅读材料…</p>}
    <button className="text-action" disabled={loading || writing} onClick={() => void load(scope || undefined)}>刷新材料（不会提交判断）</button>
    {inspection && <>
      <section className="continuity-section" aria-label="原始研究记录"><h3>{recordNames[inspection.record.recordType]} · v{inspection.record.version}</h3><code>{inspection.record.recordId}</code>{sameVersion && openRequest?.label && <p className="continuity-label">{openRequest.label}</p>}<p className="continuity-muted">上方文字仅为已保存记录的提示，不是证据。原记录来源范围：{inspection.record.scopeVersionId}</p>
        <h4>原记录的全部来源引用</h4>{!inspection.record.sources.length && <p>原记录没有可用的来源引用。</p>}{inspection.record.sources.map(source => <p key={continuitySourceKey(source)}><strong>{source.name}</strong><small>{source.documentId} · {source.revisionId}</small></p>)}
        {!inspection.record.sourceReferencesComplete && <p className="continuity-notice">原始引用不完整，不能作比较性结论；这里只允许「尚不能判断」。</p>}
        <button className="secondary-button" disabled={!verified || !sameVersion || writing || state.sending || !!state.request || !inspection.record.sources.length} onClick={addOriginals}>将旧来源加入提问</button>
        <p className="continuity-muted">若要比较新旧版：到文档库的版本历史明确选择两版，让 Pi 读取两版原文并完成回答，再回来刷新材料。不会仅因版本较新就自动切换来源。</p>
      </section>
      <section className="continuity-section"><h3>选择这次重新阅读的范围</h3><label>已完成回答的来源范围<select aria-label="连续研究阅读范围" value={scope} disabled={loading || writing || outbox.state !== 'empty'} onChange={event => chooseScope(event.target.value)}><option value="">请明确选择一个已完成回答的范围</option>{inspection.scopeOptions.map(option => <option key={option.scopeVersionId} value={option.scopeVersionId}>范围 v{option.version} · {option.sourceCount} 个来源{option.current ? ' · 最近完成' : ''} · {option.scopeVersionId}</option>)}</select></label><p className="continuity-muted">「最近完成」只是显示提示，不会替你选择，也不代表新的来源自动获准。</p>
        {!inspection.scopeOptions.length && <p>尚无已完成的真实阅读范围。请先让 Pi 读取相关原文并完成回答。</p>}
        {'scopeOptionsTruncated' in inspection && inspection.scopeOptionsTruncated === true && <p className="continuity-muted">这里只列出有界的历史范围窗口，不代表完整回答历史；这不影响当前所选范围材料自身的完整性判断。</p>}
        {scope && <><h4>明确选择本次判断使用的来源</h4><p className="continuity-muted">下列版本来自此范围真实读取后保存的证据；不按文件名、ID 或新旧次序替你选择。</p>{available.map(source => <label className="continuity-check" key={continuitySourceKey(source)}><input type="checkbox" checked={currentKeys.has(continuitySourceKey(source))} disabled={blocked} onChange={event => chooseSource({ documentId: source.documentId, revisionId: source.revisionId }, event.target.checked)} /><span>{source.name}<small>{source.documentId} · {source.revisionId}</small></span></label>)}{!available.length && <p>此范围没有可用的已读来源；不能提交判断，连「尚不能判断」也需要明确本次来源。</p>}</>}
      </section>
      {scope && <><ContinuityEvidenceGroup title="旧侧：重新核对原记录的证据" evidence={oldEvidence} selected={priorIds} disabled={blocked} focusDisabled={!verified || loading || writing} onSelect={(id, checked) => setPriorIds(toggle(priorIds, id, checked))} onFocus={value => void focus(value)} />
        <ContinuityEvidenceGroup title="本次侧：用于比较的证据" evidence={newEvidence} selected={currentIds} disabled={blocked} focusDisabled={!verified || loading || writing} onSelect={(id, checked) => setCurrentIds(toggle(currentIds, id, checked))} onFocus={value => void focus(value)} />
        {inspection.truncated && <p className="continuity-notice">材料显示已截断，不能把它当作完整核验；目前仅允许「尚不能判断」。</p>}
        <details className="continuity-section"><summary>版本依赖检查（只读）</summary><p className="continuity-muted">只检查同一文档的两个不同版本是否影响旧记录的来源依赖。不是语义 diff，不会判定旧结论对错，也不会选择下方判断。</p><label>旧版本<select aria-label="依赖检查旧版本" value={previousKey} disabled={blocked || impactLoading} onChange={event => { setPreviousKey(event.target.value); setCurrentKey(''); setImpact(null); impactSequence.current++ }}><option value="">请选择原引用版本</option>{inspection.record.sources.map(source => <option key={continuitySourceKey(source)} value={continuitySourceKey(source)}>{source.name} · {source.revisionId}</option>)}</select></label><label>本次版本<select aria-label="依赖检查本次版本" value={currentKey} disabled={blocked || impactLoading} onChange={event => { setCurrentKey(event.target.value); setImpact(null); impactSequence.current++ }}><option value="">请选择同文档的不同已读版本</option>{sources.filter(source => previous && source.documentId === previous.documentId && source.revisionId !== previous.revisionId).map(source => <option key={continuitySourceKey(source)} value={continuitySourceKey(source)}>{source.documentId} · {source.revisionId}</option>)}</select></label><button className="secondary-button" disabled={blocked || impactLoading || !previous || !currentSource} onClick={() => void inspectImpact()}>{impactLoading ? '正在核对依赖…' : '检查版本依赖'}</button>{impact && <p role="status">{{ 'needs-reverify': '存在重新核验的依赖', unaffected: '未命中此版本依赖', 'missing-source': '缺少来源' }[impact.status]} · {impact.reason}（仅依赖检查）</p>}</details>
        <section className="continuity-section"><h3>保存独立人工判断</h3><p className="continuity-muted">这是你基于原文作出的研究判断。不会更改旧 Note / Claim / Artifact，也不会写入个人偏好。</p><label>判断<select aria-label="连续研究人工判断" value={proposed} disabled={blocked} onChange={event => setProposed(event.target.value as ProductContinuityAssess['proposedState'])}>{Object.entries(continuityStateNames).map(([value, label]) => <option key={value} value={value} disabled={value !== 'unknown' && !ready.comparative}>{label}</option>)}</select></label>
          {!ready.comparative && <p className="continuity-muted">比较判断需要完整原引用、未截断的材料，并且两侧所选证据覆盖各自每个来源。请补齐阅读；资料不足时可明确记录「尚不能判断」。</p>}
          <label>判断依据<textarea aria-label="连续研究判断依据" rows={4} maxLength={4000} value={rationale} disabled={blocked} onChange={event => setRationale(event.target.value)} placeholder="说明核对了什么、适用条件、变化或尚未解决的疑问。" /></label>
          <button className="primary-button" disabled={blocked || !ready.unknown || proposed !== 'unknown' && !ready.comparative || !rationale.trim()} onClick={() => void assess()}>{writing ? '正在保存…' : '保存这次人工判断'}</button>
        </section></>}
    </>}
    {assessment && <ContinuitySaved value={assessment} />}
    <p className="continuity-muted">真实业务交互初版，仍待视觉验收。没有自动学习、偏好实验或模拟判断。</p>
  </div></Drawer>
}

export function ContinuityEvidenceGroup({ title, evidence, selected, disabled, focusDisabled, onSelect, onFocus }: { title: string, evidence: ProductReviewEvidence[], selected: string[], disabled: boolean, focusDisabled: boolean, onSelect(id: string, checked: boolean): void, onFocus(value: ProductReviewEvidence): void }) {
  return <section className="continuity-section" aria-label={title}><h3>{title}</h3>{!evidence.length && <p className="continuity-muted">尚无可用证据。先读原文，再刷新；不以笔记正文填补。</p>}{evidence.map(item => <article className="continuity-evidence" key={item.evidenceId}><header><strong>{item.sourceName}</strong><span>第 {item.physicalPage} 页</span></header><p>{item.preview}</p><small>{item.revisionId} · {item.evidenceId}</small><div className="continuity-actions"><button className="text-action" disabled={focusDisabled} onClick={() => onFocus(item)}>核对原始 PDF</button><label className="continuity-check"><input type="checkbox" aria-label={`${title} ${item.evidenceId}`} disabled={disabled} checked={selected.includes(item.evidenceId)} onChange={event => onSelect(item.evidenceId, event.target.checked)} />用于此侧核验</label></div></article>)}</section>
}
export function ContinuitySaved({ value }: { value: ProductContinuityAssessment }) {
  const link = value.result.link
  return <section className="continuity-saved" aria-label="已保存的连续研究判断"><h3>{value.result.status === 'replayed' ? '已核对原判断' : '独立判断已保存'} · {continuityStateNames[link.state]}</h3><p>{verificationNames[link.verificationStatus]}</p><p>{link.rationale}</p><small>原记录 {link.priorRecordId} · 固定版本 v{link.priorRecordVersion}</small><small>核验范围 {link.scopeVersionId}</small><code>{link.continuityLinkId}</code><p className="continuity-muted">这是新保存的 ContinuityLink，不是对旧研究记录的覆盖。</p></section>
}
