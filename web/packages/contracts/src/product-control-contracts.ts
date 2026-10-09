/** Product control v1. Never reinterpret legacy DSH session/turn fields. */
export type ProductRunState = 'accepted' | 'preparing' | 'ready' | 'dispatching' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'
export type ProductSubmissionMode = 'prompt' | 'steer' | 'follow-up'
export type ProductRunError = 'preparation-failed' | 'runtime-rejected' | 'runtime-failed' | 'execution-interrupted' | 'checkpoint-failed' | 'stale-binding' | 'selection-invalid' | 'source-unavailable' | 'internal'
export interface ProductSourceRef { documentId: string, revisionId: string }
export interface ProductBinding {
  schemaVersion: 1
  kind: 'binding'
  bindingId: string
  conversationId: string
  workspaceId: string
  ownerActorId: string
  investigationId: string | null
  runtimeSessionId: string
  branchEntryId: string | null
  generation: number
  version: number
  createdAt: string
  updatedAt: string
}
export interface ProductSubmission {
  schemaVersion: 1
  kind: 'submission'
  conversationId: string
  idempotencyKey: string
  expectedGeneration: number
  mode: ProductSubmissionMode
  text: string
  sourceRefs: ProductSourceRef[]
  selectionContextIds: string[]
  /** Explicit per-question product retrieval policy, included in the original request hash. */
  documentSearch?: { recipe: 'tree-search.v1', strategy: 'fts' | 'tree' | 'combined' }
}
export interface ProductPreparedSubmission {
  schemaVersion: 1
  kind: 'prepared'
  submissionId: string
  requestHash: string
  bindingGeneration: number
  scopeVersionId: string | null
  sourceRefs: ProductSourceRef[]
  selectionContextIds: string[]
}
export interface ProductPiCheckpoint {
  schemaVersion: 1
  kind: 'pi-checkpoint'
  submissionId: string
  requestHash: string
  runtimeSessionId: string
  userEntryId: string
  leafEntryId: string
  transcriptHash: string
  byteLength: number
  entryCount: number
  settledAt: string
}
export interface ProductRunReceipt {
  schemaVersion: 1
  kind: 'run-receipt'
  submissionId: string
  runId: string
  conversationId: string
  generation: number
  mode: ProductSubmissionMode
  state: ProductRunState
  version: number
  requestHash: string
  createdAt: string
  updatedAt: string
  payloadRetained: boolean
  errorCode?: ProductRunError
  checkpoint?: ProductPiCheckpoint
}
export interface ProductRunTransition { schemaVersion: 1, kind: 'run-transition', from: ProductRunState, to: ProductRunState }
export type ProductControlValue = ProductBinding | ProductSubmission | ProductPreparedSubmission | ProductPiCheckpoint | ProductRunReceipt | ProductRunTransition

/** Call after JSON Schema shape validation. Codes are shared with Python fixtures. */
export function productControlIssues(value: ProductControlValue): string[] {
  const issues: string[] = []
  if (value.kind === 'submission' && !value.text.trim()) issues.push('empty-text')
  if ((value.kind === 'run-receipt' || value.kind === 'binding') && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) issues.push('time-order')
  if (value.kind === 'prepared' && value.scopeVersionId === null && (value.sourceRefs.length || value.selectionContextIds.length)) issues.push('missing-scope')
  if (value.kind === 'pi-checkpoint' && value.userEntryId === value.leafEntryId) issues.push('checkpoint-entries')
  if (value.kind === 'run-receipt' && value.checkpoint) {
    if (value.checkpoint.submissionId !== value.submissionId || value.checkpoint.requestHash !== value.requestHash) issues.push('checkpoint-binding')
    if (Date.parse(value.checkpoint.settledAt) < Date.parse(value.createdAt) || Date.parse(value.checkpoint.settledAt) > Date.parse(value.updatedAt)) issues.push('checkpoint-time')
    issues.push(...productControlIssues(value.checkpoint))
  }
  return issues
}
