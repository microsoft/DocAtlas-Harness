import type { MemoryCandidate, PersonalizationObservation, PreferenceChoiceObservation, PreferenceProbe } from '@docatlas/contracts'
import type { PersonalizationTransactionGuard } from '../storage/personalization-store.js'

export const LEARNING_INVITATION_COOLDOWN_MS = 10 * 60_000
export const MAX_LEARNING_MEMBERS = 64
export type LearningMode = 'explore' | 'verify' | 'publish'
export type LearningValue = 'conclusion-first' | 'evidence-first'
export interface LearningAnswerRef {
  profileEpoch: number, probeId: string, workspaceId: string, conversationId: string, messageId: string,
  manifestId: string, investigationId: string, sourceScopeVersionId: string, materialHash: string,
  nativeTextHash: string, mode: LearningMode, turn: number
}
export interface LearningCommandIdentity {
  idempotencyKey: string, requestHash: string, actorId: string, workspaceId: string,
  conversationId: string, bindingId: string, generation: number
}
/** Host-only exact original publication/material checks. False means unavailable as a whole;
 * integrity errors must propagate. This callback and assertCurrent are synchronous. */
export interface LearningGuard extends PersonalizationTransactionGuard {
  authorizeOrigins(references: readonly LearningAnswerRef[]): boolean
}
export interface LearningSettings { version: number, enabled: boolean }
export interface LearningOffer {
  offerId: string, profileId: string, profileEpoch: number, version: number, status: 'offered' | 'dismissed',
  original: LearningAnswerRef, createdAt: string, updatedAt: string
}
export interface LearningReceipt {
  schemaVersion: 1, operationId: string, profileId: string, profileEpoch: number, command: LearningCommandIdentity,
  action: 'settings' | 'prepare' | 'choice' | 'review' | 'dismiss', committedAt: string,
  targetId: string, targetVersion: number, groupId: string | null, candidateId: string | null,
  memoryVersionId: string | null
}
export interface LearningMember {
  original: LearningAnswerRef, choiceObservationId: string, observationId: string,
  selectedValue: LearningValue
}
export interface LearningState {
  groupId: string, profileEpoch: number, workspaceId: string, axis: 'answer-order', mode: LearningMode,
  status: 'collecting' | 'pending' | 'conflicted' | 'suppressed' | 'unavailable',
  suppression: 'existing-preference' | 'existing-candidate' | 'decided-candidate' | 'forgotten' | null,
  members: LearningMember[], independentCounts: Record<LearningValue, number> | null,
  candidate: MemoryCandidate | null, groupDigest: string | null
}
export interface LearningChoiceInput {
  command: LearningCommandIdentity, choice: PreferenceChoiceObservation,
  observation: PersonalizationObservation, original: LearningAnswerRef
}
export interface LearningPrepareInput { probe: PreferenceProbe, original: LearningAnswerRef, command: LearningCommandIdentity }
export interface LearningReviewInput {
  command: LearningCommandIdentity, groupId: string, candidateId: string, expectedCandidateVersion: number,
  expectedGroupDigest: string, decision: 'accept' | 'reject'
}
