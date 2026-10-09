import { personalizationCommandIssues, type PersonalizationCommandRequest, type PersonalizationCommandResult, type PersonalizationEffect } from './personalization-contracts.js'
import { personalizationInspectIssues, type PersonalizationInspectResult } from './personalization-inspect-contracts.js'
import type { ProductPersonalizationV2Value } from './product-personalization-v2-contracts.js'

export type ExplicitPreferenceEffect = Exclude<Extract<PersonalizationEffect, { key: 'answer-order' | 'explanation-depth' | 'terminology-depth' | 'artifact-format' | 'comparison-layout' }>, never>
  | { key: 'preferred-representation', value: 'pdf' | 'page-image' | 'table' | 'comparison' }
export interface ProductPreferenceDraft { effect: ExplicitPreferenceEffect, scope: 'global' | 'workspace' }
type PlainCommand<T> = T extends { action: 'set-session-policy' | 'resume' | 'forget' | 'export' } ? Omit<T, 'schemaVersion' | 'requestType' | 'profileId' | 'sessionId' | 'actor'> : never
export type ProductPreferenceAction = PlainCommand<PersonalizationCommandRequest>
  | { action: 'set-preference', idempotencyKey: string, preference: ProductPreferenceDraft }
  | { action: 'pause', idempotencyKey: string, memoryVersionId: string, expectedVersion: number }
  | { action: 'edit', idempotencyKey: string, memoryVersionId: string, expectedVersion: number, replacement: ProductPreferenceDraft, statusAfterEdit: 'active' | 'paused' }
export interface ProductPreferenceCommand { schemaVersion: 1, kind: 'preference-command', expectedGeneration: number, command: ProductPreferenceAction }
export interface ProductPreferenceInspection {
  schemaVersion: 1, kind: 'preference-inspection', conversationId: string, modelApplication: 'not-connected', result: PersonalizationInspectResult
}
export interface ProductPreferenceResult { schemaVersion: 1, kind: 'preference-result', conversationId: string, result: PersonalizationCommandResult }
export type ProductPersonalizationValue = ProductPreferenceCommand | ProductPreferenceInspection | ProductPreferenceResult
export function productPersonalizationIssues(value: ProductPersonalizationValue | ProductPersonalizationV2Value): string[] {
  if (value.kind === 'preference-inspection') return [...personalizationInspectIssues(value.result).map(issue => issue.code),
    ...(value.result.sessionId === value.conversationId ? [] : ['preference-session'])]
  if (value.kind === 'preference-result') {
    const result = value.result, issues = personalizationCommandIssues(result).map(issue => String(issue.code))
    if ('sessionPolicy' in result && (result.sessionPolicy.profileId !== result.profileId || result.sessionPolicy.sessionId !== value.conversationId)) issues.push('preference-session')
    if ('memoryVersion' in result && result.memoryVersion && result.memoryVersion.profileId !== result.profileId) issues.push('preference-profile')
    if ('candidate' in result && result.candidate.profileId !== result.profileId) issues.push('preference-profile')
    return issues
  }
  return []
}
