import { createHash } from 'node:crypto'

import {
  continuityRpcIssues,
  type ActorRef,
  type ContinuityAssessRequest,
  type ContinuityAssessResult,
  type ContinuityEvidenceContext,
  type ContinuityLink,
  type ContinuityScopeContext,
  type ResearchSourceIdentity,
  type RevisionImpactRecordContext,
  type RevisionImpactRequest,
  type RevisionImpactResult,
} from '@docatlas/contracts'

export type ContinuityServiceErrorCode =
  | 'invalid-request'
  | 'not-found'
  | 'conflict'
  | 'permission-denied'
  | 'integrity-error'

export class ContinuityServiceError extends Error {
  constructor(readonly code: ContinuityServiceErrorCode, message: string) {
    super(message)
    this.name = 'ContinuityServiceError'
  }
}

export interface ContinuityRecord {
  recordId: string
  workspaceId: string
  investigationId: string
  recordType: string
  status: string
  version?: number
  sources: ResearchSourceIdentity[]
  sourceAvailability?: 'available' | 'missing' | 'denied'
  sourceReferencesComplete?: boolean
}

export interface ContinuityServiceBackend {
  activeScope(sessionId: string): ContinuityScopeContext | undefined
  researchRecord(workspaceId: string, recordId: string): ContinuityRecord | undefined
  resolveEvidence(workspaceId: string, evidenceId: string): ContinuityEvidenceContext | undefined
  commitLink(
    idempotencyKey: string,
    requestHash: string,
    link: ContinuityLink,
  ): { status: 'created' | 'replayed', link: ContinuityLink }
  impactRecords(
    workspaceId: string,
    recordIds: readonly string[],
    previousSource: ResearchSourceIdentity,
  ): RevisionImpactRecordContext[]
}

export class ContinuityService {
  constructor(
    private readonly backend: ContinuityServiceBackend,
    private readonly now: () => number = Date.now,
  ) {}

  assess(
    request: ContinuityAssessRequest,
    actor: ActorRef & { kind: 'user' | 'rule' },
    commandHash?: string,
  ): ContinuityAssessResult {
    if (commandHash !== undefined && (typeof commandHash !== 'string' || !/^[a-f0-9]{64}$/u.test(commandHash))) throw new ContinuityServiceError('invalid-request', 'host command hash must be canonical SHA-256')
    const scope = this.backend.activeScope(request.sessionId)
    if (scope === undefined) throw new ContinuityServiceError('not-found', 'active Session scope was not found')
    if (scope.workspaceId !== request.workspaceId
      || scope.investigationId !== request.investigationId
      || scope.scopeVersionId !== request.scopeVersionId) {
      throw new ContinuityServiceError('permission-denied', 'continuity request escaped the active scope identity')
    }
    const prior = this.backend.researchRecord(request.workspaceId, request.priorRecordId)
    if (prior === undefined || prior.status === 'deleted') {
      throw new ContinuityServiceError('not-found', 'prior research record was not found')
    }
    if (prior.workspaceId !== request.workspaceId || prior.recordId !== request.priorRecordId) {
      throw new ContinuityServiceError('integrity-error', 'prior research record identity is inconsistent')
    }
    if (request.priorRecordVersion !== undefined && prior.version !== request.priorRecordVersion) {
      throw new ContinuityServiceError('conflict', 'prior record version changed before continuity assessment')
    }
    if (!sameSources(prior.sources, request.priorSources)) {
      throw new ContinuityServiceError('conflict', 'prior source snapshot no longer matches the record')
    }
    const scopeKeys = new Set(scope.sources.map(sourceKey))
    const outside = [...request.priorSources, ...request.currentSources]
      .some(source => !scopeKeys.has(sourceKey(source)))
    const missingPrior = request.priorSources.length === 0
      || prior.sourceReferencesComplete === false
      || prior.sourceAvailability === 'missing'
      || prior.sourceAvailability === 'denied'
    const comparative = request.proposedState !== undefined && request.proposedState !== 'unknown'
    if (comparative && prior.sourceReferencesComplete === false) {
      throw new ContinuityServiceError('invalid-request', 'incomplete prior source references cannot support a comparative continuity determination')
    }
    const evidence = [
      ...(request.priorEvidenceIds ?? []),
      ...(request.currentEvidenceIds ?? []),
    ].map(id => this.backend.resolveEvidence(request.workspaceId, id))
    if (comparative && evidence.some(item => item === undefined)) {
      throw new ContinuityServiceError('not-found', 'continuity Evidence was not found')
    }
    const context = {
      activeScope: scope,
      evidence: evidence.filter((item): item is ContinuityEvidenceContext => item !== undefined),
    }
    const state = request.proposedState ?? 'unknown'
    const verificationStatus = comparative
      ? 'reverified' as const
      : missingPrior
        ? 'missing-source' as const
        : outside
          ? 'outside-scope' as const
          : 'needs-reverify' as const
    const link: ContinuityLink = {
      schemaVersion: 1,
      continuityLinkId: `continuity:${sha256(`${request.workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`,
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      scopeVersionId: request.scopeVersionId,
      priorRecordId: request.priorRecordId,
      ...(request.priorRecordVersion === undefined ? {} : { priorRecordVersion: request.priorRecordVersion }),
      priorSources: structuredClone(request.priorSources),
      currentSources: structuredClone(request.currentSources),
      state,
      verificationStatus,
      priorEvidenceIds: [...(request.priorEvidenceIds ?? [])],
      currentEvidenceIds: [...(request.currentEvidenceIds ?? [])],
      rationale: request.rationale ?? 'No verified continuity determination was supplied.',
      createdBy: structuredClone(actor),
      createdAt: new Date(this.now()).toISOString(),
    }
    const issues = [
      ...continuityRpcIssues(request, undefined, context),
      ...continuityRpcIssues({
        schemaVersion: 1,
        resultType: 'continuity-assessed',
        status: 'created',
        link,
      }, request, context),
    ]
    if (issues.length > 0 || (comparative && outside)) {
      throw new ContinuityServiceError('invalid-request', issues[0]?.message ?? 'continuity sources are outside scope')
    }
    const requestHash = commandHash ?? sha256(canonicalJson(request))
    const committed = this.backend.commitLink(request.idempotencyKey, requestHash, link)
    const result: ContinuityAssessResult = {
      schemaVersion: 1,
      resultType: 'continuity-assessed',
      status: committed.status,
      link: structuredClone(committed.link),
    }
    if (continuityRpcIssues(result, request, context).length > 0
      || result.link.continuityLinkId !== link.continuityLinkId
      || canonicalJson(result.link.createdBy) !== canonicalJson(actor)) {
      throw new ContinuityServiceError('integrity-error', 'committed continuity link is inconsistent')
    }
    return result
  }

  revisionImpact(request: RevisionImpactRequest): RevisionImpactResult {
    const requestIssues = continuityRpcIssues(request)
    if (requestIssues.length > 0) {
      throw new ContinuityServiceError('invalid-request', requestIssues[0]!.message)
    }
    const records = new Map(this.backend.impactRecords(
      request.workspaceId,
      request.recordIds,
      request.previousSource,
    )
      .map(record => [record.recordId, record]))
    if (request.recordIds.some(id => !records.has(id))) {
      throw new ContinuityServiceError('not-found', 'revision impact requires an authenticated context for every requested record')
    }
    const generation = sha256(canonicalJson(request.recordIds.map(id => records.get(id) ?? { recordId: id })))
    const queryHash = sha256(canonicalJson({ ...request, cursor: undefined, generation }))
    const offset = impactOffset(request.cursor, queryHash)
    const impacts = request.recordIds.slice(offset, offset + request.limits.maxItems).map((recordId) => {
      const record = records.get(recordId)
      if (record === undefined) throw new ContinuityServiceError('not-found', 'revision impact record context is unavailable')
      if (record.sourceReferencesComplete === false) return { recordId, status: 'missing-source' as const, reason: 'The record source references cannot be completely resolved.' }
      const affected = record.sources.some(source => sourceKey(source) === sourceKey(request.previousSource))
      if (affected && record.previousSourceAvailability === 'missing') return { recordId, status: 'missing-source' as const, reason: 'The prior source is unavailable.' }
      return affected
        ? { recordId, status: 'needs-reverify' as const, reason: 'The record references the superseded revision.' }
        : { recordId, status: 'unaffected' as const, reason: 'The record does not reference the predecessor revision.' }
    })
    const consumed = offset + impacts.length
    const truncated = consumed < request.recordIds.length
    const result: RevisionImpactResult = {
      schemaVersion: 1,
      resultType: 'revision-impact',
      workspaceId: request.workspaceId,
      previousSource: structuredClone(request.previousSource),
      currentSource: structuredClone(request.currentSource),
      impacts,
      pageInfo: {
        schemaVersion: 1,
        limit: request.limits.maxItems,
        returned: impacts.length,
        total: request.recordIds.length,
        truncated,
        completeness: truncated ? 'partial' : 'complete',
        ...(truncated ? { nextCursor: impactCursor(queryHash, consumed) } : {}),
      },
    }
    if (continuityRpcIssues(result, request, { impactRecords: [...records.values()] }).length > 0) {
      throw new ContinuityServiceError('integrity-error', 'revision-impact result is inconsistent')
    }
    return result
  }
}

function impactOffset(cursor: string | undefined, queryHash: string): number {
  if (cursor === undefined) return 0
  const match = /^impact:(\d+):([a-f0-9]{32})$/.exec(cursor)
  if (match === null) {
    throw new ContinuityServiceError('invalid-request', 'revision-impact cursor is stale')
  }
  const offset = Number(match[1])
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > 10_000) {
    throw new ContinuityServiceError('invalid-request', 'revision-impact cursor offset is invalid')
  }
  if (match[2] !== impactCursorSignature(queryHash, offset)) {
    throw new ContinuityServiceError('invalid-request', 'revision-impact cursor is stale')
  }
  return offset
}

function impactCursor(queryHash: string, offset: number): string {
  return `impact:${offset}:${impactCursorSignature(queryHash, offset)}`
}

function impactCursorSignature(queryHash: string, offset: number): string {
  return sha256(`impact-cursor\0${queryHash}\0${offset}`).slice(0, 32)
}

function sameSources(left: readonly ResearchSourceIdentity[], right: readonly ResearchSourceIdentity[]): boolean {
  return canonicalJson(left.map(sourceKey).sort()) === canonicalJson(right.map(sourceKey).sort())
}

function sourceKey(source: ResearchSourceIdentity): string {
  return [source.documentId, source.revisionId, source.representationId,
    source.representationContentHash].join('\0')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonicalJson(item))))
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, JSON.parse(canonicalJson(child))])))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
