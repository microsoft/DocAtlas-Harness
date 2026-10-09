import type { HumanResearchCommand, HumanResearchEntry, HumanResearchOperation, HumanResearchQuery, HumanResearchRecordType, HumanResearchWorkspace, ProductBinding, ProductSelectionProposal, ProductSourceRef, ResearchGovernanceDraft } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { LiveState } from './client'
import { canonical, canonicalHash } from './state'

export interface HumanResearchOwner { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number }
export interface HumanResearchPending { schemaVersion: 1, owner: HumanResearchOwner, request: HumanResearchCommand }
export type HumanResearchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type HumanResearchOutbox = { state: 'empty' } | { state: 'invalid', raw: string } | { state: 'pending', raw: string, value: HumanResearchPending, current: boolean }
export interface HumanResearchEditor {
  recordType: HumanResearchRecordType, noteKind: 'commentary' | 'hypothesis' | 'scratch', title: string, text: string, rationale: string,
  policyScope: 'investigation' | 'workspace', sourceRefs: ProductSourceRef[], selections: ProductSelectionProposal[],
}
export const humanResearchNames = { 'research-note': '笔记', 'open-question': '待研究问题', 'project-decision': '研究决策', 'research-policy': '研究规则' }
export const humanResearchTypes = Object.keys(humanResearchNames) as HumanResearchRecordType[]
/** Core Question lifecycle remains 4000 scalars; Note revisions and governance allow 8000. */
export const humanResearchTextLimit = (type: HumanResearchRecordType, editing: boolean): number => type === 'open-question' || type === 'research-note' && !editing ? 4000 : 8000
export const humanResearchOwnerKey = (owner: HumanResearchOwner) => canonical(owner)
export const humanResearchAccountKey = (owner: HumanResearchOwner) => canonical([owner.actorId, owner.workspaceId, owner.conversationId])
export const humanResearchStorageKey = (owner: HumanResearchOwner) => `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@human-research:${encodeURIComponent(owner.conversationId)}`
const opaque = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(id)
export function humanResearchOwner(state: LiveState): HumanResearchOwner | null {
  const actor = state.actor, binding = state.snapshot?.binding
  return state.phase === 'ready' && actor && binding && state.selected === binding.conversationId && actor.actorId === binding.ownerActorId && actor.workspaceId === binding.workspaceId
    ? { ...actor, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation } : null
}
export function humanResearchBinding(owner: HumanResearchOwner, binding: ProductBinding): boolean {
  return owner.actorId === binding.ownerActorId && owner.workspaceId === binding.workspaceId && owner.conversationId === binding.conversationId
    && owner.bindingId === binding.bindingId && owner.generation === binding.generation
}
export const humanResearchFrame = (owner: HumanResearchOwner) => ({ schemaVersion: 1 as const, expectedBindingId: owner.bindingId, expectedGeneration: owner.generation })
export const humanResearchOperationId = async (owner: HumanResearchOwner, key: string) => `human-op:${await canonicalHash([owner.actorId, owner.workspaceId, owner.conversationId, key])}`
export function parseHumanResearchPending(raw: string, owner: HumanResearchOwner): HumanResearchPending {
  if (new TextEncoder().encode(raw).byteLength > 131072) throw new Error('Research outbox exceeds its bound')
  const value = JSON.parse(raw) as HumanResearchPending
  if (!value || Object.keys(value).sort().join(',') !== 'owner,request,schemaVersion' || value.schemaVersion !== 1 || !value.owner
    || Object.keys(value.owner).sort().join(',') !== 'actorId,bindingId,conversationId,generation,workspaceId'
    || ![value.owner.actorId, value.owner.workspaceId, value.owner.conversationId, value.owner.bindingId].every(opaque)
    || !Number.isSafeInteger(value.owner.generation) || value.owner.generation < 1 || humanResearchAccountKey(value.owner) !== humanResearchAccountKey(owner)) throw new Error('Invalid research outbox owner')
  const request = parseBrowserContract('human-research', value.request)
  if (!('kind' in request) || request.kind !== 'human-research-command' || request.expectedBindingId !== value.owner.bindingId || request.expectedGeneration !== value.owner.generation) throw new Error('Invalid research outbox command')
  return { schemaVersion: 1, owner: value.owner, request }
}
export function readHumanResearchOutbox(storage: HumanResearchStorage, owner: HumanResearchOwner): HumanResearchOutbox {
  const raw = storage.getItem(humanResearchStorageKey(owner))
  if (raw === null) return { state: 'empty' }
  try { const value = parseHumanResearchPending(raw, owner); return { state: 'pending', raw, value, current: humanResearchOwnerKey(owner) === humanResearchOwnerKey(value.owner) } }
  catch { return { state: 'invalid', raw } }
}
export function saveHumanResearchPending(storage: HumanResearchStorage, pending: HumanResearchPending): void {
  const raw = JSON.stringify(pending), value = parseHumanResearchPending(raw, pending.owner), key = humanResearchStorageKey(value.owner)
  if (storage.getItem(key) !== null) throw new Error('A research operation is still uncertain')
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Research outbox was not retained')
}
export async function humanResearchReceiptMatches(pending: HumanResearchPending, candidate: unknown): Promise<boolean> {
  try {
    const frozen = structuredClone(pending), parsed = parseBrowserContract('human-research', candidate)
    if (!('kind' in parsed) || parsed.kind !== 'human-research-operation' || !parsed.receipt) return false
    const receipt = parsed.receipt, owner = frozen.owner, request = frozen.request
    if (parsed.operationId !== await humanResearchOperationId(owner, request.idempotencyKey) || receipt.operationId !== parsed.operationId
      || receipt.requestHash !== await canonicalHash(request) || receipt.idempotencyKey !== request.idempotencyKey || receipt.actorId !== owner.actorId
      || receipt.workspaceId !== owner.workspaceId || receipt.conversationId !== owner.conversationId || receipt.bindingId !== owner.bindingId
      || receipt.generation !== owner.generation || receipt.action !== request.action) return false
    return request.action === 'create' ? receipt.recordType === request.entry.recordType && receipt.recordVersion === 1
      : receipt.recordId === request.recordId && receipt.recordVersion === request.expectedVersion + 1
        && (request.action !== 'revise' || receipt.recordType === request.entry.recordType)
  } catch { return false }
}
export async function acknowledgeHumanResearch(storage: HumanResearchStorage, pending: HumanResearchPending, operation: HumanResearchOperation, current: () => boolean): Promise<boolean> {
  const frozen = structuredClone(pending), raw = JSON.stringify(frozen), key = humanResearchStorageKey(frozen.owner)
  if (!await humanResearchReceiptMatches(frozen, operation) || !current() || storage.getItem(key) !== raw) return false
  storage.removeItem(key); return true
}
export function emptyHumanResearchEditor(): HumanResearchEditor {
  return { recordType: 'research-note', noteKind: 'commentary', title: '', text: '', rationale: '', policyScope: 'investigation', sourceRefs: [], selections: [] }
}
export function humanResearchEntryEditor(value: HumanResearchEntry): HumanResearchEditor {
  const entry = value.entry, draft = { ...emptyHumanResearchEditor(), recordType: entry.recordType }
  if ('kind' in entry) return { ...draft, text: entry.text ?? '' }
  return entry.status === 'deleted' ? draft : { ...draft, title: entry.title, text: entry.recordType === 'project-decision' ? entry.decision : entry.directive,
    rationale: entry.rationale ?? '', policyScope: entry.recordType === 'research-policy' ? entry.policyScope : 'investigation' }
}
export function humanResearchDraftEntry(draft: HumanResearchEditor) {
  if (draft.recordType === 'research-note') return { recordType: draft.recordType, noteKind: draft.noteKind, body: draft.text } as const
  if (draft.recordType === 'open-question') return { recordType: draft.recordType, question: draft.text } as const
  const base = { recordType: draft.recordType, title: draft.title, ...(draft.rationale === '' ? {} : { rationale: draft.rationale }) }
  return draft.recordType === 'project-decision' ? { ...base, recordType: draft.recordType, decision: draft.text } satisfies ResearchGovernanceDraft
    : { ...base, recordType: draft.recordType, directive: draft.text, policyScope: draft.policyScope } satisfies ResearchGovernanceDraft
}
export function humanResearchEditorCommand(owner: HumanResearchOwner, draft: HumanResearchEditor, key: string, editing?: HumanResearchEntry | null): HumanResearchCommand | null {
  if (!draft.text.trim() || [...draft.text].length > humanResearchTextLimit(draft.recordType, !!editing)
    || ['project-decision', 'research-policy'].includes(draft.recordType) && !draft.title.trim()) return null
  const base = { ...humanResearchFrame(owner), kind: 'human-research-command' as const, idempotencyKey: key }
  let command: HumanResearchCommand
  if (!editing) command = { ...base, action: 'create', entry: humanResearchDraftEntry(draft), sourceRefs: structuredClone(draft.sourceRefs), selections: structuredClone(draft.selections) }
  else {
    const entry = editing.entry
    if (entry.status === 'deleted' || entry.recordType !== draft.recordType) return null
    const identity = { recordId: entry.recordId, expectedVersion: entry.version }
    if ('kind' in entry) command = { ...base, ...identity, action: 'edit', text: draft.text }
    else { const value = humanResearchDraftEntry(draft); if (value.recordType !== 'project-decision' && value.recordType !== 'research-policy') return null; command = { ...base, ...identity, action: 'revise', entry: value } }
  }
  try { const value = parseBrowserContract('human-research', command); return 'kind' in value && value.kind === 'human-research-command' ? value : null } catch { return null }
}
export interface HumanResearchListing { latest: HumanResearchWorkspace, items: HumanResearchWorkspace['result']['items'] }
export function mergeHumanResearchPages(previous: HumanResearchListing | null, next: HumanResearchWorkspace, request: HumanResearchQuery, owner: HumanResearchOwner): HumanResearchListing {
  if (!humanResearchBinding(owner, next.binding) || next.result.view !== request.view || next.result.items.some(item => !request.recordTypes.includes(item.recordType as HumanResearchRecordType)
    || !request.recordStatuses.includes(item.recordStatus as HumanResearchQuery['recordStatuses'][number]))
    || request.cursor && (!previous || previous.latest.result.queryHash !== next.result.queryHash || previous.latest.result.view !== next.result.view || previous.latest.result.pageInfo.nextCursor !== request.cursor)) throw new Error('Research query changed identity or filters')
  const items = request.cursor ? [...previous!.items, ...next.result.items] : next.result.items
  if (items.length > 200 || new Set(items.map(item => item.recordId)).size !== items.length || items.reduce((sum, item) => sum + item.preview.length, 0) > 120000) throw new Error('Research list bound or duplicate')
  return { latest: next, items }
}
