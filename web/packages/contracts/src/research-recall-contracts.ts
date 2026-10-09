import { pageInfoIssues } from './m0-contracts.js'
import type {
  ContractIssue,
  ContractIssueCode,
  OpaqueId,
  PageInfo,
  Sha256,
} from './m0-contracts.js'

export type ResearchRecordType =
  | 'evidence-bookmark'
  | 'research-note'
  | 'open-question'
  | 'claim-proposal'
  | 'project-decision'
  | 'research-policy'

export type ResearchRecordStatus =
  | 'active'
  | 'open'
  | 'proposed'
  | 'resolved'
  | 'superseded'
  | 'archived'
  | 'deleted'

export interface ResearchSourceIdentity {
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  representationContentHash: Sha256
}

export interface ResearchRecallRequest {
  schemaVersion: 1
  requestType: 'research-recall'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  query: string
  recordTypes: ResearchRecordType[]
  limits: { maxItems: number, maxChars: number }
  cursor?: OpaqueId
}

export interface ResearchRecallLead {
  leadId: OpaqueId
  recordId: OpaqueId
  recordType: ResearchRecordType
  recordStatus: ResearchRecordStatus
  sourceInvestigationId: OpaqueId
  sourceSessionId: OpaqueId
  sourceScopeVersionId?: OpaqueId
  provenanceCallId?: OpaqueId
  preview: string
  sourceIdentities: ResearchSourceIdentity[]
  sourceState: 'none' | 'current-scope' | 'outside-current-scope' | 'mixed'
  verificationStatus: 'unverified-lead'
  reason: string
  createdAt: string
}

export interface ResearchRecallResult {
  schemaVersion: 1
  resultType: 'research-recall'
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  queryHash: Sha256
  leads: ResearchRecallLead[]
  pageInfo: PageInfo
}

export type ResearchRecallRpcValue = ResearchRecallRequest | ResearchRecallResult

export function researchRecallRpcIssues(
  value: ResearchRecallRpcValue,
  request?: ResearchRecallRequest,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value) return issues
  for (const issue of pageInfoIssues(value.pageInfo)) {
    add(issue.code, `/pageInfo${issue.path === '/' ? '' : issue.path}`, issue.message)
  }
  if (value.pageInfo.returned !== value.leads.length) {
    add('research-recall-count', '/pageInfo/returned', 'recall count must match returned leads')
  }
  if (request !== undefined && (value.workspaceId !== request.workspaceId
    || value.investigationId !== request.investigationId
    || value.scopeVersionId !== request.scopeVersionId)) {
    add('research-recall-identity', '/', 'recall result must match the current request identity')
  }
  const leadIds = new Set<string>()
  const recordIds = new Set<string>()
  let usedChars = 0
  for (const [index, lead] of value.leads.entries()) {
    if (leadIds.has(lead.leadId) || recordIds.has(lead.recordId)) {
      add('research-recall-duplicate', `/leads/${index}`, 'recall leads and records must be unique')
    }
    leadIds.add(lead.leadId)
    recordIds.add(lead.recordId)
    usedChars += [...lead.preview].length
    if ((lead.sourceState === 'none') !== (lead.sourceIdentities.length === 0)) {
      add('research-recall-source-state', `/leads/${index}/sourceState`, 'source state must match source identities')
    }
    if (request !== undefined && !request.recordTypes.includes(lead.recordType)) {
      add('research-recall-filter', `/leads/${index}/recordType`, 'recall lead escaped the requested type filter')
    }
  }
  if (value.pageInfo.usedChars !== usedChars) {
    add('research-recall-count', '/pageInfo/usedChars', 'recall character usage must match lead previews')
  }
  if (request !== undefined && usedChars > request.limits.maxChars) {
    add('research-recall-count', '/pageInfo/usedChars', 'recall result exceeds the requested character budget')
  }
  return issues
}
