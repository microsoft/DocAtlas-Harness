import type { LiveState } from './client'
import type { NativeControlAction, ProductNativeCommand, ProductNativeInspection, ProductNativeOperation } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { canonical, canonicalHash } from './state'

/** Local display models only; the product wire contract remains the host's source of truth. */
export type NativeQueueMode = 'all' | 'one-at-a-time'
export interface NativeModelChoice { provider: string, id: string, name: string, thinkingLevels: string[] }
export interface NativeSettingsView {
  models: NativeModelChoice[]
  model: { provider: string, id: string } | null
  thinkingLevel: string | null
  thinkingLevels: string[]
  steeringMode: NativeQueueMode
  followUpMode: NativeQueueMode
  busy: boolean
  queued: number
  nativeQueue?: { steering: number, followUp: number }
  canCompact?: boolean
}
export interface NativeSettingsDraft { modelKey: string, thinkingLevel: string, steeringMode: NativeQueueMode, followUpMode: NativeQueueMode }
export interface NativeControlIdentity { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number, nativeSessionId: string }
export interface NativeControlPending { schemaVersion: 1, identity: NativeControlIdentity, request: ProductNativeCommand, operationId: string | null }
export type NativeControlStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
export type NativeControlOutbox = { state: 'empty' } | { state: 'invalid', key: string } | { state: 'pending', key: string, value: NativeControlPending, current: boolean }
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
export const nativeModelKey = (model: { provider: string, id: string }): string => JSON.stringify([model.provider, model.id])
export const nativeIdentityKey = (identity: NativeControlIdentity): string => JSON.stringify([identity.actorId, identity.workspaceId, identity.conversationId, identity.bindingId, identity.generation, identity.nativeSessionId])
export function nativeControlIdentity(state: LiveState): NativeControlIdentity | null {
  const actor = state.actor, binding = state.snapshot?.binding
  return state.phase === 'ready' && actor && binding && state.selected === binding.conversationId && binding.ownerActorId === actor.actorId && binding.workspaceId === actor.workspaceId
    ? { ...actor, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, nativeSessionId: binding.runtimeSessionId } : null
}
export function nativeControlPrefix(identity: NativeControlIdentity): string {
  return `docatlas.live.draft.v1:${encodeURIComponent(identity.actorId)}:${encodeURIComponent(identity.workspaceId)}:@native-controls:${encodeURIComponent(identity.conversationId)}:`
}
export function nativeSettingsDraft(view: NativeSettingsView): NativeSettingsDraft {
  return { modelKey: view.model ? nativeModelKey(view.model) : '', thinkingLevel: view.thinkingLevel ?? '', steeringMode: view.steeringMode, followUpMode: view.followUpMode }
}
export function nativeSettingsReady(view: NativeSettingsView, draft: NativeSettingsDraft): boolean {
  const keys = view.models.map(nativeModelKey), model = view.models.find(value => nativeModelKey(value) === draft.modelKey)
  return new Set(keys).size === keys.length && !!model && model.thinkingLevels.includes(draft.thinkingLevel)
    && ['all', 'one-at-a-time'].includes(draft.steeringMode) && ['all', 'one-at-a-time'].includes(draft.followUpMode)
}
export function nativeSettingsChanged(view: NativeSettingsView, draft: NativeSettingsDraft): boolean {
  const current = nativeSettingsDraft(view)
  return current.modelKey !== draft.modelKey || current.thinkingLevel !== draft.thinkingLevel || current.steeringMode !== draft.steeringMode || current.followUpMode !== draft.followUpMode
}
export function nativeSettingsView(inspection: ProductNativeInspection): NativeSettingsView | null {
  const value = inspection.state
  return value ? { models: inspection.models, model: value.configuration.model, thinkingLevel: value.configuration.thinkingLevel, thinkingLevels: value.thinkingLevels,
    steeringMode: value.configuration.steeringMode, followUpMode: value.configuration.followUpMode, busy: inspection.busy || value.busy,
    queued: inspection.queued, nativeQueue: { ...value.nativeQueue }, ...(value.compaction ? { canCompact: value.compaction.canCompact } : {}) } : null
}
export function nativeCompactAction(instructions: string, canCompact: boolean | undefined): Extract<NativeControlAction, { kind: 'compact' }> | null {
  return canCompact === true && [...instructions].length <= 4096 ? { kind: 'compact', instructions } : null
}
/** A receipt with a proved non-application is terminal, but never an applied configuration. */
export function nativeOperationHasTerminalProof(value: ProductNativeOperation): boolean {
  return value.state === 'succeeded' && value.result !== null || value.state === 'failed' && value.failureProof !== undefined
}
export function nativeDraftAction(view: NativeSettingsView, draft: NativeSettingsDraft, field: 'model' | 'thinking' | 'steering' | 'follow-up'): NativeControlAction | null {
  if (field === 'model') {
    const model = view.models.find(item => nativeModelKey(item) === draft.modelKey)
    return model && (!view.model || nativeModelKey(view.model) !== draft.modelKey) ? { kind: 'set-model', provider: model.provider, modelId: model.id } : null
  }
  if (field === 'thinking') return view.thinkingLevels.includes(draft.thinkingLevel) && draft.thinkingLevel !== view.thinkingLevel
    ? { kind: 'set-thinking', level: draft.thinkingLevel as Extract<NativeControlAction, { kind: 'set-thinking' }>['level'] } : null
  const mode = field === 'steering' ? draft.steeringMode : draft.followUpMode, current = field === 'steering' ? view.steeringMode : view.followUpMode
  return ['all', 'one-at-a-time'].includes(mode) && mode !== current ? { kind: 'set-queue-mode', queue: field, mode } : null
}
export function checkedNativeInspection(identity: NativeControlIdentity, candidate: unknown): ProductNativeInspection {
  const value = parseBrowserContract('native-control', candidate)
  if (!('kind' in value) || value.kind !== 'native-inspection' || value.binding.ownerActorId !== identity.actorId || value.binding.workspaceId !== identity.workspaceId
    || value.binding.conversationId !== identity.conversationId || value.binding.bindingId !== identity.bindingId || value.binding.generation !== identity.generation || value.binding.runtimeSessionId !== identity.nativeSessionId
    || new Set(value.models.map(nativeModelKey)).size !== value.models.length) throw new Error('Native settings belong to another owner, session or catalog')
  return value
}
/** A new causal read, never a current-setting projection from a historical operation proof. */
export async function nextNativeInspection(identity: NativeControlIdentity, read: () => Promise<ProductNativeInspection>, isCurrent: () => boolean): Promise<ProductNativeInspection | null> {
  const owner = { ...identity }
  if (!isCurrent()) return null
  const value = await read()
  if (!isCurrent()) return null
  return checkedNativeInspection(owner, value)
}
export function nativeControlStorageKey(pending: NativeControlPending): string {
  const identity = pending.identity
  return `${nativeControlPrefix(identity)}${encodeURIComponent(identity.bindingId)}:${identity.generation}:${encodeURIComponent(identity.nativeSessionId)}:${pending.request.expectedHead.transcriptHash}`
}
export function parseNativeControlPending(raw: string, identity: NativeControlIdentity): NativeControlPending {
  if (new TextEncoder().encode(raw).byteLength > 32768) throw new Error('Native configuration outbox exceeds its bound')
  const value = JSON.parse(raw) as NativeControlPending
  if (!value || !exact(value, ['schemaVersion', 'identity', 'request', 'operationId']) || value.schemaVersion !== 1 || !value.identity
    || !exact(value.identity, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation', 'nativeSessionId'])
    || ![value.identity.actorId, value.identity.workspaceId, value.identity.conversationId, value.identity.bindingId, value.identity.nativeSessionId].every(opaque)
    || !Number.isSafeInteger(value.identity.generation) || value.identity.generation < 1 || value.identity.actorId !== identity.actorId || value.identity.workspaceId !== identity.workspaceId
    || value.identity.conversationId !== identity.conversationId || value.operationId !== null && !opaque(value.operationId)) throw new Error('Invalid native configuration outbox owner')
  const request = parseBrowserContract('native-control', value.request)
  if (!('kind' in request) || request.kind !== 'native-command' || request.conversationId !== value.identity.conversationId || request.expectedBindingId !== value.identity.bindingId
    || request.expectedGeneration !== value.identity.generation || request.runtimeSessionId !== value.identity.nativeSessionId) throw new Error('Native command changed its pinned session')
  return { ...value, request }
}
export function readNativeControlOutbox(storage: NativeControlStorage, identity: NativeControlIdentity): NativeControlOutbox {
  if (storage.length > 2048) throw new Error('Too many tab drafts')
  const keys: string[] = [], prefix = nativeControlPrefix(identity)
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key) }
  if (!keys.length) return { state: 'empty' }
  keys.sort(); const key = keys[0]!
  if (keys.length !== 1) return { state: 'invalid', key }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { state: 'invalid', key }
    const value = parseNativeControlPending(raw, identity)
    return nativeControlStorageKey(value) === key ? { state: 'pending', key, value, current: nativeIdentityKey(value.identity) === nativeIdentityKey(identity) } : { state: 'invalid', key }
  } catch { return { state: 'invalid', key } }
}
export function saveNativeControlPending(storage: NativeControlStorage, pending: NativeControlPending): void {
  const raw = JSON.stringify(pending); parseNativeControlPending(raw, pending.identity)
  if (readNativeControlOutbox(storage, pending.identity).state !== 'empty') throw new Error('A native operation remains uncertain')
  const key = nativeControlStorageKey(pending); storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Native command was not retained')
}
export async function nativeOperationMatches(pending: NativeControlPending, candidate: unknown): Promise<boolean> {
  try {
    const value = parseBrowserContract('native-control', candidate), request = pending.request
    if (!('kind' in value) || value.kind !== 'native-operation' || canonical(value.request) !== canonical(request) || value.requestHash !== await canonicalHash(request)
      || pending.operationId !== null && value.operationId !== pending.operationId) return false
    if (value.failureProof) {
      const proof = value.failureProof
      return value.state === 'failed' && canonical(proof.beforeHead) === canonical(request.expectedHead) && canonical(proof.action) === canonical(request.action)
        && proof.afterHead.sessionId === pending.identity.nativeSessionId && proof.afterHead.entryCount === proof.beforeHead.entryCount + 2
        && proof.afterHead.byteLength > proof.beforeHead.byteLength && proof.afterHead.leafEntryId === proof.markerEntryId && proof.markerEntryId !== proof.intentEntryId
    }
    if (value.state !== 'succeeded') return true
    const proof = value.result!
    if (canonical(proof.beforeHead) !== canonical(request.expectedHead) || canonical(proof.action) !== canonical(request.action) || proof.afterHead.sessionId !== pending.identity.nativeSessionId
      || proof.afterHead.entryCount <= proof.beforeHead.entryCount || proof.afterHead.byteLength <= proof.beforeHead.byteLength || proof.afterHead.leafEntryId !== proof.markerEntryId || proof.markerEntryId === proof.intentEntryId) return false
    const action = request.action, configuration = proof.configuration
    if (action.kind === 'compact') return proof.compaction !== undefined
    return action.kind === 'set-model' ? configuration.model.provider === action.provider && configuration.model.id === action.modelId
      : action.kind === 'set-thinking' ? configuration.thinkingLevel === action.level
        : action.queue === 'steering' ? configuration.steeringMode === action.mode : configuration.followUpMode === action.mode
  } catch { return false }
}
export async function bindNativeOperation(storage: NativeControlStorage, pending: NativeControlPending, operation: ProductNativeOperation, isCurrent: () => boolean): Promise<NativeControlPending | null> {
  if (!await nativeOperationMatches(pending, operation)) return null
  const key = nativeControlStorageKey(pending), next = { ...pending, operationId: operation.operationId }
  if (!isCurrent() || storage.getItem(key) !== JSON.stringify(pending)) return null
  storage.setItem(key, JSON.stringify(next))
  if (storage.getItem(key) !== JSON.stringify(next)) throw new Error('Native operation identity was not retained')
  return next
}
export async function acknowledgeNativeOperation(storage: NativeControlStorage, pending: NativeControlPending, operation: ProductNativeOperation, isCurrent: () => boolean): Promise<boolean> {
  if (!nativeOperationHasTerminalProof(operation) || !await nativeOperationMatches(pending, operation)) return false
  const key = nativeControlStorageKey(pending)
  if (!isCurrent() || storage.getItem(key) !== JSON.stringify(pending)) return false
  storage.removeItem(key); return true
}

export interface NativeHistoryScrollAnchor { identity: string, entryId: string | null, offset: number, scrollTop: number, scrollHeight: number, interaction: number }
/** Capture a visible message, never a submission receipt or opaque cursor's guessed chronology. */
export function captureNativeHistoryAnchor(container: HTMLElement, identity: string, interaction: number): NativeHistoryScrollAnchor {
  const bounds = container.getBoundingClientRect()
  const entry = [...container.querySelectorAll<HTMLElement>('[data-message-entry]')].find(node => { const rect = node.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom })
  return { identity, entryId: entry?.dataset.messageEntry ?? null, offset: entry ? entry.getBoundingClientRect().top - bounds.top : 0, scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, interaction }
}
/** Native/browser overflow anchoring may already have compensated; only correct the remaining entry offset. */
export function restoreNativeHistoryAnchor(container: HTMLElement, anchor: NativeHistoryScrollAnchor, identity: string, interaction: number): boolean {
  if (anchor.identity !== identity || anchor.interaction !== interaction) return false
  if (anchor.entryId) {
    const entry = [...container.querySelectorAll<HTMLElement>('[data-message-entry]')].find(node => node.dataset.messageEntry === anchor.entryId)
    if (!entry) return false
    container.scrollTop += entry.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
  } else container.scrollTop = anchor.scrollTop + container.scrollHeight - anchor.scrollHeight
  return true
}
