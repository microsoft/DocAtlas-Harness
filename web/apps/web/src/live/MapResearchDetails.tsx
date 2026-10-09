import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { useUi } from './locale'
import { WorkingIndicator } from './WorkingIndicator'
import type { MapResearchAccess, MapResearchNode } from './map-research'

export function MapResearchDetails({ node, access, onClose }: { node: MapResearchNode, access: MapResearchAccess, onClose(): void }) {
  const { t } = useUi(), [busy, setBusy] = useState(false), [error, setError] = useState(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const name = { note: t('Research note', '研究笔记'), question: t('Open question', '研究问题'), claim: t('Linked claim', '关联结论'), review: t('Artifact review', '成果审阅') }[node.kind]
  const status = ({ active: t('Active', '有效记录'), open: t('Open', '待解决'), resolved: t('Resolved', '已解决'), archived: t('Archived', '已归档'),
    proposed: t('Proposed', '待核实'), supported: t('Supported', '已有支持'), 'partially-supported': t('Partial support', '部分支持'), contested: t('Contested', '存在争议'),
    contradicted: t('Contradicted', '被反驳'), unresolved: t('Unresolved', '未解决'), stale: t('Stale', '可能过时'), withdrawn: t('Withdrawn', '已撤回'),
    pass: t('Rules passed', '规则通过'), fail: t('Blocked', '存在阻塞'), 'needs-human': t('Needs human review', '需人工审阅'), incomplete: t('Incomplete', '检查不完整') } as Record<string, string>)[node.status] ?? node.status
  async function focus() {
    if (busy) return
    setBusy(true); setError(false)
    try {
      if (node.focus.kind === 'note') await access.focusNote(node.focus.recordId, node.focus.locatorId)
      else await access.focusEvidence(node.focus.scopeVersionId, node.focus.evidenceId)
      if (alive.current) onClose()
    } catch { if (alive.current) setError(true) }
    finally { if (alive.current) setBusy(false) }
  }
  function openRecord() {
    onClose()
    requestAnimationFrame(() => {
      if (node.kind === 'note' || node.kind === 'question') access.openNote(node.recordId)
      else if (node.reviewScopeId) access.openReview(node.reviewScopeId, node.kind === 'claim' ? { claimVersionId: node.recordId } : node.artifactId ? { artifactManifestId: node.artifactId } : {})
    })
  }
  return <section className={`map-research-detail change-${node.change}`} data-map-research-detail={node.recordId}>
    <div className="map-section-caption"><Icon name={node.kind === 'review' ? 'check' : 'note'} size={15} />{t('Research layer', '研究层')}</div>
    <h2>{name}</h2><div className="map-research-meta"><span>{t(`Page ${node.physicalPage}`, `第 ${node.physicalPage} 页`)}</span>{node.version !== null && <span>v{node.version}</span>}<span>{status}</span><span>{node.change === 'updated' ? t('Updated record', '已修订记录') : node.change === 'added' ? t('Added research', '新增研究') : t('Research reference', '研究引用')}</span></div>
    {node.authoredBy && <p className="map-summary-note">{node.authoredBy === 'agent' ? t('Agent-authored · unverified', 'Agent 记录 · 待核验') : t('Your research · not source text', '用户研究 · 不是原文事实')}</p>}
    <p className="map-research-preview">{node.preview}</p>
    <p className="map-summary-note">{node.association === 'page-anchor' ? t('Linked to a verified passage on this page. A page shared by sections does not prove a more precise chapter.', '关联本页的已核验原文位置。同页存在多个章节时，不猜测更精确的章节归属。') : t('Linked through saved evidence relationships. This is not a new verification or a document heading.', '根据已保存的证据关系关联，不代表重新核验通过，也不是原文目录标题。')}</p>
    <div className="map-inspector-actions"><button className="map-primary" disabled={busy} aria-live="polite" onClick={() => void focus()}>{busy ? <WorkingIndicator small /> : <Icon name="book" size={15} />}{busy ? t('Checking original…', '正在核验原文…') : t('Show original passage', '回到原文位置')}</button>
      <button className="map-secondary" disabled={busy} onClick={openRecord}><Icon name="note" size={15} />{node.kind === 'note' || node.kind === 'question' ? t('Open full note & versions', '查看笔记全文与版本') : t('Open in review', '在审阅工作区查看')}</button></div>
    {error && <p className="map-summary-note" role="alert">{t('The original is unavailable or this view changed. No other source was substituted.', '原文暂不可用或视图已变化，没有换用另一来源。')}</p>}
    <p className="map-summary-note">{t('Edit, resolve or delete the underlying record in its workspace. The map updates from that record; the original outline stays unchanged.', '在工作区编辑、解决或删除原记录，地图随记录更新；原始目录保持不变。')}</p>
  </section>
}
