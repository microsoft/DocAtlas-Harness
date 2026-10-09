import type { NativeConversationMessage, NativeHistoryOrigin, NativeSelectedHead, ProductHistoryMessage, ProductPiCheckpoint } from '@docatlas/contracts'

/** Snapshot projection has no nativeTextHash. Never manufacture one from prepared/original user text. */
export type DisplayHistoryMessage = NativeConversationMessage | ProductHistoryMessage
export interface LiveHistory {
  messages: DisplayHistoryMessage[]
  head: ProductPiCheckpoint | null
  selectedHead: NativeSelectedHead | null
  hasEarlier: boolean
  nextCursor: string | null
  loading: boolean
  error: string
  loaded: boolean
}
export const emptyHistory = (): LiveHistory => ({ messages: [], head: null, selectedHead: null, hasEarlier: false, nextCursor: null, loading: false, error: '', loaded: false })
export const historyHeadKey = (head: ProductPiCheckpoint | null | undefined, selectedHead?: NativeSelectedHead | null): string => head ? JSON.stringify([
  head.schemaVersion, head.kind, head.submissionId, head.requestHash, head.runtimeSessionId, head.userEntryId,
  head.leafEntryId, head.transcriptHash, head.byteLength, head.entryCount, head.settledAt,
]) : selectedHead ? JSON.stringify(['selected', selectedHead.version, selectedHead.fileSeal.version, selectedHead.fileSeal.sessionId,
  selectedHead.fileSeal.transcriptHash, selectedHead.fileSeal.byteLength, selectedHead.fileSeal.entryCount, selectedHead.fileSeal.tailEntryId,
  selectedHead.selectedLeafEntryId, selectedHead.contextHash]) : ''
export const historyOriginKey = (origin: NativeHistoryOrigin | undefined): string => origin ? JSON.stringify([
  origin.conversationId, origin.bindingId, origin.generation, origin.runtimeSessionId, origin.entryId,
]) : ''

/** Preserve chronological ordering when a newest-50 page overlaps a newest-100 snapshot. */
export function mergeHistory(existing: DisplayHistoryMessage[], page: ProductHistoryMessage[], continuation: boolean): DisplayHistoryMessage[] {
  // Older snapshot producers included tool/thinking-only assistant entries. They are
  // invisible UI metadata, not pagination anchors. Keep empty unavailable human inputs.
  existing = existing.filter(message => message.role === 'user' || message.text.length > 0)
  const indices = new Map(existing.map((message, index) => [message.entryId, index])), incoming = new Set(page.map(message => message.entryId))
  if (indices.size !== existing.length || incoming.size !== page.length) throw new Error('Duplicate history entries')
  const overlap = page.flatMap((message, pageIndex) => {
    const index = indices.get(message.entryId)
    if (index === undefined) return []
    const old = existing[index]!
    const compatible = old.truncated ? message.text.startsWith(old.text) : old.text === message.text && !message.truncated
    if (old.role !== message.role || !compatible || historyOriginKey(old.origin) !== historyOriginKey(message.origin)
      || 'nativeTextHash' in old && old.nativeTextHash !== message.nativeTextHash) throw new Error('History entry changed under the same checkpoint')
    return [{ index, pageIndex }]
  })
  let result: DisplayHistoryMessage[]
  if (!overlap.length) {
    if (existing.length && page.length && !continuation) throw new Error('Initial history page does not overlap the saved snapshot')
    result = [...page, ...existing]
  } else {
    const first = overlap[0]!, last = overlap.at(-1)!
    if (overlap.some((item, index) => index > 0 && item.index <= overlap[index - 1]!.index)
      || existing.slice(first.index, last.index + 1).some(message => !incoming.has(message.entryId))
      || first.pageIndex > 0 && first.index > 0 || last.pageIndex < page.length - 1 && last.index < existing.length - 1) throw new Error('History page order conflicts with the saved branch')
    result = [...existing.slice(0, first.index), ...page, ...existing.slice(last.index + 1)]
  }
  if (result.length > 2000 || result.reduce((total, message) => total + message.text.length, 0) > 8388608) throw new Error('当前页面已达到历史显示上限；原生完整记录仍保留。')
  return result
}

export async function historyTextHash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
}
