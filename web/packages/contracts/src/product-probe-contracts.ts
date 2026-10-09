import { answerManifestIssues, type AnswerManifest } from './answer-contracts.js'
import { personalizationCoreIssues, type MemoryCandidate, type PersonalizationCommandResult, type PreferenceChoiceObservation, type PreferenceProbe } from './personalization-contracts.js'

interface RequestBase { schemaVersion: 1, expectedGeneration: number, messageId: string }
interface MutationBase extends RequestBase { expectedProfileEpoch: number, expectedPolicyVersion: number }
export interface ProductProbeInspect extends RequestBase { kind: 'probe-inspect' }
export interface ProductProbePrepare extends MutationBase { kind: 'probe-prepare' }
export interface ProductProbeChoose extends MutationBase {
  kind: 'probe-choose'
  probeId: string
  idempotencyKey: string
  selected: string
  scopeIntent: 'turn' | 'workspace'
  reasonTags: NonNullable<PreferenceChoiceObservation['reasonTags']>
}
export interface ProductProbeReview extends RequestBase {
  kind: 'probe-review'
  expectedProfileEpoch: number
  probeId: string
  candidateId: string
  expectedCandidateVersion: number
  decision: 'accept' | 'reject'
  idempotencyKey: string
}
export interface ProductProbeMaterial { manifest: AnswerManifest, nativeTextHash: string, materialHash: string }
export interface ProductProbeChoiceReceipt {
  idempotencyKey: string
  requestHash: string
  choice: PreferenceChoiceObservation
  candidateId: string | null
}
interface ResponseBase { schemaVersion: 1, conversationId: string, bindingId: string, generation: number, profileEpoch: number, messageId: string }
export interface ProductProbeView extends ResponseBase {
  kind: 'probe-view'
  reason: 'ready' | 'answer-unavailable' | 'no-evidence' | 'too-large'
  contributionAllowed: boolean
  policyVersion: number
  material: ProductProbeMaterial | null
  probe: PreferenceProbe | null
  choiceReceipt: ProductProbeChoiceReceipt | null
  candidate: MemoryCandidate | null
}
export interface ProductProbeChoiceResult extends ResponseBase, ProductProbeChoiceReceipt {
  kind: 'probe-choice-result'
  probeId: string
  status: 'created' | 'replayed'
}
export interface ProductProbeReviewResult extends ResponseBase {
  kind: 'probe-review-result'
  probeId: string
  idempotencyKey: string
  requestHash: string
  result: Extract<PersonalizationCommandResult, { action: 'review-candidate' }>
}
export type ProductProbeValue = ProductProbeInspect | ProductProbePrepare | ProductProbeChoose | ProductProbeReview | ProductProbeView | ProductProbeChoiceResult | ProductProbeReviewResult

export function productProbeIssues(value: ProductProbeValue): string[] {
  const issues: string[] = []
  if (value.kind === 'probe-choose') {
    if (['both', 'neither', 'dismissed'].includes(value.selected) && value.scopeIntent !== 'turn') issues.push('probe-choice-scope')
    if (new Set(value.reasonTags).size !== value.reasonTags.length) issues.push('probe-reasons')
  }
  if (value.kind === 'probe-view') {
    if ((value.reason === 'ready') !== (value.material !== null) || !value.material && (value.probe || value.choiceReceipt || value.candidate)) issues.push('probe-material-state')
    if (value.material) {
      const manifest = value.material.manifest
      if (answerManifestIssues(manifest).length || manifest.messageId !== value.messageId || manifest.sessionId !== value.conversationId) issues.push('probe-answer')
    }
    if (value.probe) {
      if (personalizationCoreIssues(value.probe).length || value.probe.axis !== 'answer-order' || value.probe.trigger !== 'user-requested'
        || value.probe.sessionId !== value.conversationId || value.probe.backbone.factTraceDigest !== value.material?.materialHash
        || value.probe.backbone.sourceScopeVersionId !== value.material?.manifest.sourceScopeVersionId
        || value.probe.turn !== value.material?.manifest.turn) issues.push('probe-binding')
    }
    if (value.choiceReceipt && (!value.probe || value.choiceReceipt.choice.probeId !== value.probe.probeId
      || personalizationCoreIssues(value.choiceReceipt.choice, { probes: [value.probe] }).length)) issues.push('probe-receipt')
    if (value.candidate && (!value.choiceReceipt || value.choiceReceipt.candidateId !== value.candidate.candidateId
      || value.candidate.formation !== 'preference-probe' || value.candidate.proposedEffect.key !== 'answer-order'
      || value.candidate.proposedScope.kind !== 'workspace' || value.candidate.profileId !== value.probe?.profileId
      || personalizationCoreIssues(value.candidate).length)) issues.push('probe-candidate')
  }
  if (value.kind === 'probe-choice-result') {
    if (value.choice.probeId !== value.probeId || value.choice.sessionId !== value.conversationId || personalizationCoreIssues(value.choice).length) issues.push('probe-choice-identity')
    if (value.choice.scopeIntent === 'turn' && value.candidateId !== null) issues.push('probe-choice-scope')
  }
  if (value.kind === 'probe-review-result' && value.result.action !== 'review-candidate') issues.push('probe-review-kind')
  return issues
}
