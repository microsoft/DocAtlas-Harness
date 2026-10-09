import type { ProductBinding } from './product-control-contracts.js'
import { productAnswerIssues, type CitationFocus } from './product-answer-contracts.js'

export interface QuestionContextTarget { kind: 'message' | 'submission', id: string }
export interface QuestionPassage { selectionContextId: string, locatorId: string, physicalPage: number, text: string, original: CitationFocus['original'] }
export interface QuestionContext {
  schemaVersion: 1, kind: 'question-context', binding: ProductBinding, target: QuestionContextTarget,
  status: 'available' | 'none' | 'unavailable', reason: 'history' | 'source' | 'purged' | null,
  requestHash: string | null, nativeTextHash: string | null, selectionState: 'attached' | 'consumed' | null, passages: QuestionPassage[],
}
export interface QuestionSelectionFocus extends Pick<CitationFocus, 'status' | 'locator' | 'physicalPage' | 'exactText' | 'original'> {
  schemaVersion: 1, kind: 'question-selection-focus', binding: ProductBinding, target: QuestionContextTarget, selectionContextId: string, locatorId: string,
}
export type QuestionContextValue = QuestionContext | QuestionSelectionFocus
export function questionContextIssues(value: QuestionContextValue): string[] {
  const issues: string[] = []
  if (value.kind === 'question-context') {
    if (value.status === 'available' ? !value.passages.length || !value.requestHash || !value.selectionState || value.reason !== null || value.target.kind === 'message' && !value.nativeTextHash
      : value.passages.length || value.requestHash !== null || value.selectionState !== null) issues.push('context-state')
    if ((value.status === 'unavailable') !== (value.reason !== null)) issues.push('context-reason')
    if (value.passages.reduce((sum, item) => sum + [...item.text].length, 0) > 8000) issues.push('context-budget')
    if (new Set(value.passages.map(item => `${item.selectionContextId}:${item.locatorId}`)).size !== value.passages.length) issues.push('context-duplicate')
    for (const item of value.passages) if (!item.text.trim() || item.physicalPage > item.original.pageCount) issues.push('context-passage')
  } else {
    if (value.locatorId !== value.locator.locatorId) issues.push('context-locator')
    // Reuse geometry/source consistency rules without representing this input as a published citation.
    issues.push(...productAnswerIssues({ ...value, kind: 'citation-focus', conversationId: value.binding.conversationId, messageId: value.target.id, citationId: value.locatorId }))
  }
  return issues
}
