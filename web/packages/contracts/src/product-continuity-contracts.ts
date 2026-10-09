import { continuityRpcIssues, type ContinuityAssessResult, type ContinuityState, type RevisionImpact } from './continuity-contracts.js'
import type { ProductSourceRef } from './product-control-contracts.js'
import type { ProductReviewEvidence } from './product-review-contracts.js'
import type { ResearchRecordType } from './research-recall-contracts.js'

interface RequestBase { schemaVersion: 1, expectedGeneration: number }
export interface ProductContinuityInspect extends RequestBase {
  kind: 'continuity-inspect'
  recordId: string
  scopeVersionId?: string
}
export interface ProductContinuityImpact extends RequestBase {
  kind: 'continuity-impact'
  recordId: string
  previousSource: ProductSourceRef
  currentSource: ProductSourceRef
}
export interface ProductContinuityAssess extends RequestBase {
  kind: 'continuity-assess'
  scopeVersionId: string
  priorRecordId: string
  expectedPriorVersion: number
  currentSources: ProductSourceRef[]
  priorEvidenceIds: string[]
  currentEvidenceIds: string[]
  proposedState: ContinuityState
  rationale: string
  idempotencyKey: string
}
export interface ProductContinuityRecord {
  recordId: string
  recordType: ResearchRecordType | 'claim-version' | 'artifact-brief' | 'artifact-matrix'
  version: number
  scopeVersionId: string
  sourceReferencesComplete: boolean
  /** Display metadata, never authorization or a new source admission. */
  sources: Array<ProductSourceRef & { name: string }>
}
export interface ProductContinuityInspection {
  schemaVersion: 1
  kind: 'continuity-inspection'
  conversationId: string
  bindingId: string
  generation: number
  record: ProductContinuityRecord
  scopeVersionId: string | null
  scopeOptions: Array<{ scopeVersionId: string, version: number, sourceCount: number, current: boolean }>
  evidence: ProductReviewEvidence[]
  /** Only the selected Evidence material is incomplete; unrelated history does not disable comparison. */
  truncated: boolean
  /** Bounded authorized history options, never a total or a count of hidden records. */
  scopeOptionsTruncated: boolean
}
export interface ProductContinuityImpactResult {
  schemaVersion: 1
  kind: 'continuity-impact-result'
  conversationId: string
  bindingId: string
  generation: number
  recordId: string
  recordVersion: number
  previousSource: ProductSourceRef
  currentSource: ProductSourceRef
  dependencyOnly: true
  status: RevisionImpact['status']
  reason: string
}
export interface ProductContinuityAssessment {
  schemaVersion: 1
  kind: 'continuity-assessment'
  conversationId: string
  bindingId: string
  generation: number
  idempotencyKey: string
  requestHash: string
  result: ContinuityAssessResult
}
export type ProductContinuityValue = ProductContinuityInspect | ProductContinuityImpact | ProductContinuityAssess
  | ProductContinuityInspection | ProductContinuityImpactResult | ProductContinuityAssessment

const key = (source: ProductSourceRef) => `${source.documentId}\0${source.revisionId}`
const duplicate = (values: string[]) => new Set(values).size !== values.length
export function productContinuityIssues(value: ProductContinuityValue): string[] {
  const issues: string[] = []
  if (value.kind === 'continuity-impact' || value.kind === 'continuity-impact-result') {
    if (value.previousSource.documentId !== value.currentSource.documentId || value.previousSource.revisionId === value.currentSource.revisionId) issues.push('continuity-revisions')
  }
  if (value.kind === 'continuity-assess') {
    if (duplicate(value.currentSources.map(key)) || duplicate(value.priorEvidenceIds) || duplicate(value.currentEvidenceIds)) issues.push('continuity-input-duplicate')
    if (!value.rationale.trim()) issues.push('continuity-rationale')
    if (value.proposedState !== 'unknown' && (!value.priorEvidenceIds.length || !value.currentEvidenceIds.length)) issues.push('continuity-evidence-required')
  }
  if (value.kind === 'continuity-inspection') {
    if (duplicate(value.record.sources.map(key)) || duplicate(value.scopeOptions.map(item => item.scopeVersionId)) || duplicate(value.evidence.map(item => item.evidenceId))) issues.push('continuity-view-duplicate')
    if (value.scopeOptions.filter(item => item.current).length > 1) issues.push('continuity-current-scope')
    if (value.scopeVersionId === null ? value.evidence.length > 0 || value.scopeOptions.length > 0 : !value.scopeOptions.some(item => item.scopeVersionId === value.scopeVersionId)) issues.push('continuity-view-scope')
  }
  if (value.kind === 'continuity-assessment') {
    if (continuityRpcIssues(value.result).length) issues.push('continuity-result-integrity')
    if (value.result.link.priorRecordVersion === undefined) issues.push('continuity-version-pin')
    if (value.result.link.createdBy.kind !== 'user') issues.push('continuity-human-actor')
  }
  return issues
}
