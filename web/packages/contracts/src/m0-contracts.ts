export type ContractSchemaVersion = 1
export type OpaqueId = string
export type Sha256 = string
export type IsoTimestamp = string

export type ActorKind = 'user' | 'agent' | 'system' | 'rule'

export interface ActorRef {
  kind: ActorKind
  actorId: OpaqueId
}

export type SourceRole = 'primary' | 'secondary' | 'external' | 'user-authored' | 'model-derived'

export type ProtocolErrorCode =
  | 'invalid-request'
  | 'invalid-params'
  | 'not-found'
  | 'conflict'
  | 'stale'
  | 'permission-denied'
  | 'limit-exceeded'
  | 'cancelled'
  | 'unavailable'
  | 'integrity-error'
  | 'internal'

export interface ProtocolError {
  schemaVersion: ContractSchemaVersion
  code: ProtocolErrorCode
  message: string
  retryable: boolean
  correlationId?: OpaqueId
  details?: Array<{
    path?: string
    reason: string
    expected?: string
    actual?: string
  }>
  nextActions?: Array<
    | 'retry'
    | 'reduce-scope'
    | 'request-access'
    | 'open-old-revision'
    | 're-anchor'
    | 'load-next'
    | 'choose-candidate'
    | 'contact-operator'
  >
}

export interface PageInfo {
  schemaVersion: ContractSchemaVersion
  limit: number
  returned: number
  total?: number
  usedChars?: number
  truncated: boolean
  completeness: 'candidate' | 'partial' | 'complete'
  nextCursor?: OpaqueId
}

export interface DocumentRevision {
  schemaVersion: ContractSchemaVersion
  documentId: OpaqueId
  revisionId: OpaqueId
  contentHash: Sha256
  byteLength: number
  mediaType: string
  displayName: string
  origin: {
    kind: 'local-file' | 'upload' | 'remote-url' | 'provider' | 'generated'
    providerId?: OpaqueId
    externalId?: string
  }
  ingestedAt: IsoTimestamp
  sourceModifiedAt?: IsoTimestamp
  previousRevisionId?: OpaqueId
  supersededByRevisionId?: OpaqueId
  pageCount?: number
  status: 'active' | 'superseded' | 'deleted' | 'quarantined'
}

export type RepresentationKind =
  | 'original-bytes'
  | 'page-image'
  | 'embedded-text'
  | 'ocr-text'
  | 'derived-markdown'
  | 'table-extraction'
  | 'figure-crop'
  | 'model-description'

export interface SourceRepresentation {
  schemaVersion: ContractSchemaVersion
  representationId: OpaqueId
  documentId: OpaqueId
  revisionId: OpaqueId
  kind: RepresentationKind
  mediaType: string
  contentHash: Sha256
  byteLength: number
  pageCount?: number
  textQuality?: 'empty' | 'sparse' | 'garbled' | 'usable' | 'not-applicable'
  derivedFromRepresentationIds: OpaqueId[]
  generator?: {
    name: string
    version: string
    configHash: Sha256
  }
  createdAt: IsoTimestamp
  status: 'current' | 'stale' | 'failed' | 'deleted'
}

export interface IncludedSource {
  documentId: OpaqueId
  revisionId: OpaqueId
  role: SourceRole
  reason?: string
}

export interface ExcludedSource {
  documentId: OpaqueId
  revisionId: OpaqueId
  reason: 'user' | 'policy' | 'permission' | 'out-of-date' | 'duplicate' | 'other'
  detail?: string
}

export interface SourceScopeVersion {
  schemaVersion: ContractSchemaVersion
  scopeVersionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  version: number
  previousScopeVersionId?: OpaqueId
  included: IncludedSource[]
  excluded: ExcludedSource[]
  locked: boolean
  policyTags?: OpaqueId[]
  createdBy: ActorRef
  createdAt: IsoTimestamp
}

export interface BlockSelector {
  type: 'block'
  blockId: OpaqueId
}

export interface TextQuoteSelector {
  type: 'text-quote'
  exact: string
  prefix?: string
  suffix?: string
  normalizedHash: Sha256
}

export interface TextPositionSelector {
  type: 'text-position'
  start: number
  end: number
  unit: 'unicode-scalar'
}

export interface RatioBBoxSelector {
  type: 'bbox'
  unit: 'ratio'
  x: number
  y: number
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
}

export interface PdfPointBBoxSelector {
  type: 'bbox'
  unit: 'pdf-point'
  x: number
  y: number
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
}

export interface TableCellSelector {
  type: 'table-cell'
  tableId: OpaqueId
  row?: number
  column?: number
}

export interface FigureSelector {
  type: 'figure'
  figureId: OpaqueId
}

export type DocumentSelector =
  | BlockSelector
  | TextQuoteSelector
  | TextPositionSelector
  | RatioBBoxSelector
  | PdfPointBBoxSelector
  | TableCellSelector
  | FigureSelector

export interface DocumentLocator {
  schemaVersion: ContractSchemaVersion
  locatorId: OpaqueId
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  representationContentHash: Sha256
  physicalPage: number
  selectors: DocumentSelector[]
  supersedesLocatorId?: OpaqueId
  createdAt: IsoTimestamp
}

export interface EvidenceAtom {
  schemaVersion: ContractSchemaVersion
  evidenceId: OpaqueId
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  locatorId: OpaqueId
  kind: 'quote' | 'table-cell' | 'figure' | 'visual-observation'
  content: {
    mediaType: string
    text?: string
    assetId?: OpaqueId
  }
  contentHash: Sha256
  sourceRole: SourceRole
  resolutionStatus: 'resolved' | 'page-only' | 'ambiguous' | 'stale' | 'missing' | 'denied'
  status: 'current' | 'stale' | 'withdrawn' | 'deleted'
  createdBy: ActorRef
  provenanceActivityId: OpaqueId
  createdAt: IsoTimestamp
}

export interface LegacyEvidenceLead {
  schemaVersion: ContractSchemaVersion
  leadId: OpaqueId
  legacyKind: 'note-evidence' | 'page-finding' | 'read-history' | 'search-history'
  sourceSessionId: OpaqueId
  rawSource: string
  rawContent?: string
  physicalPageCandidate?: number
  documentCandidates: Array<{ documentId: OpaqueId, revisionId: OpaqueId }>
  resolutionStatus: 'unresolved'
  verificationStatus: 'unverified'
  importedBy: ActorRef
  importedAt: IsoTimestamp
}

export type LegacyEvidenceLeadInput = Omit<
  LegacyEvidenceLead,
  'schemaVersion' | 'physicalPageCandidate' | 'resolutionStatus' | 'verificationStatus'
>

const LEGACY_PHYSICAL_PAGE = /\b(?:page|p\.)\s*([1-9][0-9]*)\b/i

/** Convert page-only legacy material into an explicitly unresolved lead. */
export function buildLegacyEvidenceLead(input: LegacyEvidenceLeadInput): LegacyEvidenceLead {
  const rawSource = input.rawSource.trim()
  if (rawSource.length === 0) throw new Error('legacy evidence rawSource must not be empty')
  const match = LEGACY_PHYSICAL_PAGE.exec(rawSource)
  const physicalPageCandidate = match?.[1] === undefined ? undefined : Number(match[1])
  return {
    schemaVersion: 1,
    ...input,
    rawSource,
    ...(physicalPageCandidate === undefined ? {} : { physicalPageCandidate }),
    resolutionStatus: 'unresolved',
    verificationStatus: 'unverified',
  }
}

export type ContractIssueCode =
  | M4ContractIssueCode
  | PersonalizationContractIssueCode
  | 'page-returned-exceeds-limit'
  | 'page-returned-exceeds-total'
  | 'revision-self-previous'
  | 'revision-self-supersedes'
  | 'representation-self-derived'
  | 'representation-revision-mismatch'
  | 'representation-original-hash-mismatch'
  | 'scope-first-version-has-previous'
  | 'scope-later-version-missing-previous'
  | 'scope-duplicate-included'
  | 'scope-duplicate-excluded'
  | 'scope-included-and-excluded'
  | 'locator-self-supersedes'
  | 'locator-text-position-order'
  | 'locator-ratio-bounds'
  | 'evidence-locator-mismatch'
  | 'asset-original-hash-mismatch'
  | 'asset-original-visual-fields'
  | 'asset-pixel-limit'
  | 'asset-byte-limit'
  | 'asset-page-has-figure'
  | 'selection-context-size'
  | 'selection-actor-not-user'
  | 'selection-duplicate-id'
  | 'selection-duplicate-locator'
  | 'selection-locator-mismatch'
  | 'selection-content-completeness'
  | 'selection-content-length'
  | 'selection-kind-selector-mismatch'
  | 'selection-proposal-duplicate'
  | 'selection-range-cardinality'
  | 'selection-proposal-kind-mismatch'
  | 'selection-preview-page-order'
  | 'selection-action-record-mismatch'
  | 'selection-action-evidence-identity'
  | 'scope-rpc-active-shape'
  | 'scope-rpc-unlocked'
  | 'scope-patch-conflict'
  | 'scope-overview-identity'
  | 'scope-overview-item'
  | 'scope-rpc-duplicate-source'
  | 'scope-rpc-source-outside-included'
  | 'scope-rpc-included-without-source'
  | 'scope-rpc-cas-shape'
  | 'library-revision-identity'
  | 'library-revision-display'
  | 'library-duplicate-representation'
  | 'library-representation-identity'
  | 'library-active-representation'
  | 'library-time-order'
  | 'library-duplicate-candidate'
  | 'library-candidate-expiry'
  | 'library-duplicate-document'
  | 'library-workspace-identity'
  | 'library-job-phase'
  | 'library-representation-lineage'
  | 'library-original-representation'
  | 'library-capability-mismatch'
  | 'reader-focus-identity'
  | 'reader-focus-result-identity'
  | 'reader-focus-candidate-limit'
  | 'reader-focus-document-identity'
  | 'reader-page-identity'
  | 'reader-page-item-identity'
  | 'reader-page-count'
  | 'reader-page-pixel-limit'
  | 'research-recall-identity'
  | 'research-recall-count'
  | 'research-recall-duplicate'
  | 'research-recall-source-state'
  | 'research-recall-filter'
  | 'research-record-actor'
  | 'research-record-identity'
  | 'research-record-kind'
  | 'research-lifecycle-actor'
  | 'research-lifecycle-version'
  | 'research-lifecycle-content'
  | 'research-lifecycle-identity'
  | 'research-governance-actor'
  | 'research-governance-content'
  | 'research-governance-identity'
  | 'research-governance-version'
  | 'research-governance-action'
  | 'research-notebook-count'
  | 'research-notebook-duplicate'
  | 'research-notebook-source-state'
  | 'research-notebook-layer'
  | 'research-notebook-use'
  | 'research-notebook-identity'
  | 'research-notebook-filter'
  | 'tree-overlay-count'
  | 'tree-overlay-duplicate'
  | 'tree-overlay-anchor'
  | 'tree-overlay-status'
  | 'tree-overlay-identity'
  | 'tree-overlay-filter'
  | 'tree-overlay-layer'
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
  | 'answer-manifest-size'
  | 'answer-duplicate-id'
  | 'answer-citation-reference'
  | 'answer-citation-identity'
  | 'answer-evidence-identity'
  | 'answer-segment-status'
  | 'answer-summary-mismatch'
  | 'answer-status-mismatch'
  | 'answer-rpc-identity'

export interface ContractIssue {
  code: ContractIssueCode
  path: string
  message: string
}

function issue(code: ContractIssueCode, path: string, message: string): ContractIssue {
  return { code, path, message }
}

function sourceIdentityKey(value: { documentId: string, revisionId: string }): string {
  return `${value.documentId}\u0000${value.revisionId}`
}

export function pageInfoIssues(value: PageInfo): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (value.returned > value.limit) {
    issues.push(issue(
      'page-returned-exceeds-limit',
      '/returned',
      'returned must not exceed limit',
    ))
  }
  if (value.total !== undefined && value.returned > value.total) {
    issues.push(issue(
      'page-returned-exceeds-total',
      '/returned',
      'returned must not exceed total',
    ))
  }
  return issues
}

export function documentRevisionIssues(value: DocumentRevision): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (value.previousRevisionId === value.revisionId) {
    issues.push(issue(
      'revision-self-previous',
      '/previousRevisionId',
      'a revision cannot name itself as its previous revision',
    ))
  }
  if (value.supersededByRevisionId === value.revisionId) {
    issues.push(issue(
      'revision-self-supersedes',
      '/supersededByRevisionId',
      'a revision cannot supersede itself',
    ))
  }
  return issues
}

export function sourceRepresentationIssues(
  value: SourceRepresentation,
  revision?: DocumentRevision,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (value.derivedFromRepresentationIds.includes(value.representationId)) {
    issues.push(issue(
      'representation-self-derived',
      '/derivedFromRepresentationIds',
      'a representation cannot derive from itself',
    ))
  }
  if (revision !== undefined
    && (value.documentId !== revision.documentId || value.revisionId !== revision.revisionId)) {
    issues.push(issue(
      'representation-revision-mismatch',
      '/',
      'representation document/revision identity must match its revision',
    ))
  }
  if (revision !== undefined
    && value.kind === 'original-bytes'
    && value.contentHash !== revision.contentHash) {
    issues.push(issue(
      'representation-original-hash-mismatch',
      '/contentHash',
      'the original representation hash must match the revision content hash',
    ))
  }
  return issues
}

export function sourceScopeIssues(value: SourceScopeVersion): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (value.version === 1 && value.previousScopeVersionId !== undefined) {
    issues.push(issue(
      'scope-first-version-has-previous',
      '/previousScopeVersionId',
      'source scope version 1 must not name a previous version',
    ))
  }
  if (value.version > 1 && value.previousScopeVersionId === undefined) {
    issues.push(issue(
      'scope-later-version-missing-previous',
      '/previousScopeVersionId',
      'source scope versions after 1 must name their previous version',
    ))
  }

  const included = new Set<string>()
  for (const [index, entry] of value.included.entries()) {
    const key = sourceIdentityKey(entry)
    if (included.has(key)) {
      issues.push(issue(
        'scope-duplicate-included',
        `/included/${index}`,
        'the same document revision cannot be included more than once',
      ))
    }
    included.add(key)
  }

  const excluded = new Set<string>()
  for (const [index, entry] of value.excluded.entries()) {
    const key = sourceIdentityKey(entry)
    if (excluded.has(key)) {
      issues.push(issue(
        'scope-duplicate-excluded',
        `/excluded/${index}`,
        'the same document revision cannot be excluded more than once',
      ))
    }
    if (included.has(key)) {
      issues.push(issue(
        'scope-included-and-excluded',
        `/excluded/${index}`,
        'the same document revision cannot be both included and excluded',
      ))
    }
    excluded.add(key)
  }
  return issues
}

export function documentLocatorIssues(value: DocumentLocator): ContractIssue[] {
  const issues: ContractIssue[] = []
  if (value.supersedesLocatorId === value.locatorId) {
    issues.push(issue(
      'locator-self-supersedes',
      '/supersedesLocatorId',
      'a locator cannot supersede itself',
    ))
  }
  for (const [index, selector] of value.selectors.entries()) {
    if (selector.type === 'text-position' && selector.start >= selector.end) {
      issues.push(issue(
        'locator-text-position-order',
        `/selectors/${index}`,
        'text position start must be less than end',
      ))
    }
    if (selector.type === 'bbox'
      && selector.unit === 'ratio'
      && (selector.x + selector.width > 1 || selector.y + selector.height > 1)) {
      issues.push(issue(
        'locator-ratio-bounds',
        `/selectors/${index}`,
        'ratio bounding boxes must remain inside the page',
      ))
    }
  }
  return issues
}

export function evidenceLocatorIssues(
  evidence: EvidenceAtom,
  locator: DocumentLocator,
): ContractIssue[] {
  if (evidence.locatorId === locator.locatorId
    && evidence.documentId === locator.documentId
    && evidence.revisionId === locator.revisionId
    && evidence.representationId === locator.representationId) {
    return []
  }
  return [issue(
    'evidence-locator-mismatch',
    '/',
    'evidence and locator identities must match exactly',
  )]
}
import type { M4ContractIssueCode } from './m4-contract-issues.js'
import type { PersonalizationContractIssueCode } from './personalization-contract-issues.js'
