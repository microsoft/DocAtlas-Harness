import { documentLocatorIssues } from './m0-contracts.js'
import type {
  ActorRef,
  ContractIssue,
  ContractIssueCode,
  DocumentLocator,
  DocumentSelector,
  EvidenceAtom,
  OpaqueId,
  Sha256,
} from './m0-contracts.js'

export const MAX_SELECTION_CONTEXT_BYTES = 64 * 1024
export const DOCATLAS_SELECTION_MARKER_PREFIX = '[[docatlas.selection.v1:'
const SELECTION_CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/

export function formatSelectionMarker(selectionContextId: string): string {
  if (!SELECTION_CONTEXT_ID_PATTERN.test(selectionContextId)) {
    throw new Error('invalid DocAtlas selection context id')
  }
  return `${DOCATLAS_SELECTION_MARKER_PREFIX}${selectionContextId}]]`
}

export function parseSelectionMarkers(text: string): {
  ids: string[]
  text: string
  malformed: boolean
} {
  const ids: string[] = []
  const marker = /\[\[docatlas\.selection\.v1:([A-Za-z0-9][A-Za-z0-9._:~-]{0,127})\]\]/g
  const stripped = text.replace(marker, (_match, id: string) => {
    ids.push(id)
    return ''
  })
  return {
    ids,
    text: stripped,
    malformed: stripped.includes(DOCATLAS_SELECTION_MARKER_PREFIX),
  }
}

export type SelectionKind = 'text' | 'table' | 'figure' | 'page' | 'multi-range'
export type SelectionIntent = 'ask' | 'explain' | 'compare' | 'challenge' | 'translate' | 'calculate'
export type SelectionSourcePolicy = 'focus' | 'exclusive'

export interface SelectionContent {
  mediaType: string
  text?: string
  assetId?: OpaqueId
  contentHash: Sha256
  actualLength: number
  lengthUnit: 'unicode-scalar' | 'byte'
  completeness: 'partial' | 'complete'
  truncated: boolean
}

export interface SelectionContextItem {
  selectionId: OpaqueId
  kind: SelectionKind
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  representationContentHash: Sha256
  locators: DocumentLocator[]
  content: SelectionContent
  createdAt: string
}

export interface SelectionContext {
  schemaVersion: 1
  selectionContextId: OpaqueId
  sessionId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  scopeVersionId: OpaqueId
  intent: SelectionIntent
  sourcePolicy: SelectionSourcePolicy
  retention: 'one-shot' | 'investigation-focus'
  selections: SelectionContextItem[]
  createdBy: ActorRef
  createdAt: string
}

export interface SelectionSourceProposal {
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  representationContentHash: Sha256
}

export interface SelectionRangeProposal {
  physicalPage: number
  selectors: DocumentSelector[]
  selectedText?: string
  assetId?: OpaqueId
  contentHash: Sha256
}

export interface SelectionProposal {
  proposalId: OpaqueId
  kind: SelectionKind
  source: SelectionSourceProposal
  ranges: SelectionRangeProposal[]
}

export interface SelectionPreview {
  selectionId: OpaqueId
  kind: SelectionKind
  documentId: OpaqueId
  revisionId: OpaqueId
  physicalPageStart: number
  physicalPageEnd: number
  label: string
  text?: string
  truncated: boolean
}

export interface SelectionStageRequest {
  schemaVersion: 1
  requestType: 'selection-stage'
  sessionId: OpaqueId
  scopeVersionId: OpaqueId
  intent: SelectionIntent
  sourcePolicy: SelectionSourcePolicy
  selections: SelectionProposal[]
}

export interface SelectionStageResult {
  schemaVersion: 1
  resultType: 'selection-staged'
  selectionContextId: OpaqueId
  nonce: string
  expiresAt: string
  previews: SelectionPreview[]
  intent?: SelectionIntent
  sourcePolicy?: SelectionSourcePolicy
}

export interface SelectionPrepareRequest {
  schemaVersion: 1
  requestType: 'selection-prepare'
  sessionId: OpaqueId
  selectionContextId: OpaqueId
}

export interface SelectionPrepareResult {
  schemaVersion: 1
  resultType: 'selection-prepared'
  selectionContextId: OpaqueId
  marker: string
  expiresAt: string
  previews: SelectionPreview[]
}

export interface SelectionStatusRequest {
  schemaVersion: 1
  requestType: 'selection-status'
  sessionId: OpaqueId
  selectionContextId: OpaqueId
}

export interface SelectionStatusResult {
  schemaVersion: 1
  resultType: 'selection-status'
  selectionContextId: OpaqueId
  status: 'staged' | 'claimed' | 'consumed' | 'cancelled' | 'expired' | 'stale'
  expiresAt?: string
  previews?: SelectionPreview[]
  intent?: SelectionIntent
  sourcePolicy?: SelectionSourcePolicy
}

export interface SelectionCancelRequest {
  schemaVersion: 1
  requestType: 'selection-cancel'
  sessionId: OpaqueId
  selectionContextId: OpaqueId
  nonce: string
}

export interface SelectionCancelResult {
  schemaVersion: 1
  resultType: 'selection-cancelled'
  selectionContextId: OpaqueId
  status: 'cancelled' | 'already-consumed'
}

export type SelectionActionKind =
  | 'save-evidence'
  | 'create-note'
  | 'open-question'
  | 'propose-claim'

interface SelectionActionRequestBase {
  schemaVersion: 1
  requestType: 'selection-action'
  sessionId: OpaqueId
  selectionContextId: OpaqueId
  idempotencyKey: OpaqueId
  nonce: string
}

export type SelectionActionRequest = SelectionActionRequestBase & (
  | { action: 'save-evidence' }
  | { action: 'create-note', noteKind: 'commentary' | 'hypothesis' | 'scratch', body: string }
  | { action: 'open-question', question: string }
  | { action: 'propose-claim', statement: string, relation: 'support' | 'refute' | 'qualify' }
)

interface SelectionDomainRecordBase {
  schemaVersion: 1
  workspaceId: OpaqueId
  investigationId: OpaqueId
  selectionContextId: OpaqueId
  evidenceIds: OpaqueId[]
  locatorIds: OpaqueId[]
  createdBy: ActorRef
  createdAt: string
}

export interface EvidenceBookmarkRecord extends SelectionDomainRecordBase {
  recordType: 'evidence-bookmark'
  bookmarkId: OpaqueId
  status: 'active'
}

export interface ResearchNoteRecord extends SelectionDomainRecordBase {
  recordType: 'research-note'
  noteId: OpaqueId
  version: 1
  noteKind: 'commentary' | 'hypothesis' | 'scratch'
  body: string
  status: 'active'
}

export interface OpenQuestionRecord extends SelectionDomainRecordBase {
  recordType: 'open-question'
  questionId: OpaqueId
  version: 1
  question: string
  status: 'open'
}

export interface ClaimProposalRecord extends SelectionDomainRecordBase {
  recordType: 'claim-proposal'
  claimProposalId: OpaqueId
  statement: string
  relation: 'support' | 'refute' | 'qualify'
  assertedBy: ActorRef
  status: 'proposed'
}

export type SelectionDomainRecord =
  | EvidenceBookmarkRecord
  | ResearchNoteRecord
  | OpenQuestionRecord
  | ClaimProposalRecord

export interface SelectionActionResult {
  schemaVersion: 1
  resultType: 'selection-action-recorded'
  sessionId: OpaqueId
  selectionContextId: OpaqueId
  actionId: OpaqueId
  action: SelectionActionKind
  status: 'created' | 'replayed'
  locators: DocumentLocator[]
  evidence: EvidenceAtom[]
  record: SelectionDomainRecord
}

export type SelectionRpcRequest =
  | SelectionStageRequest
  | SelectionPrepareRequest
  | SelectionStatusRequest
  | SelectionCancelRequest
  | SelectionActionRequest

export type SelectionRpcResult =
  | SelectionStageResult
  | SelectionPrepareResult
  | SelectionStatusResult
  | SelectionCancelResult
  | SelectionActionResult

export function selectionContextIssues(value: SelectionContext): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SELECTION_CONTEXT_BYTES) {
    add('selection-context-size', '/', 'selection context exceeds its aggregate byte limit')
  }
  if (value.createdBy.kind !== 'user') {
    add('selection-actor-not-user', '/createdBy/kind', 'direct selection context must be user-created')
  }
  const selectionIds = new Set<string>()
  for (const [index, selection] of value.selections.entries()) {
    if (selectionIds.has(selection.selectionId)) {
      add('selection-duplicate-id', `/selections/${index}/selectionId`, 'selection ids must be unique')
    }
    selectionIds.add(selection.selectionId)
    const locatorIds = new Set<string>()
    for (const [locatorIndex, locator] of selection.locators.entries()) {
      for (const issue of documentLocatorIssues(locator)) {
        add(
          issue.code,
          `/selections/${index}/locators/${locatorIndex}${issue.path === '/' ? '' : issue.path}`,
          issue.message,
        )
      }
      if (locatorIds.has(locator.locatorId)) {
        add('selection-duplicate-locator', `/selections/${index}/locators/${locatorIndex}/locatorId`, 'locator ids must be unique within a selection')
      }
      locatorIds.add(locator.locatorId)
      if (locator.documentId !== selection.documentId
        || locator.revisionId !== selection.revisionId
        || locator.representationId !== selection.representationId
        || locator.representationContentHash !== selection.representationContentHash) {
        add('selection-locator-mismatch', `/selections/${index}/locators/${locatorIndex}`, 'selection and locator identities must match exactly')
      }
    }
    if ((selection.content.completeness === 'partial') !== selection.content.truncated) {
      add('selection-content-completeness', `/selections/${index}/content`, 'partial and truncated selection content must agree')
    }
    if (selection.content.text !== undefined
      && selection.content.completeness === 'complete'
      && selection.content.lengthUnit === 'unicode-scalar'
      && [...selection.content.text].length !== selection.content.actualLength) {
      add('selection-content-length', `/selections/${index}/content/actualLength`, 'complete text length must match its unicode scalar count')
    }
    if (!selectionKindMatches(selection)) {
      add('selection-kind-selector-mismatch', `/selections/${index}`, 'selection kind is incompatible with its locator selectors or content')
    }
  }
  return issues
}

export function selectionRpcIssues(value: SelectionRpcRequest | SelectionRpcResult): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('requestType' in value && value.requestType === 'selection-stage') {
    const ids = new Set<string>()
    for (const [index, proposal] of value.selections.entries()) {
      if (ids.has(proposal.proposalId)) {
        add('selection-proposal-duplicate', `/selections/${index}/proposalId`, 'selection proposal ids must be unique')
      }
      ids.add(proposal.proposalId)
      if ((proposal.kind === 'multi-range' && proposal.ranges.length < 2)
        || (proposal.kind !== 'multi-range' && proposal.ranges.length !== 1)) {
        add('selection-range-cardinality', `/selections/${index}/ranges`, 'multi-range requires several ranges and every other kind requires exactly one')
      }
      if (!proposalKindMatches(proposal)) {
        add('selection-proposal-kind-mismatch', `/selections/${index}`, 'selection proposal kind is incompatible with its selectors or asset')
      }
    }
  }
  if ('previews' in value && value.previews !== undefined) {
    for (const [index, preview] of value.previews.entries()) {
      if (preview.physicalPageStart > preview.physicalPageEnd) {
        add('selection-preview-page-order', `/previews/${index}/physicalPageStart`, 'preview page start must not exceed page end')
      }
    }
  }
  if ('resultType' in value && value.resultType === 'selection-action-recorded') {
    const recordType = {
      'save-evidence': 'evidence-bookmark',
      'create-note': 'research-note',
      'open-question': 'open-question',
      'propose-claim': 'claim-proposal',
    }[value.action]
    if (value.record.recordType !== recordType
      || value.record.selectionContextId !== value.selectionContextId
      || value.record.workspaceId === ''
      || value.record.evidenceIds.join('\0') !== value.evidence.map(item => item.evidenceId).join('\0')
      || value.record.locatorIds.join('\0') !== value.locators.map(item => item.locatorId).join('\0')) {
      add('selection-action-record-mismatch', '/record', 'selection action record does not match its action/evidence projection')
    }
    const locators = new Map(value.locators.map(locator => [locator.locatorId, locator]))
    if (locators.size !== value.locators.length
      || new Set(value.evidence.map(item => item.evidenceId)).size !== value.evidence.length) {
      add('selection-action-record-mismatch', '/evidence', 'selection action Locator and Evidence ids must be unique')
    }
    for (const [index, evidence] of value.evidence.entries()) {
      const locator = locators.get(evidence.locatorId)
      if (locator === undefined
        || locator.documentId !== evidence.documentId
        || locator.revisionId !== evidence.revisionId
        || locator.representationId !== evidence.representationId
        || evidence.provenanceActivityId !== value.actionId
        || evidence.createdBy.kind !== value.record.createdBy.kind
        || evidence.createdBy.actorId !== value.record.createdBy.actorId) {
        add('selection-action-evidence-identity', `/evidence/${index}`, 'selection evidence must match one returned Locator identity')
      }
    }
    if (value.record.recordType === 'claim-proposal'
      && (value.record.assertedBy.kind !== value.record.createdBy.kind
        || value.record.assertedBy.actorId !== value.record.createdBy.actorId)) {
      add('selection-action-record-mismatch', '/record/assertedBy', 'claim proposal assertion actor must be the explicit record author')
    }
  }
  return issues
}

function proposalKindMatches(proposal: SelectionProposal): boolean {
  if (proposal.kind === 'multi-range') return proposal.ranges.length > 1
  const range = proposal.ranges[0]
  if (range === undefined) return false
  const types = new Set<string>(range.selectors.map(selector => selector.type))
  switch (proposal.kind) {
    case 'text': return ['block', 'text-quote', 'text-position'].some(type => types.has(type))
    case 'table': return types.has('table-cell')
    case 'figure': return types.has('figure') && range.assetId !== undefined
    case 'page': return types.has('bbox')
  }
}

function selectionKindMatches(selection: SelectionContextItem): boolean {
  const types = new Set<string>(
    selection.locators.flatMap(locator => locator.selectors.map(selector => selector.type)),
  )
  switch (selection.kind) {
    case 'text': return ['block', 'text-quote', 'text-position'].some(type => types.has(type))
    case 'table': return types.has('table-cell')
    case 'figure': return types.has('figure') && selection.content.assetId !== undefined
    case 'page': return types.has('bbox')
    case 'multi-range': return selection.locators.length > 1
  }
}
