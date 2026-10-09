import { useCallback, useEffect, useRef, useState } from 'react'
import { treeIndexIssues, enrichmentIssues, type EnrichmentTree, type TreeNode, type TreeSummaryPreview } from '@docatlas/contracts'
import type { PdfReaderSource } from '../PdfReader'
import { pdfViewIdentity } from '../pdf-view-state'

export type OutlineLoader = (source: PdfReaderSource, offset: number) => Promise<EnrichmentTree>
export function checkedTreePage(source: PdfReaderSource, value: EnrichmentTree, offset: number, previous: EnrichmentTree | null): TreeNode[] {
  if (value.generation.documentId !== source.serverRevision?.documentId || value.generation.revisionId !== source.serverRevision?.revisionId
    || value.generation.config.mode !== 'merge' || source.pages !== null && value.generation.pageCount !== source.pages || value.tree.nodes.length > 200
    || value.generation.sourceHash !== source.sha256 || value.tree.offset !== offset || value.tree.generationId !== value.generation.generationId
    || value.tree.treeHash !== value.generation.treeHash || value.tree.total !== value.generation.nodeCount
    || offset > 0 && (!previous || previous.generation.generationId !== value.generation.generationId || previous.tree.treeHash !== value.tree.treeHash)
    || value.tree.nextOffset !== null && (value.tree.nextOffset <= offset || value.tree.nextOffset !== offset + value.tree.nodes.length)
    || treeIndexIssues(value.generation).length || treeIndexIssues(value.tree).length || enrichmentIssues(value).length
    || value.tree.nodes.some(node => node.endPage > value.generation.pageCount)) throw new Error('Outline identity changed')
  return value.tree.nodes
}
interface TreeState { key: string, result: EnrichmentTree | null, nodes: TreeNode[], summaryPreviews: Map<string, TreeSummaryPreview>, busy: boolean, error: boolean }
const empty = (key: string): TreeState => ({ key, result: null, nodes: [], summaryPreviews: new Map(), busy: false, error: false })
/** Reader-local navigation cache: no persistent storage, global PDF cache or model call. */
export function useDocumentTree(source: PdfReaderSource, load: OutlineLoader | undefined, enabled: boolean) {
  const identity = `${pdfViewIdentity(source)}:${source.url}`, frame = useRef({ identity, generation: 0 })
  if (frame.current.identity !== identity) frame.current = { identity, generation: frame.current.generation + 1 }
  const key = `${identity}:${frame.current.generation}`, [state, setState] = useState(() => empty(key))
  const owner = useRef(key); owner.current = key
  const live = useRef(true), flight = useRef<string | null>(null), latest = useRef(state); latest.current = state
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const read = useCallback(async (offset = 0) => {
    if (!load || flight.current === key) return
    flight.current = key
    const previous = latest.current.key === key ? latest.current : empty(key)
    setState({ ...previous, busy: true, error: false })
    try {
      const value = await load(source, offset)
      if (!live.current || owner.current !== key) return
      const page = checkedTreePage(source, value, offset, previous.result)
      const nodes = offset ? [...previous.nodes, ...page] : page
      if (nodes.length > 2000 || new Set(nodes.map(node => node.nodeId)).size !== nodes.length) throw new Error('Outline page budget changed')
      const summaryPreviews = offset ? new Map(previous.summaryPreviews) : new Map<string, TreeSummaryPreview>()
      for (const preview of value.summaryPreviews ?? []) summaryPreviews.set(preview.nodeId, preview)
      setState({ key, result: value, nodes, summaryPreviews, busy: false, error: false })
    } catch { if (live.current && owner.current === key) setState({ ...previous, busy: false, error: true }) }
    finally { if (flight.current === key) flight.current = null }
  }, [key, load, source.pages])
  const current = state.key === key ? state : empty(key)
  useEffect(() => { if (enabled && !current.result && !current.error && !current.busy) void read() }, [enabled, key, current.result, current.error, current.busy, read])
  return { ...current, read, hasMore: current.result?.tree.nextOffset != null, atLimit: current.nodes.length >= 2000 }
}
export type DocumentTreeState = ReturnType<typeof useDocumentTree>
