import { pageInfoIssues } from './m0-contracts.js'
import type { ActorRef, OpaqueId, PageInfo } from './m0-contracts.js'
import type { ResearchSourceIdentity } from './research-recall-contracts.js'

export type ContinuityState = 'continuing' | 'changed' | 'conflicted' | 'unknown'
export type ContinuityVerification = 'reverified' | 'needs-reverify' | 'missing-source' | 'outside-scope'

export interface ContinuityAssessRequest {
  schemaVersion: 1
  requestType: 'continuity-assess'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  priorRecordId: OpaqueId
  priorRecordVersion?: number
  priorSources: ResearchSourceIdentity[]
  currentSources: ResearchSourceIdentity[]
  proposedState?: ContinuityState
  priorEvidenceIds?: OpaqueId[]
  currentEvidenceIds?: OpaqueId[]
  rationale?: string
  idempotencyKey: OpaqueId
}

export interface ContinuityLink {
  schemaVersion: 1
  continuityLinkId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  priorRecordId: OpaqueId
  priorRecordVersion?: number
  priorSources: ResearchSourceIdentity[]
  currentSources: ResearchSourceIdentity[]
  state: ContinuityState
  verificationStatus: ContinuityVerification
  priorEvidenceIds: OpaqueId[]
  currentEvidenceIds: OpaqueId[]
  rationale: string
  createdBy: ActorRef
  createdAt: string
}

export interface ContinuityAssessResult {
  schemaVersion: 1
  resultType: 'continuity-assessed'
  status: 'created' | 'replayed'
  link: ContinuityLink
}

export interface RevisionImpactRequest {
  schemaVersion: 1
  requestType: 'revision-impact'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  previousSource: ResearchSourceIdentity
  currentSource: ResearchSourceIdentity
  recordIds: OpaqueId[]
  limits: { maxItems: number }
  cursor?: OpaqueId
}

export interface RevisionImpact {
  recordId: OpaqueId
  status: 'needs-reverify' | 'unaffected' | 'missing-source'
  reason: string
}

export interface RevisionImpactResult {
  schemaVersion: 1
  resultType: 'revision-impact'
  workspaceId: OpaqueId
  previousSource: ResearchSourceIdentity
  currentSource: ResearchSourceIdentity
  impacts: RevisionImpact[]
  pageInfo: PageInfo
}

export type ContinuityRpcValue =
  | ContinuityAssessRequest
  | ContinuityAssessResult
  | RevisionImpactRequest
  | RevisionImpactResult

/**
 * Exact active scope supplied by the authenticated Host. This is validation
 * context, not client-controlled RPC input.
 */
export interface ContinuityScopeContext {
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  sources: ResearchSourceIdentity[]
}

/**
 * Minimal EvidenceAtom + resolved Locator projection after a fresh Read. It
 * deliberately carries no quote text.
 */
export interface ContinuityEvidenceContext {
  evidenceId: OpaqueId
  source: ResearchSourceIdentity
  scopeVersionId: OpaqueId
  resolutionStatus: 'resolved' | 'page-only' | 'ambiguous' | 'stale' | 'missing' | 'denied'
  status: 'current' | 'stale' | 'withdrawn' | 'deleted'
}

/** Durable source references resolved by the Host for one impacted record. */
export interface RevisionImpactRecordContext {
  recordId: OpaqueId
  sources: ResearchSourceIdentity[]
  previousSourceAvailability: 'available' | 'missing'
  /** Trusted dependency projection only; omitted preserves the legacy complete-set meaning. */
  sourceReferencesComplete?: boolean
}

export interface ContinuityValidationContext {
  activeScope?: ContinuityScopeContext
  evidence?: ContinuityEvidenceContext[]
  impactRecords?: RevisionImpactRecordContext[]
}

export interface RevisionImpactExchange {
  request: RevisionImpactRequest
  result: RevisionImpactResult
}

export type ContinuityIssueCode =
  | 'continuity-identity'
  | 'continuity-state'
  | 'continuity-source-identity'
  | 'continuity-scope'
  | 'continuity-evidence-required'
  | 'continuity-evidence-invalid'
  | 'continuity-verification'
  | 'continuity-revision'
  | 'continuity-impact-count'
  | 'continuity-impact-record'
  | 'continuity-impact-status'
  | 'continuity-pagination'

export interface ContinuityContractIssue {
  code: ContinuityIssueCode
  path: string
  message: string
}

const COMPARATIVE_STATES = new Set<ContinuityState>(['continuing', 'changed', 'conflicted'])

export function continuityRpcIssues(
  value: ContinuityRpcValue,
  request?: ContinuityAssessRequest | RevisionImpactRequest,
  context?: ContinuityValidationContext,
): ContinuityContractIssue[] {
  const issues: ContinuityContractIssue[] = []
  const add = (code: ContinuityIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }

  if ('requestType' in value && value.requestType === 'continuity-assess') {
    if (value.priorRecordVersion !== undefined && (!Number.isSafeInteger(value.priorRecordVersion) || value.priorRecordVersion < 1)) add('continuity-identity', '/priorRecordVersion', 'prior record version must be a positive safe integer')
    addSourceArrayIssues(value.priorSources, '/priorSources', add)
    addSourceArrayIssues(value.currentSources, '/currentSources', add)
    if (value.proposedState !== undefined && COMPARATIVE_STATES.has(value.proposedState)) {
      addComparativeIssues(
        value.priorSources,
        value.currentSources,
        value.priorEvidenceIds ?? [],
        value.currentEvidenceIds ?? [],
        '/',
        add,
      )
      addScopeIssues(value, value.priorSources, value.currentSources, context?.activeScope, true, add)
      addEvidenceContextIssues(
        value.priorEvidenceIds ?? [],
        value.currentEvidenceIds ?? [],
        value.priorSources,
        value.currentSources,
        value.scopeVersionId,
        context?.evidence,
        '/priorEvidenceIds',
        '/currentEvidenceIds',
        add,
      )
    }
  }

  if ('resultType' in value && value.resultType === 'continuity-assessed') {
    const link = value.link
    if (link.priorRecordVersion !== undefined && (!Number.isSafeInteger(link.priorRecordVersion) || link.priorRecordVersion < 1)) add('continuity-identity', '/link/priorRecordVersion', 'prior record version must be a positive safe integer')
    addSourceArrayIssues(link.priorSources, '/link/priorSources', add)
    addSourceArrayIssues(link.currentSources, '/link/currentSources', add)
    if (request?.requestType === 'continuity-assess') {
      if (link.workspaceId !== request.workspaceId
        || link.investigationId !== request.investigationId
        || link.scopeVersionId !== request.scopeVersionId
        || link.priorRecordId !== request.priorRecordId
        || link.priorRecordVersion !== request.priorRecordVersion
        || !sameSourceSet(link.priorSources, request.priorSources)
        || !sameSourceSet(link.currentSources, request.currentSources)
        || !sameStringSet(link.priorEvidenceIds, request.priorEvidenceIds ?? [])
        || !sameStringSet(link.currentEvidenceIds, request.currentEvidenceIds ?? [])) {
        add('continuity-identity', '/link', 'continuity result must match the exact request identity and admitted inputs')
      }
      if (request.proposedState !== undefined && link.state !== request.proposedState) {
        add('continuity-state', '/link/state', 'accepted continuity state must match the explicit proposed state')
      }
    }

    const comparative = COMPARATIVE_STATES.has(link.state)
    if (comparative) {
      addComparativeIssues(
        link.priorSources,
        link.currentSources,
        link.priorEvidenceIds,
        link.currentEvidenceIds,
        '/link',
        add,
      )
      if (link.verificationStatus !== 'reverified') {
        add('continuity-verification', '/link/verificationStatus', 'a comparative continuity state must be reverified')
      }
    } else if (link.verificationStatus === 'reverified') {
      add('continuity-verification', '/link/verificationStatus', 'unknown continuity cannot be marked reverified')
    }

    const outsideScope = addScopeIssues(
      link,
      link.priorSources,
      link.currentSources,
      context?.activeScope,
      link.verificationStatus === 'reverified',
      add,
    )
    if (context?.activeScope !== undefined
      && link.verificationStatus === 'outside-scope'
      && !outsideScope) {
      add('continuity-verification', '/link/verificationStatus', 'outside-scope requires at least one source outside the active scope')
    }
    if (link.verificationStatus === 'reverified') {
      addEvidenceContextIssues(
        link.priorEvidenceIds,
        link.currentEvidenceIds,
        link.priorSources,
        link.currentSources,
        link.scopeVersionId,
        context?.evidence,
        '/link/priorEvidenceIds',
        '/link/currentEvidenceIds',
        add,
      )
    }
  }

  if ('requestType' in value && value.requestType === 'revision-impact') {
    if (value.previousSource.documentId !== value.currentSource.documentId
      || value.previousSource.revisionId === value.currentSource.revisionId) {
      add('continuity-revision', '/currentSource', 'revision impact requires two revisions of the same document')
    }
    if (new Set(value.recordIds).size !== value.recordIds.length) {
      add('continuity-impact-record', '/recordIds', 'revision impact record ids must be unique')
    }
  }

  if ('resultType' in value && value.resultType === 'revision-impact') {
    for (const issue of pageInfoIssues(value.pageInfo)) {
      add('continuity-pagination', `/pageInfo${issue.path === '/' ? '' : issue.path}`, issue.message)
    }
    if (value.pageInfo.returned !== value.impacts.length) {
      add('continuity-impact-count', '/pageInfo/returned', 'impact count must match returned items')
    }
    addImpactPaginationIssues(value, request, add)
    if (request?.requestType === 'revision-impact') {
      if (value.workspaceId !== request.workspaceId
        || !sameSource(value.previousSource, request.previousSource)
        || !sameSource(value.currentSource, request.currentSource)) {
        add('continuity-identity', '/', 'revision impact result must match the exact request source identity')
      }
      addImpactRecordIssues(value, request, context?.impactRecords, add)
    }
  }
  return issues
}

/** Validate cursor chaining and snapshot identity across a complete impact scan. */
export function revisionImpactSequenceIssues(
  exchanges: RevisionImpactExchange[],
  context?: ContinuityValidationContext,
): ContinuityContractIssue[] {
  const issues: ContinuityContractIssue[] = []
  const add = (code: ContinuityIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if (exchanges.length === 0) {
    add('continuity-pagination', '/', 'revision impact sequence requires at least one page')
    return issues
  }
  const first = exchanges[0]!
  if (first.request.cursor !== undefined) {
    add('continuity-pagination', '/0/request/cursor', 'the first revision impact page must not carry a cursor')
  }
  const seen = new Set<string>()
  for (const [index, exchange] of exchanges.entries()) {
    for (const issue of continuityRpcIssues(exchange.result, exchange.request, context)) {
      issues.push({ ...issue, path: `/${index}${issue.path === '/' ? '' : issue.path}` })
    }
    if (!sameImpactRequest(first.request, exchange.request)) {
      add('continuity-identity', `/${index}/request`, 'every page must retain the first request identity and record snapshot')
    }
    for (const impact of exchange.result.impacts) {
      if (seen.has(impact.recordId)) {
        add('continuity-impact-record', `/${index}/result/impacts`, 'an impact record cannot repeat across pages')
      }
      seen.add(impact.recordId)
    }
    const next = exchanges[index + 1]
    if (next !== undefined) {
      if (!exchange.result.pageInfo.truncated
        || exchange.result.pageInfo.nextCursor === undefined
        || next.request.cursor !== exchange.result.pageInfo.nextCursor) {
        add('continuity-pagination', `/${index}/result/pageInfo/nextCursor`, 'the next request must use the exact cursor from a truncated page')
      }
    } else if (exchange.result.pageInfo.truncated) {
      add('continuity-pagination', `/${index}/result/pageInfo/truncated`, 'a complete page sequence cannot stop while truncated')
    }
  }
  const expected = new Set(first.request.recordIds)
  if (seen.size !== expected.size || [...seen].some(recordId => !expected.has(recordId))) {
    add('continuity-impact-count', '/', 'a complete impact sequence must classify every requested record exactly once')
  }
  return issues
}

function addComparativeIssues(
  priorSources: ResearchSourceIdentity[],
  currentSources: ResearchSourceIdentity[],
  priorEvidenceIds: string[],
  currentEvidenceIds: string[],
  path: string,
  add: (code: ContinuityIssueCode, path: string, message: string) => void,
): void {
  if (priorSources.length === 0 || currentSources.length === 0) {
    add('continuity-source-identity', path, 'comparative continuity requires exact prior and current source identities')
  }
  if (priorEvidenceIds.length === 0 || currentEvidenceIds.length === 0) {
    add('continuity-evidence-required', path, 'comparative continuity requires prior and freshly read current Evidence')
  }
}

function addSourceArrayIssues(
  sources: ResearchSourceIdentity[],
  path: string,
  add: (code: ContinuityIssueCode, path: string, message: string) => void,
): void {
  const revisions = new Set<string>()
  for (const [index, source] of sources.entries()) {
    const revision = sourceRevisionKey(source)
    if (revisions.has(revision)) {
      add('continuity-source-identity', `${path}/${index}`, 'one document revision must select exactly one representation')
    }
    revisions.add(revision)
  }
}

function addScopeIssues(
  identity: { workspaceId: string, investigationId: string, scopeVersionId: string },
  priorSources: ResearchSourceIdentity[],
  currentSources: ResearchSourceIdentity[],
  scope: ContinuityScopeContext | undefined,
  requireAdmission: boolean,
  add: (code: ContinuityIssueCode, path: string, message: string) => void,
): boolean {
  if (scope === undefined) return false
  if (scope.workspaceId !== identity.workspaceId
    || scope.investigationId !== identity.investigationId
    || scope.scopeVersionId !== identity.scopeVersionId) {
    add('continuity-scope', '/scopeVersionId', 'continuity must use the exact authenticated active SourceScope')
  }
  const admitted = new Set(scope.sources.map(sourceKey))
  const outside = [...priorSources, ...currentSources].some(source => !admitted.has(sourceKey(source)))
  if (requireAdmission && outside) {
    add('continuity-scope', '/scopeVersionId', 'reverification cannot use a source outside the active SourceScope')
  }
  return outside
}

function addEvidenceContextIssues(
  priorEvidenceIds: string[],
  currentEvidenceIds: string[],
  priorSources: ResearchSourceIdentity[],
  currentSources: ResearchSourceIdentity[],
  scopeVersionId: string,
  evidence: ContinuityEvidenceContext[] | undefined,
  priorPath: string,
  currentPath: string,
  add: (code: ContinuityIssueCode, path: string, message: string) => void,
): void {
  if (evidence === undefined) return
  const byId = new Map(evidence.map(item => [item.evidenceId, item]))
  validateEvidenceSide(priorEvidenceIds, priorSources, scopeVersionId, byId, priorPath, add)
  validateEvidenceSide(currentEvidenceIds, currentSources, scopeVersionId, byId, currentPath, add)
}

function validateEvidenceSide(
  evidenceIds: string[],
  sources: ResearchSourceIdentity[],
  scopeVersionId: string,
  evidence: Map<string, ContinuityEvidenceContext>,
  path: string,
  add: (code: ContinuityIssueCode, path: string, message: string) => void,
): void {
  const allowedSources = new Set(sources.map(sourceKey))
  for (const [index, evidenceId] of evidenceIds.entries()) {
    const item = evidence.get(evidenceId)
    if (item === undefined
      || item.status !== 'current'
      || item.resolutionStatus !== 'resolved'
      || item.scopeVersionId !== scopeVersionId
      || !allowedSources.has(sourceKey(item.source))) {
      add('continuity-evidence-invalid', `${path}/${index}`, 'reverified Evidence must be current, resolved, in-scope, and match its source side')
    }
  }
}

function addImpactPaginationIssues(
  result: RevisionImpactResult,
  request: ContinuityAssessRequest | RevisionImpactRequest | undefined,
  add: (code: ContinuityIssueCode, path: string, message: string) => void,
): void {
  if (result.pageInfo.total === undefined) {
    add('continuity-pagination', '/pageInfo/total', 'revision impact pagination requires a stable total')
  }
  if (result.pageInfo.truncated) {
    if (result.pageInfo.completeness !== 'partial' || result.pageInfo.nextCursor === undefined) {
      add('continuity-pagination', '/pageInfo', 'a truncated impact page must be partial and carry a next cursor')
    }
  } else if (result.pageInfo.completeness !== 'complete' || result.pageInfo.nextCursor !== undefined) {
    add('continuity-pagination', '/pageInfo', 'an exhausted impact page must be complete and omit next cursor')
  }
  if (request?.requestType === 'revision-impact') {
    if (result.pageInfo.limit !== request.limits.maxItems
      || result.pageInfo.total !== request.recordIds.length) {
      add('continuity-pagination', '/pageInfo', 'impact page bounds must match the requested immutable record snapshot')
    }
    if (request.cursor === undefined
      && !result.pageInfo.truncated
      && result.pageInfo.returned !== result.pageInfo.total) {
      add('continuity-pagination', '/pageInfo/returned', 'an unpaginated first page must classify the complete snapshot')
    }
  }
}

function addImpactRecordIssues(
  result: RevisionImpactResult,
  request: RevisionImpactRequest,
  records: RevisionImpactRecordContext[] | undefined,
  add: (code: ContinuityIssueCode, path: string, message: string) => void,
): void {
  const requestedIndex = new Map(request.recordIds.map((recordId, index) => [recordId, index]))
  const recordContext = records === undefined
    ? undefined
    : new Map(records.map(record => [record.recordId, record]))
  const seen = new Set<string>()
  let lastIndex = -1
  for (const [index, impact] of result.impacts.entries()) {
    const position = requestedIndex.get(impact.recordId)
    if (seen.has(impact.recordId) || position === undefined || position <= lastIndex) {
      add('continuity-impact-record', `/impacts/${index}/recordId`, 'impact records must be unique members in stable request order')
    }
    seen.add(impact.recordId)
    if (position !== undefined) lastIndex = position
    if (recordContext !== undefined) {
      const record = recordContext.get(impact.recordId)
      if (record === undefined) {
        add('continuity-impact-record', `/impacts/${index}/recordId`, 'impact record has no authenticated source-reference context')
        continue
      }
      const referencesPrevious = record.sources.some(source => sameSource(source, request.previousSource))
      const expectedStatus = record.sourceReferencesComplete === false
        ? 'missing-source'
        : !referencesPrevious
        ? 'unaffected'
        : record.previousSourceAvailability === 'missing'
          ? 'missing-source'
          : 'needs-reverify'
      if (impact.status !== expectedStatus) {
        add('continuity-impact-status', `/impacts/${index}/status`, 'impact status must follow the exact predecessor source reference and availability')
      }
    }
  }
}

function sameImpactRequest(left: RevisionImpactRequest, right: RevisionImpactRequest): boolean {
  return left.sessionId === right.sessionId
    && left.workspaceId === right.workspaceId
    && left.investigationId === right.investigationId
    && left.scopeVersionId === right.scopeVersionId
    && sameSource(left.previousSource, right.previousSource)
    && sameSource(left.currentSource, right.currentSource)
    && left.limits.maxItems === right.limits.maxItems
    && sameStringSequence(left.recordIds, right.recordIds)
}

function sameSource(left: ResearchSourceIdentity, right: ResearchSourceIdentity): boolean {
  return sourceKey(left) === sourceKey(right)
}

function sameSourceSet(left: ResearchSourceIdentity[], right: ResearchSourceIdentity[]): boolean {
  return sameStringSet(left.map(sourceKey), right.map(sourceKey))
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === left.length
    && rightSet.size === right.length
    && left.every(value => rightSet.has(value))
}

function sameStringSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sourceRevisionKey(source: ResearchSourceIdentity): string {
  return `${source.documentId}\0${source.revisionId}`
}

function sourceKey(source: ResearchSourceIdentity): string {
  return `${source.documentId}\0${source.revisionId}\0${source.representationId}\0${source.representationContentHash}`
}
