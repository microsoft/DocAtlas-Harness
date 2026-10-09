import type { ProductBinding, ProductPiCheckpoint, ProductRunReceipt } from './product-control-contracts.js'
import { productControlIssues } from './product-control-contracts.js'
import { nativeSelectedHeadIssues, type NativeHistoryOrigin, type NativeSelectedHead } from './native-lineage-contracts.js'

export type RuntimeProgress =
  | { type: 'text', messageId: string, delta: string }
  | { type: 'tool-start' | 'tool-end', toolName: string, toolCallId: string }
  | { type: 'resync' }
export interface NativeConversationMessage { entryId: string, role: 'user' | 'assistant', text: string, truncated: boolean, origin?: NativeHistoryOrigin }
export interface NativeConversationHistory {
  checkpoint: ProductPiCheckpoint | null, messages: NativeConversationMessage[], hasEarlier: boolean
  /** A verified selected native view before this binding has completed a new question. */
  selectedHead?: NativeSelectedHead
}
export interface ObservationCursor { streamId: string, sequence: number }
export type ObservationUpdate =
  | { type: 'receipt', receipt: ProductRunReceipt }
  | { type: 'progress', submissionId: string, progress: RuntimeProgress }
  | { type: 'resync', reason: 'initial' | 'gap' | 'epoch' | 'overflow' }
export interface ConversationObservation {
  schemaVersion: 1, kind: 'conversation-observation', conversationId: string, generation: number,
  cursor: ObservationCursor, update: ObservationUpdate
}
export interface ConversationSnapshot {
  schemaVersion: 1, kind: 'conversation-snapshot', binding: ProductBinding, cursor: ObservationCursor,
  runs: Array<{ receipt: ProductRunReceipt, text: string | null }>, nextRunsCursor: string | null,
  history: NativeConversationHistory, live: Array<{ submissionId: string, messageId: string, text: string, truncated: boolean }>,
  activity: Array<{ submissionId: string, toolCallId: string, toolName: string, state: 'running' | 'ended' }>,
  liveIncomplete: boolean
}
export type ConversationObservationValue = ConversationObservation | ConversationSnapshot

/** Run after shape validation; identity consistency is not implied by valid JSON fields. */
export function conversationObservationIssues(value: ConversationObservationValue): string[] {
  const issues: string[] = []
  if (value.kind === 'conversation-observation') {
    if (value.update.type === 'receipt') {
      const receipt = value.update.receipt
      if (receipt.conversationId !== value.conversationId || receipt.generation !== value.generation) issues.push('receipt-scope')
      issues.push(...productControlIssues(receipt))
    }
    return issues
  }
  issues.push(...productControlIssues(value.binding))
  if (value.runs.some(run => run.receipt.conversationId !== value.binding.conversationId || run.receipt.generation > value.binding.generation)) issues.push('receipt-scope')
  if (new Set(value.runs.map(run => run.receipt.submissionId)).size !== value.runs.length) issues.push('duplicate-run')
  for (const run of value.runs) issues.push(...productControlIssues(run.receipt))
  if (value.history.checkpoint) {
    if (value.history.selectedHead !== undefined) issues.push('duplicate-history-authority')
    if (value.history.checkpoint.runtimeSessionId !== value.binding.runtimeSessionId) issues.push('history-scope')
    issues.push(...productControlIssues(value.history.checkpoint))
  } else if (value.history.messages.length && value.history.selectedHead === undefined) issues.push('unverified-history')
  if (value.history.selectedHead && (nativeSelectedHeadIssues(value.history.selectedHead).length || value.history.selectedHead.fileSeal.sessionId !== value.binding.runtimeSessionId)) issues.push('history-scope')
  if (value.history.selectedHead?.selectedLeafEntryId === null && (value.history.messages.length || value.history.hasEarlier)) issues.push('history-root')
  if (value.history.messages.some(message => message.origin && message.origin.entryId !== message.entryId)) issues.push('history-origin')
  if (new Set(value.history.messages.map(message => message.entryId)).size !== value.history.messages.length) issues.push('duplicate-entry')
  if (new Set(value.live.map(message => message.messageId)).size !== value.live.length) issues.push('duplicate-live')
  if (new Set(value.activity.map(activity => `${activity.submissionId}\0${activity.toolCallId}`)).size !== value.activity.length) issues.push('duplicate-activity')
  return issues
}
