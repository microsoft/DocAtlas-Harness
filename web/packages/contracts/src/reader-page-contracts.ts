import { documentLocatorIssues, pageInfoIssues } from './m0-contracts.js'
import type { PageInfo, ContractIssue, ContractIssueCode, OpaqueId, Sha256 } from './m0-contracts.js'
import type { TextBlockItem, VisualAssetItem } from './document-rpc.js'

export interface ReaderPageRequest {
  schemaVersion: 1
  requestType: 'reader-page-get'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  documentId: OpaqueId
  revisionId: OpaqueId
  physicalPage: number
  maxPixels: number
  cursor?: OpaqueId
}

export interface ReaderPageResult {
  schemaVersion: 1
  resultType: 'reader-page'
  workspaceId: OpaqueId
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  representationContentHash: Sha256
  physicalPage: number
  totalPages: number
  textQuality: 'empty' | 'sparse' | 'garbled' | 'usable' | 'not-applicable'
  blocks: TextBlockItem[]
  visual: VisualAssetItem
  pageInfo: PageInfo
}

export type ReaderPageRpcValue = ReaderPageRequest | ReaderPageResult

/** Cross-field checks for the exact current-revision Reader page boundary. */
export function readerPageRpcIssues(
  value: ReaderPageRpcValue,
  request?: ReaderPageRequest,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value) return issues

  if (value.physicalPage > value.totalPages) {
    add('reader-page-identity', '/physicalPage', 'reader page must be inside the current revision')
  }
  if (request !== undefined && (value.workspaceId !== request.workspaceId
    || value.documentId !== request.documentId
    || value.revisionId !== request.revisionId
    || value.physicalPage !== request.physicalPage)) {
    add('reader-page-identity', '/', 'reader page result must match the exact request identity')
  }
  for (const issue of pageInfoIssues(value.pageInfo)) {
    add(issue.code, `/pageInfo${issue.path === '/' ? '' : issue.path}`, issue.message)
  }
  if (value.pageInfo.returned !== value.blocks.length) {
    add('reader-page-count', '/pageInfo/returned', 'reader page count must match returned blocks')
  }
  const items = [...value.blocks, value.visual]
  for (const [index, item] of items.entries()) {
    const path = index < value.blocks.length ? `/blocks/${index}` : '/visual'
    const locator = item.locator
    for (const issue of documentLocatorIssues(locator)) {
      add(issue.code, `${path}/locator${issue.path === '/' ? '' : issue.path}`, issue.message)
    }
    if (locator.documentId !== value.documentId
      || locator.revisionId !== value.revisionId
      || locator.representationId !== value.representationId
      || locator.representationContentHash !== value.representationContentHash
      || locator.physicalPage !== value.physicalPage
      || item.physicalPage !== value.physicalPage) {
      add('reader-page-item-identity', path, 'reader page items must remain inside the exact page identity')
    }
  }
  if (request !== undefined
    && value.visual.asset.width * value.visual.asset.height > request.maxPixels) {
    add('reader-page-pixel-limit', '/visual/asset', 'reader page visual exceeds the requested pixel limit')
  }
  return issues
}
