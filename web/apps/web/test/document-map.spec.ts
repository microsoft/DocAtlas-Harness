import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EnrichmentTree, TreeNode } from '@docatlas/contracts'
import { checkedTreePage } from '../src/live/document-tree'
import { documentMapLayout, MAP_MAX_NODES, MAP_NODE_HEIGHT, MAP_NODE_WIDTH, sectionAtPage, sectionDepths, sectionTrail } from '../src/live/map-layout'
import { QuestionText } from '../src/live/QuestionText'

const node = (id: string, parentId: string | null, startPage = 1, endPage = 6): TreeNode => ({ nodeId: id, parentId, title: `Section ${id}`, startPage, endPage, sourceNodeId: null, keyItems: [] })
const nodes = [node('a', null), node('b', 'a', 1, 3), node('c', 'a', 4, 6), node('d', 'b', 2, 2), node('e', null, 7, 9)]
describe('deterministic, bounded document map', () => {
  it('lays out actual parent-child edges without overlap or mutating source nodes', () => {
    const before = structuredClone(nodes), map = documentMapLayout(nodes)
    expect(documentMapLayout(nodes)).toEqual(map); expect(nodes).toEqual(before)
    expect(map.nodes).toHaveLength(6); expect(map.clipped).toBe(false)
    expect(map.links.find(edge => edge.to.id === 'd')!.from.id).toBe('b')
    for (let i = 0; i < map.nodes.length; i++) for (const b of map.nodes.slice(i + 1)) {
      const a = map.nodes[i]!
      expect(Math.abs(a.x - b.x) >= MAP_NODE_WIDTH || Math.abs(a.y - b.y) >= MAP_NODE_HEIGHT).toBe(true)
    }
  })
  it('collapses descendants and focuses an exact branch, without drawing fake evidence', () => {
    const collapsed = documentMapLayout(nodes, new Set(['a']))
    expect(collapsed.nodes.map(node => node.id)).toEqual(['@document', 'a', 'e'])
    const focused = documentMapLayout(nodes, new Set(), 'b')
    expect(focused.nodes.map(node => node.id)).toEqual(['b', 'd'])
    expect(focused.links).toHaveLength(1)
    expect(sectionTrail(nodes, 'd').map(node => node.nodeId)).toEqual(['a', 'b', 'd'])
    expect(sectionAtPage(nodes, 2)?.nodeId).toBe('d'); expect(sectionAtPage(nodes, 10)).toBeUndefined()
    expect(sectionDepths(nodes).get('d')).toBe(2)
  })
  it('bounds breadth, depth and cycles and labels incomplete parent relationships', () => {
    const huge = Array.from({ length: 2000 }, (_, index) => node(String(index), null))
    expect(documentMapLayout(huge).nodes.length).toBeLessThanOrEqual(MAP_MAX_NODES)
    expect(documentMapLayout(huge).clipped).toBe(true)
    const deep = Array.from({ length: 40 }, (_, index) => node(String(index), index ? String(index - 1) : null))
    const map = documentMapLayout(deep)
    expect(map.nodes.length).toBeLessThan(12); expect(map.clipped).toBe(true)
    expect(map.partialParents).toBe(false)
    const cycle = documentMapLayout([node('x', 'y'), node('y', 'x'), node('z', 'missing')])
    expect(cycle.nodes).toHaveLength(4); expect(cycle.partialParents).toBe(true)
  })
})
describe('source-bound, read-only tree pages', () => {
  const value = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document/enrichment.json', import.meta.url), 'utf8')).bases.tree as EnrichmentTree
  const source = { id: 'pdf:one', sha256: value.generation.sourceHash, kind: 'server' as const, name: 'Original.pdf', url: '/original', pages: 6, bytes: 1024,
    serverRevision: { documentId: value.generation.documentId, revisionId: value.generation.revisionId } }
  it('accepts the exact source and rejects crossed revisions, hashes, offsets and page ranges', () => {
    expect(checkedTreePage(source, value, 0, null)).toEqual(value.tree.nodes)
    for (const change of [
      (v: EnrichmentTree) => { v.generation.revisionId = 'rev:foreign' },
      (v: EnrichmentTree) => { v.generation.sourceHash = 'f'.repeat(64) },
      (v: EnrichmentTree) => { v.tree.treeHash = 'f'.repeat(64) },
      (v: EnrichmentTree) => { v.tree.total++ },
      (v: EnrichmentTree) => { v.generation.pageCount++ },
      (v: EnrichmentTree) => { v.tree.offset = 1 },
      (v: EnrichmentTree) => { v.tree.nextOffset = 0 },
      (v: EnrichmentTree) => { v.tree.nodes[0]!.endPage = 7 },
    ]) { const candidate = structuredClone(value); change(candidate); expect(() => checkedTreePage(source, candidate, 0, null)).toThrow() }
  })
  it('requires pagination from the same sealed generation', () => {
    const second = structuredClone(value); second.tree.offset = 1
    expect(() => checkedTreePage(source, second, 1, null)).toThrow()
    const previous = structuredClone(value); previous.generation.generationId = 'tree:other'
    expect(() => checkedTreePage(source, second, 1, previous)).toThrow()
  })
})
it('long questions retain their full escaped source text behind a reversible visual collapse', () => {
  const text = '<script>never execute</script>\n'.repeat(30)
  const html = renderToStaticMarkup(createElement(QuestionText, { text }))
  expect(html).toContain('is-collapsed'); expect(html).toContain('aria-expanded="false"'); expect(html).not.toContain('<script>')
  expect(html.match(/never execute/g)).toHaveLength(30)
})
