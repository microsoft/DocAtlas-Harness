import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  artifactManifestIssues,
  claimLedgerIssues,
  derivationActivityIssues,
  evidenceRelationIssues,
  M4_PUBLISH_RULESET,
  REVIEW_GATE_IDS,
  reviewResultIssues,
  type ActorRef,
  type ArtifactManifest,
  type ClaimLedgerSnapshot,
  type ClaimUse,
  type ClaimVersion,
  type DerivationActivity,
  type EvidenceAtom,
  type EvidenceRelation,
  type M4ConflictSearchAssurance,
  type M4HumanReviewDecision,
  type ReviewGateId,
  type ReviewGateResult,
  type ReviewIssue,
  type ReviewIssueCode,
  type ReviewResult,
} from '@docatlas/contracts'

const M4_STORE_SCHEMA_VERSION = 1
const GENESIS_HASH = 'GENESIS'
const MAX_M4_EVENTS = 50_000

export const DOCATLAS_M4_PUBLISH_RULESET = M4_PUBLISH_RULESET

export type InvestigationM4StoreErrorCode =
  | 'invalid-request'
  | 'not-found'
  | 'conflict'
  | 'limit-exceeded'
  | 'integrity-error'
  | 'publish-blocked'

export class InvestigationM4StoreError extends Error {
  constructor(
    readonly code: InvestigationM4StoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'InvestigationM4StoreError'
  }
}

/**
 * This is deliberately stricter than accepting a string that merely looks
 * like an Evidence id. The Host adapter must distinguish canonical document
 * Evidence from Research Recall and Personal Memory before M4 can link it.
 */
export type M4EvidenceResolution =
  | {
    kind: 'evidence-atom'
    workspaceId: string
    investigationId: string
    sourceScopeVersionIds: readonly string[]
    evidence: EvidenceAtom
    integrity?:
      | 'valid'
      | 'locator-unresolvable'
      | 'source-revision-mismatch'
      | 'content-hash-mismatch'
  }
  | {
    kind: 'personal-memory' | 'research-recall'
    workspaceId: string
    recordId: string
  }

export interface M4PublicationAssurance {
  /** Optional deterministic ResearchPolicy enforcement hook. */
  publicationAllowed?(input: {
    workspaceId: string
    investigationId: string
    sourceScopeVersionId: string
    artifactManifestId: string
  }): boolean
}

export interface InvestigationM4StoreOptions {
  workspaceId: string
  /** Exact immutable ownership is supplied by all M4 effects; old single-argument ports remain compatible. */
  resolveEvidence(evidenceId: string, context?: { investigationId: string, sourceScopeVersionId: string }): M4EvidenceResolution | undefined
  publicationAssurance?: M4PublicationAssurance
}

export interface RecordClaimVersionCommand {
  workspaceId: string
  investigationId: string
  idempotencyKey: string
  /** Stable authenticated wire request; excludes Host-derived actor/time fields. */
  idempotencyInput?: unknown
  expectedCurrentClaimVersionId: string | null
  claim: ClaimVersion
  provenance: DerivationActivity
  evidenceRelations: EvidenceRelation[]
}

export interface RecordArtifactDraftCommand {
  workspaceId: string
  investigationId: string
  idempotencyKey: string
  idempotencyInput?: unknown
  expectedPreviousArtifactManifestId: string | null
  manifest: ArtifactManifest & { status: 'draft' }
}

export type ConflictSearchAssurance = M4ConflictSearchAssurance

export interface RecordConflictSearchAssuranceCommand {
  workspaceId: string
  investigationId: string
  idempotencyKey: string
  idempotencyInput?: unknown
  assurance: ConflictSearchAssurance
}

export interface RunArtifactReviewCommand {
  workspaceId: string
  investigationId: string
  idempotencyKey: string
  idempotencyInput?: unknown
  artifactManifestId: string
  reviewResultId: string
  ruleset: ReviewResult['ruleset']
  signoffRequirement: ReviewResult['signoffRequirement']
  reviewer: ActorRef & { kind: 'rule' }
  createdAt: string
}

export type HumanReviewDecision = M4HumanReviewDecision

export interface RecordHumanReviewDecisionCommand {
  workspaceId: string
  investigationId: string
  idempotencyKey: string
  idempotencyInput?: unknown
  decision: HumanReviewDecision
}

export interface PublishArtifactCommand {
  workspaceId: string
  investigationId: string
  idempotencyKey: string
  idempotencyInput?: unknown
  artifactManifestId: string
  expectedStatus: 'draft'
  reviewResultId: string
  humanReviewDecisionId?: string
  publishedBy: ActorRef & { kind: 'user' | 'system' }
  publishedAt: string
}

export interface M4MutationResult<T> {
  status: 'created' | 'replayed'
  value: T
}

export interface M4JournalEntry {
  sequence: number
  eventId: string
  investigationId: string
  eventType: M4EventPayload['type']
  aggregateId: string
  aggregateVersion: number
  createdAt: string
  eventHash: string
}

/** Private application projection; hosts authorize immutable scopes before exposing any item. */
export interface M4WorkspaceSnapshot {
  /** Verified first-creation order. Publishing an existing ID does not move its position. */
  artifacts: ArtifactManifest[]
  /** Verified append order, oldest to newest; equal timestamps and non-monotonic IDs are valid. */
  reviews: ReviewResult[]
  /** Verified append order, oldest to newest. Equal timestamps are valid; IDs are not chronology. */
  decisions: M4HumanReviewDecision[]
}

interface ClaimRecordedPayload {
  type: 'claim-version.recorded'
  expectedCurrentClaimVersionId: string | null
  claim: ClaimVersion
  provenance: DerivationActivity
  evidenceRelations: EvidenceRelation[]
}

interface ArtifactDraftRecordedPayload {
  type: 'artifact-draft.recorded'
  expectedPreviousArtifactManifestId: string | null
  manifest: ArtifactManifest & { status: 'draft' }
}

interface ReviewResultRecordedPayload {
  type: 'review-result.recorded'
  review: ReviewResult
}

interface ConflictSearchAssuranceRecordedPayload {
  type: 'conflict-search-assurance.recorded'
  assurance: ConflictSearchAssurance
}

interface HumanReviewDecisionRecordedPayload {
  type: 'human-review-decision.recorded'
  decision: HumanReviewDecision
}

interface ArtifactPublishedPayload {
  type: 'artifact.published'
  artifactManifestId: string
  expectedStatus: 'draft'
  publication: NonNullable<ArtifactManifest['publication']>
}

type M4EventPayload =
  | ClaimRecordedPayload
  | ArtifactDraftRecordedPayload
  | ConflictSearchAssuranceRecordedPayload
  | ReviewResultRecordedPayload
  | HumanReviewDecisionRecordedPayload
  | ArtifactPublishedPayload

interface StoredEvent {
  sequence: number
  eventId: string
  workspaceId: string
  investigationId: string
  eventType: M4EventPayload['type']
  aggregateId: string
  aggregateVersion: number
  idempotencyKey: string
  requestJson: string
  requestHash: string
  payloadJson: string
  payloadHash: string
  resultJson: string
  resultHash: string
  previousEventHash: string
  eventHash: string
  createdAt: string
}

interface M4State {
  claims: Map<string, ClaimVersion>
  chainCurrent: Map<string, string>
  derivations: Map<string, DerivationActivity>
  evidenceRelations: Map<string, EvidenceRelation>
  artifacts: Map<string, ArtifactManifest>
  artifactLatest: Map<string, string>
  conflictAssurances: Map<string, ConflictSearchAssurance>
  reviews: Map<string, ReviewResult>
  humanDecisions: Map<string, HumanReviewDecision>
  eventsByIdempotencyKey: Map<string, StoredEvent>
}

interface EventDescriptor {
  investigationId: string
  aggregateId: string
  aggregateVersion: number
  createdAt: string
}

/**
 * Append-only M4 domain adapter over a workspace-owned SQLite database.
 * The caller owns and closes the database. This lets SourceScopeStore attach
 * M4 to its existing per-workspace database without creating another owner.
 */
export class InvestigationM4Store {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly options: InvestigationM4StoreOptions,
  ) {}

  static attach(
    database: DatabaseSync,
    options: InvestigationM4StoreOptions,
  ): InvestigationM4Store {
    requireId(options.workspaceId, 'workspaceId')
    initializeM4Schema(database, options.workspaceId)
    const store = new InvestigationM4Store(database, options)
    store.verifyIntegrity()
    return store
  }

  static verifyExisting(database: DatabaseSync, workspaceId: string): void {
    const table = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'investigation_m4_events'
    `).get()
    if (table === undefined) return
    const metadata = database.prepare(`
      SELECT schema_version, workspace_id
      FROM investigation_m4_metadata
      WHERE singleton = 1
    `).get() as Record<string, unknown> | undefined
    if (metadata === undefined
      || integerColumn(metadata, 'schema_version') !== M4_STORE_SCHEMA_VERSION
      || stringColumn(metadata, 'workspace_id') !== workspaceId) {
      integrity('M4 store metadata is missing or belongs to another workspace')
    }
    new InvestigationM4Store(database, {
      workspaceId,
      resolveEvidence: () => undefined,
    }).verifyIntegrity()
  }

  recordClaimVersion(
    command: RecordClaimVersionCommand,
  ): M4MutationResult<ClaimVersion> {
    return this.mutate(command, (state) => {
      this.requireCommandIdentity(command.workspaceId, command.investigationId)
      assertClaimBundle(command, state)
      this.requireCanonicalEvidence(command.claim, command.provenance, command.evidenceRelations)
      const payload: ClaimRecordedPayload = cloneCanonical({
        type: 'claim-version.recorded',
        expectedCurrentClaimVersionId: command.expectedCurrentClaimVersionId,
        claim: command.claim,
        provenance: command.provenance,
        evidenceRelations: command.evidenceRelations,
      })
      return {
        payload,
        descriptor: {
          investigationId: command.investigationId,
          aggregateId: command.claim.claimChainId,
          aggregateVersion: command.claim.version,
          createdAt: command.claim.createdAt,
        },
      }
    }) as M4MutationResult<ClaimVersion>
  }

  recordArtifactDraft(
    command: RecordArtifactDraftCommand,
  ): M4MutationResult<ArtifactManifest> {
    return this.mutate(command, (state) => {
      this.requireCommandIdentity(command.workspaceId, command.investigationId)
      const manifest = cloneCanonical(command.manifest)
      assertArtifactDraft(manifest, command.expectedPreviousArtifactManifestId, state)
      const payload: ArtifactDraftRecordedPayload = {
        type: 'artifact-draft.recorded',
        expectedPreviousArtifactManifestId: command.expectedPreviousArtifactManifestId,
        manifest,
      }
      return {
        payload,
        descriptor: {
          investigationId: command.investigationId,
          aggregateId: manifest.artifactId,
          aggregateVersion: manifest.version,
          createdAt: manifest.createdAt,
        },
      }
    }) as M4MutationResult<ArtifactManifest>
  }

  recordConflictSearchAssurance(
    command: RecordConflictSearchAssuranceCommand,
  ): M4MutationResult<ConflictSearchAssurance> {
    return this.mutate(command, (state) => {
      this.requireCommandIdentity(command.workspaceId, command.investigationId)
      const assurance = cloneCanonical(command.assurance)
      assertConflictSearchAssurance(assurance, state)
      if (assurance.workspaceId !== command.workspaceId
        || assurance.investigationId !== command.investigationId) {
        invalid('conflict-search assurance cannot cross workspace or Investigation identity')
      }
      for (const evidenceId of assurance.evidenceIds) {
        const resolution = this.options.resolveEvidence(evidenceId, { investigationId: assurance.investigationId, sourceScopeVersionId: assurance.sourceScopeVersionId })
        if (resolution === undefined || resolution.kind !== 'evidence-atom') {
          invalid('conflict-search assurance may pin only canonical document Evidence')
        }
        if (resolution.workspaceId !== assurance.workspaceId
          || resolution.investigationId !== assurance.investigationId
          || !resolution.sourceScopeVersionIds.includes(assurance.sourceScopeVersionId)) {
          invalid('conflict-search assurance Evidence is outside its exact source scope')
        }
      }
      const payload: ConflictSearchAssuranceRecordedPayload = {
        type: 'conflict-search-assurance.recorded',
        assurance,
      }
      return {
        payload,
        descriptor: {
          investigationId: command.investigationId,
          aggregateId: assurance.assuranceId,
          aggregateVersion: 1,
          createdAt: assurance.assuredAt,
        },
      }
    }) as M4MutationResult<ConflictSearchAssurance>
  }

  runArtifactReview(
    command: RunArtifactReviewCommand,
  ): M4MutationResult<ReviewResult> {
    return this.mutate(command, (state) => {
      this.requireCommandIdentity(command.workspaceId, command.investigationId)
      requireId(command.reviewResultId, 'reviewResultId')
      requireIsoTimestamp(command.createdAt, 'createdAt')
      requireActor(command.reviewer, 'rule', 'reviewer')
      requireRuleset(command.ruleset)
      if (command.signoffRequirement !== 'required'
        && command.signoffRequirement !== 'not-required') {
        invalid('signoffRequirement is invalid')
      }
      if (state.reviews.has(command.reviewResultId)) {
        conflict('reviewResultId is already immutable')
      }
      const artifact = state.artifacts.get(command.artifactManifestId)
      if (artifact === undefined) notFound('artifact manifest was not found')
      if (artifact.status !== 'draft') conflict('only an immutable draft can be reviewed for publication')
      if (artifact.workspaceId !== command.workspaceId
        || artifact.investigationId !== command.investigationId) {
        invalid('artifact review cannot cross workspace or Investigation identity')
      }
      const review = this.computePublishReview(command, artifact, state)
      const payload: ReviewResultRecordedPayload = {
        type: 'review-result.recorded',
        review,
      }
      return {
        payload,
        descriptor: {
          investigationId: command.investigationId,
          aggregateId: command.reviewResultId,
          aggregateVersion: 1,
          createdAt: command.createdAt,
        },
      }
    }) as M4MutationResult<ReviewResult>
  }

  recordHumanReviewDecision(
    command: RecordHumanReviewDecisionCommand,
  ): M4MutationResult<HumanReviewDecision> {
    return this.mutate(command, (state) => {
      this.requireCommandIdentity(command.workspaceId, command.investigationId)
      const decision = cloneCanonical(command.decision)
      assertHumanReviewDecision(decision, state)
      if (decision.workspaceId !== command.workspaceId
        || decision.investigationId !== command.investigationId) {
        invalid('human review decision cannot cross workspace or Investigation identity')
      }
      const review = state.reviews.get(decision.reviewResultId)
      if (review === undefined) notFound('deterministic ReviewResult was not found')
      if (decision.decision === 'approved'
        && review.decision !== 'needs-human') {
        blocked('human approval cannot override a deterministic fail or incomplete result')
      }
      const payload: HumanReviewDecisionRecordedPayload = {
        type: 'human-review-decision.recorded',
        decision,
      }
      return {
        payload,
        descriptor: {
          investigationId: command.investigationId,
          aggregateId: decision.reviewDecisionId,
          aggregateVersion: 1,
          createdAt: decision.decidedAt,
        },
      }
    }) as M4MutationResult<HumanReviewDecision>
  }

  publishArtifact(
    command: PublishArtifactCommand,
  ): M4MutationResult<ArtifactManifest> {
    return this.mutate(command, (state) => {
      this.requireCommandIdentity(command.workspaceId, command.investigationId)
      requireActor(command.publishedBy, ['user', 'system'], 'publishedBy')
      requireIsoTimestamp(command.publishedAt, 'publishedAt')
      const artifact = state.artifacts.get(command.artifactManifestId)
      if (artifact === undefined) notFound('artifact manifest was not found')
      if (artifact.workspaceId !== command.workspaceId
        || artifact.investigationId !== command.investigationId) {
        invalid('artifact publication cannot cross workspace or Investigation identity')
      }
      if (artifact.status !== command.expectedStatus) {
        conflict('artifact status changed before publication')
      }
      const review = state.reviews.get(command.reviewResultId)
      if (review === undefined) notFound('deterministic ReviewResult was not found')
      assertReviewPinsArtifact(review, artifact)
      if (review.decision === 'fail' || review.decision === 'incomplete') {
        blocked('failed or incomplete deterministic review cannot publish')
      }
      let decision: HumanReviewDecision | undefined
      if (review.decision === 'needs-human') {
        if (command.humanReviewDecisionId === undefined) {
          blocked('publication requires the exact approving human review decision')
        }
        decision = state.humanDecisions.get(command.humanReviewDecisionId)
        if (decision === undefined
          || decision.reviewResultId !== review.reviewResultId
          || decision.decision !== 'approved') {
          blocked('publication requires the exact approving human review decision')
        }
      } else if (command.humanReviewDecisionId !== undefined) {
        invalid('deterministic pass must not invent a human-review dependency')
      }
      if (Date.parse(command.publishedAt) < Date.parse(review.createdAt)
        || (decision !== undefined
          && Date.parse(command.publishedAt) < Date.parse(decision.decidedAt))) {
        invalid('publication cannot precede its deterministic or human review')
      }
      this.assertArtifactEvidenceStillPublishable(artifact, state)
      const publication: NonNullable<ArtifactManifest['publication']> = {
        reviewResultId: review.reviewResultId,
        deterministicDecision: review.decision,
        ...(decision === undefined
          ? {}
          : { humanReviewDecisionId: decision.reviewDecisionId }),
        publishedBy: cloneCanonical(command.publishedBy),
        publishedAt: command.publishedAt,
      }
      const payload: ArtifactPublishedPayload = {
        type: 'artifact.published',
        artifactManifestId: artifact.artifactManifestId,
        expectedStatus: command.expectedStatus,
        publication,
      }
      return {
        payload,
        descriptor: {
          investigationId: command.investigationId,
          aggregateId: artifact.artifactId,
          aggregateVersion: artifact.version,
          createdAt: command.publishedAt,
        },
      }
    }) as M4MutationResult<ArtifactManifest>
  }

  getClaimLedger(investigationId: string): ClaimLedgerSnapshot {
    requireId(investigationId, 'investigationId')
    const state = this.loadState()
    const claims = [...state.claims.values()]
      .filter(claim => claim.investigationId === investigationId)
      .sort(compareClaimVersions)
    const claimIds = new Set(claims.map(claim => claim.claimVersionId))
    const evidenceRelations = [...state.evidenceRelations.values()]
      .filter(relation => claimIds.has(relation.claimVersionId))
      .sort((left, right) => left.evidenceRelationId.localeCompare(right.evidenceRelationId))
    const derivations = [...state.derivations.values()]
      .filter(derivation => derivation.investigationId === investigationId)
      .sort((left, right) => left.derivationActivityId.localeCompare(right.derivationActivityId))
    return cloneCanonical({ claims, evidenceRelations, derivations })
  }

  getArtifactManifest(artifactManifestId: string): ArtifactManifest {
    requireId(artifactManifestId, 'artifactManifestId')
    const artifact = this.loadState().artifacts.get(artifactManifestId)
    if (artifact === undefined) notFound('artifact manifest was not found')
    return cloneCanonical(artifact)
  }

  listArtifactManifests(investigationId?: string): ArtifactManifest[] {
    const artifacts = [...this.loadState().artifacts.values()]
      .filter(artifact => investigationId === undefined || artifact.investigationId === investigationId)
      .sort((left, right) => left.artifactManifestId.localeCompare(right.artifactManifestId))
    return cloneCanonical(artifacts)
  }

  getWorkspaceSnapshot(investigationId: string): M4WorkspaceSnapshot {
    requireId(investigationId, 'investigationId')
    const state = this.loadState()
    for (const item of [...state.artifacts.values(), ...state.reviews.values(), ...state.humanDecisions.values()]) {
      if (item.workspaceId !== this.options.workspaceId) integrity('M4 snapshot contains a cross-workspace object')
    }
    return cloneCanonical({
      // Verified replay preserves first creation/append sequence. Map.set on publication keeps
      // the existing artifact position; neither opaque IDs nor equal clocks define chronology.
      artifacts: [...state.artifacts.values()].filter(item => item.investigationId === investigationId),
      reviews: [...state.reviews.values()].filter(item => item.investigationId === investigationId),
      decisions: [...state.humanDecisions.values()].filter(item => item.investigationId === investigationId),
    })
  }

  getReviewResult(reviewResultId: string): ReviewResult {
    requireId(reviewResultId, 'reviewResultId')
    const review = this.loadState().reviews.get(reviewResultId)
    if (review === undefined) notFound('ReviewResult was not found')
    return cloneCanonical(review)
  }

  getHumanReviewDecision(reviewDecisionId: string): HumanReviewDecision {
    requireId(reviewDecisionId, 'reviewDecisionId')
    const decision = this.loadState().humanDecisions.get(reviewDecisionId)
    if (decision === undefined) notFound('human review decision was not found')
    return cloneCanonical(decision)
  }

  listJournal(investigationId?: string): M4JournalEntry[] {
    const state = this.loadState()
    const rows = readStoredEvents(this.database)
      .filter(row => investigationId === undefined || row.investigationId === investigationId)
    // Reading state above is intentional: it authenticates every row before
    // exposing even bounded journal metadata.
    void state
    return rows.map(row => ({
      sequence: row.sequence,
      eventId: row.eventId,
      investigationId: row.investigationId,
      eventType: row.eventType,
      aggregateId: row.aggregateId,
      aggregateVersion: row.aggregateVersion,
      createdAt: row.createdAt,
      eventHash: row.eventHash,
    }))
  }

  verifyIntegrity(): void {
    this.loadState()
  }

  private mutate(
    command: { idempotencyKey: string, idempotencyInput?: unknown },
    create: (state: M4State) => { payload: M4EventPayload, descriptor: EventDescriptor },
  ): M4MutationResult<unknown> {
    requireId(command.idempotencyKey, 'idempotencyKey')
    const requestJson = canonicalJson(command.idempotencyInput ?? command)
    const requestHash = sha256(requestJson)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const state = this.loadState()
      const replay = state.eventsByIdempotencyKey.get(command.idempotencyKey)
      if (replay !== undefined) {
        if (replay.requestHash !== requestHash || replay.requestJson !== requestJson) {
          conflict('M4 idempotency key was already used for a different request')
        }
        const stored = parseJson(replay.resultJson, 'stored M4 command result is invalid')
        if (!isRecord(stored) || stored.status !== 'created' || !('value' in stored)) {
          integrity('stored M4 command result shape is invalid')
        }
        this.database.exec('COMMIT')
        return cloneCanonical({ ...stored, status: 'replayed' }) as M4MutationResult<unknown>
      }
      const { payload, descriptor } = create(state)
      const result = applyPayload(state, payload)
      appendEvent(this.database, this.options.workspaceId, command.idempotencyKey, requestJson, payload, descriptor, result)
      this.database.exec('COMMIT')
      return cloneCanonical(result)
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the domain error that caused the rollback.
      }
      throw normalizeSqliteError(error)
    }
  }

  private loadState(): M4State {
    const state = emptyState()
    let previousEventHash = GENESIS_HASH
    for (const row of readStoredEvents(this.database)) {
      verifyStoredEvent(row, this.options.workspaceId, previousEventHash)
      const payload = parseEventPayload(row.payloadJson)
      if (payload.type !== row.eventType) {
        integrity('M4 journal event type does not match its payload')
      }
      const expectedResult = applyPayload(state, payload)
      if (canonicalJson(expectedResult) !== row.resultJson) {
        integrity('M4 journal result does not match deterministic event replay')
      }
      if (state.eventsByIdempotencyKey.has(row.idempotencyKey)) {
        integrity('M4 journal contains a duplicate idempotency key')
      }
      state.eventsByIdempotencyKey.set(row.idempotencyKey, row)
      previousEventHash = row.eventHash
    }
    return state
  }

  private requireCommandIdentity(workspaceId: string, investigationId: string): void {
    requireId(workspaceId, 'workspaceId')
    requireId(investigationId, 'investigationId')
    if (workspaceId !== this.options.workspaceId) {
      invalid('M4 command cannot cross the attached workspace identity')
    }
  }

  private requireCanonicalEvidence(
    claim: ClaimVersion,
    provenance: DerivationActivity,
    relations: readonly EvidenceRelation[],
  ): void {
    const ids = new Set([
      ...provenance.inputEvidenceIds,
      ...relations.map(relation => relation.evidenceId),
    ])
    for (const evidenceId of ids) {
      const resolution = this.options.resolveEvidence(evidenceId, { investigationId: claim.investigationId, sourceScopeVersionId: claim.scope.sourceScopeVersionId })
      if (resolution === undefined) {
        invalid(`EvidenceAtom ${evidenceId} does not exist`)
      }
      if (resolution.kind !== 'evidence-atom') {
        invalid('Personal Memory and Research Recall cannot be used as document Evidence')
      }
      if (resolution.evidence.evidenceId !== evidenceId
        || resolution.workspaceId !== claim.workspaceId
        || resolution.investigationId !== claim.investigationId) {
        invalid('EvidenceRelation cannot cross workspace or Investigation identity')
      }
      if (!resolution.sourceScopeVersionIds.includes(claim.scope.sourceScopeVersionId)) {
        invalid('EvidenceRelation source is outside the Claim source-scope version')
      }
    }
  }

  private computePublishReview(
    command: RunArtifactReviewCommand,
    artifact: ArtifactManifest & { status: 'draft' },
    state: M4State,
  ): ReviewResult {
    const claimUses = collectClaimUses(artifact)
    const usedClaimIds = unique(claimUses.map(use => use.claimVersionId))
    const closure = collectClaimClosure(state, usedClaimIds)
    const claimIds = [...closure.claimIds]
    const claims = claimIds
      .map(id => state.claims.get(id))
      .filter((claim): claim is ClaimVersion => claim !== undefined)
    const relations = [...state.evidenceRelations.values()]
      .filter(relation => claimIds.includes(relation.claimVersionId))
    const evidenceIds = unique([
      ...relations.map(relation => relation.evidenceId),
      ...claimUses.flatMap(use => use.citationEvidenceIds),
    ])
    const derivationIds = [...closure.derivationIds]
    const derivations = derivationIds
      .map(id => state.derivations.get(id))
      .filter((activity): activity is DerivationActivity => activity !== undefined)
    for (const activity of derivations) evidenceIds.push(...activity.inputEvidenceIds)
    const checkedObjectIds = unique([
      artifact.artifactManifestId,
      artifact.sourceScopeVersionId,
      ...claimUses.map(use => use.claimUseId),
      ...claimIds,
      ...relations.map(relation => relation.evidenceRelationId),
      ...evidenceIds,
      ...derivationIds,
    ])

    const issues: ReviewIssue[] = []
    const add = createReviewIssueAdder(issues, checkedObjectIds)

    if (artifact.contentHash !== artifactContentHash(artifact)) {
      add('content-hash-mismatch', 'blocker', 'Artifact content hash no longer matches its immutable content.', [{
        kind: 'artifact-manifest',
        objectId: artifact.artifactManifestId,
      }])
    }
    for (const claimVersionId of claimIds) {
      if (!state.claims.has(claimVersionId)) {
        add('missing-object', 'blocker', 'ClaimUse references a missing ClaimVersion.', [{
          kind: 'claim-version',
          objectId: claimVersionId,
        }])
      }
    }
    for (const derivationId of derivationIds) {
      const activity = state.derivations.get(derivationId)
      if (activity === undefined) {
        add('missing-object', 'blocker', 'Claim provenance references a missing DerivationActivity.', [{
          kind: 'derivation',
          objectId: derivationId,
        }])
      } else if (derivationActivityIssues(activity).length > 0) {
        add('derivation-unreproducible', 'blocker', 'Claim provenance is not deterministically reproducible.', [{
          kind: 'derivation',
          objectId: derivationId,
        }])
      }
    }
    for (const input of invalidDerivedClaimInputs(state, usedClaimIds, artifact)) {
      add('derived-claim-input-invalid', 'blocker', 'A derived Claim requires accepted, current, resolved input Claims in the same immutable source scope.', [
        { kind: 'claim-version', objectId: input.claimVersionId },
        { kind: 'claim-version', objectId: input.inputClaimVersionId },
      ])
    }
    for (const evidenceId of unique(evidenceIds)) {
      const resolution = this.options.resolveEvidence(evidenceId, { investigationId: artifact.investigationId, sourceScopeVersionId: artifact.sourceScopeVersionId })
      if (resolution === undefined || resolution.kind !== 'evidence-atom') {
        add('missing-object', 'blocker', 'A required canonical EvidenceAtom is unavailable.', [{
          kind: 'evidence',
          objectId: evidenceId,
        }])
        continue
      }
      const evidence = resolution.evidence
      const explicitIntegrity = resolution.integrity ?? 'valid'
      if (explicitIntegrity !== 'valid') {
        add(explicitIntegrity, 'blocker', 'Evidence failed its immutable source integrity check.', [{
          kind: explicitIntegrity === 'locator-unresolvable' ? 'locator' : 'evidence',
          objectId: explicitIntegrity === 'locator-unresolvable' ? evidence.locatorId : evidenceId,
        }])
      }
      if (evidence.content.text !== undefined
        && sha256(evidence.content.text) !== evidence.contentHash) {
        add('content-hash-mismatch', 'blocker', 'Evidence text no longer matches its immutable content hash.', [{
          kind: 'evidence',
          objectId: evidenceId,
        }])
      }
      if (evidence.status !== 'current' || evidence.resolutionStatus === 'stale') {
        add('source-revision-mismatch', 'blocker', 'Evidence is no longer current for its source revision.', [{
          kind: 'evidence',
          objectId: evidenceId,
        }])
      } else if (evidence.resolutionStatus !== 'resolved'
        && evidence.resolutionStatus !== 'page-only') {
        add('locator-unresolvable', 'blocker', 'Evidence Locator cannot be resolved exactly enough for publication.', [{
          kind: 'locator',
          objectId: evidence.locatorId,
        }])
      }
    }

    const ledgerIssues = claimLedgerIssues({
      claims,
      evidenceRelations: relations,
      derivations,
      knownEvidenceIds: unique(evidenceIds),
    })
    for (const issue of ledgerIssues) {
      if (issue.code === 'claim-ledger-reference'
        || issue.code === 'claim-ledger-identity'
        || issue.code === 'claim-version-lineage'
        || issue.code === 'claim-ledger-current-version') {
        add('missing-object', 'blocker', issue.message, [{
          kind: 'artifact-manifest',
          objectId: artifact.artifactManifestId,
          path: issue.path,
        }])
      } else if (issue.code === 'derivation-activity-provenance'
        || issue.code === 'derivation-activity-reference-cycle'
        || issue.code === 'derivation-activity-time-order') {
        add('derivation-unreproducible', 'blocker', issue.message, [{
          kind: 'artifact-manifest',
          objectId: artifact.artifactManifestId,
          path: issue.path,
        }])
      } else if (issue.code === 'claim-ledger-basis'
        || issue.code === 'claim-ledger-status') {
        add('claim-without-support', 'blocker', issue.message, [{
          kind: 'artifact-manifest',
          objectId: artifact.artifactManifestId,
          path: issue.path,
        }])
      }
    }

    const artifactIssues = artifactManifestIssues(artifact, {
      claims,
      evidenceRelations: relations,
    })
    for (const issue of artifactIssues) {
      const subject = [{
        kind: 'artifact-manifest' as const,
        objectId: artifact.artifactManifestId,
        path: issue.path,
      }]
      if (issue.code === 'artifact-source-scope') {
        add('source-outside-scope', 'blocker', issue.message, subject)
      } else if (issue.code === 'artifact-evidence-reference') {
        add('citation-does-not-support', 'blocker', issue.message, subject)
      } else if (issue.code === 'artifact-claim-reference') {
        add('missing-object', 'blocker', issue.message, subject)
      } else {
        add('claim-use-unmapped', 'blocker', issue.message, subject)
      }
    }

    for (const claim of claims.filter(value => usedClaimIds.includes(value.claimVersionId))) {
      if (claim.scope.sourceScopeVersionId !== artifact.sourceScopeVersionId) {
        add('source-outside-scope', 'blocker', 'Claim belongs to a different source-scope version.', [{
          kind: 'claim-version',
          objectId: claim.claimVersionId,
        }])
      }
      if (claim.reviewStatus === 'unreviewed' || claim.reviewStatus === 'needs-changes') {
        add('unreviewed-claim', 'blocker', 'Publication includes a ClaimVersion without human acceptance.', [{
          kind: 'claim-version',
          objectId: claim.claimVersionId,
        }])
      } else if (claim.reviewStatus === 'rejected') {
        add('rejected-claim', 'blocker', 'Publication includes a rejected ClaimVersion.', [{
          kind: 'claim-version',
          objectId: claim.claimVersionId,
        }])
      }
      if (claim.lifecycleStatus !== 'current' || claim.epistemicStatus === 'stale'
        || claim.epistemicStatus === 'withdrawn') {
        add('stale-claim', 'blocker', 'Publication includes a stale or non-current ClaimVersion.', [{
          kind: 'claim-version',
          objectId: claim.claimVersionId,
        }])
      }
      if ((claim.basis === 'document-supported' || claim.basis === 'derived-from-claims')
        && (claim.epistemicStatus === 'proposed' || claim.epistemicStatus === 'unresolved')) {
        add('unresolved-claim', 'blocker', 'Publication includes an unresolved factual ClaimVersion.', [{
          kind: 'claim-version',
          objectId: claim.claimVersionId,
        }])
      }
      const active = relations.filter(relation => relation.claimVersionId === claim.claimVersionId
        && relation.reviewStatus !== 'human-rejected')
      const supportIds = new Set(active
        .filter(relation => relation.kind === 'supports')
        .map(relation => relation.evidenceId))
      const refuteIds = new Set(active
        .filter(relation => relation.kind === 'refutes')
        .map(relation => relation.evidenceId))
      if (refuteIds.size > 0) {
        const disclosed = claimUses.some(use => use.claimVersionId === claim.claimVersionId
          && use.useKind === 'conflict-disclosure'
          && use.citationEvidenceIds.some(id => supportIds.has(id))
          && use.citationEvidenceIds.some(id => refuteIds.has(id)))
        if (!disclosed) {
          add('material-conflict-undisclosed', 'blocker', 'Supporting and refuting Evidence must both be visible in a conflict disclosure.', [{
            kind: 'claim-version',
            objectId: claim.claimVersionId,
          }])
        }
      }
      for (const relation of active) {
        const resolution = this.options.resolveEvidence(relation.evidenceId, { investigationId: artifact.investigationId, sourceScopeVersionId: artifact.sourceScopeVersionId })
        if (resolution?.kind === 'evidence-atom'
          && !resolution.sourceScopeVersionIds.includes(artifact.sourceScopeVersionId)) {
          add('source-outside-scope', 'blocker', 'EvidenceRelation resolves outside the artifact source-scope version.', [{
            kind: 'evidence-relation',
            objectId: relation.evidenceRelationId,
          }])
        }
      }
    }

    const assuranceInput = {
      workspaceId: artifact.workspaceId,
      investigationId: artifact.investigationId,
      sourceScopeVersionId: artifact.sourceScopeVersionId,
      artifactManifestId: artifact.artifactManifestId,
    }
    const conflictEvidenceIds = unique(relations
      .filter(relation => usedClaimIds.includes(relation.claimVersionId)
        && relation.reviewStatus !== 'human-rejected')
      .map(relation => relation.evidenceId))
    const conflictAssurance = findConflictSearchAssurance(
      state,
      artifact,
      usedClaimIds,
      conflictEvidenceIds,
      command.createdAt,
    )
    if (conflictAssurance === undefined) {
      add('conflict-search-incomplete', 'blocker', 'Configured conflict search has not completed for this exact artifact scope.', [{
        kind: 'artifact-manifest',
        objectId: artifact.artifactManifestId,
      }])
    } else if (!checkedObjectIds.includes(conflictAssurance.assuranceId)) {
      checkedObjectIds.push(conflictAssurance.assuranceId)
    }
    if (this.options.publicationAssurance?.publicationAllowed?.(assuranceInput) === false) {
      add('policy-violation', 'blocker', 'ResearchPolicy blocks publication of this artifact.', [{
        kind: 'policy',
        objectId: artifact.sourceScopeVersionId,
      }])
    }

    issues.sort(compareReviewIssues)
    const gates = REVIEW_GATE_IDS.map((gateId): ReviewGateResult => {
      const gateIssues = issues.filter(issue => issue.gateId === gateId)
      return {
        gateId,
        status: gateIssues.some(issue => issue.severity === 'blocker') ? 'fail' : 'pass',
        checkedObjectIds: checkedForGate(
          gateId,
          artifact,
          claimUses,
          claims,
          relations,
          derivations,
          unique(evidenceIds),
          conflictAssurance?.assuranceId,
        ),
        issueIds: gateIssues.map(issue => issue.issueId),
      }
    }) as ReviewResult['gates']
    const failedItems = gates.filter(gate => gate.status === 'fail').length
    const review: ReviewResult = {
      schemaVersion: 1,
      reviewResultId: command.reviewResultId,
      workspaceId: artifact.workspaceId,
      investigationId: artifact.investigationId,
      sourceScopeVersionId: artifact.sourceScopeVersionId,
      mode: 'publish-gate',
      subject: {
        kind: 'artifact-manifest',
        objectIds: [artifact.artifactManifestId],
        contentHash: artifact.contentHash,
      },
      ruleset: cloneCanonical(command.ruleset),
      checkedObjectIds: unique(checkedObjectIds),
      gates,
      issues,
      coverage: {
        requiredItems: REVIEW_GATE_IDS.length,
        checkedItems: REVIEW_GATE_IDS.length,
        passedItems: REVIEW_GATE_IDS.length - failedItems,
        failedItems,
        notApplicableItems: 0,
        complete: true,
      },
      signoffRequirement: command.signoffRequirement,
      decision: failedItems > 0
        ? 'fail'
        : command.signoffRequirement === 'required'
          ? 'needs-human'
          : 'pass',
      reviewer: cloneCanonical(command.reviewer),
      createdAt: command.createdAt,
    }
    const semanticIssues = reviewResultIssues(review)
    if (semanticIssues.length > 0) {
      integrity(`computed ReviewResult violated its contract: ${semanticIssues[0]?.message ?? 'unknown issue'}`)
    }
    return review
  }

  private assertArtifactEvidenceStillPublishable(
    artifact: ArtifactManifest,
    state: M4State,
  ): void {
    if (invalidDerivedClaimInputs(state, unique(collectClaimUses(artifact).map(use => use.claimVersionId)), artifact).length) {
      blocked('Derived Claim input acceptance or source scope changed after deterministic review')
    }
    const claimIds = [...collectClaimClosure(
      state,
      unique(collectClaimUses(artifact).map(use => use.claimVersionId)),
    ).claimIds]
    const relations = [...state.evidenceRelations.values()]
      .filter(relation => claimIds.includes(relation.claimVersionId)
        && relation.reviewStatus !== 'human-rejected')
    for (const relation of relations) {
      const resolution = this.options.resolveEvidence(relation.evidenceId, { investigationId: artifact.investigationId, sourceScopeVersionId: artifact.sourceScopeVersionId })
      if (resolution === undefined || resolution.kind !== 'evidence-atom'
        || resolution.workspaceId !== artifact.workspaceId
        || resolution.investigationId !== artifact.investigationId
        || !resolution.sourceScopeVersionIds.includes(artifact.sourceScopeVersionId)
        || (resolution.integrity ?? 'valid') !== 'valid'
        || resolution.evidence.status !== 'current'
        || (resolution.evidence.resolutionStatus !== 'resolved'
          && resolution.evidence.resolutionStatus !== 'page-only')) {
        blocked('Evidence integrity or source scope changed after deterministic review')
      }
    }
  }
}

export function artifactContentHash(
  value: ArtifactManifest | ArtifactManifest['content'],
): string {
  const content = isRecord(value) && 'content' in value
    ? value.content
    : value
  return sha256(canonicalJson(content))
}

function initializeM4Schema(database: DatabaseSync, workspaceId: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS investigation_m4_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      workspace_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS investigation_m4_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS investigation_m4_events_investigation
      ON investigation_m4_events(investigation_id, sequence);
    CREATE TRIGGER IF NOT EXISTS investigation_m4_events_no_update
      BEFORE UPDATE ON investigation_m4_events
      BEGIN SELECT RAISE(ABORT, 'M4 journal is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS investigation_m4_events_no_delete
      BEFORE DELETE ON investigation_m4_events
      BEGIN SELECT RAISE(ABORT, 'M4 journal is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS investigation_m4_metadata_no_update
      BEFORE UPDATE ON investigation_m4_metadata
      BEGIN SELECT RAISE(ABORT, 'M4 metadata is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS investigation_m4_metadata_no_delete
      BEFORE DELETE ON investigation_m4_metadata
      BEGIN SELECT RAISE(ABORT, 'M4 metadata is immutable'); END;
  `)
  const row = database.prepare(`
    SELECT schema_version, workspace_id
    FROM investigation_m4_metadata
    WHERE singleton = 1
  `).get() as Record<string, unknown> | undefined
  if (row === undefined) {
    database.prepare(`
      INSERT INTO investigation_m4_metadata(singleton, schema_version, workspace_id)
      VALUES (1, ?, ?)
    `).run(M4_STORE_SCHEMA_VERSION, workspaceId)
    return
  }
  if (integerColumn(row, 'schema_version') !== M4_STORE_SCHEMA_VERSION) {
    integrity('unsupported M4 store schema version')
  }
  if (stringColumn(row, 'workspace_id') !== workspaceId) {
    invalid('M4 SQLite adapter is already bound to a different workspace')
  }
}

function appendEvent(
  database: DatabaseSync,
  workspaceId: string,
  idempotencyKey: string,
  requestJson: string,
  payload: M4EventPayload,
  descriptor: EventDescriptor,
  result: M4MutationResult<unknown>,
): void {
  const count = database.prepare(`
    SELECT count(*) AS count FROM investigation_m4_events
  `).get() as Record<string, unknown> | undefined
  if (count === undefined || integerColumn(count, 'count') >= MAX_M4_EVENTS) {
    limitExceeded('M4 Investigation journal event limit is reached')
  }
  const previous = database.prepare(`
    SELECT event_hash FROM investigation_m4_events ORDER BY sequence DESC LIMIT 1
  `).get() as Record<string, unknown> | undefined
  const previousEventHash = previous === undefined
    ? GENESIS_HASH
    : stringColumn(previous, 'event_hash')
  const payloadJson = canonicalJson(payload)
  const resultJson = canonicalJson(result)
  const requestHash = sha256(requestJson)
  const payloadHash = sha256(payloadJson)
  const resultHash = sha256(resultJson)
  const eventId = `m4-event:${sha256(`${workspaceId}\0${idempotencyKey}`).slice(0, 32)}`
  const eventHash = hashEvent({
    eventId,
    workspaceId,
    investigationId: descriptor.investigationId,
    eventType: payload.type,
    aggregateId: descriptor.aggregateId,
    aggregateVersion: descriptor.aggregateVersion,
    idempotencyKey,
    requestHash,
    payloadHash,
    resultHash,
    previousEventHash,
    createdAt: descriptor.createdAt,
  })
  database.prepare(`
    INSERT INTO investigation_m4_events(
      event_id, workspace_id, investigation_id, event_type,
      aggregate_id, aggregate_version, idempotency_key,
      request_json, request_hash, payload_json, payload_hash,
      result_json, result_hash, previous_event_hash, event_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    workspaceId,
    descriptor.investigationId,
    payload.type,
    descriptor.aggregateId,
    descriptor.aggregateVersion,
    idempotencyKey,
    requestJson,
    requestHash,
    payloadJson,
    payloadHash,
    resultJson,
    resultHash,
    previousEventHash,
    eventHash,
    descriptor.createdAt,
  )
}

function readStoredEvents(database: DatabaseSync): StoredEvent[] {
  const rows = database.prepare(`
    SELECT sequence, event_id, workspace_id, investigation_id, event_type,
           aggregate_id, aggregate_version, idempotency_key,
           request_json, request_hash, payload_json, payload_hash,
           result_json, result_hash, previous_event_hash, event_hash, created_at
    FROM investigation_m4_events
    ORDER BY sequence
  `).all() as Record<string, unknown>[]
  return rows.map(row => ({
    sequence: integerColumn(row, 'sequence'),
    eventId: stringColumn(row, 'event_id'),
    workspaceId: stringColumn(row, 'workspace_id'),
    investigationId: stringColumn(row, 'investigation_id'),
    eventType: parseEventType(stringColumn(row, 'event_type')),
    aggregateId: stringColumn(row, 'aggregate_id'),
    aggregateVersion: integerColumn(row, 'aggregate_version'),
    idempotencyKey: stringColumn(row, 'idempotency_key'),
    requestJson: stringColumn(row, 'request_json'),
    requestHash: stringColumn(row, 'request_hash'),
    payloadJson: stringColumn(row, 'payload_json'),
    payloadHash: stringColumn(row, 'payload_hash'),
    resultJson: stringColumn(row, 'result_json'),
    resultHash: stringColumn(row, 'result_hash'),
    previousEventHash: stringColumn(row, 'previous_event_hash'),
    eventHash: stringColumn(row, 'event_hash'),
    createdAt: stringColumn(row, 'created_at'),
  }))
}

function verifyStoredEvent(
  row: StoredEvent,
  workspaceId: string,
  previousEventHash: string,
): void {
  if (row.workspaceId !== workspaceId || row.previousEventHash !== previousEventHash) {
    integrity('M4 journal workspace identity or hash chain is invalid')
  }
  if (row.requestHash !== sha256(row.requestJson)
    || row.payloadHash !== sha256(row.payloadJson)
    || row.resultHash !== sha256(row.resultJson)) {
    integrity('M4 journal payload hash is invalid')
  }
  const expectedId = `m4-event:${sha256(`${workspaceId}\0${row.idempotencyKey}`).slice(0, 32)}`
  if (row.eventId !== expectedId || row.eventHash !== hashEvent(row)) {
    integrity('M4 journal event identity or hash is invalid')
  }
  requireIsoTimestamp(row.createdAt, 'stored event createdAt', 'integrity-error')
}

function hashEvent(value: {
  eventId: string
  workspaceId: string
  investigationId: string
  eventType: string
  aggregateId: string
  aggregateVersion: number
  idempotencyKey: string
  requestHash: string
  payloadHash: string
  resultHash: string
  previousEventHash: string
  createdAt: string
}): string {
  return sha256(canonicalJson({
    eventId: value.eventId,
    workspaceId: value.workspaceId,
    investigationId: value.investigationId,
    eventType: value.eventType,
    aggregateId: value.aggregateId,
    aggregateVersion: value.aggregateVersion,
    idempotencyKey: value.idempotencyKey,
    requestHash: value.requestHash,
    payloadHash: value.payloadHash,
    resultHash: value.resultHash,
    previousEventHash: value.previousEventHash,
    createdAt: value.createdAt,
  }))
}

function emptyState(): M4State {
  return {
    claims: new Map(),
    chainCurrent: new Map(),
    derivations: new Map(),
    evidenceRelations: new Map(),
    artifacts: new Map(),
    artifactLatest: new Map(),
    conflictAssurances: new Map(),
    reviews: new Map(),
    humanDecisions: new Map(),
    eventsByIdempotencyKey: new Map(),
  }
}

function applyPayload(state: M4State, payload: M4EventPayload): M4MutationResult<unknown> {
  switch (payload.type) {
    case 'claim-version.recorded': {
      assertClaimBundle({
        workspaceId: payload.claim.workspaceId,
        investigationId: payload.claim.investigationId,
        idempotencyKey: 'replay',
        expectedCurrentClaimVersionId: payload.expectedCurrentClaimVersionId,
        claim: payload.claim,
        provenance: payload.provenance,
        evidenceRelations: payload.evidenceRelations,
      }, state, 'integrity-error')
      if (payload.expectedCurrentClaimVersionId !== null) {
        const previous = state.claims.get(payload.expectedCurrentClaimVersionId)
        if (previous === undefined) integrity('claim predecessor vanished during replay')
        state.claims.set(previous.claimVersionId, {
          ...previous,
          lifecycleStatus: 'superseded',
          supersededByClaimVersionId: payload.claim.claimVersionId,
        })
      }
      state.claims.set(payload.claim.claimVersionId, cloneCanonical(payload.claim))
      state.chainCurrent.set(payload.claim.claimChainId, payload.claim.claimVersionId)
      state.derivations.set(payload.provenance.derivationActivityId, cloneCanonical(payload.provenance))
      for (const relation of payload.evidenceRelations) {
        state.evidenceRelations.set(relation.evidenceRelationId, cloneCanonical(relation))
      }
      assertLedgerProjection(state, payload.claim.investigationId)
      return { status: 'created', value: cloneCanonical(payload.claim) }
    }
    case 'artifact-draft.recorded': {
      assertArtifactDraft(payload.manifest, payload.expectedPreviousArtifactManifestId, state, 'integrity-error')
      const previousId = payload.expectedPreviousArtifactManifestId
      if (previousId !== null) {
        const previous = state.artifacts.get(previousId)
        if (previous === undefined || previous.status === 'draft') {
          integrity('artifact predecessor cannot be projected as superseded')
        }
        state.artifacts.set(previousId, { ...previous, status: 'superseded' })
      }
      state.artifacts.set(payload.manifest.artifactManifestId, cloneCanonical(payload.manifest))
      state.artifactLatest.set(payload.manifest.artifactId, payload.manifest.artifactManifestId)
      return { status: 'created', value: cloneCanonical(payload.manifest) }
    }
    case 'conflict-search-assurance.recorded': {
      assertConflictSearchAssurance(payload.assurance, state, 'integrity-error')
      state.conflictAssurances.set(
        payload.assurance.assuranceId,
        cloneCanonical(payload.assurance),
      )
      return { status: 'created', value: cloneCanonical(payload.assurance) }
    }
    case 'review-result.recorded': {
      if (state.reviews.has(payload.review.reviewResultId)) {
        integrity('duplicate immutable ReviewResult during replay')
      }
      const issues = reviewResultIssues(payload.review)
      if (issues.length > 0) integrity(`stored ReviewResult is invalid: ${issues[0]?.message ?? 'unknown issue'}`)
      const artifactId = payload.review.subject.objectIds[0]
      const artifact = artifactId === undefined ? undefined : state.artifacts.get(artifactId)
      if (artifact === undefined) integrity('ReviewResult references a missing artifact')
      assertReviewPinsArtifact(payload.review, artifact, 'integrity-error')
      state.reviews.set(payload.review.reviewResultId, cloneCanonical(payload.review))
      return { status: 'created', value: cloneCanonical(payload.review) }
    }
    case 'human-review-decision.recorded': {
      assertHumanReviewDecision(payload.decision, state, 'integrity-error')
      const review = state.reviews.get(payload.decision.reviewResultId)
      if (review === undefined) integrity('human decision references a missing ReviewResult')
      if (payload.decision.decision === 'approved' && review.decision !== 'needs-human') {
        integrity('stored human approval overrides deterministic review')
      }
      state.humanDecisions.set(payload.decision.reviewDecisionId, cloneCanonical(payload.decision))
      return { status: 'created', value: cloneCanonical(payload.decision) }
    }
    case 'artifact.published': {
      const artifact = state.artifacts.get(payload.artifactManifestId)
      if (artifact === undefined || artifact.status !== payload.expectedStatus) {
        integrity('artifact publication CAS failed during replay')
      }
      const review = state.reviews.get(payload.publication.reviewResultId)
      if (review === undefined) integrity('artifact publication references a missing ReviewResult')
      assertReviewPinsArtifact(review, artifact, 'integrity-error')
      if (review.decision !== 'pass' && review.decision !== 'needs-human') {
        integrity('stored artifact bypasses deterministic publication gates')
      }
      if (review.decision === 'needs-human') {
        const decisionId = payload.publication.humanReviewDecisionId
        const decision = decisionId === undefined ? undefined : state.humanDecisions.get(decisionId)
        if (decision === undefined || decision.reviewResultId !== review.reviewResultId
          || decision.decision !== 'approved') {
          integrity('stored artifact lacks its exact human publication approval')
        }
      }
      const published: ArtifactManifest = {
        ...artifact,
        status: 'published',
        publication: cloneCanonical(payload.publication),
      }
      const issues = artifactManifestIssues(published, {
        claims: [...state.claims.values()],
        evidenceRelations: [...state.evidenceRelations.values()],
        reviewResult: review,
      })
      if (issues.length > 0) integrity(`stored artifact publication is invalid: ${issues[0]?.message ?? 'unknown issue'}`)
      if (artifactContentHash(published) !== published.contentHash) {
        integrity('stored artifact content hash is invalid')
      }
      state.artifacts.set(artifact.artifactManifestId, published)
      return { status: 'created', value: cloneCanonical(published) }
    }
  }
}

function assertClaimBundle(
  command: RecordClaimVersionCommand,
  state: M4State,
  errorCode: 'invalid-request' | 'integrity-error' = 'invalid-request',
): void {
  const fail = errorCode === 'integrity-error' ? integrity : invalid
  const { claim, provenance, evidenceRelations } = command
  requireId(command.investigationId, 'investigationId', errorCode)
  if (claim.workspaceId !== command.workspaceId
    || claim.investigationId !== command.investigationId
    || provenance.workspaceId !== command.workspaceId
    || provenance.investigationId !== command.investigationId
    || evidenceRelations.some(relation => relation.workspaceId !== command.workspaceId
      || relation.investigationId !== command.investigationId
      || relation.claimVersionId !== claim.claimVersionId)) {
    fail('Claim bundle cannot cross workspace or Investigation identity')
  }
  if (claim.lifecycleStatus !== 'current' || claim.supersededByClaimVersionId !== undefined) {
    fail('a newly recorded ClaimVersion must be current and must not name a future successor')
  }
  if (state.claims.has(claim.claimVersionId)
    || state.derivations.has(provenance.derivationActivityId)
    || evidenceRelations.some(relation => state.evidenceRelations.has(relation.evidenceRelationId))) {
    fail('Claim bundle reuses an immutable object id')
  }
  if (new Set(evidenceRelations.map(relation => relation.evidenceRelationId)).size
    !== evidenceRelations.length) {
    fail('Claim bundle repeats an EvidenceRelation id')
  }
  const currentId = state.chainCurrent.get(claim.claimChainId)
  if (command.expectedCurrentClaimVersionId === null) {
    if (currentId !== undefined || claim.version !== 1
      || claim.previousClaimVersionId !== undefined) {
      if (errorCode === 'integrity-error') {
        integrity('new Claim chain creation failed its compare-and-swap precondition')
      }
      conflict('new Claim chain creation failed its compare-and-swap precondition')
    }
  } else {
    const previous = state.claims.get(command.expectedCurrentClaimVersionId)
    if (currentId !== command.expectedCurrentClaimVersionId
      || previous === undefined
      || previous.lifecycleStatus !== 'current'
      || claim.version !== previous.version + 1
      || claim.previousClaimVersionId !== previous.claimVersionId
      || claim.claimChainId !== previous.claimChainId) {
      if (errorCode === 'integrity-error') {
        integrity('ClaimVersion compare-and-swap or immutable lineage is stale')
      }
      conflict('ClaimVersion compare-and-swap or immutable lineage is stale')
    }
  }
  if (provenance.outputClaimVersionIds.length !== 1
    || provenance.outputClaimVersionIds[0] !== claim.claimVersionId) {
    fail('Claim provenance must output exactly this immutable ClaimVersion')
  }
  const localIssues = [
    ...derivationActivityIssues(provenance),
    ...evidenceRelations.flatMap(evidenceRelationIssues),
  ]
  if (localIssues.length > 0) fail(localIssues[0]?.message ?? 'Claim bundle is invalid')

  const claims = [...state.claims.values()].map(existing => existing.claimVersionId === command.expectedCurrentClaimVersionId
    ? {
        ...existing,
        lifecycleStatus: 'superseded' as const,
        supersededByClaimVersionId: claim.claimVersionId,
      }
    : existing)
  claims.push(claim)
  const snapshot: ClaimLedgerSnapshot = {
    claims,
    evidenceRelations: [...state.evidenceRelations.values(), ...evidenceRelations],
    derivations: [...state.derivations.values(), provenance],
  }
  const issues = claimLedgerIssues(snapshot)
  if (issues.length > 0) fail(issues[0]?.message ?? 'Claim Ledger bundle is invalid')
}

function assertLedgerProjection(state: M4State, investigationId: string): void {
  const claims = [...state.claims.values()].filter(claim => claim.investigationId === investigationId)
  const ids = new Set(claims.map(claim => claim.claimVersionId))
  const issues = claimLedgerIssues({
    claims,
    evidenceRelations: [...state.evidenceRelations.values()]
      .filter(relation => ids.has(relation.claimVersionId)),
    derivations: [...state.derivations.values()]
      .filter(derivation => derivation.investigationId === investigationId),
  })
  if (issues.length > 0) integrity(`Claim Ledger replay is invalid: ${issues[0]?.message ?? 'unknown issue'}`)
}

function assertArtifactDraft(
  manifest: ArtifactManifest & { status: 'draft' },
  expectedPreviousId: string | null,
  state: M4State,
  errorCode: 'invalid-request' | 'integrity-error' = 'invalid-request',
): void {
  const fail = errorCode === 'integrity-error' ? integrity : invalid
  if (manifest.status !== 'draft' || manifest.publication !== undefined) {
    fail('only an unpublished ArtifactManifest draft can be recorded')
  }
  if (state.artifacts.has(manifest.artifactManifestId)) {
    fail('artifactManifestId is already immutable')
  }
  const latestId = state.artifactLatest.get(manifest.artifactId)
  if (expectedPreviousId === null) {
    if (latestId !== undefined || manifest.version !== 1
      || manifest.previousArtifactManifestId !== undefined) {
      fail('new Artifact chain creation failed its compare-and-swap precondition')
    }
  } else {
    const previous = state.artifacts.get(expectedPreviousId)
    if (latestId !== expectedPreviousId || previous === undefined
      || previous.status === 'draft'
      || manifest.version !== previous.version + 1
      || manifest.previousArtifactManifestId !== previous.artifactManifestId) {
      fail('ArtifactManifest compare-and-swap or immutable lineage is stale')
    }
  }
  if (manifest.contentHash !== artifactContentHash(manifest)) {
    fail('ArtifactManifest contentHash must bind canonical content exactly')
  }
  const issues = artifactManifestIssues(manifest, {
    claims: [...state.claims.values()],
    evidenceRelations: [...state.evidenceRelations.values()],
  })
  if (issues.length > 0) fail(issues[0]?.message ?? 'ArtifactManifest draft is invalid')
}

function assertConflictSearchAssurance(
  assurance: ConflictSearchAssurance,
  state: M4State,
  errorCode: 'invalid-request' | 'integrity-error' = 'invalid-request',
): void {
  const fail = errorCode === 'integrity-error' ? integrity : invalid
  if (assurance.schemaVersion !== 1) fail('conflict-search assurance schemaVersion is invalid')
  requireId(assurance.assuranceId, 'assuranceId', errorCode)
  requireId(assurance.workspaceId, 'workspaceId', errorCode)
  requireId(assurance.investigationId, 'investigationId', errorCode)
  requireId(assurance.sourceScopeVersionId, 'sourceScopeVersionId', errorCode)
  requireActor(assurance.assuredBy, 'user', 'assuredBy', errorCode)
  requireIsoTimestamp(assurance.assuredAt, 'assuredAt', errorCode)
  if (state.conflictAssurances.has(assurance.assuranceId)) {
    fail('conflict-search assurance id is already immutable')
  }
  if (assurance.claimVersionIds.length === 0
    || new Set(assurance.claimVersionIds).size !== assurance.claimVersionIds.length
    || new Set(assurance.evidenceIds).size !== assurance.evidenceIds.length
    || canonicalJson(assurance.claimVersionIds) !== canonicalJson([...assurance.claimVersionIds].sort())
    || canonicalJson(assurance.evidenceIds) !== canonicalJson([...assurance.evidenceIds].sort())) {
    fail('conflict-search assurance ids must be unique, sorted, and include at least one ClaimVersion')
  }
  for (const claimVersionId of assurance.claimVersionIds) {
    const claim = state.claims.get(claimVersionId)
    if (claim === undefined
      || claim.workspaceId !== assurance.workspaceId
      || claim.investigationId !== assurance.investigationId
      || claim.scope.sourceScopeVersionId !== assurance.sourceScopeVersionId
      || claim.lifecycleStatus !== 'current') {
      fail('conflict-search assurance must pin current Claims in its exact source scope')
    }
  }
  const expectedEvidenceIds = unique([...state.evidenceRelations.values()]
    .filter(relation => assurance.claimVersionIds.includes(relation.claimVersionId)
      && relation.reviewStatus !== 'human-rejected')
    .map(relation => relation.evidenceId)).sort()
  if (canonicalJson(expectedEvidenceIds) !== canonicalJson(assurance.evidenceIds)) {
    fail('conflict-search assurance must pin the complete active EvidenceRelation set')
  }
}

function assertHumanReviewDecision(
  decision: HumanReviewDecision,
  state: M4State,
  errorCode: 'invalid-request' | 'integrity-error' = 'invalid-request',
): void {
  const fail = errorCode === 'integrity-error' ? integrity : invalid
  if (decision.schemaVersion !== 1) fail('human review decision schemaVersion is invalid')
  requireId(decision.reviewDecisionId, 'reviewDecisionId', errorCode)
  requireId(decision.workspaceId, 'workspaceId', errorCode)
  requireId(decision.investigationId, 'investigationId', errorCode)
  requireId(decision.reviewResultId, 'reviewResultId', errorCode)
  requireActor(decision.decidedBy, 'user', 'decidedBy', errorCode)
  requireIsoTimestamp(decision.decidedAt, 'decidedAt', errorCode)
  if (decision.decision !== 'approved' && decision.decision !== 'rejected') {
    fail('human review decision value is invalid')
  }
  if (decision.rationale !== undefined
    && (decision.rationale.trim().length === 0 || decision.rationale.length > 10_000)) {
    fail('human review rationale is invalid')
  }
  if (state.humanDecisions.has(decision.reviewDecisionId)) {
    fail('reviewDecisionId is already immutable')
  }
  const review = state.reviews.get(decision.reviewResultId)
  if (review === undefined) {
    if (errorCode === 'integrity-error') {
      integrity('human review decision references a missing ReviewResult')
    }
    invalid('human review decision references a missing ReviewResult')
  }
  if (review.workspaceId !== decision.workspaceId
    || review.investigationId !== decision.investigationId) {
    fail('human review decision cannot cross workspace or Investigation identity')
  }
  if (Date.parse(decision.decidedAt) < Date.parse(review.createdAt)) {
    fail('human review decision cannot precede deterministic review')
  }
}

function assertReviewPinsArtifact(
  review: ReviewResult,
  artifact: ArtifactManifest,
  errorCode: 'publish-blocked' | 'integrity-error' = 'publish-blocked',
): void {
  const fail = errorCode === 'integrity-error' ? integrity : blocked
  if (review.workspaceId !== artifact.workspaceId
    || review.investigationId !== artifact.investigationId
    || review.sourceScopeVersionId !== artifact.sourceScopeVersionId
    || review.mode !== 'publish-gate'
    || review.subject.kind !== 'artifact-manifest'
    || review.subject.objectIds.length !== 1
    || review.subject.objectIds[0] !== artifact.artifactManifestId
    || review.subject.contentHash !== artifact.contentHash) {
    fail('ReviewResult does not pin this exact artifact identity and content hash')
  }
}

function collectClaimUses(artifact: ArtifactManifest): ClaimUse[] {
  return artifact.content.kind === 'brief'
    ? artifact.content.sections.flatMap(section => section.claimUses)
    : artifact.content.cells.flatMap(cell => cell.claimUses)
}

/** Validate factual premises, not the previous/successor links retained only for version history. */
function invalidDerivedClaimInputs(
  state: M4State,
  seedClaimIds: readonly string[],
  artifact: ArtifactManifest,
): Array<{ claimVersionId: string, inputClaimVersionId: string }> {
  const invalidInputs: Array<{ claimVersionId: string, inputClaimVersionId: string }> = []
  const seen = new Set<string>(), pending = [...seedClaimIds]
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const claim = state.claims.get(id)
    if (claim?.basis !== 'derived-from-claims') continue
    const activity = state.derivations.get(claim.provenanceActivityId)
    if (!activity) continue // The deterministic missing-provenance gate reports this separately.
    for (const inputId of activity.inputClaimVersionIds) {
      const input = state.claims.get(inputId)
      if (!input || input.workspaceId !== artifact.workspaceId || input.investigationId !== artifact.investigationId
        || input.scope.sourceScopeVersionId !== artifact.sourceScopeVersionId || input.reviewStatus !== 'accepted'
        || input.lifecycleStatus !== 'current' || ['proposed', 'unresolved', 'stale', 'withdrawn'].includes(input.epistemicStatus)) {
        invalidInputs.push({ claimVersionId: id, inputClaimVersionId: inputId })
      }
      pending.push(inputId)
    }
  }
  return invalidInputs
}

function collectClaimClosure(
  state: M4State,
  seedClaimIds: readonly string[],
): { claimIds: Set<string>, derivationIds: Set<string> } {
  const claimIds = new Set<string>()
  const derivationIds = new Set<string>()
  const pending = [...seedClaimIds]
  while (pending.length > 0) {
    const claimVersionId = pending.shift()
    if (claimVersionId === undefined || claimIds.has(claimVersionId)) continue
    claimIds.add(claimVersionId)
    const claim = state.claims.get(claimVersionId)
    if (claim === undefined) continue
    if (claim.previousClaimVersionId !== undefined) pending.push(claim.previousClaimVersionId)
    if (claim.supersededByClaimVersionId !== undefined) pending.push(claim.supersededByClaimVersionId)
    derivationIds.add(claim.provenanceActivityId)
    const activity = state.derivations.get(claim.provenanceActivityId)
    if (activity !== undefined) pending.push(...activity.inputClaimVersionIds)
  }
  return { claimIds, derivationIds }
}

function findConflictSearchAssurance(
  state: M4State,
  artifact: ArtifactManifest,
  claimVersionIds: readonly string[],
  evidenceIds: readonly string[],
  reviewedAt: string,
): ConflictSearchAssurance | undefined {
  const expectedClaims = [...claimVersionIds].sort()
  const expectedEvidence = [...evidenceIds].sort()
  return [...state.conflictAssurances.values()]
    .filter(assurance => assurance.workspaceId === artifact.workspaceId
      && assurance.investigationId === artifact.investigationId
      && assurance.sourceScopeVersionId === artifact.sourceScopeVersionId
      && Date.parse(assurance.assuredAt) <= Date.parse(reviewedAt)
      && canonicalJson(assurance.claimVersionIds) === canonicalJson(expectedClaims)
      && canonicalJson(assurance.evidenceIds) === canonicalJson(expectedEvidence))
    .sort((left, right) => right.assuredAt.localeCompare(left.assuredAt)
      || right.assuranceId.localeCompare(left.assuranceId))[0]
}

function checkedForGate(
  gateId: ReviewGateId,
  artifact: ArtifactManifest,
  uses: readonly ClaimUse[],
  claims: readonly ClaimVersion[],
  relations: readonly EvidenceRelation[],
  derivations: readonly DerivationActivity[],
  evidenceIds: readonly string[],
  conflictAssuranceId?: string,
): string[] {
  const artifactId = artifact.artifactManifestId
  switch (gateId) {
    case 'G0-integrity':
      return unique([artifactId, ...claims.map(claim => claim.claimVersionId),
        ...derivations.map(value => value.derivationActivityId), ...evidenceIds])
    case 'G1-grounding':
      return unique([artifactId, ...uses.map(use => use.claimUseId),
        ...claims.map(claim => claim.claimVersionId),
        ...relations.map(relation => relation.evidenceRelationId), ...evidenceIds])
    case 'G2-scope':
      return unique([artifactId, artifact.sourceScopeVersionId,
        ...claims.map(claim => claim.claimVersionId), ...evidenceIds])
    case 'G3-conflict':
      return unique([artifactId, ...uses.map(use => use.claimUseId),
        ...claims.map(claim => claim.claimVersionId),
        ...relations.map(relation => relation.evidenceRelationId),
        ...(conflictAssuranceId === undefined ? [] : [conflictAssuranceId])])
    case 'G4-publication':
      return unique([artifactId, ...uses.map(use => use.claimUseId),
        ...claims.map(claim => claim.claimVersionId)])
  }
}

const REVIEW_ISSUE_GATE: Record<ReviewIssueCode, ReviewGateId> = {
  'locator-unresolvable': 'G0-integrity',
  'source-revision-mismatch': 'G0-integrity',
  'content-hash-mismatch': 'G0-integrity',
  'missing-object': 'G0-integrity',
  'derivation-unreproducible': 'G0-integrity',
  'claim-without-support': 'G1-grounding',
  'partial-support-undisclosed': 'G1-grounding',
  'citation-does-not-support': 'G1-grounding',
  'claim-use-unmapped': 'G1-grounding',
  'derived-claim-input-invalid': 'G1-grounding',
  'source-outside-scope': 'G2-scope',
  'scope-coverage-incomplete': 'G2-scope',
  'temporal-scope-mismatch': 'G2-scope',
  'jurisdiction-scope-mismatch': 'G2-scope',
  'definition-scope-mismatch': 'G2-scope',
  'source-authority-limited': 'G2-scope',
  'conflict-search-incomplete': 'G3-conflict',
  'material-conflict-undisclosed': 'G3-conflict',
  'refuting-evidence-unresolved': 'G3-conflict',
  'dependent-lineage-double-counted': 'G3-conflict',
  'unreviewed-claim': 'G4-publication',
  'rejected-claim': 'G4-publication',
  'stale-claim': 'G4-publication',
  'unresolved-claim': 'G4-publication',
  'policy-violation': 'G4-publication',
  'artifact-claim-use-invalid': 'G4-publication',
}

function createReviewIssueAdder(
  issues: ReviewIssue[],
  checkedObjectIds: string[],
): (
  code: ReviewIssueCode,
  severity: ReviewIssue['severity'],
  message: string,
  subjects: ReviewIssue['subjects'],
  ) => void {
  const keys = new Set<string>()
  return (code, severity, message, subjects) => {
    for (const subject of subjects) {
      if (!checkedObjectIds.includes(subject.objectId)) checkedObjectIds.push(subject.objectId)
    }
    const gateId = REVIEW_ISSUE_GATE[code]
    const key = canonicalJson({ code, severity, message, subjects })
    if (keys.has(key)) return
    keys.add(key)
    const digest = sha256(key).slice(0, 32)
    issues.push({
      issueId: `review-issue:${digest}`,
      code,
      gateId,
      severity,
      message,
      subjects: cloneCanonical(subjects),
      ruleId: `m4-rule:${code}`,
      status: 'open',
    })
  }
}

function compareReviewIssues(left: ReviewIssue, right: ReviewIssue): number {
  const gate = REVIEW_GATE_IDS.indexOf(left.gateId) - REVIEW_GATE_IDS.indexOf(right.gateId)
  return gate !== 0 ? gate : left.issueId.localeCompare(right.issueId)
}

function compareClaimVersions(left: ClaimVersion, right: ClaimVersion): number {
  return left.claimChainId.localeCompare(right.claimChainId) || left.version - right.version
}

function requireRuleset(value: ReviewResult['ruleset']): void {
  requireId(value.name, 'ruleset.name')
  requireId(value.version, 'ruleset.version')
  if (!/^[a-f0-9]{64}$/.test(value.configHash)) invalid('ruleset.configHash must be a SHA-256 digest')
}

function requireActor(
  value: ActorRef,
  expected: ActorRef['kind'] | readonly ActorRef['kind'][],
  field: string,
  errorCode: 'invalid-request' | 'integrity-error' = 'invalid-request',
): void {
  const kinds: readonly ActorRef['kind'][] = Array.isArray(expected) ? expected : [expected]
  if (!kinds.includes(value.kind) || typeof value.actorId !== 'string'
    || value.actorId.trim().length === 0) {
    const message = `${field} actor is invalid`
    if (errorCode === 'integrity-error') integrity(message)
    invalid(message)
  }
}

function requireId(
  value: string,
  field: string,
  errorCode: 'invalid-request' | 'integrity-error' = 'invalid-request',
): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    const message = `${field} is invalid`
    if (errorCode === 'integrity-error') integrity(message)
    invalid(message)
  }
}

function requireIsoTimestamp(
  value: string,
  field: string,
  errorCode: 'invalid-request' | 'integrity-error' = 'invalid-request',
): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    const message = `${field} is not an ISO timestamp`
    if (errorCode === 'integrity-error') integrity(message)
    invalid(message)
  }
}

function parseEventType(value: string): M4EventPayload['type'] {
  if (value === 'claim-version.recorded'
    || value === 'artifact-draft.recorded'
    || value === 'conflict-search-assurance.recorded'
    || value === 'review-result.recorded'
    || value === 'human-review-decision.recorded'
    || value === 'artifact.published') return value
  integrity('M4 journal contains an unknown event type')
}

function parseEventPayload(json: string): M4EventPayload {
  const value = parseJson(json, 'stored M4 event payload is invalid')
  if (!isRecord(value) || typeof value.type !== 'string') {
    integrity('stored M4 event payload shape is invalid')
  }
  parseEventType(value.type)
  return value as unknown as M4EventPayload
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') integrity(`M4 database column ${key} is invalid`)
  return value
}

function integerColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    integrity(`M4 database column ${key} is invalid`)
  }
  return value
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    integrity(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]))
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function invalid(message: string): never {
  throw new InvestigationM4StoreError('invalid-request', message)
}

function notFound(message: string): never {
  throw new InvestigationM4StoreError('not-found', message)
}

function conflict(message: string): never {
  throw new InvestigationM4StoreError('conflict', message)
}

function limitExceeded(message: string): never {
  throw new InvestigationM4StoreError('limit-exceeded', message)
}

function integrity(message: string): never {
  throw new InvestigationM4StoreError('integrity-error', message)
}

function blocked(message: string): never {
  throw new InvestigationM4StoreError('publish-blocked', message)
}

function normalizeSqliteError(error: unknown): unknown {
  if (error instanceof InvestigationM4StoreError) return error
  if (error instanceof Error && error.message.includes('M4 journal is append-only')) {
    return new InvestigationM4StoreError('integrity-error', error.message)
  }
  return error
}
