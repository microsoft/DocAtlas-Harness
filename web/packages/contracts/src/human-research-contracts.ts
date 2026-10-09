import type { ProductBinding, ProductSourceRef } from './product-control-contracts.js'
import type { ProductSelectionProposal, VerifiedSelectionItem } from './document-http-contracts.js'
import type { ResearchSourceIdentity, ResearchRecordType } from './research-recall-contracts.js'
import type { ResearchGovernanceDraft, ResearchGovernanceRecord } from './research-governance-contracts.js'
import { researchGovernanceRpcIssues } from './research-governance-contracts.js'
import { researchNotebookRpcIssues, type ResearchNotebookResult } from './research-notebook-contracts.js'
import { treeOverlayRpcIssues, type TreeOverlayResult } from './tree-overlay-contracts.js'
import { productResearchIssues, type NotebookEntry, type ResearchFocus } from './product-research-contracts.js'
import { documentLocatorIssues } from './m0-contracts.js'

export type HumanResearchDraft =
  | { recordType: 'research-note', noteKind: 'commentary' | 'hypothesis' | 'scratch', body: string }
  | { recordType: 'open-question', question: string }
export type HumanResearchRecordType = 'research-note' | 'open-question' | 'project-decision' | 'research-policy'
export type HumanResearchRecordStatus = 'active' | 'open' | 'resolved' | 'archived'

/** Canonical domain record. Anchors are verified quotations, not new Read Evidence. */
export type HumanResearchRecord = {
  schemaVersion: 1, origin: 'human-command', recordId: string, workspaceId: string, investigationId: string,
  sourceSessionId: string, sourceScopeVersionId: string, provenanceCommandId: string, commandHash: string,
  version: 1, createdBy: { kind: 'user', actorId: string }, createdAt: string, epistemicStatus: 'unverified',
  anchors: VerifiedSelectionItem[], sourceIdentities: ResearchSourceIdentity[],
} & (Extract<HumanResearchDraft, { recordType: 'research-note' }> & { status: 'active' } | Extract<HumanResearchDraft, { recordType: 'open-question' }> & { status: 'open' })

export interface HumanResearchFrameRequest { schemaVersion: 1, expectedBindingId: string, expectedGeneration: number }
interface HumanResearchCommandBase extends HumanResearchFrameRequest { kind: 'human-research-command', idempotencyKey: string }
export type HumanResearchCommand = HumanResearchCommandBase & (
  | { action: 'create', entry: HumanResearchDraft | ResearchGovernanceDraft, sourceRefs: ProductSourceRef[], selections: ProductSelectionProposal[] }
  | { action: 'edit', recordId: string, expectedVersion: number, text: string }
  | { action: 'resolve' | 'archive' | 'delete', recordId: string, expectedVersion: number }
  | { action: 'revise', recordId: string, expectedVersion: number, entry: ResearchGovernanceDraft }
)

/** Host-computed identity. The complete public command hash is not source/Evidence authority. */
export interface HumanResearchCommandIdentity {
  operationId: string, idempotencyKey: string, requestHash: string, actorId: string, workspaceId: string,
  conversationId: string, bindingId: string, generation: number, action: HumanResearchCommand['action'],
}
/** Immutable commit metadata; replay does not republish erased/soft-deleted record prose. */
export interface HumanResearchReceipt extends HumanResearchCommandIdentity {
  schemaVersion: 1, kind: 'human-research-receipt', status: 'committed', recordId: string,
  recordType: HumanResearchRecordType, recordVersion: number, committedAt: string,
}
export interface HumanResearchOperation {
  schemaVersion: 1, kind: 'human-research-operation', binding: ProductBinding, operationId: string, receipt: HumanResearchReceipt | null,
}
export interface HumanResearchQuery extends HumanResearchFrameRequest {
  kind: 'human-research-query', view: 'working' | 'workspace', recordTypes: HumanResearchRecordType[],
  recordStatuses: HumanResearchRecordStatus[], maxItems: number, maxChars: number, cursor?: string,
}
export interface HumanResearchWorkspace {
  schemaVersion: 1, kind: 'human-research-workspace', binding: ProductBinding, result: ResearchNotebookResult,
}
export interface HumanResearchEntry {
  schemaVersion: 1, kind: 'human-research-entry', binding: ProductBinding, entry: NotebookEntry | ResearchGovernanceRecord,
  useStatus: 'unverified-lead' | 'user-governance',
}
export interface HumanResearchOverlayQuery extends HumanResearchFrameRequest {
  kind: 'human-research-overlay-query', source: ProductSourceRef, physicalPage?: number, view: 'working' | 'workspace',
  recordTypes: HumanResearchRecordType[], maxItems: number, maxChars: number, cursor?: string,
}
export interface HumanResearchOverlay {
  schemaVersion: 1, kind: 'human-research-overlay', binding: ProductBinding, result: TreeOverlayResult,
  recordVersions?: Array<{ recordId: string, version: number, authoredBy: 'user' | 'agent' }>,
}
export interface HumanResearchFocus {
  schemaVersion: 1, kind: 'human-research-focus', binding: ProductBinding, focus: ResearchFocus,
}
export type HumanResearchValue = HumanResearchRecord | HumanResearchCommand | HumanResearchReceipt | HumanResearchOperation
  | HumanResearchQuery | HumanResearchWorkspace | HumanResearchEntry | HumanResearchOverlayQuery | HumanResearchOverlay | HumanResearchFocus

const sourceKey = (value: ResearchSourceIdentity) => JSON.stringify([value.documentId, value.revisionId, value.representationId, value.representationContentHash])
const referenceKey = (value: ProductSourceRef) => JSON.stringify([value.documentId, value.revisionId])
const governance = (value: ResearchRecordType) => value === 'project-decision' || value === 'research-policy'
const humanTypes: readonly string[] = ['research-note', 'open-question', 'project-decision', 'research-policy']

/** Shape validation precedes these cross-field checks. Host provenance and PDF verification are separate. */
export function humanResearchIssues(value: HumanResearchValue): string[] {
  const issues: string[] = []
  if ('origin' in value) {
    if (value.createdBy.kind !== 'user' || (value.recordType === 'research-note' ? value.status !== 'active' : value.status !== 'open')) issues.push('human-record-state')
    const sources = new Set(value.sourceIdentities.map(sourceKey)), anchors = new Set<string>()
    if (sources.size !== value.sourceIdentities.length || new Set(value.sourceIdentities.map(referenceKey)).size !== value.sourceIdentities.length) issues.push('human-record-sources')
    for (const anchor of value.anchors) {
      const quote = anchor.locator.selectors.find(selector => selector.type === 'text-quote')
      if (documentLocatorIssues(anchor.locator).length || !sources.has(sourceKey(anchor.locator)) || anchors.has(anchor.locator.locatorId)
        || quote?.type !== 'text-quote' || quote.exact !== anchor.text) issues.push('human-record-anchor')
      anchors.add(anchor.locator.locatorId)
    }
    if (value.anchors.reduce((sum, anchor) => sum + [...anchor.text].length, 0) > 8000) issues.push('human-record-budget')
    return issues
  }
  if (value.kind === 'human-research-command') {
    if (value.action === 'create') {
      if (governance(value.entry.recordType) && value.selections.length) issues.push('human-governance-anchors')
      if (new Set(value.sourceRefs.map(referenceKey)).size !== value.sourceRefs.length) issues.push('human-source-duplicate')
      if (value.selections.reduce((sum, item) => sum + [...item.quote].length, 0) > 8000) issues.push('human-selection-budget')
      if (new Set(value.selections.map(item => JSON.stringify([item.documentId, item.revisionId, item.physicalPage, item.quote]))).size !== value.selections.length) issues.push('human-selection-duplicate')
      const all = new Set([...value.sourceRefs.map(referenceKey), ...value.selections.map(referenceKey)])
      if (all.size > 64) issues.push('human-source-budget')
    }
  }
  if (value.kind === 'human-research-receipt') {
    if (value.action === 'create' ? value.recordVersion !== 1 : value.recordVersion < 2) issues.push('human-receipt-version')
    if (value.action === 'revise' && !governance(value.recordType) || value.action === 'edit' && governance(value.recordType)
      || value.action === 'resolve' && value.recordType !== 'open-question') issues.push('human-receipt-action')
  }
  if (value.kind === 'human-research-operation' && value.receipt) {
    issues.push(...humanResearchIssues(value.receipt))
    if (value.receipt.operationId !== value.operationId || value.receipt.actorId !== value.binding.ownerActorId || value.receipt.workspaceId !== value.binding.workspaceId
      || value.receipt.conversationId !== value.binding.conversationId || value.receipt.generation > value.binding.generation
      || value.receipt.generation === value.binding.generation && value.receipt.bindingId !== value.binding.bindingId) issues.push('human-operation-owner')
  }
  if (value.kind === 'human-research-workspace') {
    issues.push(...researchNotebookRpcIssues(value.result).map(issue => issue.code))
    if (value.result.workspaceId !== value.binding.workspaceId) issues.push('human-workspace-owner')
    if (value.result.items.some(item => !humanTypes.includes(item.recordType))) issues.push('human-workspace-type')
  }
  if (value.kind === 'human-research-entry') {
    const entry = value.entry
    if ('kind' in entry) {
      issues.push(...productResearchIssues(entry))
      if (value.useStatus !== 'unverified-lead' || entry.conversationId !== value.binding.conversationId) issues.push('human-entry-kind')
    } else {
      issues.push(...researchGovernanceRpcIssues({ schemaVersion: 1, resultType: 'research-governance', status: 'updated', record: entry }).map(issue => issue.code))
      if (value.useStatus !== 'user-governance' || entry.workspaceId !== value.binding.workspaceId) issues.push('human-entry-kind')
    }
  }
  if (value.kind === 'human-research-overlay') {
    issues.push(...treeOverlayRpcIssues(value.result).map(issue => issue.code))
    if (value.result.workspaceId !== value.binding.workspaceId) issues.push('human-overlay-owner')
    if (value.result.items.some(item => !humanTypes.includes(item.recordType))) issues.push('human-overlay-type')
    const ids = new Set(value.result.items.map(item => item.recordId)), versions = value.recordVersions ?? []
    if (new Set(versions.map(item => item.recordId)).size !== versions.length || versions.some(item => !ids.has(item.recordId))) issues.push('human-overlay-version')
  }
  if (value.kind === 'human-research-focus') {
    issues.push(...productResearchIssues(value.focus))
    if (value.focus.conversationId !== value.binding.conversationId) issues.push('human-focus-owner')
  }
  return issues
}
