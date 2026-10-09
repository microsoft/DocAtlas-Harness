import { answerManifestIssues, personalizationCommandIssues, type AnswerManifest, type MemoryCandidate, type PersonalizationCommandRequest, type ProductProbeChoose, type ProductProbeReview, type ProductProbeMaterial, type ProductProbeView } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { LiveState } from './client'
import { preferenceIdentity, type PreferenceIdentity, type PreferenceStorage } from './preference-state'
import { canonical, canonicalHash } from './state'

/** Local rendering types, not a second wire protocol or a browser-authored Probe. */
export type ProbeRecipe = 'conclusion-first' | 'evidence-first'
export type ProbeSection = 'answer' | 'evidence'
export interface ProbeVariantInput { variantKey: string, effect: { key: string, value: string } }
export interface ProbePresentation {
  position: 'A' | 'B'
  variantKey: string
  recipe: ProbeRecipe
  manifest: AnswerManifest
  sections: readonly [ProbeSection, ProbeSection]
}
export interface ProbeChoiceDraft { selected: string | null, scopeIntent: 'turn' | 'workspace' }
export interface ProbeAnswerOwner extends PreferenceIdentity { messageId: string }
export interface ProbeOwner extends ProbeAnswerOwner { probeId: string, profileId: string, profileEpoch: number }
export interface ProbeAnswerPin { manifestId: string, messageId: string, sourceScopeVersionId: string, answerTextHash: string, nativeTextHash: string, materialHash: string }
export interface ProbeCandidatePin { candidateId: string, version: number, effect: { key: string, value: string }, scope: { kind: 'workspace', profileId: string, workspaceId: string } }
export interface ProbePending { schemaVersion: 1, owner: ProbeOwner, original: ProbeAnswerPin, variants: ProbeVariantInput[], presentationOrder: string[], candidate: ProbeCandidatePin | null, request: ProductProbeChoose | ProductProbeReview }
export type ProbeOutbox = { state: 'empty' } | { state: 'invalid', key: string } | { state: 'pending', key: string, value: ProbePending, current: boolean }
export const blankProbeChoice = (): ProbeChoiceDraft => ({ selected: null, scopeIntent: 'turn' })
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const reservedChoices = new Set(['both', 'neither', 'dismissed'])
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

/** A message ID is only a target. The host must still authorize its immutable completed Answer. */
export function probeAnswerOwner(state: LiveState, messageId: string): ProbeAnswerOwner | null {
  const identity = preferenceIdentity(state)
  return identity && opaque(messageId) ? { ...identity, messageId } : null
}
export const probeAnswerOwnerKey = (owner: ProbeAnswerOwner): string => JSON.stringify([owner.actorId, owner.workspaceId, owner.conversationId, owner.bindingId, owner.generation, owner.messageId])
export const probeOwnerKey = (owner: ProbeOwner): string => JSON.stringify([probeAnswerOwnerKey(owner), owner.probeId, owner.profileId, owner.profileEpoch])
export function probePrefix(owner: ProbeAnswerOwner): string {
  return `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@probe:${encodeURIComponent(owner.conversationId)}:${encodeURIComponent(owner.messageId)}:`
}
export function probeStorageKey(owner: ProbeOwner): string {
  return `${probePrefix(owner)}${encodeURIComponent(owner.bindingId)}:${owner.generation}:${encodeURIComponent(owner.probeId)}:${encodeURIComponent(owner.profileId)}:${owner.profileEpoch}`
}
export function probeAnswerPin(material: ProductProbeMaterial): ProbeAnswerPin {
  return { manifestId: material.manifest.manifestId, messageId: material.manifest.messageId, sourceScopeVersionId: material.manifest.sourceScopeVersionId,
    answerTextHash: material.manifest.answerTextHash, nativeTextHash: material.nativeTextHash, materialHash: material.materialHash }
}
export function probeCandidatePin(candidate: MemoryCandidate): ProbeCandidatePin {
  if (candidate.proposedScope.kind !== 'workspace' || candidate.proposedEffect.key !== 'answer-order') throw new Error('Only an explicitly scoped answer-order candidate is supported')
  return { candidateId: candidate.candidateId, version: candidate.version, effect: { ...candidate.proposedEffect }, scope: { ...candidate.proposedScope } }
}
function validRecipes(variants: readonly ProbeVariantInput[], order: readonly string[]): boolean {
  return variants.length === 2 && order.length === 2 && new Set(order).size === 2 && new Set(variants.map(value => value.variantKey)).size === 2
    && variants.every(value => opaque(value.variantKey) && !reservedChoices.has(value.variantKey) && value.effect.key === 'answer-order'
      && ['conclusion-first', 'evidence-first'].includes(value.effect.value)) && new Set(variants.map(value => value.effect.value)).size === 2
    && order.every(key => variants.some(value => value.variantKey === key))
}
/** Verify the actual complete bytes, not merely matching server-declared digest labels. */
export async function checkedProbeView(identity: ProbeAnswerOwner, candidate: unknown): Promise<ProductProbeView> {
  const value = parseBrowserContract('product-probe', candidate)
  if (value.kind !== 'probe-view' || value.conversationId !== identity.conversationId || value.bindingId !== identity.bindingId || value.generation !== identity.generation || value.messageId !== identity.messageId) throw new Error('Probe view changed owner or original Answer')
  if (value.material) {
    const { manifest, nativeTextHash, materialHash } = value.material
    const segments = manifest.blocks.flatMap(block => block.segments)
    if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 131072 || manifest.blocks.length > 64 || manifest.citations.length > 32
      || !manifest.citations.some(citation => citation.verificationStatus === 'read-verified' && citation.evidence)
      || new Set(segments.flatMap(segment => segment.claimVersionIds)).size > 200
      || segments.filter(segment => segment.status === 'unresolved' || segment.status === 'qualified' || segment.kind === 'unclassified').length > 200
      || segments.filter(segment => segment.status === 'contested').length + manifest.citations.filter(citation => citation.relation === 'refute').length > 200) throw new Error('Probe cannot trim or fabricate eligible material')
    const raw = manifest.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n')
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)), rawHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
    if (manifest.workspaceId !== identity.workspaceId || rawHash !== manifest.answerTextHash || materialHash !== await canonicalHash({ recipeVersion: 1, manifest, nativeTextHash })) throw new Error('Original Probe material content changed')
    if (value.probe) {
      const probe = value.probe
      if (!validRecipes(probe.variants, probe.presentationOrder) || probe.probeId !== `probe:${await canonicalHash([probe.profileId, value.profileEpoch, identity.conversationId, identity.messageId, manifest.manifestId, materialHash, 'answer-order:v1'])}`) throw new Error('Frozen Probe recipe or original identity changed')
      if (probe.investigationId !== manifest.investigationId || canonical(probe.taskContext) !== canonical({ mode: manifest.mode, workspaceId: manifest.workspaceId, investigationId: manifest.investigationId })) throw new Error('Probe task context changed')
      for (const variant of probe.variants) {
        const first = variant.effect.value === 'conclusion-first', sections = first ? ['answer', 'evidence'] : ['evidence', 'answer']
        if (variant.variantKey !== (first ? 'variant:answer-first' : 'variant:evidence-first') || variant.factTraceDigest !== materialHash || variant.invariantCheck !== 'passed'
          || variant.artifactId !== `presentation:${await canonicalHash({ materialHash, recipeVersion: 1, sections })}`) throw new Error('Controlled Probe recipe fingerprint changed')
      }
      const expected = { sourceScopeVersionId: manifest.sourceScopeVersionId, claimVersionIds: [...new Set(segments.flatMap(segment => segment.claimVersionIds))].sort(),
        evidenceAtomIds: [...new Set(manifest.citations.flatMap(citation => citation.evidence ? [citation.evidence.evidenceId] : []))].sort(),
        uncertaintyIds: segments.filter(segment => segment.status === 'unresolved' || segment.status === 'qualified' || segment.kind === 'unclassified').map(segment => segment.segmentId).sort(),
        conflictIds: [...segments.filter(segment => segment.status === 'contested').map(segment => segment.segmentId), ...manifest.citations.filter(citation => citation.relation === 'refute').map(citation => citation.citationId)].sort(), factTraceDigest: materialHash }
      if (canonical(probe.backbone) !== canonical(expected)) throw new Error('Probe omitted uncertainty, conflict or canonical Evidence')
      if (value.candidate && (value.candidate.proposedMemoryType !== 'presentation-preference' || value.candidate.risk !== 'low' || value.candidate.sensitivity !== 'ordinary'
        || value.candidate.rationaleCode !== 'controlled-probe-choice' || canonical(value.candidate.proposedEffect) !== canonical(probe.variants.find(variant => variant.variantKey === value.choiceReceipt?.choice.selected)?.effect)
        || canonical(value.candidate.proposedScope) !== canonical({ kind: 'workspace', profileId: probe.profileId, workspaceId: identity.workspaceId }))) throw new Error('Candidate exceeds this explicit workspace presentation choice')
    }
  }
  return value
}
export function parseProbePending(raw: string, expected: ProbeAnswerOwner): ProbePending {
  if (new TextEncoder().encode(raw).byteLength > 32768) throw new Error('Probe outbox exceeds its bound')
  const value = JSON.parse(raw) as ProbePending
  if (!value || !exact(value, ['schemaVersion', 'owner', 'original', 'variants', 'presentationOrder', 'candidate', 'request']) || value.schemaVersion !== 1 || !value.owner
    || !exact(value.owner, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation', 'messageId', 'probeId', 'profileId', 'profileEpoch'])
    || ![value.owner.actorId, value.owner.workspaceId, value.owner.conversationId, value.owner.bindingId, value.owner.messageId, value.owner.probeId, value.owner.profileId].every(opaque)
    || !Number.isSafeInteger(value.owner.generation) || value.owner.generation < 1 || !Number.isSafeInteger(value.owner.profileEpoch) || value.owner.profileEpoch < 0
    || value.owner.actorId !== expected.actorId || value.owner.workspaceId !== expected.workspaceId || value.owner.conversationId !== expected.conversationId || value.owner.messageId !== expected.messageId) throw new Error('Invalid Probe outbox owner')
  if (!value.original || !exact(value.original, ['manifestId', 'messageId', 'sourceScopeVersionId', 'answerTextHash', 'nativeTextHash', 'materialHash'])
    || ![value.original.manifestId, value.original.messageId, value.original.sourceScopeVersionId].every(opaque) || ![value.original.answerTextHash, value.original.nativeTextHash, value.original.materialHash].every(digest)
    || value.original.messageId !== value.owner.messageId || !Array.isArray(value.variants) || value.variants.some(variant => !variant || !exact(variant, ['variantKey', 'effect']) || !variant.effect || !exact(variant.effect, ['key', 'value']))
    || !Array.isArray(value.presentationOrder) || !validRecipes(value.variants, value.presentationOrder)) throw new Error('Probe lost its original Answer or frozen presentation')
  const request = parseBrowserContract('product-probe', value.request)
  if (request.kind !== 'probe-choose' && request.kind !== 'probe-review' || request.expectedGeneration !== value.owner.generation || request.expectedProfileEpoch !== value.owner.profileEpoch
    || request.messageId !== value.owner.messageId || request.probeId !== value.owner.probeId) throw new Error('Probe request changed epoch or target')
  if (request.kind === 'probe-choose') {
    if (value.candidate !== null || !probeDraftReady({ selected: request.selected, scopeIntent: request.scopeIntent }, value.presentationOrder, 'enabled')) throw new Error('Invalid frozen choice')
  } else {
    const item = value.candidate
    if (!item || !exact(item, ['candidateId', 'version', 'effect', 'scope']) || !opaque(item.candidateId) || !Number.isSafeInteger(item.version) || item.version < 1
      || item.candidateId !== request.candidateId || item.version !== request.expectedCandidateVersion || !item.effect || !exact(item.effect, ['key', 'value']) || item.effect.key !== 'answer-order' || !['conclusion-first', 'evidence-first'].includes(item.effect.value)
      || !item.scope || !exact(item.scope, ['kind', 'profileId', 'workspaceId']) || item.scope.kind !== 'workspace' || item.scope.profileId !== value.owner.profileId || item.scope.workspaceId !== value.owner.workspaceId) throw new Error('Candidate confirmation changed its frozen proposal')
  }
  return { ...value, request }
}
export function readProbeOutbox(storage: PreferenceStorage, identity: ProbeAnswerOwner, currentOwner: ProbeOwner | null): ProbeOutbox {
  if (storage.length > 2048) throw new Error('Too many tab-local drafts')
  const keys: string[] = [], prefix = probePrefix(identity)
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key) }
  if (!keys.length) return { state: 'empty' }
  keys.sort(); const key = keys[0]!
  if (keys.length !== 1) return { state: 'invalid', key }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { state: 'invalid', key }
    const value = parseProbePending(raw, identity)
    if (probeStorageKey(value.owner) !== key) return { state: 'invalid', key }
    return { state: 'pending', key, value, current: currentOwner !== null && probeOwnerKey(currentOwner) === probeOwnerKey(value.owner) }
  } catch { return { state: 'invalid', key } }
}
export function saveProbePending(storage: PreferenceStorage, pending: ProbePending): void {
  const raw = JSON.stringify(pending); parseProbePending(raw, pending.owner)
  if (readProbeOutbox(storage, pending.owner, pending.owner).state !== 'empty') throw new Error('An original Probe operation remains uncertain')
  const key = probeStorageKey(pending.owner); storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Probe request was not retained')
}
export async function probeReceiptMatches(pending: ProbePending, candidate: unknown): Promise<boolean> {
  try {
    const value = parseBrowserContract('product-probe', candidate), { owner, request } = pending
    if (!['probe-view', 'probe-choice-result', 'probe-review-result'].includes(value.kind) || !('bindingId' in value) || value.conversationId !== owner.conversationId
      || value.bindingId !== owner.bindingId || value.generation !== owner.generation || value.profileEpoch !== owner.profileEpoch || value.messageId !== owner.messageId) return false
    if (owner.probeId !== `probe:${await canonicalHash([owner.profileId, owner.profileEpoch, owner.conversationId, owner.messageId, pending.original.manifestId, pending.original.materialHash, 'answer-order:v1'])}`) return false
    if (request.kind === 'probe-choose' && (value.kind === 'probe-choice-result' || value.kind === 'probe-view')) {
      const receipt = value.kind === 'probe-view' ? value.choiceReceipt : value
      if (!receipt || receipt.idempotencyKey !== request.idempotencyKey || receipt.requestHash !== await canonicalHash(request)) return false
      if (value.kind === 'probe-view' && (!value.material || canonical(probeAnswerPin(value.material)) !== canonical(pending.original) || value.probe?.probeId !== owner.probeId)) return false
      const choice = receipt.choice
      return choice.probeId === owner.probeId && choice.profileId === owner.profileId && choice.sessionId === owner.conversationId && choice.selected === request.selected
        && choice.scopeIntent === request.scopeIntent && canonical([...(choice.reasonTags ?? [])].sort()) === canonical([...request.reasonTags].sort())
        && choice.consent.basis === 'session-policy' && choice.consent.retention === (request.scopeIntent === 'workspace' ? 'eligible' : 'session-only')
        && (request.scopeIntent === 'workspace' ? receipt.candidateId !== null : receipt.candidateId === null)
    }
    if (request.kind !== 'probe-review' || value.kind !== 'probe-review-result' || value.probeId !== owner.probeId || value.idempotencyKey !== request.idempotencyKey || value.requestHash !== await canonicalHash(request) || !pending.candidate) return false
    const command: PersonalizationCommandRequest = { schemaVersion: 1, requestType: 'personalization-command', profileId: owner.profileId, sessionId: owner.conversationId,
      actor: { kind: 'user', actorId: owner.actorId }, action: 'review-candidate', candidateId: request.candidateId, expectedVersion: request.expectedCandidateVersion, decision: request.decision, idempotencyKey: request.idempotencyKey }
    return personalizationCommandIssues(value.result, command).length === 0 && value.result.candidate.version === pending.candidate.version + 1
      && canonical(value.result.candidate.proposedEffect) === canonical(pending.candidate.effect) && canonical(value.result.candidate.proposedScope) === canonical(pending.candidate.scope)
      && (!value.result.memoryVersion || value.result.memoryVersion.status !== 'deleted' && canonical(value.result.memoryVersion.effect) === canonical(pending.candidate.effect) && canonical(value.result.memoryVersion.scope) === canonical(pending.candidate.scope))
  } catch { return false }
}
export async function acknowledgeProbe(storage: PreferenceStorage, pending: ProbePending, result: unknown, isCurrent: () => boolean): Promise<boolean> {
  if (!await probeReceiptMatches(pending, result)) return false
  const key = probeStorageKey(pending.owner)
  if (!isCurrent() || storage.getItem(key) !== JSON.stringify(pending)) return false
  storage.removeItem(key); return true
}

/** Both recipes reference one canonical manifest. The ONLY recipe operation is swapping two whole sections. */
export function probePresentations(manifest: AnswerManifest, variants: readonly ProbeVariantInput[], presentationOrder: readonly string[]): readonly [ProbePresentation, ProbePresentation] {
  if (answerManifestIssues(manifest).length) throw new Error('Probe requires an intact canonical Answer manifest')
  if (variants.length !== 2 || presentationOrder.length !== 2 || new Set(presentationOrder).size !== 2 || new Set(variants.map(value => value.variantKey)).size !== 2
    || variants.some(value => !opaque(value.variantKey) || reservedChoices.has(value.variantKey) || value.effect.key !== 'answer-order'
      || !['conclusion-first', 'evidence-first'].includes(value.effect.value)) || new Set(variants.map(value => value.effect.value)).size !== 2
    || presentationOrder.some(key => !variants.some(value => value.variantKey === key))) throw new Error('Probe variants must preserve the exact host-frozen single-axis order')
  const result = presentationOrder.map((key, index): ProbePresentation => {
    const variant = variants.find(value => value.variantKey === key)!, recipe = variant.effect.value as ProbeRecipe
    return { position: index === 0 ? 'A' : 'B', variantKey: key, recipe, manifest, sections: recipe === 'conclusion-first' ? ['answer', 'evidence'] : ['evidence', 'answer'] }
  })
  return [result[0]!, result[1]!]
}
/** Neutral/negative/dismissal choices cannot be promoted into an inferred lasting preference. */
export function chooseProbeDraft(previous: ProbeChoiceDraft, selected: string | null, presentationOrder: readonly string[]): ProbeChoiceDraft {
  if (selected !== null && !reservedChoices.has(selected) && !presentationOrder.includes(selected)) throw new Error('Choice is not one of this frozen Probe variants')
  return { selected, scopeIntent: selected !== null && !reservedChoices.has(selected) ? previous.scopeIntent : 'turn' }
}
export function probeDraftReady(draft: ProbeChoiceDraft, presentationOrder: readonly string[], contribution: 'enabled' | 'disabled' | 'unavailable'): boolean {
  return contribution === 'enabled' && draft.selected !== null && (presentationOrder.includes(draft.selected) || reservedChoices.has(draft.selected))
    && (draft.scopeIntent === 'turn' || draft.scopeIntent === 'workspace' && presentationOrder.includes(draft.selected))
}
