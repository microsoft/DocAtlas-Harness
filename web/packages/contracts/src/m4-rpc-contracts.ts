import {
  artifactManifestIssues,
  type ArtifactManifest,
  type BriefArtifactContent,
  type MatrixArtifactContent,
} from './artifact-contracts.js'
import {
  claimLedgerIssues,
  claimVersionIssues,
  type ClaimBasis,
  type ClaimEpistemicStatus,
  type ClaimProposition,
  type ClaimReviewStatus,
  type ClaimScope,
  type ClaimVersion,
  type DerivationActivity,
  type DerivationOperation,
  type EvidenceRelation,
  type EvidenceRelationKind,
  type ClaimLedgerSnapshot,
} from './claim-contracts.js'
import type { ActorRef, IsoTimestamp, OpaqueId } from './m0-contracts.js'
import type { AddM4ContractIssue, M4ContractIssue } from './m4-contract-issues.js'
import { reviewResultIssues, type ReviewResult } from './review-contracts.js'

export const M4_PUBLISH_RULESET = {
  name: 'docatlas-publish-gates',
  version: '1.0.0',
  configHash: '30288476e404da8e42aaadbd5ef63a498ecd7761856d2fc92dd63806e8dc971a',
} as const satisfies ReviewResult['ruleset']

interface M4AuthenticatedRequestBase {
  schemaVersion: 1
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
}

interface M4MutationRequestBase extends M4AuthenticatedRequestBase {
  idempotencyKey: OpaqueId
}

/**
 * Browser claim input deliberately omits identity, authority, lifecycle and
 * clock fields. The authenticated Host hydrates those fields and records one
 * current immutable ClaimVersion.
 */
export interface M4ClaimVersionDraft {
  schemaVersion: 1
  claimVersionId: OpaqueId
  claimChainId: OpaqueId
  version: number
  previousClaimVersionId?: OpaqueId
  statement: string
  basis: ClaimBasis
  proposition?: ClaimProposition
  scope: Omit<ClaimScope, 'sourceScopeVersionId'>
  epistemicStatus: ClaimEpistemicStatus
  reviewStatus: ClaimReviewStatus
}

/** Host adds workspace/Investigation, user actor, times, DSH provenance and output id. */
export interface M4DerivationDraft {
  schemaVersion: 1
  derivationActivityId: OpaqueId
  operation: DerivationOperation
  inputEvidenceIds: OpaqueId[]
  inputClaimVersionIds: OpaqueId[]
  expression?: string
  rounding?: DerivationActivity['rounding']
}

/** A browser relation is an explicit user confirmation; review authority is Host-derived. */
export interface M4EvidenceRelationDraft {
  schemaVersion: 1
  evidenceRelationId: OpaqueId
  evidenceId: OpaqueId
  kind: EvidenceRelationKind
  coverage: EvidenceRelation['coverage']
  rationale?: string
}

export interface M4ClaimRecordRequest extends M4MutationRequestBase {
  requestType: 'm4-claim-record'
  expectedCurrentClaimVersionId: OpaqueId | null
  claim: M4ClaimVersionDraft
  provenance: M4DerivationDraft
  evidenceRelations: M4EvidenceRelationDraft[]
}

export interface M4ClaimLedgerGetRequest extends M4AuthenticatedRequestBase {
  requestType: 'm4-claim-ledger-get'
}

export type M4ArtifactManifestDraft = {
  schemaVersion: 1
  artifactManifestId: OpaqueId
  artifactId: OpaqueId
  version: number
  previousArtifactManifestId?: OpaqueId
  title: string
  personalizationUseIds: OpaqueId[]
} & (
  | { kind: 'brief', content: BriefArtifactContent }
  | { kind: 'matrix', content: MatrixArtifactContent }
)

export interface M4ArtifactDraftRequest extends M4MutationRequestBase {
  requestType: 'm4-artifact-draft'
  expectedPreviousArtifactManifestId: OpaqueId | null
  manifest: M4ArtifactManifestDraft
}

export interface M4ConflictSearchAssureRequest extends M4MutationRequestBase {
  requestType: 'm4-conflict-search-assure'
  claimVersionIds: OpaqueId[]
  evidenceIds: OpaqueId[]
}

export interface M4ReviewRunRequest extends M4MutationRequestBase {
  requestType: 'm4-review-run'
  artifactManifestId: OpaqueId
  reviewResultId: OpaqueId
  ruleset: ReviewResult['ruleset']
  signoffRequirement: ReviewResult['signoffRequirement']
}

export interface M4HumanDecisionRequest extends M4MutationRequestBase {
  requestType: 'm4-human-decision'
  reviewDecisionId: OpaqueId
  reviewResultId: OpaqueId
  decision: 'approved' | 'rejected'
  rationale?: string
}

export interface M4ArtifactPublishRequest extends M4MutationRequestBase {
  requestType: 'm4-artifact-publish'
  artifactManifestId: OpaqueId
  expectedStatus: 'draft'
  reviewResultId: OpaqueId
  humanReviewDecisionId?: OpaqueId
}

export interface M4ArtifactGetRequest extends M4AuthenticatedRequestBase {
  requestType: 'm4-artifact-get'
  artifactManifestId: OpaqueId
}

export interface M4ReviewGetRequest extends M4AuthenticatedRequestBase {
  requestType: 'm4-review-get'
  reviewResultId: OpaqueId
}

export type M4RpcRequest =
  | M4ClaimRecordRequest
  | M4ClaimLedgerGetRequest
  | M4ArtifactDraftRequest
  | M4ConflictSearchAssureRequest
  | M4ReviewRunRequest
  | M4HumanDecisionRequest
  | M4ArtifactPublishRequest
  | M4ArtifactGetRequest
  | M4ReviewGetRequest

export interface M4ConflictSearchAssurance {
  schemaVersion: 1
  assuranceId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  sourceScopeVersionId: OpaqueId
  claimVersionIds: OpaqueId[]
  evidenceIds: OpaqueId[]
  assuredBy: ActorRef & { kind: 'user' }
  assuredAt: IsoTimestamp
}

export interface M4HumanReviewDecision {
  schemaVersion: 1
  reviewDecisionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  reviewResultId: OpaqueId
  decision: 'approved' | 'rejected'
  rationale?: string
  decidedBy: ActorRef & { kind: 'user' }
  decidedAt: IsoTimestamp
}

interface M4ResultBase {
  schemaVersion: 1
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
}

interface M4MutationResultBase extends M4ResultBase {
  status: 'created' | 'replayed'
}

export interface M4ClaimRecordResult extends M4MutationResultBase {
  resultType: 'm4-claim-record'
  claim: ClaimVersion
}

export interface M4ClaimLedgerResult extends M4ResultBase {
  resultType: 'm4-claim-ledger'
  ledger: ClaimLedgerSnapshot
}

export interface M4ArtifactDraftResult extends M4MutationResultBase {
  resultType: 'm4-artifact-draft'
  manifest: ArtifactManifest & { status: 'draft' }
}

export interface M4ConflictSearchAssureResult extends M4MutationResultBase {
  resultType: 'm4-conflict-search-assurance'
  assurance: M4ConflictSearchAssurance
}

export interface M4ReviewRunResult extends M4MutationResultBase {
  resultType: 'm4-review-run'
  review: ReviewResult
}

export interface M4HumanDecisionResult extends M4MutationResultBase {
  resultType: 'm4-human-decision'
  reviewDecision: M4HumanReviewDecision
}

export interface M4ArtifactPublishResult extends M4MutationResultBase {
  resultType: 'm4-artifact-publish'
  manifest: ArtifactManifest & { status: 'published' }
}

export interface M4ArtifactGetResult extends M4ResultBase {
  resultType: 'm4-artifact'
  manifest: ArtifactManifest
}

export interface M4ReviewGetResult extends M4ResultBase {
  resultType: 'm4-review'
  review: ReviewResult
}

export type M4RpcResult =
  | M4ClaimRecordResult
  | M4ClaimLedgerResult
  | M4ArtifactDraftResult
  | M4ConflictSearchAssureResult
  | M4ReviewRunResult
  | M4HumanDecisionResult
  | M4ArtifactPublishResult
  | M4ArtifactGetResult
  | M4ReviewGetResult

export type M4RpcValue = M4RpcRequest | M4RpcResult

/** Cross-field and request/result binding checks beyond JSON Schema shape. */
export function m4RpcIssues(
  value: M4RpcValue,
  request?: M4RpcRequest,
): M4ContractIssue[] {
  const { issues, add } = issueCollector()
  if ('requestType' in value) {
    validateRequest(value, add)
    return issues
  }

  validateResult(value, add)
  if (request !== undefined) validateResultBinding(value, request, add)
  return issues
}

function validateRequest(value: M4RpcRequest, add: AddM4ContractIssue): void {
  switch (value.requestType) {
    case 'm4-claim-record': {
      const { claim, provenance, evidenceRelations } = value
      const relationIds = evidenceRelations.map(relation => relation.evidenceRelationId)
      if (new Set(relationIds).size !== relationIds.length) {
        add('m4-rpc-duplicate-id', '/evidenceRelations', 'EvidenceRelation draft ids must be unique')
      }
      if (value.expectedCurrentClaimVersionId === null) {
        if (claim.version !== 1 || claim.previousClaimVersionId !== undefined) {
          add('m4-rpc-cas', '/claim/version', 'a new Claim chain must begin at version 1 without a predecessor')
        }
      } else if (claim.version < 2
        || claim.previousClaimVersionId !== value.expectedCurrentClaimVersionId) {
        add('m4-rpc-cas', '/claim/previousClaimVersionId', 'a Claim revision must pin the expected current version')
      }
      if (provenance.inputEvidenceIds.length === 0
        && provenance.inputClaimVersionIds.length === 0) {
        add('derivation-activity-provenance', '/provenance', 'claim provenance must consume Evidence or a prior ClaimVersion')
      }
      if (provenance.operation === 'extract' && provenance.inputEvidenceIds.length === 0) {
        add('derivation-activity-provenance', '/provenance/inputEvidenceIds', 'extract requires an EvidenceAtom input')
      }
      if (provenance.operation === 'calculate'
        && (provenance.expression === undefined || provenance.rounding === undefined)) {
        add('derivation-activity-provenance', '/provenance', 'calculate requires an expression and rounding policy')
      }
      for (const [index, relation] of evidenceRelations.entries()) {
        if (!provenance.inputEvidenceIds.includes(relation.evidenceId)) {
          add('m4-rpc-reference', `/evidenceRelations/${index}/evidenceId`, 'a related EvidenceAtom must be an explicit provenance input')
        }
      }
      if (claim.basis === 'document-supported' && evidenceRelations.length === 0) {
        add('claim-ledger-basis', '/evidenceRelations', 'a document-supported Claim requires explicit EvidenceRelations')
      }
      if (claim.basis === 'derived-from-claims' && provenance.inputClaimVersionIds.length === 0) {
        add('claim-ledger-basis', '/provenance/inputClaimVersionIds', 'a derived Claim requires ClaimVersion inputs')
      }
      if ((claim.basis === 'user-assumption' || claim.basis === 'project-decision'
        || claim.basis === 'external-knowledge') && evidenceRelations.length > 0) {
        add('claim-ledger-basis', '/evidenceRelations', 'assumptions, decisions and external knowledge cannot claim document support')
      }
      return
    }
    case 'm4-artifact-draft': {
      if (value.expectedPreviousArtifactManifestId === null) {
        if (value.manifest.version !== 1
          || value.manifest.previousArtifactManifestId !== undefined) {
          add('m4-rpc-cas', '/manifest/version', 'a new Artifact chain must begin at version 1 without a predecessor')
        }
      } else if (value.manifest.version < 2
        || value.manifest.previousArtifactManifestId
          !== value.expectedPreviousArtifactManifestId) {
        add('m4-rpc-cas', '/manifest/previousArtifactManifestId', 'an Artifact revision must pin the expected latest manifest')
      }
      appendAt(add, artifactManifestIssues(hydrateDraftArtifact(value)), '/manifest')
      return
    }
    case 'm4-conflict-search-assure':
      if (!isUniqueSorted(value.claimVersionIds) || !isUniqueSorted(value.evidenceIds)) {
        add('m4-rpc-assurance-set', '/', 'conflict assurance Claim and Evidence ids must be unique and lexically sorted')
      }
      return
    case 'm4-claim-ledger-get':
      return
    case 'm4-review-run':
      if (!sameRuleset(value.ruleset, M4_PUBLISH_RULESET)) {
        add('m4-rpc-ruleset', '/ruleset', 'review request must pin the configured deterministic publication ruleset')
      }
      return
    case 'm4-human-decision':
    case 'm4-artifact-publish':
    case 'm4-artifact-get':
    case 'm4-review-get':
      return
  }
}

function validateResult(value: M4RpcResult, add: AddM4ContractIssue): void {
  switch (value.resultType) {
    case 'm4-claim-record':
      appendAt(add, claimVersionIssues(value.claim), '/claim')
      validateObjectIdentity(value, value.claim, '/claim', add)
      if (value.claim.scope.sourceScopeVersionId !== value.scopeVersionId) {
        add('m4-rpc-identity', '/claim/scope/sourceScopeVersionId', 'recorded Claim must remain in the authenticated source scope')
      }
      if (value.claim.createdBy.kind !== 'user') {
        add('m4-rpc-authority', '/claim/createdBy/kind', 'browser Claim recording requires authenticated user authority')
      }
      return
    case 'm4-claim-ledger':
      appendAt(add, claimLedgerIssues(value.ledger), '/ledger')
      for (const [index, claim] of value.ledger.claims.entries()) {
        validateObjectIdentity(value, claim, `/ledger/claims/${index}`, add)
      }
      for (const [index, relation] of value.ledger.evidenceRelations.entries()) {
        validateObjectIdentity(value, relation, `/ledger/evidenceRelations/${index}`, add)
      }
      for (const [index, derivation] of value.ledger.derivations.entries()) {
        validateObjectIdentity(value, derivation, `/ledger/derivations/${index}`, add)
      }
      return
    case 'm4-artifact-draft':
    case 'm4-artifact-publish':
    case 'm4-artifact':
      appendAt(add, artifactManifestIssues(value.manifest).filter(issue =>
        issue.code !== 'artifact-review-reference'), '/manifest')
      validateObjectIdentity(value, value.manifest, '/manifest', add)
      if (value.manifest.sourceScopeVersionId !== value.scopeVersionId) {
        add('m4-rpc-identity', '/manifest/sourceScopeVersionId', 'Artifact must remain in the authenticated source scope')
      }
      if (value.resultType === 'm4-artifact-draft' && value.manifest.status !== 'draft') {
        add('m4-rpc-result', '/manifest/status', 'artifact draft result must contain a draft')
      }
      if (value.resultType === 'm4-artifact-draft' && value.manifest.createdBy.kind !== 'user') {
        add('m4-rpc-authority', '/manifest/createdBy/kind', 'browser Artifact drafts require authenticated user authority')
      }
      if (value.resultType === 'm4-artifact-publish' && value.manifest.status !== 'published') {
        add('m4-rpc-result', '/manifest/status', 'artifact publish result must contain a published manifest')
      }
      if (value.resultType === 'm4-artifact-publish'
        && value.manifest.publication?.publishedBy.kind !== 'user') {
        add('m4-rpc-authority', '/manifest/publication/publishedBy/kind', 'browser publication requires authenticated user authority')
      }
      return
    case 'm4-review-run':
    case 'm4-review':
      appendAt(add, reviewResultIssues(value.review), '/review')
      validateObjectIdentity(value, value.review, '/review', add)
      if (value.review.sourceScopeVersionId !== value.scopeVersionId) {
        add('m4-rpc-identity', '/review/sourceScopeVersionId', 'Review must remain in the authenticated source scope')
      }
      return
    case 'm4-human-decision':
      validateObjectIdentity(value, value.reviewDecision, '/reviewDecision', add)
      if (value.reviewDecision.decidedBy.kind !== 'user') {
        add('m4-rpc-authority', '/reviewDecision/decidedBy/kind', 'human review decisions require authenticated user authority')
      }
      return
    case 'm4-conflict-search-assurance':
      validateObjectIdentity(value, value.assurance, '/assurance', add)
      if (value.assurance.sourceScopeVersionId !== value.scopeVersionId) {
        add('m4-rpc-identity', '/assurance/sourceScopeVersionId', 'conflict assurance must remain in the authenticated source scope')
      }
      if (value.assurance.assuredBy.kind !== 'user') {
        add('m4-rpc-authority', '/assurance/assuredBy/kind', 'conflict-search assurance requires authenticated user authority')
      }
      if (!isUniqueSorted(value.assurance.claimVersionIds)
        || !isUniqueSorted(value.assurance.evidenceIds)) {
        add('m4-rpc-assurance-set', '/assurance', 'assured Claim and Evidence ids must be unique and lexically sorted')
      }
      return
  }
}

function validateResultBinding(
  value: M4RpcResult,
  request: M4RpcRequest,
  add: AddM4ContractIssue,
): void {
  if (value.workspaceId !== request.workspaceId
    || value.investigationId !== request.investigationId
    || value.scopeVersionId !== request.scopeVersionId) {
    add('m4-rpc-identity', '/', 'M4 result must match the exact authenticated request scope')
  }
  const pair = `${request.requestType}\0${value.resultType}`
  const expectedPairs = new Set([
    'm4-claim-record\0m4-claim-record',
    'm4-claim-ledger-get\0m4-claim-ledger',
    'm4-artifact-draft\0m4-artifact-draft',
    'm4-conflict-search-assure\0m4-conflict-search-assurance',
    'm4-review-run\0m4-review-run',
    'm4-human-decision\0m4-human-decision',
    'm4-artifact-publish\0m4-artifact-publish',
    'm4-artifact-get\0m4-artifact',
    'm4-review-get\0m4-review',
  ])
  if (!expectedPairs.has(pair)) {
    add('m4-rpc-result', '/resultType', 'M4 result type does not answer this request type')
    return
  }
  if (request.requestType === 'm4-claim-record' && value.resultType === 'm4-claim-record') {
    const draft = request.claim
    if (!claimMatchesDraft(value.claim, draft, request.provenance.derivationActivityId)) {
      add('m4-rpc-result', '/claim', 'recorded Claim does not match the submitted immutable draft')
    }
  } else if (request.requestType === 'm4-artifact-draft'
    && value.resultType === 'm4-artifact-draft') {
    if (!artifactMatchesDraft(value.manifest, request.manifest)) {
      add('m4-rpc-result', '/manifest', 'recorded Artifact does not match the submitted immutable draft')
    }
  } else if (request.requestType === 'm4-conflict-search-assure'
    && value.resultType === 'm4-conflict-search-assurance') {
    if (!sameIds(value.assurance.claimVersionIds, request.claimVersionIds)
      || !sameIds(value.assurance.evidenceIds, request.evidenceIds)) {
      add('m4-rpc-result', '/assurance', 'conflict-search assurance changed the exact reviewed set')
    }
  } else if (request.requestType === 'm4-review-run'
    && value.resultType === 'm4-review-run') {
    if (value.review.reviewResultId !== request.reviewResultId
      || value.review.mode !== 'publish-gate'
      || value.review.subject.objectIds.length !== 1
      || value.review.subject.objectIds[0] !== request.artifactManifestId
      || value.review.signoffRequirement !== request.signoffRequirement
      || !sameRuleset(value.review.ruleset, request.ruleset)) {
      add('m4-rpc-result', '/review', 'deterministic Review does not pin the requested artifact and ruleset')
    }
  } else if (request.requestType === 'm4-human-decision'
    && value.resultType === 'm4-human-decision') {
    const decision = value.reviewDecision
    if (decision.reviewDecisionId !== request.reviewDecisionId
      || decision.reviewResultId !== request.reviewResultId
      || decision.decision !== request.decision
      || decision.rationale !== request.rationale) {
      add('m4-rpc-result', '/reviewDecision', 'human decision result does not match the explicit user decision')
    }
  } else if (request.requestType === 'm4-artifact-publish'
    && value.resultType === 'm4-artifact-publish') {
    const publication = value.manifest.publication
    if (value.manifest.artifactManifestId !== request.artifactManifestId
      || publication?.reviewResultId !== request.reviewResultId
      || publication?.humanReviewDecisionId !== request.humanReviewDecisionId) {
      add('m4-rpc-result', '/manifest/publication', 'publication does not pin the exact requested manifest and review authority')
    }
  } else if (request.requestType === 'm4-artifact-get'
    && value.resultType === 'm4-artifact'
    && value.manifest.artifactManifestId !== request.artifactManifestId) {
    add('m4-rpc-result', '/manifest/artifactManifestId', 'artifact query returned a different immutable manifest')
  } else if (request.requestType === 'm4-review-get'
    && value.resultType === 'm4-review'
    && value.review.reviewResultId !== request.reviewResultId) {
    add('m4-rpc-result', '/review/reviewResultId', 'review query returned a different immutable result')
  }
}

function claimMatchesDraft(
  claim: ClaimVersion,
  draft: M4ClaimVersionDraft,
  provenanceActivityId: OpaqueId,
): boolean {
  const { sourceScopeVersionId: _sourceScopeVersionId, ...scopeDraft } = claim.scope
  return claim.claimVersionId === draft.claimVersionId
    && claim.claimChainId === draft.claimChainId
    && claim.version === draft.version
    && claim.previousClaimVersionId === draft.previousClaimVersionId
    && claim.statement === draft.statement
    && claim.basis === draft.basis
    && canonicalJson(claim.proposition) === canonicalJson(draft.proposition)
    && canonicalJson(scopeDraft) === canonicalJson(draft.scope)
    && claim.epistemicStatus === draft.epistemicStatus
    && claim.reviewStatus === draft.reviewStatus
    && claim.lifecycleStatus === 'current'
    && claim.supersededByClaimVersionId === undefined
    && claim.createdBy.kind === 'user'
    && claim.provenanceActivityId === provenanceActivityId
}

function hydrateDraftArtifact(request: M4ArtifactDraftRequest): ArtifactManifest & { status: 'draft' } {
  return {
    ...request.manifest,
    workspaceId: request.workspaceId,
    investigationId: request.investigationId,
    sourceScopeVersionId: request.scopeVersionId,
    status: 'draft',
    contentHash: '0'.repeat(64),
    createdBy: { kind: 'user', actorId: 'user:authenticated' },
    createdAt: '2000-01-01T00:00:00.000Z',
  } as ArtifactManifest & { status: 'draft' }
}

function artifactMatchesDraft(
  manifest: ArtifactManifest,
  draft: M4ArtifactManifestDraft,
): boolean {
  return manifest.artifactManifestId === draft.artifactManifestId
    && manifest.artifactId === draft.artifactId
    && manifest.version === draft.version
    && manifest.previousArtifactManifestId === draft.previousArtifactManifestId
    && manifest.kind === draft.kind
    && manifest.title === draft.title
    && canonicalJson(manifest.content) === canonicalJson(draft.content)
    && sameIds(manifest.personalizationUseIds, draft.personalizationUseIds)
}

function validateObjectIdentity(
  envelope: Pick<M4ResultBase, 'workspaceId' | 'investigationId'>,
  value: { workspaceId: OpaqueId, investigationId: OpaqueId },
  path: string,
  add: AddM4ContractIssue,
): void {
  if (value.workspaceId !== envelope.workspaceId
    || value.investigationId !== envelope.investigationId) {
    add('m4-rpc-identity', path, 'M4 object cannot cross workspace or Investigation identity')
  }
}

function isUniqueSorted(values: readonly string[]): boolean {
  return new Set(values).size === values.length
    && values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameRuleset(
  left: ReviewResult['ruleset'],
  right: ReviewResult['ruleset'],
): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.configHash === right.configHash
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]))
}

function appendAt(
  add: AddM4ContractIssue,
  issues: readonly M4ContractIssue[],
  prefix: string,
): void {
  for (const issue of issues) {
    add(issue.code, `${prefix}${issue.path === '/' ? '' : issue.path}`, issue.message)
  }
}

function issueCollector(): { issues: M4ContractIssue[], add: AddM4ContractIssue } {
  const issues: M4ContractIssue[] = []
  return {
    issues,
    add(code, path, message) {
      issues.push({ code, path, message })
    },
  }
}
