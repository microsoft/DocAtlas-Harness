import type { ActorRef, ContractIssue, ContractIssueCode, OpaqueId } from './m0-contracts.js'

export interface ResearchLifecycleRequest {
  schemaVersion: 1
  requestType: 'research-record-lifecycle'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  recordId: OpaqueId
  expectedVersion: number
  idempotencyKey: OpaqueId
  action: 'edit' | 'resolve' | 'archive' | 'delete'
  text?: string
}

export interface ResearchRecordState {
  schemaVersion: 1
  recordId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  recordType: 'research-note' | 'open-question'
  version: number
  previousVersion: number
  status: 'active' | 'open' | 'resolved' | 'archived' | 'deleted'
  epistemicStatus: 'unverified'
  text?: string
  updatedBy: ActorRef
  updatedAt: string
}

export interface ResearchLifecycleResult {
  schemaVersion: 1
  resultType: 'research-record-lifecycle'
  status: 'updated' | 'replayed'
  state: ResearchRecordState
}

export type ResearchLifecycleRpcValue = ResearchLifecycleRequest | ResearchLifecycleResult

export function researchLifecycleRpcIssues(
  value: ResearchLifecycleRpcValue,
  request?: ResearchLifecycleRequest,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value) return issues
  const state = value.state
  if (state.updatedBy.kind !== 'user') {
    add('research-lifecycle-actor', '/state/updatedBy/kind', 'record lifecycle changes require a user actor')
  }
  if (state.version !== state.previousVersion + 1) {
    add('research-lifecycle-version', '/state/version', 'record lifecycle version must advance exactly once')
  }
  if ((state.status === 'deleted') !== (state.text === undefined)) {
    add('research-lifecycle-content', '/state/text', 'only a deleted tombstone omits current record text')
  }
  if (request !== undefined && (state.recordId !== request.recordId
    || state.workspaceId !== request.workspaceId
    || state.investigationId !== request.investigationId
    || state.previousVersion !== request.expectedVersion)) {
    add('research-lifecycle-identity', '/state', 'record lifecycle result must match the exact request identity')
  }
  return issues
}
