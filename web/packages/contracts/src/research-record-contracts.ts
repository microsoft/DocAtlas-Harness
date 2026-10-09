import type { ActorRef, ContractIssue, ContractIssueCode, OpaqueId } from './m0-contracts.js'

interface ResearchRecordRequestBase {
  schemaVersion: 1
  requestType: 'research-record'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  callId: OpaqueId
  idempotencyKey: OpaqueId
}

export type ResearchRecordRequest = ResearchRecordRequestBase & (
  | { kind: 'checkpoint', body: string }
  | { kind: 'open-question', question: string }
)

interface ResearchRecordBase {
  schemaVersion: 1
  recordId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  sourceSessionId: OpaqueId
  sourceScopeVersionId: OpaqueId
  provenanceCallId: OpaqueId
  version: 1
  createdBy: ActorRef
  createdAt: string
  epistemicStatus: 'unverified'
}

export type AgentResearchRecord = ResearchRecordBase & (
  | {
    recordType: 'research-note'
    noteKind: 'checkpoint'
    body: string
    status: 'active'
  }
  | {
    recordType: 'open-question'
    question: string
    status: 'open'
  }
)

export interface ResearchRecordResult {
  schemaVersion: 1
  resultType: 'research-recorded'
  status: 'created' | 'replayed'
  record: AgentResearchRecord
}

export type ResearchRecordRpcValue = ResearchRecordRequest | ResearchRecordResult

export function researchRecordRpcIssues(
  value: ResearchRecordRpcValue,
  request?: ResearchRecordRequest,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value) return issues
  if (value.record.createdBy.kind !== 'agent') {
    add('research-record-actor', '/record/createdBy/kind', 'Agent record RPC can only create Agent-authored records')
  }
  if (request !== undefined && (value.record.workspaceId !== request.workspaceId
    || value.record.investigationId !== request.investigationId
    || value.record.sourceSessionId !== request.sessionId
    || value.record.sourceScopeVersionId !== request.scopeVersionId
    || value.record.provenanceCallId !== request.callId)) {
    add('research-record-identity', '/record', 'record must match the exact request scope identity')
  }
  const contentMatches = request === undefined
    ? true
    : request.kind === 'checkpoint'
      ? value.record.recordType === 'research-note' && value.record.body === request.body
      : value.record.recordType === 'open-question' && value.record.question === request.question
  if (!contentMatches) {
    add('research-record-kind', '/record/recordType', 'record kind and content must match the request')
  }
  return issues
}
