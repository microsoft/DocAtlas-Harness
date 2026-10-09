import {
  documentRevisionIssues,
  pageInfoIssues,
  sourceRepresentationIssues,
} from './m0-contracts.js'
import type {
  ContractIssue,
  ContractIssueCode,
  DocumentRevision,
  OpaqueId,
  PageInfo,
  ProtocolError,
  SourceRepresentation,
  SourceRole,
} from './m0-contracts.js'

export type LibraryCapability = 'text' | 'ocr' | 'table' | 'figure' | 'page-image' | 'original'
export type LibraryDocumentStatus = 'ready' | 'partial' | 'archived'

export interface LibraryDocument {
  schemaVersion: 1
  workspaceId: OpaqueId
  documentId: OpaqueId
  displayName: string
  mediaType: 'application/pdf' | 'text/markdown' | 'text/plain'
  sourceRole: SourceRole
  status: LibraryDocumentStatus
  revisionCount: number
  currentRevision: DocumentRevision
  representations: SourceRepresentation[]
  activeRepresentationId: OpaqueId
  capabilities: LibraryCapability[]
  createdAt: string
  updatedAt: string
}

export interface LibraryDocumentSummary {
  documentId: OpaqueId
  displayName: string
  mediaType: LibraryDocument['mediaType']
  sourceRole: SourceRole
  status: LibraryDocumentStatus
  revisionCount: number
  currentRevisionId: OpaqueId
  capabilities: LibraryCapability[]
  updatedAt: string
}

export interface LibraryCandidate {
  candidateId: OpaqueId
  rootId: OpaqueId
  displayName: string
  mediaType: LibraryDocument['mediaType']
  byteLength: number
  modifiedAt: string
  observedAt: string
  expiresAt: string
}

export interface LibraryDiscoverRequest {
  schemaVersion: 1
  requestType: 'library-discover'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  rootId?: OpaqueId
  query?: string
  limit: number
  cursor?: OpaqueId
}

export interface LibraryDiscoverResult {
  schemaVersion: 1
  resultType: 'library-candidates'
  workspaceId: OpaqueId
  candidates: LibraryCandidate[]
  pageInfo: PageInfo
}

/** Explicit logical-document association; the physical source remains immutable and independently verified. */
export interface LibraryRevisionTarget {
  documentId: OpaqueId
  expectedCurrentRevisionId: OpaqueId
}

export interface LibraryImportRequest {
  schemaVersion: 1
  requestType: 'library-import'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  candidateId: OpaqueId
  sourceRole: SourceRole
  idempotencyKey: OpaqueId
  revisionTarget?: LibraryRevisionTarget
}

export interface LibraryImportResult {
  schemaVersion: 1
  resultType: 'library-import-accepted'
  workspaceId: OpaqueId
  jobId: OpaqueId
  status: 'queued' | 'replayed'
}

export interface LibraryJobRequest {
  schemaVersion: 1
  requestType: 'library-job-get'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  jobId: OpaqueId
}

export interface LibraryJobResult {
  schemaVersion: 1
  resultType: 'library-job'
  workspaceId: OpaqueId
  jobId: OpaqueId
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  phase: 'queued' | 'hashing' | 'ingesting' | 'committing' | 'complete'
  document?: LibraryDocument
  error?: ProtocolError
  createdAt: string
  updatedAt: string
}

export interface LibraryListRequest {
  schemaVersion: 1
  requestType: 'library-list'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  query?: string
  status?: LibraryDocumentStatus[]
  limit: number
  cursor?: OpaqueId
  sort: 'updated-desc' | 'name-asc'
}

export interface LibraryListResult {
  schemaVersion: 1
  resultType: 'library-documents'
  workspaceId: OpaqueId
  documents: LibraryDocumentSummary[]
  pageInfo: PageInfo
}

export interface LibraryGetRequest {
  schemaVersion: 1
  requestType: 'library-get'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  documentId: OpaqueId
}

export interface LibraryGetResult {
  schemaVersion: 1
  resultType: 'library-document'
  workspaceId: OpaqueId
  document: LibraryDocument
}

export type LibraryRpcRequest =
  | LibraryDiscoverRequest
  | LibraryImportRequest
  | LibraryJobRequest
  | LibraryListRequest
  | LibraryGetRequest

export type LibraryRpcResult =
  | LibraryDiscoverResult
  | LibraryImportResult
  | LibraryJobResult
  | LibraryListResult
  | LibraryGetResult

export function libraryDocumentIssues(value: LibraryDocument): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  for (const issue of documentRevisionIssues(value.currentRevision)) {
    add(issue.code, `/currentRevision${suffix(issue.path)}`, issue.message)
  }
  if (value.currentRevision.documentId !== value.documentId) {
    add('library-revision-identity', '/currentRevision/documentId', 'Library document and current revision identities must match')
  }
  if (value.currentRevision.displayName !== value.displayName
    || value.currentRevision.mediaType !== value.mediaType) {
    add('library-revision-display', '/currentRevision', 'Library display and media facts must match the current revision')
  }
  const representationIds = new Set<string>()
  const originals: SourceRepresentation[] = []
  let active = false
  for (const [index, representation] of value.representations.entries()) {
    for (const issue of sourceRepresentationIssues(representation)) {
      add(issue.code, `/representations/${index}${suffix(issue.path)}`, issue.message)
    }
    if (representationIds.has(representation.representationId)) {
      add('library-duplicate-representation', `/representations/${index}/representationId`, 'Library representation ids must be unique')
    }
    representationIds.add(representation.representationId)
    if (representation.kind === 'original-bytes') originals.push(representation)
    if (representation.documentId !== value.documentId
      || representation.revisionId !== value.currentRevision.revisionId) {
      add('library-representation-identity', `/representations/${index}`, 'Library representation must belong to the current revision')
    }
    active ||= representation.representationId === value.activeRepresentationId
  }
  for (const [index, representation] of value.representations.entries()) {
    if (representation.derivedFromRepresentationIds.some(id => !representationIds.has(id))) {
      add('library-representation-lineage', `/representations/${index}/derivedFromRepresentationIds`, 'Library representation lineage must remain inside the current revision')
    }
  }
  if (originals.length !== 1
    || originals[0]?.contentHash !== value.currentRevision.contentHash
    || originals[0]?.byteLength !== value.currentRevision.byteLength
    || originals[0]?.mediaType !== value.currentRevision.mediaType) {
    add('library-original-representation', '/representations', 'Library current revision requires one matching original representation')
  }
  if (!active) {
    add('library-active-representation', '/activeRepresentationId', 'active Library representation must exist in the current revision')
  }
  const expectedCapabilities = capabilitiesOf(value.representations)
  if (expectedCapabilities.size !== value.capabilities.length
    || value.capabilities.some(capability => !expectedCapabilities.has(capability))) {
    add('library-capability-mismatch', '/capabilities', 'Library capabilities must be derived exactly from current representations')
  }
  if (Date.parse(value.createdAt) > Date.parse(value.updatedAt)) {
    add('library-time-order', '/updatedAt', 'Library updatedAt must not precede createdAt')
  }
  return issues
}

export function libraryRpcIssues(value: LibraryRpcRequest | LibraryRpcResult): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('pageInfo' in value) {
    for (const issue of pageInfoIssues(value.pageInfo)) {
      add(issue.code, `/pageInfo${suffix(issue.path)}`, issue.message)
    }
  }
  if ('candidates' in value) {
    const ids = new Set<string>()
    for (const [index, candidate] of value.candidates.entries()) {
      if (ids.has(candidate.candidateId)) {
        add('library-duplicate-candidate', `/candidates/${index}/candidateId`, 'Library candidate ids must be unique')
      }
      ids.add(candidate.candidateId)
      if (Date.parse(candidate.observedAt) >= Date.parse(candidate.expiresAt)) {
        add('library-candidate-expiry', `/candidates/${index}/expiresAt`, 'candidate expiry must follow discovery time')
      }
    }
  }
  if ('documents' in value) {
    const ids = new Set<string>()
    for (const [index, document] of value.documents.entries()) {
      if (ids.has(document.documentId)) {
        add('library-duplicate-document', `/documents/${index}/documentId`, 'Library list document ids must be unique')
      }
      ids.add(document.documentId)
    }
  }
  if ('document' in value && value.document !== undefined) {
    for (const issue of libraryDocumentIssues(value.document)) {
      add(issue.code, `/document${suffix(issue.path)}`, issue.message)
    }
    if ('workspaceId' in value && value.document.workspaceId !== value.workspaceId) {
      add('library-workspace-identity', '/document/workspaceId', 'Library result and document workspace identities must match')
    }
  }
  if ('resultType' in value && value.resultType === 'library-job') {
    const phaseMatches = value.status === 'queued'
      ? value.phase === 'queued'
      : value.status === 'running'
        ? ['hashing', 'ingesting', 'committing'].includes(value.phase)
        : value.phase === 'complete'
    if (!phaseMatches) {
      add('library-job-phase', '/phase', 'Library job phase is incompatible with its status')
    }
  }
  return issues
}

function suffix(path: string): string {
  return path === '/' ? '' : path
}

function capabilitiesOf(representations: readonly SourceRepresentation[]): Set<LibraryCapability> {
  const result = new Set<LibraryCapability>()
  for (const representation of representations) {
    switch (representation.kind) {
      case 'original-bytes': result.add('original'); break
      case 'embedded-text':
      case 'derived-markdown': result.add('text'); break
      case 'ocr-text': result.add('text'); result.add('ocr'); break
      case 'table-extraction': result.add('table'); break
      case 'figure-crop': result.add('figure'); break
      case 'page-image': result.add('page-image'); break
      case 'model-description': break
    }
  }
  return result
}
