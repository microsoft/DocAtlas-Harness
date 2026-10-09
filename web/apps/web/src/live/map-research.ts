import { useEffect, useMemo, useRef, useState } from 'react'
import type { HumanResearchOverlay, ProductReviewWorkspace, TreeNode } from '@docatlas/contracts'
import type { PdfReaderSource } from '../PdfReader'
import { artifactClaimUses, artifactReview } from './review-state'

export interface MapResearchAccess {
  ownerKey: string, revision: string,
  notes(source: PdfReaderSource, cursor?: string): Promise<HumanResearchOverlay>,
  reviews(source: PdfReaderSource, scopeVersionId?: string): Promise<ProductReviewWorkspace>,
  openNote(recordId: string): void, openReview(scopeVersionId: string, target: { claimVersionId?: string, artifactManifestId?: string }): void,
  focusNote(recordId: string, locatorId: string): Promise<void>, focusEvidence(scopeVersionId: string, evidenceId: string): Promise<void>,
}
export interface MapResearchNode {
  id: string, parentId: string | null, recordId: string, kind: 'note' | 'question' | 'claim' | 'review', version: number | null,
  title: string, preview: string, physicalPage: number, status: string, change: 'added' | 'updated' | 'research',
  association: 'page-anchor' | 'evidence-link', authoredBy?: 'user' | 'agent',
  focus: { kind: 'note', recordId: string, locatorId: string } | { kind: 'evidence', scopeVersionId: string, evidenceId: string },
  reviewScopeId?: string, artifactId?: string,
}
/** A page shared by siblings does not prove which subsection contains the quote. */
export function researchParent(nodes: readonly TreeNode[], page: number): string | null {
  const candidates = nodes.filter(node => node.startPage <= page && page <= node.endPage)
  if (!candidates.length) return null
  // Overlapping siblings can have different spans. Choosing the shortest span
  // would still guess a subsection that the page anchor cannot establish.
  const byId = new Map(nodes.map(node => [node.nodeId, node])), ancestors = new Set<string>()
  const trails = candidates.map(node => {
    const path: TreeNode[] = [], seen = new Set<string>(); let current: TreeNode | undefined = node
    while (current && !seen.has(current.nodeId) && path.length < 24) {
      seen.add(current.nodeId); path.unshift(current)
      if (current.nodeId !== node.nodeId) ancestors.add(current.nodeId)
      current = byId.get(current.parentId ?? '')
    }
    return path
  })
  const paths = trails.filter(path => !ancestors.has(path.at(-1)!.nodeId))
  if (!paths.length) return null
  const common = paths[0]!.filter(node => paths.every(path => path.some(item => item.nodeId === node.nodeId)))
  return common.at(-1)?.nodeId ?? null
}
export function researchDisplayNode(value: MapResearchNode): TreeNode {
  return { nodeId: value.id, parentId: value.parentId, title: value.title, startPage: value.physicalPage, endPage: value.physicalPage, sourceNodeId: null, keyItems: [] }
}
const sameSource = (source: PdfReaderSource, value: { documentId: string, revisionId: string }) => value.documentId === source.serverRevision?.documentId && value.revisionId === source.serverRevision?.revisionId
export function mapResearchNodes(source: PdfReaderSource, tree: readonly TreeNode[], pages: readonly HumanResearchOverlay[], review: ProductReviewWorkspace | null) {
  const nodes: MapResearchNode[] = [], ids = new Set<string>()
  const parents = new Map<number, string | null>()
  const parentAt = (page: number) => { if (!parents.has(page)) parents.set(page, researchParent(tree, page)); return parents.get(page)! }
  let clipped = !!pages.at(-1)?.result.pageInfo.truncated || !!review?.truncated
  const add = (value: MapResearchNode) => {
    if (ids.has(value.id)) return
    if (nodes.length >= 60) { clipped = true; return }
    if (!Number.isSafeInteger(value.physicalPage) || value.physicalPage < 1 || typeof source.pages === 'number' && value.physicalPage > source.pages) throw new Error('Research page exceeds the original PDF')
    ids.add(value.id); nodes.push(value)
  }
  for (const page of pages) {
    if (!sameSource(source, page.result.source) || page.result.physicalPage !== undefined) throw new Error('Research map source changed')
    const versions = new Map(page.recordVersions?.map(item => [item.recordId, item]))
    for (const item of page.result.items) {
      if (!sameSource(source, item.locator) || item.locator.representationId !== page.result.source.representationId || item.locator.representationContentHash !== page.result.source.representationContentHash) throw new Error('Research map anchor changed')
      if (item.recordType !== 'research-note' && item.recordType !== 'open-question') continue
      const metadata = versions.get(item.recordId), version = metadata?.version ?? null
      add({ id: `@research:${item.overlayId}`, parentId: parentAt(item.locator.physicalPage), recordId: item.recordId, kind: item.recordType === 'open-question' ? 'question' : 'note', version,
        title: [...item.preview].slice(0, 100).join(''), preview: item.preview, physicalPage: item.locator.physicalPage, status: item.recordStatus,
        change: version === null ? 'research' : version > 1 ? 'updated' : 'added', association: 'page-anchor', ...(metadata ? { authoredBy: metadata.authoredBy } : {}),
        focus: { kind: 'note', recordId: item.recordId, locatorId: item.locator.locatorId } })
    }
  }
  if (review?.scope) {
    const evidence = new Map(review.evidence.filter(item => sameSource(source, item)).map(item => [item.evidenceId, item])), scopeVersionId = review.scope.scopeVersionId
    const claimEvidence = new Map<string, string[]>()
    for (const relation of review.evidenceRelations) if (evidence.has(relation.evidenceId)) claimEvidence.set(relation.claimVersionId, [...new Set([...(claimEvidence.get(relation.claimVersionId) ?? []), relation.evidenceId])])
    for (const claim of review.claims) {
      if (claim.lifecycleStatus !== 'current') continue
      const anchors = claimEvidence.get(claim.claimVersionId) ?? []
      for (const id of anchors) {
        const anchor = evidence.get(id)!
        add({ id: `@research:claim:${claim.claimVersionId}:${id}`, recordId: claim.claimVersionId, parentId: parentAt(anchor.physicalPage), kind: 'claim', version: claim.version,
          title: [...claim.statement].slice(0, 100).join(''), preview: claim.statement, physicalPage: anchor.physicalPage, status: claim.epistemicStatus, change: claim.version > 1 ? 'updated' : 'added', association: 'evidence-link',
          focus: { kind: 'evidence', scopeVersionId, evidenceId: id }, reviewScopeId: scopeVersionId })
      }
    }
    for (const artifact of review.artifacts) {
      const result = artifactReview(review, artifact)
      if (!result) continue
      const anchorIds = new Set(artifactClaimUses(artifact).flatMap(use => claimEvidence.get(use.claimVersionId) ?? []))
      for (const id of anchorIds) {
        const anchor = evidence.get(id)!
        add({ id: `@research:review:${result.reviewResultId}:${id}`, recordId: result.reviewResultId, parentId: parentAt(anchor.physicalPage), kind: 'review', version: artifact.version,
          title: artifact.title, preview: `${artifact.title}\n${result.coverage.checkedItems}/${result.coverage.requiredItems}`, physicalPage: anchor.physicalPage, status: result.decision, change: 'research', association: 'evidence-link',
          focus: { kind: 'evidence', scopeVersionId, evidenceId: id }, reviewScopeId: scopeVersionId, artifactId: artifact.artifactManifestId })
      }
    }
  }
  return { nodes, clipped }
}

export function useMapResearch(source: PdfReaderSource, tree: readonly TreeNode[], access?: MapResearchAccess) {
  const [pages, setPages] = useState<HumanResearchOverlay[]>([]), [review, setReview] = useState<ProductReviewWorkspace | null>(null), [busy, setBusy] = useState(false)
  const [noteError, setNoteError] = useState(false), [reviewError, setReviewError] = useState(false), [scopeChoice, setScopeChoice] = useState<{ sourceKey: string, id: string }>(), [refresh, setRefresh] = useState(0)
  const serial = useRef(0), key = JSON.stringify([source.id, source.sha256, source.serverRevision, access?.ownerKey, access?.revision])
  const sourceKey = JSON.stringify([source.id, source.sha256, source.serverRevision, access?.ownerKey]), scope = scopeChoice?.sourceKey === sourceKey ? scopeChoice.id : undefined
  const requestKey = JSON.stringify([key, scope, refresh]), [loadedKey, setLoadedKey] = useState('')
  useEffect(() => {
    const token = ++serial.current
    setPages([]); setReview(null); setNoteError(false); setReviewError(false); setLoadedKey(requestKey)
    if (!access || !source.serverRevision) { setBusy(false); return }
    setBusy(true)
    void Promise.allSettled([
      access.notes(source).then(value => { if (serial.current === token) setPages([value]) }).catch(() => { if (serial.current === token) setNoteError(true) }),
      access.reviews(source, scope).then(value => { if (serial.current === token) setReview(value) }).catch(() => { if (serial.current === token) setReviewError(true) }),
    ]).finally(() => { if (serial.current === token) setBusy(false) })
    return () => { serial.current++ }
  }, [key, scope, refresh])
  async function more() {
    const cursor = pages.at(-1)?.result.pageInfo.nextCursor, token = serial.current
    if (!access || !cursor || busy || pages.length >= 4) return
    setBusy(true)
    try {
      const value = await access.notes(source, cursor)
      if (serial.current !== token) return
      if (value.result.queryHash !== pages[0]?.result.queryHash) throw new Error('Research map cursor changed')
      setPages(old => [...old, value])
    } catch { if (serial.current === token) setNoteError(true) }
    finally { if (serial.current === token) setBusy(false) }
  }
  const projected = useMemo(() => {
    if (loadedKey !== requestKey) return { nodes: [], clipped: false, invalid: false }
    try { return { ...mapResearchNodes(source, tree, pages, review), invalid: false } }
    catch { return { nodes: [], clipped: false, invalid: true } }
  }, [source, tree, pages, review, loadedKey, requestKey])
  return { ...projected, busy, noteError, reviewError, review: loadedKey === requestKey ? review : null, refresh: () => setRefresh(value => value + 1), more,
    canMore: loadedKey === requestKey && !!pages.at(-1)?.result.pageInfo.nextCursor && pages.length < 4, setScope: (id: string) => setScopeChoice({ sourceKey, id }) }
}
