import type { ProductBinding, ProductLearningCommand, ProductLearningOperation, ProductLearningView, ProductProbeMaterial } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { LiveState } from './client'
import { canonical, canonicalHash } from './state'

export interface LearningOwner { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number }
export interface LearningMaterialPin { messageId: string, manifestId: string, sourceScopeVersionId: string, materialHash: string, nativeTextHash: string, probeId: string }
export interface LearningPending { schemaVersion: 1, owner: LearningOwner, profileId: string, profileEpoch: number, material: LearningMaterialPin | null, request: ProductLearningCommand }
export type LearningOutbox = { state: 'empty' } | { state: 'invalid', raw: string } | { state: 'pending', raw: string, current: boolean, value: LearningPending }
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
export const learningOwnerKey = (owner: LearningOwner) => canonical(owner)
export const learningStorageKey = (owner: LearningOwner) => `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@learning:${encodeURIComponent(owner.conversationId)}`
export const learningFrame = (owner: LearningOwner) => ({ schemaVersion: 1 as const, expectedBindingId: owner.bindingId, expectedGeneration: owner.generation })
export const learningOperationId = async (owner: LearningOwner, key: string) => `learning-op:${await canonicalHash([owner.actorId, owner.workspaceId, owner.conversationId, key])}`
export async function learningProbeIdentity(profileId: string, epoch: number, material: ProductProbeMaterial): Promise<string> {
  const manifest = material.manifest
  return `learning-probe:${await canonicalHash([profileId, epoch, manifest.sessionId, manifest.messageId, manifest.manifestId, material.materialHash, 'answer-order:learning:v1'])}`
}
export async function learningMaterialPin(profileId: string, epoch: number, material: ProductProbeMaterial): Promise<LearningMaterialPin> {
  return { messageId: material.manifest.messageId, manifestId: material.manifest.manifestId, sourceScopeVersionId: material.manifest.sourceScopeVersionId,
    materialHash: material.materialHash, nativeTextHash: material.nativeTextHash, probeId: await learningProbeIdentity(profileId, epoch, material) }
}
export function learningOwner(state: LiveState): LearningOwner | null {
  const actor = state.actor, binding = state.snapshot?.binding
  return state.phase === 'ready' && actor && binding && state.selected === binding.conversationId && actor.actorId === binding.ownerActorId && actor.workspaceId === binding.workspaceId
    ? { ...actor, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation } : null
}
export function learningBinding(owner: LearningOwner, binding: ProductBinding): boolean {
  return binding.ownerActorId === owner.actorId && binding.workspaceId === owner.workspaceId && binding.conversationId === owner.conversationId
    && binding.bindingId === owner.bindingId && binding.generation === owner.generation
}
/** Native history order, never ID order or old paged rows, selects the sole quiet invitation target. */
export function activeLearningOffer(state: LiveState, view: ProductLearningView | null, hidden: ReadonlySet<string> = new Set(), pendingDismiss: string | null = null) {
  const owner = learningOwner(state)
  if (!owner || !view || !learningBinding(owner, view.binding) || !view.settings.enabled || !view.contributionAllowed || state.sending || state.request !== null
    || state.snapshot?.runs.some(run => !['completed', 'failed', 'cancelled'].includes(run.receipt.state))) return undefined
  const latest = state.snapshot?.history.messages.findLast(item => item.role === 'assistant' && item.text.trim() && !item.truncated
    && (!item.origin || item.origin.conversationId === state.selected))
  return view.offers.find(offer => offer.status === 'offered' && !hidden.has(offer.offerId) && offer.offerId !== pendingDismiss && offer.original.messageId === latest?.entryId)
}
export async function sha256Text(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
}

/** Recompute public material and deterministic renderer recipes; authenticated host still owns source authority. */
export async function checkedLearningView(owner: LearningOwner, candidate: unknown): Promise<ProductLearningView> {
  const value = parseBrowserContract('product-learning', structuredClone(candidate))
  if (value.kind !== 'learning-view' || !learningBinding(owner, value.binding)
    || value.profileId !== `profile:pi:${(await canonicalHash([owner.actorId, owner.workspaceId])).slice(0, 32)}`) throw new Error('Learning view changed its owner')
  const comparison = value.comparison, material = comparison?.material
  if (material) {
    const manifest = material.manifest, segments = manifest.blocks.flatMap(block => block.segments)
    if (await sha256Text(manifest.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n')) !== manifest.answerTextHash
      || await canonicalHash({ recipeVersion: 1, manifest, nativeTextHash: material.nativeTextHash }) !== material.materialHash) throw new Error('Learning material hash changed')
    const probe = comparison.probe
    if (probe) {
      if (probe.probeId !== await learningProbeIdentity(value.profileId, value.profileEpoch, material) || probe.variants.length !== 2
        || probe.presentationOrder.length !== 2 || new Set(probe.presentationOrder).size !== 2
        || canonical([...probe.presentationOrder].sort()) !== canonical(probe.variants.map(item => item.variantKey).sort())) throw new Error('Learning comparison identity or order changed')
      const expected = { sourceScopeVersionId: manifest.sourceScopeVersionId, claimVersionIds: [...new Set(segments.flatMap(segment => segment.claimVersionIds))].sort(),
        evidenceAtomIds: [...new Set(manifest.citations.flatMap(citation => citation.evidence ? [citation.evidence.evidenceId] : []))].sort(),
        uncertaintyIds: segments.filter(segment => segment.status === 'unresolved' || segment.status === 'qualified' || segment.kind === 'unclassified').map(segment => segment.segmentId).sort(),
        conflictIds: [...segments.filter(segment => segment.status === 'contested').map(segment => segment.segmentId), ...manifest.citations.filter(citation => citation.relation === 'refute').map(citation => citation.citationId)].sort(), factTraceDigest: material.materialHash }
      if (canonical(probe.backbone) !== canonical(expected) || canonical(probe.taskContext) !== canonical({ mode: manifest.mode, workspaceId: manifest.workspaceId, investigationId: manifest.investigationId })) throw new Error('Learning comparison changed evidence or uncertainty')
      for (const variant of probe.variants) {
        const first = variant.effect.value === 'conclusion-first', sections = first ? ['answer', 'evidence'] : ['evidence', 'answer']
        if (variant.effect.key !== 'answer-order' || !['conclusion-first', 'evidence-first'].includes(variant.effect.value)
          || variant.variantKey !== (first ? 'variant:answer-first' : 'variant:evidence-first') || variant.factTraceDigest !== material.materialHash || variant.invariantCheck !== 'passed'
          || variant.artifactId !== `presentation:${await canonicalHash({ materialHash: material.materialHash, recipeVersion: 1, sections })}`) throw new Error('Learning renderer recipe changed')
      }
    }
  }
  return value
}

export function parseLearningPending(raw: string, owner: LearningOwner): LearningPending {
  if (new TextEncoder().encode(raw).byteLength > 32768) throw new Error('Learning pending request exceeds its bound')
  const value = JSON.parse(raw) as LearningPending
  if (!value || !exact(value, ['schemaVersion', 'owner', 'profileId', 'profileEpoch', 'material', 'request']) || value.schemaVersion !== 1
    || !value.owner || !exact(value.owner, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation'])
    || ![value.owner.actorId, value.owner.workspaceId, value.owner.conversationId, value.owner.bindingId, value.profileId].every(id)
    || !Number.isSafeInteger(value.owner.generation) || value.owner.generation < 1 || !Number.isSafeInteger(value.profileEpoch) || value.profileEpoch < 0
    || value.owner.actorId !== owner.actorId || value.owner.workspaceId !== owner.workspaceId || value.owner.conversationId !== owner.conversationId) throw new Error('Learning pending owner changed')
  const request = parseBrowserContract('product-learning', value.request)
  if (request.kind !== 'learning-command' || request.expectedBindingId !== value.owner.bindingId || request.expectedGeneration !== value.owner.generation || request.expectedProfileEpoch !== value.profileEpoch) throw new Error('Learning pending command changed')
  if (request.action === 'prepare' || request.action === 'choose') {
    const pin = value.material
    if (!pin || !exact(pin, ['messageId', 'manifestId', 'sourceScopeVersionId', 'materialHash', 'nativeTextHash', 'probeId'])
      || ![pin.messageId, pin.manifestId, pin.sourceScopeVersionId, pin.probeId].every(id) || ![pin.materialHash, pin.nativeTextHash].every(digest)
      || pin.messageId !== request.messageId || pin.materialHash !== request.materialHash || request.action === 'choose' && pin.probeId !== request.probeId) throw new Error('Learning original material pin changed')
  } else if (value.material !== null) throw new Error('Learning settings/governance cannot carry document material')
  return { ...value, request }
}
export function readLearningPending(storage: StoragePort, owner: LearningOwner): LearningOutbox {
  const raw = storage.getItem(learningStorageKey(owner))
  if (raw === null) return { state: 'empty' }
  try { const value = parseLearningPending(raw, owner); return { state: 'pending', raw, value, current: learningOwnerKey(value.owner) === learningOwnerKey(owner) } }
  catch { return { state: 'invalid', raw } }
}
export function saveLearningPending(storage: StoragePort, pending: LearningPending): void {
  const raw = JSON.stringify(pending), value = parseLearningPending(raw, pending.owner), key = learningStorageKey(value.owner)
  if (storage.getItem(key) !== null) throw new Error('Another learning command is still uncertain')
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Learning request was not retained')
}
export async function learningReceiptMatches(pending: LearningPending, candidate: unknown): Promise<boolean> {
  try {
    const input = structuredClone(pending), value = parseBrowserContract('product-learning', candidate)
    if (value.kind !== 'learning-operation' || !value.receipt || value.profileId !== input.profileId || value.profileEpoch !== input.profileEpoch) return false
    const receipt = value.receipt, request = input.request, owner = input.owner
    if (value.operationId !== await learningOperationId(owner, request.idempotencyKey) || receipt.operationId !== value.operationId
      || receipt.requestHash !== await canonicalHash(request) || receipt.idempotencyKey !== request.idempotencyKey || receipt.actorId !== owner.actorId
      || receipt.workspaceId !== owner.workspaceId || receipt.conversationId !== owner.conversationId || receipt.bindingId !== owner.bindingId
      || receipt.generation !== owner.generation || receipt.profileEpoch !== input.profileEpoch || receipt.action !== request.action) return false
    if (request.action === 'configure') return receipt.targetVersion === request.expectedSettingsVersion + 1 && receipt.targetId === `learning-settings:${(await sha256Text(input.profileId)).slice(0, 32)}`
    if (request.action === 'prepare') return receipt.targetVersion === 1 && receipt.targetId === input.material?.probeId
    if (request.action === 'dismiss') return receipt.targetId === request.offerId && receipt.targetVersion === request.expectedOfferVersion + 1
    if (request.action === 'review') return receipt.targetId === request.candidateId && receipt.candidateId === request.candidateId && receipt.groupId === request.groupId
      && receipt.targetVersion === request.expectedCandidateVersion + 1 && (request.decision !== 'reject' || receipt.memoryVersionId === null)
    return receipt.targetVersion === 1 && receipt.targetId === `choice:learning:${await canonicalHash([input.profileId, request.probeId, request.idempotencyKey])}`
      && (request.scopeIntent !== 'turn' || receipt.groupId === null && receipt.candidateId === null)
  } catch { return false }
}
export async function acknowledgeLearning(storage: StoragePort, pending: LearningPending, value: ProductLearningOperation, current: () => boolean): Promise<boolean> {
  const frozen = structuredClone(pending), key = learningStorageKey(frozen.owner), raw = JSON.stringify(frozen)
  if (!await learningReceiptMatches(frozen, value) || !current() || storage.getItem(key) !== raw) return false
  storage.removeItem(key); return true
}
