import type { ProductRunReceipt, ProductSelectionTicket, ProductSubmission } from '@docatlas/contracts'
import type { LiveState } from './client'

/** Ephemeral presentation of the existing outbox, never a second transcript. */
export interface OutgoingMessage {
  bindingId: string, request: ProductSubmission, requestHash: string | null,
  selections: ProductSelectionTicket[], receipt: ProductRunReceipt | null,
}
export function outgoingMessage(state: LiveState): OutgoingMessage | null {
  const value = state.outgoing, binding = state.snapshot?.binding
  if (!value || state.phase !== 'ready' || !binding || value.bindingId !== binding.bindingId || state.selected !== value.request.conversationId
    || value.request.expectedGeneration !== binding.generation) return null
  const run = state.snapshot!.runs.find(item => item.receipt.requestHash === value.requestHash && item.receipt.generation === value.request.expectedGeneration)
  // Retraction/purge wins over local convenience. Only keep the local copy
  // while the authoritative projection has no text yet.
  if (run && (!run.receipt.payloadRetained || run.text !== null || run.receipt.checkpoint)) return null
  return value
}
