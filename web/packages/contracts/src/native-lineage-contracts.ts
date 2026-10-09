import type { NativeConfiguration } from './native-control-contracts.js'
import type { ProductBinding } from './product-control-contracts.js'

/** Complete immutable file-prefix identity, deliberately distinct from the selected branch. */
export interface NativeFileSeal {
  version: 1
  sessionId: string
  transcriptHash: string
  byteLength: number
  entryCount: number
  tailEntryId: string | null
}

/** Selected native context is independently persisted and restored before extension factories. */
export interface NativeSelectedHead {
  version: 1
  fileSeal: NativeFileSeal
  selectedLeafEntryId: string | null
  /** SHA-256 of the canonical public SDK context for this exact selected parent chain. */
  contextHash: string
}

export type NativeLineageAction =
  | { kind: 'navigate', targetEntryId: string, summarize: boolean, instructions: string, replaceInstructions: boolean, label: string | null }
  | { kind: 'fork', targetEntryId: string, position: 'before' | 'at' }
export interface NativeLineageApply { operationId: string, requestHash: string, expectedHead: NativeSelectedHead, action: NativeLineageAction }
interface LineageProofBase {
  operationId: string
  requestHash: string
  beforeHead: NativeSelectedHead
  sourceAfterHead: NativeSelectedHead
  targetHead: NativeSelectedHead
  intentEntryId: string
  sourceMarkerEntryId: string
  targetMarkerEntryId: string
  sourceConfiguration: NativeConfiguration
  configuration: NativeConfiguration
}
export interface NativeNavigationProof extends LineageProofBase {
  kind: 'native-navigation-proof'
  action: Extract<NativeLineageAction, { kind: 'navigate' }>
  landingEntryId: string | null
  summary: { entryId: string, fromEntryId: string | null, summaryHash: string } | null
}
export interface NativeForkProof extends LineageProofBase {
  kind: 'native-fork-proof'
  action: Extract<NativeLineageAction, { kind: 'fork' }>
  /** Verified sufficient source prefix, not a guessed timestamp for SDK copying. */
  forkBasisSeal: NativeFileSeal
  inheritedEntryCount: number
  /** Canonical exact SDK non-label inheritance plus resolved/rechained labels. */
  inheritanceHash: string
}
export type NativeLineageProof = NativeNavigationProof | NativeForkProof
export interface NativeLineageFailureProof {
  kind: 'native-lineage-failure'
  operationId: string
  requestHash: string
  action: NativeLineageAction
  beforeHead: NativeSelectedHead
  afterHead: NativeSelectedHead
  intentEntryId: string
  markerEntryId: string
  reason: 'cancelled' | 'sdk-rejected'
}
export type NativeLineageOutcome =
  | { status: 'applied' | 'replayed', proof: NativeLineageProof }
  | { status: 'not-applied', failureProof: NativeLineageFailureProof }

export interface ProductLineageCommand {
  schemaVersion: 1
  kind: 'lineage-command'
  conversationId: string
  expectedBindingId: string
  expectedGeneration: number
  runtimeSessionId: string
  approvalId: string
  expectedApprovalVersion: number
  expectedHead: NativeSelectedHead
  idempotencyKey: string
  action: NativeLineageAction
}
export type ProductLineageState = 'accepted' | 'applying' | 'handoff' | 'succeeded' | 'failed' | 'outcome-unknown'
export interface ProductLineageOperation {
  schemaVersion: 1
  kind: 'lineage-operation'
  operationId: string
  sourceBinding: ProductBinding
  requestHash: string
  request: ProductLineageCommand
  state: ProductLineageState
  version: number
  createdAt: string
  updatedAt: string
  result: { proof: NativeLineageProof, targetBinding: ProductBinding } | null
  failureProof?: NativeLineageFailureProof
  errorCode: 'stale-state' | 'not-authorized' | 'invalid-action' | 'execution-interrupted' | null
}
export interface ProductLineageInspection {
  schemaVersion: 1
  kind: 'lineage-inspection'
  binding: ProductBinding
  resource: { approvalId: string, version: number, manifestHash: string }
  head: NativeSelectedHead | null
  busy: boolean
  queued: number
  operations: ProductLineageOperation[]
  truncated: boolean
}
/** Public origin identity only. The host resolves and reauthorizes the immutable lineage. */
export interface NativeHistoryOrigin {
  conversationId: string
  bindingId: string
  generation: number
  runtimeSessionId: string
  entryId: string
}
export interface ProductNativeTreeRequest {
  schemaVersion: 1
  kind: 'native-tree-request'
  expectedGeneration: number
  view: 'messages' | 'all'
  cursor: string | null
}
export interface ProductNativeTreeEntry {
  entryId: string
  parentId: string | null
  type: 'user' | 'assistant' | 'tool-result' | 'compaction' | 'branch-summary' | 'label' | 'metadata' | 'custom-message'
  preview: string
  label: string | null
  depth: number
  onSelectedBranch: boolean
  canNavigate: boolean
  canForkBefore: boolean
  canForkAt: boolean
  origin: NativeHistoryOrigin | null
}
export interface ProductNativeTreePage {
  schemaVersion: 1
  kind: 'native-tree-page'
  binding: ProductBinding
  head: NativeSelectedHead
  view: 'messages' | 'all'
  entries: ProductNativeTreeEntry[]
  nextCursor: string | null
}
export type NativeLineageValue = NativeLineageAction | NativeLineageApply | NativeLineageOutcome | ProductLineageCommand
  | ProductLineageOperation | ProductLineageInspection | ProductNativeTreeRequest | ProductNativeTreePage

export function nativeFileSealEqual(left: NativeFileSeal, right: NativeFileSeal): boolean {
  return left.version === right.version && left.sessionId === right.sessionId && left.transcriptHash === right.transcriptHash
    && left.byteLength === right.byteLength && left.entryCount === right.entryCount && left.tailEntryId === right.tailEntryId
}
export function nativeSelectedHeadEqual(left: NativeSelectedHead, right: NativeSelectedHead): boolean {
  return left.version === right.version && nativeFileSealEqual(left.fileSeal, right.fileSeal)
    && left.selectedLeafEntryId === right.selectedLeafEntryId && left.contextHash === right.contextHash
}
export function nativeLineageActionEqual(left: NativeLineageAction, right: NativeLineageAction): boolean {
  return left.kind === 'fork' ? right.kind === left.kind && left.targetEntryId === right.targetEntryId && left.position === right.position
    : right.kind === left.kind && left.targetEntryId === right.targetEntryId && left.summarize === right.summarize && left.instructions === right.instructions
      && left.replaceInstructions === right.replaceInstructions && left.label === right.label
}
const configurationEqual = (left: NativeConfiguration, right: NativeConfiguration) => left.model.provider === right.model.provider && left.model.id === right.model.id
  && left.thinkingLevel === right.thinkingLevel && left.steeringMode === right.steeringMode && left.followUpMode === right.followUpMode
function fileIssues(value: NativeFileSeal): boolean { return (value.entryCount === 0) !== (value.tailEntryId === null) }
function headIssues(value: NativeSelectedHead): boolean { return fileIssues(value.fileSeal) || value.fileSeal.entryCount === 0 && value.selectedLeafEntryId !== null }
export function nativeSelectedHeadIssues(value: NativeSelectedHead): string[] { return headIssues(value) ? ['selected-head'] : [] }
function proofIssues(value: NativeLineageProof): boolean {
  const before = value.beforeHead.fileSeal, source = value.sourceAfterHead.fileSeal, target = value.targetHead.fileSeal
  if (headIssues(value.beforeHead) || headIssues(value.sourceAfterHead) || headIssues(value.targetHead) || source.sessionId !== before.sessionId
    || source.byteLength <= before.byteLength || source.entryCount < before.entryCount + 2 || value.sourceMarkerEntryId === value.intentEntryId
    || value.sourceAfterHead.selectedLeafEntryId !== value.sourceMarkerEntryId || source.tailEntryId !== value.sourceMarkerEntryId
    || value.targetHead.selectedLeafEntryId !== value.targetMarkerEntryId || target.tailEntryId !== value.targetMarkerEntryId) return true
  if (value.kind === 'native-navigation-proof') return value.action.kind !== 'navigate' || !nativeSelectedHeadEqual(value.sourceAfterHead, value.targetHead)
    || value.sourceMarkerEntryId !== value.targetMarkerEntryId || !configurationEqual(value.sourceConfiguration, value.configuration)
    || value.summary !== null && (!value.action.summarize || [value.intentEntryId, value.targetMarkerEntryId].includes(value.summary.entryId))
  const basis = value.forkBasisSeal
  return value.action.kind !== 'fork' || target.sessionId === before.sessionId || fileIssues(basis) || basis.sessionId !== before.sessionId
    || basis.entryCount < before.entryCount + 1 || basis.entryCount >= source.entryCount || basis.byteLength <= before.byteLength || basis.byteLength >= source.byteLength
    || value.inheritedEntryCount >= target.entryCount
}
function failureIssues(value: NativeLineageFailureProof): boolean {
  const before = value.beforeHead.fileSeal, after = value.afterHead.fileSeal
  return headIssues(value.beforeHead) || headIssues(value.afterHead) || before.sessionId !== after.sessionId || after.entryCount !== before.entryCount + 2
    || after.byteLength <= before.byteLength || value.beforeHead.contextHash !== value.afterHead.contextHash
    || value.afterHead.selectedLeafEntryId !== value.markerEntryId || after.tailEntryId !== value.markerEntryId || value.markerEntryId === value.intentEntryId
}
/** Shape validation precedes semantic checks; actual bytes/SDK ancestry remain a host verifier responsibility. */
export function nativeLineageIssues(value: NativeLineageValue): string[] {
  const issues: string[] = []
  if ('expectedHead' in value && headIssues(value.expectedHead)) issues.push('selected-head')
  if ('status' in value && (value.status === 'not-applied' ? failureIssues(value.failureProof) : proofIssues(value.proof))) issues.push('lineage-proof')
  if ('kind' in value && value.kind === 'lineage-command' && value.expectedHead.fileSeal.sessionId !== value.runtimeSessionId) issues.push('lineage-session')
  if ('kind' in value && value.kind === 'lineage-operation') {
    const request = value.request, source = value.sourceBinding
    if (nativeLineageIssues(request).length || source.conversationId !== request.conversationId || source.bindingId !== request.expectedBindingId
      || source.generation !== request.expectedGeneration || source.runtimeSessionId !== request.runtimeSessionId) issues.push('lineage-owner')
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) issues.push('lineage-time')
    if (value.state === 'succeeded' ? value.result === null || value.errorCode !== null || value.failureProof !== undefined
      : value.result !== null || (value.state === 'failed' || value.state === 'outcome-unknown' ? value.errorCode === null : value.errorCode !== null)) issues.push('lineage-state')
    const result = value.result
    if (result) {
      const proof = result.proof, target = result.targetBinding
      if (proofIssues(proof) || proof.operationId !== value.operationId || proof.requestHash !== value.requestHash
        || !nativeLineageActionEqual(proof.action, request.action) || !nativeSelectedHeadEqual(proof.beforeHead, request.expectedHead)
        || target.ownerActorId !== source.ownerActorId || target.workspaceId !== source.workspaceId || target.bindingId === source.bindingId
        || target.runtimeSessionId !== proof.targetHead.fileSeal.sessionId || target.branchEntryId !== proof.targetHead.selectedLeafEntryId) issues.push('lineage-result')
      if (request.action.kind === 'navigate' ? target.conversationId !== source.conversationId || target.runtimeSessionId !== source.runtimeSessionId
        || target.generation !== source.generation + 1 || target.version !== source.version + 1
        : target.conversationId === source.conversationId || target.runtimeSessionId === source.runtimeSessionId || target.generation !== 1 || target.version !== 1) issues.push('lineage-target')
    }
    if (value.failureProof) {
      const proof = value.failureProof
      if (value.state !== 'failed' || value.errorCode !== 'execution-interrupted' || failureIssues(proof) || proof.operationId !== value.operationId
        || proof.requestHash !== value.requestHash || !nativeLineageActionEqual(proof.action, request.action) || !nativeSelectedHeadEqual(proof.beforeHead, request.expectedHead)) issues.push('lineage-failure')
    }
  }
  if ('kind' in value && value.kind === 'lineage-inspection') {
    if (value.head && (headIssues(value.head) || value.head.fileSeal.sessionId !== value.binding.runtimeSessionId)) issues.push('lineage-inspection-head')
    if (new Set(value.operations.map(operation => operation.operationId)).size !== value.operations.length || value.operations.some(operation => nativeLineageIssues(operation).length
      || operation.sourceBinding.conversationId !== value.binding.conversationId || operation.sourceBinding.workspaceId !== value.binding.workspaceId || operation.sourceBinding.ownerActorId !== value.binding.ownerActorId)) issues.push('lineage-inspection-operations')
  }
  if ('kind' in value && value.kind === 'native-tree-page') {
    if (headIssues(value.head) || value.head.fileSeal.sessionId !== value.binding.runtimeSessionId || new Set(value.entries.map(entry => entry.entryId)).size !== value.entries.length) issues.push('native-tree-head')
    if (value.entries.some(entry => entry.parentId === entry.entryId || entry.canForkBefore && entry.type !== 'user'
      || value.view === 'messages' && !['user', 'assistant'].includes(entry.type) || entry.origin !== null && (!['user', 'assistant'].includes(entry.type) || entry.origin.entryId !== entry.entryId))) issues.push('native-tree-entry')
    if (value.entries.reduce((sum, entry) => sum + entry.preview.length + (entry.label?.length ?? 0), 0) > 131072) issues.push('native-tree-budget')
  }
  return issues
}
