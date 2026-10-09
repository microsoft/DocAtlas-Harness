import { documentLocatorIssues } from './m0-contracts.js'
import { libraryDocumentIssues } from './library-contracts.js'
import type { ResolveResult } from './document-rpc.js'
import type { LibraryDocument } from './library-contracts.js'
import type {
  ContractIssue,
  ContractIssueCode,
  DocumentLocator,
  OpaqueId,
} from './m0-contracts.js'

export interface ReaderFocusResolveRequest {
  schemaVersion: 1
  requestType: 'reader-focus-resolve'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  focusId: OpaqueId
  locator: DocumentLocator
}

export interface ReaderFocusResolveResult {
  schemaVersion: 1
  resultType: 'reader-focus-resolution'
  workspaceId: OpaqueId
  focusId: OpaqueId
  access: 'source-scope' | 'library' | 'both'
  resolution: ResolveResult
  document?: LibraryDocument
}

export type ReaderFocusRpcValue = ReaderFocusResolveRequest | ReaderFocusResolveResult

export function readerFocusRpcIssues(value: ReaderFocusRpcValue): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value) {
    for (const issue of documentLocatorIssues(value.locator)) {
      add(issue.code, `/locator${suffix(issue.path)}`, issue.message)
    }
    if (value.focusId !== value.locator.locatorId) {
      add('reader-focus-identity', '/focusId', 'reader focus id must equal its immutable locator id')
    }
    return issues
  }

  if (value.focusId !== value.resolution.locatorId) {
    add('reader-focus-result-identity', '/focusId', 'reader focus result must resolve the requested focus id')
  }
  if (value.resolution.candidates.length > 5) {
    add('reader-focus-candidate-limit', '/resolution/candidates', 'reader focus exposes at most five candidates')
  }
  const target = value.resolution.resolvedLocator
  if ((value.resolution.status === 'resolved') !== (target !== undefined)) {
    add('reader-focus-result-identity', '/resolution/status', 'resolved status and exact target must agree')
  }
  for (const [index, locator] of [
    ...(target === undefined ? [] : [target]),
    ...value.resolution.candidates,
  ].entries()) {
    for (const issue of documentLocatorIssues(locator)) {
      add(issue.code, `/resolution/locators/${index}${suffix(issue.path)}`, issue.message)
    }
    if (locator.documentId !== value.resolution.documentId
      || locator.revisionId !== value.resolution.revisionId
      || locator.representationId !== value.resolution.representationId) {
      add('reader-focus-result-identity', `/resolution/locators/${index}`, 'resolved targets must remain inside the requested source identity')
    }
  }
  if (value.document !== undefined) {
    for (const issue of libraryDocumentIssues(value.document)) {
      add(issue.code, `/document${suffix(issue.path)}`, issue.message)
    }
    if (value.document.workspaceId !== value.workspaceId
      || value.document.documentId !== value.resolution.documentId) {
      add('reader-focus-document-identity', '/document', 'reader focus document must match its workspace and resolution')
    }
  }
  if ((value.access === 'library' || value.access === 'both') && value.document === undefined) {
    add('reader-focus-document-identity', '/document', 'Library reader access requires document metadata')
  }
  return issues
}

function suffix(path: string): string {
  return path === '/' ? '' : path
}
