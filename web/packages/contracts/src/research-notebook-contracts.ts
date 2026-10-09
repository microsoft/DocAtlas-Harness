import { pageInfoIssues } from './m0-contracts.js'
import type {
  ContractIssue,
  ContractIssueCode,
  OpaqueId,
  PageInfo,
  Sha256,
} from './m0-contracts.js'
import type {
  ResearchRecordStatus,
  ResearchRecordType,
  ResearchSourceIdentity,
} from './research-recall-contracts.js'

export type ResearchNotebookRecordStatus = Exclude<ResearchRecordStatus, 'deleted'>

export interface ResearchNotebookRequest {
  schemaVersion: 1
  requestType: 'research-notebook'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  view: 'working' | 'workspace'
  recordTypes: ResearchRecordType[]
  recordStatuses: ResearchNotebookRecordStatus[]
  limits: { maxItems: number, maxChars: number }
  cursor?: OpaqueId
}

export interface ResearchNotebookItem {
  itemId: OpaqueId
  recordId: OpaqueId
  recordType: ResearchRecordType
  recordStatus: ResearchNotebookRecordStatus
  recordVersion: number
  sourceInvestigationId: OpaqueId
  sourceSessionId: OpaqueId
  sourceScopeVersionId?: OpaqueId
  layer: 'working' | 'research'
  preview: string
  sourceIdentities: ResearchSourceIdentity[]
  sourceState: 'none' | 'current-scope' | 'outside-current-scope' | 'mixed'
  useStatus: 'unverified-lead' | 'user-governance'
  updatedAt: string
}

export interface ResearchNotebookResult {
  schemaVersion: 1
  resultType: 'research-notebook'
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  view: 'working' | 'workspace'
  queryHash: Sha256
  items: ResearchNotebookItem[]
  pageInfo: PageInfo
}

export type ResearchNotebookRpcValue = ResearchNotebookRequest | ResearchNotebookResult

export function researchNotebookRpcIssues(
  value: ResearchNotebookRpcValue,
  request?: ResearchNotebookRequest,
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
    add('research-notebook-count', '/pageInfo/returned', 'Notebook count must match returned items')
  }
  let usedChars = 0
  const ids = new Set<string>()
  for (const [index, item] of value.items.entries()) {
    usedChars += [...item.preview].length
    if (ids.has(item.itemId) || ids.has(item.recordId)) {
      add('research-notebook-duplicate', `/items/${index}`, 'Notebook items must be unique')
    }
    ids.add(item.itemId)
    ids.add(item.recordId)
    if ((item.sourceState === 'none') !== (item.sourceIdentities.length === 0)) {
      add(
        'research-notebook-source-state',
        `/items/${index}/sourceState`,
        'Notebook source state must match exact source identities',
      )
    }
    const expectedLayer = item.sourceInvestigationId === value.investigationId
      ? 'working'
      : 'research'
    if (item.layer !== expectedLayer) {
      add('research-notebook-layer', `/items/${index}/layer`, 'Notebook layer is inconsistent')
    }
    const expectedUse = item.recordType === 'project-decision'
      || item.recordType === 'research-policy'
      ? 'user-governance'
      : 'unverified-lead'
    if (item.useStatus !== expectedUse) {
      add('research-notebook-use', `/items/${index}/useStatus`, 'Notebook use status is inconsistent')
    }
  }
  if (value.pageInfo.usedChars !== usedChars) {
    add('research-notebook-count', '/pageInfo/usedChars', 'Notebook character usage is inconsistent')
  }
  if (request !== undefined) {
    if (value.workspaceId !== request.workspaceId
      || value.investigationId !== request.investigationId
      || value.scopeVersionId !== request.scopeVersionId
      || value.view !== request.view) {
      add('research-notebook-identity', '/', 'Notebook result must match the exact request identity')
    }
    if (value.items.some(item => !request.recordTypes.includes(item.recordType)
      || !request.recordStatuses.includes(item.recordStatus)
      || (request.view === 'working' && item.layer !== 'working'))) {
      add('research-notebook-filter', '/items', 'Notebook item escaped the requested filters')
    }
    if (usedChars > request.limits.maxChars) {
      add('research-notebook-count', '/pageInfo/usedChars', 'Notebook exceeds its character budget')
    }
  }
  return issues
}
