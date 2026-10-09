import { artifactManifestIssues, type ArtifactManifest, type ClaimUseKind } from './artifact-contracts.js'
import { claimVersionIssues, type ClaimVersion, type ClaimBasis, type ClaimEpistemicStatus, type ClaimReviewStatus, type ClaimProposition, type ClaimScope,
  type EvidenceRelation, type EvidenceRelationKind, type DerivationActivity, type DerivationOperation } from './claim-contracts.js'
import { reviewResultIssues, type ReviewResult } from './review-contracts.js'
import { m4RpcIssues, type M4HumanReviewDecision, type M4RpcResult } from './m4-rpc-contracts.js'
import type { SourceScopeVersion } from './m0-contracts.js'
import { productAnswerIssues, type CitationFocus } from './product-answer-contracts.js'
import type { ProductSourceRef } from './product-control-contracts.js'

export interface ProductReviewEvidence {
  evidenceId: string
  documentId: string
  revisionId: string
  physicalPage: number
  sourceName: string
  /** Bounded display text, never a replacement canonical EvidenceAtom. */
  preview: string
  contentHash: string
}
export interface ProductReviewWorkspace {
  schemaVersion: 1
  kind: 'review-workspace'
  conversationId: string
  bindingId: string
  generation: number
  scope: SourceScopeVersion | null
  scopeOptions: Array<{ scopeVersionId: string, version: number, sourceCount: number, current: boolean, sourceRefs?: ProductSourceRef[] }>
  claims: ClaimVersion[]
  evidenceRelations: EvidenceRelation[]
  derivations: DerivationActivity[]
  evidence: ProductReviewEvidence[]
  /** Verified first-creation order, oldest first. Publishing an existing manifest does not move it. */
  artifacts: ArtifactManifest[]
  /** Verified review append order, oldest first. IDs and timestamps are not chronology. */
  reviews: ReviewResult[]
  /** Journal append order, oldest first. Timestamps/IDs are not a total ordering. */
  decisions: M4HumanReviewDecision[]
  truncated: boolean
}
interface CommandBase {
  schemaVersion: 1
  kind: 'review-command'
  expectedGeneration: number
  scopeVersionId: string
  idempotencyKey: string
}
export type ProductReviewCommand = CommandBase & (
  | { action: 'claim-save', expectedClaimVersionId: string | null, statement: string, basis: ClaimBasis,
    epistemicStatus: ClaimEpistemicStatus, reviewStatus: ClaimReviewStatus, proposition?: ClaimProposition,
    claimScope?: Omit<ClaimScope, 'sourceScopeVersionId'>,
    evidenceRelations: Array<{ evidenceId: string, kind: EvidenceRelationKind, coverage: 'full' | 'partial', rationale?: string }>,
    derivation: { operation: DerivationOperation, inputClaimVersionIds: string[], expression?: string, rounding?: DerivationActivity['rounding'] } }
  | { action: 'artifact-create', artifactKind: 'brief' | 'matrix', title: string, claims: Array<{ claimVersionId: string, useKind: ClaimUseKind }> }
  | { action: 'review-attest', artifactManifestId: string, attestation: 'listed-evidence-reviewed' }
  | { action: 'review-run', artifactManifestId: string }
  | { action: 'review-decide', reviewResultId: string, decision: 'approved' | 'rejected', rationale?: string }
  | { action: 'artifact-publish', artifactManifestId: string, reviewResultId: string, humanReviewDecisionId: string }
)
export interface ProductReviewResult {
  schemaVersion: 1
  kind: 'review-result'
  conversationId: string
  idempotencyKey: string
  requestHash: string
  result: M4RpcResult
}
export interface ProductReviewFocus extends Omit<CitationFocus, 'kind' | 'messageId' | 'citationId'> {
  kind: 'review-focus'
  scopeVersionId: string
  evidenceId: string
}
export type ProductReviewValue = ProductReviewWorkspace | ProductReviewCommand | ProductReviewResult | ProductReviewFocus

export function productReviewIssues(value: ProductReviewValue): string[] {
  const issues: string[] = [], duplicate = (values: string[]) => new Set(values).size !== values.length
  if (value.kind === 'review-command') {
    if (value.action === 'claim-save') {
      if (!value.statement.trim()) issues.push('review-statement')
      if (value.derivation.operation === 'calculate' && (!value.derivation.expression?.trim() || !value.derivation.rounding)) issues.push('review-calculation')
      if (duplicate(value.derivation.inputClaimVersionIds) || duplicate(value.evidenceRelations.map(item => `${item.evidenceId}:${item.kind}`))) issues.push('review-input-duplicate')
      if (value.basis === 'document-supported' && !value.evidenceRelations.length || value.basis === 'derived-from-claims' && !value.derivation.inputClaimVersionIds.length) issues.push('review-input-missing')
    }
    if (value.action === 'artifact-create' && (!value.title.trim() || duplicate(value.claims.map(item => item.claimVersionId)))) issues.push('review-artifact-input')
  } else if (value.kind === 'review-result') {
    if (m4RpcIssues(value.result).length) issues.push('review-result-integrity')
  } else if (value.kind === 'review-workspace') {
    if (!value.scope && [value.claims, value.evidenceRelations, value.derivations, value.evidence, value.artifacts, value.reviews, value.decisions].some(items => items.length)) issues.push('review-unscoped-data')
    if (value.scope && !value.scopeOptions.some(item => item.scopeVersionId === value.scope!.scopeVersionId)) issues.push('review-scope-missing')
    if (value.scopeOptions.some(item => item.sourceRefs && (item.sourceRefs.length !== item.sourceCount || new Set(item.sourceRefs.map(ref => `${ref.documentId}:${ref.revisionId}`)).size !== item.sourceRefs.length))) issues.push('review-scope-sources')
    if (duplicate(value.scopeOptions.map(item => item.scopeVersionId)) || duplicate(value.claims.map(item => item.claimVersionId))
      || duplicate(value.evidenceRelations.map(item => item.evidenceRelationId)) || duplicate(value.derivations.map(item => item.derivationActivityId))
      || duplicate(value.evidence.map(item => item.evidenceId)) || duplicate(value.artifacts.map(item => item.artifactManifestId))
      || duplicate(value.reviews.map(item => item.reviewResultId)) || duplicate(value.decisions.map(item => item.reviewDecisionId))) issues.push('review-object-duplicate')
    if (value.claims.some(claim => claimVersionIssues(claim).length) || value.artifacts.some(artifact => {
      const review = artifact.publication ? value.reviews.find(review => review.reviewResultId === artifact.publication!.reviewResultId) : undefined
      return artifactManifestIssues(artifact, review ? { reviewResult: review } : {}).length > 0
    })
      || value.reviews.some(review => reviewResultIssues(review).length)) issues.push('review-object-integrity')
    if (value.scope) {
      const scope = value.scope
      if ([...value.claims, ...value.evidenceRelations, ...value.derivations, ...value.artifacts, ...value.reviews, ...value.decisions]
        .some(item => item.workspaceId !== scope.workspaceId || item.investigationId !== scope.investigationId)) issues.push('review-owner')
      if (value.claims.some(item => item.scope.sourceScopeVersionId !== scope.scopeVersionId)
        || value.artifacts.some(item => item.sourceScopeVersionId !== scope.scopeVersionId) || value.reviews.some(item => item.sourceScopeVersionId !== scope.scopeVersionId)) issues.push('review-scope')
    }
  } else if (productAnswerIssues({ ...value, kind: 'citation-focus', messageId: 'review:focus', citationId: value.evidenceId }).length) issues.push('review-focus')
  return issues
}
