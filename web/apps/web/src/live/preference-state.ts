import { personalizationCommandIssues, personalizationCoreIssues, type EditableMemoryDraft, type PersonalizationCommandRequest,
  type PersonalizationInspectResult, type ProductPreferenceCommand, type ProductPreferenceCommandV2, type ProductPreferenceDraft, type ProductPreferenceResult, type ProductPreferenceResultV2 } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { LiveState } from './client'

export interface PreferenceIdentity { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number }
export interface PendingPreference { schemaVersion: 1, identity: PreferenceIdentity, profileId: string, request: ProductPreferenceCommand | ProductPreferenceCommandV2 }
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
export type PreferenceOutbox = { state: 'empty' } | { state: 'invalid', key: string }
  | { state: 'pending', key: string, value: PendingPreference, current: boolean }
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')

export const preferenceAxes = [
  { key: 'answer-order', label: '回答顺序', values: [['conclusion-first', '先说结论'], ['evidence-first', '先看证据']] },
  { key: 'explanation-depth', label: '解释深度', values: [['brief', '简洁'], ['standard', '适中'], ['teaching', '详细讲解']] },
  { key: 'preferred-representation', label: '阅读形式', values: [['pdf', '原始 PDF'], ['page-image', '原文页面图'], ['table', '表格'], ['comparison', '对照']] },
  { key: 'terminology-depth', label: '术语解释', values: [['professional', '保留专业术语'], ['explain-on-first-use', '首次出现时解释'], ['teaching', '逐步讲解']] },
  { key: 'artifact-format', label: '整理形式', values: [['brief', '简报'], ['matrix', '矩阵'], ['timeline', '时间线']] },
  { key: 'comparison-layout', label: '回答对照布局', values: [['side-by-side', '左右并排'], ['stacked', '上下排列']] },
] as const
export function preferenceLabel(effect: { key: string, value: string }): string {
  const axis = preferenceAxes.find(item => item.key === effect.key)
  return axis ? `${axis.label} · ${axis.values.find(value => value[0] === effect.value)?.[1] ?? effect.value}` : `${effect.key}: ${effect.value}`
}
export function preferenceIdentity(state: LiveState): PreferenceIdentity | null {
  const actor = state.actor, binding = state.snapshot?.binding
  if (state.phase !== 'ready' || !actor || !binding || binding.conversationId !== state.selected
    || binding.ownerActorId !== actor.actorId || binding.workspaceId !== actor.workspaceId) return null
  return { ...actor, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation }
}
export function preferencePrefix(identity: PreferenceIdentity): string {
  return `docatlas.live.draft.v1:${encodeURIComponent(identity.actorId)}:${encodeURIComponent(identity.workspaceId)}:@preferences:${encodeURIComponent(identity.conversationId)}:`
}
export function preferenceKey(identity: PreferenceIdentity): string { return `${preferencePrefix(identity)}${encodeURIComponent(identity.bindingId)}:${identity.generation}` }
/** Do not refresh an old body's erasure generation. Only the host can reconcile an exact erasure receipt. */
export function canRetryPreferenceAtEpoch(pending: PendingPreference, profileEpoch: number): boolean {
  const expected = pending.request.schemaVersion === 2 ? pending.request.expectedProfileEpoch : 0, command = pending.request.command
  return expected === profileEpoch || command.action === 'forget' && command.mode === 'privacy-erasure' && command.target === 'profile' && expected < profileEpoch
}
function sameOwner(left: PreferenceIdentity, right: PreferenceIdentity): boolean {
  return left.actorId === right.actorId && left.workspaceId === right.workspaceId && left.conversationId === right.conversationId
}
export function parsePendingPreference(raw: string, expected: PreferenceIdentity): PendingPreference {
  if (raw.length > 32768) throw new Error('Preference outbox is too large')
  const value = JSON.parse(raw) as PendingPreference
  if (!value || !exact(value, ['schemaVersion', 'identity', 'profileId', 'request']) || value.schemaVersion !== 1
    || !value.identity || !exact(value.identity, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation'])
    || ![value.identity.actorId, value.identity.workspaceId, value.identity.conversationId, value.identity.bindingId, value.profileId].every(opaque)
    || !Number.isSafeInteger(value.identity.generation) || value.identity.generation < 1 || !sameOwner(value.identity, expected)) throw new Error('Preference outbox identity is invalid')
  const request = parseBrowserContract(value.request?.schemaVersion === 1 ? 'product-personalization' : 'product-personalization-v2', value.request)
  if (request.kind !== 'preference-command' || request.expectedGeneration !== value.identity.generation) throw new Error('Preference outbox generation is invalid')
  return { ...value, request }
}
/** Reading a restored outbox never submits, repairs, rekeys or deletes it. */
export function readPreferenceOutbox(storage: PreferenceStorage, identity: PreferenceIdentity): PreferenceOutbox {
  if (storage.length > 2048) throw new Error('Too many tab-local drafts')
  const prefix = preferencePrefix(identity), keys: string[] = []
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key) }
  if (!keys.length) return { state: 'empty' }
  keys.sort()
  const key = keys[0]!
  if (keys.length > 1) return { state: 'invalid', key }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { state: 'invalid', key }
    const value = parsePendingPreference(raw, identity)
    if (preferenceKey(value.identity) !== key) return { state: 'invalid', key }
    return { state: 'pending', key, value, current: preferenceKey(value.identity) === preferenceKey(identity) }
  } catch { return { state: 'invalid', key } }
}
export function savePendingPreference(storage: PreferenceStorage, value: PendingPreference): void {
  const raw = JSON.stringify(value), checked = parsePendingPreference(raw, value.identity), key = preferenceKey(checked.identity)
  if (readPreferenceOutbox(storage, value.identity).state !== 'empty') throw new Error('A preference operation is still uncertain')
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Preference outbox was not retained')
}
function legacyDraft(draft: ProductPreferenceDraft, pending: PendingPreference): EditableMemoryDraft {
  return { memoryType: draft.effect.key === 'preferred-representation' ? 'reader-preference' : 'presentation-preference', effect: draft.effect,
    summary: `${draft.effect.key}: ${draft.effect.value}`, scope: draft.scope === 'global' ? { kind: 'global', profileId: pending.profileId }
      : { kind: 'workspace', profileId: pending.profileId, workspaceId: pending.identity.workspaceId }, sensitivity: 'ordinary', policy: { apply: 'disclose' } }
}
/** For receipt comparison only: these reconstructed host identity fields are never sent to the server. */
export function preferenceReceiptMatches(pending: PendingPreference, candidate: unknown): candidate is ProductPreferenceResult | ProductPreferenceResultV2 {
  try {
    const value = parseBrowserContract(pending.request.schemaVersion === 1 ? 'product-personalization' : 'product-personalization-v2', candidate), command = pending.request.command
    if (value.kind !== 'preference-result' || value.conversationId !== pending.identity.conversationId || value.result.profileId !== pending.profileId) return false
    const fields = command.action === 'set-preference' ? { ...command, preference: legacyDraft(command.preference, pending) }
      : command.action === 'edit' ? { ...command, replacement: legacyDraft(command.replacement, pending) } : command
    const request = { ...fields, schemaVersion: 1, requestType: 'personalization-command', profileId: pending.profileId, sessionId: pending.identity.conversationId,
      actor: { kind: 'user', actorId: pending.identity.actorId } } as PersonalizationCommandRequest
    return personalizationCommandIssues(value.result, request).length === 0
  } catch { return false }
}
export function acknowledgePreference(storage: PreferenceStorage, pending: PendingPreference, candidate: unknown): boolean {
  if (!preferenceReceiptMatches(pending, candidate)) return false
  const key = preferenceKey(pending.identity)
  if (storage.getItem(key) !== JSON.stringify(pending)) return false
  storage.removeItem(key)
  return true
}
export function recordedPreferenceUses(inspection: PersonalizationInspectResult) {
  const decisions = new Map(inspection.decisions.map(value => [value.decisionId, value]))
  return inspection.uses.flatMap(use => {
    const decision = decisions.get(use.decisionId)
    return decision && use.profileId === inspection.profileId && use.sessionId === inspection.sessionId
      && !personalizationCoreIssues(use, { decisions: [decision] }).length ? [{ use, decision }] : []
  })
}
export function preferenceExportUrl(conversationId: string, assetId: string): string {
  if (![conversationId, assetId].every(opaque)) throw new Error('Invalid preference export identity')
  return `/api/conversations/${encodeURIComponent(conversationId)}/preferences/exports/${encodeURIComponent(assetId)}`
}
