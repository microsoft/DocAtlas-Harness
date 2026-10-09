import type {
  DocumentLocator,
  DocumentRevision,
  OpaqueId,
  PageInfo,
  Sha256,
  SourceRepresentation,
} from './m0-contracts.js'
import type { ProgressiveReadMode } from './sidecar-protocol.js'

export interface SourceIdentity {
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
}

export interface SourceBinding {
  schemaVersion: 1
  bindingId: OpaqueId
  rootId: OpaqueId
  relativePath: string
  expectedContentHash: Sha256
  byteLength: number
  mediaType: string
}

export type IngestRevision = Omit<
  DocumentRevision,
  'status' | 'supersededByRevisionId'
> & {
  status: 'active'
}

export interface IngestRequest {
  schemaVersion: 1
  requestType: 'ingest'
  idempotencyKey: OpaqueId
  revision: IngestRevision
  sourceBinding: SourceBinding
  requestedRepresentationKinds: Array<
    | 'embedded-text'
    | 'ocr-text'
    | 'derived-markdown'
    | 'page-image'
    | 'table-extraction'
    | 'figure-crop'
    | 'model-description'
  >
  options: {
    forceRebuild: boolean
    allowOcr: boolean
    maxPages?: number
  }
}

export interface IngestResult {
  schemaVersion: 1
  resultType: 'ingest'
  idempotencyKey: OpaqueId
  documentId: OpaqueId
  revisionId: OpaqueId
  cacheStatus: 'created' | 'reused' | 'refreshed'
  representations: SourceRepresentation[]
  index: {
    status: 'ready' | 'partial'
    blockCount: number
    indexedPages: number
    totalPages: number
    textQuality: 'empty' | 'sparse' | 'garbled' | 'usable'
  }
  warnings: string[]
}

export interface TextLimits {
  maxItems: number
  maxChars: number
}

export interface SearchRequest {
  schemaVersion: 1
  requestType: 'search'
  scopeVersionId: OpaqueId
  sources: SourceIdentity[]
  query: string
  strategy: 'tree' | 'fts' | 'combined'
  limits: TextLimits
  cursor?: OpaqueId
}

export interface SearchCandidate extends SourceIdentity {
  candidateId: OpaqueId
  physicalPageStart: number
  physicalPageEnd: number
  blockIds: OpaqueId[]
  title: string
  preview: string
  matchKind: 'tree' | 'lexical' | 'combined'
  score?: number
  reason: string
}

export interface SearchResult {
  schemaVersion: 1
  resultType: 'search'
  scopeVersionId: OpaqueId
  queryHash: Sha256
  candidates: SearchCandidate[]
  pageInfo: PageInfo
}

interface ReadRequestBase {
  schemaVersion: 1
  requestType: 'read'
  source: SourceIdentity
  limits: TextLimits
  cursor?: OpaqueId
}

export interface ReadLocateRequest extends ReadRequestBase {
  mode: 'locate'
  query: string
}

export interface ReadBlocksRequest extends ReadRequestBase {
  mode: 'blocks'
  blockIds: OpaqueId[]
}

export interface ReadExpandRequest extends ReadRequestBase {
  mode: 'expand'
  targetBlockId: OpaqueId
  before: number
  after: number
}

export interface ReadSequentialRequest extends ReadRequestBase {
  mode: 'sequential'
}

/** Bounded blocks from one physical page for the authenticated browser Reader. */
export interface ReadPageRequest extends ReadRequestBase {
  mode: 'page'
  physicalPage: number
}

export type ReadVisualRequest = ReadRequestBase & {
  mode: 'visual'
  maxPixels?: number
} & (
  | { physicalPage: number, figureId?: never }
  | { figureId: OpaqueId, physicalPage?: never }
)

export type ReadRequest =
  | ReadLocateRequest
  | ReadBlocksRequest
  | ReadExpandRequest
  | ReadSequentialRequest
  | ReadPageRequest
  | ReadVisualRequest

export interface TextBlockItem {
  itemType: 'block'
  blockId: OpaqueId
  physicalPage: number
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'caption' | 'other'
  text: string
  locator: DocumentLocator
}

export interface VisualAssetItem {
  itemType: 'visual'
  physicalPage: number
  asset: {
    assetId: OpaqueId
    contentHash: Sha256
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
    byteLength: number
    width: number
    height: number
  }
  locator: DocumentLocator
}

export type ReadItem = TextBlockItem | VisualAssetItem

export interface ReadResult {
  schemaVersion: 1
  resultType: 'read'
  mode: ProgressiveReadMode
  source: SourceIdentity
  textQuality: 'empty' | 'sparse' | 'garbled' | 'usable' | 'not-applicable'
  items: ReadItem[]
  pageInfo: PageInfo
}

export interface ResolveRequest {
  schemaVersion: 1
  requestType: 'resolve'
  locator: DocumentLocator
  allowCandidates: boolean
  maxCandidates: number
}

export interface ResolveResult extends SourceIdentity {
  schemaVersion: 1
  resultType: 'resolve'
  resolutionId: OpaqueId
  locatorId: OpaqueId
  status: 'resolved' | 'page-only' | 'ambiguous' | 'stale' | 'missing' | 'denied'
  checkedRepresentationHash?: Sha256
  checkedAt: string
  exactText?: string
  reason?: string
  resolvedLocator?: DocumentLocator
  candidates: DocumentLocator[]
}

export type SidecarDocumentRpcValue =
  | IngestRequest
  | IngestResult
  | SearchRequest
  | SearchResult
  | ReadRequest
  | ReadResult
  | ResolveRequest
  | ResolveResult

export type DocumentRpcIssueCode =
  | 'source-binding-absolute-or-unsafe-path'
  | 'ingest-binding-hash-mismatch'
  | 'ingest-binding-length-mismatch'
  | 'ingest-binding-media-type-mismatch'
  | 'ingest-result-identity-mismatch'
  | 'ingest-index-page-overflow'
  | 'search-candidate-page-order'
  | 'read-item-identity-mismatch'
  | 'read-item-page-mismatch'
  | 'resolve-result-identity-mismatch'
  | 'resolve-resolved-target-missing'
  | 'resolve-nonresolved-target-present'

export interface DocumentRpcIssue {
  code: DocumentRpcIssueCode
  path: string
  message: string
}

function rpcIssue(code: DocumentRpcIssueCode, path: string, message: string): DocumentRpcIssue {
  return { code, path, message }
}

export function sourceBindingIssues(binding: SourceBinding): DocumentRpcIssue[] {
  const unsafe = binding.relativePath.startsWith('/')
    || /^[A-Za-z]:/.test(binding.relativePath)
    || binding.relativePath.includes('\\')
    || binding.relativePath.split('/').some(part => part === '..' || part === '.' || part === '')
  return unsafe
    ? [rpcIssue(
        'source-binding-absolute-or-unsafe-path',
        '/relativePath',
        'source binding paths must be normalized relative paths without empty or parent segments',
      )]
    : []
}

export function ingestRequestIssues(value: IngestRequest): DocumentRpcIssue[] {
  const issues = sourceBindingIssues(value.sourceBinding)
  if (value.sourceBinding.expectedContentHash !== value.revision.contentHash) {
    issues.push(rpcIssue(
      'ingest-binding-hash-mismatch',
      '/sourceBinding/expectedContentHash',
      'source binding hash must match the immutable revision hash',
    ))
  }
  if (value.sourceBinding.byteLength !== value.revision.byteLength) {
    issues.push(rpcIssue(
      'ingest-binding-length-mismatch',
      '/sourceBinding/byteLength',
      'source binding length must match the immutable revision length',
    ))
  }
  if (value.sourceBinding.mediaType !== value.revision.mediaType) {
    issues.push(rpcIssue(
      'ingest-binding-media-type-mismatch',
      '/sourceBinding/mediaType',
      'source binding media type must match the immutable revision media type',
    ))
  }
  return issues
}

export function ingestResultIssues(value: IngestResult): DocumentRpcIssue[] {
  const issues: DocumentRpcIssue[] = []
  value.representations.forEach((representation, index) => {
    if (representation.documentId !== value.documentId || representation.revisionId !== value.revisionId) {
      issues.push(rpcIssue(
        'ingest-result-identity-mismatch',
        `/representations/${index}`,
        'every representation must belong to the ingest result document revision',
      ))
    }
  })
  if (value.index.indexedPages > value.index.totalPages) {
    issues.push(rpcIssue(
      'ingest-index-page-overflow',
      '/index/indexedPages',
      'indexed pages must not exceed total pages',
    ))
  }
  return issues
}

export function searchResultIssues(value: SearchResult): DocumentRpcIssue[] {
  return value.candidates.flatMap((candidate, index) =>
    candidate.physicalPageStart <= candidate.physicalPageEnd
      ? []
      : [rpcIssue(
          'search-candidate-page-order',
          `/candidates/${index}`,
          'candidate page start must not exceed page end',
        )])
}

export function readResultIssues(value: ReadResult): DocumentRpcIssue[] {
  const issues: DocumentRpcIssue[] = []
  value.items.forEach((item, index) => {
    const locator = item.locator
    if (locator.documentId !== value.source.documentId
      || locator.revisionId !== value.source.revisionId
      || locator.representationId !== value.source.representationId) {
      issues.push(rpcIssue(
        'read-item-identity-mismatch',
        `/items/${index}/locator`,
        'read item locator must belong to the requested source identity',
      ))
    }
    if (locator.physicalPage !== item.physicalPage) {
      issues.push(rpcIssue(
        'read-item-page-mismatch',
        `/items/${index}/physicalPage`,
        'read item page must match its locator page',
      ))
    }
  })
  return issues
}

export function resolveResultIssues(value: ResolveResult, request: ResolveRequest): DocumentRpcIssue[] {
  const issues: DocumentRpcIssue[] = []
  const locator = request.locator
  if (value.locatorId !== locator.locatorId
    || value.documentId !== locator.documentId
    || value.revisionId !== locator.revisionId
    || value.representationId !== locator.representationId) {
    issues.push(rpcIssue(
      'resolve-result-identity-mismatch',
      '/',
      'resolve result identity must match the requested locator',
    ))
  }
  if (value.status === 'resolved' && value.resolvedLocator === undefined) {
    issues.push(rpcIssue(
      'resolve-resolved-target-missing',
      '/resolvedLocator',
      'resolved results require an exact resolved locator',
    ))
  }
  if (value.status !== 'resolved' && value.resolvedLocator !== undefined) {
    issues.push(rpcIssue(
      'resolve-nonresolved-target-present',
      '/resolvedLocator',
      'non-resolved results cannot expose an exact resolved locator',
    ))
  }
  return issues
}
