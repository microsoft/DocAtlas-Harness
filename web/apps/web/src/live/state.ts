import type { ConversationObservation, ConversationSnapshot, ProductSubmission, ProductSelectionTicket } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'

export function applyObservation(snapshot: ConversationSnapshot, event: ConversationObservation): { snapshot: ConversationSnapshot, refresh: boolean } {
  if (event.conversationId !== snapshot.binding.conversationId || event.generation < snapshot.binding.generation) return { snapshot, refresh: false }
  if (event.generation !== snapshot.binding.generation || event.cursor.streamId !== snapshot.cursor.streamId || event.update.type === 'resync') return { snapshot, refresh: true }
  if (event.cursor.sequence <= snapshot.cursor.sequence) return { snapshot, refresh: false }
  if (event.cursor.sequence !== snapshot.cursor.sequence + 1) return { snapshot, refresh: true }
  const next = structuredClone(snapshot); next.cursor = event.cursor
  const update = event.update
  if (update.type === 'receipt') {
    const index = next.runs.findIndex(run => run.receipt.submissionId === update.receipt.submissionId)
    if (index < 0) next.runs.push({ receipt: update.receipt, text: null })
    else if (next.runs[index]!.receipt.version < update.receipt.version) next.runs[index]!.receipt = update.receipt
    next.runs = next.runs.slice(-32)
    return { snapshot: next, refresh: index < 0 || ['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(update.receipt.state) }
  }
  const run = next.runs.find(value => value.receipt.submissionId === update.submissionId)
  if (!run || !['running', 'cancelling'].includes(run.receipt.state)) return { snapshot, refresh: true }
  const progress = update.progress
  if (progress.type === 'resync') return { snapshot, refresh: true }
  if (progress.type === 'text') {
    let message = next.live.find(item => item.messageId === progress.messageId)
    if (message && message.submissionId !== update.submissionId) return { snapshot, refresh: true }
    if (!message) { message = { submissionId: update.submissionId, messageId: progress.messageId, text: '', truncated: false }; next.live.push(message) }
    if (next.live.length > 8) { next.live.shift(); next.liveIncomplete = true }
    const remaining = Math.max(0, 65536 - next.live.reduce((sum, item) => sum + item.text.length, 0))
    let part = progress.delta.slice(0, remaining)
    if (part.length < progress.delta.length && /[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1)
    message.text += part; message.truncated ||= part.length !== progress.delta.length; next.liveIncomplete ||= message.truncated
  } else {
    const index = next.activity.findIndex(item => item.submissionId === update.submissionId && item.toolCallId === progress.toolCallId)
    const item = { submissionId: update.submissionId, toolCallId: progress.toolCallId, toolName: progress.toolName, state: progress.type === 'tool-start' ? 'running' as const : 'ended' as const }
    if (index < 0) next.activity.push(item); else next.activity[index] = item
    if (next.activity.length > 64) { next.activity.shift(); next.liveIncomplete = true }
  }
  return { snapshot: next, refresh: false }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`
  return JSON.stringify(value)
}
export async function submissionHash(request: ProductSubmission): Promise<string> {
  return canonicalHash(request)
}
export async function canonicalHash(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
}
export interface DraftRecord { version: 1, draft: string, request: ProductSubmission | null, sources?: ProductSubmission['sourceRefs'], selections?: ProductSelectionTicket[] }
export function parseDraft(raw: string | null, conversationId: string): DraftRecord {
  if (raw === null) return { version: 1, draft: '', request: null }
  if (raw.length > 524288) throw new Error('Invalid tab draft')
  const value = JSON.parse(raw) as DraftRecord
  if (!value || !['draft,request,version', 'draft,request,sources,version', 'draft,request,selections,sources,version'].includes(Object.keys(value).sort().join(',')) || value.version !== 1 || typeof value.draft !== 'string' || value.draft.length > 6000) throw new Error('Invalid tab draft')
  if (value.selections !== undefined) {
    if (!Array.isArray(value.selections) || value.selections.length > 8) throw new Error('Invalid selection tray')
    for (const item of value.selections) { const ticket = parseBrowserContract('document-http', item); if (ticket.kind !== 'selection-ticket' || ticket.conversationId !== conversationId || !ticket.items.every(item => value.sources?.some(source => source.documentId === item.locator.documentId && source.revisionId === item.locator.revisionId))) throw new Error('Invalid selection ticket scope') }
    if (new Set(value.selections.map(item => item.selectionContextId)).size !== value.selections.length || value.selections.flatMap(value => value.items).reduce((sum, item) => sum + [...item.text].length, 0) > 8000) throw new Error('Invalid selection group')
  }
  if (value.sources !== undefined) parseBrowserContract('product-control', { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: 1, idempotencyKey: 'draft:source-validation', mode: 'prompt', text: 'draft', sourceRefs: value.sources, selectionContextIds: [] })
  if (value.request !== null) {
    const request = parseBrowserContract('product-control', value.request)
    if (request.kind !== 'submission' || request.conversationId !== conversationId || canonical(request.selectionContextIds) !== canonical((value.selections ?? []).map(item => item.selectionContextId)) || request.text !== value.draft || value.sources && canonical(request.sourceRefs) !== canonical(value.sources)) throw new Error('Invalid tab submission')
  }
  return value
}
