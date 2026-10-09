import type { UploadReceipt, UploadStart } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'

export interface PendingUpload { request: UploadStart, receipt: UploadReceipt | null, attachToQuestion?: { bindingId: string, generation: number } }

/** A saved upload is a retry intent, never authority to admit an uncommitted PDF. */
export function parsePendingUpload(raw: string, conversationId: string): PendingUpload {
  if (new TextEncoder().encode(raw).byteLength > 8192) throw new Error('Upload note exceeds limit')
  const saved = JSON.parse(raw) as PendingUpload
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !('receipt' in saved)
    || Object.keys(saved).some(key => !['request', 'receipt', 'attachToQuestion'].includes(key))) throw new Error('Invalid upload intent')
  const target = saved.attachToQuestion
  if (target !== undefined && (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).sort().join(',') !== 'bindingId,generation' || typeof target.bindingId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(target.bindingId) || !Number.isSafeInteger(target.generation) || target.generation < 1)) throw new Error('Invalid upload question target')
  const request = parseBrowserContract('document-http', saved.request)
  const receipt = saved.receipt === null ? null : parseBrowserContract('document-http', saved.receipt)
  if (request.kind !== 'upload-start' || receipt && (receipt.kind !== 'upload' || receipt.conversationId !== conversationId
    || receipt.contentHash !== request.contentHash || receipt.byteLength !== request.byteLength || receipt.name !== request.name)) throw new Error('Invalid upload identity')
  return { request, receipt: receipt as UploadReceipt | null, ...(saved.attachToQuestion === undefined ? {} : { attachToQuestion: saved.attachToQuestion }) }
}

export function uploadQuestionMatches(value: PendingUpload, binding: { bindingId: string, generation: number } | undefined): boolean {
  return !!value.attachToQuestion && !!binding && value.attachToQuestion.bindingId === binding.bindingId && value.attachToQuestion.generation === binding.generation
}
