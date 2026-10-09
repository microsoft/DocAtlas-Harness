import type { ProductContinuityAssess, ProductContinuityInspection, ProductContinuityRecord, ProductSourceRef } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { LiveState } from './client'
import { reviewIdentity, type ReviewIdentity, type ReviewStorage } from './review-state'
import { canonicalHash } from './state'

export interface ContinuityTarget { recordId: string, recordVersion: number, label?: string }
export interface ContinuityOpenRequest extends ContinuityTarget { id: number }
export interface ContinuityOwner extends ReviewIdentity { recordId: string }
export interface ContinuityPending { schemaVersion: 1, owner: ContinuityOwner, record: ProductContinuityRecord, request: ProductContinuityAssess }
export type ContinuityOutbox = { state: 'empty' } | { state: 'invalid', key: string }
  | { state: 'pending', key: string, value: ContinuityPending, current: boolean }
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
export const continuitySourceKey = (source: ProductSourceRef): string => JSON.stringify([source.documentId, source.revisionId])
const sourceSet = (sources: ProductSourceRef[]) => JSON.stringify(sources.map(continuitySourceKey).sort())
const evidenceSet = (ids: string[]) => JSON.stringify([...ids].sort())
export const continuityOwnerKey = (owner: ContinuityOwner): string => JSON.stringify([owner.actorId, owner.workspaceId, owner.conversationId, owner.bindingId, owner.generation, owner.recordId])
export function continuityOwner(state: LiveState, recordId: string): ContinuityOwner | null {
  const identity = reviewIdentity(state)
  return identity && opaque(recordId) ? { ...identity, recordId } : null
}
export function continuityPrefix(owner: ContinuityOwner): string {
  return `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@continuity:${encodeURIComponent(owner.conversationId)}:${encodeURIComponent(owner.recordId)}:`
}
export function continuityStorageKey(pending: ContinuityPending): string {
  return `${continuityPrefix(pending.owner)}${encodeURIComponent(pending.owner.bindingId)}:${pending.owner.generation}:${encodeURIComponent(pending.request.scopeVersionId)}`
}
export function parseContinuityPending(raw: string, owner: ContinuityOwner): ContinuityPending {
  if (new TextEncoder().encode(raw).byteLength > 131072) throw new Error('Continuity outbox exceeds its bound')
  const value = JSON.parse(raw) as ContinuityPending
  if (!value || !exact(value, ['schemaVersion', 'owner', 'record', 'request']) || value.schemaVersion !== 1 || !value.owner
    || !exact(value.owner, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation', 'recordId'])
    || ![value.owner.actorId, value.owner.workspaceId, value.owner.conversationId, value.owner.bindingId, value.owner.recordId].every(opaque)
    || !Number.isSafeInteger(value.owner.generation) || value.owner.generation < 1
    || value.owner.actorId !== owner.actorId || value.owner.workspaceId !== owner.workspaceId || value.owner.conversationId !== owner.conversationId || value.owner.recordId !== owner.recordId) throw new Error('Invalid continuity outbox owner')
  const request = parseBrowserContract('product-continuity', value.request)
  const record = parseBrowserContract('product-continuity', { schemaVersion: 1, kind: 'continuity-inspection', conversationId: value.owner.conversationId,
    bindingId: value.owner.bindingId, generation: value.owner.generation, record: value.record, scopeVersionId: null, scopeOptions: [], evidence: [], truncated: false, scopeOptionsTruncated: false })
  if (request.kind !== 'continuity-assess' || record.kind !== 'continuity-inspection' || request.expectedGeneration !== value.owner.generation
    || request.priorRecordId !== value.owner.recordId || record.record.recordId !== value.owner.recordId || request.expectedPriorVersion !== record.record.version
    || request.proposedState !== 'unknown' && !record.record.sourceReferencesComplete) throw new Error('Continuity request lost its original record version')
  return { ...value, request, record: record.record }
}
export function readContinuityOutbox(storage: ReviewStorage, owner: ContinuityOwner): ContinuityOutbox {
  if (storage.length > 2048) throw new Error('Too many tab drafts')
  const prefix = continuityPrefix(owner), keys: string[] = []
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key) }
  if (!keys.length) return { state: 'empty' }
  keys.sort(); const key = keys[0]!
  if (keys.length !== 1) return { state: 'invalid', key }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { state: 'invalid', key }
    const value = parseContinuityPending(raw, owner)
    return continuityStorageKey(value) === key ? { state: 'pending', key, value, current: continuityOwnerKey(value.owner) === continuityOwnerKey(owner) } : { state: 'invalid', key }
  } catch { return { state: 'invalid', key } }
}
export function saveContinuityPending(storage: ReviewStorage, value: ContinuityPending): void {
  const raw = JSON.stringify(value); parseContinuityPending(raw, value.owner)
  if (readContinuityOutbox(storage, value.owner).state !== 'empty') throw new Error('A continuity assessment remains uncertain')
  const key = continuityStorageKey(value); storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Continuity outbox was not retained')
}
export async function continuityReceiptMatches(pending: ContinuityPending, candidate: unknown): Promise<boolean> {
  try {
    const value = parseBrowserContract('product-continuity', candidate), { owner, request, record } = pending
    if (value.kind !== 'continuity-assessment' || value.conversationId !== owner.conversationId || value.bindingId !== owner.bindingId || value.generation !== owner.generation
      || value.idempotencyKey !== request.idempotencyKey || value.requestHash !== await canonicalHash(request)) return false
    const link = value.result.link
    return link.workspaceId === owner.workspaceId && link.createdBy.kind === 'user' && link.createdBy.actorId === owner.actorId
      && link.priorRecordId === record.recordId && link.priorRecordVersion === record.version && link.scopeVersionId === request.scopeVersionId
      && sourceSet(link.priorSources) === sourceSet(record.sources) && sourceSet(link.currentSources) === sourceSet(request.currentSources)
      && evidenceSet(link.priorEvidenceIds) === evidenceSet(request.priorEvidenceIds) && evidenceSet(link.currentEvidenceIds) === evidenceSet(request.currentEvidenceIds)
      && link.state === request.proposedState && link.rationale === request.rationale
  } catch { return false }
}
export async function acknowledgeContinuity(storage: ReviewStorage, pending: ContinuityPending, result: unknown, isCurrent: () => boolean): Promise<boolean> {
  if (!await continuityReceiptMatches(pending, result)) return false
  const key = continuityStorageKey(pending)
  // Hashing yields: recheck the live owner and the exact retained body immediately before clearing.
  if (!isCurrent() || storage.getItem(key) !== JSON.stringify(pending)) return false
  storage.removeItem(key); return true
}
export function continuityReadSources(inspection: ProductContinuityInspection): Array<ProductSourceRef & { name: string }> {
  const result = new Map<string, ProductSourceRef & { name: string }>()
  for (const item of inspection.evidence) if (!result.has(continuitySourceKey(item))) result.set(continuitySourceKey(item), { documentId: item.documentId, revisionId: item.revisionId, name: item.sourceName })
  return [...result.values()]
}
export function mergeContinuitySources(existing: ProductSourceRef[], original: ProductSourceRef[]): ProductSourceRef[] {
  const result = existing.map(source => ({ ...source })), keys = new Set(existing.map(continuitySourceKey))
  for (const source of original) {
    if (![source.documentId, source.revisionId].every(opaque)) throw new Error('Invalid original revision')
    if (!keys.has(continuitySourceKey(source))) { result.push({ documentId: source.documentId, revisionId: source.revisionId }); keys.add(continuitySourceKey(source)) }
  }
  if (result.length > 32) throw new Error('Combined question exceeds the source limit')
  return result
}
export function continuityReadiness(inspection: ProductContinuityInspection, explicitScope: string, currentSources: ProductSourceRef[], priorIds: string[], currentIds: string[]): { unknown: boolean, comparative: boolean } {
  const scopeValid = !!explicitScope && inspection.scopeVersionId === explicitScope && inspection.scopeOptions.some(scope => scope.scopeVersionId === explicitScope)
  const available = new Set(continuityReadSources(inspection).map(continuitySourceKey)), current = new Set(currentSources.map(continuitySourceKey)), prior = new Set(inspection.record.sources.map(continuitySourceKey))
  const validSide = (ids: string[], sources: Set<string>) => new Set(ids).size === ids.length && ids.every(id => inspection.evidence.some(item => item.evidenceId === id && sources.has(continuitySourceKey(item))))
  const covers = (ids: string[], sources: Set<string>) => [...sources].every(key => ids.some(id => inspection.evidence.some(item => item.evidenceId === id && continuitySourceKey(item) === key)))
  const unknown = scopeValid && currentSources.length > 0 && currentSources.length <= 32 && current.size === currentSources.length && [...current].every(key => available.has(key))
    && validSide(priorIds, prior) && validSide(currentIds, current) && priorIds.length <= 64 && currentIds.length <= 64
  return { unknown, comparative: unknown && inspection.record.sourceReferencesComplete && !inspection.truncated && prior.size > 0 && priorIds.length > 0 && currentIds.length > 0 && covers(priorIds, prior) && covers(currentIds, current) }
}
