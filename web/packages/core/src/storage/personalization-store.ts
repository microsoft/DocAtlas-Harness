import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  memoryVersionSetIssues,
  personalizationCommandIssues,
  personalizationCoreIssues,
  personalizationInspectIssues,
  type EditableMemoryDraft,
  type ForgetReceipt,
  type MemoryCandidate,
  type MemorySessionPolicy,
  type MemoryUse,
  type MemoryVersion,
  type PersonalizationCommandRequest,
  type PersonalizationCommandResult,
  type PersonalizationCoreValue,
  type PersonalizationDecision,
  type PersonalizationEffect,
  type PersonalizationExportDescriptor,
  type PersonalizationObservation,
  type PersonalizationInspectResult,
  type PersonalizationScope,
  type PersonalizationTaskContext,
  type PreferenceChoiceObservation,
  type PreferenceProbe,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { LEARNING_INVITATION_COOLDOWN_MS, MAX_LEARNING_MEMBERS, type LearningAnswerRef, type LearningChoiceInput,
  type LearningCommandIdentity, type LearningGuard, type LearningMember, type LearningMode, type LearningOffer,
  type LearningPrepareInput, type LearningReceipt, type LearningReviewInput, type LearningSettings, type LearningState,
  type LearningValue } from '../personalization/learning.js'

const PERSONALIZATION_SCHEMA_VERSION = 3
const DATABASE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const MAX_OBSERVATIONS = 50_000
const MAX_CANDIDATES = 10_000
const MAX_MEMORY_CHAINS = 5_000
const MAX_DECISIONS = 50_000
const MAX_USES = 50_000
const MAX_PROBES = 10_000
const MAX_DECISION_MEMORIES = 12
const EXPORT_TTL_MS = 10 * 60_000

export type PersonalizationStoreErrorCode =
  | 'invalid-request'
  | 'conflict'
  | 'not-found'
  | 'permission-denied'
  | 'limit-exceeded'
  | 'integrity-error'

export class PersonalizationStoreError extends Error {
  constructor(readonly code: PersonalizationStoreErrorCode, message: string) {
    super(message)
    this.name = 'PersonalizationStoreError'
  }
}

export interface CompilePersonalizationDecisionInput {
  profileId: string
  sessionId: string
  turn: number
  taskContext: PersonalizationTaskContext
  sourceScopeVersionId: string
  baselineDigest: string
  confirmedMemoryVersionIds?: readonly string[]
  /** Trusted application selection only; omitted preserves the legacy compiler behavior. */
  eligibleMemoryVersionIds?: readonly string[]
  maxMemories?: number
}

export interface PersonalizationExportAsset {
  descriptor: PersonalizationExportDescriptor
  bytes: Buffer
  mediaType: 'application/json' | 'text/markdown; charset=utf-8'
}

/** Trusted host fence only; never deserialize authority callbacks from a browser payload. */
export interface PersonalizationTransactionGuard {
  expectedProfileEpoch: number
  expectedPolicyVersion?: number
  assertCurrent(): void
}

export interface ProbeChoiceCommit {
  command: { idempotencyKey: string, requestHash: string }
  choice: PreferenceChoiceObservation
  observation: PersonalizationObservation
  candidate?: MemoryCandidate
}

export interface ProbeChoiceCommitResult {
  status: 'created' | 'replayed'
  choice: PreferenceChoiceObservation
  candidateId?: string
}

export interface StoredProbeChoice {
  command: { idempotencyKey: string, requestHash: string }
  choice: PreferenceChoiceObservation
  observation: PersonalizationObservation
  candidateId?: string
}

type LiveMemoryVersion = Exclude<MemoryVersion, { status: 'deleted' }>

interface StoredExportRow {
  descriptor: PersonalizationExportDescriptor
  path: string
}

/** Profile-scoped personalization persistence; never opens an Investigation database. */
export class PersonalizationStore {
  private readonly databases = new Map<string, DatabaseSync>()
  private closed = false

  private constructor(
    private readonly profilesRoot: string,
    private readonly backupsRoot: string,
    private readonly exportsRoot: string,
    private readonly now: () => Date,
  ) {}

  static async open(
    domainRoot: string,
    now: () => Date = () => new Date(),
  ): Promise<PersonalizationStore> {
    if (!isAbsolute(domainRoot)) {
      throw new PersonalizationStoreError('invalid-request', 'DocAtlas domain root must be absolute')
    }
    const profilesRoot = join(domainRoot, 'profiles')
    const backupsRoot = join(profilesRoot, 'backups')
    const exportsRoot = join(profilesRoot, 'exports')
    await mkdir(profilesRoot, { recursive: true, mode: DIRECTORY_MODE })
    await mkdir(backupsRoot, { recursive: true, mode: DIRECTORY_MODE })
    await mkdir(exportsRoot, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(domainRoot, DIRECTORY_MODE)
    await chmod(profilesRoot, DIRECTORY_MODE)
    await chmod(backupsRoot, DIRECTORY_MODE)
    await chmod(exportsRoot, DIRECTORY_MODE)
    return new PersonalizationStore(profilesRoot, backupsRoot, exportsRoot, now)
  }

  command(candidate: unknown, expectedProfileEpoch?: number, commandHash?: string, assertCurrent?: () => void): PersonalizationCommandResult {
    const request = structuredClone(parseCommandRequest(candidate))
    assertNoSecret(request)
    if (expectedProfileEpoch !== undefined && (!Number.isSafeInteger(expectedProfileEpoch) || expectedProfileEpoch < 0)) {
      throw new PersonalizationStoreError('invalid-request', 'Expected profile epoch must be a non-negative safe integer')
    }
    commandRequestHash(request, commandHash)
    if (assertCurrent !== undefined && (request.action !== 'review-candidate' || typeof assertCurrent !== 'function')) {
      throw new PersonalizationStoreError('invalid-request', 'A command authorization callback is supported only for explicit candidate review')
    }
    let authorizationFailure: { error: unknown } | undefined
    const authorizeReview = () => {
      if (!assertCurrent) return
      try { assertSynchronousAuthorization(assertCurrent) } catch (error) { authorizationFailure = { error }; throw error }
    }
    const database = this.profile(request.profileId)
    if (request.action === 'review-candidate' && request.candidateId.startsWith('learning-candidate:')) {
      throw new PersonalizationStoreError('invalid-request', 'Accumulated learning candidates require current group authorization through the learning review API')
    }
    if (
      request.action === 'forget'
      && request.target === 'profile'
      && request.mode === 'privacy-erasure'
    ) {
      try {
        return this.eraseProfile(database, request, expectedProfileEpoch, commandHash)
      } catch (error) {
        throw normalizeStoreError(error)
      }
    }
    let createdExportPath: string | undefined
    database.exec('BEGIN IMMEDIATE')
    try {
      authorizeReview()
      const concurrentReplay = authorizedCommandReplay(database, request, expectedProfileEpoch, commandHash)
      if (concurrentReplay !== undefined) {
        authorizeReview()
        database.exec('COMMIT')
        return concurrentReplay
      }
      authorizeReview()
      const handled = this.applyCommand(database, request)
      createdExportPath = handled.createdExportPath
      const result = handled.result
      assertCommandResult(result, request)
      insertIdempotency(database, request, result, commandHash)
      appendJournal(database, {
        eventId: deterministicId('event', request.profileId, request.idempotencyKey),
        aggregateType: commandAggregateType(request),
        aggregateId: commandAggregateId(request),
        aggregateVersion: commandAggregateVersion(result),
        eventType: `personalization-command.${request.action}`,
        actorKind: request.actor.kind,
        actorId: request.actor.actorId,
        occurredAt: this.timestamp(),
        idempotencyKey: request.idempotencyKey,
        payload: result,
      })
      bumpLedgerRevision(database)
      authorizeReview()
      database.exec('COMMIT')
      return result
    } catch (error) {
      rollback(database)
      if (createdExportPath !== undefined) safeUnlink(createdExportPath)
      if (authorizationFailure && error === authorizationFailure.error) throw error
      throw normalizeStoreError(error)
    }
  }

  recordObservation(candidate: unknown): PersonalizationObservation {
    const value = parseCore(candidate, 'personalization-observation')
    assertNoSecret(value)
    const database = this.profile(value.profileId)
    const existing = readJsonRow<PersonalizationObservation>(
      database,
      'SELECT record_json FROM personalization_observations WHERE observation_id = ?',
      value.observationId,
    )
    if (existing !== undefined) return exactReplay(existing, value, 'observation')
    const context = { sessionPolicies: listSessionPolicies(database) }
    assertCore(value, context)
    enforceCount(database, 'personalization_observations', MAX_OBSERVATIONS)
    transaction(database, () => {
      database.prepare(`
        INSERT INTO personalization_observations(
          observation_id, session_id, consent, lineage_key, record_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        value.observationId,
        value.sessionId,
        value.consent.retention,
        value.lineageKey,
        canonicalJson(value),
      )
      appendCoreEvent(database, value, 'observation.recorded', value.observationId, 1)
      bumpLedgerRevision(database)
    })
    return value
  }

  recordCandidate(candidate: unknown): MemoryCandidate {
    const value = parseCore(candidate, 'memory-candidate')
    if (value.candidateId.startsWith('learning-candidate:')) throw new PersonalizationStoreError('invalid-request', 'Learning candidates are derived only by the controlled accumulation transaction')
    assertNoSecret(value)
    if (value.decision !== 'pending' && value.decision !== 'needs-review') {
      throw new PersonalizationStoreError(
        'invalid-request',
        'new candidates must be pending or held for explicit review',
      )
    }
    const database = this.profile(value.profileId)
    const existing = readJsonRow<MemoryCandidate>(
      database,
      'SELECT record_json FROM personalization_candidates WHERE candidate_id = ?',
      value.candidateId,
    )
    if (existing !== undefined) return exactReplay(existing, value, 'candidate')
    assertCore(value, { observations: listObservations(database) })
    enforceCount(database, 'personalization_candidates', MAX_CANDIDATES)
    transaction(database, () => {
      database.prepare(`
        INSERT INTO personalization_candidates(candidate_id, version, decision, record_json)
        VALUES (?, ?, ?, ?)
      `).run(value.candidateId, value.version, value.decision, canonicalJson(value))
      appendCoreEvent(database, value, 'candidate.recorded', value.candidateId, value.version)
      bumpLedgerRevision(database)
    })
    return value
  }

  recordMemoryUse(candidate: unknown): MemoryUse {
    const value = parseCore(candidate, 'memory-use')
    assertNoSecret(value)
    const database = this.profile(value.profileId)
    const existing = readJsonRow<MemoryUse>(
      database,
      'SELECT record_json FROM personalization_memory_uses WHERE memory_use_id = ?',
      value.memoryUseId,
    )
    if (existing !== undefined) return exactReplay(existing, value, 'MemoryUse')
    const decision = listDecisions(database).find(item => item.decisionId === value.decisionId)
    assertCore(value, {
      decisions: decision === undefined ? [] : [decision],
      memories: listMemoryVersions(database),
    })
    const current = new Map(listCurrentMemories(database).map(memory => [
      memory.memoryVersionId,
      memory,
    ]))
    if (
      decision === undefined
      || decision.memoryVersionIds.some(id => current.get(id)?.status !== 'active')
      || readSessionPolicy(database, value.sessionId)?.useExisting !== true
    ) {
      throw new PersonalizationStoreError(
        'conflict',
        'personalization decision is no longer admitted for use',
      )
    }
    enforceCount(database, 'personalization_memory_uses', MAX_USES)
    transaction(database, () => {
      database.prepare(`
        INSERT INTO personalization_memory_uses(memory_use_id, decision_id, record_json)
        VALUES (?, ?, ?)
      `).run(value.memoryUseId, value.decisionId, canonicalJson(value))
      appendCoreEvent(database, value, 'memory-use.recorded', value.memoryUseId, 1)
      bumpLedgerRevision(database)
    })
    return value
  }

  recordProbe(candidate: unknown, transactionGuard?: PersonalizationTransactionGuard): PreferenceProbe {
    const value = structuredClone(parseCore(candidate, 'preference-probe'))
    if (value.probeId.startsWith('learning-probe:')) throw new PersonalizationStoreError('invalid-request', 'Learning comparisons require their original Answer reference and learning receipt')
    const guard = transactionGuard === undefined ? undefined : copyTransactionGuard(transactionGuard)
    assertNoSecret(value)
    const database = this.profile(value.profileId)
    try {
      return transaction(database, () => {
        if (guard) assertTransactionGuard(database, value.sessionId, guard, false)
        const existing = readExactProbe(database, value.profileId, value.probeId)
        if (existing !== undefined) {
          const replay = exactReplay(existing, value, 'PreferenceProbe')
          if (guard) assertTransactionGuard(database, value.sessionId, guard, false)
          return replay
        }
        if (guard) assertTransactionGuard(database, value.sessionId, guard, true)
        if (value.trigger !== 'user-requested' && value.investigationId !== undefined && readRow(database,
          'SELECT probe_id FROM personalization_probes WHERE automatic = 1 AND investigation_id = ? LIMIT 1', value.investigationId)) {
          throw new PersonalizationStoreError('limit-exceeded', 'only one automatic preference probe is allowed per Investigation')
        }
        if (value.trigger !== 'user-requested' && value.investigationId !== undefined && learningOffersRaw(database).some(offer => offer.original.investigationId === value.investigationId)) {
          throw new PersonalizationStoreError('limit-exceeded', 'The Investigation automatic-calibration slot is already reserved by a learning invitation')
        }
        assertCore(value)
        enforceCount(database, 'personalization_probes', MAX_PROBES)
        database.prepare(`
          INSERT INTO personalization_probes(
            probe_id, investigation_id, automatic, record_json
          ) VALUES (?, ?, ?, ?)
        `).run(
          value.probeId,
          value.investigationId ?? null,
          value.trigger === 'user-requested' ? 0 : 1,
          canonicalJson(value),
        )
        appendCoreEvent(database, value, 'preference-probe.recorded', value.probeId, 1)
        bumpLedgerRevision(database)
        if (guard) assertTransactionGuard(database, value.sessionId, guard, true)
        return value
      })
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new PersonalizationStoreError(
          'limit-exceeded',
          'only one automatic preference probe is allowed per Investigation',
        )
      }
      throw error
    }
  }

  recordPreferenceChoice(candidate: unknown): PreferenceChoiceObservation {
    const value = parseCore(candidate, 'preference-choice-observation')
    if (value.probeId.startsWith('learning-probe:')) throw new PersonalizationStoreError('invalid-request', 'Raw choices cannot bypass accumulated learning authority')
    assertNoSecret(value)
    const database = this.profile(value.profileId)
    if (readProbeChoiceReceipt(database, value.profileId, value.probeId) !== undefined) {
      const existing = readExactChoice(database, value.profileId, value.choiceObservationId)
      if (existing !== undefined) return exactReplay(existing, value, 'PreferenceChoice')
      throw new PersonalizationStoreError('conflict', 'A controlled probe already has its committed choice')
    }
    const existing = readJsonRow<PreferenceChoiceObservation>(
      database,
      'SELECT record_json FROM personalization_choices WHERE choice_id = ?',
      value.choiceObservationId,
    )
    if (existing !== undefined) return exactReplay(existing, value, 'PreferenceChoice')
    assertCore(value, { probes: listProbes(database) })
    transaction(database, () => {
      if (readProbeChoiceReceipt(database, value.profileId, value.probeId) !== undefined) {
        throw new PersonalizationStoreError('conflict', 'A controlled probe already has its committed choice')
      }
      database.prepare(`
        INSERT INTO personalization_choices(choice_id, probe_id, record_json)
        VALUES (?, ?, ?)
      `).run(value.choiceObservationId, value.probeId, canonicalJson(value))
      appendCoreEvent(database, value, 'preference-choice.recorded', value.choiceObservationId, 1)
      bumpLedgerRevision(database)
    })
    return value
  }

  /** One governed write, never a candidate promotion or a MemoryUse. */
  commitProbeChoice(input: ProbeChoiceCommit, transactionGuard: PersonalizationTransactionGuard): ProbeChoiceCommitResult {
    const value = parseProbeChoiceCommit(input), guard = copyTransactionGuard(transactionGuard)
    if (value.choice.probeId.startsWith('learning-probe:')) throw new PersonalizationStoreError('invalid-request', 'The single-choice API cannot reinterpret an accumulated learning Probe')
    const database = this.profile(value.choice.profileId), inputHash = sha256(canonicalJson(value))
    return transaction(database, () => {
      assertTransactionGuard(database, value.choice.sessionId, guard, false)
      const probe = readExactProbe(database, value.choice.profileId, value.choice.probeId)
      if (!probe) throw new PersonalizationStoreError('not-found', 'The exact original preference probe is unavailable')
      const receipt = readProbeChoiceReceipt(database, value.choice.profileId, value.choice.probeId)
      const keyed = readRow(database, 'SELECT aggregate_id FROM personalization_journal WHERE event_id = ?', probeChoiceEventId(value.choice.profileId, value.command.idempotencyKey))
      if (receipt !== undefined) {
        if (receipt.inputHash !== inputHash || canonicalJson(receipt.command) !== canonicalJson(value.command)) {
          throw new PersonalizationStoreError('conflict', 'The controlled probe choice already contains a different complete request')
        }
        const saved = resolveProbeChoiceReceipt(database, receipt)
        assertTransactionGuard(database, value.choice.sessionId, guard, false)
        return { status: 'replayed', choice: saved.choice, ...(saved.candidateId ? { candidateId: saved.candidateId } : {}) }
      }
      if (keyed || readRow(database, 'SELECT choice_id FROM personalization_choices WHERE probe_id = ? LIMIT 1', value.choice.probeId)
        || readRow(database, 'SELECT choice_id FROM personalization_choices WHERE choice_id = ?', value.choice.choiceObservationId)
        || readRow(database, 'SELECT observation_id FROM personalization_observations WHERE observation_id = ?', value.observation.observationId)
        || value.candidate && readRow(database, 'SELECT candidate_id FROM personalization_candidates WHERE candidate_id = ?', value.candidate.candidateId)) {
        throw new PersonalizationStoreError('conflict', 'The controlled choice identity or probe is already occupied; raw partial writes are not receipts')
      }
      assertTransactionGuard(database, value.choice.sessionId, guard, true)
      assertControlledChoice(value, probe)
      enforceCount(database, 'personalization_choices', MAX_OBSERVATIONS)
      enforceCount(database, 'personalization_observations', MAX_OBSERVATIONS)
      if (value.candidate) enforceCount(database, 'personalization_candidates', MAX_CANDIDATES)
      database.prepare('INSERT INTO personalization_choices(choice_id, probe_id, record_json) VALUES (?, ?, ?)')
        .run(value.choice.choiceObservationId, value.choice.probeId, canonicalJson(value.choice))
      appendCoreEvent(database, value.choice, 'preference-choice.recorded', value.choice.choiceObservationId, 1)
      insertObservation(database, value.observation)
      appendCoreEvent(database, value.observation, 'observation.recorded', value.observation.observationId, 1)
      if (value.candidate) {
        database.prepare('INSERT INTO personalization_candidates(candidate_id, version, decision, record_json) VALUES (?, ?, ?, ?)')
          .run(value.candidate.candidateId, value.candidate.version, value.candidate.decision, canonicalJson(value.candidate))
        appendCoreEvent(database, value.candidate, 'candidate.recorded', value.candidate.candidateId, 1)
      }
      const payload: ProbeChoiceReceipt = { schemaVersion: 1, receiptType: 'controlled-probe-choice', profileId: value.choice.profileId,
        probeId: probe.probeId, choiceObservationId: value.choice.choiceObservationId, observationId: value.observation.observationId,
        ...(value.candidate ? { candidateId: value.candidate.candidateId } : {}), command: value.command, inputHash }
      appendJournal(database, { eventId: probeChoiceEventId(value.choice.profileId, value.command.idempotencyKey), aggregateType: 'preference-probe',
        aggregateId: probe.probeId, aggregateVersion: 1, eventType: 'preference-choice.committed', actorKind: value.observation.observedActor.kind,
        actorId: value.observation.observedActor.actorId, occurredAt: value.choice.occurredAt, idempotencyKey: value.command.idempotencyKey, payload })
      bumpLedgerRevision(database)
      assertTransactionGuard(database, value.choice.sessionId, guard, true)
      return { status: 'created', choice: value.choice, ...(value.candidate ? { candidateId: value.candidate.candidateId } : {}) }
    })
  }

  learningSettings(profileId: string): LearningSettings {
    const database = this.existingProfile(profileId)
    return database ? learningSettingsRaw(database, profileId) : { version: 0, enabled: false }
  }

  setLearningSettings(profileId: string, input: { command: LearningCommandIdentity, expectedVersion: number, enabled: boolean }, guardCandidate: LearningGuard): LearningReceipt {
    const value = structuredClone(input), guard = copyLearningGuard(guardCandidate)
    validateLearningCommand(value.command)
    if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0 || typeof value.enabled !== 'boolean') throw new PersonalizationStoreError('invalid-request', 'Invalid learning invitation setting')
    const database = this.profile(profileId)
    return transaction(database, () => {
      assertTransactionGuard(database, value.command.conversationId, guard, false)
      const replay = learningReplay(database, profileId, value.command, 'settings', guard.expectedProfileEpoch)
      if (replay) { assertLearningReplayInput(replay, value); assertTransactionGuard(database, value.command.conversationId, guard, false); return replay.receipt }
      const current = learningSettingsRaw(database, profileId)
      if (current.version !== value.expectedVersion) throw new PersonalizationStoreError('conflict', 'Learning invitation settings version changed')
      if (current.version >= Number.MAX_SAFE_INTEGER) throw new PersonalizationStoreError('limit-exceeded', 'Learning settings version is exhausted')
      const settings = { version: current.version + 1, enabled: value.enabled }, committedAt = this.timestamp()
      const receipt = makeLearningReceipt(profileId, guard.expectedProfileEpoch, value.command, 'settings', committedAt, `learning-settings:${sha256(profileId).slice(0, 32)}`, settings.version)
      appendLearningEvent(database, 'learning.settings.recorded', receipt.targetId, settings.version, committedAt, value.command.actorId,
        { schemaVersion: 1, profileId, profileEpoch: guard.expectedProfileEpoch, settings, operationId: receipt.operationId }, receipt.operationId)
      appendLearningReceipt(database, { receipt, inputHash: sha256(canonicalJson(value)) })
      bumpLedgerRevision(database); assertTransactionGuard(database, value.command.conversationId, guard, false)
      return receipt
    })
  }

  reserveLearningOffer(profileId: string, input: { original: LearningAnswerRef, completedSubmissions: number }, guardCandidate: LearningGuard): LearningOffer | undefined {
    const value = structuredClone(input), guard = copyLearningGuard(guardCandidate)
    validateLearningOriginal(value.original)
    if (!Number.isSafeInteger(value.completedSubmissions) || value.completedSubmissions < 0) throw new PersonalizationStoreError('invalid-request', 'Invalid completed submission count')
    const database = this.existingProfile(profileId)
    if (!database) { assertLearningRead(undefined, guard); return undefined }
    return transaction(database, () => {
      assertTransactionGuard(database, value.original.conversationId, guard, false)
      if (value.original.profileEpoch !== guard.expectedProfileEpoch || !learningSettingsRaw(database, profileId).enabled || value.completedSubmissions < 3) return undefined
      const policy = readSessionPolicy(database, value.original.conversationId)
      if (!policy?.contributeToFuture) return undefined
      assertTransactionGuard(database, value.original.conversationId, guard, true)
      if (!authorizeLearningOrigins(guard, [value.original])) return undefined
      const state = learningStateRaw(database, profileId, value.original.workspaceId, value.original.mode, guard)
      if (state.status !== 'collecting' && state.status !== 'conflicted') return undefined
      const offers = learningOffersRaw(database), previous = offers.find(offer => offer.original.investigationId === value.original.investigationId)
      if (previous || readRow(database, 'SELECT probe_id FROM personalization_probes WHERE automatic=1 AND investigation_id=?', value.original.investigationId)) return undefined
      const now = this.now().getTime(), latest = offers.reduce((maximum, offer) => Math.max(maximum, Date.parse(offer.createdAt)), 0)
      if (latest && now - latest < LEARNING_INVITATION_COOLDOWN_MS) return undefined
      if (offers.length >= MAX_PROBES) throw new PersonalizationStoreError('limit-exceeded', 'Learning invitation retention limit reached')
      const occurredAt = new Date(now).toISOString()
      const offer: LearningOffer = { offerId: `learning-offer:${sha256(canonicalJson([profileId, guard.expectedProfileEpoch, value.original.investigationId]))}`,
        profileId, profileEpoch: guard.expectedProfileEpoch, version: 1, status: 'offered', original: value.original, createdAt: occurredAt, updatedAt: occurredAt }
      appendLearningEvent(database, 'learning.offer.recorded', offer.offerId, 1, occurredAt, 'rule:consented-learning', { schemaVersion: 1, offer })
      bumpLedgerRevision(database)
      assertTransactionGuard(database, value.original.conversationId, guard, true)
      if (!authorizeLearningOrigins(guard, [value.original]) || !learningSettingsRaw(database, profileId).enabled) throw new PersonalizationStoreError('permission-denied', 'Learning invitation authority changed')
      return offer
    })
  }

  learningOffers(profileId: string, workspaceId: string, conversationId: string, guardCandidate: LearningGuard): LearningOffer[] {
    const guard = copyLearningGuard(guardCandidate), database = this.existingProfile(profileId)
    assertLearningRead(database, guard)
    if (!database) return []
    const offers = learningOffersRaw(database).filter(offer => offer.original.workspaceId === workspaceId && offer.original.conversationId === conversationId)
    if (offers.length > MAX_LEARNING_MEMBERS || !authorizeLearningOrigins(guard, offers.map(offer => offer.original))) return []
    assertLearningRead(database, guard); return offers
  }

  dismissLearningOffer(profileId: string, input: { offerId: string, expectedOfferVersion: number, command: LearningCommandIdentity }, guardCandidate: LearningGuard): LearningReceipt {
    const value = structuredClone(input), guard = copyLearningGuard(guardCandidate)
    validateLearningCommand(value.command)
    const database = this.profile(profileId)
    return transaction(database, () => {
      assertTransactionGuard(database, value.command.conversationId, guard, false)
      const replay = learningReplay(database, profileId, value.command, 'dismiss', guard.expectedProfileEpoch)
      if (replay) { assertLearningReplayInput(replay, value); authorizeLearningReceipt(database, replay, guard); return replay.receipt }
      const previous = learningOffersRaw(database).find(offer => offer.offerId === value.offerId)
      if (!previous || previous.original.workspaceId !== value.command.workspaceId || previous.original.conversationId !== value.command.conversationId) throw new PersonalizationStoreError('not-found', 'Original learning invitation is unavailable')
      if (previous.version !== value.expectedOfferVersion || previous.status !== 'offered') throw new PersonalizationStoreError('conflict', 'Learning invitation version changed')
      if (!authorizeLearningOrigins(guard, [previous.original])) throw new PersonalizationStoreError('permission-denied', 'Original invitation source is unavailable')
      const committedAt = this.timestamp(), offer: LearningOffer = { ...previous, version: previous.version + 1, status: 'dismissed', updatedAt: committedAt }
      const receipt = makeLearningReceipt(profileId, guard.expectedProfileEpoch, value.command, 'dismiss', committedAt, offer.offerId, offer.version)
      appendLearningEvent(database, 'learning.offer.recorded', offer.offerId, offer.version, committedAt, value.command.actorId, { schemaVersion: 1, offer, operationId: receipt.operationId }, receipt.operationId)
      appendLearningReceipt(database, { receipt, original: offer.original, inputHash: sha256(canonicalJson(value)) }); bumpLedgerRevision(database)
      assertTransactionGuard(database, value.command.conversationId, guard, false)
      if (!authorizeLearningOrigins(guard, [offer.original])) throw new PersonalizationStoreError('permission-denied', 'Original invitation source changed')
      return receipt
    })
  }

  prepareLearningProbe(profileId: string, input: LearningPrepareInput, guardCandidate: LearningGuard): LearningReceipt {
    const value = structuredClone(input), guard = copyLearningGuard(guardCandidate)
    validateLearningCommand(value.command); validateLearningOriginal(value.original)
    const probe = parseCore(value.probe, 'preference-probe')
    assertLearningProbeOriginal(probe, value.original, profileId, guard.expectedProfileEpoch)
    assertLearningCommandOrigin(value.command, value.original)
    const database = this.profile(profileId)
    return transaction(database, () => {
      assertTransactionGuard(database, value.command.conversationId, guard, false)
      const replay = learningReplay(database, profileId, value.command, 'prepare', guard.expectedProfileEpoch)
      if (replay) { assertLearningReplayInput(replay, value); authorizeLearningReceipt(database, replay, guard); return replay.receipt }
      assertTransactionGuard(database, value.command.conversationId, guard, true)
      if (!authorizeLearningOrigins(guard, [value.original])) throw new PersonalizationStoreError('permission-denied', 'Original learning Answer is unavailable')
      const existing = readExactProbe(database, profileId, probe.probeId)
      if (existing) {
        exactReplay(existing, probe, 'Learning Probe')
        const original = learningPreparedOriginal(database, profileId, probe.probeId)
        if (!original || canonicalJson(original) !== canonicalJson(value.original)) throw new PersonalizationStoreError('integrity-error', 'Learning Probe lost its original Answer provenance')
      } else {
        enforceCount(database, 'personalization_probes', MAX_PROBES)
        database.prepare('INSERT INTO personalization_probes(probe_id,investigation_id,automatic,record_json) VALUES (?,?,0,?)').run(probe.probeId, probe.investigationId ?? null, canonicalJson(probe))
        appendCoreEvent(database, probe, 'preference-probe.recorded', probe.probeId, 1)
      }
      const receipt = makeLearningReceipt(profileId, guard.expectedProfileEpoch, value.command, 'prepare', this.timestamp(), probe.probeId, 1)
      appendLearningReceipt(database, { receipt, original: value.original, inputHash: sha256(canonicalJson(value)) }); bumpLedgerRevision(database)
      assertTransactionGuard(database, value.command.conversationId, guard, true)
      if (!authorizeLearningOrigins(guard, [value.original])) throw new PersonalizationStoreError('permission-denied', 'Learning Answer authority changed')
      return receipt
    })
  }

  commitLearningChoice(input: LearningChoiceInput, guardCandidate: LearningGuard): LearningReceipt {
    const value = structuredClone(input), guard = copyLearningGuard(guardCandidate)
    validateLearningCommand(value.command); validateLearningOriginal(value.original)
    const parsed = parseProbeChoiceCommit({ command: { idempotencyKey: value.command.idempotencyKey, requestHash: value.command.requestHash }, choice: value.choice, observation: value.observation })
    value.choice = parsed.choice; value.observation = parsed.observation
    assertLearningCommandOrigin(value.command, value.original)
    const profileId = value.choice.profileId, database = this.profile(profileId), inputHash = sha256(canonicalJson(value))
    return transaction(database, () => {
      assertTransactionGuard(database, value.command.conversationId, guard, false)
      const replay = learningReplay(database, profileId, value.command, 'choice', guard.expectedProfileEpoch)
      if (replay) {
        if (replay.inputHash !== inputHash) throw new PersonalizationStoreError('conflict', 'Original learning choice content changed')
        authorizeLearningReceipt(database, replay, guard); return replay.receipt
      }
      assertTransactionGuard(database, value.command.conversationId, guard, true)
      const probe = readExactProbe(database, profileId, value.choice.probeId), original = learningPreparedOriginal(database, profileId, value.choice.probeId)
      if (!probe || !original || canonicalJson(original) !== canonicalJson(value.original)) throw new PersonalizationStoreError('integrity-error', 'Learning comparison requires its exact prepared original')
      assertLearningProbeOriginal(probe, original, profileId, guard.expectedProfileEpoch)
      assertControlledChoice(parsed, probe)
      if (value.observation.lineageKey !== original.investigationId || value.observation.observedActor.actorId !== value.command.actorId || !['turn', 'workspace'].includes(value.choice.scopeIntent)) throw new PersonalizationStoreError('invalid-request', 'Learning choices require exact human Investigation lineage and explicit scope')
      if (!authorizeLearningOrigins(guard, [original])) throw new PersonalizationStoreError('permission-denied', 'Original learning Answer is unavailable')
      if (readRow(database, 'SELECT choice_id FROM personalization_choices WHERE probe_id=?', probe.probeId)) throw new PersonalizationStoreError('conflict', 'A learning comparison already has its one durable choice')
      enforceCount(database, 'personalization_choices', MAX_OBSERVATIONS); enforceCount(database, 'personalization_observations', MAX_OBSERVATIONS)
      database.prepare('INSERT INTO personalization_choices(choice_id,probe_id,record_json) VALUES (?,?,?)').run(value.choice.choiceObservationId, probe.probeId, canonicalJson(value.choice))
      appendCoreEvent(database, value.choice, 'preference-choice.recorded', value.choice.choiceObservationId, 1)
      insertObservation(database, value.observation); appendCoreEvent(database, value.observation, 'observation.recorded', value.observation.observationId, 1)
      const receipt = makeLearningReceipt(profileId, guard.expectedProfileEpoch, value.command, 'choice', value.choice.occurredAt, value.choice.choiceObservationId, 1)
      const pending: LearningStoredReceipt = { receipt, original, choiceObservationId: value.choice.choiceObservationId, observationId: value.observation.observationId, inputHash }
      const eligible = value.choice.scopeIntent === 'workspace' && value.choice.consent.retention === 'eligible'
      pending.eligible = eligible
      if (eligible) {
        receipt.groupId = learningGroupId(profileId, guard.expectedProfileEpoch, original.workspaceId, original.mode)
        const state = learningStateRaw(database, profileId, original.workspaceId, original.mode, guard, pending)
        const effectValue: LearningValue | undefined = state.independentCounts && state.independentCounts['conclusion-first'] >= 3 && state.independentCounts['evidence-first'] === 0 ? 'conclusion-first'
          : state.independentCounts && state.independentCounts['evidence-first'] >= 3 && state.independentCounts['conclusion-first'] === 0 ? 'evidence-first' : undefined
        if (state.status === 'collecting' && effectValue) {
          const observations = state.members.map(member => member.observationId)
          const candidate: MemoryCandidate = { schemaVersion: 1, recordType: 'memory-candidate', candidateId: learningCandidateId(state.groupId), profileId, version: 1,
            proposedMemoryType: 'presentation-preference', proposedEffect: { key: 'answer-order', value: effectValue }, proposedScope: { kind: 'workspace', profileId, workspaceId: original.workspaceId },
            observationIds: observations, independentLineageCount: new Set(state.members.map(member => member.original.investigationId)).size, counterObservationIds: [],
            formation: 'preference-probe', risk: 'low', sensitivity: 'ordinary', decision: 'pending', rationaleCode: 'controlled-probe-choice', createdAt: value.choice.occurredAt }
          assertCore(candidate, { observations: listObservations(database) }); enforceCount(database, 'personalization_candidates', MAX_CANDIDATES)
          database.prepare('INSERT INTO personalization_candidates(candidate_id,version,decision,record_json) VALUES (?,1,?,?)').run(candidate.candidateId, candidate.decision, canonicalJson(candidate))
          appendCoreEvent(database, candidate, 'candidate.recorded', candidate.candidateId, 1); receipt.candidateId = candidate.candidateId
        }
      }
      appendLearningReceipt(database, pending); bumpLedgerRevision(database)
      assertTransactionGuard(database, value.command.conversationId, guard, true)
      if (!authorizeLearningOrigins(guard, [original])) throw new PersonalizationStoreError('permission-denied', 'Learning Answer authority changed')
      if (receipt.candidateId && learningStateRaw(database, profileId, original.workspaceId, original.mode, guard).status !== 'pending') throw new PersonalizationStoreError('permission-denied', 'Accumulation authority changed before candidate commit')
      return receipt
    })
  }

  learningState(profileId: string, workspaceId: string, mode: LearningMode, guardCandidate: LearningGuard): LearningState {
    const guard = copyLearningGuard(guardCandidate), database = this.existingProfile(profileId)
    assertLearningRead(database, guard)
    if (!opaqueId(workspaceId) || !['explore', 'verify', 'publish'].includes(mode)) throw new PersonalizationStoreError('invalid-request', 'Invalid learning group identity')
    const state = learningStateRaw(database, profileId, workspaceId, mode, guard)
    assertLearningRead(database, guard); return state
  }

  learningReceipt(profileId: string, operationId: string, guardCandidate: LearningGuard): LearningReceipt | undefined {
    const guard = copyLearningGuard(guardCandidate), database = this.existingProfile(profileId)
    assertLearningRead(database, guard)
    if (!database) return undefined
    const stored = readLearningReceipt(database, profileId, operationId)
    if (stored) authorizeLearningReceipt(database, stored, guard)
    assertLearningRead(database, guard); return stored?.receipt
  }

  learningProbeChoice(profileId: string, probeId: string, guardCandidate: LearningGuard): { receipt: LearningReceipt, choice: PreferenceChoiceObservation } | undefined {
    const guard = copyLearningGuard(guardCandidate), database = this.existingProfile(profileId)
    assertLearningRead(database, guard)
    if (!database) return undefined
    const rows = readRows(database, "SELECT * FROM personalization_journal WHERE event_type='learning.command.committed' AND json_extract(payload_json,'$.receipt.action')='choice' AND json_extract(payload_json,'$.original.probeId')=? LIMIT 2", probeId)
    if (!rows.length) return undefined
    if (rows.length !== 1) throw new PersonalizationStoreError('integrity-error', 'Learning Probe has more than one committed choice')
    const stored = verifyLearningReceiptRow(database, profileId, rows[0]!)
    authorizeLearningReceipt(database, stored, guard)
    if (stored.original && learningStateRaw(database, profileId, stored.original.workspaceId, stored.original.mode, guard).suppression === 'forgotten') throw new PersonalizationStoreError('permission-denied', 'Forgotten learning provenance cannot be reopened as current feedback')
    const choice = readExactChoice(database, profileId, stored.choiceObservationId!)
    if (!choice) throw new PersonalizationStoreError('integrity-error', 'Learning choice is missing')
    assertLearningRead(database, guard); return { receipt: stored.receipt, choice }
  }

  reviewLearningCandidate(profileId: string, input: LearningReviewInput, guardCandidate: LearningGuard): LearningReceipt {
    const value = structuredClone(input), guard = copyLearningGuard(guardCandidate)
    validateLearningCommand(value.command)
    const database = this.profile(profileId)
    return transaction(database, () => {
      assertTransactionGuard(database, value.command.conversationId, guard, false)
      const replay = learningReplay(database, profileId, value.command, 'review', guard.expectedProfileEpoch)
      if (replay) { assertLearningReplayInput(replay, value); authorizeLearningReceipt(database, replay, guard); return replay.receipt }
      const mode = (['explore', 'verify', 'publish'] as const).find(item => learningGroupId(profileId, guard.expectedProfileEpoch, value.command.workspaceId, item) === value.groupId)
      if (!mode || value.candidateId !== learningCandidateId(value.groupId)) throw new PersonalizationStoreError('invalid-request', 'Learning candidate does not belong to this group')
      const state = learningStateRaw(database, profileId, value.command.workspaceId, mode, guard)
      if (state.status === 'unavailable') throw new PersonalizationStoreError('permission-denied', 'Complete learning group is unavailable')
      if (!state.candidate || state.groupDigest !== value.expectedGroupDigest || state.candidate.version !== value.expectedCandidateVersion) throw new PersonalizationStoreError('conflict', 'Learning group or candidate changed before confirmation')
      if (value.decision === 'accept' && state.status !== 'pending') throw new PersonalizationStoreError('conflict', 'Only an unopposed current learning candidate can be confirmed')
      if (!['accept', 'reject'].includes(value.decision)) throw new PersonalizationStoreError('invalid-request', 'Invalid learning candidate decision')
      const request: Extract<PersonalizationCommandRequest, { action: 'review-candidate' }> = { schemaVersion: 1, requestType: 'personalization-command', profileId,
        sessionId: value.command.conversationId, actor: { kind: 'user', actorId: value.command.actorId }, idempotencyKey: learningOperationId(value.command), action: 'review-candidate',
        candidateId: value.candidateId, expectedVersion: value.expectedCandidateVersion, decision: value.decision }
      const result = this.reviewCandidate(database, request)
      if (result.action !== 'review-candidate') throw new PersonalizationStoreError('integrity-error', 'Unexpected learning review result')
      insertIdempotency(database, request, result, value.command.requestHash)
      appendJournal(database, { eventId: deterministicId('event', profileId, request.idempotencyKey), aggregateType: 'memory-candidate', aggregateId: value.candidateId,
        aggregateVersion: result.candidate.version, eventType: 'personalization-command.review-candidate', actorKind: 'user', actorId: value.command.actorId,
        occurredAt: this.timestamp(), idempotencyKey: request.idempotencyKey, payload: result })
      const receipt = makeLearningReceipt(profileId, guard.expectedProfileEpoch, value.command, 'review', this.timestamp(), value.candidateId, result.candidate.version)
      receipt.groupId = value.groupId; receipt.candidateId = value.candidateId; receipt.memoryVersionId = result.memoryVersion?.memoryVersionId ?? null
      appendLearningReceipt(database, { receipt, review: value, inputHash: sha256(canonicalJson(value)) }); bumpLedgerRevision(database)
      assertTransactionGuard(database, value.command.conversationId, guard, false)
      if (!authorizeLearningOrigins(guard, state.members.map(member => member.original))) throw new PersonalizationStoreError('permission-denied', 'Original learning sources changed before confirmation')
      return receipt
    })
  }

  probe(profileId: string, probeId: string): PreferenceProbe | undefined {
    const database = this.existingProfile(profileId)
    return database ? readExactProbe(database, profileId, probeId) : undefined
  }

  preferenceChoice(profileId: string, choiceObservationId: string): PreferenceChoiceObservation | undefined {
    const database = this.existingProfile(profileId)
    return database ? readExactChoice(database, profileId, choiceObservationId) : undefined
  }

  observation(profileId: string, observationId: string): PersonalizationObservation | undefined {
    const database = this.existingProfile(profileId)
    return database ? readExactObservation(database, profileId, observationId) : undefined
  }

  /** Only a complete controlled receipt; legacy/raw partial rows are never inferred as one. */
  probeChoice(profileId: string, probeId: string): StoredProbeChoice | undefined {
    const database = this.existingProfile(profileId)
    if (!database) return undefined
    const receipt = readProbeChoiceReceipt(database, profileId, probeId)
    return receipt ? resolveProbeChoiceReceipt(database, receipt) : undefined
  }

  /** Missing profiles are an empty read, not permission to recreate erased history. */
  peekProfile(profileId: string, sessionId: string): { profileEpoch: number, sessionPolicy?: MemorySessionPolicy } {
    if (!opaqueId(sessionId)) throw new PersonalizationStoreError('invalid-request', 'Session identity is invalid')
    const database = this.existingProfile(profileId)
    if (!database) return { profileEpoch: 0 }
    const sessionPolicy = readSessionPolicy(database, sessionId)
    return { profileEpoch: metadata(database).profileEpoch, ...(sessionPolicy ? { sessionPolicy: structuredClone(sessionPolicy) } : {}) }
  }

  compileDecision(
    input: CompilePersonalizationDecisionInput,
  ): PersonalizationDecision | undefined {
    if (!Number.isInteger(input.turn) || input.turn < 0) {
      throw new PersonalizationStoreError('invalid-request', 'decision turn must be non-negative')
    }
    if (!/^[a-f0-9]{64}$/.test(input.baselineDigest)) {
      throw new PersonalizationStoreError('invalid-request', 'Fact Trace baseline digest is invalid')
    }
    const maxMemories = input.maxMemories ?? MAX_DECISION_MEMORIES
    if (!Number.isInteger(maxMemories) || maxMemories < 1 || maxMemories > MAX_DECISION_MEMORIES) {
      throw new PersonalizationStoreError('limit-exceeded', 'decision memory bound is invalid')
    }
    const database = this.profile(input.profileId)
    const policy = readSessionPolicy(database, input.sessionId)
    if (policy?.useExisting !== true) return undefined
    const confirmed = new Set(input.confirmedMemoryVersionIds ?? [])
    const selected = input.eligibleMemoryVersionIds
    if (selected !== undefined && (!Array.isArray(selected) || selected.length > MAX_MEMORY_CHAINS
      || selected.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(id))
      || new Set(selected).size !== selected.length)) {
      throw new PersonalizationStoreError('invalid-request', 'Invalid trusted memory eligibility selection')
    }
    const eligible = selected === undefined ? undefined : new Set(selected)
    const now = this.timestamp()
    const applicable = listCurrentMemories(database)
      .filter((memory): memory is LiveMemoryVersion => memory.status === 'active')
      .filter(memory => eligible === undefined || eligible.has(memory.memoryVersionId))
      .filter(memory => memoryTimeApplies(memory, now))
      .filter(memory => scopeApplies(memory.scope, input.taskContext))
      .filter(memory => memory.sensitivity !== 'sensitive' || confirmed.has(memory.memoryVersionId))
      .sort(compareAdmittedMemory)
    const byEffect = new Map<PersonalizationEffect['key'], LiveMemoryVersion>()
    for (const memory of applicable) {
      if (!byEffect.has(memory.effect.key)) byEffect.set(memory.effect.key, memory)
      if (byEffect.size >= maxMemories) break
    }
    const memories = [...byEffect.values()]
    if (memories.length === 0) return undefined
    const seed = canonicalJson({
      profileId: input.profileId,
      sessionId: input.sessionId,
      turn: input.turn,
      taskContext: input.taskContext,
      sourceScopeVersionId: input.sourceScopeVersionId,
      baselineDigest: input.baselineDigest,
      memoryVersionIds: memories.map(memory => memory.memoryVersionId),
    })
    const decision: PersonalizationDecision = {
      schemaVersion: 1,
      recordType: 'personalization-decision',
      decisionId: deterministicId('personalization-decision', seed),
      profileId: input.profileId,
      memoryVersionIds: memories.map(memory => memory.memoryVersionId),
      appliesTo: {
        ...input.taskContext,
        sessionId: input.sessionId,
        turn: input.turn,
      },
      effects: memories.map(memory => memory.effect),
      why: memories.map(memory => ({
        memoryVersionId: memory.memoryVersionId,
        reason: memory.sensitivity === 'sensitive'
          ? 'recent-confirmation'
          : memory.activation.kind === 'explicit-setting'
            ? 'explicit-setting'
            : 'scope-match',
      })),
      factTraceGuard: {
        sourceScopeVersionId: input.sourceScopeVersionId,
        baselineDigest: input.baselineDigest,
        evidenceSupportInvariant: true,
        contradictionDisclosureInvariant: true,
        publicationGateInvariant: true,
        sourceScopeInvariant: true,
      },
      expiresAfterTurn: input.turn,
      createdAt: now,
    }
    assertCore(decision, { memories })
    const existing = readJsonRow<PersonalizationDecision>(
      database,
      'SELECT record_json FROM personalization_decisions WHERE decision_id = ?',
      decision.decisionId,
    )
    if (existing !== undefined) {
      // The decision identity binds its immutable inputs, not the wall clock of
      // a later provider attempt. Keep the original timestamp on exact replay.
      assertCore(existing, { memories })
      return exactReplay(existing, { ...decision, createdAt: existing.createdAt }, 'PersonalizationDecision')
    }
    enforceCount(database, 'personalization_decisions', MAX_DECISIONS)
    transaction(database, () => {
      database.prepare(`
        INSERT INTO personalization_decisions(decision_id, session_id, turn, record_json)
        VALUES (?, ?, ?, ?)
      `).run(decision.decisionId, decision.appliesTo.sessionId, decision.appliesTo.turn, canonicalJson(decision))
      appendCoreEvent(database, decision, 'personalization-decision.compiled', decision.decisionId, 1)
      bumpLedgerRevision(database)
    })
    return decision
  }

  sessionPolicy(profileId: string, sessionId: string): MemorySessionPolicy | undefined {
    return readSessionPolicy(this.profile(profileId), sessionId)
  }

  currentMemories(profileId: string): MemoryVersion[] {
    return listCurrentMemories(this.profile(profileId))
  }

  inspect(requestCandidate: unknown): PersonalizationInspectResult {
    let request: ReturnType<typeof parseContract<'personalization-inspect'>>
    try {
      request = parseContract('personalization-inspect', requestCandidate)
    } catch {
      throw new PersonalizationStoreError('invalid-request', 'personalization inspection request is invalid')
    }
    if (!('requestType' in request) || request.requestType !== 'personalization-inspect') {
      throw new PersonalizationStoreError('invalid-request', 'personalization inspection request is invalid')
    }
    const database = this.profile(request.profileId)
    const memories = listCurrentMemories(database)
      .sort((left, right) => right.transactionTime.recordedAt.localeCompare(left.transactionTime.recordedAt))
    const decisions = listDecisions(database)
      .filter(decision => decision.appliesTo.sessionId === request.sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const uses = listMemoryUses(database)
      .filter(use => use.sessionId === request.sessionId)
      .sort((left, right) => right.usedAt.localeCompare(left.usedAt))
    const sessionPolicy = readSessionPolicy(database, request.sessionId)
    const result: PersonalizationInspectResult = {
      schemaVersion: 1,
      resultType: 'personalization-inspection',
      profileId: request.profileId,
      sessionId: request.sessionId,
      profileRevision: metadata(database).ledgerRevision,
      ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
      memories: memories.slice(0, request.maxItems),
      decisions: decisions.slice(0, request.maxItems),
      uses: uses.slice(0, request.maxItems),
      counts: {
        memories: memories.length,
        decisions: decisions.length,
        uses: uses.length,
      },
      truncated: {
        memories: memories.length > request.maxItems,
        decisions: decisions.length > request.maxItems,
        uses: uses.length > request.maxItems,
      },
    }
    if (personalizationInspectIssues(result, request).length > 0) {
      throw new PersonalizationStoreError('integrity-error', 'personalization inspection is inconsistent')
    }
    return result
  }

  candidate(profileId: string, candidateId: string): MemoryCandidate | undefined {
    return readJsonRow(
      this.profile(profileId),
      'SELECT record_json FROM personalization_candidates WHERE candidate_id = ?',
      candidateId,
    )
  }

  ledgerRevision(profileId: string): number {
    return metadata(this.profile(profileId)).ledgerRevision
  }

  /** Opaque monotonic erasure fence, independent of the resettable content-ledger revision. */
  profileEpoch(profileId: string): number {
    return metadata(this.profile(profileId)).profileEpoch
  }

  exportAsset(profileId: string, assetId: string): PersonalizationExportAsset {
    const database = this.profile(profileId)
    const row = readRow(database, `
      SELECT descriptor_json, path FROM personalization_exports WHERE asset_id = ?
    `, assetId)
    if (row === undefined) throw new PersonalizationStoreError('not-found', 'personalization export is unavailable')
    const descriptor = JSON.parse(stringColumn(row, 'descriptor_json')) as PersonalizationExportDescriptor
    if (Date.parse(descriptor.expiresAt) <= this.now().getTime()) {
      throw new PersonalizationStoreError('not-found', 'personalization export has expired')
    }
    const path = stringColumn(row, 'path')
    if (path !== exportPath(this.exportsRoot, profileId, descriptor)) {
      throw new PersonalizationStoreError('integrity-error', 'personalization export path is invalid')
    }
    const bytes = readFileSync(path)
    if (sha256Bytes(bytes) !== descriptor.contentHash || bytes.byteLength !== descriptor.byteLength) {
      throw new PersonalizationStoreError('integrity-error', 'personalization export integrity check failed')
    }
    return {
      descriptor,
      bytes,
      mediaType: descriptor.format === 'json'
        ? 'application/json'
        : 'text/markdown; charset=utf-8',
    }
  }

  databasePath(profileId: string): string {
    return personalizationProfileDatabasePath(this.profilesRoot, profileId)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const database of this.databases.values()) database.close()
    this.databases.clear()
  }

  private applyCommand(
    database: DatabaseSync,
    request: PersonalizationCommandRequest,
  ): { result: PersonalizationCommandResult, createdExportPath?: string } {
    switch (request.action) {
      case 'set-session-policy':
        return { result: this.setSessionPolicy(database, request) }
      case 'set-preference':
        return { result: this.setPreference(database, request) }
      case 'review-candidate':
        return { result: this.reviewCandidate(database, request) }
      case 'pause':
      case 'resume':
      case 'edit':
        return { result: this.mutateMemory(database, request) }
      case 'forget':
        return { result: this.forget(database, request) }
      case 'export': {
        const exported = this.exportProfile(database, request)
        return { result: exported.result, createdExportPath: exported.path }
      }
    }
  }

  private setSessionPolicy(
    database: DatabaseSync,
    request: Extract<PersonalizationCommandRequest, { action: 'set-session-policy' }>,
  ): PersonalizationCommandResult {
    const previous = readSessionPolicy(database, request.sessionId)
    const currentVersion = previous?.version ?? 0
    if (currentVersion !== request.expectedVersion) {
      throw new PersonalizationStoreError('conflict', 'session policy compare-and-set failed')
    }
    const version = currentVersion + 1
    const policy: MemorySessionPolicy = {
      schemaVersion: 1,
      recordType: 'memory-session-policy',
      policyId: deterministicId('memory-session-policy', request.profileId, request.sessionId, String(version)),
      profileId: request.profileId,
      sessionId: request.sessionId,
      version,
      useExisting: request.policy.useExisting,
      contributeToFuture: request.policy.contributeToFuture,
      updatedBy: request.actor,
      updatedAt: this.timestamp(),
    }
    assertCore(policy)
    database.prepare(`
      INSERT INTO personalization_session_policies(session_id, version, record_json)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        version = excluded.version,
        record_json = excluded.record_json
    `).run(policy.sessionId, policy.version, canonicalJson(policy))
    return {
      schemaVersion: 1,
      resultType: 'personalization-command',
      profileId: request.profileId,
      action: request.action,
      status: 'applied',
      sessionPolicy: policy,
    }
  }

  private setPreference(
    database: DatabaseSync,
    request: Extract<PersonalizationCommandRequest, { action: 'set-preference' }>,
  ): PersonalizationCommandResult {
    assertNoDuplicateCurrentEffect(database, request.preference, undefined)
    enforceCount(database, 'personalization_memory_chains', MAX_MEMORY_CHAINS)
    const occurredAt = this.timestamp()
    const observation = explicitObservation(request, request.preference, occurredAt)
    assertCore(observation, { sessionPolicies: listSessionPolicies(database) })
    insertObservation(database, observation)
    const chainId = deterministicId('memory-chain', request.profileId, request.idempotencyKey)
    const memory = createMemoryVersion({
      profileId: request.profileId,
      chainId,
      version: 1,
      draft: request.preference,
      observationIds: [observation.observationId],
      activationKind: request.preference.sensitivity === 'sensitive'
        ? 'explicit-confirmation'
        : 'explicit-setting',
      actor: request.actor,
      occurredAt,
    })
    insertMemory(database, memory)
    return {
      schemaVersion: 1,
      resultType: 'personalization-command',
      profileId: request.profileId,
      action: request.action,
      status: 'created',
      memoryVersion: memory,
    }
  }

  private reviewCandidate(
    database: DatabaseSync,
    request: Extract<PersonalizationCommandRequest, { action: 'review-candidate' }>,
  ): PersonalizationCommandResult {
    const current = readJsonRow<MemoryCandidate>(
      database,
      'SELECT record_json FROM personalization_candidates WHERE candidate_id = ?',
      request.candidateId,
    )
    if (current === undefined) throw new PersonalizationStoreError('not-found', 'memory candidate is unavailable')
    if (current.version !== request.expectedVersion) {
      throw new PersonalizationStoreError('conflict', 'candidate compare-and-set failed')
    }
    if (current.decision !== 'pending' && current.decision !== 'needs-review') {
      throw new PersonalizationStoreError('conflict', 'memory candidate was already decided')
    }
    if (
      request.decision === 'accept'
      && current.sensitivity === 'sensitive'
      && current.formation === 'inferred-behavior'
    ) {
      throw new PersonalizationStoreError(
        'invalid-request',
        'inferred sensitive state cannot be promoted; create an explicit preference instead',
      )
    }
    const occurredAt = this.timestamp()
    const acceptedReplacement = request.decision === 'accept' ? request.replacement : undefined
    const candidate: MemoryCandidate = {
      ...current,
      ...(acceptedReplacement === undefined
        ? {}
        : {
            proposedMemoryType: acceptedReplacement.memoryType,
            proposedEffect: acceptedReplacement.effect,
            proposedScope: acceptedReplacement.scope,
            sensitivity: acceptedReplacement.sensitivity,
          }),
      version: current.version + 1,
      decision: request.decision === 'accept' ? 'promote' : 'reject',
      rationaleCode: request.decision === 'accept'
        ? current.rationaleCode
        : 'user-rejected',
      decidedBy: request.actor,
      decidedAt: occurredAt,
    }
    assertCore(candidate, { observations: listObservations(database) })
    database.prepare(`
      UPDATE personalization_candidates SET version = ?, decision = ?, record_json = ?
      WHERE candidate_id = ? AND version = ?
    `).run(candidate.version, candidate.decision, canonicalJson(candidate), current.candidateId, current.version)
    let memoryVersion: MemoryVersion | undefined
    if (request.decision === 'accept') {
      enforceCount(database, 'personalization_memory_chains', MAX_MEMORY_CHAINS)
      const draft = request.replacement ?? candidateDraft(candidate)
      assertNoDuplicateCurrentEffect(database, draft, undefined)
      const chainId = deterministicId('memory-chain', request.profileId, request.idempotencyKey)
      memoryVersion = createMemoryVersion({
        profileId: request.profileId,
        chainId,
        version: 1,
        draft,
        observationIds: candidate.observationIds,
        candidateId: candidate.candidateId,
        activationKind: 'explicit-confirmation',
        actor: request.actor,
        occurredAt,
      })
      insertMemory(database, memoryVersion)
    }
    return {
      schemaVersion: 1,
      resultType: 'personalization-command',
      profileId: request.profileId,
      action: request.action,
      status: 'updated',
      candidate,
      ...(memoryVersion === undefined ? {} : { memoryVersion }),
    }
  }

  private mutateMemory(
    database: DatabaseSync,
    request: Extract<PersonalizationCommandRequest, { action: 'pause' | 'resume' | 'edit' }>,
  ): PersonalizationCommandResult {
    const current = requireCurrentMemory(database, request.memoryVersionId, request.expectedVersion)
    if (request.action === 'pause' && current.status !== 'active' && current.status !== 'disputed') {
      throw new PersonalizationStoreError('conflict', 'only active or disputed memory can be paused')
    }
    if (request.action === 'resume' && current.status !== 'paused') {
      throw new PersonalizationStoreError('conflict', 'only paused memory can be resumed')
    }
    const occurredAt = this.timestamp()
    let draft: EditableMemoryDraft = memoryDraft(current)
    let observationIds = [...current.observationIds]
    let candidateId = current.candidateId
    let activationKind: LiveMemoryVersion['activation']['kind'] = current.activation.kind
    let activationActor = current.activation.actor
    if (request.action === 'edit') {
      draft = request.replacement
      assertNoDuplicateCurrentEffect(database, draft, current.chainId)
      const observation = explicitObservation(request, draft, occurredAt)
      assertCore(observation, { sessionPolicies: listSessionPolicies(database) })
      insertObservation(database, observation)
      observationIds = [...observationIds, observation.observationId].slice(-100)
      candidateId = undefined
      activationKind = 'explicit-confirmation'
      activationActor = request.actor
    }
    const status = request.action === 'pause'
      ? 'paused'
      : request.action === 'resume'
        ? 'active'
        : request.statusAfterEdit
    retractPendingDecisions(database, new Set([current.memoryVersionId]))
    const memory = createMemoryVersion({
      profileId: request.profileId,
      chainId: current.chainId,
      version: current.version + 1,
      draft,
      observationIds,
      ...(candidateId === undefined ? {} : { candidateId }),
      activationKind,
      actor: activationActor,
      occurredAt,
      previousMemoryVersionId: current.memoryVersionId,
      status,
      ...(request.action === 'edit' ? {} : { validTime: current.validTime }),
    })
    supersedeMemory(database, current, memory, occurredAt)
    return {
      schemaVersion: 1,
      resultType: 'personalization-command',
      profileId: request.profileId,
      action: request.action,
      status: 'updated',
      memoryVersion: memory,
    }
  }

  private forget(
    database: DatabaseSync,
    request: Extract<PersonalizationCommandRequest, { action: 'forget' }>,
  ): PersonalizationCommandResult {
    if (request.target === 'memory-chain') {
      if (request.mode !== 'memory-only') {
        throw new PersonalizationStoreError(
          'invalid-request',
          'chain forget is logical memory-only removal; use profile privacy erasure for compaction',
        )
      }
      const current = requireCurrentMemory(database, request.memoryVersionId!, request.expectedVersion!)
      tombstoneMemory(database, current, this.timestamp())
      retractPendingDecisions(database, new Set([current.memoryVersionId]))
    } else {
      if (metadata(database).ledgerRevision !== request.expectedProfileRevision) {
        throw new PersonalizationStoreError('conflict', 'profile revision compare-and-set failed')
      }
      const currentMemories = listCurrentMemories(database)
      for (const memory of currentMemories) {
        if (memory.status !== 'deleted') tombstoneMemory(database, memory, this.timestamp())
      }
      retractPendingDecisions(
        database,
        new Set(currentMemories.map(memory => memory.memoryVersionId)),
      )
    }
    const receipt: ForgetReceipt = {
      receiptId: deterministicId('forget-receipt', request.profileId, request.idempotencyKey),
      target: request.target,
      targetId: request.target === 'profile' ? request.profileId : request.memoryVersionId!,
      mode: request.mode,
      activeProjectionRemoved: true,
      sessionLogChanged: false,
      providerCopiesChanged: false,
      provenanceHandling: request.provenanceHandling,
      backupDisposition: 'not-applicable',
      completedAt: this.timestamp(),
    }
    return {
      schemaVersion: 1,
      resultType: 'personalization-command',
      profileId: request.profileId,
      action: request.action,
      status: 'completed',
      receipt,
    }
  }

  private exportProfile(
    database: DatabaseSync,
    request: Extract<PersonalizationCommandRequest, { action: 'export' }>,
  ): { result: PersonalizationCommandResult, path: string } {
    const projection = personalizationExportProjection(database, request)
    const exportedAt = this.timestamp()
    const bundle = {
      schemaVersion: 1,
      exportType: 'docatlas-personalization',
      profileId: request.profileId,
      exportedAt,
      ledgerRevision: metadata(database).ledgerRevision,
      includedStatuses: request.includeStatuses,
      sessionPolicies: listSessionPolicies(database),
      ...projection,
    }
    assertNoSecret(bundle)
    const text = request.format === 'json'
      ? `${JSON.stringify(bundle, null, 2)}\n`
      : renderMarkdownExport(bundle)
    const bytes = Buffer.from(text, 'utf8')
    const exportId = deterministicId('personalization-export', request.profileId, request.idempotencyKey)
    const assetId = deterministicId('asset', exportId)
    const managedExportRoot = profileExportRoot(this.exportsRoot, request.profileId)
    mkdirSync(managedExportRoot, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(managedExportRoot, DIRECTORY_MODE)
    const path = exportPath(this.exportsRoot, request.profileId, descriptorLike(assetId, request.format))
    if (existsSync(path)) {
      const existing = readFileSync(path)
      if (!existing.equals(bytes)) {
        throw new PersonalizationStoreError('integrity-error', 'stale export asset conflicts with this request')
      }
    } else {
      writeFileSync(path, bytes, { mode: DATABASE_MODE, flag: 'wx' })
    }
    chmodSync(path, DATABASE_MODE)
    const descriptor: PersonalizationExportDescriptor = {
      exportId,
      assetId,
      bundleSchemaVersion: 1,
      format: request.format,
      contentHash: sha256Bytes(bytes),
      byteLength: bytes.byteLength,
      createdAt: exportedAt,
      expiresAt: new Date(this.now().getTime() + EXPORT_TTL_MS).toISOString(),
      provenance: request.includeProvenanceRefs ? 'references-only' : 'omitted',
      includedStatuses: request.includeStatuses,
    }
    database.prepare(`
      INSERT INTO personalization_exports(asset_id, descriptor_json, path, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(assetId, canonicalJson(descriptor), path, descriptor.expiresAt)
    return {
      result: {
        schemaVersion: 1,
        resultType: 'personalization-command',
        profileId: request.profileId,
        action: request.action,
        status: 'created',
        export: descriptor,
      },
      path,
    }
  }

  private eraseProfile(
    database: DatabaseSync,
    request: Extract<PersonalizationCommandRequest, { action: 'forget' }>,
    expectedProfileEpoch?: number,
    commandHash?: string,
  ): PersonalizationCommandResult {
    let backupPaths: string[] = []
    let completedEpoch: number
    const exportRoot = profileExportRoot(this.exportsRoot, request.profileId)
    database.exec('BEGIN IMMEDIATE')
    try {
      const replay = authorizedCommandReplay(database, request, expectedProfileEpoch, commandHash)
      if (replay !== undefined) { database.exec('COMMIT'); return replay }
      const current = metadata(database)
      if (current.ledgerRevision !== request.expectedProfileRevision) {
        throw new PersonalizationStoreError('conflict', 'profile revision compare-and-set failed')
      }
      if (current.profileEpoch >= Number.MAX_SAFE_INTEGER) throw new PersonalizationStoreError('limit-exceeded', 'Profile erasure epoch is exhausted')
      completedEpoch = current.profileEpoch + 1
      backupPaths = this.profileBackupPaths(request.profileId)
      assertManagedDirectory(exportRoot)
      for (const table of [
        'personalization_choices',
        'personalization_memory_uses',
        'personalization_decisions',
        'personalization_memory_chains',
        'personalization_memory_versions',
        'personalization_candidates',
        'personalization_observations',
        'personalization_session_policies',
        'personalization_probes',
        'personalization_exports',
        'personalization_idempotency',
        'personalization_journal',
      ]) database.exec(`DELETE FROM ${table}`)
      database.prepare('UPDATE personalization_metadata SET ledger_revision = 0, profile_epoch = ? WHERE singleton = 1').run(completedEpoch)
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      throw error
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    database.exec('VACUUM')
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    removeManagedDirectory(exportRoot)
    for (const path of backupPaths) safeUnlink(path)
    const completedAt = this.timestamp()
    const receipt: ForgetReceipt = {
      receiptId: deterministicId('forget-receipt', request.profileId, request.idempotencyKey),
      target: 'profile',
      targetId: request.profileId,
      mode: 'privacy-erasure',
      activeProjectionRemoved: true,
      sessionLogChanged: false,
      providerCopiesChanged: false,
      provenanceHandling: request.provenanceHandling,
      backupDisposition: 'compacted',
      completedAt,
    }
    const result: PersonalizationCommandResult = {
      schemaVersion: 1,
      resultType: 'personalization-command',
      profileId: request.profileId,
      action: 'forget',
      status: 'completed',
      receipt,
    }
    transaction(database, () => {
      if (metadata(database).profileEpoch !== completedEpoch) throw new PersonalizationStoreError('conflict', 'A newer profile erasure superseded this receipt')
      insertIdempotency(database, request, result, commandHash)
      appendJournal(database, {
        eventId: deterministicId('event', request.profileId, request.idempotencyKey),
        aggregateType: 'profile',
        aggregateId: request.profileId,
        aggregateVersion: 1,
        eventType: 'personalization-command.forget',
        actorKind: request.actor.kind,
        actorId: request.actor.actorId,
        occurredAt: completedAt,
        idempotencyKey: request.idempotencyKey,
        payload: result,
      })
      bumpLedgerRevision(database)
    })
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    assertCommandResult(result, request)
    return result
  }

  private existingProfile(profileId: string): DatabaseSync | undefined {
    if (this.closed) throw new PersonalizationStoreError('integrity-error', 'personalization store is closed')
    if (!opaqueId(profileId)) throw new PersonalizationStoreError('invalid-request', 'Profile identity is invalid')
    return this.databases.get(profileId) ?? (existsSync(this.databasePath(profileId)) ? this.profile(profileId) : undefined)
  }

  private profile(profileId: string): DatabaseSync {
    if (this.closed) throw new PersonalizationStoreError('integrity-error', 'personalization store is closed')
    const existing = this.databases.get(profileId)
    if (existing !== undefined) return existing
    const path = personalizationProfileDatabasePath(this.profilesRoot, profileId)
    ensurePrivateFile(path)
    const database = new DatabaseSync(path)
    try {
      preflight(database)
      configure(database)
      initializeProfile(database, path, this.backupsRoot, profileId, this.timestamp())
      ensurePrivateSqliteFiles(path)
      verifyProfile(database, profileId, this.exportsRoot)
      this.databases.set(profileId, database)
      return database
    } catch (error) {
      database.close()
      throw normalizeStoreError(error)
    }
  }

  private profileBackupPaths(profileId: string): string[] {
    const prefix = `${sha256(profileId)}.`
    for (const name of readdirSync(this.backupsRoot)) {
      if (!name.startsWith(prefix)) continue
      if (name.endsWith('.sqlite3')) {
        verifyProfileBackup(join(this.backupsRoot, name), profileId)
      } else if (!name.endsWith('.sqlite3-wal') && !name.endsWith('.sqlite3-shm')) {
        throw new PersonalizationStoreError('integrity-error', 'unknown managed profile backup file')
      }
    }
    return readdirSync(this.backupsRoot)
      .filter(name => name.startsWith(prefix))
      .map(name => join(this.backupsRoot, name))
  }

  private timestamp(): string {
    return this.now().toISOString()
  }
}

export function personalizationProfileDatabasePath(profilesRoot: string, profileId: string): string {
  return join(profilesRoot, `${sha256(profileId)}.sqlite3`)
}

function initializeProfile(
  database: DatabaseSync,
  path: string,
  backupsRoot: string,
  profileId: string,
  now: string,
): void {
  const hasMetadata = tableExists(database, 'personalization_metadata')
  if (!hasMetadata) {
    const foreignTables = readRows(database, `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `)
    if (foreignTables.length > 0) {
      throw new PersonalizationStoreError('integrity-error', 'unknown personalization database layout')
    }
    createSchema(database)
    database.prepare(`
      INSERT INTO personalization_metadata(singleton, schema_version, profile_id, ledger_revision, profile_epoch, created_at)
      VALUES (1, ?, ?, 0, 0, ?)
    `).run(PERSONALIZATION_SCHEMA_VERSION, profileId, now)
    return
  }
  const row = readRow(database, `
    SELECT schema_version, profile_id FROM personalization_metadata WHERE singleton = 1
  `)
  if (row === undefined) throw new PersonalizationStoreError('integrity-error', 'profile metadata is missing')
  if (stringColumn(row, 'profile_id') !== profileId) {
    throw new PersonalizationStoreError('integrity-error', 'profile database identity mismatch')
  }
  const version = integerColumn(row, 'schema_version')
  if (version > PERSONALIZATION_SCHEMA_VERSION || version < 0) {
    throw new PersonalizationStoreError('integrity-error', 'unsupported personalization schema version')
  }
  if (version >= 2 && !readRows(database, 'PRAGMA table_info(personalization_metadata)').some(column => stringColumn(column, 'name') === 'profile_epoch')) {
    throw new PersonalizationStoreError('integrity-error', 'A versioned profile cannot lose its persistent erasure epoch')
  }
  if (version < PERSONALIZATION_SCHEMA_VERSION) {
    if (tableExists(database, 'personalization_journal')) verifyJournal(database)
    database.exec('PRAGMA wal_checkpoint(FULL)')
    const backupPath = join(
      backupsRoot,
      `${sha256(profileId)}.v${version}.${sha256(now).slice(0, 16)}.sqlite3`,
    )
    copyFileSync(path, backupPath, fsConstants.COPYFILE_EXCL)
    chmodSync(backupPath, DATABASE_MODE)
    verifyProfileBackup(backupPath, profileId)
    transaction(database, () => {
      createSchema(database)
      const erased = hasPrivacyErasureReceipt(database, profileId)
      if (!readRows(database, 'PRAGMA table_info(personalization_metadata)').some(column => stringColumn(column, 'name') === 'profile_epoch')) {
        database.exec('ALTER TABLE personalization_metadata ADD COLUMN profile_epoch INTEGER NOT NULL DEFAULT 0 CHECK(profile_epoch >= 0 AND profile_epoch <= 9007199254740991)')
      }
      database.prepare(`
        UPDATE personalization_metadata SET schema_version = ?, profile_epoch = MAX(profile_epoch, ?), ledger_revision = CASE WHEN ? = 0 THEN 0 ELSE ledger_revision END
        WHERE singleton = 1
      `).run(PERSONALIZATION_SCHEMA_VERSION, erased ? 1 : 0, version)
    })
  } else {
    createSchema(database)
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS personalization_metadata(
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      ledger_revision INTEGER NOT NULL,
      profile_epoch INTEGER NOT NULL CHECK(profile_epoch >= 0 AND profile_epoch <= 9007199254740991),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personalization_journal(
      event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      idempotency_key TEXT,
      payload_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personalization_idempotency(
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personalization_session_policies(
      session_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personalization_observations(
      observation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      consent TEXT NOT NULL,
      lineage_key TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personalization_candidates(
      candidate_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      decision TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personalization_memory_versions(
      memory_version_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE(chain_id, version)
    );
    CREATE TABLE IF NOT EXISTS personalization_memory_chains(
      chain_id TEXT PRIMARY KEY,
      current_memory_version_id TEXT NOT NULL UNIQUE,
      current_version INTEGER NOT NULL,
      FOREIGN KEY(current_memory_version_id)
        REFERENCES personalization_memory_versions(memory_version_id)
    );
    CREATE TABLE IF NOT EXISTS personalization_decisions(
      decision_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personalization_memory_uses(
      memory_use_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      FOREIGN KEY(decision_id) REFERENCES personalization_decisions(decision_id)
    );
    CREATE TABLE IF NOT EXISTS personalization_probes(
      probe_id TEXT PRIMARY KEY,
      investigation_id TEXT,
      automatic INTEGER NOT NULL CHECK(automatic IN (0, 1)),
      record_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS personalization_one_auto_probe
      ON personalization_probes(investigation_id)
      WHERE automatic = 1 AND investigation_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS personalization_choices(
      choice_id TEXT PRIMARY KEY,
      probe_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      FOREIGN KEY(probe_id) REFERENCES personalization_probes(probe_id)
    );
    CREATE INDEX IF NOT EXISTS personalization_choices_by_probe ON personalization_choices(probe_id);
    CREATE INDEX IF NOT EXISTS personalization_receipts_by_probe ON personalization_journal(event_type, aggregate_id);
    CREATE INDEX IF NOT EXISTS personalization_learning_receipts_by_choice
      ON personalization_journal(json_extract(payload_json, '$.choiceObservationId'))
      WHERE event_type = 'learning.command.committed' AND json_extract(payload_json, '$.receipt.action') = 'choice';
    CREATE TABLE IF NOT EXISTS personalization_exports(
      asset_id TEXT PRIMARY KEY,
      descriptor_json TEXT NOT NULL,
      path TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `)
}

function configure(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA busy_timeout = 5000')
}

function preflight(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
  if (row === undefined || Object.values(row)[0] !== 'ok') {
    throw new PersonalizationStoreError('integrity-error', 'personalization database quick-check failed')
  }
}

function verifyProfile(database: DatabaseSync, profileId: string, exportsRoot: string): void {
  preflight(database)
  const meta = metadata(database)
  if (meta.schemaVersion !== PERSONALIZATION_SCHEMA_VERSION || meta.profileId !== profileId) {
    throw new PersonalizationStoreError('integrity-error', 'personalization metadata failed validation')
  }
  verifyJournal(database)
  const policies = listSessionPolicies(database)
  const observations = listObservations(database)
  const candidates = listCandidates(database)
  const memories = listMemoryVersions(database)
  const decisions = listDecisions(database)
  const uses = listMemoryUses(database)
  const probes = listProbes(database)
  const choices = listChoices(database)
  const controlledReceipts = readRows(database, "SELECT aggregate_id FROM personalization_journal WHERE event_type = 'preference-choice.committed'")
    .map(row => readProbeChoiceReceipt(database, profileId, stringColumn(row, 'aggregate_id'))!)
  const controlledObservationIds = new Set(controlledReceipts.map(receipt => receipt.observationId))
  const learningReceipts = verifyLearningLedger(database, profileId)
  for (const receipt of learningReceipts) if (receipt.observationId) controlledObservationIds.add(receipt.observationId)
  for (const value of [
    ...policies,
    ...observations,
    ...candidates,
    ...memories,
    ...uses,
    ...probes,
    ...choices,
  ] as PersonalizationCoreValue[]) {
    assertCore(value, {
      profileId,
      // A controlled receipt proves consent at its atomic creation. Turning future
      // contribution off cannot invalidate an immutable historical observation.
      ...(value.recordType === 'personalization-observation' && controlledObservationIds.has(value.observationId) ? {} : { sessionPolicies: policies }),
      observations,
      candidates,
      memories,
      decisions,
      probes,
      choices,
    })
    assertNoSecret(value)
  }
  for (const decision of decisions) {
    assertCore(decision, {
      profileId,
      memories: memoriesAtDecisionTime(decision, memories),
    })
    assertNoSecret(decision)
  }
  const versionIssues = memoryVersionSetIssues(memories)
  if (versionIssues.length > 0) {
    throw new PersonalizationStoreError('integrity-error', 'personalization memory lineage is invalid')
  }
  verifyCurrentMemoryProjection(database, memories)
  for (const receipt of controlledReceipts) resolveProbeChoiceReceipt(database, receipt)
  for (const row of readRows(database, 'SELECT request_hash, result_json FROM personalization_idempotency')) {
    const requestHash = stringColumn(row, 'request_hash')
    if (!/^[a-f0-9]{64}$/.test(requestHash)) {
      throw new PersonalizationStoreError('integrity-error', 'personalization idempotency hash is invalid')
    }
    parseCommandResult(stringColumn(row, 'result_json'))
  }
  for (const stored of storedExportRows(database)) {
    assertExportDescriptor(profileId, stored.descriptor)
    if (stored.path !== exportPath(exportsRoot, profileId, stored.descriptor)
      || !existsSync(stored.path)
      || statSync(stored.path).isFile() === false) {
      throw new PersonalizationStoreError('integrity-error', 'personalization export file is missing')
    }
  }
}

interface JournalEventInput {
  eventId: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  eventType: string
  actorKind: string
  actorId: string
  occurredAt: string
  idempotencyKey?: string
  payload: unknown
}

function appendJournal(database: DatabaseSync, input: JournalEventInput): void {
  const previous = readRow(database, `
    SELECT event_hash FROM personalization_journal ORDER BY event_seq DESC LIMIT 1
  `)
  const previousHash = previous === undefined ? '0'.repeat(64) : stringColumn(previous, 'event_hash')
  const payloadJson = canonicalJson(input.payload)
  const hashPayload = canonicalJson({
    eventId: input.eventId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    eventType: input.eventType,
    actorKind: input.actorKind,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: JSON.parse(payloadJson) as unknown,
    previousHash,
  })
  const eventHash = sha256(hashPayload)
  database.prepare(`
    INSERT INTO personalization_journal(
      event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
      actor_kind, actor_id, occurred_at, idempotency_key, payload_json,
      previous_hash, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventId,
    input.aggregateType,
    input.aggregateId,
    input.aggregateVersion,
    input.eventType,
    input.actorKind,
    input.actorId,
    input.occurredAt,
    input.idempotencyKey ?? null,
    payloadJson,
    previousHash,
    eventHash,
  )
}

function verifyJournal(database: DatabaseSync): void {
  let previousHash = '0'.repeat(64)
  for (const row of readRows(database, 'SELECT * FROM personalization_journal ORDER BY event_seq')) {
    if (stringColumn(row, 'previous_hash') !== previousHash) {
      throw new PersonalizationStoreError('integrity-error', 'personalization journal chain is invalid')
    }
    const payloadJson = stringColumn(row, 'payload_json')
    const hashPayload = canonicalJson({
      eventId: stringColumn(row, 'event_id'),
      aggregateType: stringColumn(row, 'aggregate_type'),
      aggregateId: stringColumn(row, 'aggregate_id'),
      aggregateVersion: integerColumn(row, 'aggregate_version'),
      eventType: stringColumn(row, 'event_type'),
      actorKind: stringColumn(row, 'actor_kind'),
      actorId: stringColumn(row, 'actor_id'),
      occurredAt: stringColumn(row, 'occurred_at'),
      idempotencyKey: nullableStringColumn(row, 'idempotency_key'),
      payload: JSON.parse(payloadJson) as unknown,
      previousHash,
    })
    const eventHash = sha256(hashPayload)
    if (eventHash !== stringColumn(row, 'event_hash')) {
      throw new PersonalizationStoreError('integrity-error', 'personalization journal hash is invalid')
    }
    previousHash = eventHash
  }
}

function appendCoreEvent(
  database: DatabaseSync,
  value: PersonalizationCoreValue,
  eventType: string,
  aggregateId: string,
  aggregateVersion: number,
): void {
  appendJournal(database, {
    eventId: deterministicId('event', eventType, aggregateId, String(aggregateVersion)),
    aggregateType: value.recordType,
    aggregateId,
    aggregateVersion,
    eventType,
    actorKind: coreActor(value).kind,
    actorId: coreActor(value).actorId,
    occurredAt: coreTimestamp(value),
    payload: value,
  })
}

function coreActor(value: PersonalizationCoreValue): { kind: 'user' | 'rule', actorId: string } {
  switch (value.recordType) {
    case 'memory-session-policy': return value.updatedBy
    case 'personalization-observation': return value.observedActor
    case 'memory-candidate': return value.decidedBy ?? { kind: 'rule', actorId: 'rule:personalization:v1' }
    case 'memory-version':
      return value.status === 'deleted'
        ? { kind: 'rule', actorId: 'rule:personalization:v1' }
        : value.activation.actor
    default: return { kind: 'rule', actorId: 'rule:personalization:v1' }
  }
}

function coreTimestamp(value: PersonalizationCoreValue): string {
  switch (value.recordType) {
    case 'memory-session-policy': return value.updatedAt
    case 'personalization-observation': return value.occurredAt
    case 'memory-candidate': return value.decidedAt ?? value.createdAt
    case 'memory-version': return value.transactionTime.recordedAt
    case 'personalization-decision': return value.createdAt
    case 'memory-use': return value.usedAt
    case 'preference-probe': return value.generatedAt
    case 'preference-choice-observation': return value.occurredAt
  }
}

function explicitObservation(
  request: Extract<PersonalizationCommandRequest, { action: 'set-preference' | 'edit' }>,
  draft: EditableMemoryDraft,
  occurredAt: string,
): PersonalizationObservation {
  return {
    schemaVersion: 1,
    recordType: 'personalization-observation',
    observationId: deterministicId('observation', request.profileId, request.idempotencyKey),
    profileId: request.profileId,
    sessionId: request.sessionId,
    occurredAt,
    observedActor: request.actor,
    sourceRef: {
      kind: 'ui-action',
      sessionId: request.sessionId,
      actionId: deterministicId('ui-action', request.idempotencyKey),
      actionType: request.action,
      payloadHash: sha256(canonicalJson(request)),
    },
    lineageKey: deterministicId('lineage', request.sessionId, request.idempotencyKey),
    taskContext: taskContextForScope(draft.scope),
    scope: draft.scope,
    consent: { retention: 'eligible', basis: 'user-explicit' },
    signal: 'explicit-setting',
    detail: { effect: draft.effect, appliesBeyondTurn: true },
  }
}

function taskContextForScope(scope: PersonalizationScope): PersonalizationTaskContext {
  return {
    mode: 'explore',
    ...('workspaceId' in scope ? { workspaceId: scope.workspaceId } : {}),
    ...('collectionId' in scope ? { collectionId: scope.collectionId } : {}),
    ...('documentId' in scope ? { documentId: scope.documentId } : {}),
    ...('revisionId' in scope ? { revisionId: scope.revisionId } : {}),
    ...('taskFamily' in scope ? { taskFamily: scope.taskFamily } : {}),
    ...('domain' in scope ? { domain: scope.domain } : {}),
  }
}

function candidateDraft(candidate: MemoryCandidate): EditableMemoryDraft {
  return {
    memoryType: candidate.proposedMemoryType,
    effect: candidate.proposedEffect,
    summary: describeEffect(candidate.proposedEffect),
    scope: candidate.proposedScope,
    sensitivity: candidate.sensitivity,
    policy: {
      apply: candidate.sensitivity === 'sensitive' ? 'confirm-each-use' : 'disclose',
    },
  }
}

function createMemoryVersion(input: {
  profileId: string
  chainId: string
  version: number
  draft: EditableMemoryDraft
  observationIds: string[]
  candidateId?: string
  activationKind: LiveMemoryVersion['activation']['kind']
  actor: { kind: 'user' | 'rule', actorId: string }
  occurredAt: string
  previousMemoryVersionId?: string
  status?: 'active' | 'paused' | 'disputed'
  validTime?: LiveMemoryVersion['validTime']
}): LiveMemoryVersion {
  const validTime = input.validTime ?? memoryValidTime(input.draft, input.occurredAt)
  const memory: LiveMemoryVersion = {
    schemaVersion: 1,
    recordType: 'memory-version',
    memoryVersionId: deterministicId('memory-version', input.chainId, String(input.version)),
    chainId: input.chainId,
    version: input.version,
    profileId: input.profileId,
    status: input.status ?? 'active',
    ...(input.previousMemoryVersionId === undefined
      ? {}
      : { previousMemoryVersionId: input.previousMemoryVersionId }),
    transactionTime: { recordedAt: input.occurredAt },
    memoryType: input.draft.memoryType,
    effect: input.draft.effect,
    summary: input.draft.summary,
    scope: input.draft.scope,
    sensitivity: input.draft.sensitivity,
    observationIds: input.observationIds,
    ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
    contentSafety: {
      secretScan: 'passed',
      sensitiveInference: input.draft.sensitivity === 'sensitive' ? 'user-declared' : 'none',
    },
    retentionConsent: 'eligible',
    validTime,
    activation: {
      kind: input.activationKind,
      actor: input.actor,
      activatedAt: input.occurredAt,
    },
    policy: input.draft.policy,
  }
  assertCore(memory)
  return memory
}

function memoryValidTime(
  draft: EditableMemoryDraft,
  occurredAt: string,
): LiveMemoryVersion['validTime'] {
  if (draft.policy.expiresAfterDays === undefined) return { from: occurredAt }
  const from = Date.parse(occurredAt)
  const until = new Date(from + draft.policy.expiresAfterDays * 24 * 60 * 60 * 1000).toISOString()
  return { from: occurredAt, until }
}

function memoryDraft(memory: LiveMemoryVersion): EditableMemoryDraft {
  return {
    memoryType: memory.memoryType,
    effect: memory.effect,
    summary: memory.summary,
    scope: memory.scope,
    sensitivity: memory.sensitivity,
    policy: memory.policy,
  }
}

function insertObservation(database: DatabaseSync, observation: PersonalizationObservation): void {
  enforceCount(database, 'personalization_observations', MAX_OBSERVATIONS)
  database.prepare(`
    INSERT INTO personalization_observations(
      observation_id, session_id, consent, lineage_key, record_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    observation.observationId,
    observation.sessionId,
    observation.consent.retention,
    observation.lineageKey,
    canonicalJson(observation),
  )
}

function insertMemory(database: DatabaseSync, memory: LiveMemoryVersion): void {
  assertCore(memory, { observations: listObservations(database), candidates: listCandidates(database) })
  database.prepare(`
    INSERT INTO personalization_memory_versions(
      memory_version_id, chain_id, version, status, record_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    memory.memoryVersionId,
    memory.chainId,
    memory.version,
    memory.status,
    canonicalJson(memory),
  )
  database.prepare(`
    INSERT INTO personalization_memory_chains(chain_id, current_memory_version_id, current_version)
    VALUES (?, ?, ?)
  `).run(memory.chainId, memory.memoryVersionId, memory.version)
}

function supersedeMemory(
  database: DatabaseSync,
  current: LiveMemoryVersion,
  next: LiveMemoryVersion,
  occurredAt: string,
): void {
  const superseded: LiveMemoryVersion = {
    ...current,
    status: 'superseded',
    supersededByMemoryVersionId: next.memoryVersionId,
    transactionTime: { ...current.transactionTime, retiredAt: occurredAt },
  }
  assertCore(superseded)
  database.prepare(`
    UPDATE personalization_memory_versions SET status = ?, record_json = ?
    WHERE memory_version_id = ?
  `).run(superseded.status, canonicalJson(superseded), current.memoryVersionId)
  database.prepare(`
    INSERT INTO personalization_memory_versions(
      memory_version_id, chain_id, version, status, record_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(next.memoryVersionId, next.chainId, next.version, next.status, canonicalJson(next))
  database.prepare(`
    UPDATE personalization_memory_chains
    SET current_memory_version_id = ?, current_version = ?
    WHERE chain_id = ? AND current_memory_version_id = ?
  `).run(next.memoryVersionId, next.version, next.chainId, current.memoryVersionId)
}

function tombstoneMemory(
  database: DatabaseSync,
  current: LiveMemoryVersion,
  occurredAt: string,
): MemoryVersion {
  const tombstone: MemoryVersion = {
    schemaVersion: 1,
    recordType: 'memory-version',
    memoryVersionId: deterministicId('memory-version', current.chainId, String(current.version + 1)),
    chainId: current.chainId,
    version: current.version + 1,
    profileId: current.profileId,
    status: 'deleted',
    previousMemoryVersionId: current.memoryVersionId,
    transactionTime: { recordedAt: occurredAt, retiredAt: occurredAt },
  }
  const superseded: LiveMemoryVersion = {
    ...current,
    status: 'superseded',
    supersededByMemoryVersionId: tombstone.memoryVersionId,
    transactionTime: { ...current.transactionTime, retiredAt: occurredAt },
  }
  assertCore(superseded)
  assertCore(tombstone)
  database.prepare(`
    UPDATE personalization_memory_versions SET status = ?, record_json = ?
    WHERE memory_version_id = ?
  `).run(superseded.status, canonicalJson(superseded), current.memoryVersionId)
  database.prepare(`
    INSERT INTO personalization_memory_versions(
      memory_version_id, chain_id, version, status, record_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    tombstone.memoryVersionId,
    tombstone.chainId,
    tombstone.version,
    tombstone.status,
    canonicalJson(tombstone),
  )
  database.prepare(`
    UPDATE personalization_memory_chains
    SET current_memory_version_id = ?, current_version = ? WHERE chain_id = ?
  `).run(tombstone.memoryVersionId, tombstone.version, tombstone.chainId)
  return tombstone
}

function retractPendingDecisions(database: DatabaseSync, memoryIds: Set<string>): void {
  for (const decision of listDecisions(database)) {
    if (
      decision.memoryVersionIds.some(id => memoryIds.has(id))
      && readRow(
        database,
        'SELECT memory_use_id FROM personalization_memory_uses WHERE decision_id = ? LIMIT 1',
        decision.decisionId,
      ) === undefined
    ) {
      database.prepare('DELETE FROM personalization_decisions WHERE decision_id = ?').run(decision.decisionId)
    }
  }
}

function requireCurrentMemory(
  database: DatabaseSync,
  memoryVersionId: string,
  expectedVersion: number,
): LiveMemoryVersion {
  const row = readRow(database, `
    SELECT v.record_json, c.current_memory_version_id, c.current_version
    FROM personalization_memory_versions v
    JOIN personalization_memory_chains c ON c.chain_id = v.chain_id
    WHERE v.memory_version_id = ?
  `, memoryVersionId)
  if (row === undefined) throw new PersonalizationStoreError('not-found', 'memory version is unavailable')
  if (
    stringColumn(row, 'current_memory_version_id') !== memoryVersionId
    || integerColumn(row, 'current_version') !== expectedVersion
  ) {
    throw new PersonalizationStoreError('conflict', 'memory compare-and-set failed')
  }
  const memory = parseCoreJson<MemoryVersion>(stringColumn(row, 'record_json'))
  if (memory.status === 'deleted') throw new PersonalizationStoreError('conflict', 'memory was forgotten')
  return memory
}

function assertNoDuplicateCurrentEffect(
  database: DatabaseSync,
  draft: EditableMemoryDraft,
  excludingChainId: string | undefined,
): void {
  const duplicate = listCurrentMemories(database).find(memory => (
    memory.status !== 'deleted'
    && memory.chainId !== excludingChainId
    && memory.effect.key === draft.effect.key
    && canonicalJson(memory.scope) === canonicalJson(draft.scope)
  ))
  if (duplicate !== undefined) {
    throw new PersonalizationStoreError(
      'conflict',
      'an active preference already owns this effect and scope; edit that chain instead',
    )
  }
}

function copyTransactionGuard(guard: PersonalizationTransactionGuard): PersonalizationTransactionGuard {
  if (!guard || !Number.isSafeInteger(guard.expectedProfileEpoch) || guard.expectedProfileEpoch < 0
    || guard.expectedPolicyVersion !== undefined && (!Number.isSafeInteger(guard.expectedPolicyVersion) || guard.expectedPolicyVersion < 1)
    || typeof guard.assertCurrent !== 'function') {
    throw new PersonalizationStoreError('invalid-request', 'A controlled preference write requires a valid synchronous host fence')
  }
  return { expectedProfileEpoch: guard.expectedProfileEpoch, ...(guard.expectedPolicyVersion === undefined ? {} : { expectedPolicyVersion: guard.expectedPolicyVersion }), assertCurrent: guard.assertCurrent }
}

function assertTransactionGuard(database: DatabaseSync, sessionId: string, guard: PersonalizationTransactionGuard, contribution: boolean): void {
  assertSynchronousAuthorization(guard.assertCurrent)
  if (metadata(database).profileEpoch !== guard.expectedProfileEpoch) {
    throw new PersonalizationStoreError('conflict', 'Profile epoch changed after privacy erasure')
  }
  if (contribution) {
    const policy = readSessionPolicy(database, sessionId)
    if (!policy || !policy.contributeToFuture) throw new PersonalizationStoreError('permission-denied', 'The original session no longer permits contribution to future personalization')
    if (guard.expectedPolicyVersion !== undefined && policy.version !== guard.expectedPolicyVersion) {
      throw new PersonalizationStoreError('conflict', 'The original session contribution policy version changed')
    }
  }
}

function assertSynchronousAuthorization(assertCurrent: () => void): void {
  const result: unknown = assertCurrent()
  if (result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function') {
    void Promise.resolve(result).catch(() => {})
    throw new PersonalizationStoreError('invalid-request', 'Preference authorization must be synchronous')
  }
}

interface LearningStoredReceipt {
  receipt: LearningReceipt
  inputHash: string
  original?: LearningAnswerRef
  choiceObservationId?: string
  observationId?: string
  eligible?: boolean
  review?: LearningReviewInput
}
const learningGroupId = (profileId: string, epoch: number, workspaceId: string, mode: LearningMode) => `learning-group:${sha256(canonicalJson([profileId, epoch, workspaceId, 'answer-order', mode]))}`
const learningCandidateId = (groupId: string) => `learning-candidate:${sha256(groupId)}`
const learningOperationId = (command: LearningCommandIdentity) => `learning-op:${sha256(canonicalJson([command.actorId, command.workspaceId, command.conversationId, command.idempotencyKey]))}`
const learningReceiptEventId = (operationId: string) => deterministicId('event', 'learning.command.committed', operationId)

function validateLearningCommand(value: LearningCommandIdentity): void {
  if (!objectValue(value) || Object.keys(value).sort().join(',') !== 'actorId,bindingId,conversationId,generation,idempotencyKey,requestHash,workspaceId'
    || ![value.actorId, value.workspaceId, value.conversationId, value.bindingId, value.idempotencyKey].every(opaqueId)
    || value.idempotencyKey.length < 16 || !digestValue(value.requestHash) || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new PersonalizationStoreError('invalid-request', 'Invalid complete learning command identity')
  }
}
function validateLearningOriginal(value: LearningAnswerRef): void {
  if (!objectValue(value) || Object.keys(value).sort().join(',') !== 'conversationId,investigationId,manifestId,materialHash,messageId,mode,nativeTextHash,probeId,profileEpoch,sourceScopeVersionId,turn,workspaceId'
    || ![value.probeId, value.workspaceId, value.conversationId, value.messageId, value.manifestId, value.investigationId, value.sourceScopeVersionId].every(opaqueId)
    || !/^learning-probe:[a-f0-9]{64}$/u.test(value.probeId) || !digestValue(value.materialHash) || !digestValue(value.nativeTextHash)
    || !Number.isSafeInteger(value.profileEpoch) || value.profileEpoch < 0 || !Number.isSafeInteger(value.turn) || value.turn < 0
    || !['explore', 'verify', 'publish'].includes(value.mode)) throw new PersonalizationStoreError('invalid-request', 'Invalid reference-only learning Answer identity')
}
function assertLearningCommandOrigin(command: LearningCommandIdentity, original: LearningAnswerRef): void {
  if (command.conversationId !== original.conversationId || command.workspaceId !== original.workspaceId) throw new PersonalizationStoreError('invalid-request', 'Learning command must retain its original Answer conversation')
}
function assertLearningProbeOriginal(probe: PreferenceProbe, original: LearningAnswerRef, profileId: string, epoch: number): void {
  validateLearningOriginal(original)
  if (personalizationCoreIssues(probe).length || probe.profileId !== profileId || probe.probeId !== original.probeId || original.profileEpoch !== epoch
    || probe.trigger !== 'user-requested' || probe.axis !== 'answer-order' || probe.sessionId !== original.conversationId || probe.turn !== original.turn
    || probe.investigationId !== original.investigationId || probe.taskContext.investigationId !== original.investigationId
    || probe.taskContext.workspaceId !== original.workspaceId || probe.taskContext.mode !== original.mode
    || probe.backbone.sourceScopeVersionId !== original.sourceScopeVersionId || probe.backbone.factTraceDigest !== original.materialHash
    || probe.variants.some(variant => variant.effect.key !== 'answer-order' || !['conclusion-first', 'evidence-first'].includes(variant.effect.value))) {
    throw new PersonalizationStoreError('integrity-error', 'Learning Probe no longer matches its exact original Answer')
  }
  const expected = `learning-probe:${sha256(canonicalJson([profileId, epoch, original.conversationId, original.messageId, original.manifestId, original.materialHash, 'answer-order:learning:v1']))}`
  if (probe.probeId !== expected) throw new PersonalizationStoreError('integrity-error', 'Learning Probe stable identity changed')
  for (const [variantKey, effectValue, sections] of [
    ['variant:answer-first', 'conclusion-first', ['answer', 'evidence']],
    ['variant:evidence-first', 'evidence-first', ['evidence', 'answer']],
  ] as const) {
    const variant = probe.variants.find(item => item.variantKey === variantKey)
    if (!variant || variant.effect.value !== effectValue || variant.artifactId !== `presentation:${sha256(canonicalJson({ materialHash: original.materialHash, recipeVersion: 1, sections }))}`) {
      throw new PersonalizationStoreError('integrity-error', 'Learning comparison recipe changed')
    }
  }
}
function copyLearningGuard(value: LearningGuard): LearningGuard {
  const guard = copyTransactionGuard(value)
  if (typeof value.authorizeOrigins !== 'function') throw new PersonalizationStoreError('invalid-request', 'Learning requires synchronous original-publication authority')
  return { ...guard, authorizeOrigins: value.authorizeOrigins }
}
function assertLearningRead(database: DatabaseSync | undefined, guard: LearningGuard): void {
  assertSynchronousAuthorization(guard.assertCurrent)
  if ((database ? metadata(database).profileEpoch : 0) !== guard.expectedProfileEpoch) throw new PersonalizationStoreError('conflict', 'Learning profile erasure epoch changed')
}
function authorizeLearningOrigins(guard: LearningGuard, originals: readonly LearningAnswerRef[]): boolean {
  if (originals.length > MAX_LEARNING_MEMBERS) return false
  const frozen = structuredClone(originals), identity = canonicalJson(frozen)
  const result: unknown = guard.authorizeOrigins(frozen)
  if (typeof result !== 'boolean' || canonicalJson(frozen) !== identity) throw new PersonalizationStoreError('invalid-request', 'Learning publication checks must be synchronous and cannot change original references')
  assertSynchronousAuthorization(guard.assertCurrent)
  return result
}
function makeLearningReceipt(profileId: string, epoch: number, command: LearningCommandIdentity, action: LearningReceipt['action'], committedAt: string, targetId: string, targetVersion: number): LearningReceipt {
  return { schemaVersion: 1, operationId: learningOperationId(command), profileId, profileEpoch: epoch, command: structuredClone(command), action,
    committedAt, targetId, targetVersion, groupId: null, candidateId: null, memoryVersionId: null }
}
function appendLearningEvent(database: DatabaseSync, eventType: string, aggregateId: string, aggregateVersion: number, occurredAt: string, actorId: string, payload: unknown, operationId?: string): void {
  appendJournal(database, { eventId: deterministicId('event', eventType, aggregateId, String(aggregateVersion)), aggregateType: 'preference-learning', aggregateId,
    aggregateVersion, eventType, actorKind: actorId === 'rule:consented-learning' ? 'rule' : 'user', actorId, occurredAt,
    ...(operationId === undefined ? {} : { idempotencyKey: operationId }), payload })
}
function appendLearningReceipt(database: DatabaseSync, stored: LearningStoredReceipt): void {
  const receipt = stored.receipt
  if (Buffer.byteLength(canonicalJson(stored)) > 32768) throw new PersonalizationStoreError('limit-exceeded', 'Learning receipt metadata exceeds its bound')
  appendJournal(database, { eventId: learningReceiptEventId(receipt.operationId), aggregateType: 'preference-learning', aggregateId: receipt.targetId,
    aggregateVersion: receipt.targetVersion, eventType: 'learning.command.committed', actorKind: 'user', actorId: receipt.command.actorId,
    occurredAt: receipt.committedAt, idempotencyKey: receipt.operationId, payload: stored })
}
function learningSettingsRaw(database: DatabaseSync, profileId: string): LearningSettings {
  const row = readRow(database, "SELECT * FROM personalization_journal WHERE event_type='learning.settings.recorded' ORDER BY event_seq DESC LIMIT 1")
  if (!row) return { version: 0, enabled: false }
  const value = checkedJournalPayload(row)
  if (!objectValue(value) || Object.keys(value).sort().join(',') !== 'operationId,profileEpoch,profileId,schemaVersion,settings' || value.schemaVersion !== 1 || value.profileId !== profileId
    || value.profileEpoch !== metadata(database).profileEpoch || !objectValue(value.settings) || Object.keys(value.settings).sort().join(',') !== 'enabled,version'
    || !Number.isSafeInteger(value.settings.version) || Number(value.settings.version) < 1 || typeof value.settings.enabled !== 'boolean'
    || value.settings.version !== row.aggregate_version || !opaqueId(value.operationId)
    || row.idempotency_key !== value.operationId) throw new PersonalizationStoreError('integrity-error', 'Learning invitation settings journal is invalid')
  const receipt = readLearningReceipt(database, profileId, value.operationId)
  if (!receipt || receipt.receipt.action !== 'settings' || receipt.receipt.targetVersion !== value.settings.version) throw new PersonalizationStoreError('integrity-error', 'Learning invitation settings lost their transactional receipt')
  return structuredClone(value.settings) as unknown as LearningSettings
}
function learningOffersRaw(database: DatabaseSync): LearningOffer[] {
  const current = new Map<string, LearningOffer>()
  for (const row of readRows(database, "SELECT * FROM personalization_journal WHERE event_type='learning.offer.recorded' ORDER BY event_seq")) {
    const value = checkedJournalPayload(row)
    if (!objectValue(value) || Object.keys(value).some(key => !['schemaVersion', 'offer', 'operationId'].includes(key)) || value.schemaVersion !== 1 || !objectValue(value.offer)) throw new PersonalizationStoreError('integrity-error', 'Learning invitation journal is invalid')
    const offer = value.offer as unknown as LearningOffer
    validateLearningOriginal(offer.original)
    if (Object.keys(offer).sort().join(',') !== 'createdAt,offerId,original,profileEpoch,profileId,status,updatedAt,version' || offer.profileId !== metadata(database).profileId
      || offer.profileEpoch !== metadata(database).profileEpoch || offer.original.profileEpoch !== offer.profileEpoch
      || offer.offerId !== `learning-offer:${sha256(canonicalJson([offer.profileId, offer.profileEpoch, offer.original.investigationId]))}`
      || offer.offerId !== row.aggregate_id || offer.version !== row.aggregate_version || !Number.isFinite(Date.parse(offer.createdAt)) || !Number.isFinite(Date.parse(offer.updatedAt))
      || offer.updatedAt !== row.occurred_at || ![1, 2].includes(offer.version) || (offer.version === 1 ? offer.status !== 'offered' || offer.createdAt !== offer.updatedAt : offer.status !== 'dismissed')) {
      throw new PersonalizationStoreError('integrity-error', 'Learning invitation identity or version is invalid')
    }
    const previous = current.get(offer.offerId)
    if (offer.version !== (previous?.version ?? 0) + 1 || previous && (canonicalJson(previous.original) !== canonicalJson(offer.original) || previous.createdAt !== offer.createdAt)) throw new PersonalizationStoreError('integrity-error', 'Learning invitation history is inconsistent')
    current.set(offer.offerId, structuredClone(offer))
    if (current.size > MAX_PROBES) throw new PersonalizationStoreError('integrity-error', 'Learning invitation retention bound changed')
  }
  return [...current.values()]
}
function readLearningReceipt(database: DatabaseSync, profileId: string, operationId: string): LearningStoredReceipt | undefined {
  if (!/^learning-op:[a-f0-9]{64}$/u.test(operationId)) throw new PersonalizationStoreError('invalid-request', 'Invalid original learning operation identity')
  const row = readRow(database, "SELECT * FROM personalization_journal WHERE event_id=? AND event_type='learning.command.committed'", learningReceiptEventId(operationId))
  return row ? verifyLearningReceiptRow(database, profileId, row) : undefined
}
function learningReplay(database: DatabaseSync, profileId: string, command: LearningCommandIdentity, action: LearningReceipt['action'], epoch: number): LearningStoredReceipt | undefined {
  const value = readLearningReceipt(database, profileId, learningOperationId(command))
  if (value && (value.receipt.profileEpoch !== epoch || value.receipt.action !== action || canonicalJson(value.receipt.command) !== canonicalJson(command))) {
    throw new PersonalizationStoreError('conflict', 'Original learning key was committed for a different complete command')
  }
  return value
}
function assertLearningReplayInput(stored: LearningStoredReceipt, input: unknown): void {
  if (stored.inputHash !== sha256(canonicalJson(input))) throw new PersonalizationStoreError('conflict', 'Original learning operation input changed despite its supplied command hash')
}
function verifyLearningReceiptRow(database: DatabaseSync, profileId: string, row: Record<string, unknown>): LearningStoredReceipt {
  const payload = checkedJournalPayload(row)
  if (!objectValue(payload) || Object.keys(payload).some(key => !['receipt', 'inputHash', 'original', 'choiceObservationId', 'observationId', 'eligible', 'review'].includes(key))
    || !objectValue(payload.receipt) || !digestValue(payload.inputHash) || Buffer.byteLength(canonicalJson(payload)) > 32768) throw new PersonalizationStoreError('integrity-error', 'Learning command receipt is invalid')
  const receipt = payload.receipt as unknown as LearningReceipt
  validateLearningCommand(receipt.command)
  if (Object.keys(receipt).sort().join(',') !== 'action,candidateId,command,committedAt,groupId,memoryVersionId,operationId,profileEpoch,profileId,schemaVersion,targetId,targetVersion'
    || receipt.schemaVersion !== 1 || receipt.profileId !== profileId || receipt.profileEpoch !== metadata(database).profileEpoch
    || receipt.operationId !== learningOperationId(receipt.command) || receipt.operationId !== row.idempotency_key || row.event_id !== learningReceiptEventId(receipt.operationId)
    || row.aggregate_id !== receipt.targetId || row.aggregate_version !== receipt.targetVersion || row.actor_kind !== 'user' || row.actor_id !== receipt.command.actorId
    || row.occurred_at !== receipt.committedAt || !Number.isFinite(Date.parse(receipt.committedAt)) || !opaqueId(receipt.targetId) || !Number.isSafeInteger(receipt.targetVersion) || receipt.targetVersion < 1
    || !['settings', 'prepare', 'choice', 'review', 'dismiss'].includes(receipt.action)
    || ![receipt.groupId, receipt.candidateId, receipt.memoryVersionId].every(value => value === null || opaqueId(value))) throw new PersonalizationStoreError('integrity-error', 'Learning receipt identity changed')
  const stored = structuredClone(payload) as unknown as LearningStoredReceipt
  if (stored.original) { validateLearningOriginal(stored.original); if (stored.original.profileEpoch !== receipt.profileEpoch) throw new PersonalizationStoreError('integrity-error', 'Learning original epoch changed') }
  if (receipt.action === 'prepare' || receipt.action === 'choice') {
    if (!stored.original) throw new PersonalizationStoreError('integrity-error', 'Learning receipt lost its original Answer')
    assertLearningCommandOrigin(receipt.command, stored.original)
    const probe = readExactProbe(database, profileId, stored.original.probeId)
    if (!probe) throw new PersonalizationStoreError('integrity-error', 'Learning receipt lost its controlled Probe')
    assertLearningProbeOriginal(probe, stored.original, profileId, receipt.profileEpoch)
    if (receipt.action === 'prepare') {
      if (receipt.targetId !== probe.probeId || receipt.targetVersion !== 1 || receipt.groupId !== null || receipt.candidateId !== null || receipt.memoryVersionId !== null
        || stored.inputHash !== sha256(canonicalJson({ probe, original: stored.original, command: receipt.command }))) throw new PersonalizationStoreError('integrity-error', 'Learning preparation receipt is inconsistent')
    } else {
      const choice = stored.choiceObservationId ? readExactChoice(database, profileId, stored.choiceObservationId) : undefined
      const observation = stored.observationId ? readExactObservation(database, profileId, stored.observationId) : undefined
      if (!choice || !observation || receipt.targetId !== choice.choiceObservationId || receipt.targetVersion !== 1 || observation.lineageKey !== stored.original.investigationId
        || observation.observedActor.actorId !== receipt.command.actorId || canonicalJson(originalCoreEvent(database, 'observation.recorded', observation.observationId)) !== canonicalJson(observation)) throw new PersonalizationStoreError('integrity-error', 'Learning receipt lost its exact user choice')
      assertControlledChoice({ command: { idempotencyKey: receipt.command.idempotencyKey, requestHash: receipt.command.requestHash }, choice, observation }, probe)
      const eligible = choice.scopeIntent === 'workspace' && choice.consent.retention === 'eligible'
      const groupId = learningGroupId(profileId, receipt.profileEpoch, stored.original.workspaceId, stored.original.mode)
      if (stored.eligible !== eligible || receipt.groupId !== (eligible ? groupId : null) || receipt.memoryVersionId !== null
        || receipt.candidateId !== null && receipt.candidateId !== learningCandidateId(groupId)
        || sha256(canonicalJson({ command: receipt.command, choice, observation, original: stored.original })) !== stored.inputHash) throw new PersonalizationStoreError('integrity-error', 'Learning choice complete input or scope changed')
      if (receipt.candidateId) {
        const candidate = originalCoreEvent<MemoryCandidate>(database, 'candidate.recorded', receipt.candidateId)
        if (candidate.profileId !== profileId || candidate.version !== 1 || candidate.decision !== 'pending' || candidate.formation !== 'preference-probe') throw new PersonalizationStoreError('integrity-error', 'Learning candidate origin changed')
      }
    }
  } else if (receipt.action === 'settings') {
    const event = readRow(database, "SELECT * FROM personalization_journal WHERE event_type='learning.settings.recorded' AND idempotency_key=?", receipt.operationId)
    const value = event ? checkedJournalPayload(event) : undefined
    if (!objectValue(value) || !objectValue(value.settings) || value.profileId !== profileId || value.profileEpoch !== receipt.profileEpoch || value.operationId !== receipt.operationId
      || value.settings.version !== receipt.targetVersion || typeof value.settings.enabled !== 'boolean' || receipt.targetId !== `learning-settings:${sha256(profileId).slice(0, 32)}`
      || receipt.groupId !== null || receipt.candidateId !== null || receipt.memoryVersionId !== null
      || stored.inputHash !== sha256(canonicalJson({ command: receipt.command, expectedVersion: receipt.targetVersion - 1, enabled: value.settings.enabled }))) throw new PersonalizationStoreError('integrity-error', 'Learning setting receipt has no matching effect')
  } else if (receipt.action === 'dismiss') {
    const offer = learningOffersRaw(database).find(value => value.offerId === receipt.targetId)
    if (!offer || offer.version !== receipt.targetVersion || offer.status !== 'dismissed' || !stored.original || canonicalJson(offer.original) !== canonicalJson(stored.original)
      || receipt.groupId !== null || receipt.candidateId !== null || receipt.memoryVersionId !== null
      || stored.inputHash !== sha256(canonicalJson({ offerId: receipt.targetId, expectedOfferVersion: receipt.targetVersion - 1, command: receipt.command }))) throw new PersonalizationStoreError('integrity-error', 'Invitation dismissal receipt has no matching effect')
    assertLearningCommandOrigin(receipt.command, stored.original)
  } else {
    if (!stored.review || sha256(canonicalJson(stored.review)) !== stored.inputHash || !digestValue(stored.review.expectedGroupDigest) || !['accept', 'reject'].includes(stored.review.decision) || canonicalJson(stored.review.command) !== canonicalJson(receipt.command)
      || stored.review.candidateId !== receipt.targetId || stored.review.groupId !== receipt.groupId || receipt.candidateId !== receipt.targetId
      || stored.review.expectedCandidateVersion + 1 !== receipt.targetVersion) throw new PersonalizationStoreError('integrity-error', 'Accumulated candidate review receipt is invalid')
    const resultRow = readRow(database, 'SELECT result_json FROM personalization_idempotency WHERE idempotency_key=?', receipt.operationId)
    const result = resultRow ? parseCommandResult(stringColumn(resultRow, 'result_json')) : undefined
    if (!result || result.action !== 'review-candidate' || result.candidate.candidateId !== receipt.candidateId || result.candidate.version !== receipt.targetVersion
      || (result.memoryVersion?.memoryVersionId ?? null) !== receipt.memoryVersionId) throw new PersonalizationStoreError('integrity-error', 'Learning review lost its domain effect')
  }
  return stored
}
function learningPreparedOriginal(database: DatabaseSync, profileId: string, probeId: string): LearningAnswerRef | undefined {
  const rows = readRows(database, "SELECT * FROM personalization_journal WHERE event_type='learning.command.committed' AND json_extract(payload_json,'$.receipt.action')='prepare' AND aggregate_id=? ORDER BY event_seq", probeId)
  let original: LearningAnswerRef | undefined
  for (const row of rows) {
    const value = verifyLearningReceiptRow(database, profileId, row).original
    if (!value || original && canonicalJson(value) !== canonicalJson(original)) throw new PersonalizationStoreError('integrity-error', 'Learning Probe has inconsistent original Answer references')
    original = value
  }
  return original
}
function learningMember(database: DatabaseSync, profileId: string, stored: LearningStoredReceipt): LearningMember | undefined {
  if (stored.receipt.action !== 'choice' || stored.eligible !== true) return undefined
  const choice = readExactChoice(database, profileId, stored.choiceObservationId!)!, probe = readExactProbe(database, profileId, stored.original!.probeId)!
  const variant = probe.variants.find(value => value.variantKey === choice.selected)
  if (!variant || variant.effect.key !== 'answer-order') throw new PersonalizationStoreError('integrity-error', 'Learning selection no longer resolves to its controlled axis')
  return { original: stored.original!, choiceObservationId: choice.choiceObservationId, observationId: stored.observationId!, selectedValue: variant.effect.value }
}
function learningStateRaw(database: DatabaseSync | undefined, profileId: string, workspaceId: string, mode: LearningMode, guard: LearningGuard, pending?: LearningStoredReceipt): LearningState {
  const groupId = learningGroupId(profileId, guard.expectedProfileEpoch, workspaceId, mode)
  const state: LearningState = { groupId, profileEpoch: guard.expectedProfileEpoch, workspaceId, axis: 'answer-order', mode, status: 'collecting', suppression: null,
    members: [], independentCounts: { 'conclusion-first': 0, 'evidence-first': 0 }, candidate: null, groupDigest: null }
  const unavailable = () => ({ ...state, status: 'unavailable' as const, members: [], independentCounts: null, candidate: null, groupDigest: null })
  if (!database) { state.groupDigest = sha256(canonicalJson(state)); return state }
  // Enumerating only successful receipt projections must not erase a real opposing choice.
  // The one choice currently being committed is the sole legitimate not-yet-receipted row.
  const uncovered = readRow(database, `SELECT c.choice_id FROM personalization_choices c
    JOIN personalization_probes p ON p.probe_id=c.probe_id
    WHERE p.probe_id LIKE 'learning-probe:%' AND json_extract(p.record_json,'$.taskContext.workspaceId')=?
      AND json_extract(p.record_json,'$.taskContext.mode')=? AND c.choice_id<>?
      AND NOT EXISTS (SELECT 1 FROM personalization_journal j WHERE j.event_type='learning.command.committed'
        AND json_extract(j.payload_json,'$.receipt.action')='choice'
        AND json_extract(j.payload_json,'$.choiceObservationId')=c.choice_id
        AND json_extract(j.payload_json,'$.original.probeId')=p.probe_id
        AND json_extract(j.payload_json,'$.original.workspaceId')=? AND json_extract(j.payload_json,'$.original.mode')=?
        AND json_extract(j.payload_json,'$.eligible')=CASE WHEN json_extract(c.record_json,'$.scopeIntent')='workspace'
          AND json_extract(c.record_json,'$.consent.retention')='eligible' THEN 1 ELSE 0 END
        AND (CASE WHEN json_extract(j.payload_json,'$.eligible')=1 THEN json_extract(j.payload_json,'$.receipt.groupId')=?
          ELSE json_extract(j.payload_json,'$.receipt.groupId') IS NULL END)) LIMIT 1`,
  workspaceId, mode, pending?.choiceObservationId ?? '', workspaceId, mode, groupId)
  if (uncovered) throw new PersonalizationStoreError('integrity-error', 'Learning group has an unreceipted or mismatched choice; counterexamples cannot be filtered out')
  const rows = readRows(database, "SELECT * FROM personalization_journal WHERE event_type='learning.command.committed' AND json_extract(payload_json,'$.receipt.action')='choice' AND json_extract(payload_json,'$.eligible')=1 AND json_extract(payload_json,'$.receipt.groupId')=? ORDER BY event_seq LIMIT 65", groupId)
  if (rows.length + (pending ? 1 : 0) > MAX_LEARNING_MEMBERS) return unavailable()
  for (const row of rows) { const member = learningMember(database, profileId, verifyLearningReceiptRow(database, profileId, row)); if (member) state.members.push(member) }
  if (pending) { const member = learningMember(database, profileId, pending); if (member) state.members.push(member) }
  if (!authorizeLearningOrigins(guard, state.members.map(member => member.original))) return unavailable()
  for (const member of state.members) if (member.original.profileEpoch !== guard.expectedProfileEpoch || member.original.workspaceId !== workspaceId || member.original.mode !== mode) throw new PersonalizationStoreError('integrity-error', 'Learning member crossed its original group')
  state.independentCounts = { 'conclusion-first': new Set(state.members.filter(member => member.selectedValue === 'conclusion-first').map(member => member.original.investigationId)).size,
    'evidence-first': new Set(state.members.filter(member => member.selectedValue === 'evidence-first').map(member => member.original.investigationId)).size }
  state.candidate = readJsonRow<MemoryCandidate>(database, 'SELECT record_json FROM personalization_candidates WHERE candidate_id=?', learningCandidateId(groupId)) ?? null
  const applies = (scope: PersonalizationScope) => scope.kind === 'global' || 'workspaceId' in scope && scope.workspaceId === workspaceId
  const currentMemories = listCurrentMemories(database), deletedChains = new Set(currentMemories.filter(memory => memory.status === 'deleted').map(memory => memory.chainId))
  const memories = currentMemories.filter(memory => memory.status !== 'deleted' && memory.effect.key === 'answer-order' && applies(memory.scope))
  const forgotten = listMemoryVersions(database).some(memory => memory.status !== 'deleted' && memory.effect.key === 'answer-order' && applies(memory.scope)
    && deletedChains.has(memory.chainId))
  const otherCandidate = listCandidates(database).find(candidate => candidate.candidateId !== state.candidate?.candidateId && candidate.proposedEffect.key === 'answer-order' && applies(candidate.proposedScope))
  if (forgotten) { state.status = 'suppressed'; state.suppression = 'forgotten'; state.members = []; state.independentCounts = null; state.candidate = null }
  else if (memories.length) { state.status = 'suppressed'; state.suppression = 'existing-preference' }
  else if (state.candidate && !['pending', 'needs-review'].includes(state.candidate.decision)) { state.status = 'suppressed'; state.suppression = 'decided-candidate' }
  else if (otherCandidate) { state.status = 'suppressed'; state.suppression = 'existing-candidate' }
  else if (state.independentCounts['conclusion-first'] && state.independentCounts['evidence-first']) state.status = 'conflicted'
  else if (state.candidate) state.status = 'pending'
  state.groupDigest = sha256(canonicalJson(state))
  return state
}
function authorizeLearningReceipt(database: DatabaseSync, stored: LearningStoredReceipt, guard: LearningGuard): void {
  assertLearningRead(database, guard)
  if (stored.receipt.profileEpoch !== guard.expectedProfileEpoch) throw new PersonalizationStoreError('conflict', 'Original learning receipt belongs to an erased profile epoch')
  if (stored.original && !authorizeLearningOrigins(guard, [stored.original])) throw new PersonalizationStoreError('permission-denied', 'Original learning Answer is unavailable')
  if (stored.receipt.groupId) {
    const mode = (['explore', 'verify', 'publish'] as const).find(value => learningGroupId(stored.receipt.profileId, guard.expectedProfileEpoch, stored.receipt.command.workspaceId, value) === stored.receipt.groupId)
    if (!mode || learningStateRaw(database, stored.receipt.profileId, stored.receipt.command.workspaceId, mode, guard).status === 'unavailable') throw new PersonalizationStoreError('permission-denied', 'The complete original learning group is unavailable')
  }
  assertLearningRead(database, guard)
}

function verifyLearningLedger(database: DatabaseSync, profileId: string): LearningStoredReceipt[] {
  const rows = readRows(database, "SELECT * FROM personalization_journal WHERE event_type LIKE 'learning.%' ORDER BY event_seq")
  const receipts: Array<{ value: LearningStoredReceipt, sequence: number }> = []
  const receiptIds = new Set<string>(), prepared = new Set<string>(), chosen = new Set<string>(), candidates = new Map<string, { value: LearningStoredReceipt, sequence: number }>()
  let settingsVersion = 0
  for (const row of rows) {
    const type = stringColumn(row, 'event_type')
    if (!['learning.settings.recorded', 'learning.offer.recorded', 'learning.command.committed'].includes(type)) throw new PersonalizationStoreError('integrity-error', 'Unsupported learning journal event')
    if (type === 'learning.command.committed') {
      const value = verifyLearningReceiptRow(database, profileId, row), sequence = integerColumn(row, 'event_seq')
      if (receiptIds.has(value.receipt.operationId)) throw new PersonalizationStoreError('integrity-error', 'Learning operation receipt is duplicated')
      receiptIds.add(value.receipt.operationId); receipts.push({ value, sequence })
      if (value.receipt.action === 'prepare') prepared.add(value.original!.probeId)
      if (value.receipt.action === 'choice') {
        if (chosen.has(value.original!.probeId)) throw new PersonalizationStoreError('integrity-error', 'A learning comparison has multiple durable choices')
        chosen.add(value.original!.probeId)
        if (value.receipt.candidateId) {
          if (candidates.has(value.receipt.candidateId)) throw new PersonalizationStoreError('integrity-error', 'Learning group created its candidate more than once')
          candidates.set(value.receipt.candidateId, { value, sequence })
        }
      }
    } else if (type === 'learning.settings.recorded') {
      const value = checkedJournalPayload(row)
      if (!objectValue(value) || value.schemaVersion !== 1 || value.profileId !== profileId || value.profileEpoch !== metadata(database).profileEpoch
        || !objectValue(value.settings) || value.settings.version !== ++settingsVersion || typeof value.settings.enabled !== 'boolean'
        || row.aggregate_version !== settingsVersion || value.operationId !== row.idempotency_key) throw new PersonalizationStoreError('integrity-error', 'Learning setting version chain changed')
    }
  }
  learningSettingsRaw(database, profileId)
  const offers = learningOffersRaw(database), automatic = new Set(readRows(database, 'SELECT investigation_id FROM personalization_probes WHERE automatic=1').map(row => stringColumn(row, 'investigation_id')))
  const invitations = [...offers].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  for (const [index, offer] of invitations.entries()) {
    if (automatic.has(offer.original.investigationId) || index > 0 && Date.parse(offer.createdAt) - Date.parse(invitations[index - 1]!.createdAt) < LEARNING_INVITATION_COOLDOWN_MS) throw new PersonalizationStoreError('integrity-error', 'Automatic learning reservation or cooldown was violated')
  }
  for (const row of rows.filter(row => row.event_type !== 'learning.command.committed')) {
    const value = checkedJournalPayload(row)
    if (objectValue(value) && typeof value.operationId === 'string' && !receiptIds.has(value.operationId)) throw new PersonalizationStoreError('integrity-error', 'Learning setting or dismissal lost its transactional receipt')
  }
  for (const probe of listProbes(database)) if (probe.probeId.startsWith('learning-probe:') && !prepared.has(probe.probeId)) throw new PersonalizationStoreError('integrity-error', 'Learning Probe lost its original preparation receipt')
  for (const choice of listChoices(database)) if (choice.probeId.startsWith('learning-probe:') && !chosen.has(choice.probeId)) throw new PersonalizationStoreError('integrity-error', 'Learning choice is a partial write without a receipt')
  for (const current of listCandidates(database).filter(candidate => candidate.candidateId.startsWith('learning-candidate:'))) {
    const creation = candidates.get(current.candidateId)
    if (!creation) throw new PersonalizationStoreError('integrity-error', 'Learning candidate has no controlled accumulation origin')
    const original = originalCoreEvent<MemoryCandidate>(database, 'candidate.recorded', current.candidateId)
    const members = receipts.filter(item => item.sequence <= creation.sequence && item.value.receipt.action === 'choice' && item.value.eligible
      && item.value.receipt.groupId === creation.value.receipt.groupId).map(item => learningMember(database, profileId, item.value)!)
    const selected = new Set(members.map(member => member.selectedValue)), lineages = new Set(members.map(member => member.original.investigationId))
    if (members.length > MAX_LEARNING_MEMBERS || lineages.size < 3 || selected.size !== 1 || original.proposedEffect.key !== 'answer-order'
      || !selected.has(original.proposedEffect.value) || original.independentLineageCount !== lineages.size
      || canonicalJson(original.observationIds) !== canonicalJson(members.map(member => member.observationId)) || original.counterObservationIds.length
      || original.proposedScope.kind !== 'workspace' || original.proposedScope.workspaceId !== creation.value.original!.workspaceId
      || original.risk !== 'low' || original.sensitivity !== 'ordinary' || original.proposedMemoryType !== 'presentation-preference') throw new PersonalizationStoreError('integrity-error', 'Learning candidate did not have three unopposed independent investigations')
    const reviews = receipts.filter(item => item.value.receipt.action === 'review' && item.value.receipt.candidateId === current.candidateId)
    if (reviews.length > 1 || current.version === 1 && canonicalJson(current) !== canonicalJson(original) || current.version > 1 && reviews.length !== 1) throw new PersonalizationStoreError('integrity-error', 'Learning candidate was modified outside its controlled review')
    if (reviews.length) {
      const row = readRow(database, 'SELECT result_json FROM personalization_idempotency WHERE idempotency_key=?', reviews[0]!.value.receipt.operationId)!
      const result = parseCommandResult(stringColumn(row, 'result_json'))
      if (result.action !== 'review-candidate' || canonicalJson(result.candidate) !== canonicalJson(current)) throw new PersonalizationStoreError('integrity-error', 'Learning candidate current projection differs from its reviewed version')
    }
  }
  return receipts.map(item => item.value)
}

const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const digestValue = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const objectValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseProbeChoiceCommit(input: ProbeChoiceCommit): ProbeChoiceCommit {
  if (!objectValue(input) || Object.keys(input).some(key => !['command', 'choice', 'observation', 'candidate'].includes(key))
    || !objectValue(input.command) || Object.keys(input.command).sort().join(',') !== 'idempotencyKey,requestHash'
    || !opaqueId(input.command.idempotencyKey) || !digestValue(input.command.requestHash)) {
    throw new PersonalizationStoreError('invalid-request', 'Invalid controlled preference command identity')
  }
  const value: ProbeChoiceCommit = { command: { idempotencyKey: input.command.idempotencyKey, requestHash: input.command.requestHash },
    choice: parseCore(input.choice, 'preference-choice-observation'), observation: parseCore(input.observation, 'personalization-observation'),
    ...(input.candidate === undefined ? {} : { candidate: parseCore(input.candidate, 'memory-candidate') }) }
  assertNoSecret(value)
  return structuredClone(value)
}

function choiceScope(probe: PreferenceProbe, intent: PreferenceChoiceObservation['scopeIntent']): PersonalizationScope {
  const { profileId, taskContext } = probe
  if (intent === 'global' || intent === 'turn' && !taskContext.workspaceId) return { kind: 'global', profileId }
  if (intent === 'turn' || intent === 'workspace') {
    if (!taskContext.workspaceId) throw new PersonalizationStoreError('invalid-request', 'Workspace preference requires the original probe workspace')
    return { kind: 'workspace', profileId, workspaceId: taskContext.workspaceId }
  }
  if (!taskContext.taskFamily) throw new PersonalizationStoreError('invalid-request', 'Task-family preference requires the original probe task family')
  return { kind: 'task-family', profileId, taskFamily: taskContext.taskFamily, ...(taskContext.workspaceId ? { workspaceId: taskContext.workspaceId } : {}) }
}

function assertControlledChoice(value: ProbeChoiceCommit, probe: PreferenceProbe): void {
  const { choice, observation, candidate } = value, reserved = ['both', 'neither', 'dismissed'].includes(choice.selected)
  const variant = probe.variants.find(item => item.variantKey === choice.selected), transient = choice.scopeIntent === 'turn' || reserved
  if (personalizationCoreIssues(choice, { probes: [probe] }).length || personalizationCoreIssues(observation, { choices: [choice] }).length
    || choice.profileId !== probe.profileId || choice.sessionId !== probe.sessionId || choice.turn !== probe.turn
    || choice.probeId !== probe.probeId || !reserved && !variant
    || observation.profileId !== probe.profileId || observation.sessionId !== probe.sessionId || observation.observedActor.kind !== 'user'
    || observation.signal !== 'pairwise-preference-choice' || observation.sourceRef.kind !== 'preference-probe'
    || observation.sourceRef.probeId !== probe.probeId || observation.detail.probeId !== probe.probeId
    || observation.detail.choiceObservationId !== choice.choiceObservationId || observation.detail.selected !== choice.selected
    || observation.occurredAt !== choice.occurredAt || canonicalJson(observation.taskContext) !== canonicalJson(probe.taskContext)
    || canonicalJson(observation.consent) !== canonicalJson(choice.consent)
    || canonicalJson(observation.scope) !== canonicalJson(choiceScope(probe, choice.scopeIntent))
    || observation.consent.retention !== (transient ? 'session-only' : 'eligible')) {
    throw new PersonalizationStoreError('invalid-request', 'Controlled choice and observation must share the exact original probe, scope, consent and user action')
  }
  if (candidate && (transient || !variant || candidate.profileId !== probe.profileId || candidate.version !== 1 || candidate.decision !== 'pending'
    || candidate.formation !== 'preference-probe' || candidate.rationaleCode !== 'controlled-probe-choice'
    || candidate.decidedAt !== undefined || candidate.decidedBy !== undefined || candidate.createdAt !== observation.occurredAt
    || canonicalJson(candidate.observationIds) !== canonicalJson([observation.observationId]) || candidate.independentLineageCount !== 1
    || candidate.counterObservationIds.length !== 0 || canonicalJson(candidate.proposedEffect) !== canonicalJson(variant.effect)
    || candidate.proposedEffect.key !== probe.axis || canonicalJson(candidate.proposedScope) !== canonicalJson(observation.scope)
    || personalizationCoreIssues(candidate, { observations: [observation] }).length)) {
    throw new PersonalizationStoreError('invalid-request', 'A controlled candidate must remain pending and derive only the selected axis and explicit scope from this eligible choice')
  }
}

interface ProbeChoiceReceipt {
  schemaVersion: 1
  receiptType: 'controlled-probe-choice'
  profileId: string
  probeId: string
  choiceObservationId: string
  observationId: string
  candidateId?: string
  command: { idempotencyKey: string, requestHash: string }
  inputHash: string
}

function probeChoiceEventId(profileId: string, idempotencyKey: string): string {
  return deterministicId('event', 'preference-choice.committed', profileId, idempotencyKey)
}

function checkedJournalPayload(row: Record<string, unknown>): unknown {
  let payload: unknown
  try { payload = JSON.parse(stringColumn(row, 'payload_json')) as unknown } catch {
    throw new PersonalizationStoreError('integrity-error', 'Preference journal payload is invalid')
  }
  const hashPayload = canonicalJson({ eventId: stringColumn(row, 'event_id'), aggregateType: stringColumn(row, 'aggregate_type'),
    aggregateId: stringColumn(row, 'aggregate_id'), aggregateVersion: integerColumn(row, 'aggregate_version'), eventType: stringColumn(row, 'event_type'),
    actorKind: stringColumn(row, 'actor_kind'), actorId: stringColumn(row, 'actor_id'), occurredAt: stringColumn(row, 'occurred_at'),
    idempotencyKey: nullableStringColumn(row, 'idempotency_key'), payload, previousHash: stringColumn(row, 'previous_hash') })
  if (sha256(hashPayload) !== stringColumn(row, 'event_hash')) throw new PersonalizationStoreError('integrity-error', 'Preference journal payload hash is invalid')
  return payload
}

function readProbeChoiceReceipt(database: DatabaseSync, profileId: string, probeId: string): ProbeChoiceReceipt | undefined {
  const rows = readRows(database, "SELECT * FROM personalization_journal WHERE event_type = 'preference-choice.committed' AND aggregate_id = ? LIMIT 2", probeId)
  if (!rows.length) return undefined
  if (rows.length !== 1) throw new PersonalizationStoreError('integrity-error', 'A controlled probe has multiple durable choices')
  const row = rows[0]!, value = checkedJournalPayload(row)
  if (!objectValue(value) || Object.keys(value).some(key => !['schemaVersion', 'receiptType', 'profileId', 'probeId', 'choiceObservationId', 'observationId', 'candidateId', 'command', 'inputHash'].includes(key))
    || value.schemaVersion !== 1 || value.receiptType !== 'controlled-probe-choice' || value.profileId !== profileId || value.probeId !== probeId
    || !opaqueId(value.choiceObservationId) || !opaqueId(value.observationId) || value.candidateId !== undefined && !opaqueId(value.candidateId)
    || !digestValue(value.inputHash) || !objectValue(value.command) || Object.keys(value.command).sort().join(',') !== 'idempotencyKey,requestHash'
    || !opaqueId(value.command.idempotencyKey) || !digestValue(value.command.requestHash)
    || stringColumn(row, 'aggregate_type') !== 'preference-probe' || integerColumn(row, 'aggregate_version') !== 1
    || stringColumn(row, 'event_id') !== probeChoiceEventId(profileId, value.command.idempotencyKey)
    || nullableStringColumn(row, 'idempotency_key') !== value.command.idempotencyKey) {
    throw new PersonalizationStoreError('integrity-error', 'Controlled preference receipt identity is invalid')
  }
  return structuredClone(value) as unknown as ProbeChoiceReceipt
}

function originalCoreEvent<T extends PersonalizationCoreValue>(database: DatabaseSync, eventType: string, id: string): T {
  const row = readRow(database, 'SELECT * FROM personalization_journal WHERE event_id = ?', deterministicId('event', eventType, id, '1'))
  if (!row || stringColumn(row, 'event_type') !== eventType || stringColumn(row, 'aggregate_id') !== id || integerColumn(row, 'aggregate_version') !== 1) {
    throw new PersonalizationStoreError('integrity-error', 'The original preference capture journal is unavailable')
  }
  const value = parseCoreJson<T>(canonicalJson(checkedJournalPayload(row)))
  if (value.recordType !== stringColumn(row, 'aggregate_type')) throw new PersonalizationStoreError('integrity-error', 'Preference capture record type changed')
  return value
}

function readExactProbe(database: DatabaseSync, profileId: string, probeId: string): PreferenceProbe | undefined {
  const value = readJsonRow<PreferenceProbe>(database, 'SELECT record_json FROM personalization_probes WHERE probe_id = ?', probeId)
  if (!value) return undefined
  if (value.recordType !== 'preference-probe' || value.profileId !== profileId || value.probeId !== probeId
    || canonicalJson(originalCoreEvent(database, 'preference-probe.recorded', probeId)) !== canonicalJson(value)) {
    throw new PersonalizationStoreError('integrity-error', 'Original preference probe identity changed')
  }
  assertCore(value); return structuredClone(value)
}

function readExactChoice(database: DatabaseSync, profileId: string, choiceId: string): PreferenceChoiceObservation | undefined {
  const value = readJsonRow<PreferenceChoiceObservation>(database, 'SELECT record_json FROM personalization_choices WHERE choice_id = ?', choiceId)
  if (!value) return undefined
  if (value.recordType !== 'preference-choice-observation' || value.profileId !== profileId || value.choiceObservationId !== choiceId
    || canonicalJson(originalCoreEvent(database, 'preference-choice.recorded', choiceId)) !== canonicalJson(value)) {
    throw new PersonalizationStoreError('integrity-error', 'Original preference choice identity changed')
  }
  assertCore(value); return structuredClone(value)
}

function readExactObservation(database: DatabaseSync, profileId: string, observationId: string): PersonalizationObservation | undefined {
  const value = readJsonRow<PersonalizationObservation>(database, 'SELECT record_json FROM personalization_observations WHERE observation_id = ?', observationId)
  if (!value) return undefined
  if (value.recordType !== 'personalization-observation' || value.profileId !== profileId || value.observationId !== observationId) {
    throw new PersonalizationStoreError('integrity-error', 'Original preference observation identity changed')
  }
  assertCore(value); return structuredClone(value)
}

function resolveProbeChoiceReceipt(database: DatabaseSync, receipt: ProbeChoiceReceipt): StoredProbeChoice {
  const probe = readExactProbe(database, receipt.profileId, receipt.probeId), choice = readExactChoice(database, receipt.profileId, receipt.choiceObservationId)
  const observation = readExactObservation(database, receipt.profileId, receipt.observationId)
  const candidate = receipt.candidateId ? originalCoreEvent<MemoryCandidate>(database, 'candidate.recorded', receipt.candidateId) : undefined
  if (!probe || !choice || !observation || canonicalJson(originalCoreEvent(database, 'observation.recorded', receipt.observationId)) !== canonicalJson(observation)
    || candidate && (candidate.recordType !== 'memory-candidate' || candidate.candidateId !== receipt.candidateId || candidate.profileId !== receipt.profileId)) {
    throw new PersonalizationStoreError('integrity-error', 'Controlled preference receipt lost its original captures')
  }
  const input: ProbeChoiceCommit = { command: receipt.command, choice, observation, ...(candidate ? { candidate } : {}) }
  if (sha256(canonicalJson(input)) !== receipt.inputHash) throw new PersonalizationStoreError('integrity-error', 'Controlled preference receipt input hash changed')
  try { assertControlledChoice(input, probe) } catch { throw new PersonalizationStoreError('integrity-error', 'Controlled preference receipt relationships changed') }
  return structuredClone({ command: receipt.command, choice, observation, ...(receipt.candidateId ? { candidateId: receipt.candidateId } : {}) })
}

function readIdempotentResult(
  database: DatabaseSync,
  request: PersonalizationCommandRequest,
  commandHash?: string,
): PersonalizationCommandResult | undefined {
  const row = readRow(database, `
    SELECT request_hash, result_json FROM personalization_idempotency WHERE idempotency_key = ?
  `, request.idempotencyKey)
  if (row === undefined) return undefined
  if (stringColumn(row, 'request_hash') !== commandRequestHash(request, commandHash)) {
    throw new PersonalizationStoreError(
      'conflict',
      'personalization idempotency key was already used for a different request',
    )
  }
  const result = parseCommandResult(stringColumn(row, 'result_json'))
  const replayed = { ...result, status: 'replayed' } as PersonalizationCommandResult
  assertCommandResult(replayed, request)
  return replayed
}

/** Must run while holding BEGIN IMMEDIATE, including when returning an idempotent command receipt. */
function authorizedCommandReplay(database: DatabaseSync, request: PersonalizationCommandRequest, expectedEpoch: number | undefined, commandHash?: string): PersonalizationCommandResult | undefined {
  const epoch = metadata(database).profileEpoch
  if (expectedEpoch !== undefined && expectedEpoch !== epoch) {
    // An erasure advances the fence itself. Only its exact latest immutable receipt may cross that one boundary.
    if (expectedEpoch === epoch - 1 && request.action === 'forget' && request.target === 'profile' && request.mode === 'privacy-erasure') {
      const replay = readIdempotentResult(database, request, commandHash)
      if (replay?.action === 'forget' && replay.receipt.mode === 'privacy-erasure' && replay.receipt.target === 'profile') return replay
    }
    throw new PersonalizationStoreError('conflict', 'Profile epoch changed after privacy erasure; inspect before creating a new command')
  }
  return readIdempotentResult(database, request, commandHash)
}

function commandRequestHash(request: PersonalizationCommandRequest, commandHash?: string): string {
  if (commandHash !== undefined && !digestValue(commandHash)) {
    throw new PersonalizationStoreError('invalid-request', 'Full product command hash must be a SHA-256 digest')
  }
  return sha256(canonicalJson(commandHash === undefined ? request : { request, commandHash }))
}

function hasPrivacyErasureReceipt(database: DatabaseSync, profileId: string): boolean {
  // Retain no old request keys or preference content: migration derives only a one-bit historical erasure fence.
  for (const row of readRows(database, `SELECT result_json FROM personalization_idempotency WHERE result_json LIKE '%privacy-erasure%'`)) {
    const result = parseCommandResult(stringColumn(row, 'result_json'))
    if (result.profileId !== profileId) throw new PersonalizationStoreError('integrity-error', 'Profile command receipt has foreign ownership')
    if (result.action === 'forget' && result.receipt.target === 'profile' && result.receipt.mode === 'privacy-erasure') return true
  }
  return false
}

function insertIdempotency(
  database: DatabaseSync,
  request: PersonalizationCommandRequest,
  result: PersonalizationCommandResult,
  commandHash?: string,
): void {
  database.prepare(`
    INSERT INTO personalization_idempotency(idempotency_key, request_hash, result_json)
    VALUES (?, ?, ?)
  `).run(request.idempotencyKey, commandRequestHash(request, commandHash), canonicalJson(result))
}

function listSessionPolicies(database: DatabaseSync): MemorySessionPolicy[] {
  return readJsonRows(database, 'SELECT record_json FROM personalization_session_policies ORDER BY session_id')
}

function readSessionPolicy(database: DatabaseSync, sessionId: string): MemorySessionPolicy | undefined {
  const value = readJsonRow<MemorySessionPolicy>(
    database,
    'SELECT record_json FROM personalization_session_policies WHERE session_id = ?',
    sessionId,
  )
  if (value && (value.recordType !== 'memory-session-policy' || value.sessionId !== sessionId || value.profileId !== metadata(database).profileId)) {
    throw new PersonalizationStoreError('integrity-error', 'Original session policy identity is invalid')
  }
  return value
}

function listObservations(database: DatabaseSync): PersonalizationObservation[] {
  return readJsonRows(database, 'SELECT record_json FROM personalization_observations ORDER BY observation_id')
}

function listCandidates(database: DatabaseSync): MemoryCandidate[] {
  return readJsonRows(database, 'SELECT record_json FROM personalization_candidates ORDER BY candidate_id')
}

function listMemoryVersions(database: DatabaseSync): MemoryVersion[] {
  return readJsonRows(database, `
    SELECT record_json FROM personalization_memory_versions ORDER BY chain_id, version
  `)
}

function listCurrentMemories(database: DatabaseSync): MemoryVersion[] {
  return readJsonRows(database, `
    SELECT v.record_json
    FROM personalization_memory_chains c
    JOIN personalization_memory_versions v
      ON v.memory_version_id = c.current_memory_version_id
    ORDER BY c.chain_id
  `)
}

function memoriesAtDecisionTime(
  decision: PersonalizationDecision,
  memories: readonly MemoryVersion[],
): MemoryVersion[] {
  const createdAt = Date.parse(decision.createdAt)
  return memories.map((memory) => {
    if (!decision.memoryVersionIds.includes(memory.memoryVersionId) || memory.status === 'deleted') {
      return memory
    }
    const recordedAt = Date.parse(memory.transactionTime.recordedAt)
    const retiredAt = memory.transactionTime.retiredAt === undefined
      ? undefined
      : Date.parse(memory.transactionTime.retiredAt)
    if (recordedAt > createdAt || (retiredAt !== undefined && retiredAt < createdAt)) {
      return memory
    }
    return { ...memory, status: 'active' }
  })
}

function verifyCurrentMemoryProjection(
  database: DatabaseSync,
  memories: readonly MemoryVersion[],
): void {
  const byChain = new Map<string, MemoryVersion[]>()
  for (const memory of memories) {
    const chain = byChain.get(memory.chainId) ?? []
    chain.push(memory)
    byChain.set(memory.chainId, chain)
  }
  const projectionRows = readRows(database, `
    SELECT chain_id, current_memory_version_id, current_version
    FROM personalization_memory_chains ORDER BY chain_id
  `)
  if (projectionRows.length !== byChain.size) {
    throw new PersonalizationStoreError('integrity-error', 'personalization current-memory projection is incomplete')
  }
  for (const row of projectionRows) {
    const chainId = stringColumn(row, 'chain_id')
    const chain = byChain.get(chainId)
    const latest = chain?.reduce((left, right) => left.version > right.version ? left : right)
    if (
      latest === undefined
      || latest.memoryVersionId !== stringColumn(row, 'current_memory_version_id')
      || latest.version !== integerColumn(row, 'current_version')
    ) {
      throw new PersonalizationStoreError('integrity-error', 'personalization current-memory projection is invalid')
    }
  }
}

function listDecisions(database: DatabaseSync): PersonalizationDecision[] {
  return readJsonRows(database, 'SELECT record_json FROM personalization_decisions ORDER BY decision_id')
}

function listMemoryUses(database: DatabaseSync): MemoryUse[] {
  return readJsonRows(database, 'SELECT record_json FROM personalization_memory_uses ORDER BY memory_use_id')
}

function listProbes(database: DatabaseSync): PreferenceProbe[] {
  return readJsonRows(database, 'SELECT record_json FROM personalization_probes ORDER BY probe_id')
}

function listChoices(database: DatabaseSync): PreferenceChoiceObservation[] {
  return readJsonRows(database, 'SELECT record_json FROM personalization_choices ORDER BY choice_id')
}

function storedExportRows(database: DatabaseSync): StoredExportRow[] {
  return readRows(database, 'SELECT descriptor_json, path FROM personalization_exports')
    .map(row => ({
      descriptor: JSON.parse(stringColumn(row, 'descriptor_json')) as PersonalizationExportDescriptor,
      path: stringColumn(row, 'path'),
    }))
}

function memoryTimeApplies(memory: LiveMemoryVersion, now: string): boolean {
  const instant = Date.parse(now)
  return (memory.validTime.from === undefined || Date.parse(memory.validTime.from) <= instant)
    && (memory.validTime.until === undefined || Date.parse(memory.validTime.until) > instant)
}

function scopeApplies(scope: PersonalizationScope, context: PersonalizationTaskContext): boolean {
  switch (scope.kind) {
    case 'global': return true
    case 'domain': return scope.domain === context.domain
    case 'workspace': return scope.workspaceId === context.workspaceId
    case 'collection':
      return scope.workspaceId === context.workspaceId && scope.collectionId === context.collectionId
    case 'document-revision':
      return scope.workspaceId === context.workspaceId
        && scope.documentId === context.documentId
        && scope.revisionId === context.revisionId
    case 'task-family':
      return scope.taskFamily === context.taskFamily
        && (scope.workspaceId === undefined || scope.workspaceId === context.workspaceId)
        && (scope.domain === undefined || scope.domain === context.domain)
  }
}

function compareAdmittedMemory(left: LiveMemoryVersion, right: LiveMemoryVersion): number {
  const rank = scopeRank(right.scope) - scopeRank(left.scope)
  if (rank !== 0) return rank
  const time = right.transactionTime.recordedAt.localeCompare(left.transactionTime.recordedAt)
  if (time !== 0) return time
  return left.memoryVersionId.localeCompare(right.memoryVersionId)
}

function scopeRank(scope: PersonalizationScope): number {
  switch (scope.kind) {
    case 'document-revision': return 6
    case 'collection': return 5
    case 'task-family': return scope.workspaceId === undefined ? 3 : 4
    case 'workspace': return 3
    case 'domain': return 2
    case 'global': return 1
  }
}

function personalizationExportProjection(database: DatabaseSync, request: Extract<PersonalizationCommandRequest, { action: 'export' }>) {
  const allMemories = listMemoryVersions(database), allObservations = listObservations(database), allCandidates = listCandidates(database)
  const allChoices = listChoices(database), allProbes = listProbes(database)
  const deletedChains = new Set(listCurrentMemories(database).filter(memory => memory.status === 'deleted').map(memory => memory.chainId))
  const forgottenObservations = new Set<string>(), forgottenCandidates = new Set<string>(), forgottenProbes = new Set<string>()
  const candidateById = new Map(allCandidates.map(candidate => [candidate.candidateId, candidate]))
  const candidatesByObservation = new Map<string, Set<string>>(), observationsByProbe = new Map<string, Set<string>>(), probeByObservation = new Map<string, string>()
  const addEdge = (index: Map<string, Set<string>>, from: string, to: string) => { const values = index.get(from) ?? new Set<string>(); values.add(to); index.set(from, values) }
  for (const candidate of allCandidates) for (const id of [...candidate.observationIds, ...candidate.counterObservationIds]) addEdge(candidatesByObservation, id, candidate.candidateId)
  for (const observation of allObservations) if (observation.signal === 'pairwise-preference-choice') {
    probeByObservation.set(observation.observationId, observation.detail.probeId); addEdge(observationsByProbe, observation.detail.probeId, observation.observationId)
  }
  const pending: Array<{ kind: 'observation' | 'candidate' | 'probe', id: string }> = []
  const mark = (kind: 'observation' | 'candidate' | 'probe', id: string) => {
    const visited = kind === 'observation' ? forgottenObservations : kind === 'candidate' ? forgottenCandidates : forgottenProbes
    if (!visited.has(id)) { visited.add(id); pending.push({ kind, id }) }
  }
  for (const memory of allMemories) if (memory.status !== 'deleted' && deletedChains.has(memory.chainId)) {
    for (const id of memory.observationIds) mark('observation', id)
    if (memory.candidateId) mark('candidate', memory.candidateId)
  }
  // A newly broadened export must not resurrect forgotten source material through a
  // pending/rejected sibling candidate, a counter-observation, or the same probe.
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index]!
    if (item.kind === 'observation') {
      for (const id of candidatesByObservation.get(item.id) ?? []) mark('candidate', id)
      const probeId = probeByObservation.get(item.id); if (probeId) mark('probe', probeId)
    } else if (item.kind === 'candidate') {
      const candidate = candidateById.get(item.id)
      if (candidate) for (const id of [...candidate.observationIds, ...candidate.counterObservationIds]) mark('observation', id)
    } else for (const id of observationsByProbe.get(item.id) ?? []) mark('observation', id)
  }
  const memories = allMemories.filter(memory => !deletedChains.has(memory.chainId) && memory.status !== 'deleted'
    && request.includeStatuses.includes(memory.status) && !memory.observationIds.some(id => forgottenObservations.has(id)))
  const memoryObservationIds = new Set(allMemories.flatMap(memory => memory.status === 'deleted' ? [] : memory.observationIds))
  const includedObservationIds = new Set(memories.flatMap(memory => memory.status === 'deleted' ? [] : memory.observationIds))
  const eligible = allObservations.filter(observation => observation.consent.retention === 'eligible' && !forgottenObservations.has(observation.observationId)
    && (!memoryObservationIds.has(observation.observationId) || includedObservationIds.has(observation.observationId)))
  const eligibleIds = new Set(eligible.map(observation => observation.observationId))
  const candidates = allCandidates.filter(candidate => !forgottenCandidates.has(candidate.candidateId)
    && [...candidate.observationIds, ...candidate.counterObservationIds].every(id => eligibleIds.has(id)))
  const eligibleChoiceIds = new Set(eligible.flatMap(observation => observation.signal === 'pairwise-preference-choice'
    ? [`${observation.detail.probeId}\0${observation.detail.choiceObservationId}`] : []))
  const choices = allChoices.filter(choice => choice.consent.retention === 'eligible' && !forgottenProbes.has(choice.probeId)
    && eligibleChoiceIds.has(`${choice.probeId}\0${choice.choiceObservationId}`))
  const chosenProbeIds = new Set(choices.map(choice => choice.probeId)), allChosenProbeIds = new Set(allChoices.map(choice => choice.probeId))
  const probes = allProbes.filter(probe => !forgottenProbes.has(probe.probeId)
    && (chosenProbeIds.has(probe.probeId) || !allChosenProbeIds.has(probe.probeId) && readSessionPolicy(database, probe.sessionId)?.contributeToFuture === true))
  const memoryIds = new Set(memories.map(memory => memory.memoryVersionId))
  const learningChoices = readRows(database, "SELECT * FROM personalization_journal WHERE event_type='learning.command.committed' AND json_extract(payload_json,'$.receipt.action')='choice'")
    .map(row => verifyLearningReceiptRow(database, metadata(database).profileId, row))
    .filter(value => value.eligible && value.observationId !== undefined && eligibleIds.has(value.observationId) && value.original && !forgottenProbes.has(value.original.probeId))
  const learningOffers = learningOffersRaw(database).filter(offer => !forgottenProbes.has(offer.original.probeId)
    && (chosenProbeIds.has(offer.original.probeId) || !allChosenProbeIds.has(offer.original.probeId) && readSessionPolicy(database, offer.original.conversationId)?.contributeToFuture === true))
  return { memories, candidates,
    observations: eligible.map(observation => request.includeProvenanceRefs ? observation : { observationId: observation.observationId, provenance: 'omitted' as const }),
    choices: choices.map(choice => request.includeProvenanceRefs ? choice : { choiceObservationId: choice.choiceObservationId, provenance: 'omitted' as const }),
    probes: probes.map(probe => request.includeProvenanceRefs ? probe : { probeId: probe.probeId, provenance: 'omitted' as const }),
    uses: listMemoryUses(database).filter(use => memoryIds.has(use.memoryVersionId)),
    learning: { settings: learningSettingsRaw(database, metadata(database).profileId),
      choices: learningChoices.map(value => request.includeProvenanceRefs ? { receipt: value.receipt, original: value.original } : { operationId: value.receipt.operationId, provenance: 'omitted' as const }),
      invitations: learningOffers.map(offer => request.includeProvenanceRefs ? offer : { offerId: offer.offerId, status: offer.status, provenance: 'omitted' as const }) } }
}

function renderMarkdownExport(bundle: {
  profileId: string
  exportedAt: string
  memories: MemoryVersion[]
}): string {
  const lines = [
    '# DocAtlas Personalization Export',
    '',
    `Profile: ${bundle.profileId}`,
    `Exported: ${bundle.exportedAt}`,
    '',
    '## Memory versions',
    '',
  ]
  for (const memory of bundle.memories) {
    if (memory.status === 'deleted') continue
    lines.push(
      `- ${memory.memoryVersionId} (${memory.status}, ${memory.scope.kind}): ${memory.summary}`,
    )
  }
  lines.push('', '## Governed profile records', '', '```json', JSON.stringify(bundle, null, 2), '```')
  return `${lines.join('\n')}\n`
}

function commandAggregateType(request: PersonalizationCommandRequest): string {
  if (request.action === 'set-session-policy') return 'memory-session-policy'
  if (request.action === 'review-candidate') return 'memory-candidate'
  if (request.action === 'forget' && request.target === 'profile') return 'profile'
  if (request.action === 'export') return 'personalization-export'
  return 'memory-chain'
}

function commandAggregateId(request: PersonalizationCommandRequest): string {
  switch (request.action) {
    case 'set-session-policy': return request.sessionId
    case 'set-preference': return request.idempotencyKey
    case 'review-candidate': return request.candidateId
    case 'pause':
    case 'resume':
    case 'edit': return request.memoryVersionId
    case 'forget': return request.target === 'profile' ? request.profileId : request.memoryVersionId!
    case 'export': return request.idempotencyKey
  }
}

function commandAggregateVersion(result: PersonalizationCommandResult): number {
  switch (result.action) {
    case 'set-session-policy': return result.sessionPolicy.version
    case 'set-preference': return result.memoryVersion.version
    case 'review-candidate': return result.candidate.version
    case 'pause':
    case 'resume':
    case 'edit': return result.memoryVersion.version
    default: return 1
  }
}

function metadata(database: DatabaseSync): {
  schemaVersion: number
  profileId: string
  ledgerRevision: number
  profileEpoch: number
} {
  const row = readRow(database, `
    SELECT schema_version, profile_id, ledger_revision, profile_epoch
    FROM personalization_metadata WHERE singleton = 1
  `)
  if (row === undefined) throw new PersonalizationStoreError('integrity-error', 'profile metadata is missing')
  const profileEpoch = integerColumn(row, 'profile_epoch')
  if (!Number.isSafeInteger(profileEpoch) || profileEpoch < 0) throw new PersonalizationStoreError('integrity-error', 'Invalid persistent profile epoch')
  return {
    schemaVersion: integerColumn(row, 'schema_version'),
    profileId: stringColumn(row, 'profile_id'),
    ledgerRevision: integerColumn(row, 'ledger_revision'),
    profileEpoch,
  }
}

function bumpLedgerRevision(database: DatabaseSync): void {
  database.prepare(`
    UPDATE personalization_metadata SET ledger_revision = ledger_revision + 1 WHERE singleton = 1
  `).run()
}

function enforceCount(database: DatabaseSync, table: string, maximum: number): void {
  const row = readRow(database, `SELECT COUNT(*) AS count FROM ${table}`)
  if (row !== undefined && integerColumn(row, 'count') >= maximum) {
    throw new PersonalizationStoreError('limit-exceeded', 'personalization profile limit was reached')
  }
}

function parseCommandRequest(candidate: unknown): PersonalizationCommandRequest {
  let value: ReturnType<typeof parseContract<'personalization-command'>>
  try {
    value = parseContract('personalization-command', candidate)
  } catch {
    throw new PersonalizationStoreError('invalid-request', 'personalization command shape is invalid')
  }
  if (!('requestType' in value) || personalizationCommandIssues(value).length > 0) {
    throw new PersonalizationStoreError('invalid-request', 'personalization command is invalid')
  }
  return value
}

function parseCommandResult(json: string): PersonalizationCommandResult {
  let value: ReturnType<typeof parseContract<'personalization-command'>>
  try {
    value = parseContract('personalization-command', JSON.parse(json) as unknown)
  } catch {
    throw new PersonalizationStoreError('integrity-error', 'stored personalization command result is invalid')
  }
  if ('requestType' in value) {
    throw new PersonalizationStoreError('integrity-error', 'stored personalization result is a request')
  }
  return value
}

function assertCommandResult(
  result: PersonalizationCommandResult,
  request: PersonalizationCommandRequest,
): void {
  try {
    parseContract('personalization-command', result)
  } catch {
    throw new PersonalizationStoreError('integrity-error', 'personalization command result shape is invalid')
  }
  if (personalizationCommandIssues(result, request).length > 0) {
    throw new PersonalizationStoreError('integrity-error', 'personalization command result failed invariants')
  }
}

function parseCore<K extends PersonalizationCoreValue['recordType']>(
  candidate: unknown,
  recordType: K,
): Extract<PersonalizationCoreValue, { recordType: K }> {
  let value: PersonalizationCoreValue
  try {
    value = parseContract('personalization-core', candidate)
  } catch {
    throw new PersonalizationStoreError('invalid-request', 'personalization record shape is invalid')
  }
  if (value.recordType !== recordType) {
    throw new PersonalizationStoreError('invalid-request', `expected ${recordType}`)
  }
  return value as Extract<PersonalizationCoreValue, { recordType: K }>
}

function parseCoreJson<T extends PersonalizationCoreValue>(json: string): T {
  try {
    return parseContract('personalization-core', JSON.parse(json) as unknown) as T
  } catch {
    throw new PersonalizationStoreError('integrity-error', 'stored personalization record is invalid')
  }
}

function assertCore(
  value: PersonalizationCoreValue,
  context: Parameters<typeof personalizationCoreIssues>[1] = {},
): void {
  try {
    parseContract('personalization-core', value)
  } catch {
    throw new PersonalizationStoreError('integrity-error', 'personalization record shape is invalid')
  }
  if (personalizationCoreIssues(value, context).length > 0) {
    throw new PersonalizationStoreError('integrity-error', 'personalization record failed invariants')
  }
}

function assertNoSecret(value: unknown): void {
  const serialized = JSON.stringify(value)
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/i,
    /(?:api[_-]?key|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][^"']{8,}/i,
  ]
  if (secretPatterns.some(pattern => pattern.test(serialized))) {
    throw new PersonalizationStoreError(
      'invalid-request',
      'personalization content was rejected by secret policy',
    )
  }
}

function exactReplay<T>(stored: T, candidate: T, label: string): T {
  if (canonicalJson(stored) !== canonicalJson(candidate)) {
    throw new PersonalizationStoreError('conflict', `${label} identity already contains different data`)
  }
  return stored
}

function describeEffect(effect: PersonalizationEffect): string {
  return `${effect.key}: ${effect.value}`
}

function ensurePrivateFile(path: string): void {
  if (!existsSync(path)) {
    const file = openSync(path, 'wx', DATABASE_MODE)
    closeSync(file)
  }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PersonalizationStoreError('integrity-error', 'profile database must be a regular file')
  }
  chmodSync(path, DATABASE_MODE)
}

function ensurePrivateSqliteFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue
    const info = lstatSync(candidate)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PersonalizationStoreError(
        'integrity-error',
        'profile database files must be regular files',
      )
    }
    chmodSync(candidate, DATABASE_MODE)
  }
}

function verifyProfileBackup(path: string, profileId: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PersonalizationStoreError('integrity-error', 'profile backup must be a regular file')
  }
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    preflight(database)
    if (!tableExists(database, 'personalization_metadata')) {
      throw new PersonalizationStoreError('integrity-error', 'profile backup metadata is missing')
    }
    const row = readRow(database, `
      SELECT schema_version, profile_id FROM personalization_metadata WHERE singleton = 1
    `)
    if (
      row === undefined
      || stringColumn(row, 'profile_id') !== profileId
      || integerColumn(row, 'schema_version') < 0
      || integerColumn(row, 'schema_version') > PERSONALIZATION_SCHEMA_VERSION
    ) {
      throw new PersonalizationStoreError('integrity-error', 'profile backup identity is invalid')
    }
  } finally {
    database.close()
  }
}

function assertManagedDirectory(path: string): void {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PersonalizationStoreError('integrity-error', 'managed export directory is invalid')
  }
}

function removeManagedDirectory(path: string): void {
  if (!existsSync(path)) return
  assertManagedDirectory(path)
  rmSync(path, { recursive: true, force: true })
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return readRow(database, `
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `, name) !== undefined
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    rollback(database)
    throw error
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // No active transaction.
  }
}

type SqlValue = string | number | bigint | null | Uint8Array

function readRow(database: DatabaseSync, sql: string, ...params: SqlValue[]): Record<string, unknown> | undefined {
  return database.prepare(sql).get(...params) as Record<string, unknown> | undefined
}

function readRows(database: DatabaseSync, sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
  return database.prepare(sql).all(...params) as Record<string, unknown>[]
}

function readJsonRow<T>(database: DatabaseSync, sql: string, ...params: SqlValue[]): T | undefined {
  const row = readRow(database, sql, ...params)
  return row === undefined ? undefined : parseCoreJson<T & PersonalizationCoreValue>(stringColumn(row, 'record_json')) as T
}

function readJsonRows<T>(database: DatabaseSync, sql: string, ...params: SqlValue[]): T[] {
  return readRows(database, sql, ...params)
    .map(row => parseCoreJson<T & PersonalizationCoreValue>(stringColumn(row, 'record_json')) as T)
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new PersonalizationStoreError('integrity-error', `invalid ${key} column`)
  return value
}

function nullableStringColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new PersonalizationStoreError('integrity-error', `invalid ${key} column`)
  return value
}

function integerColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PersonalizationStoreError('integrity-error', `invalid ${key} column`)
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalValue(item))
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) result[key] = canonicalValue(child)
  }
  return result
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(parts.join('\0')).slice(0, 32)}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

function descriptorLike(
  assetId: string,
  format: PersonalizationExportDescriptor['format'],
): Pick<PersonalizationExportDescriptor, 'assetId' | 'format'> {
  return { assetId, format }
}

function exportPath(
  exportsRoot: string,
  profileId: string,
  descriptor: Pick<PersonalizationExportDescriptor, 'assetId' | 'format'>,
): string {
  return join(
    profileExportRoot(exportsRoot, profileId),
    `${sha256(descriptor.assetId)}.${descriptor.format === 'json' ? 'json' : 'md'}`,
  )
}

function profileExportRoot(exportsRoot: string, profileId: string): string {
  return join(exportsRoot, sha256(profileId))
}

function assertExportDescriptor(
  profileId: string,
  descriptor: PersonalizationExportDescriptor,
): void {
  try {
    parseContract('personalization-command', {
      schemaVersion: 1,
      resultType: 'personalization-command',
      profileId,
      action: 'export',
      status: 'created',
      export: descriptor,
    })
  } catch {
    throw new PersonalizationStoreError('integrity-error', 'stored export descriptor is invalid')
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function normalizeStoreError(error: unknown): PersonalizationStoreError {
  if (error instanceof PersonalizationStoreError) return error
  return new PersonalizationStoreError('integrity-error', 'personalization storage operation failed')
}
