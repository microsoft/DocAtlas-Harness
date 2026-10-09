import type { NativeLineageAction, NativeSelectedHead, ProductBinding, ProductLineageCommand, ProductLineageInspection, ProductLineageOperation, ProductNativeTreeEntry, ProductNativeTreePage } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { canonical, canonicalHash } from './state'
import { nativeIdentityKey, type NativeControlIdentity, type NativeControlStorage } from './native-control-state'

export type LineageOwner = Pick<NativeControlIdentity, 'actorId' | 'workspaceId' | 'conversationId'>
export interface LineagePending { schemaVersion: 1, identity: NativeControlIdentity, request: ProductLineageCommand, operationId: string | null }
export type LineageOutbox = { state: 'empty' } | { state: 'invalid', key: string, raw: string | null }
  | { state: 'pending', key: string, raw: string, value: LineagePending, current: boolean }
export interface LineageDraft { summarize: boolean, instructions: string, replaceInstructions: boolean, label: string }
export interface LineageTree { head: NativeSelectedHead, view: ProductNativeTreePage['view'], entries: ProductNativeTreeEntry[], nextCursor: string | null }
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
export const lineageScopeKey = (owner: LineageOwner): string => JSON.stringify([owner.actorId, owner.workspaceId, owner.conversationId])
export const lineageHeadKey = (head: NativeSelectedHead): string => canonical(head)
export const lineageDraft = (): LineageDraft => ({ summarize: false, instructions: '', replaceInstructions: false, label: '' })
export function lineageOwns(owner: LineageOwner, binding: ProductBinding): boolean {
  return owner.actorId === binding.ownerActorId && owner.workspaceId === binding.workspaceId && owner.conversationId === binding.conversationId
}
export function lineageBindingMatches(identity: NativeControlIdentity, binding: ProductBinding): boolean {
  return lineageOwns(identity, binding) && identity.bindingId === binding.bindingId && identity.generation === binding.generation && identity.nativeSessionId === binding.runtimeSessionId
}
export function checkedLineageInspection(identity: NativeControlIdentity, candidate: unknown): ProductLineageInspection {
  const value = parseBrowserContract('native-lineage', structuredClone(candidate))
  if (!('kind' in value) || value.kind !== 'lineage-inspection' || !lineageBindingMatches(identity, value.binding)) throw new Error('Lineage inspection changed owner or generation')
  return value
}
/** Host proofs remain authority for actual native bytes; the browser verifies all public bindings and the complete request hash. */
export async function checkedLineageOperation(owner: LineageOwner, candidate: unknown, operationId?: string): Promise<ProductLineageOperation> {
  const frozenOwner = { ...owner }, value = parseBrowserContract('native-lineage', structuredClone(candidate))
  if (!('kind' in value) || value.kind !== 'lineage-operation' || !lineageOwns(frozenOwner, value.sourceBinding)
    || operationId !== undefined && operationId !== value.operationId || value.requestHash !== await canonicalHash(value.request)) throw new Error('Lineage operation changed owner, identity or complete request hash')
  return value
}
export function lineageTerminalProof(operation: ProductLineageOperation): boolean {
  return operation.state === 'succeeded' && operation.result !== null || operation.state === 'failed' && operation.failureProof !== undefined
}
export function lineageOutboxPrefix(owner: LineageOwner): string {
  return `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@lineage:${encodeURIComponent(owner.conversationId)}:`
}
export function lineageStorageKey(pending: LineagePending): string {
  return `${lineageOutboxPrefix(pending.identity)}${encodeURIComponent(pending.request.idempotencyKey)}`
}
export function parseLineagePending(raw: string, owner: LineageOwner): LineagePending {
  if (new TextEncoder().encode(raw).byteLength > 32768) throw new Error('Lineage outbox exceeds its bound')
  const value = JSON.parse(raw) as LineagePending
  if (!value || !exact(value, ['schemaVersion', 'identity', 'request', 'operationId']) || value.schemaVersion !== 1 || !value.identity
    || !exact(value.identity, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation', 'nativeSessionId'])
    || ![value.identity.actorId, value.identity.workspaceId, value.identity.conversationId, value.identity.bindingId, value.identity.nativeSessionId].every(opaque)
    || !Number.isSafeInteger(value.identity.generation) || value.identity.generation < 1 || lineageScopeKey(value.identity) !== lineageScopeKey(owner)
    || value.operationId !== null && !opaque(value.operationId)) throw new Error('Invalid lineage outbox owner')
  const request = parseBrowserContract('native-lineage', value.request)
  if (!('kind' in request) || request.kind !== 'lineage-command' || request.conversationId !== value.identity.conversationId || request.expectedBindingId !== value.identity.bindingId
    || request.expectedGeneration !== value.identity.generation || request.runtimeSessionId !== value.identity.nativeSessionId) throw new Error('Lineage outbox changed its frozen generation')
  return { ...value, request }
}
export function readLineageOutbox(storage: NativeControlStorage, identity: NativeControlIdentity): LineageOutbox {
  if (storage.length > 2048) throw new Error('Too many tab drafts')
  const prefix = lineageOutboxPrefix(identity), keys: string[] = []
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key) }
  if (!keys.length) return { state: 'empty' }
  keys.sort(); const key = keys[0]!, raw = storage.getItem(key)
  if (keys.length !== 1 || !raw) return { state: 'invalid', key, raw }
  try {
    const value = parseLineagePending(raw, identity)
    return lineageStorageKey(value) === key && JSON.stringify(value) === raw
      ? { state: 'pending', key, raw, value, current: nativeIdentityKey(value.identity) === nativeIdentityKey(identity) }
      : { state: 'invalid', key, raw }
  } catch { return { state: 'invalid', key, raw } }
}
export function saveLineagePending(storage: NativeControlStorage, pending: LineagePending): void {
  const raw = JSON.stringify(pending); parseLineagePending(raw, pending.identity)
  if (readLineageOutbox(storage, pending.identity).state !== 'empty') throw new Error('An original lineage operation is still pending')
  const key = lineageStorageKey(pending); storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Lineage command was not retained')
}
export async function lineageOperationMatches(pending: LineagePending, candidate: unknown): Promise<boolean> {
  const frozen = structuredClone(pending)
  try {
    const value = await checkedLineageOperation(frozen.identity, candidate, frozen.operationId ?? undefined)
    return canonical(value.request) === canonical(frozen.request) && lineageBindingMatches(frozen.identity, value.sourceBinding)
  } catch { return false }
}
export async function bindLineageOperation(storage: NativeControlStorage, pending: LineagePending, operation: ProductLineageOperation, current: () => boolean): Promise<LineagePending | null> {
  const frozen = structuredClone(pending), raw = JSON.stringify(frozen), candidate = structuredClone(operation)
  if (!await lineageOperationMatches(frozen, candidate) || !current()) return null
  const key = lineageStorageKey(frozen), next = { ...frozen, operationId: candidate.operationId }
  if (storage.getItem(key) !== raw) return null
  storage.setItem(key, JSON.stringify(next))
  if (storage.getItem(key) !== JSON.stringify(next)) throw new Error('Lineage operation ID was not retained')
  return next
}
export async function acknowledgeLineageOperation(storage: NativeControlStorage, pending: LineagePending, operation: ProductLineageOperation, current: () => boolean): Promise<boolean> {
  const frozen = structuredClone(pending), raw = JSON.stringify(frozen), candidate = structuredClone(operation)
  if (!lineageTerminalProof(candidate) || !await lineageOperationMatches(frozen, candidate) || !current()) return false
  const key = lineageStorageKey(frozen)
  if (storage.getItem(key) !== raw) return false
  storage.removeItem(key); return true
}
export function lineageAction(entry: ProductNativeTreeEntry, draft: LineageDraft, kind: 'navigate' | 'before' | 'at'): NativeLineageAction | null {
  if (kind === 'before' || kind === 'at') return (kind === 'before' ? entry.type === 'user' && entry.canForkBefore : entry.canForkAt)
    ? { kind: 'fork', targetEntryId: entry.entryId, position: kind } : null
  if (!entry.canNavigate || [...draft.instructions].length > 4096 || [...draft.label].length > 256) return null
  return { kind: 'navigate', targetEntryId: entry.entryId, summarize: draft.summarize, instructions: draft.instructions,
    replaceInstructions: draft.replaceInstructions, label: draft.label === '' ? null : draft.label }
}
export function mergeLineageTree(identity: NativeControlIdentity, inspection: ProductLineageInspection, previous: LineageTree | null,
  candidate: unknown, cursor: string | null, view: ProductNativeTreePage['view']): LineageTree {
  const page = parseBrowserContract('native-lineage', structuredClone(candidate))
  if (!('kind' in page) || page.kind !== 'native-tree-page' || !lineageBindingMatches(identity, page.binding) || !inspection.head
    || !lineageBindingMatches(identity, inspection.binding) || page.view !== view || lineageHeadKey(page.head) !== lineageHeadKey(inspection.head)
    || cursor !== null && (!previous || previous.nextCursor !== cursor || previous.view !== view || lineageHeadKey(previous.head) !== lineageHeadKey(page.head))) throw new Error('Native tree changed owner, selected head or cursor')
  if (cursor !== null && page.nextCursor === cursor) throw new Error('Native tree cursor did not advance')
  const entries = [...(cursor === null ? [] : previous!.entries), ...page.entries]
  if (entries.length > 1000 || entries.reduce((sum, entry) => sum + [...entry.preview].length + (entry.label ? [...entry.label].length : 0), 0) > 1_000_000
    || new Set(entries.map(entry => entry.entryId)).size !== entries.length) throw new Error('Native tree repeats entries or exceeds its display bound')
  const known = new Map(entries.map(entry => [entry.entryId, entry]))
  if (entries.some(entry => entry.parentId !== null && known.has(entry.parentId) && entry.depth !== known.get(entry.parentId)!.depth + 1)) throw new Error('Native tree parent/depth is inconsistent')
  return { head: page.head, view: page.view, entries, nextCursor: page.nextCursor }
}
/** Opening is explicit and cannot pull a user back from another conversation/generation. */
export function lineageCanActivate(identity: NativeControlIdentity | null, operation: ProductLineageOperation): boolean {
  return !!identity && operation.state === 'succeeded' && !!operation.result && lineageOwns(identity, operation.sourceBinding)
    && operation.result.targetBinding.ownerActorId === identity.actorId && operation.result.targetBinding.workspaceId === identity.workspaceId
    && (lineageBindingMatches(identity, operation.sourceBinding) || operation.request.action.kind === 'navigate' && lineageBindingMatches(identity, operation.result.targetBinding))
}
