import { documentRevisionIssues, type DocumentRevision } from './m0-contracts.js'
import type { ScopedSourceIdentity } from './source-scope-rpc.js'
import { libraryRpcIssues, type LibraryJobResult } from './library-contracts.js'
import type { CitationFocus } from './product-answer-contracts.js'

export interface ProductRevisionImport {
  schemaVersion: 1
  kind: 'revision-import'
  expectedGeneration: number
  idempotencyKey: string
  uploadId: string
  targetDocumentId: string
  expectedCurrentRevisionId: string
}
export interface ProductRevisionImportState {
  schemaVersion: 1
  kind: 'revision-import-state'
  conversationId: string
  bindingId: string
  generation: number
  request: ProductRevisionImport
  requestHash: string
  /** null is an authenticated lookup with no accepted job, never a successful import. */
  job: LibraryJobResult | null
}
export interface ProductRevisionHistory {
  schemaVersion: 1
  kind: 'revision-history'
  conversationId: string
  bindingId: string
  generation: number
  documentId: string
  currentRevisionId: string
  /** Most recent first in verified revision-chain order, never an ID/timestamp sort. */
  versions: Array<{ revision: DocumentRevision, source: ScopedSourceIdentity | null, original: CitationFocus['original'] | null }>
  nextCursor: string | null
  truncated: boolean
}
export type ProductLibraryValue = ProductRevisionImport | ProductRevisionImportState | ProductRevisionHistory

/** The host still supplies ownership, policy, immutable bytes, current CAS and durable receipt authority. */
export function productLibraryIssues(value: ProductLibraryValue): string[] {
  const issues: string[] = []
  if (value.kind === 'revision-history') {
    if (new Set(value.versions.map(item => item.revision.revisionId)).size !== value.versions.length) issues.push('revision-duplicate')
    for (const item of value.versions) {
      const revision = item.revision
      if (documentRevisionIssues(revision).length || revision.documentId !== value.documentId) issues.push('revision-identity')
      if (item.source && (item.source.documentId !== revision.documentId || item.source.revisionId !== revision.revisionId)) issues.push('revision-source')
      if (item.original && (item.original.documentId !== revision.documentId || item.original.revisionId !== revision.revisionId
        || item.original.contentHash !== revision.contentHash || item.original.byteLength !== revision.byteLength
        || revision.mediaType !== 'application/pdf' || revision.pageCount !== item.original.pageCount)) issues.push('revision-original')
      if (revision.revisionId === value.currentRevisionId && revision.status !== 'active') issues.push('revision-current')
    }
    if (value.nextCursor !== null && !value.truncated) issues.push('revision-page')
  } else if (value.kind === 'revision-import-state' && value.job) {
    if (libraryRpcIssues(value.job).length) issues.push('revision-job')
    if (value.job.status === 'succeeded') {
      const document = value.job.document
      if (!document || document.documentId !== value.request.targetDocumentId
        || document.currentRevision.revisionId !== value.request.expectedCurrentRevisionId && document.currentRevision.previousRevisionId !== value.request.expectedCurrentRevisionId) issues.push('revision-result')
    }
  }
  return issues
}
