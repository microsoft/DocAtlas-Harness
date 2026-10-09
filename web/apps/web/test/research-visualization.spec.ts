import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { humanResearchIssues, type HumanResearchOverlay, type ProductReviewWorkspace, type TreeNode } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { mapResearchNodes, researchDisplayNode, researchParent } from '../src/live/map-research'
import { reviewGraphData } from '../src/live/ReviewGraph'
import { documentMapLayout } from '../src/live/map-layout'
import { humanResearchFixture } from './human-research-fixture'

const chapter = (nodeId: string, parentId: string | null, startPage = 1, endPage = 20): TreeNode => ({ nodeId, parentId, startPage, endPage, title: nodeId, sourceNodeId: null, keyItems: [] })
const tree = [chapter('root', null), chapter('first', 'root', 1, 17), chapter('second', 'root', 17, 20), chapter('detail', 'first', 2, 3)]
async function noteFixture() {
  const fixture = await humanResearchFixture(), overlay = fixture.overlay
  overlay.result.items = [{ overlayId: 'overlay:note', recordId: 'note:human', recordType: 'research-note', recordStatus: 'active',
    sourceInvestigationId: overlay.result.investigationId, sourceSessionId: overlay.binding.conversationId, layer: 'working', createdAt: '2026-09-11T00:00:00Z',
    locator: fixture.locator, relation: 'research-record-anchor', verificationStatus: 'anchor-only', preview: 'Compare this reporting period.' }]
  overlay.result.pageInfo = { ...overlay.result.pageInfo, total: 1, returned: 1, usedChars: [...overlay.result.items[0]!.preview].length }
  overlay.recordVersions = [{ recordId: 'note:human', version: 1, authoredBy: 'user' }]
  const source = { id: 'original', kind: 'server' as const, name: 'Report.pdf', sha256: 'f'.repeat(64), url: '/original', bytes: 1000, pages: 20, serverRevision: fixture.sourceRef }
  return { source, overlay }
}
function reviewFixture(): ProductReviewWorkspace {
  const directory = new URL('../../../contracts/fixtures/', import.meta.url)
  const fixture = JSON.parse(readFileSync(new URL('product-review.json', directory), 'utf8'))
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand)
    if (!value || typeof value !== 'object') return value
    if ('$fixture' in value) {
      const reference = value as { $fixture: string, path: Array<string | number> }
      let input: unknown = JSON.parse(readFileSync(new URL(fixture.imports[reference.$fixture], directory), 'utf8'))
      for (const part of reference.path) input = Reflect.get(input as object, part)
      return input
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]))
  }
  return expand(fixture.bases.workspace) as ProductReviewWorkspace
}

describe('research projection is separate from immutable navigation', () => {
  it('uses deepest unambiguous ancestors, including overlapping siblings of unequal lengths', () => {
    expect(researchParent(tree, 2)).toBe('detail')
    expect(researchParent(tree, 17)).toBe('root')
    expect(researchParent([chapter('a', null, 1, 17), chapter('b', null, 17, 17)], 17)).toBeNull()
    expect(researchParent(tree, 30)).toBeNull()
    const wide = [chapter('root', null), ...Array.from({ length: 1999 }, (_, i) => chapter(`s:${i}`, 'root', 17, 17))]
    expect(researchParent(wide, 17)).toBe('root')
  })
  it('projects added and revised records without changing canonical nodes or inventing evidence', async () => {
    const { source, overlay } = await noteFixture(), before = structuredClone(tree)
    const added = mapResearchNodes(source, tree, [overlay], null).nodes
    expect(added).toHaveLength(1); expect(added[0]).toMatchObject({ kind: 'note', change: 'added', version: 1, parentId: 'root', physicalPage: 17, association: 'page-anchor' })
    expect(parseBrowserContract('human-research', overlay)).toEqual(overlay)
    overlay.recordVersions![0]!.version = 2
    expect(mapResearchNodes(source, tree, [overlay], null).nodes[0]!.change).toBe('updated')
    const duplicate = structuredClone(overlay); duplicate.recordVersions!.push(duplicate.recordVersions![0]!)
    expect(humanResearchIssues(duplicate)).toContain('human-overlay-version')
    expect(() => parseBrowserContract('human-research', duplicate)).toThrow()
    const combined = [...tree, ...added.map(researchDisplayNode)]
    expect(documentMapLayout(combined).links.some(link => link.to.id === added[0]!.id && link.from.id === 'root')).toBe(true)
    expect(tree).toEqual(before)
    expect(mapResearchNodes(source, [], [overlay], null).nodes[0]!.parentId).toBeNull()
    expect(mapResearchNodes(source, tree, [], null).nodes).toEqual([])
    delete overlay.recordVersions
    expect(mapResearchNodes(source, tree, [overlay], null).nodes[0]!.change).toBe('research')
  })
  it('rejects wrong revisions, representations and impossible physical pages, and bounds research work', async () => {
    const { source, overlay } = await noteFixture()
    for (const mutate of [
      (value: HumanResearchOverlay) => { value.result.source.revisionId = 'rev:other' },
      (value: HumanResearchOverlay) => { value.result.items[0]!.locator.documentId = 'doc:other' },
      (value: HumanResearchOverlay) => { value.result.items[0]!.locator.representationContentHash = 'a'.repeat(64) },
      (value: HumanResearchOverlay) => { value.result.items[0]!.locator.physicalPage = 21 },
    ]) { const value = structuredClone(overlay); mutate(value); expect(() => mapResearchNodes(source, tree, [value], null)).toThrow() }
    overlay.result.items = Array.from({ length: 75 }, (_, i) => ({ ...overlay.result.items[0]!, overlayId: `overlay:${i}` }))
    const result = mapResearchNodes(source, tree, [overlay], null)
    expect(result.nodes).toHaveLength(60); expect(result.clipped).toBe(true)
  })
  it('only projects claims and reviews linked to this exact original source', () => {
    const review = reviewFixture(), original = review.evidence[0]!
    const source = { id: 'original', kind: 'server' as const, name: original.sourceName, sha256: 'f'.repeat(64), url: '/original', bytes: 1000, pages: 20,
      serverRevision: { documentId: original.documentId, revisionId: original.revisionId } }
    const nodes = mapResearchNodes(source, tree, [], review).nodes
    expect(nodes.some(node => node.kind === 'claim')).toBe(true)
    expect(nodes.some(node => node.kind === 'review')).toBe(true)
    expect(nodes.every(node => node.focus.kind === 'evidence' && node.focus.evidenceId === original.evidenceId)).toBe(true)
    expect(mapResearchNodes({ ...source, serverRevision: { ...source.serverRevision, revisionId: 'rev:other' } }, tree, [], review).nodes).toEqual([])
    review.evidenceRelations = []
    expect(mapResearchNodes(source, tree, [], review).nodes).toEqual([])
  })
})
describe('review relationship diagram', () => {
  it('preserves support and refutation, explicit links, journal order and original records', () => {
    const value = reviewFixture(), latest = { ...structuredClone(value.reviews[0]!), reviewResultId: 'review:000-latest', reviewedAt: '2000-01-01T00:00:00Z' }
    value.reviews.push(latest)
    const before = structuredClone(value), graph = reviewGraphData(value)
    expect(graph.edges.some(edge => edge.kind === 'supports')).toBe(true)
    expect(graph.edges.some(edge => edge.kind === 'refutes')).toBe(true)
    expect(graph.nodes.filter(node => node.kind === 'review').map(node => node.recordId)).toContain(latest.reviewResultId)
    expect(graph.nodes.filter(node => node.kind === 'review').map(node => node.recordId)).not.toContain(value.reviews[0]!.reviewResultId)
    const ids = new Set(graph.nodes.map(node => node.id))
    expect(graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true)
    expect(value).toEqual(before)
    value.evidence = Array.from({ length: 30 }, (_, i) => ({ ...value.evidence[0]!, evidenceId: `evidence:${i}` }))
    expect(reviewGraphData(value).nodes.filter(node => node.kind === 'evidence')).toHaveLength(12)
    expect(reviewGraphData(value).clipped).toBe(true)
  })
})
