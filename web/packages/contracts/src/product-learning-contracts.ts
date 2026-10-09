import type { ProductBinding } from './product-control-contracts.js'
import { answerManifestIssues } from './answer-contracts.js'
import { personalizationCoreIssues, type MemoryCandidate, type PreferenceChoiceObservation, type PreferenceProbe } from './personalization-contracts.js'
import type { ProductProbeMaterial } from './product-probe-contracts.js'

export interface ProductLearningFrame { schemaVersion: 1, expectedBindingId: string, expectedGeneration: number }
export interface ProductLearningQuery extends ProductLearningFrame { kind: 'learning-query', messageId?: string }
interface LearningCommandBase extends ProductLearningFrame { kind: 'learning-command', expectedProfileEpoch: number, idempotencyKey: string }
export type ProductLearningCommand = LearningCommandBase & (
  | { action: 'configure', expectedSettingsVersion: number, enabled: boolean }
  | { action: 'prepare', expectedPolicyVersion: number, messageId: string, materialHash: string }
  | { action: 'choose', expectedPolicyVersion: number, messageId: string, materialHash: string, probeId: string, selected: string,
      scopeIntent: 'turn' | 'workspace', reasonTags: NonNullable<PreferenceChoiceObservation['reasonTags']> }
  | { action: 'dismiss', offerId: string, expectedOfferVersion: number }
  | { action: 'review', groupId: string, candidateId: string, expectedCandidateVersion: number, expectedGroupDigest: string, decision: 'accept' | 'reject' }
)
export interface ProductLearningSettings { version: number, enabled: boolean }
/** Trusted references only. A profile never owns a duplicate Answer or source body. */
export interface ProductLearningAnswerRef {
  profileEpoch: number, probeId: string, conversationId: string, messageId: string, manifestId: string, investigationId: string,
  sourceScopeVersionId: string, materialHash: string, nativeTextHash: string, mode: 'explore' | 'verify' | 'publish', turn: number,
}
export interface ProductLearningOffer { offerId: string, version: number, original: ProductLearningAnswerRef, status: 'offered' | 'dismissed', createdAt: string }
export interface ProductLearningMember { original: ProductLearningAnswerRef, observationId: string, value: 'conclusion-first' | 'evidence-first' }
export interface ProductLearningGroup {
  groupId: string, mode: ProductLearningAnswerRef['mode'], axis: 'answer-order',
  status: 'collecting' | 'conflicted' | 'candidate' | 'settled' | 'suppressed' | 'unavailable', digest: string | null,
  counts: { conclusionFirst: number, evidenceFirst: number, independentInvestigations: number } | null,
  members: ProductLearningMember[], candidate: MemoryCandidate | null,
}
export interface ProductLearningChoiceReceipt {
  idempotencyKey: string, requestHash: string, choice: PreferenceChoiceObservation, candidateId: string | null, groupId: string | null,
}
export interface ProductLearningComparison {
  reason: 'ready' | 'answer-unavailable' | 'no-evidence' | 'too-large', material: ProductProbeMaterial | null,
  probe: PreferenceProbe | null, choiceReceipt: ProductLearningChoiceReceipt | null,
}
export interface ProductLearningView {
  schemaVersion: 1, kind: 'learning-view', binding: ProductBinding, profileId: string, profileEpoch: number,
  settings: ProductLearningSettings, contributionAllowed: boolean, policyVersion: number,
  offers: ProductLearningOffer[], groups: ProductLearningGroup[], messageId: string | null, comparison: ProductLearningComparison | null,
}
/** Immutable original-operation metadata; subsequent aggregation cannot fill in old null candidate IDs. */
export interface ProductLearningReceipt {
  schemaVersion: 1, kind: 'learning-receipt', operationId: string, idempotencyKey: string, requestHash: string,
  actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number, profileEpoch: number,
  action: ProductLearningCommand['action'], committedAt: string, targetId: string, targetVersion: number,
  groupId: string | null, candidateId: string | null, memoryVersionId: string | null,
}
export interface ProductLearningOperation {
  schemaVersion: 1, kind: 'learning-operation', binding: ProductBinding, profileId: string, profileEpoch: number,
  operationId: string, receipt: ProductLearningReceipt | null,
}
export type ProductLearningValue = ProductLearningQuery | ProductLearningCommand | ProductLearningView | ProductLearningOperation | ProductLearningReceipt

/** Shape validation first; cryptographic material/group proofs and source permission remain host/Core duties. */
export function productLearningIssues(value: ProductLearningValue): string[] {
  const issues: string[] = []
  if (value.kind === 'learning-command' && value.action === 'choose') {
    if (['both', 'neither', 'dismissed'].includes(value.selected) && value.scopeIntent !== 'turn') issues.push('learning-choice-scope')
    if (new Set(value.reasonTags).size !== value.reasonTags.length) issues.push('learning-reasons')
  }
  if (value.kind === 'learning-receipt') {
    if (value.action !== 'review' && value.memoryVersionId !== null) issues.push('learning-activation')
    if (!['choose', 'review'].includes(value.action) && (value.candidateId !== null || value.groupId !== null)) issues.push('learning-receipt-action')
    if (value.action === 'review' && (value.candidateId !== value.targetId || !value.groupId || value.targetVersion < 2)) issues.push('learning-review-receipt')
    if (['prepare', 'choose'].includes(value.action) && value.targetVersion !== 1) issues.push('learning-receipt-version')
  }
  if (value.kind === 'learning-operation' && value.receipt) {
    const r = value.receipt, b = value.binding
    issues.push(...productLearningIssues(r))
    if (r.operationId !== value.operationId || r.actorId !== b.ownerActorId || r.workspaceId !== b.workspaceId || r.conversationId !== b.conversationId
      || r.profileEpoch !== value.profileEpoch || r.generation > b.generation || r.generation === b.generation && r.bindingId !== b.bindingId) issues.push('learning-operation-owner')
  }
  if (value.kind === 'learning-view') {
    if (value.settings.version === 0 && value.settings.enabled) issues.push('learning-default-consent')
    if ((value.messageId === null) !== (value.comparison === null)) issues.push('learning-comparison-target')
    if (new Set(value.offers.map(offer => offer.offerId)).size !== value.offers.length || new Set(value.groups.map(group => group.groupId)).size !== value.groups.length
      || new Set(value.groups.map(group => group.mode)).size !== value.groups.length) issues.push('learning-duplicates')
    for (const offer of value.offers) if (offer.original.profileEpoch !== value.profileEpoch || offer.original.conversationId !== value.binding.conversationId) issues.push('learning-offer-owner')
    for (const group of value.groups) {
      if (group.status === 'unavailable' || group.status === 'suppressed') {
        if (group.digest !== null || group.counts !== null || group.members.length || group.candidate !== null) issues.push('learning-hidden-group')
        continue
      }
      if (group.digest === null || group.counts === null) issues.push('learning-group-state')
      if (new Set(group.members.map(member => member.observationId)).size !== group.members.length) issues.push('learning-member-duplicate')
      if (group.members.some(member => member.original.profileEpoch !== value.profileEpoch || member.original.mode !== group.mode)) issues.push('learning-group-owner')
      const supporting = (selected: string) => new Set(group.members.filter(member => member.value === selected).map(member => member.original.investigationId)).size
      if (group.counts && (group.counts.conclusionFirst !== supporting('conclusion-first') || group.counts.evidenceFirst !== supporting('evidence-first')
        || group.counts.independentInvestigations !== new Set(group.members.map(member => member.original.investigationId)).size)) issues.push('learning-group-counts')
      if (group.status === 'conflicted' && (!group.counts?.conclusionFirst || !group.counts.evidenceFirst)) issues.push('learning-conflict-state')
      if (group.status === 'candidate' && (!group.candidate || Math.max(group.counts?.conclusionFirst ?? 0, group.counts?.evidenceFirst ?? 0) < 3
        || !!group.counts?.conclusionFirst && !!group.counts.evidenceFirst || !['pending', 'needs-review'].includes(group.candidate.decision))) issues.push('learning-candidate-state')
      if (group.candidate) {
        const c = group.candidate
        if (personalizationCoreIssues(c).length || c.profileId !== value.profileId || c.formation !== 'preference-probe' || c.proposedEffect.key !== 'answer-order'
          || c.proposedScope.kind !== 'workspace' || c.proposedScope.workspaceId !== value.binding.workspaceId || c.proposedScope.profileId !== value.profileId
          || c.independentLineageCount < 3 || c.risk !== 'low' || c.sensitivity !== 'ordinary') issues.push('learning-candidate')
      }
    }
    const comparison = value.comparison
    if (comparison) {
      const material = comparison.material, probe = comparison.probe
      if ((comparison.reason === 'ready') !== (material !== null) || !material && (probe !== null || comparison.choiceReceipt !== null)) issues.push('learning-material-state')
      if (material && (answerManifestIssues(material.manifest).length || material.manifest.messageId !== value.messageId
        || material.manifest.sessionId !== value.binding.conversationId || material.manifest.workspaceId !== value.binding.workspaceId)) issues.push('learning-material-owner')
      if (probe && (personalizationCoreIssues(probe).length || !probe.probeId.startsWith('learning-probe:') || probe.profileId !== value.profileId
        || probe.trigger !== 'user-requested' || probe.axis !== 'answer-order' || probe.sessionId !== value.binding.conversationId
        || probe.backbone.factTraceDigest !== material?.materialHash || probe.backbone.sourceScopeVersionId !== material?.manifest.sourceScopeVersionId
        || probe.investigationId !== material?.manifest.investigationId || probe.turn !== material?.manifest.turn)) issues.push('learning-probe')
      const receipt = comparison.choiceReceipt
      if (receipt && (!probe || receipt.choice.probeId !== probe.probeId || personalizationCoreIssues(receipt.choice, { probes: probe ? [probe] : [] }).length
        || receipt.choice.profileId !== value.profileId || receipt.choice.scopeIntent === 'turn' && (receipt.candidateId !== null || receipt.groupId !== null))) issues.push('learning-choice-receipt')
    }
  }
  return issues
}
