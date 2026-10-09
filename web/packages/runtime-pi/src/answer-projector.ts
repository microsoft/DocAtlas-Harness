import { compileSourceAnswerManifest, type AnswerReadReceipt } from '@docatlas/core'
import { pageInfoIssues, readResultIssues, type AnswerManifest, type DocumentLocator, type ProductPiCheckpoint, type ReadResult, type ScopedSourceIdentity, type SourceScopeVersion } from '@docatlas/contracts'
import { validateContractShape } from '@docatlas/contracts/node'
import { verifyWorkerCheckpoint } from './worker/checkpoint.js'

/** Captured and durably sealed by the host, never reconstructed from worker-owned details. */
export interface CheckpointReadAttestation extends AnswerReadReceipt { result: ReadResult }
export interface CheckpointAnswerInput {
  sessionId: string
  turn: number
  scope: SourceScopeVersion
  sources: readonly ScopedSourceIdentity[]
  reads: readonly CheckpointReadAttestation[]
}

/** Projects only a completed, unambiguous native branch and independently attested successful Reads.
 * Invalid checkpoint bytes throw; an unsupported attribution boundary leaves an explicit projection gap.
 * Does not read another file prefix, modify native history, execute tools or invent evidence from text.
 */
export function projectCheckpointAnswer(file: string, candidate: unknown, input: CheckpointAnswerInput): AnswerManifest | undefined {
  let manifest: AnswerManifest | undefined
  verifyWorkerCheckpoint(file, candidate, (entries, checkpoint) => { manifest = project(entries, checkpoint, input) })
  return manifest
}

function project(entries: Record<string, unknown>[], checkpoint: ProductPiCheckpoint, input: CheckpointAnswerInput): AnswerManifest | undefined {
  if (!validateContractShape('source-scope-version', input.scope).ok || !Number.isSafeInteger(input.turn) || input.turn < 1 || input.reads.length > 1000) return undefined
  const byId = new Map(entries.map(entry => [entry.id, entry])), branch: Record<string, unknown>[] = []
  let entry = byId.get(checkpoint.leafEntryId)
  while (entry && entry.id !== checkpoint.userEntryId) {
    // A compaction, branch-summary, custom message or steering user needs a separate reviewed attribution proof.
    if (entry.type !== 'message') {
      // These native records carry metadata, not conversation turns or evidence catalogs.
      if (!['label', 'custom', 'model_change', 'thinking_level_change', 'session_info'].includes(String(entry.type))) return undefined
      entry = byId.get(entry.parentId)
      continue
    }
    const message = record(entry.message)
    if (!message || message.role !== 'assistant' && message.role !== 'toolResult') return undefined
    branch.unshift(entry)
    entry = byId.get(entry.parentId)
  }
  if (!entry || !branch.length) return undefined
  const answerEntry = branch.at(-1)!, answer = record(answerEntry.message)
  if (answer?.role !== 'assistant' || answer.stopReason !== 'stop' || !Array.isArray(answer.content)
    || answer.content.some(part => record(part)?.type === 'toolCall') || typeof answerEntry.id !== 'string') return undefined
  const blocks = answer.content.flatMap((part, index) => {
    const value = record(part)
    return value?.type === 'text' && typeof value.text === 'string' ? [{ index, text: value.text }] : []
  })
  if (!blocks.length) return undefined
  const attestations = new Map<string, CheckpointReadAttestation>()
  for (const read of input.reads) {
    if (!read.callId || read.callId.length > 256 || attestations.has(read.callId)) return undefined
    attestations.set(read.callId, read)
  }
  const calls = new Map<string, Record<string, unknown>>(), resolved = new Set<string>(), reads: AnswerReadReceipt[] = []
  let locatorCount = 0
  for (const current of branch.slice(0, -1)) {
    const message = record(current.message)!
    if (message.role === 'assistant') {
      if (!Array.isArray(message.content)) return undefined
      for (const part of message.content) {
        const call = record(part)
        if (call?.type !== 'toolCall') continue
        if (typeof call.id !== 'string' || calls.has(call.id) || typeof call.name !== 'string') return undefined
        calls.set(call.id, call)
      }
      continue
    }
    if (typeof message.toolCallId !== 'string' || resolved.has(message.toolCallId)) return undefined
    const call = calls.get(message.toolCallId)
    if (!call || message.toolName !== call.name) return undefined
    resolved.add(message.toolCallId)
    if (call.name !== 'docatlas_read' || message.isError !== false) continue
    const read = attestations.get(message.toolCallId)
    if (!read || !attestedRead(read, call, message, input)) continue
    locatorCount += read.locators.length
    if (locatorCount > 1000) return undefined
    reads.push({ callId: read.callId, scopeVersionId: read.scopeVersionId, locators: read.locators })
  }
  // Outstanding native calls imply that this final message is not a proved settled tool/answer interval.
  if ([...calls.keys()].some(id => !resolved.has(id))) return undefined
  return compileSourceAnswerManifest({ sessionId: input.sessionId, turn: input.turn, scope: input.scope, sources: input.sources,
    message: { id: answerEntry.id, createdAt: checkpoint.settledAt, blocks }, reads })
}

function attestedRead(read: CheckpointReadAttestation, call: Record<string, unknown>, message: Record<string, unknown>, input: CheckpointAnswerInput): boolean {
  if (read.scopeVersionId !== input.scope.scopeVersionId || !validateContractShape('sidecar-document-rpc', read.result).ok || read.result.resultType !== 'read'
    || read.result.mode === 'locate' || readResultIssues(read.result).length || pageInfoIssues(read.result.pageInfo).length || read.locators.length > 200) return false
  const result = read.result, args = record(call.arguments), details = record(message.details), content = message.content
  if (!args || args.documentId !== result.source.documentId || args.revisionId !== undefined && args.revisionId !== result.source.revisionId || args.mode !== result.mode
    || !details || !validateContractShape('docatlas-tool-meta', details).ok || details.operation !== 'read' || details.scopeVersionId !== read.scopeVersionId
    || !Array.isArray(content) || record(content[0])?.type !== 'text' || record(content[0])?.text !== JSON.stringify(result)
    || JSON.stringify(details.locators) !== JSON.stringify(read.locators) || JSON.stringify(read.locators) !== JSON.stringify(result.items.map(item => item.locator))) return false
  // A valid host receipt may contain an image after the JSON, never additional worker-authored prose.
  if (content.slice(1).some(part => record(part)?.type !== 'image')) return false
  const source = input.sources.find(source => source.documentId === result.source.documentId && source.revisionId === result.source.revisionId && source.representationId === result.source.representationId)
  if (!source || !input.scope.included.some(item => item.documentId === source.documentId && item.revisionId === source.revisionId)
    || input.scope.excluded.some(item => item.documentId === source.documentId && item.revisionId === source.revisionId)) return false
  if (args.physicalPage !== undefined && result.items.some(item => item.physicalPage !== args.physicalPage)) return false
  if (result.mode === 'blocks' && (!Array.isArray(args.blockIds) || result.items.some(item => item.itemType !== 'block' || !(args.blockIds as unknown[]).includes(item.blockId)))) return false
  return result.items.every(item => sameSource(item.locator, source)
    && (item.itemType !== 'block' || item.locator.selectors.every(selector => selector.type !== 'text-quote' || item.text.includes(selector.exact))))
}
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function sameSource(locator: DocumentLocator, source: ScopedSourceIdentity): boolean {
  return locator.documentId === source.documentId && locator.revisionId === source.revisionId && locator.representationId === source.representationId && locator.representationContentHash === source.representationContentHash
}
