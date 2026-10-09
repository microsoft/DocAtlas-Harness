import type { DocumentLocator } from './m0-contracts.js'
import { pageInfoIssues } from './m0-contracts.js'
import type { ContractIssue, ContractIssueCode, OpaqueId, PageInfo, Sha256 } from './m0-contracts.js'
import type {
  ResearchRecordStatus,
  ResearchRecordType,
  ResearchSourceIdentity,
} from './research-recall-contracts.js'

export interface TreeOverlayRequest {
  schemaVersion: 1
  requestType: 'tree-overlay-get'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  source: ResearchSourceIdentity
  physicalPage?: number
  recordTypes: ResearchRecordType[]
  limits: { maxItems: number, maxChars: number }
  cursor?: OpaqueId
}

export interface TreeOverlayItem {
  overlayId: OpaqueId
  recordId: OpaqueId
  recordType: ResearchRecordType
  recordStatus: ResearchRecordStatus
  sourceInvestigationId: OpaqueId
  sourceSessionId: OpaqueId
  layer: 'working' | 'research'
  locator: DocumentLocator
  preview: string
  relation: 'research-record-anchor'
  verificationStatus: 'anchor-only'
  createdAt: string
}

export interface TreeOverlayResult {
  schemaVersion: 1
  resultType: 'tree-overlay'
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  source: ResearchSourceIdentity
  physicalPage?: number
  queryHash: Sha256
  items: TreeOverlayItem[]
  pageInfo: PageInfo
}

export type TreeOverlayRpcValue = TreeOverlayRequest | TreeOverlayResult

export function treeOverlayRpcIssues(
  value: TreeOverlayRpcValue,
  request?: TreeOverlayRequest,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value) return issues
  for (const issue of pageInfoIssues(value.pageInfo)) {
    add(issue.code, `/pageInfo${issue.path === '/' ? '' : issue.path}`, issue.message)
  }
  if (value.pageInfo.returned !== value.items.length) {
    add('tree-overlay-count', '/pageInfo/returned', 'overlay count must match returned items')
  }
  const sourceKey = exactSourceKey(value.source)
  const overlayIds = new Set<string>()
  let usedChars = 0
  for (const [index, item] of value.items.entries()) {
    if (overlayIds.has(item.overlayId)) {
      add('tree-overlay-duplicate', `/items/${index}/overlayId`, 'overlay ids must be unique')
    }
    overlayIds.add(item.overlayId)
    usedChars += [...item.preview].length
    if (exactLocatorSourceKey(item.locator) !== sourceKey
      || (value.physicalPage !== undefined && item.locator.physicalPage !== value.physicalPage)) {
      add('tree-overlay-anchor', `/items/${index}/locator`, 'overlay locator escaped the exact requested source/page')
    }
    if (item.recordStatus === 'deleted') {
      add('tree-overlay-status', `/items/${index}/recordStatus`, 'deleted records cannot remain in the active overlay')
    }
    const expectedLayer = item.sourceInvestigationId === value.investigationId
      ? 'working'
      : 'research'
    if (item.layer !== expectedLayer) {
      add('tree-overlay-layer', `/items/${index}/layer`, 'overlay layer must reflect current versus prior Investigation')
    }
  }
  if (value.pageInfo.usedChars !== usedChars) {
    add('tree-overlay-count', '/pageInfo/usedChars', 'overlay character usage must match previews')
  }
  if (request !== undefined) {
    if (value.workspaceId !== request.workspaceId
      || value.investigationId !== request.investigationId
      || value.scopeVersionId !== request.scopeVersionId
      || exactSourceKey(value.source) !== exactSourceKey(request.source)
      || value.physicalPage !== request.physicalPage) {
      add('tree-overlay-identity', '/', 'overlay result must match the exact request identity')
    }
    if (value.items.some(item => !request.recordTypes.includes(item.recordType))) {
      add('tree-overlay-filter', '/items', 'overlay item escaped the requested type filter')
    }
    if (usedChars > request.limits.maxChars) {
      add('tree-overlay-count', '/pageInfo/usedChars', 'overlay exceeds the requested character budget')
    }
  }
  return issues
}

function exactSourceKey(source: ResearchSourceIdentity): string {
  return [
    source.documentId,
    source.revisionId,
    source.representationId,
    source.representationContentHash,
  ].join('\0')
}

function exactLocatorSourceKey(locator: DocumentLocator): string {
  return [
    locator.documentId,
    locator.revisionId,
    locator.representationId,
    locator.representationContentHash,
  ].join('\0')
}
