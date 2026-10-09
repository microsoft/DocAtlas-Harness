import {
  evidenceLocatorIssues,
  documentLocatorIssues,
  type ContractIssue,
  type ContractIssueCode,
  type ActorRef,
  type DocumentLocator,
  type EvidenceAtom,
  type OpaqueId,
  type Sha256,
} from './m0-contracts.js'

export const MAX_ANSWER_MANIFEST_BYTES = 512 * 1024

export type AnswerSegmentKind =
  | 'factual'
  | 'derived'
  | 'interpretive'
  | 'procedural'
  | 'social'
  | 'unclassified'

export type AnswerSegmentStatus =
  | 'supported'
  | 'qualified'
  | 'contested'
  | 'unresolved'
  | 'not-applicable'

export type CitationRelation = 'support' | 'refute' | 'qualify'
export type AnswerManifestWarning =
  | 'unclassified-text'
  | 'unknown-locator'
  | 'malformed-marker'
  | 'scope-conflict'
  | 'locator-without-text'
  | 'limit-exceeded'

export interface AnswerSegment {
  segmentId: OpaqueId
  text: string
  kind: AnswerSegmentKind
  status: AnswerSegmentStatus
  claimVersionIds: OpaqueId[]
  visibleCitationIds: OpaqueId[]
}

export interface AnswerBlock {
  blockId: OpaqueId
  sourceBlockIndex: number
  kind: 'prose'
  segments: AnswerSegment[]
}

export interface CitationPresentation {
  citationId: OpaqueId
  ordinal: number
  relation: CitationRelation
  relationAssertedBy: ActorRef
  focusId: OpaqueId
  locator: DocumentLocator
  verificationStatus: 'read-verified' | 'locator-only'
  evidence?: EvidenceAtom
}

export interface AnswerVerificationSummary {
  factualSegments: number
  mappedFactualSegments: number
  supportedSegments: number
  qualifiedSegments: number
  contestedSegments: number
  unresolvedSegments: number
  unclassifiedSegments: number
  citationCount: number
  complete: boolean
  warnings: AnswerManifestWarning[]
}

export interface AnswerManifest {
  schemaVersion: 1
  manifestId: OpaqueId
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  messageId: OpaqueId
  turn: number
  sourceScopeVersionId: OpaqueId
  mode: 'explore' | 'verify' | 'publish'
  manifestStatus: 'mapped' | 'partial' | 'unmapped'
  answerTextHash: Sha256
  blocks: AnswerBlock[]
  citations: CitationPresentation[]
  verificationSummary: AnswerVerificationSummary
  createdAt: string
}

export interface AnswerGetRequest {
  schemaVersion: 1
  requestType: 'answer-get'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  messageId: OpaqueId
}

export interface AnswerGetResult {
  schemaVersion: 1
  resultType: 'answer-manifest'
  workspaceId: OpaqueId
  messageId: OpaqueId
  status: 'available' | 'unavailable'
  manifest?: AnswerManifest
}

export type AnswerRpcValue = AnswerGetRequest | AnswerGetResult

export function answerManifestIssues(value: AnswerManifest): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_ANSWER_MANIFEST_BYTES) {
    add('answer-manifest-size', '/', 'answer manifest exceeds its canonical byte limit')
  }
  const ids = new Set<string>()
  const citations = new Map<string, CitationPresentation>()
  for (const [index, citation] of value.citations.entries()) {
    uniqueId(citation.citationId, `/citations/${index}/citationId`, ids, add)
    citations.set(citation.citationId, citation)
    if (citation.ordinal !== index + 1) {
      add('answer-citation-identity', `/citations/${index}/ordinal`, 'citation ordinals must be contiguous in presentation order')
    }
    if (citation.focusId !== citation.locator.locatorId) {
      add('answer-citation-identity', `/citations/${index}/focusId`, 'citation focus must equal its locator id')
    }
    for (const issue of documentLocatorIssues(citation.locator)) {
      add(issue.code, `/citations/${index}/locator${suffix(issue.path)}`, issue.message)
    }
    if (citation.relationAssertedBy.kind !== 'agent') {
      add('answer-citation-identity', `/citations/${index}/relationAssertedBy`, 'citation evidence relation must remain an explicit Agent assertion')
    }
    const hasEvidence = citation.evidence !== undefined
    if ((citation.verificationStatus === 'read-verified') !== hasEvidence) {
      add('answer-evidence-identity', `/citations/${index}/verificationStatus`, 'read-verified citation status requires one EvidenceAtom')
    }
    if (citation.evidence !== undefined) {
      for (const issue of evidenceLocatorIssues(citation.evidence, citation.locator)) {
        add(issue.code, `/citations/${index}/evidence${suffix(issue.path)}`, issue.message)
      }
      const quote = citation.locator.selectors.find(selector => selector.type === 'text-quote')
      if (quote?.type !== 'text-quote'
        || citation.evidence.content.text !== quote.exact
        || citation.evidence.contentHash !== quote.normalizedHash
        || citation.evidence.resolutionStatus !== 'resolved'
        || citation.evidence.status !== 'current') {
        add('answer-evidence-identity', `/citations/${index}/evidence`, 'read-verified Evidence must equal the current resolved Locator quote')
      }
    }
  }

  const segments = value.blocks.flatMap((block, blockIndex) => {
    uniqueId(block.blockId, `/blocks/${blockIndex}/blockId`, ids, add)
    return block.segments.map((segment, segmentIndex) => {
      uniqueId(segment.segmentId, `/blocks/${blockIndex}/segments/${segmentIndex}/segmentId`, ids, add)
      for (const citationId of segment.visibleCitationIds) {
        if (!citations.has(citationId)) {
          add('answer-citation-reference', `/blocks/${blockIndex}/segments/${segmentIndex}/visibleCitationIds`, 'answer segment references an unknown citation')
        }
      }
      validateSegmentStatus(segment, citations, `/blocks/${blockIndex}/segments/${segmentIndex}`, add)
      return segment
    })
  })
  const referenced = new Set(segments.flatMap(segment => segment.visibleCitationIds))
  for (const [index, citation] of value.citations.entries()) {
    if (!referenced.has(citation.citationId)) {
      add('answer-citation-reference', `/citations/${index}/citationId`, 'every citation must be visible from at least one segment')
    }
  }
  const expected = answerVerificationSummary(
    segments,
    value.citations,
    value.verificationSummary.warnings,
  )
  if (!sameSummary(expected, value.verificationSummary)) {
    add('answer-summary-mismatch', '/verificationSummary', 'verification summary must be derived exactly from answer segments and citations')
  }
  const expectedStatus = expected.factualSegments === 0
    ? 'unmapped'
    : expected.unresolvedSegments === 0 && expected.unclassifiedSegments === 0
      ? 'mapped'
      : 'partial'
  if (value.manifestStatus !== expectedStatus) {
    add('answer-status-mismatch', '/manifestStatus', 'manifest status must match its segment coverage')
  }
  return issues
}

export function answerRpcIssues(value: AnswerRpcValue): ContractIssue[] {
  if ('requestType' in value || value.manifest === undefined) return []
  const issues = answerManifestIssues(value.manifest)
  if (value.workspaceId !== value.manifest.workspaceId
    || value.messageId !== value.manifest.messageId) {
    issues.push({
      code: 'answer-rpc-identity',
      path: '/manifest',
      message: 'answer RPC identity must match its manifest',
    })
  }
  return issues
}

export function answerVerificationSummary(
  segments: readonly AnswerSegment[],
  citations: readonly CitationPresentation[],
  extraWarnings: readonly AnswerManifestWarning[] = [],
): AnswerVerificationSummary {
  const factual = segments.filter(segment => segment.kind === 'factual')
  const supported = factual.filter(segment => segment.status === 'supported').length
  const qualified = factual.filter(segment => segment.status === 'qualified').length
  const contested = factual.filter(segment => segment.status === 'contested').length
  const unresolved = factual.filter(segment => segment.status === 'unresolved').length
  const unclassified = segments.filter(segment => segment.kind === 'unclassified').length
  const warnings = new Set(extraWarnings)
  if (unclassified > 0) warnings.add('unclassified-text')
  if (citations.some(citation => citation.verificationStatus === 'locator-only')) {
    warnings.add('locator-without-text')
  }
  return {
    factualSegments: factual.length,
    mappedFactualSegments: supported + qualified + contested,
    supportedSegments: supported,
    qualifiedSegments: qualified,
    contestedSegments: contested,
    unresolvedSegments: unresolved,
    unclassifiedSegments: unclassified,
    citationCount: citations.length,
    complete: factual.length > 0 && unresolved === 0 && unclassified === 0,
    warnings: [...warnings].sort(),
  }
}

function validateSegmentStatus(
  segment: AnswerSegment,
  citations: ReadonlyMap<string, CitationPresentation>,
  path: string,
  add: (code: ContractIssueCode, path: string, message: string) => void,
): void {
  const linked = segment.visibleCitationIds.flatMap(id => {
    const citation = citations.get(id)
    return citation === undefined ? [] : [citation]
  })
  if (segment.kind === 'unclassified') {
    if (segment.status !== 'unresolved' || segment.visibleCitationIds.length > 0) {
      add('answer-segment-status', path, 'unclassified segments must remain unresolved and uncited')
    }
    return
  }
  if (segment.kind !== 'factual') return
  const verified = linked.length > 0
    && linked.every(citation => citation.verificationStatus === 'read-verified')
  const expected: AnswerSegmentStatus = !verified
    ? 'unresolved'
    : linked.some(citation => citation.relation === 'refute')
      ? 'contested'
      : linked.some(citation => citation.relation === 'qualify')
        ? 'qualified'
        : 'supported'
  if (segment.status !== expected) {
    add('answer-segment-status', `${path}/status`, 'factual segment status must follow its verified evidence relations')
  }
}

function uniqueId(
  id: string,
  path: string,
  ids: Set<string>,
  add: (code: ContractIssueCode, path: string, message: string) => void,
): void {
  if (ids.has(id)) add('answer-duplicate-id', path, 'answer manifest object ids must be unique')
  ids.add(id)
}

function sameSummary(left: AnswerVerificationSummary, right: AnswerVerificationSummary): boolean {
  return left.factualSegments === right.factualSegments
    && left.mappedFactualSegments === right.mappedFactualSegments
    && left.supportedSegments === right.supportedSegments
    && left.qualifiedSegments === right.qualifiedSegments
    && left.contestedSegments === right.contestedSegments
    && left.unresolvedSegments === right.unresolvedSegments
    && left.unclassifiedSegments === right.unclassifiedSegments
    && left.citationCount === right.citationCount
    && left.complete === right.complete
    && left.warnings.length === right.warnings.length
    && left.warnings.every((warning, index) => warning === right.warnings[index])
}

function suffix(path: string): string {
  return path === '/' ? '' : path
}
