import type { ActorRef, IsoTimestamp, OpaqueId, Sha256 } from './m0-contracts.js'
import type { AddM4ContractIssue, M4ContractIssue } from './m4-contract-issues.js'

export type ClaimBasis =
  | 'document-supported'
  | 'derived-from-claims'
  | 'user-assumption'
  | 'project-decision'
  | 'external-knowledge'

export type ClaimEpistemicStatus =
  | 'proposed'
  | 'supported'
  | 'partially-supported'
  | 'contested'
  | 'contradicted'
  | 'unresolved'
  | 'stale'
  | 'withdrawn'

export type ClaimReviewStatus = 'unreviewed' | 'accepted' | 'needs-changes' | 'rejected'
export type ClaimLifecycleStatus = 'current' | 'superseded' | 'archived'

export interface ClaimProposition {
  subject?: string
  predicate?: string
  object?: string | number | boolean
  numericValue?: number
  unit?: string
  polarity?: 'positive' | 'negative'
  modality?: 'asserted' | 'estimated' | 'possible' | 'required' | 'prohibited'
}

export interface ClaimScope {
  sourceScopeVersionId: OpaqueId
  entityIds?: OpaqueId[]
  jurisdiction?: string
  section?: string
  validTime?: {
    from?: IsoTimestamp
    until?: IsoTimestamp
  }
}

export interface ClaimVersion {
  schemaVersion: 1
  claimVersionId: OpaqueId
  claimChainId: OpaqueId
  version: number
  workspaceId: OpaqueId
  investigationId: OpaqueId
  statement: string
  basis: ClaimBasis
  proposition?: ClaimProposition
  scope: ClaimScope
  epistemicStatus: ClaimEpistemicStatus
  reviewStatus: ClaimReviewStatus
  lifecycleStatus: ClaimLifecycleStatus
  previousClaimVersionId?: OpaqueId
  supersededByClaimVersionId?: OpaqueId
  createdBy: ActorRef
  createdAt: IsoTimestamp
  provenanceActivityId: OpaqueId
}

export type EvidenceRelationKind =
  | 'supports'
  | 'refutes'
  | 'qualifies'
  | 'contextualizes'
  | 'defines'
  | 'derived-input'

interface EvidenceRelationBase {
  schemaVersion: 1
  evidenceRelationId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  claimVersionId: OpaqueId
  evidenceId: OpaqueId
  kind: EvidenceRelationKind
  coverage: 'full' | 'partial'
  rationale?: string
  createdBy: ActorRef
  createdAt: IsoTimestamp
}

export type EvidenceRelation = EvidenceRelationBase & (
  | {
    reviewStatus: 'machine-proposed'
    reviewedBy?: never
    reviewedAt?: never
  }
  | {
    reviewStatus: 'human-confirmed' | 'human-rejected'
    reviewedBy: ActorRef & { kind: 'user' }
    reviewedAt: IsoTimestamp
  }
)

export type DerivationOperation =
  | 'extract'
  | 'normalize'
  | 'calculate'
  | 'compare'
  | 'aggregate'
  | 'infer'
  | 'human-edit'
  | 'verify'

export interface DerivationActivity {
  schemaVersion: 1
  derivationActivityId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  operation: DerivationOperation
  inputEvidenceIds: OpaqueId[]
  inputClaimVersionIds: OpaqueId[]
  outputClaimVersionIds: OpaqueId[]
  expression?: string
  rounding?: {
    mode: 'half-even' | 'half-up' | 'floor' | 'ceiling' | 'truncate'
    decimalPlaces: number
  }
  tool?: {
    name: string
    version: string
    configHash: Sha256
  }
  model?: {
    provider: string
    model: string
    promptHash: Sha256
  }
  actor: ActorRef
  startedAt: IsoTimestamp
  completedAt: IsoTimestamp
  dsh?: {
    sessionId: OpaqueId
    turn: number
    step: number
    callId?: OpaqueId
  }
}

export interface ClaimLedgerSnapshot {
  claims: readonly ClaimVersion[]
  evidenceRelations: readonly EvidenceRelation[]
  derivations: readonly DerivationActivity[]
  /** Omit only when EvidenceAtom resolution is deliberately outside this snapshot. */
  knownEvidenceIds?: readonly OpaqueId[]
}

export function claimVersionIssues(value: ClaimVersion): M4ContractIssue[] {
  const { issues, add } = issueCollector()
  if (value.version === 1 && value.previousClaimVersionId !== undefined) {
    add('claim-version-lineage', '/previousClaimVersionId', 'the first claim version cannot name a previous version')
  }
  if (value.version > 1 && value.previousClaimVersionId === undefined) {
    add('claim-version-lineage', '/previousClaimVersionId', 'later claim versions must name their immutable predecessor')
  }
  if (value.previousClaimVersionId === value.claimVersionId
    || value.supersededByClaimVersionId === value.claimVersionId) {
    add('claim-version-lineage', '/', 'a claim version cannot precede or supersede itself')
  }
  if ((value.lifecycleStatus === 'superseded') !== (value.supersededByClaimVersionId !== undefined)) {
    add('claim-version-lineage', '/supersededByClaimVersionId', 'only superseded claims name a successor, and every superseded claim must name one')
  }
  const validTime = value.scope.validTime
  if (validTime?.from !== undefined && validTime.until !== undefined
    && Date.parse(validTime.from) > Date.parse(validTime.until)) {
    add('claim-version-time-order', '/scope/validTime', 'valid-time start must not be after its end')
  }
  if (value.proposition?.unit !== undefined && value.proposition.numericValue === undefined) {
    add('claim-proposition-unit', '/proposition/unit', 'a proposition unit requires an explicit numericValue')
  }
  return issues
}

export function evidenceRelationIssues(value: EvidenceRelation): M4ContractIssue[] {
  const { issues, add } = issueCollector()
  if (value.reviewStatus === 'machine-proposed') {
    if (value.reviewedBy !== undefined || value.reviewedAt !== undefined) {
      add('evidence-relation-review', '/', 'a machine-proposed relation cannot impersonate a completed human review')
    }
  } else {
    if (value.reviewedBy?.kind !== 'user' || value.reviewedAt === undefined) {
      add('evidence-relation-review', '/', 'a human relation decision requires its user reviewer and review time')
    }
    if (value.reviewedAt !== undefined && Date.parse(value.reviewedAt) < Date.parse(value.createdAt)) {
      add('evidence-relation-time-order', '/reviewedAt', 'relation review cannot precede relation creation')
    }
  }
  return issues
}

export function derivationActivityIssues(value: DerivationActivity): M4ContractIssue[] {
  const { issues, add } = issueCollector()
  const inputClaims = new Set(value.inputClaimVersionIds)
  if (value.outputClaimVersionIds.some(id => inputClaims.has(id))) {
    add('derivation-activity-reference-cycle', '/outputClaimVersionIds', 'one activity cannot use its own output claim as an input')
  }
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    add('derivation-activity-time-order', '/completedAt', 'derivation completion cannot precede its start')
  }
  if (value.inputEvidenceIds.length === 0 && value.inputClaimVersionIds.length === 0) {
    add('derivation-activity-provenance', '/', 'a derivation must consume at least one EvidenceAtom or ClaimVersion')
  }
  if (value.operation === 'extract' && value.inputEvidenceIds.length === 0) {
    add('derivation-activity-provenance', '/inputEvidenceIds', 'extract requires an EvidenceAtom input')
  }
  if (value.operation === 'calculate' && (value.expression === undefined || value.rounding === undefined)) {
    add('derivation-activity-provenance', '/', 'calculate requires a reproducible expression and explicit rounding policy')
  }
  if (value.operation === 'human-edit' && value.actor.kind !== 'user') {
    add('derivation-activity-provenance', '/actor/kind', 'human-edit must identify a user actor')
  }
  if (value.model !== undefined && value.actor.kind !== 'agent') {
    add('derivation-activity-provenance', '/model', 'model provenance requires an Agent actor')
  }
  if (value.operation === 'infer' && value.actor.kind === 'agent' && value.model === undefined) {
    add('derivation-activity-provenance', '/model', 'Agent inference must pin provider, model, and prompt hash')
  }
  return issues
}

/** Validate a complete, single-workspace Claim Ledger snapshot. */
export function claimLedgerIssues(value: ClaimLedgerSnapshot): M4ContractIssue[] {
  const { issues, add } = issueCollector()
  const claims = new Map<OpaqueId, ClaimVersion>()
  const relations = new Map<OpaqueId, EvidenceRelation>()
  const derivations = new Map<OpaqueId, DerivationActivity>()
  const knownEvidence = value.knownEvidenceIds === undefined
    ? undefined
    : new Set(value.knownEvidenceIds)

  for (const [index, claim] of value.claims.entries()) {
    appendAt(issues, claimVersionIssues(claim), `/claims/${index}`)
    if (claims.has(claim.claimVersionId)) {
      add('claim-ledger-duplicate-id', `/claims/${index}/claimVersionId`, 'claim version ids must be unique')
    }
    claims.set(claim.claimVersionId, claim)
  }
  for (const [index, relation] of value.evidenceRelations.entries()) {
    appendAt(issues, evidenceRelationIssues(relation), `/evidenceRelations/${index}`)
    if (relations.has(relation.evidenceRelationId)) {
      add('claim-ledger-duplicate-id', `/evidenceRelations/${index}/evidenceRelationId`, 'evidence relation ids must be unique')
    }
    relations.set(relation.evidenceRelationId, relation)
  }
  for (const [index, derivation] of value.derivations.entries()) {
    appendAt(issues, derivationActivityIssues(derivation), `/derivations/${index}`)
    if (derivations.has(derivation.derivationActivityId)) {
      add('claim-ledger-duplicate-id', `/derivations/${index}/derivationActivityId`, 'derivation activity ids must be unique')
    }
    derivations.set(derivation.derivationActivityId, derivation)
  }

  const chainCurrents = new Map<OpaqueId, number>()
  const chainVersions = new Set<string>()
  for (const [index, claim] of value.claims.entries()) {
    const chainVersion = `${claim.claimChainId}\0${claim.version}`
    if (chainVersions.has(chainVersion)) {
      add('claim-ledger-duplicate-id', `/claims/${index}/version`, 'a claim chain cannot contain the same version number twice')
    }
    chainVersions.add(chainVersion)
    if (claim.lifecycleStatus === 'current') {
      const count = (chainCurrents.get(claim.claimChainId) ?? 0) + 1
      chainCurrents.set(claim.claimChainId, count)
      if (count > 1) {
        add('claim-ledger-current-version', `/claims/${index}/lifecycleStatus`, 'a claim chain can have at most one current version')
      }
    }
    if (claim.previousClaimVersionId !== undefined) {
      const previous = claims.get(claim.previousClaimVersionId)
      if (previous === undefined) {
        add('claim-ledger-reference', `/claims/${index}/previousClaimVersionId`, 'previous ClaimVersion does not exist in the ledger snapshot')
      } else if (previous.claimChainId !== claim.claimChainId || previous.version !== claim.version - 1) {
        add('claim-version-lineage', `/claims/${index}/previousClaimVersionId`, 'the previous ClaimVersion must be the immediately preceding version in the same chain')
      }
    }
    if (claim.supersededByClaimVersionId !== undefined) {
      const successor = claims.get(claim.supersededByClaimVersionId)
      if (successor === undefined) {
        add('claim-ledger-reference', `/claims/${index}/supersededByClaimVersionId`, 'successor ClaimVersion does not exist in the ledger snapshot')
      } else if (successor.previousClaimVersionId !== claim.claimVersionId) {
        add('claim-version-lineage', `/claims/${index}/supersededByClaimVersionId`, 'the named successor must point back to this ClaimVersion')
      }
    }
    const activity = derivations.get(claim.provenanceActivityId)
    if (activity === undefined || !activity.outputClaimVersionIds.includes(claim.claimVersionId)) {
      add('claim-ledger-reference', `/claims/${index}/provenanceActivityId`, 'claim provenance must name an activity that outputs this exact ClaimVersion')
    } else if (activity.workspaceId !== claim.workspaceId
      || activity.investigationId !== claim.investigationId) {
      add('claim-ledger-identity', `/claims/${index}/provenanceActivityId`, 'claim and provenance activity must share workspace and Investigation identity')
    }
  }

  for (const [index, relation] of value.evidenceRelations.entries()) {
    const claim = claims.get(relation.claimVersionId)
    if (claim === undefined) {
      add('claim-ledger-reference', `/evidenceRelations/${index}/claimVersionId`, 'EvidenceRelation references an unknown ClaimVersion')
    } else if (claim.workspaceId !== relation.workspaceId
      || claim.investigationId !== relation.investigationId) {
      add('claim-ledger-identity', `/evidenceRelations/${index}`, 'EvidenceRelation cannot cross workspace or Investigation identity')
    }
    if (knownEvidence !== undefined && !knownEvidence.has(relation.evidenceId)) {
      add('claim-ledger-reference', `/evidenceRelations/${index}/evidenceId`, 'EvidenceRelation must reference an existing EvidenceAtom, never Memory or a recall lead')
    }
  }

  for (const [index, derivation] of value.derivations.entries()) {
    for (const claimVersionId of [
      ...derivation.inputClaimVersionIds,
      ...derivation.outputClaimVersionIds,
    ]) {
      const claim = claims.get(claimVersionId)
      if (claim === undefined) {
        add('claim-ledger-reference', `/derivations/${index}`, 'DerivationActivity references an unknown ClaimVersion')
      } else if (claim.workspaceId !== derivation.workspaceId
        || claim.investigationId !== derivation.investigationId) {
        add('claim-ledger-identity', `/derivations/${index}`, 'DerivationActivity cannot cross workspace or Investigation identity')
      }
    }
    if (knownEvidence !== undefined && derivation.inputEvidenceIds.some(id => !knownEvidence.has(id))) {
      add('claim-ledger-reference', `/derivations/${index}/inputEvidenceIds`, 'DerivationActivity references an unknown EvidenceAtom')
    }
  }

  const usableRelations = value.evidenceRelations.filter(relation => relation.reviewStatus !== 'human-rejected')
  for (const [index, claim] of value.claims.entries()) {
    const linked = usableRelations.filter(relation => relation.claimVersionId === claim.claimVersionId)
    const supports = linked.filter(relation => relation.kind === 'supports')
    const refutes = linked.filter(relation => relation.kind === 'refutes')
    const evidential = linked.filter(relation => relation.kind === 'supports'
      || relation.kind === 'refutes'
      || relation.kind === 'qualifies')
    if (claim.basis === 'document-supported' && evidential.length === 0) {
      add('claim-ledger-basis', `/claims/${index}/basis`, 'a document-supported claim requires a non-rejected EvidenceRelation')
    }
    if (claim.basis === 'derived-from-claims') {
      const activity = derivations.get(claim.provenanceActivityId)
      if (activity === undefined || activity.inputClaimVersionIds.length === 0) {
        add('claim-ledger-basis', `/claims/${index}/basis`, 'a derived claim requires a provenance activity with ClaimVersion inputs')
      }
    }
    if ((claim.basis === 'user-assumption'
      || claim.basis === 'project-decision'
      || claim.basis === 'external-knowledge')
      && evidential.length > 0) {
      add('claim-ledger-basis', `/claims/${index}/basis`, 'assumptions, decisions, and external knowledge cannot masquerade as document-supported evidence')
    }
    const hasSupports = supports.length > 0
    const hasFullSupports = supports.some(relation => relation.coverage === 'full')
    const hasRefutes = refutes.length > 0
    if (claim.basis === 'document-supported'
      && claim.epistemicStatus === 'supported' && (!hasFullSupports || hasRefutes)) {
      add('claim-ledger-status', `/claims/${index}/epistemicStatus`, 'supported requires full supporting evidence and no active refuting evidence')
    }
    if (claim.basis === 'document-supported'
      && claim.epistemicStatus === 'partially-supported' && (!hasSupports || hasRefutes)) {
      add('claim-ledger-status', `/claims/${index}/epistemicStatus`, 'partially-supported requires supporting evidence and no active refuting evidence')
    }
    if (claim.basis === 'document-supported'
      && claim.epistemicStatus === 'contested' && (!hasSupports || !hasRefutes)) {
      add('claim-ledger-status', `/claims/${index}/epistemicStatus`, 'contested requires both supporting and refuting evidence')
    }
    if (claim.basis === 'document-supported'
      && claim.epistemicStatus === 'contradicted' && (hasSupports || !hasRefutes)) {
      add('claim-ledger-status', `/claims/${index}/epistemicStatus`, 'contradicted requires refuting evidence and no active supporting evidence')
    }
  }
  return issues
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

function appendAt(target: M4ContractIssue[], source: readonly M4ContractIssue[], prefix: string): void {
  target.push(...source.map(issue => ({
    ...issue,
    path: issue.path === '/' ? prefix : `${prefix}${issue.path}`,
  })))
}
