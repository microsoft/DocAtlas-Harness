import { useMemo, useState } from 'react'
import type { ProductReviewWorkspace } from '@docatlas/contracts'
import { artifactClaimUses, artifactReview } from './review-state'
import { useUi } from './locale'
import { Icon } from '../icons'
import './review-graph.css'

export interface ReviewGraphNode { id: string, recordId: string, kind: 'evidence' | 'claim' | 'artifact' | 'review', title: string, preview: string, status: string, column: number, row: number, artifactId?: string }
export interface ReviewGraphEdge { from: string, to: string, kind: string }
/** Only explicit, loaded domain links are drawn. No model-inferred relation or fabricated confidence. */
export function reviewGraphData(workspace: ProductReviewWorkspace) {
  const nodes: ReviewGraphNode[] = [], edges: ReviewGraphEdge[] = [], limit = 12
  workspace.evidence.slice(0, limit).forEach((value, row) => nodes.push({ id: `e:${value.evidenceId}`, recordId: value.evidenceId, kind: 'evidence', title: value.sourceName, preview: value.preview, status: `p. ${value.physicalPage}`, column: 0, row }))
  workspace.claims.slice(-limit).forEach((value, row) => nodes.push({ id: `c:${value.claimVersionId}`, recordId: value.claimVersionId, kind: 'claim', title: value.statement, preview: `v${value.version}`, status: value.epistemicStatus, column: 1, row }))
  workspace.artifacts.slice(-limit).forEach((value, row) => nodes.push({ id: `a:${value.artifactManifestId}`, recordId: value.artifactManifestId, kind: 'artifact', title: value.title, preview: `${value.kind} · v${value.version}`, status: value.status, column: 2, row }))
  // Latest is journal order, never lexicographic ID or wall-clock sorting.
  const reviews = workspace.artifacts.flatMap(artifact => { const value = artifactReview(workspace, artifact); return value ? [{ value, artifact }] : [] }).slice(-limit)
  reviews.forEach(({ value, artifact }, row) => nodes.push({ id: `r:${value.reviewResultId}`, recordId: value.reviewResultId, kind: 'review', title: artifact.title,
    preview: `${value.coverage.checkedItems}/${value.coverage.requiredItems}`, status: value.decision, column: 3, row, artifactId: artifact.artifactManifestId }))
  const ids = new Set(nodes.map(node => node.id))
  const add = (from: string, to: string, kind: string) => { if (ids.has(from) && ids.has(to)) edges.push({ from, to, kind }) }
  for (const relation of workspace.evidenceRelations) add(`e:${relation.evidenceId}`, `c:${relation.claimVersionId}`, relation.kind)
  for (const artifact of workspace.artifacts) for (const use of artifactClaimUses(artifact)) add(`c:${use.claimVersionId}`, `a:${artifact.artifactManifestId}`, use.useKind)
  for (const { value, artifact } of reviews) add(`a:${artifact.artifactManifestId}`, `r:${value.reviewResultId}`, 'reviewed')
  return { nodes, edges, clipped: workspace.truncated || workspace.evidence.length > limit || workspace.claims.length > limit || workspace.artifacts.length > limit,
    height: Math.max(250, 48 + Math.max(0, ...nodes.map(node => node.row + 1)) * 116) }
}

export function ReviewRelationshipGraph({ workspace, onEvidence, onClaim, onArtifact }: {
  workspace: ProductReviewWorkspace, onEvidence(id: string): void, onClaim(id: string): void, onArtifact(id: string): void,
}) {
  const { t } = useUi(), graph = useMemo(() => reviewGraphData(workspace), [workspace]), [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = graph.nodes.find(node => node.id === selectedId), byId = new Map(graph.nodes.map(node => [node.id, node]))
  const related = new Set(selected ? [selected.id, ...graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id).flatMap(edge => [edge.from, edge.to])] : [])
  const connections = selected ? graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id) : []
  const relationName = (kind: string) => ({ supports: t('Supports', '支持'), refutes: t('Refutes', '反驳'), qualifies: t('Qualifies', '限定'), reviewed: t('Reviewed artifact', '审阅成果') }[kind] ?? kind)
  const labels = { evidence: t('Evidence', '原文证据'), claim: t('Claims', '结论'), artifact: t('Artifacts', '成果'), review: t('Review', '审阅') }
  const status = (value: string) => ({ proposed: t('Proposed', '待核实'), supported: t('Supported', '已有支持'), 'partially-supported': t('Partial support', '部分支持'), contested: t('Contested', '存在争议'),
    contradicted: t('Contradicted', '被反驳'), unresolved: t('Unresolved', '未解决'), stale: t('Stale', '可能过时'), withdrawn: t('Withdrawn', '已撤回'),
    draft: t('Draft', '草稿'), published: t('Published locally', '本地已发布'), superseded: t('Superseded', '已有后续版本'), pass: t('Rules passed', '规则通过'), fail: t('Blocked', '存在阻塞'),
    'needs-human': t('Needs human review', '需人工审阅'), incomplete: t('Incomplete', '检查不完整') }[value] ?? value)
  return <section className="review-relationships" aria-label={t('Evidence and review relationships', '证据与审阅关系图')}>
    <div className="review-graph-intro"><h3>{t('Follow the reasoning back to its sources', '沿着关系，回到判断的依据')}</h3><p>{t('These are saved relationships, not a new assessment of truth. Select a card to inspect its direct connections.', '这里展示已保存的关系，不是重新判定事实。选择卡片，查看它的直接关联。')}</p></div>
    {!graph.nodes.length ? <p className="review-muted">{t('No evidence or findings in this view yet. Nothing has been invented for the diagram.', '当前视图还没有证据或结论，不生成示例关系。')}</p> : <>
      <div className="review-graph-canvas" role="region" aria-label={t('Research relationship diagram', '研究关系画布')} tabIndex={0}>
        <div className="review-graph-world" style={{ width: 1096, height: graph.height }}>
          {(['evidence', 'claim', 'artifact', 'review'] as const).map((kind, column) => <h4 className="review-graph-column" key={kind} style={{ left: 12 + column * 276 }}>{labels[kind]}</h4>)}
          <svg className="review-graph-edges" width={1096} height={graph.height} aria-hidden="true">{graph.edges.map((edge, index) => {
            const from = byId.get(edge.from)!, to = byId.get(edge.to)!, x = 12 + from.column * 276 + 228, y = 44 + from.row * 116 + 46, end = 12 + to.column * 276, endY = 44 + to.row * 116 + 46
            return <path key={`${edge.from}:${edge.to}:${index}`} data-relation-kind={edge.kind} className={`${edge.kind} ${selected && edge.from !== selected.id && edge.to !== selected.id ? 'is-muted' : ''}`} d={`M${x},${y} C${x + 24},${y} ${end - 24},${endY} ${end},${endY}`} />
          })}</svg>
          {graph.nodes.map(node => <button type="button" key={node.id} data-review-graph-node={node.id} className={`review-graph-node kind-${node.kind} ${selected?.id === node.id ? 'is-selected' : ''} ${selected && !related.has(node.id) ? 'is-muted' : ''}`}
            aria-pressed={selected?.id === node.id} aria-label={`${labels[node.kind]}: ${node.title}`} style={{ left: 12 + node.column * 276, top: 44 + node.row * 116 }} onClick={() => setSelectedId(node.id)}>
            <small>{labels[node.kind]}<span>{status(node.status)}</span></small><strong>{node.title}</strong><span className="review-graph-preview">{node.preview}</span></button>)}
        </div>
      </div>
      <div className="review-graph-legend"><span className="supports">{t('Supports', '支持')}</span><span className="refutes">{t('Refutes', '反驳')}</span><span className="qualifies">{t('Qualifies', '限定')}</span><span>{t('Other saved links', '其他已存关系')}</span></div>
    </>}
    {graph.clipped && <p className="review-muted">{t('The diagram is bounded to 12 cards per column and the currently loaded scope. Use the other tabs to inspect more records.', '关系图每列最多显示12条，并受当前已加载范围限制。请用其他视图继续查看记录。')}</p>}
    {selected && <aside className="review-graph-inspector"><div><small>{labels[selected.kind]} · {status(selected.status)}</small><h4>{selected.title}</h4><p>{selected.preview}</p>
      <ul className="review-graph-direct-links" aria-label={t('Direct saved relationships', '已保存的直接关系')}>{connections.map((edge, index) => <li key={index}><span>{relationName(edge.kind)}</span><button className="text-action" onClick={() => setSelectedId(edge.from === selected.id ? edge.to : edge.from)}>{byId.get(edge.from === selected.id ? edge.to : edge.from)!.title}</button></li>)}</ul>
      {!connections.length && <p>{t('No direct links in the loaded view.', '已加载视图中没有直接关联。')}</p>}
    </div><button className="secondary-button" onClick={() => selected.kind === 'evidence' ? onEvidence(selected.recordId) : selected.kind === 'claim' ? onClaim(selected.recordId) : onArtifact(selected.artifactId ?? selected.recordId)}><Icon name={selected.kind === 'evidence' ? 'book' : 'note'} size={15} />{selected.kind === 'evidence' ? t('Check original PDF', '核对原始 PDF') : selected.kind === 'claim' ? t('Open claim', '查看结论') : t('Open artifact & review', '查看成果与审阅')}</button></aside>}
  </section>
}
