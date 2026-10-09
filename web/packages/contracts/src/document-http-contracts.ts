import type { LibraryRpcResult } from './library-contracts.js'
import { documentLocatorIssues, type DocumentLocator } from './m0-contracts.js'
export interface UploadStart { schemaVersion: 1, kind: 'upload-start', idempotencyKey: string, name: string, byteLength: number, contentHash: string }
export interface UploadReceipt { schemaVersion: 1, kind: 'upload', uploadId: string, conversationId: string, name: string, byteLength: number, contentHash: string, status: 'pending' | 'stored' }
export interface ProductSelectionProposal { documentId: string, revisionId: string, physicalPage: number, quote: string }
export interface ProductSelectionStage { schemaVersion: 1, kind: 'selection-stage', idempotencyKey: string, expectedGeneration: number, proposals: ProductSelectionProposal[] }
export interface VerifiedSelectionItem { locator: DocumentLocator, text: string }
export interface ProductSelectionTicket {
  schemaVersion: 1, kind: 'selection-ticket', selectionContextId: string, conversationId: string, workspaceId: string, actorId: string, bindingId: string, generation: number,
  state: 'staged' | 'bound' | 'consumed' | 'cancelled' | 'expired', items: VerifiedSelectionItem[], createdAt: string, expiresAt: string, submissionId: string | null, requestHash: string | null,
}
export type DocumentHttpValue = UploadStart | UploadReceipt | ProductSelectionStage | ProductSelectionTicket | { schemaVersion: 1, kind: 'library-response', conversationId: string, result: LibraryRpcResult }
export function selectionTicketValid(value: ProductSelectionTicket): boolean {
  return Date.parse(value.expiresAt) > Date.parse(value.createdAt) && value.items.reduce((sum, item) => sum + [...item.text].length, 0) <= 8000
    && (value.submissionId === null) === (value.requestHash === null)
    && (['bound', 'consumed'].includes(value.state) ? value.submissionId !== null : value.state === 'expired' || value.submissionId === null)
    && new Set(value.items.map(item => item.locator.locatorId)).size === value.items.length
    && value.items.every(item => !documentLocatorIssues(item.locator).length && item.locator.selectors.some(selector => selector.type === 'text-quote' && selector.exact === item.text))
}
