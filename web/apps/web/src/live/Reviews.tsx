import { UiText, useUi } from './locale'
import { useEffect, useRef, useState } from 'react'
import type { ArtifactManifest, ClaimVersion, EvidenceRelationKind, ProductReviewCommand, ProductReviewFocus, ProductReviewResult, ProductReviewWorkspace, ReviewResult } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { Drawer } from '../Drawer'
import type { LiveState } from './client'
import { acknowledgeReview, artifactClaimUses, artifactReview, claimRevisionDraft, publishApproval, readReviewOutbox, reviewIdentity, reviewIdentityKey,
  reviewOwnerKey, saveReviewPending, type ClaimDraft, type ReviewOutbox, type ReviewOwner } from './review-state'
import './reviews.css'
import type { ContinuityTarget } from './continuity-state'
import { Icon } from '../icons'
import { ReviewRelationshipGraph } from './ReviewGraph'

interface ReviewClient {
  state(): LiveState
  reviewWorkspace(conversationId: string, scopeVersionId?: string): Promise<ProductReviewWorkspace>
  reviewCommand(conversationId: string, command: ProductReviewCommand): Promise<ProductReviewResult>
  reviewFocus(conversationId: string, scopeVersionId: string, evidenceId: string): Promise<ProductReviewFocus>
}
export interface ReviewOpenRequest { id: number, scopeVersionId: string, evidenceIds?: string[], claimVersionId?: string, artifactManifestId?: string }
type EvidencePreview = ProductReviewWorkspace['evidence'][number]
const relationNames: Record<EvidenceRelationKind, string> = { supports: '支持', refutes: '反驳', qualifies: '限定', contextualizes: '背景', defines: '定义', 'derived-input': '推导输入' }
const statusNames = { proposed: '待核实', supported: '已有支持', 'partially-supported': '部分支持', contested: '存在争议', contradicted: '被反驳', unresolved: '未解决', stale: '可能过时', withdrawn: '已撤回' }
const reviewNames = { unreviewed: '未审阅', accepted: '人工接受', 'needs-changes': '需要修改', rejected: '人工拒绝' }
const artifactNames = { draft: '草稿', published: '本地已发布', superseded: '已有后续版本', withdrawn: '已撤回' }
const useNames = { assertion: '事实断言', assumption: '假设', decision: '决策', 'external-knowledge': '外部知识', 'conflict-disclosure': '冲突披露' }
const blankClaim = (): ClaimDraft => ({ statement: '', basis: 'document-supported', epistemicStatus: 'proposed', reviewStatus: 'unreviewed', expectedClaimVersionId: null,
  evidenceRelations: [], derivation: { operation: 'extract', inputClaimVersionIds: [] } })

export function LiveReviews({ client, state, onFocus, openRequest, onContinue, onChanged }: { client: ReviewClient, state: LiveState, onFocus(focus: ProductReviewFocus): void, openRequest?: ReviewOpenRequest | undefined, onContinue?(target: ContinuityTarget): void, onChanged?(): void }) {
  const { t } = useUi()
  const identity = reviewIdentity(state), stamp = identity ? reviewIdentityKey(identity) : ''
  const [open, setOpen] = useState(false), [workspace, setWorkspace] = useState<ProductReviewWorkspace | null>(null)
  const [requestedScope, setRequestedScope] = useState<string | undefined>(), [view, setView] = useState<'claims' | 'artifacts' | 'graph'>('claims')
  const [loading, setLoading] = useState(false), [writing, setWriting] = useState(false), [notice, setNotice] = useState('')
  const [outbox, setOutbox] = useState<ReviewOutbox>({ state: 'empty' }), [storageBlocked, setStorageBlocked] = useState(false)
  const [draft, setDraft] = useState<ClaimDraft>(blankClaim), [artifactTitle, setArtifactTitle] = useState(''), [artifactKind, setArtifactKind] = useState<'brief' | 'matrix'>('brief')
  const [chosenClaims, setChosenClaims] = useState<Array<{ claimVersionId: string, useKind: keyof typeof useNames }>>([]), [artifactId, setArtifactId] = useState('')
  const [attested, setAttested] = useState(false), [rationale, setRationale] = useState('')
  const epoch = useRef(0), sequence = useRef(0), focusSequence = useRef(0), busy = useRef(false), seenOpenRequest = useRef<number | undefined>(undefined)
  const currentStamp = useRef(stamp), scopeRef = useRef(workspace?.scope?.scopeVersionId ?? null), editor = useRef<HTMLTextAreaElement>(null)
  currentStamp.current = stamp; scopeRef.current = workspace?.scope?.scopeVersionId ?? null
  const owner: ReviewOwner | null = identity && workspace?.scope && workspace.bindingId === identity.bindingId && workspace.generation === identity.generation
    ? { ...identity, scopeVersionId: workspace.scope.scopeVersionId } : null
  const blocked = loading || writing || !owner || storageBlocked || outbox.state !== 'empty'
  const artifact = workspace?.artifacts.find(value => value.artifactManifestId === artifactId), review = artifact && workspace ? artifactReview(workspace, artifact) : undefined
  const latestApproval = artifact && workspace ? publishApproval(workspace, artifact) : null
  const approval = latestApproval?.decision.decidedBy.actorId === identity?.actorId ? latestApproval : null
  const latestDecision = review && workspace ? workspace.decisions.filter(value => value.reviewResultId === review.reviewResultId).at(-1) : undefined
  const current = (token: number, expected = stamp) => { const active = reviewIdentity(client.state()); return token === epoch.current && expected === currentStamp.current && active !== null && reviewIdentityKey(active) === expected }

  function restore(scope = scopeRef.current) {
    if (!identity) return
    try { setOutbox(readReviewOutbox(sessionStorage, identity, scope)); setStorageBlocked(false) }
    catch { setStorageBlocked(true); setNotice('无法读取此标签页的待核对操作；未发送任何更改。') }
  }
  useEffect(() => {
    epoch.current++; sequence.current++; focusSequence.current++; busy.current = false
    setOpen(false); setWorkspace(null); setRequestedScope(undefined); setView('claims'); setLoading(false); setWriting(false); setNotice(''); setOutbox({ state: 'empty' }); setStorageBlocked(false)
    setDraft(blankClaim()); setChosenClaims([]); setArtifactTitle(''); setArtifactId(''); setAttested(false); setRationale(''); restore(null)
    return () => { epoch.current++; sequence.current++; focusSequence.current++ }
  }, [stamp])
  async function load(scope = requestedScope, evidenceIds?: string[], target?: ReviewOpenRequest) {
    if (!identity) return
    const token = epoch.current, request = ++sequence.current
    setLoading(true)
    try {
      const value = await client.reviewWorkspace(identity.conversationId, scope)
      if (!current(token) || request !== sequence.current) return
      if (value.kind !== 'review-workspace' || value.conversationId !== identity.conversationId || value.bindingId !== identity.bindingId || value.generation !== identity.generation || value.scope && value.scope.workspaceId !== identity.workspaceId
        || scope !== undefined && value.scope?.scopeVersionId !== scope) throw new Error('Review workspace changed')
      setWorkspace(value); setRequestedScope(value.scope?.scopeVersionId); restore(value.scope?.scopeVersionId ?? null)
      if (evidenceIds) {
        const included = [...new Set(evidenceIds)].filter(id => value.evidence.some(item => item.evidenceId === id))
        setDraft({ ...blankClaim(), evidenceRelations: included.map(evidenceId => ({ evidenceId, kind: 'supports', coverage: 'full' })) })
        if (included.length !== new Set(evidenceIds).size) setNotice('部分证据不在此可核对范围，未自动选入。请核对原文后继续。')
      }
      if (target?.artifactManifestId) {
        if (value.artifacts.some(item => item.artifactManifestId === target.artifactManifestId)) { setArtifactId(target.artifactManifestId); setAttested(false); setRationale(''); setView('artifacts') }
        else setNotice('该成果不在当前已加载的授权范围内。未替换成另一份成果。')
      }
      if (target?.claimVersionId) {
        if (value.claims.some(item => item.claimVersionId === target.claimVersionId)) requestAnimationFrame(() => {
          const element = [...document.querySelectorAll<HTMLElement>('[data-review-claim]')].find(item => item.dataset.reviewClaim === target.claimVersionId)
          element?.scrollIntoView({ block: 'center' }); element?.focus({ preventScroll: true })
        })
        else setNotice('该结论版本不在当前已加载的授权范围内。未替换成另一版本。')
      }
    } catch { if (current(token) && request === sequence.current) setNotice('审阅工作区尚不可用或范围已变化。未使用示例数据；旧记录与待核对操作保留。') }
    finally { if (current(token) && request === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    if (!openRequest || seenOpenRequest.current === openRequest.id || !identity || busy.current || writing) return
    seenOpenRequest.current = openRequest.id
    if (draft.statement.trim() && !window.confirm('已有未保存的结论草稿。用这次回答的证据开始新草稿？待核对请求和服务端记录不会改变。')) return
    setOpen(true); setView('claims'); setWorkspace(null); setRequestedScope(openRequest.scopeVersionId); setDraft(blankClaim()); setArtifactId('')
    void load(openRequest.scopeVersionId, openRequest.evidenceIds, openRequest)
  }, [openRequest?.id, stamp, writing])
  function changeScope(scope: string) {
    if (busy.current || loading || !scope || scope === workspace?.scope?.scopeVersionId) return
    if (draft.statement.trim() && !window.confirm('切换审阅范围将清空未保存的结论草稿；已保留的待核对请求不会改写，原生对话源范围不会改变。继续？')) return
    focusSequence.current++; setDraft(blankClaim()); setChosenClaims([]); setArtifactId(''); setArtifactTitle(''); setAttested(false); setRationale('')
    setWorkspace(null); setRequestedScope(scope); restore(scope); void load(scope)
  }
  async function focus(evidence: EvidencePreview) {
    if (!owner || !workspace) return
    const token = epoch.current, request = ++focusSequence.current, expected = reviewOwnerKey(owner)
    try {
      const value = await client.reviewFocus(owner.conversationId, owner.scopeVersionId, evidence.evidenceId)
      if (!current(token) || request !== focusSequence.current || !identity || reviewOwnerKey({ ...identity, scopeVersionId: scopeRef.current ?? '' }) !== expected) return
      if (value.evidenceId !== evidence.evidenceId || value.scopeVersionId !== owner.scopeVersionId || value.locator.documentId !== evidence.documentId
        || value.locator.revisionId !== evidence.revisionId || value.physicalPage !== evidence.physicalPage) throw new Error('Review evidence changed')
      onFocus(value); setOpen(false)
    } catch { if (current(token) && request === focusSequence.current) setNotice('原始 PDF 的证据位置暂不能核验，未跳到其他版本或用 Markdown 代替。') }
  }
  async function commit(fields?: Record<string, unknown>) {
    if (!owner || !workspace || busy.current || loading || storageBlocked || outbox.state === 'invalid') return
    const token = epoch.current, expectedOwner = reviewOwnerKey(owner)
    let pending = outbox.state === 'pending' ? outbox.value : undefined
    let sent = false
    if (pending && reviewOwnerKey(pending.owner) !== expectedOwner) { setNotice('待核对请求属于另一范围或会话代际；不会替换它的源范围或操作键。'); return }
    busy.current = true; setWriting(true); focusSequence.current++
    try {
      if (!pending) {
        if (!fields) return
        const command = parseBrowserContract('product-review', { ...fields, schemaVersion: 1, kind: 'review-command', expectedGeneration: owner.generation,
          scopeVersionId: owner.scopeVersionId, idempotencyKey: `review:${crypto.randomUUID()}` })
        if (command.kind !== 'review-command') throw new Error('Invalid review command')
        pending = { schemaVersion: 1, owner, request: command }
        saveReviewPending(sessionStorage, pending); restore(owner.scopeVersionId)
      }
      setNotice('正在核对操作的持久回执…')
      sent = true
      const result = await client.reviewCommand(owner.conversationId, pending.request)
      if (!current(token) || scopeRef.current !== owner.scopeVersionId) return
      if (!await acknowledgeReview(sessionStorage, pending, result)) throw new Error('Review receipt mismatch')
      onChanged?.()
      if (!current(token) || scopeRef.current !== owner.scopeVersionId) return
      setOutbox({ state: 'empty' }); setNotice('操作已保存。确定性检查与人工签署各自保留，均不保证事实绝对正确。')
      if (pending.request.action === 'claim-save') setDraft(blankClaim())
      if (result.result.resultType === 'm4-artifact-draft' || result.result.resultType === 'm4-artifact-publish') { setArtifactId(result.result.manifest.artifactManifestId); setView('artifacts') }
      setAttested(false); await load(owner.scopeVersionId)
    } catch { if (current(token)) { restore(); setNotice(sent ? '结果尚未确认或版本已变化，原键和请求保留。刷新只读取状态；请核对后手动重试，不会自动重新写入。' : '无法校验或保留本地操作，本次未发送；已有待核对请求不会被覆盖。') } }
    finally { if (current(token)) { busy.current = false; setWriting(false) } }
  }
  function discard() {
    if (busy.current || outbox.state === 'empty' || !window.confirm('仅清除此标签页的待核对操作，不撤销服务器可能已经保存的记录，也不删除历史。继续？')) return
    try { sessionStorage.removeItem(outbox.key); restore(); setNotice('仅清除了本地待办；请刷新核对服务端记录。'); void load() } catch { setNotice('本地待办未能清除。') }
  }
  function revise(claim: ClaimVersion, newChain = false) {
    if (!workspace || blocked) return
    const value = claimRevisionDraft(workspace, claim)
    if (!value || !['document-supported', 'derived-from-claims'].includes(value.basis)) { setNotice('此结论的完整推导或证据未在当前列表中，不能用不完整摘要替代修订。'); return }
    setDraft({ ...value, expectedClaimVersionId: newChain ? null : value.expectedClaimVersionId }); setView('claims')
    setNotice(newChain ? '已复制为新结论链草稿，原结论与历史未变。' : '已载入完整当前版本。接受、拒绝或修改均需明确保存为新版本。')
    editor.current?.focus()
  }
  function copyArtifact(value: ArtifactManifest) {
    if (blocked) return
    setArtifactTitle(`${value.title}（修订草稿）`); setArtifactKind(value.kind)
    setChosenClaims(artifactClaimUses(value).map(use => ({ claimVersionId: use.claimVersionId, useKind: use.useKind })))
    setNotice('已复制为新成果链草稿；不会原地修改或撤回原成果。请核对结论版本，再创建。')
  }
  function relation(evidenceId: string, selected: boolean) {
    setDraft(value => ({ ...value, evidenceRelations: selected ? [...value.evidenceRelations, { evidenceId, kind: 'supports', coverage: 'full' }] : value.evidenceRelations.filter(item => item.evidenceId !== evidenceId) }))
  }
  const saveDisabled = blocked || !draft.statement.trim() || draft.basis === 'document-supported' && !draft.evidenceRelations.length
    || draft.basis === 'derived-from-claims' && (!draft.derivation.inputClaimVersionIds.length || draft.derivation.operation === 'calculate' && (!draft.derivation.expression?.trim() || !draft.derivation.rounding))
  const staleChosen = chosenClaims.some(use => !workspace?.claims.some(claim => claim.claimVersionId === use.claimVersionId && claim.lifecycleStatus === 'current'))

  return <><button className="header-action" disabled={!identity} onClick={() => { setOpen(true); void load() }}><Icon name="check" size={17} /><UiText en="Findings and review" zh="结论与审阅" /></button>
    {open && <Drawer workspace title="结论与审阅" subtitle="将证据整理成可追溯结论，独立审阅后发布本地成果。引用仍只跳转原始 PDF。" onClose={() => { focusSequence.current++; setOpen(false) }}>
      <div className="live-reviews">
        <div className="research-workspace-intro"><div><h3>{t('From evidence to a considered decision', '从原文依据，到审慎判断')}</h3><p>{t('Inspect relationships, check the rules and keep human sign-off separate.', '看清证据关系，核对固定规则，并独立保留人工决定。')}</p></div><div className="research-counts"><span><strong>{workspace?.evidence.length ?? 0}</strong>{t('evidence', '份原文证据')}</span><span><strong>{workspace?.claims.length ?? 0}</strong>{t('claim versions', '个结论版本')}</span><span><strong>{workspace?.artifacts.length ?? 0}</strong>{t('artifacts', '份成果')}</span></div></div>
        <p className="review-boundary">结论不是原文，人工接受不等于事实已验证。审阅 G0–G4 检查固定规则；计算表达式可追溯，不代表已自动验证算术。</p>
        {notice && <p className="review-notice" role="status">{notice}</p>}
        {outbox.state !== 'empty' && <section className="review-pending" aria-label="待核对审阅操作"><h3>有一条操作尚未确认</h3><p>刷新不会重新执行；不会将旧请求切换到新的范围。</p>
          {outbox.state === 'pending' ? <><details><summary>查看原操作与范围</summary><p>{outbox.value.request.action} · {outbox.value.owner.scopeVersionId}</p><code>{outbox.value.request.idempotencyKey}</code></details>{!outbox.current && <p>此请求属于另一审阅范围或会话代际。请返回原范围核对，不能替换原键重试。</p>}</> : <p>本地请求无法完整校验，未修复、覆盖或发送。</p>}
          <div className="review-actions"><button className="secondary-button" disabled={writing || loading || outbox.state !== 'pending' || !outbox.current} onClick={() => void commit()}>使用原键核对操作</button><button className="text-action" disabled={writing} onClick={discard}>仅清除本地待办</button></div>
        </section>}
        <div className="review-scope"><label>审阅资料范围<select aria-label="审阅资料范围" disabled={writing || loading || !workspace?.scopeOptions.length} value={workspace?.scope?.scopeVersionId ?? ''} onChange={event => changeScope(event.target.value)}>
          {!workspace?.scope && <option value="">尚无可用范围</option>}{workspace?.scopeOptions.map(scope => <option key={scope.scopeVersionId} value={scope.scopeVersionId}>版本 {scope.version} · {scope.sourceCount} 份资料{scope.current ? ' · 最近已保存回答' : ' · 历史范围'}</option>)}</select></label>
          <button className="text-action" disabled={writing || loading} onClick={() => { restore(); void load() }}>{loading ? '读取中…' : '刷新审阅工作区'}</button></div>
        <p className="review-muted">这里选择历史范围仅用于查看和审阅，不修改对话的原生文档范围。</p>
        {workspace?.truncated && <p className="review-notice">当前列表已截断，不是完整审阅历史；不能在此声明已核对完整材料。请使用较小的已授权范围。</p>}
        {loading && <p role="status">正在读取已授权的证据、结论和审阅记录…</p>}
        {!loading && !workspace && <p className="review-muted">尚未读到真实审阅数据。可以刷新；不会展示模拟成果。</p>}
        {workspace && !workspace.scope && <p className="review-muted">当前尚无已准备的资料范围。请先基于文档发起研究，再回到此处整理证据。</p>}
        {workspace?.scope && <><div className="review-tabs" role="group" aria-label="审阅工作区视图"><button aria-pressed={view === 'claims'} onClick={() => setView('claims')}>{t('Evidence & claims', '证据与结论')} · {workspace.claims.length}</button><button aria-pressed={view === 'artifacts'} onClick={() => setView('artifacts')}>{t('Artifacts & review', '成果与审阅')} · {workspace.artifacts.length}</button><button aria-pressed={view === 'graph'} onClick={() => setView('graph')}><Icon name="map" size={14} />{t('Relationships', '关系图')}</button></div>
          {view === 'graph' ? <ReviewRelationshipGraph key={workspace.scope.scopeVersionId} workspace={workspace} onEvidence={id => { const value = workspace.evidence.find(item => item.evidenceId === id); if (value) void focus(value) }}
            onClaim={id => { setView('claims'); requestAnimationFrame(() => { const target = [...document.querySelectorAll<HTMLElement>('[data-review-claim]')].find(item => item.dataset.reviewClaim === id); target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true }) }) }}
            onArtifact={id => { setArtifactId(id); setAttested(false); setRationale(''); setView('artifacts') }} /> : view === 'claims' ? <>
            <ReviewEvidenceList evidence={workspace.evidence} selected={draft.evidenceRelations.map(value => value.evidenceId)} disabled={blocked} onSelect={relation} onFocus={value => void focus(value)} />
            <section className="review-section" aria-labelledby="review-claim-editor"><h3 id="review-claim-editor">{draft.expectedClaimVersionId ? '修订与审阅结论' : '写下一条结论'}</h3>
              {draft.expectedClaimVersionId && <p className="review-muted">基于 {draft.expectedClaimVersionId} 条件提交新版本；原版本保留。版本已变化时不会覆盖。</p>}
              <label>结论正文<textarea ref={editor} aria-label="结论正文" rows={4} maxLength={4000} value={draft.statement} disabled={blocked} onChange={event => setDraft({ ...draft, statement: event.target.value })} /></label>
              <div className="review-fields"><label>结论基础<select aria-label="结论基础" value={draft.basis} disabled={blocked} onChange={event => setDraft({ ...draft, basis: event.target.value as ClaimDraft['basis'], derivation: { operation: event.target.value === 'document-supported' ? 'extract' : 'calculate', inputClaimVersionIds: [] } })}><option value="document-supported">直接依据文档</option><option value="derived-from-claims">由已有结论推导</option></select></label>
                <label>证据判断<select aria-label="结论证据判断" value={draft.epistemicStatus} disabled={blocked} onChange={event => setDraft({ ...draft, epistemicStatus: event.target.value as ClaimDraft['epistemicStatus'] })}>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label>人工审阅状态<select aria-label="结论人工审阅状态" value={draft.reviewStatus} disabled={blocked} onChange={event => setDraft({ ...draft, reviewStatus: event.target.value as ClaimDraft['reviewStatus'] })}>{Object.entries(reviewNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
              {draft.evidenceRelations.map((item, index) => <div className="review-relation" key={`${item.evidenceId}:${index}`}><span>{workspace.evidence.find(evidence => evidence.evidenceId === item.evidenceId)?.sourceName ?? '尚不能核对的证据'} · {item.evidenceId}</span>
                <label>关系<select aria-label={`证据关系 ${item.evidenceId} ${index + 1}`} value={item.kind} disabled={blocked} onChange={event => setDraft({ ...draft, evidenceRelations: draft.evidenceRelations.map((value, position) => position === index ? { ...value, kind: event.target.value as EvidenceRelationKind } : value) })}>{Object.entries(relationNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label>覆盖<select aria-label={`证据覆盖 ${item.evidenceId} ${index + 1}`} value={item.coverage} disabled={blocked} onChange={event => setDraft({ ...draft, evidenceRelations: draft.evidenceRelations.map((value, position) => position === index ? { ...value, coverage: event.target.value as 'full' | 'partial' } : value) })}><option value="full">完整范围</option><option value="partial">部分范围</option></select></label>
                <label>关系说明（可选）<input aria-label={`证据关系说明 ${item.evidenceId} ${index + 1}`} value={item.rationale ?? ''} maxLength={4000} disabled={blocked} onChange={event => setDraft({ ...draft, evidenceRelations: draft.evidenceRelations.map((value, position) => position === index ? { ...value, rationale: event.target.value } : value) })} /></label></div>)}
              {draft.basis === 'derived-from-claims' && <div className="review-derivation"><label>推导操作<select aria-label="结论推导操作" disabled={blocked} value={draft.derivation.operation} onChange={event => setDraft({ ...draft, derivation: { ...draft.derivation, operation: event.target.value as 'calculate' | 'compare' } })}><option value="calculate">计算</option><option value="compare">比较</option></select></label>
                <fieldset disabled={blocked}><legend>引用的输入结论版本</legend>{workspace.claims.filter(claim => claim.lifecycleStatus === 'current' && claim.claimVersionId !== draft.expectedClaimVersionId || draft.derivation.inputClaimVersionIds.includes(claim.claimVersionId)).map(claim => <label className="review-check" key={claim.claimVersionId}><input type="checkbox" checked={draft.derivation.inputClaimVersionIds.includes(claim.claimVersionId)} onChange={event => setDraft({ ...draft, derivation: { ...draft.derivation, inputClaimVersionIds: event.target.checked ? [...draft.derivation.inputClaimVersionIds, claim.claimVersionId] : draft.derivation.inputClaimVersionIds.filter(id => id !== claim.claimVersionId) } })} /><span>v{claim.version} · {claim.statement}{claim.lifecycleStatus !== 'current' ? ' · 历史输入版本' : ''}</span></label>)}</fieldset>
                <label>{draft.derivation.operation === 'calculate' ? '计算表达式（必填）' : '比较方法（可选）'}<textarea aria-label="推导表达式" rows={2} maxLength={8000} value={draft.derivation.expression ?? ''} disabled={blocked} onChange={event => setDraft({ ...draft, derivation: { ...draft.derivation, expression: event.target.value } })} /></label>
                {draft.derivation.operation === 'calculate' && <div className="review-fields"><label>舍入规则（必选）<select aria-label="计算舍入规则" value={draft.derivation.rounding?.mode ?? ''} disabled={blocked} onChange={event => { if (event.target.value) setDraft({ ...draft, derivation: { ...draft.derivation, rounding: { mode: event.target.value as NonNullable<ClaimDraft['derivation']['rounding']>['mode'], decimalPlaces: draft.derivation.rounding?.decimalPlaces ?? 2 } } }) }}><option value="">请选择</option><option value="half-even">舍入到偶数</option><option value="half-up">四舍五入</option><option value="floor">向下取整</option><option value="ceiling">向上取整</option><option value="truncate">截断</option></select></label><label>保留小数位<input aria-label="计算小数位" type="number" min={0} max={12} value={draft.derivation.rounding?.decimalPlaces ?? 2} disabled={blocked || !draft.derivation.rounding} onChange={event => { const value = Number(event.target.value); if (draft.derivation.rounding && Number.isInteger(value) && value >= 0 && value <= 12) setDraft({ ...draft, derivation: { ...draft.derivation, rounding: { ...draft.derivation.rounding, decimalPlaces: value } } }) }} /></label></div>}
                <p className="review-muted">保留输入版本和表达式用于追溯；不会执行表达式或自动验证计算结果。输入结论不是新证据；若要作为事实发布，还需在上方明确选择其真实原文材料。保存推导结论不等于已满足发布条件。</p></div>}
              {(draft.proposition || draft.claimScope) && <details><summary>修订中保留的结构与适用范围</summary><p className="review-muted">这些已有字段原样保留；基础编辑器不会默默移除实体、时间或辖区限定。</p><pre>{JSON.stringify({ proposition: draft.proposition, claimScope: draft.claimScope }, null, 2)}</pre></details>}
              <div className="review-actions"><button className="primary-button" disabled={saveDisabled} onClick={() => void commit({ action: 'claim-save', ...draft, statement: draft.statement.trim() })}>{draft.expectedClaimVersionId ? '保存结论新版本' : '保存新结论'}</button><button className="text-action" disabled={blocked} onClick={() => setDraft(blankClaim())}>清空结论草稿</button></div>
            </section>
            <ReviewClaimList claims={workspace.claims} disabled={blocked} onEdit={revise} onContinue={onContinue ? target => { focusSequence.current++; setOpen(false); onContinue(target) } : undefined} />
          </> : <>
            <section className="review-section"><h3>整理为成果草稿</h3><p className="review-muted">只组织已保存的结论版本；创建不会自动审阅、签署或发布。</p>
              <div className="review-fields"><label>成果标题<input aria-label="成果标题" value={artifactTitle} maxLength={200} disabled={blocked} onChange={event => setArtifactTitle(event.target.value)} /></label><label>成果形式<select aria-label="成果形式" value={artifactKind} disabled={blocked} onChange={event => setArtifactKind(event.target.value as 'brief' | 'matrix')}><option value="brief">简报 Brief</option><option value="matrix">对照表 Matrix</option></select></label></div>
              <fieldset disabled={blocked}><legend>选择结论及其用途</legend>{workspace.claims.filter(claim => claim.lifecycleStatus === 'current' || chosenClaims.some(use => use.claimVersionId === claim.claimVersionId)).map(claim => {
                const selected = chosenClaims.find(value => value.claimVersionId === claim.claimVersionId)
                return <div className="review-claim-choice" key={claim.claimVersionId}><label className="review-check"><input type="checkbox" checked={!!selected} onChange={event => setChosenClaims(event.target.checked ? [...chosenClaims, { claimVersionId: claim.claimVersionId, useKind: 'assertion' }] : chosenClaims.filter(use => use.claimVersionId !== claim.claimVersionId))} /><span>v{claim.version} · {claim.statement}{claim.lifecycleStatus !== 'current' ? ' · 非当前版本' : ''}</span></label>{selected && <select aria-label={`结论用途 ${claim.claimVersionId}`} value={selected.useKind} onChange={event => setChosenClaims(chosenClaims.map(use => use.claimVersionId === claim.claimVersionId ? { ...use, useKind: event.target.value as keyof typeof useNames } : use))}>{Object.entries(useNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</div>
              })}</fieldset>
              {staleChosen && <p className="review-notice">草稿含非当前或未显示的结论版本。请明确选择替代版本，不会自动改写引用。</p>}
              <button className="primary-button" disabled={blocked || !artifactTitle.trim() || !chosenClaims.length || staleChosen} onClick={() => void commit({ action: 'artifact-create', artifactKind, title: artifactTitle.trim(), claims: chosenClaims })}>创建成果草稿</button>
            </section>
            <section className="review-section"><h3>已有成果</h3>{!workspace.artifacts.length && <p className="review-muted">还没有成果草稿，不会自动生成示例。</p>}<div className="review-artifacts">{workspace.artifacts.map(value => <button className="review-artifact-choice" aria-pressed={value.artifactManifestId === artifactId} key={value.artifactManifestId} onClick={() => { setArtifactId(value.artifactManifestId); setAttested(false); setRationale('') }}><strong>{value.title}</strong><span>{value.kind === 'brief' ? '简报' : '对照表'} · v{value.version} · {artifactNames[value.status]}</span></button>)}</div></section>
            {artifact && <section className="review-section" aria-label="成果内容与审阅"><ReviewArtifactPreview artifact={artifact} evidence={workspace.evidence} onFocus={value => void focus(value)} />
              <button className="text-action" disabled={blocked} onClick={() => copyArtifact(artifact)}>复制为修订草稿（新成果链）</button>
              {onContinue && <button className="text-action" disabled={writing} onClick={() => { focusSequence.current++; setOpen(false); onContinue({ recordId: artifact.artifactManifestId, recordVersion: artifact.version, label: artifact.title }) }}>继续核验</button>}
              {artifact.status === 'draft' && <><details><summary>核对发布涉及的支持、反向与限定材料</summary><ReviewEvidenceList evidence={workspace.evidence} disabled={true} onFocus={value => void focus(value)} /></details>
                <label className="review-check"><input type="checkbox" checked={attested} disabled={blocked || workspace.truncated} onChange={event => setAttested(event.target.checked)} /><span>我已核对当前列出的支持、反向和限定证据；此声明不代表已穷尽外部资料。</span></label>
                <div className="review-actions"><button className="secondary-button" disabled={blocked || !attested || workspace.truncated} onClick={() => void commit({ action: 'review-attest', artifactManifestId: artifact.artifactManifestId, attestation: 'listed-evidence-reviewed' })}>保存材料核对声明</button><button className="secondary-button" disabled={blocked} onClick={() => void commit({ action: 'review-run', artifactManifestId: artifact.artifactManifestId })}>运行 G0–G4 审阅</button></div></>}
              {review && <ReviewGates review={review} />}
              {review && artifact.status === 'draft' && <section className="review-signoff"><h4>独立人工签署</h4><p className="review-muted">签署不修改 G0–G4 的结果；后续拒绝会阻止使用旧批准发布。</p><label>签署意见（可选）<textarea aria-label="人工签署意见" rows={2} maxLength={2000} value={rationale} disabled={blocked} onChange={event => setRationale(event.target.value)} /></label>
                <div className="review-actions"><button className="secondary-button" disabled={blocked || !['pass', 'needs-human'].includes(review.decision) || !review.coverage.complete} onClick={() => { if (window.confirm('确认对这份固定审阅结果作出人工批准？它不代替事实核验，也不会自动发布。')) void commit({ action: 'review-decide', reviewResultId: review.reviewResultId, decision: 'approved', ...(rationale.trim() ? { rationale: rationale.trim() } : {}) }) }}>人工批准此审阅</button><button className="text-action" disabled={blocked} onClick={() => void commit({ action: 'review-decide', reviewResultId: review.reviewResultId, decision: 'rejected', ...(rationale.trim() ? { rationale: rationale.trim() } : {}) })}>人工拒绝此审阅</button></div>
                {latestDecision && <p>最近签署：{latestDecision.decision === 'approved' ? '批准' : '拒绝'} · {latestDecision.decidedAt}</p>}
                <details><summary>查看此审阅的签署历史</summary>{workspace.decisions.filter(value => value.reviewResultId === review.reviewResultId).map(value => <p key={value.reviewDecisionId}>{value.decision === 'approved' ? '批准' : '拒绝'} · {value.decidedAt}{value.rationale ? ` · ${value.rationale}` : ''}</p>)}</details>
                <button className="primary-button" disabled={blocked || !approval} onClick={() => { if (approval && window.confirm('发布为本地不可变成果？后续修改需新草稿与新审阅，不会对外发送，也不会原地覆盖。')) void commit({ action: 'artifact-publish', artifactManifestId: artifact.artifactManifestId, reviewResultId: approval.review.reviewResultId, humanReviewDecisionId: approval.decision.reviewDecisionId }) }}>发布本地成果</button>
              </section>}
            </section>}
          </>}
        </>}
      </div>
    </Drawer>}
  </>
}

export function ReviewEvidenceList({ evidence, selected, disabled, onSelect, onFocus }: { evidence: EvidencePreview[], selected?: string[], disabled: boolean, onSelect?(id: string, selected: boolean): void, onFocus(value: EvidencePreview): void }) {
  return <section className="review-section" aria-label="可核对证据"><h3>证据预览</h3>{!evidence.length && <p className="review-muted">此范围还没有已保存的证据。请先通过真实文档问答或阅读收集证据；这里不会把任意文字当作原文。</p>}
    <div className="review-evidence-list">{evidence.map(value => <article key={value.evidenceId} data-review-evidence={value.evidenceId}><header><strong>{value.sourceName}</strong><span>第 {value.physicalPage} 页</span></header><p>{value.preview}</p><small>版本 {value.revisionId} · 证据 {value.evidenceId}</small><div className="review-actions">
      <button className="text-action" onClick={() => onFocus(value)}>核对原始 PDF</button>{onSelect && <label className="review-check"><input type="checkbox" aria-label={`选择证据 ${value.evidenceId}`} disabled={disabled} checked={selected?.includes(value.evidenceId) ?? false} onChange={event => onSelect(value.evidenceId, event.target.checked)} />用于此结论</label>}</div></article>)}</div>
  </section>
}
export function ReviewClaimList({ claims, disabled, onEdit, onContinue }: { claims: ClaimVersion[], disabled: boolean, onEdit(claim: ClaimVersion, newChain?: boolean): void, onContinue?: ((target: ContinuityTarget) => void) | undefined }) {
  return <section className="review-section" aria-label="已保存结论"><h3>已保存结论</h3>{!claims.length && <p className="review-muted">尚无结论。保存后将保留证据关系、推导输入与不可变版本。</p>}{claims.map(claim => <article className="review-claim" key={claim.claimVersionId} data-review-claim={claim.claimVersionId} tabIndex={-1}><p>{claim.statement}</p><small>v{claim.version} · {statusNames[claim.epistemicStatus]} · {reviewNames[claim.reviewStatus]}{claim.lifecycleStatus !== 'current' ? ' · 历史版本' : ''}</small>
    <button className="text-action" disabled={disabled} onClick={() => onEdit(claim, claim.lifecycleStatus !== 'current')}>{claim.lifecycleStatus === 'current' ? '修订 / 接受 / 拒绝' : '复制为新结论草稿'}</button>{onContinue && <button className="text-action" disabled={disabled} onClick={() => onContinue({ recordId: claim.claimVersionId, recordVersion: claim.version, label: claim.statement.slice(0, 500) })}>继续核验</button>}</article>)}</section>
}
export function ReviewArtifactPreview({ artifact, evidence, onFocus }: { artifact: ArtifactManifest, evidence: EvidencePreview[], onFocus(value: EvidencePreview): void }) {
  const citations = (ids: string[]) => <div className="review-citations">{[...new Set(ids)].map((id, index) => { const source = evidence.find(value => value.evidenceId === id); return <button key={id} className="text-action" disabled={!source} aria-label={`核对成果引用 ${id}`} onClick={() => { if (source) onFocus(source) }}>{source ? `原文 ${index + 1} · ${source.sourceName} 第 ${source.physicalPage} 页` : `引用当前无法核对 · ${id}`}</button> })}</div>
  return <article className="review-artifact-content" aria-label="不可变成果内容"><h3>{artifact.title}</h3><p className="review-muted">{artifactNames[artifact.status]} · v{artifact.version} · {artifact.kind === 'brief' ? '简报' : '对照表'}{artifact.status !== 'draft' ? ' · 本地不可变版本，不等于已对外发布；不能原地回滚。' : ' · 尚未发布'}</p>
    {artifact.kind === 'brief' ? artifact.content.sections.map(section => <section key={section.sectionId}><h4>{section.heading}</h4><p className="review-preserve">{section.markdown}</p>{citations(section.claimUses.flatMap(use => use.citationEvidenceIds))}</section>)
      : <div className="review-matrix-scroll" role="region" aria-label="成果对照表" tabIndex={0}><table><thead><tr><th scope="col">项目</th>{artifact.content.columns.map(column => <th scope="col" key={column.columnId}>{column.label}</th>)}</tr></thead><tbody>{artifact.content.rows.map(row => <tr key={row.rowId}><th scope="row">{row.label}</th>{artifact.content.columns.map(column => { const cell = artifact.content.cells.find(value => value.rowId === row.rowId && value.columnId === column.columnId); return <td key={column.columnId}><p className="review-preserve">{cell?.markdown ?? '未提供'}</p>{cell && citations(cell.claimUses.flatMap(use => use.citationEvidenceIds))}</td> })}</tr>)}</tbody></table></div>}
    <details><summary>成果版本与内容指纹</summary><code>{artifact.artifactManifestId}</code><code>{artifact.contentHash}</code></details>
  </article>
}
export function ReviewGates({ review }: { review: ReviewResult }) {
  const { t } = useUi()
  const labels = { 'G0-integrity': 'G0 完整性', 'G1-grounding': 'G1 证据支持', 'G2-scope': 'G2 适用范围', 'G3-conflict': 'G3 冲突与反向材料', 'G4-publication': 'G4 发布条件' }
  const statuses = { pass: '通过', fail: '未通过', 'not-run': '未执行', 'not-applicable': '不适用' }
  return <section className="review-gates" aria-label="确定性审阅结果"><h4>G0–G4 审阅结果</h4><p>结论：{{ pass: '规则通过', fail: '存在阻塞项', 'needs-human': '需要人工签署', incomplete: '检查不完整' }[review.decision]} · {review.coverage.checkedItems}/{review.coverage.requiredItems} 项已检查</p>
    <div className="review-gate-progress" role="progressbar" aria-label={t('Checks covered', '已检查覆盖')} aria-valuenow={review.coverage.checkedItems} aria-valuemin={0} aria-valuemax={Math.max(1, review.coverage.requiredItems)}><i style={{ width: `${review.coverage.requiredItems ? Math.min(100, review.coverage.checkedItems / review.coverage.requiredItems * 100) : 0}%` }} /></div>
    <ul>{review.gates.map(gate => <li key={gate.gateId} data-review-gate={gate.gateId} data-gate-status={gate.status}><strong>{labels[gate.gateId]}</strong><span>{statuses[gate.status]}</span>{review.issues.filter(issue => issue.gateId === gate.gateId).map(issue => <p key={issue.issueId} className={issue.severity === 'blocker' ? 'review-blocker' : 'review-muted'}>{issue.severity === 'blocker' ? '阻塞' : '提醒'} · {issue.message}</p>)}</li>)}</ul><small>固定规则版本 {review.ruleset.version}。人工批准不会更改检查结果，检查通过不保证语义或算术正确。</small>
  </section>
}
