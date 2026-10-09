import { createHash } from 'node:crypto'
import { researchRecallRpcIssues, researchRecordRpcIssues, type ResearchRecallRequest, type ResearchRecallResult, type ResearchRecordRequest, type ResearchRecordResult, type ResearchSourceIdentity } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { DocumentAccessError } from '../document/session.js'

/** Installed by the host only at exact native consumption; an empty research source frame is valid. */
export interface ResearchInvocation {
  readonly conversationId: string
  readonly runtimeSessionId: string
  readonly submissionId: string
  readonly workspaceId: string
  readonly investigationId: string
  readonly scopeVersionId: string
  readonly currentSources: readonly ResearchSourceIdentity[]
  assertCurrent(): void
  authorizeRecord(): void
  /** Must authorize the query's searchable universe BEFORE the port performs retrieval. */
  authorizeRecall(): void
}
/** Private host ledger data, not a replacement for a Research record or an Evidence atom. */
export interface ResearchRecordLineage {
  workspaceId: string
  conversationId: string
  runtimeSessionId: string
  submissionId: string
  investigationId: string
  scopeVersionId: string
  nativeToolCallId: string
  wireCallId: string
  idempotencyKey: string
}
export interface ResearchOperationsPort {
  /** Host persists reversible provenance mapping before domain commit and links the result last. */
  recordResearch(request: ResearchRecordRequest, lineage: Readonly<ResearchRecordLineage>, check: () => void): ResearchRecordResult | Promise<ResearchRecordResult>
  /** The host callback applies source/record visibility before querying, never by post-filtering leads. */
  recallResearch(request: ResearchRecallRequest, currentSources: readonly ResearchSourceIdentity[], check: () => void): ResearchRecallResult | Promise<ResearchRecallResult>
}

export class ResearchOperations {
  constructor(private readonly port: ResearchOperationsPort, private readonly invocation: () => ResearchInvocation) {}

  async record(nativeToolCallId: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<ResearchRecordResult> {
    const active = this.invocation(), check = () => { signal?.throwIfAborted(); active.assertCurrent(); active.authorizeRecord() }
    check(); assertInvocation(active)
    if (typeof nativeToolCallId !== 'string' || !nativeToolCallId.trim() || nativeToolCallId.length > 256 || hasControl(nativeToolCallId)) throw invalidRequest()
    assertFields(fields, ['kind', 'body', 'question'])
    const content = fields.kind === 'checkpoint' && typeof fields.body === 'string' && fields.question === undefined ? { kind: 'checkpoint' as const, body: fields.body }
      : fields.kind === 'open-question' && typeof fields.question === 'string' && fields.body === undefined ? { kind: 'open-question' as const, question: fields.question } : undefined
    if (!content || !(content.kind === 'checkpoint' ? content.body : content.question).trim()) throw invalidRequest()
    const digest = createHash('sha256').update(JSON.stringify([active.workspaceId, active.conversationId, active.runtimeSessionId, active.submissionId, nativeToolCallId])).digest('hex')
    const lineage: ResearchRecordLineage = { workspaceId: active.workspaceId, conversationId: active.conversationId, runtimeSessionId: active.runtimeSessionId, submissionId: active.submissionId,
      investigationId: active.investigationId, scopeVersionId: active.scopeVersionId, nativeToolCallId, wireCallId: `call:research:${digest}`, idempotencyKey: `research:record:${digest}` }
    const request = parseRequest('research-record-rpc', { schemaVersion: 1, requestType: 'research-record', sessionId: active.conversationId, workspaceId: active.workspaceId,
      investigationId: active.investigationId, scopeVersionId: active.scopeVersionId, callId: lineage.wireCallId, idempotencyKey: lineage.idempotencyKey, ...content }) as ResearchRecordRequest
    check()
    const result = await this.port.recordResearch(request, Object.freeze(lineage), check)
    check(); parseContract('research-record-rpc', result)
    if (result.resultType !== 'research-recorded' || researchRecordRpcIssues(result, request).length || result.record.createdBy.actorId !== active.conversationId) throw invalidOutput()
    bounded(result); check(); return result
  }

  async recall(fields: Record<string, unknown>, signal?: AbortSignal): Promise<ResearchRecallResult> {
    const active = this.invocation(), check = () => { signal?.throwIfAborted(); active.assertCurrent(); active.authorizeRecall() }
    check(); assertInvocation(active); assertFields(fields, ['query', 'recordTypes', 'maxItems', 'maxChars', 'cursor'])
    if (typeof fields.query !== 'string' || !fields.query.trim()) throw invalidRequest()
    const request = parseRequest('research-recall-rpc', { schemaVersion: 1, requestType: 'research-recall', sessionId: active.conversationId, workspaceId: active.workspaceId,
      investigationId: active.investigationId, scopeVersionId: active.scopeVersionId, query: fields.query,
      recordTypes: structuredClone(fields.recordTypes ?? ['research-note', 'open-question', 'evidence-bookmark', 'claim-proposal']),
      limits: { maxItems: fields.maxItems ?? 8, maxChars: fields.maxChars ?? 4000 }, ...(fields.cursor === undefined ? {} : { cursor: fields.cursor }) }) as ResearchRecallRequest
    const sources = structuredClone(active.currentSources)
    check()
    const result = await this.port.recallResearch(request, sources, check)
    check(); parseContract('research-recall-rpc', result)
    if (result.resultType !== 'research-recall' || researchRecallRpcIssues(result, request).length || result.leads.length > request.limits.maxItems || result.pageInfo.limit !== request.limits.maxItems) throw invalidOutput()
    // Do not promote old locators, bookmarks, generated notes or governance leads into current Evidence.
    bounded(result); check(); return result
  }
}

function parseRequest(contract: 'research-record-rpc' | 'research-recall-rpc', value: unknown) {
  try { return parseContract(contract, value) } catch { throw invalidRequest() }
}
function assertFields(fields: Record<string, unknown>, allowed: string[]): void {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => !allowed.includes(key))) throw invalidRequest()
}
function assertInvocation(active: ResearchInvocation): void {
  for (const id of [active.conversationId, active.runtimeSessionId, active.submissionId, active.workspaceId, active.investigationId, active.scopeVersionId]) {
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || hasControl(id)) throw new DocumentAccessError('unavailable', 'Research execution identity is incomplete')
  }
  if (!Array.isArray(active.currentSources)) throw new DocumentAccessError('unavailable', 'Research source frame is incomplete')
}
function hasControl(value: string): boolean { return [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) }
function bounded(value: unknown): void { const text = JSON.stringify(value); if (text.length > 30000 || Buffer.byteLength(text) > 65536) throw new DocumentAccessError('invalid-output', 'Research presentation exceeds budget; request fewer leads or smaller previews') }
function invalidRequest(): DocumentAccessError { return new DocumentAccessError('invalid-request', 'Research arguments do not match the supported operation') }
function invalidOutput(): DocumentAccessError { return new DocumentAccessError('invalid-output', 'Research result failed scope, record or budget validation') }
