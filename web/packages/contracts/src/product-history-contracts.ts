import type { NativeConversationMessage } from './observation-contracts.js'
import type { ProductBinding, ProductPiCheckpoint } from './product-control-contracts.js'
import { nativeSelectedHeadIssues, type NativeSelectedHead } from './native-lineage-contracts.js'

export interface ProductHistoryRequest { schemaVersion: 1, kind: 'history-page-request', expectedGeneration: number, cursor: string | null }
export interface ProductHistoryMessage extends NativeConversationMessage {
  nativeTextHash: string
  /** Original human input is restored by exact ControlStore userEntry binding, not text matching. */
  displayOrigin: 'native' | 'submission' | 'unavailable'
}
export interface ProductHistoryPage {
  schemaVersion: 1
  kind: 'history-page'
  binding: ProductBinding
  checkpoint: ProductPiCheckpoint | null
  selectedHead?: NativeSelectedHead
  messages: ProductHistoryMessage[]
  hasEarlier: boolean
  nextCursor: string | null
}
export type ProductHistoryValue = ProductHistoryRequest | ProductHistoryPage
export function productHistoryIssues(value: ProductHistoryValue): string[] {
  if (value.kind !== 'history-page') return []
  const issues: string[] = []
  if (value.checkpoint === null ? !value.selectedHead && (value.messages.length || value.hasEarlier || value.nextCursor !== null)
    : value.selectedHead !== undefined || value.checkpoint.runtimeSessionId !== value.binding.runtimeSessionId) issues.push('history-checkpoint')
  if (value.selectedHead && (nativeSelectedHeadIssues(value.selectedHead).length || value.selectedHead.fileSeal.sessionId !== value.binding.runtimeSessionId)) issues.push('history-selected-head')
  if (value.selectedHead?.selectedLeafEntryId === null && (value.messages.length || value.hasEarlier || value.nextCursor !== null)) issues.push('history-root')
  if (value.messages.some(message => message.origin && message.origin.entryId !== message.entryId)) issues.push('history-origin')
  if (value.hasEarlier !== (value.nextCursor !== null) || value.hasEarlier && !value.messages.length) issues.push('history-cursor')
  if (new Set(value.messages.map(message => message.entryId)).size !== value.messages.length) issues.push('history-duplicate')
  if (value.messages.some(message => message.role === 'assistant' && message.displayOrigin !== 'native'
    || message.role === 'user' && message.displayOrigin === 'native'
    || message.displayOrigin === 'submission' && message.truncated
    || message.displayOrigin === 'unavailable' && (message.text !== '' || message.truncated))) issues.push('history-display')
  if (value.messages.reduce((total, message) => total + message.text.length, 0) > 131072) issues.push('history-budget')
  return issues
}
