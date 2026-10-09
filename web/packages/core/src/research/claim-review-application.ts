import { createHash } from 'node:crypto'
import { documentLocatorIssues, evidenceLocatorIssues, m4RpcIssues, M4_PUBLISH_RULESET, sourceScopeRpcIssues,
  type ActorRef, type ArtifactManifest, type ClaimLedgerSnapshot, type ClaimVersion, type DerivationActivity, type DocumentLocator,
  type EvidenceAtom, type EvidenceRelation, type M4RpcRequest, type M4RpcResult, type ReviewResult, type ScopedSourceIdentity, type SourceScopeVersion,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { DocumentAccessError } from '../document/session.js'
import { artifactContentHash } from '../storage/investigation-m4-store.js'
import type { SourceScopeStore } from '../storage/source-scope-store.js'

export interface ClaimReviewScope { readonly scope: SourceScopeVersion, readonly sources: readonly ScopedSourceIdentity[] }
export interface AuthorizedClaimEvidence {
  readonly kind: 'evidence-atom'
  readonly workspaceId: string
  readonly investigationId: string
  readonly sourceScopeVersionIds: readonly string[]
  readonly evidence: EvidenceAtom
  readonly locator: DocumentLocator
}
/** Trusted synchronous host ports. This human application is not a model tool or an approval bypass. */
export interface ClaimReviewContext extends ClaimReviewScope {
  readonly conversationId: string
  readonly workspaceId: string
  readonly investigationId: string
  readonly actor: ActorRef & { kind: 'user' }
  readonly signoffRequirement: ReviewResult['signoffRequirement']
  /** Optional canonical hash of the full product command before its M4 projection. */
  readonly commandHash?: string
  assertCurrent(): void
  authorize(action: M4RpcRequest['requestType']): void
  /** Authorize the whole immutable historical frame before disclosing even old Claim/Evidence IDs. */
  authorizeHistoricalScope(scopeVersionId: string): ClaimReviewScope
  /** Resolve canonical saved Evidence AND current access, never Recall/Notebook/Profile IDs or caller metadata. */
  getAuthorizedEvidence(evidenceId: string, scopeVersionId: string, action: M4RpcRequest['requestType']): AuthorizedClaimEvidence | undefined
}
export type ClaimReviewStore = Pick<SourceScopeStore, 'recordM4ClaimVersion' | 'getM4ClaimLedger' | 'recordM4ArtifactDraft' | 'recordM4ConflictSearchAssurance'
  | 'runM4ArtifactReview' | 'recordM4HumanReviewDecision' | 'publishM4Artifact' | 'getM4ArtifactManifest' | 'getM4ReviewResult'>
const readOnly = new Set<M4RpcRequest['requestType']>(['m4-claim-ledger-get', 'm4-artifact-get', 'm4-review-get'])
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => value === undefined ? 'undefined' : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}` : JSON.stringify(value)
const denied = (message: string): never => { throw new DocumentAccessError('permission-denied', message) }
const invalid = (message: string): never => { throw new DocumentAccessError('invalid-request', message) }

/** Host-neutral extraction of authenticated M4 assembly; immutable stores remain the only domain writer. */
export class ClaimReviewApplication {
  constructor(private readonly store: ClaimReviewStore, private readonly clock: () => string = () => new Date().toISOString()) {}

  handle(candidate: M4RpcRequest, context: ClaimReviewContext): M4RpcResult {
    let request: M4RpcRequest
    try { const parsed = parseContract('m4-rpc', candidate); if (!('requestType' in parsed) || m4RpcIssues(parsed).length) return invalid('Invalid M4 command'); request = structuredClone(parsed) }
    catch { return invalid('Invalid M4 command') }
    if (context.actor?.kind !== 'user' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(context.actor.actorId)
      || !['required', 'not-required'].includes(context.signoffRequirement)) return denied('Claim Review requires a trusted human actor and publication policy')
    if (context.commandHash !== undefined && (typeof context.commandHash !== 'string' || !/^[a-f0-9]{64}$/u.test(context.commandHash))) return invalid('Product command hash must be canonical SHA-256')
    if (request.sessionId !== context.conversationId || request.workspaceId !== context.workspaceId || request.investigationId !== context.investigationId) return denied('M4 command belongs to another authenticated context')
    const actor = structuredClone(context.actor), identity = canonical({ conversationId: context.conversationId, workspaceId: context.workspaceId,
      investigationId: context.investigationId, actor, signoffRequirement: context.signoffRequirement, commandHash: context.commandHash, scope: context.scope, sources: context.sources })
    const check = () => {
      synchronous(context.assertCurrent()); synchronous(context.authorize(request.requestType))
      if (canonical({ conversationId: context.conversationId, workspaceId: context.workspaceId, investigationId: context.investigationId, actor: context.actor,
        signoffRequirement: context.signoffRequirement, commandHash: context.commandHash, scope: context.scope, sources: context.sources }) !== identity) throw new DocumentAccessError('stale', 'M4 trusted execution frame changed')
    }
    check()
    if (!readOnly.has(request.requestType) && request.scopeVersionId !== context.scope.scopeVersionId) return denied('M4 mutations must use the exact current source scope')
    const frames = new Map<string, ClaimReviewScope>(), evidence = new Map<string, AuthorizedClaimEvidence>()
    const frame = (scopeVersionId: string): ClaimReviewScope => {
      check()
      const source = scopeVersionId === context.scope.scopeVersionId ? { scope: context.scope, sources: context.sources } : context.authorizeHistoricalScope(scopeVersionId)
      synchronous(source)
      if (!source) return denied('Historical source authorization is unavailable')
      const frozen = structuredClone(source)
      try {
        const result = parseContract('source-scope-rpc', { schemaVersion: 1, resultType: 'source-scope', sessionId: context.conversationId, status: 'active', scope: frozen.scope, sources: frozen.sources })
        if (sourceScopeRpcIssues(result).length) return denied('Invalid authorized source frame')
      } catch { return denied('Invalid authorized source frame') }
      if (frozen.scope.workspaceId !== context.workspaceId || frozen.scope.investigationId !== context.investigationId || frozen.scope.scopeVersionId !== scopeVersionId || !frozen.scope.locked) return denied('Source frame is outside the authorized Investigation')
      const previous = frames.get(scopeVersionId)
      if (previous && canonical(previous) !== canonical(frozen)) throw new DocumentAccessError('stale', 'Authorized source frame changed during M4 operation')
      frames.set(scopeVersionId, frozen); check(); return frozen
    }
    frame(request.scopeVersionId)
    const authorizeEvidence = (evidenceId: string, scopeVersionId: string) => {
      const scope = frame(scopeVersionId), value = context.getAuthorizedEvidence(evidenceId, scopeVersionId, request.requestType)
      synchronous(value)
      check()
      if (!value || value.kind !== 'evidence-atom' || value.workspaceId !== context.workspaceId || value.investigationId !== context.investigationId
        || !value.sourceScopeVersionIds.includes(scopeVersionId) || value.evidence.evidenceId !== evidenceId) return denied('Only authorized canonical Evidence can support this scoped Claim')
      try { parseContract('evidence-atom', value.evidence); parseContract('document-locator', value.locator) } catch { return invalid('Canonical Evidence identity is invalid') }
      if (documentLocatorIssues(value.locator).length || evidenceLocatorIssues(value.evidence, value.locator).length
        || !scope.sources.some(source => source.documentId === value.locator.documentId && source.revisionId === value.locator.revisionId
          && source.representationId === value.locator.representationId && source.representationContentHash === value.locator.representationContentHash)) return denied('Evidence does not belong to the exact authorized source revision and representation')
      if (value.evidence.content.text !== undefined && digest(value.evidence.content.text) !== value.evidence.contentHash) throw new DocumentAccessError('invalid-output', 'Canonical Evidence text hash is invalid')
      const key = `${scopeVersionId}\0${evidenceId}`, previous = evidence.get(key)
      if (previous && canonical(previous) !== canonical(value)) throw new DocumentAccessError('stale', 'Authorized Evidence changed during M4 operation')
      evidence.set(key, structuredClone(value))
    }
    let ledger: ClaimLedgerSnapshot | undefined
    const claimGraph = (ids: readonly string[], includeSuccessors = false): void => {
      ledger ??= this.store.getM4ClaimLedger(context.workspaceId, context.investigationId)
      const claims = new Map(ledger.claims.map(claim => [claim.claimVersionId, claim])), derivations = new Map(ledger.derivations.map(activity => [activity.derivationActivityId, activity]))
      const queue = [...ids], visited = new Set<string>()
      while (queue.length) {
        const id = queue.pop()!; if (visited.has(id)) continue; visited.add(id)
        if (visited.size > 10000) throw new DocumentAccessError('invalid-request', 'Claim lineage exceeds the application traversal bound')
        const claim = claims.get(id)
        if (!claim || claim.workspaceId !== context.workspaceId || claim.investigationId !== context.investigationId) return denied('Referenced ClaimVersion is not available to this Investigation')
        frame(claim.scope.sourceScopeVersionId)
        const activity = derivations.get(claim.provenanceActivityId)
        if (!activity || activity.workspaceId !== context.workspaceId || activity.investigationId !== context.investigationId) throw new DocumentAccessError('invalid-output', 'Claim provenance is unavailable')
        for (const evidenceId of new Set([...activity.inputEvidenceIds, ...ledger.evidenceRelations.filter(relation => relation.claimVersionId === id).map(relation => relation.evidenceId)])) authorizeEvidence(evidenceId, claim.scope.sourceScopeVersionId)
        queue.push(...activity.inputClaimVersionIds)
        if (claim.previousClaimVersionId) queue.push(claim.previousClaimVersionId)
        // Deterministic Review consumes the complete version-chain closure, including
        // successors. Authorize that same closure before it can emit checked-object IDs.
        // Frozen artifact reads do not implicitly consume later versions.
        if (includeSuccessors && claim.supersededByClaimVersionId) queue.push(claim.supersededByClaimVersionId)
      }
    }
    const artifact = (id: string, exact: boolean, includeSuccessors = false): ArtifactManifest => {
      check(); const value = this.store.getM4ArtifactManifest(context.workspaceId, id)
      if (value.workspaceId !== context.workspaceId || value.investigationId !== context.investigationId || exact && value.sourceScopeVersionId !== request.scopeVersionId) return denied('Artifact does not belong to this exact source scope')
      frame(value.sourceScopeVersionId)
      if (value.content.kind === 'matrix') for (const row of value.content.rows) if (row.source && !frame(value.sourceScopeVersionId).scope.included.some(source => source.documentId === row.source!.documentId && source.revisionId === row.source!.revisionId)) return denied('Matrix row source is outside its authorized scope')
      const uses = value.content.kind === 'brief' ? value.content.sections.flatMap(section => section.claimUses) : value.content.cells.flatMap(cell => cell.claimUses)
      claimGraph(uses.map(use => use.claimVersionId), includeSuccessors)
      for (const id of new Set(uses.flatMap(use => use.citationEvidenceIds))) authorizeEvidence(id, value.sourceScopeVersionId)
      if (artifactContentHash(value.content) !== value.contentHash) throw new DocumentAccessError('invalid-output', 'Artifact content hash is invalid')
      return value
    }
    const review = (id: string): ReviewResult => {
      check(); const value = this.store.getM4ReviewResult(context.workspaceId, id)
      if (value.workspaceId !== context.workspaceId || value.investigationId !== context.investigationId || value.sourceScopeVersionId !== request.scopeVersionId) return denied('Review does not belong to this exact source scope')
      frame(value.sourceScopeVersionId)
      for (const id of value.subject.objectIds) artifact(id, true)
      // A saved Review may have inspected successors that its original Artifact
      // did not cite. Reauthorize its frozen checked Claims, without substituting
      // newer successors that were not part of this immutable Review.
      ledger ??= this.store.getM4ClaimLedger(context.workspaceId, context.investigationId)
      const checked = new Set(value.checkedObjectIds)
      claimGraph(ledger.claims.filter(claim => checked.has(claim.claimVersionId)).map(claim => claim.claimVersionId))
      return value
    }
    const recheck = () => { check(); for (const id of frames.keys()) frame(id); for (const [key] of evidence) { const split = key.indexOf('\0'); authorizeEvidence(key.slice(split + 1), key.slice(0, split)) }; check() }
    const finish = (result: M4RpcResult): M4RpcResult => {
      recheck(); parseContract('m4-rpc', result)
      if (m4RpcIssues(result, request).length) throw new DocumentAccessError('invalid-output', 'M4 result failed its authenticated contract')
      return result
    }
    const now = this.clock()
    if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) return invalid('M4 host clock must return canonical ISO time')
    const base = { schemaVersion: 1 as const, workspaceId: context.workspaceId, investigationId: context.investigationId, scopeVersionId: request.scopeVersionId }
    // User identity is part of the idempotent effect, while wall-clock hydration never changes a replay key.
    const mutation = 'idempotencyKey' in request ? { workspaceId: context.workspaceId, investigationId: context.investigationId, idempotencyKey: request.idempotencyKey,
      idempotencyInput: { request, actor, ...(context.commandHash === undefined ? {} : { productCommandHash: context.commandHash }) } } : undefined
    switch (request.requestType) {
      case 'm4-claim-record': {
        claimGraph([...request.provenance.inputClaimVersionIds, ...(request.expectedCurrentClaimVersionId ? [request.expectedCurrentClaimVersionId] : [])])
        for (const id of new Set([...request.provenance.inputEvidenceIds, ...request.evidenceRelations.map(relation => relation.evidenceId)])) authorizeEvidence(id, request.scopeVersionId)
        const claim: ClaimVersion = { ...structuredClone(request.claim), workspaceId: context.workspaceId, investigationId: context.investigationId,
          scope: { ...request.claim.scope, sourceScopeVersionId: request.scopeVersionId }, lifecycleStatus: 'current', createdBy: actor, createdAt: now, provenanceActivityId: request.provenance.derivationActivityId }
        const provenance: DerivationActivity = { schemaVersion: 1, derivationActivityId: request.provenance.derivationActivityId, operation: request.provenance.operation,
          inputEvidenceIds: [...request.provenance.inputEvidenceIds], inputClaimVersionIds: [...request.provenance.inputClaimVersionIds],
          ...(request.provenance.expression === undefined ? {} : { expression: request.provenance.expression }), ...(request.provenance.rounding === undefined ? {} : { rounding: structuredClone(request.provenance.rounding) }),
          workspaceId: context.workspaceId, investigationId: context.investigationId,
          outputClaimVersionIds: [claim.claimVersionId], actor, startedAt: now, completedAt: now }
        const relations: EvidenceRelation[] = request.evidenceRelations.map(relation => ({ ...structuredClone(relation), workspaceId: context.workspaceId, investigationId: context.investigationId,
          claimVersionId: claim.claimVersionId, createdBy: actor, createdAt: now, reviewStatus: 'human-confirmed', reviewedBy: actor, reviewedAt: now }))
        recheck(); const saved = this.store.recordM4ClaimVersion({ ...mutation!, expectedCurrentClaimVersionId: request.expectedCurrentClaimVersionId, claim, provenance, evidenceRelations: relations })
        return finish({ ...base, resultType: 'm4-claim-record', status: saved.status, claim: saved.value })
      }
      case 'm4-claim-ledger-get': {
        ledger = this.store.getM4ClaimLedger(context.workspaceId, context.investigationId); claimGraph(ledger.claims.map(claim => claim.claimVersionId))
        return finish({ ...base, resultType: 'm4-claim-ledger', ledger })
      }
      case 'm4-artifact-draft': {
        if (request.expectedPreviousArtifactManifestId) artifact(request.expectedPreviousArtifactManifestId, false)
        if (request.manifest.content.kind === 'matrix') for (const row of request.manifest.content.rows) if (row.source && !frame(request.scopeVersionId).scope.included.some(source => source.documentId === row.source!.documentId && source.revisionId === row.source!.revisionId)) return denied('Matrix row source is outside its authorized scope')
        const uses = request.manifest.content.kind === 'brief' ? request.manifest.content.sections.flatMap(section => section.claimUses) : request.manifest.content.cells.flatMap(cell => cell.claimUses)
        claimGraph(uses.map(use => use.claimVersionId)); for (const id of new Set(uses.flatMap(use => use.citationEvidenceIds))) authorizeEvidence(id, request.scopeVersionId)
        const manifest = { ...structuredClone(request.manifest), workspaceId: context.workspaceId, investigationId: context.investigationId, sourceScopeVersionId: request.scopeVersionId,
          status: 'draft' as const, contentHash: artifactContentHash(request.manifest.content), createdBy: actor, createdAt: now }
        recheck(); const saved = this.store.recordM4ArtifactDraft({ ...mutation!, expectedPreviousArtifactManifestId: request.expectedPreviousArtifactManifestId, manifest })
        if (saved.value.status !== 'draft') throw new DocumentAccessError('invalid-output', 'Artifact replay did not return its original draft')
        return finish({ ...base, resultType: 'm4-artifact-draft', status: saved.status, manifest: saved.value as ArtifactManifest & { status: 'draft' } })
      }
      case 'm4-conflict-search-assure': {
        claimGraph(request.claimVersionIds); for (const id of request.evidenceIds) authorizeEvidence(id, request.scopeVersionId)
        const assurance = { schemaVersion: 1 as const, assuranceId: `conflict-assurance:${digest(`${context.workspaceId}\0${context.investigationId}\0${request.idempotencyKey}`).slice(0, 32)}`,
          workspaceId: context.workspaceId, investigationId: context.investigationId, sourceScopeVersionId: request.scopeVersionId, claimVersionIds: [...request.claimVersionIds], evidenceIds: [...request.evidenceIds], assuredBy: actor, assuredAt: now }
        recheck(); const saved = this.store.recordM4ConflictSearchAssurance({ ...mutation!, assurance })
        return finish({ ...base, resultType: 'm4-conflict-search-assurance', status: saved.status, assurance: saved.value })
      }
      case 'm4-review-run': {
        if (canonical(request.ruleset) !== canonical(M4_PUBLISH_RULESET) || request.signoffRequirement !== context.signoffRequirement) return denied('Review ruleset or sign-off requirement differs from trusted host policy')
        artifact(request.artifactManifestId, true, true); recheck()
        const saved = this.store.runM4ArtifactReview({ ...mutation!, artifactManifestId: request.artifactManifestId, reviewResultId: request.reviewResultId, ruleset: { ...M4_PUBLISH_RULESET },
          signoffRequirement: context.signoffRequirement, reviewer: { kind: 'rule', actorId: 'rule:docatlas-publish-gates' }, createdAt: now })
        return finish({ ...base, resultType: 'm4-review-run', status: saved.status, review: saved.value })
      }
      case 'm4-human-decision': {
        review(request.reviewResultId); recheck()
        const saved = this.store.recordM4HumanReviewDecision({ ...mutation!, decision: { schemaVersion: 1, reviewDecisionId: request.reviewDecisionId, workspaceId: context.workspaceId,
          investigationId: context.investigationId, reviewResultId: request.reviewResultId, decision: request.decision,
          ...(request.rationale === undefined ? {} : { rationale: request.rationale }), decidedBy: actor, decidedAt: now } })
        return finish({ ...base, resultType: 'm4-human-decision', status: saved.status, reviewDecision: saved.value })
      }
      case 'm4-artifact-publish': {
        artifact(request.artifactManifestId, true, true); const reviewed = review(request.reviewResultId)
        if (reviewed.signoffRequirement !== context.signoffRequirement || canonical(reviewed.ruleset) !== canonical(M4_PUBLISH_RULESET)) return denied('Publication policy no longer matches the pinned Review')
        recheck(); const saved = this.store.publishM4Artifact({ ...mutation!, artifactManifestId: request.artifactManifestId, expectedStatus: request.expectedStatus, reviewResultId: request.reviewResultId,
          ...(request.humanReviewDecisionId === undefined ? {} : { humanReviewDecisionId: request.humanReviewDecisionId }), publishedBy: actor, publishedAt: now })
        if (saved.value.status !== 'published') throw new DocumentAccessError('invalid-output', 'Publication did not return a published manifest')
        return finish({ ...base, resultType: 'm4-artifact-publish', status: saved.status, manifest: saved.value as ArtifactManifest & { status: 'published' } })
      }
      case 'm4-artifact-get': return finish({ ...base, resultType: 'm4-artifact', manifest: artifact(request.artifactManifestId, true) })
      case 'm4-review-get': return finish({ ...base, resultType: 'm4-review', review: review(request.reviewResultId) })
    }
  }
}

function isPromise(value: unknown): boolean { return value !== null && typeof value === 'object' && typeof Reflect.get(value, 'then') === 'function' }
function synchronous(value: unknown): void {
  if (isPromise(value)) { void Promise.resolve(value).catch(() => {}); throw new DocumentAccessError('unavailable', 'Claim Review authorization ports must be synchronous') }
}
