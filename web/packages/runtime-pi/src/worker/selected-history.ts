import { createHash } from 'node:crypto'
import type { NativeConversationHistory, NativeSelectedHead } from '@docatlas/contracts'
import { NATIVE_HISTORY_MESSAGE_CHARS, NATIVE_HISTORY_PAGE_CHARS, NATIVE_HISTORY_PAGE_LIMIT, type NativeHistoryPageMessage } from './history-page.js'
import { verifyNativeFileSeal, verifyNativeSelectedHead } from './native-selection.js'

export type NativeSelectedConversation = NativeConversationHistory & { selectedHead: NativeSelectedHead, checkpoint: null }
export interface NativeSelectedHistoryPage { selectedHead: NativeSelectedHead, messages: NativeHistoryPageMessage[], hasEarlier: boolean }
interface Visible { entryId: string, role: 'user' | 'assistant', text: string }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function visibleBranch(file: string, cwd: string, candidate: NativeSelectedHead): { selectedHead: NativeSelectedHead, visible: Visible[] } {
  const selectedHead = verifyNativeSelectedHead(file, cwd, candidate), snapshot = verifyNativeFileSeal(file, cwd, selectedHead.fileSeal)
  const byId = new Map(snapshot.entries.map(entry => [entry.id, entry])), seen = new Set<string>(), visible: Visible[] = []
  let current = selectedHead.selectedLeafEntryId === null ? undefined : byId.get(selectedHead.selectedLeafEntryId)
  if (selectedHead.selectedLeafEntryId !== null && !current) throw new Error('Missing selected native history leaf')
  while (current) {
    if (!id(current.id) || seen.has(current.id) || current.parentId !== null && !id(current.parentId)) throw new Error('Invalid selected native history branch')
    seen.add(current.id)
    const message = current.type === 'message' ? object(current.message) : undefined
    if (message?.role === 'user' || message?.role === 'assistant') {
      const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
        ? message.content.flatMap(part => { const block = object(part); return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [] }).join('\n') : ''
      // Native thinking/tool-only and metadata entries never consume a visible-page slot or become an anchor.
      if (text.length) visible.push({ entryId: current.id, role: message.role, text })
    }
    if (current.parentId === null) break
    current = byId.get(current.parentId)
    if (!current) throw new Error('Incomplete selected native history branch')
  }
  return { selectedHead, visible }
}

function window(visible: Visible[], count: number, budget: number): { messages: NativeHistoryPageMessage[], hasEarlier: boolean } {
  const messages: NativeHistoryPageMessage[] = []; let remaining = budget, hasEarlier = false
  for (const message of visible) {
    if (messages.length >= count) { hasEarlier = true; break }
    let selected = message.text.slice(0, NATIVE_HISTORY_MESSAGE_CHARS)
    if (selected.length < message.text.length && /[\uD800-\uDBFF]$/u.test(selected)) selected = selected.slice(0, -1)
    // Keep this whole older entry for the next request, instead of truncating it merely to fill a page.
    if (selected.length > remaining) { hasEarlier = true; break }
    remaining -= selected.length
    messages.push({ entryId: message.entryId, role: message.role, text: selected, truncated: selected.length < message.text.length,
      nativeTextHash: createHash('sha256').update(message.text).digest('hex') })
  }
  return { messages: messages.reverse(), hasEarlier }
}

/** Private host projection of an explicit selection, including root/metadata-only states. No invented Answer checkpoint.
 * Native user text may contain prepared source data: only the host's exact-original mapping can make a human-visible draft/history.
 */
export function selectedConversation(file: string, cwd: string, head: NativeSelectedHead): NativeSelectedConversation {
  const { selectedHead, visible } = visibleBranch(file, cwd, head), projected = window(visible, 100, 262144)
  return { checkpoint: null, selectedHead, hasEarlier: projected.hasEarlier,
    messages: projected.messages.map(({ nativeTextHash: _nativeTextHash, ...message }) => message) }
}

/** Read-only, exclusive visible boundary on the same sealed prefix and explicit parent chain. */
export function selectedHistoryPage(file: string, cwd: string, head: NativeSelectedHead, beforeEntryId?: string): NativeSelectedHistoryPage {
  if (beforeEntryId !== undefined && !id(beforeEntryId)) throw new Error('Invalid selected native history page boundary')
  const { selectedHead, visible } = visibleBranch(file, cwd, head)
  const boundary = beforeEntryId === undefined ? -1 : visible.findIndex(message => message.entryId === beforeEntryId)
  if (beforeEntryId !== undefined && boundary < 0) throw new Error('Selected history boundary is not visible on this verified branch')
  return { selectedHead, ...window(visible.slice(boundary + 1), NATIVE_HISTORY_PAGE_LIMIT, NATIVE_HISTORY_PAGE_CHARS) }
}
