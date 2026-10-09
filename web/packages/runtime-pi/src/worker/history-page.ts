import { createHash } from 'node:crypto'
import type { NativeConversationMessage, ProductPiCheckpoint } from '@docatlas/contracts'
import { verifyWorkerCheckpoint } from './checkpoint.js'

export const NATIVE_HISTORY_PAGE_LIMIT = 50
export const NATIVE_HISTORY_PAGE_CHARS = 131072
export const NATIVE_HISTORY_MESSAGE_CHARS = 65536
export interface NativeHistoryPageMessage extends NativeConversationMessage { nativeTextHash: string }
export interface NativeHistoryPageProjection {
  checkpoint: ProductPiCheckpoint
  messages: NativeHistoryPageMessage[]
  hasEarlier: boolean
}
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Read-only projection of the SAME independently verified native prefix and actual parent branch.
 * The optional entry is exclusive and cannot select metadata, another branch or an uncommitted tail.
 * Full-text hashes witness only native visible text, never thinking/tool/system/provider payloads.
 */
export function checkpointHistoryPage(file: string, candidate: unknown, beforeEntryId?: string): NativeHistoryPageProjection {
  if (beforeEntryId !== undefined && !opaque(beforeEntryId)) throw new Error('Invalid native history page boundary')
  let result: NativeHistoryPageProjection | undefined
  verifyWorkerCheckpoint(file, candidate, (entries, checkpoint) => {
    const byId = new Map(entries.map(entry => [entry.id, entry])), seen = new Set<string>()
    const visible: Array<{ entryId: string, role: 'user' | 'assistant', text: string }> = []
    let entry = byId.get(checkpoint.leafEntryId)
    if (!entry) throw new Error('Missing native history leaf')
    while (entry) {
      if (!opaque(entry.id) || seen.has(entry.id) || entry.parentId !== null && !opaque(entry.parentId)) throw new Error('Invalid native history branch identity')
      seen.add(entry.id)
      const message = entry.type === 'message' ? object(entry.message) : undefined
      if (message?.role === 'user' || message?.role === 'assistant') {
        const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
          ? message.content.flatMap(part => { const item = object(part); return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [] }).join('\n') : ''
        // Tool-call-only/thinking-only assistant entries are not public text pagination anchors.
        if (text.length > 0) visible.push({ entryId: entry.id, role: message.role, text })
      }
      if (entry.parentId === null) break
      entry = byId.get(entry.parentId)
      if (!entry) throw new Error('Incomplete native history branch')
    }
    const boundary = beforeEntryId === undefined ? -1 : visible.findIndex(message => message.entryId === beforeEntryId)
    if (beforeEntryId !== undefined && boundary < 0) throw new Error('Native history boundary is not visible on the verified branch')
    let remaining = NATIVE_HISTORY_PAGE_CHARS, hasEarlier = false
    const messages: NativeHistoryPageMessage[] = []
    for (const message of visible.slice(boundary + 1)) {
      if (messages.length >= NATIVE_HISTORY_PAGE_LIMIT) { hasEarlier = true; break }
      let selected = message.text.slice(0, NATIVE_HISTORY_MESSAGE_CHARS)
      if (selected.length < message.text.length && /[\uD800-\uDBFF]$/u.test(selected)) selected = selected.slice(0, -1)
      // Leave an entire older entry for the next page; page budgeting never discards its tail.
      if (selected.length > remaining) { hasEarlier = true; break }
      remaining -= selected.length
      messages.push({ entryId: message.entryId, role: message.role, text: selected, truncated: selected.length < message.text.length,
        nativeTextHash: createHash('sha256').update(message.text).digest('hex') })
    }
    result = { checkpoint, messages: messages.reverse(), hasEarlier }
  })
  return result!
}
