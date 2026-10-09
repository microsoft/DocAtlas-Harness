export interface TreeConfig { mode: 'raw' | 'merge', useEmbeddedToc: boolean, workers: 1 }
export interface TreeSource { documentId: string, revisionId: string, sourceHash: string }
export interface TreeNode { nodeId: string, parentId: string | null, title: string, startPage: number, endPage: number, sourceNodeId: string | null, keyItems: string[] }
export interface TreeBuildRequest extends TreeSource { schemaVersion: 1, kind: 'build-tree', config: TreeConfig }
export interface TreeReadRequest extends TreeSource { schemaVersion: 1, kind: 'read-tree', generationId: string, offset: number, limit: number }
export interface TreeData { schemaVersion: 1, kind: 'tree-data', generationId: string, pageCount: number, nodes: TreeNode[] }
export interface TreeGeneration extends TreeSource {
  schemaVersion: 1
  kind: 'tree-generation'
  generationId: string
  parentGenerationId: string | null
  config: TreeConfig
  provider: { name: 'pageindex-flash', version: string, sourceCommit: string, fingerprint: string }
  status: 'ready' | 'empty'
  pageCount: number
  nodeCount: number
  treeHash: string
  createdAt: string
  tocSource: 'detected' | 'bookmarks' | 'hybrid' | 'disabled'
  warnings: Array<'empty-tree' | 'no-readable-text'>
  optimization: { mergeCount: number, samePageMergeCount: number, samePageDroppedCount: number, rounds: number, costBefore: number, costAfter: number }
}
export interface TreePage { schemaVersion: 1, kind: 'tree-page', generationId: string, treeHash: string, offset: number, total: number, nextOffset: number | null, nodes: TreeNode[] }
export type TreeIndexValue = TreeBuildRequest | TreeReadRequest | TreeData | TreeGeneration | TreePage

/** After shape validation. Tree pages intentionally need not contain their parents. */
export function treeIndexIssues(value: TreeIndexValue): string[] {
  const issues = new Set<string>()
  if (value.kind === 'tree-data' || value.kind === 'tree-page') {
    const seen = new Map<string, TreeNode>()
    for (const node of value.nodes) {
      if (!node.nodeId.startsWith(`${value.generationId}:`)) issues.add('node-generation')
      if (seen.has(node.nodeId)) issues.add('duplicate-node')
      if (!node.title.trim()) issues.add('empty-title')
      if (node.endPage < node.startPage || (value.kind === 'tree-data' && node.endPage > value.pageCount)) issues.add('page-range')
      if (value.kind === 'tree-data' && node.parentId !== null) {
        const parent = seen.get(node.parentId)
        if (!parent || node.parentId === node.nodeId) issues.add('hierarchy')
        else if (node.startPage < parent.startPage || node.endPage > parent.endPage) issues.add('parent-range')
      }
      seen.set(node.nodeId, node)
    }
  }
  if (value.kind === 'tree-generation') {
    if ((value.config.mode === 'raw') !== (value.parentGenerationId === null) || value.parentGenerationId === value.generationId) issues.add('parent-generation')
    if ((value.status === 'empty') !== value.warnings.includes('empty-tree')) issues.add('empty-warning')
  }
  if (value.kind === 'tree-page') {
    const end = value.offset + value.nodes.length
    if (end > value.total || value.nextOffset !== (end < value.total ? end : null) || (!value.nodes.length && end < value.total)) issues.add('pagination')
  }
  return [...issues]
}
