import { treeIndexIssues, type TreeNode, type TreeGeneration, type TreePage } from './tree-index-contracts.js'
export interface EnrichmentBudget { maxNodes: number, maxPages: number, maxModelCalls: number, maxInputChars: number, maxOutputTokens: number, maxOutputChars: number, wallMs: number }
export type EnrichmentRecipe = 'docatlas-flash-enrichment.v1' | 'docatlas-flash-enrichment.v2'
export interface EnrichmentStart { schemaVersion: 1, kind: 'enrichment-start', idempotencyKey: string, documentId: string, revisionId: string, baseMode: 'raw' | 'merge', nodeIds: string[], mode: 'summary' | 'expand' | 'full', budget: EnrichmentBudget, recipe?: EnrichmentRecipe }
export interface EnrichedNode extends TreeNode { summary: string | null, summaryKind: 'model' | 'source-excerpt' | null }
export interface EnrichmentUsage { calls: number, inputChars: number, outputTokens: number, outputChars: number, inputTokens: number }
export interface EnrichmentResult {
  schemaVersion: 1, kind: 'tree-enrichment', enrichmentId: string, baseGenerationId: string, baseTreeHash: string, documentId: string, revisionId: string, sourceHash: string,
  representationId: string, representationHash: string, recipe: EnrichmentRecipe, navigationOnly: true, inputHash: string, resultHash: string,
  provider: { provider: string, model: string }, upstreamCommit: string, nodes: EnrichedNode[], usage: EnrichmentUsage,
  decisions: Array<{ nodeId: string, decision: 'expanded' | 'kept-collapsed', costBefore: number, costAfter: number }>,
}
export interface EnrichmentJob {
  schemaVersion: 1, kind: 'enrichment-job', jobId: string, conversationId: string, bindingId: string, runtimeSessionId: string, actorId: string, workspaceId: string, generation: number,
  request: EnrichmentStart, state: 'queued' | 'preparing' | 'generating' | 'completed' | 'failed' | 'cancelled', createdAt: string, updatedAt: string,
  result: EnrichmentResult | null, error: 'budget-exceeded' | 'invalid-output' | 'unavailable' | 'source-changed' | null,
}
export interface TreeSummaryPreview { nodeId: string, jobId: string, resultHash: string, preview: string, summaryKind: 'model' | 'source-excerpt', truncated: boolean }
export interface EnrichmentTree { schemaVersion: 1, kind: 'enrichment-tree', conversationId: string, generation: TreeGeneration, tree: TreePage, summaryPreviews?: TreeSummaryPreview[] }
interface EnrichmentReadIdentity {
  schemaVersion: 1, scopeVersionId: string, documentId: string, revisionId: string, sourceHash: string,
  representationId: string, representationHash: string, navigationOnly: true, offset: number, total: number, nextOffset: number | null,
}
export interface EnrichmentList extends EnrichmentReadIdentity {
  kind: 'enrichment-list',
  jobs: Array<{ jobId: string, enrichmentId: string, baseGenerationId: string, baseTreeHash: string, mode: 'summary' | 'expand' | 'full', nodeCount: number, resultHash: string }>,
}
export interface EnrichmentPage extends EnrichmentReadIdentity {
  kind: 'enrichment-page', jobId: string, enrichmentId: string, baseGenerationId: string, baseTreeHash: string,
  inputHash: string, resultHash: string, recipe: EnrichmentRecipe, nodes: EnrichedNode[],
}
export type EnrichmentValue = EnrichmentStart | EnrichmentJob | EnrichmentResult | EnrichmentTree | EnrichmentList | EnrichmentPage

/** After shape validation; a selected subtree or page can omit its base-tree ancestors. */
function enrichedNodeIssues(value: EnrichmentResult | EnrichmentPage): string[] {
  const issues = new Set<string>(), nodes = new Map<string, EnrichedNode>()
  for (const node of value.nodes) {
    if (nodes.has(node.nodeId) || !node.title.trim() || node.endPage < node.startPage || (node.summary === null) !== (node.summaryKind === null) || node.summary !== null && !node.summary.trim()) issues.add('node')
    if (!node.nodeId.startsWith(`${value.baseGenerationId}:`) && !node.nodeId.startsWith(`${value.enrichmentId}:`)) issues.add('node-lineage')
    nodes.set(node.nodeId, node)
  }
  for (const node of value.nodes) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId)
    if (node.parentId !== null && !node.parentId.startsWith(`${value.baseGenerationId}:`) && !node.parentId.startsWith(`${value.enrichmentId}:`)) issues.add('node-hierarchy')
    if (value.kind === 'tree-enrichment' && node.parentId?.startsWith(`${value.enrichmentId}:`) && !parent) issues.add('node-hierarchy')
    if (parent && (node.startPage < parent.startPage || node.endPage > parent.endPage)) issues.add('node-parent-range')
    const ancestors = new Set([node.nodeId])
    let current = parent
    while (current) {
      if (ancestors.has(current.nodeId)) { issues.add('node-hierarchy'); break }
      ancestors.add(current.nodeId)
      current = current.parentId === null ? undefined : nodes.get(current.parentId)
    }
  }
  return [...issues]
}

export function enrichmentIssues(value: EnrichmentValue): string[] {
  const issues: string[] = []
  if (value.kind === 'enrichment-tree') {
    issues.push(...treeIndexIssues(value.generation), ...treeIndexIssues(value.tree))
    if (value.tree.generationId !== value.generation.generationId || value.tree.treeHash !== value.generation.treeHash || value.tree.total !== value.generation.nodeCount) issues.push('tree-identity')
    const ids = new Set<string>(), nodes = new Set(value.tree.nodes.map(node => node.nodeId))
    for (const preview of value.summaryPreviews ?? []) {
      if (ids.has(preview.nodeId) || !nodes.has(preview.nodeId) || !preview.preview.trim()) issues.push('summary-preview')
      ids.add(preview.nodeId)
    }
  }
  if (value.kind === 'enrichment-start' && new Set(value.nodeIds).size !== value.nodeIds.length) issues.push('duplicate-target')
  if (value.kind === 'enrichment-job') {
    issues.push(...enrichmentIssues(value.request))
    if ((value.state === 'completed') !== (value.result !== null) || (value.state === 'failed') !== (value.error !== null)) issues.push('job-state')
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) issues.push('job-time')
    if (value.result) {
      issues.push(...enrichmentIssues(value.result))
      if (value.result.documentId !== value.request.documentId || value.result.revisionId !== value.request.revisionId) issues.push('job-source')
      if (value.result.recipe !== (value.request.recipe ?? 'docatlas-flash-enrichment.v1')) issues.push('job-recipe')
      const usage = value.result.usage, budget = value.request.budget
      let coveredPages = 0, coveredEnd = 0
      for (const node of [...value.result.nodes].sort((a, b) => a.startPage - b.startPage)) {
        coveredPages += Math.max(0, node.endPage - Math.max(coveredEnd, node.startPage - 1))
        coveredEnd = Math.max(coveredEnd, node.endPage)
      }
      if (usage.calls > budget.maxModelCalls || usage.inputChars > budget.maxInputChars || usage.outputTokens > budget.maxOutputTokens || usage.outputChars > budget.maxOutputChars || value.result.nodes.length > budget.maxNodes || coveredPages > budget.maxPages) issues.push('job-budget')
    }
  }
  if (value.kind === 'tree-enrichment') {
    issues.push(...enrichedNodeIssues(value))
    const ids = new Set(value.nodes.map(node => node.nodeId)), decisions = new Set<string>()
    for (const decision of value.decisions) {
      if (decisions.has(decision.nodeId) || !ids.has(decision.nodeId) || (decision.decision === 'expanded' ? decision.costAfter >= decision.costBefore : decision.costAfter !== decision.costBefore)) issues.push('expansion-cost')
      decisions.add(decision.nodeId)
    }
  }
  if (value.kind === 'enrichment-list' || value.kind === 'enrichment-page') {
    const length = value.kind === 'enrichment-list' ? value.jobs.length : value.nodes.length, end = value.offset + length
    if (end > value.total || value.nextOffset !== (end < value.total ? end : null) || (!length && end < value.total)) issues.push('pagination')
    if (value.kind === 'enrichment-page') issues.push(...enrichedNodeIssues(value))
    else if (new Set(value.jobs.map(job => job.jobId)).size !== value.jobs.length || new Set(value.jobs.map(job => job.enrichmentId)).size !== value.jobs.length) issues.push('duplicate-job')
  }
  return issues
}
