import type { ActorRef, ContractIssue, ContractIssueCode, OpaqueId } from './m0-contracts.js'

interface ResearchGovernanceRequestBase {
  schemaVersion: 1
  requestType: 'research-governance'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  idempotencyKey: OpaqueId
}

export type ResearchGovernanceDraft =
  | {
    recordType: 'project-decision'
    title: string
    decision: string
    rationale?: string
  }
  | {
    recordType: 'research-policy'
    title: string
    directive: string
    policyScope: 'investigation' | 'workspace'
    rationale?: string
  }

export type ResearchGovernanceRequest = ResearchGovernanceRequestBase & (
  | { action: 'create', entry: ResearchGovernanceDraft }
  | {
    action: 'revise'
    recordId: OpaqueId
    expectedVersion: number
    entry: ResearchGovernanceDraft
  }
  | {
    action: 'archive' | 'delete'
    recordId: OpaqueId
    expectedVersion: number
  }
)

interface ResearchGovernanceRecordBase {
  schemaVersion: 1
  recordId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  sourceSessionId: OpaqueId
  sourceScopeVersionId: OpaqueId
  recordType: 'project-decision' | 'research-policy'
  version: number
  status: 'active' | 'archived' | 'deleted'
  createdBy: ActorRef
  updatedBy: ActorRef
  createdAt: string
  updatedAt: string
}

export type ResearchGovernanceRecord =
  | ResearchGovernanceRecordBase & {
    recordType: 'project-decision'
    status: 'active' | 'archived'
    title: string
    decision: string
    rationale?: string
  }
  | ResearchGovernanceRecordBase & {
    recordType: 'research-policy'
    status: 'active' | 'archived'
    title: string
    directive: string
    policyScope: 'investigation' | 'workspace'
    rationale?: string
  }
  | ResearchGovernanceRecordBase & {
    status: 'deleted'
  }

export interface ResearchGovernanceResult {
  schemaVersion: 1
  resultType: 'research-governance'
  status: 'created' | 'updated' | 'replayed'
  record: ResearchGovernanceRecord
}

export type ResearchGovernanceRpcValue = ResearchGovernanceRequest | ResearchGovernanceResult

export function researchGovernanceRpcIssues(
  value: ResearchGovernanceRpcValue,
  request?: ResearchGovernanceRequest,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value) return issues
  const record = value.record
  if (record.createdBy.kind !== 'user' || record.updatedBy.kind !== 'user') {
    add(
      'research-governance-actor',
      '/record',
      'Project Decisions and Research Policies require user authority',
    )
  }
  if (record.status === 'deleted') {
    const keys = Object.keys(record)
    if (keys.some(key => ['title', 'decision', 'directive', 'policyScope', 'rationale'].includes(key))) {
      add(
        'research-governance-content',
        '/record',
        'a governance tombstone cannot retain current content',
      )
    }
  }
  if (request === undefined) return issues
  if (record.workspaceId !== request.workspaceId
    || record.investigationId !== request.investigationId
    || record.sourceSessionId !== request.sessionId
    || record.sourceScopeVersionId !== request.scopeVersionId) {
    add(
      'research-governance-identity',
      '/record',
      'governance result must match the exact authenticated request scope',
    )
  }
  if (request.action === 'create') {
    if (record.version !== 1 || record.status !== 'active'
      || value.status === 'updated' || !governanceEntryMatches(record, request.entry)) {
      add(
        'research-governance-version',
        '/record/version',
        'create must produce active version 1 with matching typed content',
      )
    }
  } else {
    if (record.recordId !== request.recordId || record.version !== request.expectedVersion + 1) {
      add(
        'research-governance-version',
        '/record/version',
        'governance mutation must advance the requested record exactly once',
      )
    }
    const contentMatches = request.action === 'revise'
      ? record.status === 'active' && governanceEntryMatches(record, request.entry)
      : request.action === 'archive'
        ? record.status === 'archived'
        : record.status === 'deleted'
    if (!contentMatches) {
      add(
        'research-governance-action',
        '/record/status',
        'governance result does not match the requested lifecycle action',
      )
    }
    if (value.status === 'created') {
      add(
        'research-governance-action',
        '/status',
        'a non-create governance mutation cannot report created',
      )
    }
  }
  return issues
}

function governanceEntryMatches(
  record: ResearchGovernanceRecord,
  entry: ResearchGovernanceDraft,
): boolean {
  if (record.status === 'deleted' || record.recordType !== entry.recordType) return false
  if (record.title !== entry.title || record.rationale !== entry.rationale) return false
  return entry.recordType === 'project-decision'
    ? record.recordType === 'project-decision' && record.decision === entry.decision
    : record.recordType === 'research-policy'
      && record.directive === entry.directive
      && record.policyScope === entry.policyScope
}
