import { answerManifestIssues, type AnswerManifest } from './answer-contracts.js'
import { documentLocatorIssues, type DocumentLocator } from './m0-contracts.js'
import type { NativeHistoryOrigin } from './native-lineage-contracts.js'

export interface AnswerResponse {
  schemaVersion: 1
  kind: 'answer-response'
  conversationId: string
  messageId: string
  status: 'available' | 'unavailable'
  nativeTextHash: string | null
  manifest: AnswerManifest | null
  /** Immutable original publication, authorized through the current selected native lineage. */
  origin?: NativeHistoryOrigin
}

export interface CitationFocus {
  schemaVersion: 1
  kind: 'citation-focus'
  conversationId: string
  messageId: string
  citationId: string
  status: 'resolved' | 'page-only' | 'ambiguous'
  locator: DocumentLocator
  physicalPage: number
  exactText: string | null
  original: {
    documentId: string
    revisionId: string
    name: string
    contentHash: string
    byteLength: number
    pageCount: number
  }
}

export type ProductAnswerValue = AnswerResponse | CitationFocus

/** After wire shape validation. Mapping/reading a citation is not semantic review. */
export function productAnswerIssues(value: ProductAnswerValue): string[] {
  const issues: string[] = []
  if (value.kind === 'answer-response') {
    if (value.status === 'available' ? value.manifest === null || value.nativeTextHash === null : value.manifest !== null || value.nativeTextHash !== null) issues.push('answer-state')
    if (value.manifest !== null) {
      issues.push(...answerManifestIssues(value.manifest).map(issue => issue.code))
      if (value.manifest.sessionId !== (value.origin?.conversationId ?? value.conversationId) || value.manifest.messageId !== value.messageId
        || value.origin && value.origin.entryId !== value.messageId) issues.push('answer-identity')
    }
    if (value.status !== 'available' && value.origin !== undefined) issues.push('answer-origin')
  } else {
    issues.push(...documentLocatorIssues(value.locator).map(issue => issue.code))
    if (value.original.documentId !== value.locator.documentId || value.original.revisionId !== value.locator.revisionId) issues.push('citation-source')
    if (value.physicalPage !== value.locator.physicalPage || value.physicalPage > value.original.pageCount) issues.push('citation-page')
    if (value.status === 'resolved' ? value.exactText === null || !value.exactText.trim() : value.exactText !== null) issues.push('citation-text')
  }
  return issues
}
