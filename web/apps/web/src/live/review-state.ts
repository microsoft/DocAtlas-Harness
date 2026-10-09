import { M4_PUBLISH_RULESET, type ArtifactManifest, type ClaimVersion, type ProductReviewCommand,
  type ProductReviewWorkspace, type ReviewResult } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { LiveState } from './client'
import { canonicalHash } from './state'

export interface ReviewIdentity { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number }
export interface ReviewOwner extends ReviewIdentity { scopeVersionId: string }
export interface ReviewPending { schemaVersion: 1, owner: ReviewOwner, request: ProductReviewCommand }
export type ReviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
export type ReviewOutbox = { state: 'empty' } | { state: 'invalid', key: string }
  | { state: 'pending', key: string, value: ReviewPending, current: boolean }
export type ClaimSave = Extract<ProductReviewCommand, { action: 'claim-save' }>
export type ClaimDraft = Omit<ClaimSave, 'schemaVersion' | 'kind' | 'expectedGeneration' | 'scopeVersionId' | 'idempotencyKey' | 'action'>
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const sameAccount = (left: ReviewIdentity, right: ReviewIdentity) => left.actorId === right.actorId && left.workspaceId === right.workspaceId && left.conversationId === right.conversationId
export const reviewIdentityKey = (owner: ReviewIdentity) => JSON.stringify([owner.actorId, owner.workspaceId, owner.conversationId, owner.bindingId, owner.generation])
export const reviewOwnerKey = (owner: ReviewOwner) => JSON.stringify([reviewIdentityKey(owner), owner.scopeVersionId])
export function reviewIdentity(state: LiveState): ReviewIdentity | null {
  const actor = state.actor, binding = state.snapshot?.binding
  return state.phase === 'ready' && actor && binding && state.selected === binding.conversationId && binding.ownerActorId === actor.actorId && binding.workspaceId === actor.workspaceId
    ? { ...actor, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation } : null
}
export function reviewPrefix(owner: ReviewIdentity): string {
  return `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@reviews:${encodeURIComponent(owner.conversationId)}:`
}
export function reviewStorageKey(owner: ReviewOwner): string { return `${reviewPrefix(owner)}${encodeURIComponent(owner.bindingId)}:${owner.generation}:${encodeURIComponent(owner.scopeVersionId)}` }

/** A tab-local pending body is a reconciliation candidate, never an automatic instruction. */
export function parseReviewPending(raw: string, identity: ReviewIdentity): ReviewPending {
  if (new TextEncoder().encode(raw).byteLength > 131072) throw new Error('Review outbox exceeds its bound')
  const value = JSON.parse(raw) as ReviewPending
  if (!value || !exact(value, ['schemaVersion', 'owner', 'request']) || value.schemaVersion !== 1 || !value.owner
    || !exact(value.owner, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation', 'scopeVersionId'])
    || ![value.owner.actorId, value.owner.workspaceId, value.owner.conversationId, value.owner.bindingId, value.owner.scopeVersionId].every(opaque)
    || !Number.isSafeInteger(value.owner.generation) || value.owner.generation < 1 || !sameAccount(value.owner, identity)) throw new Error('Invalid review outbox owner')
  const request = parseBrowserContract('product-review', value.request)
  if (request.kind !== 'review-command' || request.expectedGeneration !== value.owner.generation || request.scopeVersionId !== value.owner.scopeVersionId) throw new Error('Invalid review outbox context')
  return { ...value, request }
}
export function readReviewOutbox(storage: ReviewStorage, identity: ReviewIdentity, scopeVersionId: string | null): ReviewOutbox {
  if (storage.length > 2048) throw new Error('Too many tab-local drafts')
  const prefix = reviewPrefix(identity), keys: string[] = []
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key) }
  if (!keys.length) return { state: 'empty' }
  keys.sort(); const key = keys[0]!
  if (keys.length !== 1) return { state: 'invalid', key }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { state: 'invalid', key }
    const value = parseReviewPending(raw, identity)
    if (reviewStorageKey(value.owner) !== key) return { state: 'invalid', key }
    return { state: 'pending', key, value, current: reviewIdentityKey(value.owner) === reviewIdentityKey(identity) && value.owner.scopeVersionId === scopeVersionId }
  } catch { return { state: 'invalid', key } }
}
export function saveReviewPending(storage: ReviewStorage, pending: ReviewPending): void {
  const raw = JSON.stringify(pending), checked = parseReviewPending(raw, pending.owner), key = reviewStorageKey(checked.owner)
  if (readReviewOutbox(storage, checked.owner, checked.owner.scopeVersionId).state !== 'empty') throw new Error('A review operation is still uncertain')
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Review outbox was not retained')
}
export function artifactClaimUses(artifact: ArtifactManifest) {
  return artifact.kind === 'brief' ? artifact.content.sections.flatMap(section => section.claimUses) : artifact.content.cells.flatMap(cell => cell.claimUses)
}
export async function reviewReceiptMatches(pending: ReviewPending, candidate: unknown): Promise<boolean> {
  try {
    const value = parseBrowserContract('product-review', candidate), command = pending.request, owner = pending.owner
    if (value.kind !== 'review-result' || value.conversationId !== owner.conversationId || value.idempotencyKey !== command.idempotencyKey || value.requestHash !== await canonicalHash(command)
      || value.result.workspaceId !== owner.workspaceId || value.result.scopeVersionId !== owner.scopeVersionId) return false
    const result = value.result, authored = (actor: { kind: string, actorId?: string }) => actor.kind === 'user' && actor.actorId === owner.actorId
    switch (command.action) {
      case 'claim-save': {
        if (result.resultType !== 'm4-claim-record') return false
        const { sourceScopeVersionId, ...claimScope } = result.claim.scope
        return result.claim.statement === command.statement && result.claim.basis === command.basis && result.claim.epistemicStatus === command.epistemicStatus && result.claim.reviewStatus === command.reviewStatus
          && sourceScopeVersionId === owner.scopeVersionId && authored(result.claim.createdBy)
          && await canonicalHash(result.claim.proposition ?? null) === await canonicalHash(command.proposition ?? null)
          && await canonicalHash(claimScope) === await canonicalHash(command.claimScope ?? {})
          && (command.expectedClaimVersionId === null ? result.claim.version === 1 && result.claim.previousClaimVersionId === undefined
            : result.claim.previousClaimVersionId === command.expectedClaimVersionId && result.claim.claimVersionId !== command.expectedClaimVersionId)
      }
      case 'artifact-create': {
        if (result.resultType !== 'm4-artifact-draft' || result.manifest.kind !== command.artifactKind || result.manifest.status !== 'draft'
          || result.manifest.title !== command.title || result.manifest.sourceScopeVersionId !== owner.scopeVersionId || !authored(result.manifest.createdBy)) return false
        const signature = (uses: Array<{ claimVersionId: string, useKind: string }>) => uses.map(use => `${use.claimVersionId}\0${use.useKind}`).sort()
        return JSON.stringify(signature(artifactClaimUses(result.manifest))) === JSON.stringify(signature(command.claims))
      }
      case 'review-attest': return result.resultType === 'm4-conflict-search-assurance' && result.assurance.sourceScopeVersionId === owner.scopeVersionId && authored(result.assurance.assuredBy)
      case 'review-run': return result.resultType === 'm4-review-run' && result.review.subject.kind === 'artifact-manifest'
        && result.review.subject.objectIds.length === 1 && result.review.subject.objectIds[0] === command.artifactManifestId
        && result.review.ruleset.name === M4_PUBLISH_RULESET.name && result.review.ruleset.version === M4_PUBLISH_RULESET.version && result.review.ruleset.configHash === M4_PUBLISH_RULESET.configHash
      case 'review-decide': return result.resultType === 'm4-human-decision' && result.reviewDecision.reviewResultId === command.reviewResultId
        && result.reviewDecision.decision === command.decision && authored(result.reviewDecision.decidedBy)
        && (result.reviewDecision.rationale ?? '') === (command.rationale ?? '')
      case 'artifact-publish': return result.resultType === 'm4-artifact-publish' && result.manifest.status === 'published' && result.manifest.artifactManifestId === command.artifactManifestId
        && result.manifest.publication.reviewResultId === command.reviewResultId && result.manifest.publication.humanReviewDecisionId === command.humanReviewDecisionId && authored(result.manifest.publication.publishedBy)
    }
  } catch { return false }
}
export async function acknowledgeReview(storage: ReviewStorage, pending: ReviewPending, result: unknown): Promise<boolean> {
  if (!await reviewReceiptMatches(pending, result)) return false
  const key = reviewStorageKey(pending.owner)
  if (storage.getItem(key) !== JSON.stringify(pending)) return false
  storage.removeItem(key); return true
}
export function claimRevisionDraft(workspace: ProductReviewWorkspace, claim: ClaimVersion): ClaimDraft | null {
  const derivation = workspace.derivations.find(value => value.derivationActivityId === claim.provenanceActivityId)
  const relations = workspace.evidenceRelations.filter(value => value.claimVersionId === claim.claimVersionId && value.reviewStatus !== 'human-rejected')
  if (!derivation || !workspace.scope || workspace.scope.scopeVersionId !== claim.scope.sourceScopeVersionId
    || relations.some(value => !workspace.evidence.some(evidence => evidence.evidenceId === value.evidenceId))
    || derivation.inputEvidenceIds.some(id => !relations.some(value => value.evidenceId === id))
    || derivation.inputClaimVersionIds.some(id => !workspace.claims.some(value => value.claimVersionId === id))) return null
  const { sourceScopeVersionId: _sourceScopeVersionId, ...claimScope } = claim.scope
  return { statement: claim.statement, basis: claim.basis, epistemicStatus: claim.epistemicStatus, reviewStatus: claim.reviewStatus, expectedClaimVersionId: claim.claimVersionId,
    ...(claim.proposition ? { proposition: structuredClone(claim.proposition) } : {}), ...(Object.keys(claimScope).length ? { claimScope: structuredClone(claimScope) } : {}),
    evidenceRelations: relations.map(value => ({ evidenceId: value.evidenceId, kind: value.kind, coverage: value.coverage, ...(value.rationale ? { rationale: value.rationale } : {}) })),
    derivation: { operation: derivation.operation, inputClaimVersionIds: [...derivation.inputClaimVersionIds], ...(derivation.expression ? { expression: derivation.expression } : {}), ...(derivation.rounding ? { rounding: structuredClone(derivation.rounding) } : {}) } }
}
export function artifactReview(workspace: ProductReviewWorkspace, artifact: ArtifactManifest): ReviewResult | undefined {
  return workspace.reviews.filter(review => review.subject.kind === 'artifact-manifest' && review.subject.objectIds.length === 1 && review.subject.objectIds[0] === artifact.artifactManifestId).at(-1)
}
export function publishApproval(workspace: ProductReviewWorkspace, artifact: ArtifactManifest) {
  const review = artifactReview(workspace, artifact)
  if (artifact.status !== 'draft' || !review || !['pass', 'needs-human'].includes(review.decision) || !review.coverage.complete
    || review.gates.some(gate => gate.status === 'fail' || gate.status === 'not-run') || review.issues.some(issue => issue.severity === 'blocker')) return null
  // The server's durable append order, not clocks or opaque IDs, defines the latest sign-off.
  const decision = workspace.decisions.filter(value => value.reviewResultId === review.reviewResultId).at(-1)
  return decision?.decision === 'approved' ? { review, decision } : null
}
