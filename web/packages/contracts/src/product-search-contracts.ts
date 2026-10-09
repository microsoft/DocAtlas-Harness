export type ProductSearchStrategy = 'fts' | 'tree' | 'combined'
export interface ProductSearchRequest {
  schemaVersion: 1
  kind: 'product-search-request'
  recipe: 'tree-search.v1'
  query: string
  strategy: ProductSearchStrategy
  limits: { maxItems: number, maxChars: number }
  cursor?: string
}
export interface TreeSearchSelection {
  schemaVersion: 1
  kind: 'tree-search-selection'
  nodes: Array<{ key: string, reason: string }>
}
export interface ProductSearchExecution {
  schemaVersion: 1
  kind: 'product-search-execution'
  recipe: 'tree-search.v1'
  requestHash: string
  strategies: Array<'fts' | 'tree'>
  catalogTruncated: boolean
  nodesConsidered: number
  sourceCount: number
  model: string | null
  treeRefs: Array<{ candidateId: string, generationId: string, treeHash: string, sourceHash: string, nodeId: string }>
  summaryRefs?: Array<{ jobId: string, resultHash: string, baseGenerationId: string, nodesUsed: number }>
}
export type ProductSearchValue = ProductSearchRequest | TreeSearchSelection | ProductSearchExecution
