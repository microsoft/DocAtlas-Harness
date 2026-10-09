import { documentLocatorIssues, type DocumentLocator, type EvidenceAtom } from './m0-contracts.js'
import { researchNotebookRpcIssues, type ResearchNotebookResult } from './research-notebook-contracts.js'
import { researchLifecycleRpcIssues, type ResearchLifecycleResult } from './research-lifecycle-contracts.js'
import { selectionRpcIssues, type SelectionActionResult } from './selection-contracts.js'
import { productAnswerIssues, type CitationFocus } from './product-answer-contracts.js'

export interface NotebookQuery {
  schemaVersion: 1, kind: 'notebook-query', expectedGeneration: number,
  view: 'working' | 'workspace', maxItems: number, maxChars: number, cursor?: string
}
export interface NotebookResponse { schemaVersion: 1, kind: 'notebook-response', conversationId: string, result: ResearchNotebookResult }
export interface NoteSave {
  schemaVersion: 1, kind: 'note-save', expectedGeneration: number, idempotencyKey: string,
  selectionContextId: string, noteKind: 'commentary' | 'hypothesis' | 'scratch', body: string
}
export interface NoteSaved { schemaVersion: 1, kind: 'note-saved', conversationId: string, result: SelectionActionResult }
export type NotebookMutation = {
  schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: number, idempotencyKey: string,
  recordId: string, expectedVersion: number
} & ({ action: 'edit', text: string } | { action: 'archive' | 'delete' | 'resolve' })
export interface NotebookUpdated { schemaVersion: 1, kind: 'notebook-updated', conversationId: string, result: ResearchLifecycleResult }
export interface NotebookEntry {
  schemaVersion: 1, kind: 'notebook-entry', conversationId: string, recordId: string,
  recordType: 'research-note' | 'open-question', investigationId: string, sourceSessionId: string, scopeVersionId: string,
  version: number, status: 'active' | 'open' | 'resolved' | 'archived' | 'deleted', text: string | null,
  locators: DocumentLocator[], evidence: EvidenceAtom[], authoredBy: 'user' | 'agent', verificationStatus: 'unverified-lead'
}
export type ResearchFocus = Omit<CitationFocus, 'kind' | 'messageId' | 'citationId'> & { kind: 'research-focus', recordId: string }
export interface ResearchSessionPolicy {
  schemaVersion: 1, kind: 'research-session-policy', conversationId: string, version: number,
  recallPriorResearch: boolean, contributeResearchState: boolean
}
export interface ResearchPolicySet {
  schemaVersion: 1, kind: 'research-policy-set', expectedGeneration: number, idempotencyKey: string,
  expectedVersion: number, recallPriorResearch: boolean, contributeResearchState: boolean
}
/** Private host ledger only. This must never be accepted from a model or exposed as browser history. */
export interface ResearchCallProvenance {
  schemaVersion: 1, kind: 'research-call-provenance', workspaceId: string, actorId: string, conversationId: string,
  runtimeSessionId: string, submissionId: string, bindingId: string, generation: number,
  investigationId: string, scopeVersionId: string, nativeToolCallId: string, wireCallId: string,
  idempotencyKey: string, requestHash: string, recordId: string | null
}
export type ProductResearchValue = NotebookQuery | NotebookResponse | NoteSave | NoteSaved | NotebookMutation | NotebookUpdated
  | NotebookEntry | ResearchFocus | ResearchSessionPolicy | ResearchPolicySet | ResearchCallProvenance

export function productResearchIssues(value: ProductResearchValue): string[] {
  const issues: string[] = []
  if (value.kind === 'notebook-response') issues.push(...researchNotebookRpcIssues(value.result).map(issue => issue.code))
  if (value.kind === 'note-saved') {
    issues.push(...selectionRpcIssues(value.result).map(issue => issue.code))
    if (value.result.action !== 'create-note' || value.result.record.recordType !== 'research-note' || value.result.record.createdBy.kind !== 'user'
      || value.result.sessionId !== value.conversationId) issues.push('note-identity')
  }
  if (value.kind === 'notebook-updated') issues.push(...researchLifecycleRpcIssues(value.result).map(issue => issue.code))
  if (value.kind === 'research-focus') issues.push(...productAnswerIssues({ ...value, kind: 'citation-focus', messageId: value.recordId, citationId: value.locator.locatorId }))
  if (value.kind === 'notebook-entry') {
    if (value.status === 'deleted' ? value.text !== null || value.locators.length || value.evidence.length : value.text === null || !value.text.trim()) issues.push('note-state')
    if (value.recordType === 'research-note' && (value.status === 'open' || value.status === 'resolved') || value.recordType === 'open-question' && value.status === 'active') issues.push('note-kind')
    const ids = new Map(value.locators.map(locator => [locator.locatorId, locator]))
    if (ids.size !== value.locators.length || new Set(value.evidence.map(item => item.evidenceId)).size !== value.evidence.length) issues.push('note-duplicate')
    for (const locator of value.locators) issues.push(...documentLocatorIssues(locator).map(issue => issue.code))
    for (const evidence of value.evidence) {
      const locator = ids.get(evidence.locatorId)
      if (!locator || locator.documentId !== evidence.documentId || locator.revisionId !== evidence.revisionId || locator.representationId !== evidence.representationId) issues.push('note-evidence')
    }
  }
  return issues
}
