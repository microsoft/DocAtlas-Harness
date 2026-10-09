import type { ProductBinding } from './product-control-contracts.js'

export type NativeThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type NativeQueueMode = 'all' | 'one-at-a-time'
/** Public native-prefix identity; no filename, cwd, credential or raw transcript. */
export interface NativeControlHead {
  version: 1
  sessionId: string
  transcriptHash: string
  byteLength: number
  entryCount: number
  leafEntryId: string | null
}
export interface NativeConfiguration {
  model: { provider: string, id: string }
  thinkingLevel: NativeThinkingLevel
  steeringMode: NativeQueueMode
  followUpMode: NativeQueueMode
}
export interface NativeModelOption {
  provider: string
  id: string
  name: string
  thinkingLevels: NativeThinkingLevel[]
  contextWindow: number
  maxTokens: number
}
export type NativeControlAction =
  | { kind: 'set-model', provider: string, modelId: string }
  | { kind: 'set-thinking', level: NativeThinkingLevel }
  | { kind: 'set-queue-mode', queue: 'steering' | 'follow-up', mode: NativeQueueMode }
  | { kind: 'compact', instructions: string }
export interface NativeRuntimeState {
  head: NativeControlHead
  configuration: NativeConfiguration
  models: NativeModelOption[]
  thinkingLevels: NativeThinkingLevel[]
  busy: boolean
  nativeQueue: { steering: number, followUp: number }
  /** Absent on older workers: do not infer that manual compaction is available. */
  compaction?: { canCompact: boolean }
}
/** Host-to-worker call; inherited pipes and host verification provide authority, not these fields. */
export interface NativeControlApply {
  operationId: string
  requestHash: string
  expectedHead: NativeControlHead
  action: NativeControlAction
}
export interface NativeControlProof {
  operationId: string
  requestHash: string
  action: NativeControlAction
  beforeHead: NativeControlHead
  afterHead: NativeControlHead
  intentEntryId: string
  markerEntryId: string
  configuration: NativeConfiguration
  /** Required for compact only. Summary text is native context, never browser Evidence. */
  compaction?: { entryId: string, firstKeptEntryId: string, tokensBefore: number, summaryHash: string }
}
export interface NativeCompactFailureProof {
  operationId: string
  requestHash: string
  action: Extract<NativeControlAction, { kind: 'compact' }>
  beforeHead: NativeControlHead
  afterHead: NativeControlHead
  intentEntryId: string
  markerEntryId: string
  reason: 'cancelled' | 'sdk-rejected'
}
export type NativeControlOutcome =
  | { status: 'applied' | 'replayed', proof: NativeControlProof }
  | { status: 'not-applied', failureProof: NativeCompactFailureProof }
export interface ProductNativeCommand {
  schemaVersion: 1
  kind: 'native-command'
  conversationId: string
  expectedBindingId: string
  expectedGeneration: number
  runtimeSessionId: string
  approvalId: string
  expectedApprovalVersion: number
  expectedHead: NativeControlHead
  idempotencyKey: string
  action: NativeControlAction
}
export type NativeOperationState = 'accepted' | 'applying' | 'succeeded' | 'failed' | 'outcome-unknown'
export interface ProductNativeOperation {
  schemaVersion: 1
  kind: 'native-operation'
  operationId: string
  conversationId: string
  bindingId: string
  generation: number
  runtimeSessionId: string
  requestHash: string
  request: ProductNativeCommand
  state: NativeOperationState
  version: number
  createdAt: string
  updatedAt: string
  result: NativeControlProof | null
  errorCode: 'stale-state' | 'not-authorized' | 'invalid-action' | 'execution-interrupted' | null
  /** Optional additive terminal proof; successful result keeps its original meaning. */
  failureProof?: NativeCompactFailureProof
}
export interface ProductNativeInspection {
  schemaVersion: 1
  kind: 'native-inspection'
  binding: ProductBinding
  resource: { approvalId: string, version: number, manifestHash: string }
  models: NativeModelOption[]
  state: NativeRuntimeState | null
  busy: boolean
  queued: number
  operations: ProductNativeOperation[]
  truncated: boolean
}
export type NativeControlValue = NativeControlAction | NativeRuntimeState | NativeControlApply | NativeControlOutcome | ProductNativeCommand | ProductNativeOperation | ProductNativeInspection

export function nativeHeadEqual(left: NativeControlHead, right: NativeControlHead): boolean {
  return left.version === right.version && left.sessionId === right.sessionId && left.transcriptHash === right.transcriptHash
    && left.byteLength === right.byteLength && left.entryCount === right.entryCount && left.leafEntryId === right.leafEntryId
}
export function nativeActionEqual(left: NativeControlAction, right: NativeControlAction): boolean {
  if (left.kind === 'set-model') return right.kind === left.kind && left.provider === right.provider && left.modelId === right.modelId
  if (left.kind === 'set-thinking') return right.kind === left.kind && left.level === right.level
  if (left.kind === 'compact') return right.kind === left.kind && left.instructions === right.instructions
  return right.kind === left.kind && left.queue === right.queue && left.mode === right.mode
}
function proofIssues(proof: NativeControlProof): boolean {
  return proof.beforeHead.sessionId !== proof.afterHead.sessionId || proof.afterHead.byteLength <= proof.beforeHead.byteLength
    || proof.afterHead.entryCount < proof.beforeHead.entryCount + 2 || proof.afterHead.leafEntryId !== proof.markerEntryId
    || proof.intentEntryId === proof.markerEntryId || proof.beforeHead.leafEntryId === proof.intentEntryId
    || proof.action.kind === 'set-model' && (proof.configuration.model.id !== proof.action.modelId || proof.configuration.model.provider !== proof.action.provider)
    || proof.action.kind === 'set-queue-mode' && proof.configuration[proof.action.queue === 'steering' ? 'steeringMode' : 'followUpMode'] !== proof.action.mode
    || (proof.action.kind === 'compact' ? !proof.compaction || proof.afterHead.entryCount < proof.beforeHead.entryCount + 3
      || [proof.intentEntryId, proof.markerEntryId, proof.beforeHead.leafEntryId].includes(proof.compaction.entryId)
      || [proof.intentEntryId, proof.markerEntryId, proof.compaction.entryId].includes(proof.compaction.firstKeptEntryId) : proof.compaction !== undefined)
}
function failureProofIssues(proof: NativeCompactFailureProof): boolean {
  return proof.action.kind !== 'compact' || proof.beforeHead.sessionId !== proof.afterHead.sessionId
    || proof.afterHead.byteLength <= proof.beforeHead.byteLength || proof.afterHead.entryCount !== proof.beforeHead.entryCount + 2
    || proof.afterHead.leafEntryId !== proof.markerEntryId || proof.intentEntryId === proof.markerEntryId
    || proof.beforeHead.leafEntryId === proof.intentEntryId || proof.beforeHead.leafEntryId === proof.markerEntryId
}
function modelsUnique(models: NativeModelOption[]): boolean { return new Set(models.map(model => JSON.stringify([model.provider, model.id]))).size === models.length }
export function nativeControlIssues(value: NativeControlValue): string[] {
  const issues: string[] = []
  if ('status' in value && (value.status === 'not-applied' ? failureProofIssues(value.failureProof) : proofIssues(value.proof))) issues.push('native-proof')
  if ('head' in value) {
    const model = value.models.find(item => item.provider === value.configuration.model.provider && item.id === value.configuration.model.id)
    if (!modelsUnique(value.models) || !model || !model.thinkingLevels.includes(value.configuration.thinkingLevel)
      || model.thinkingLevels.length !== value.thinkingLevels.length || model.thinkingLevels.some(level => !value.thinkingLevels.includes(level))) issues.push('native-configuration')
  }
  if ('kind' in value && value.kind === 'native-command') {
    if (value.expectedHead.sessionId !== value.runtimeSessionId) issues.push('native-session')
  }
  if ('kind' in value && value.kind === 'native-operation') {
    const input = value.request
    if (value.conversationId !== input.conversationId || value.bindingId !== input.expectedBindingId || value.generation !== input.expectedGeneration
      || value.runtimeSessionId !== input.runtimeSessionId || input.expectedHead.sessionId !== input.runtimeSessionId) issues.push('operation-binding')
    if (value.state === 'succeeded' ? !value.result || value.errorCode !== null : value.result !== null
      || (value.state === 'failed' || value.state === 'outcome-unknown' ? value.errorCode === null : value.errorCode !== null)) issues.push('operation-state')
    if (value.result && (value.result.operationId !== value.operationId || value.result.requestHash !== value.requestHash
      || value.result.beforeHead.sessionId !== value.runtimeSessionId || value.result.afterHead.sessionId !== value.runtimeSessionId
      || !nativeActionEqual(value.result.action, input.action) || !nativeHeadEqual(value.result.beforeHead, input.expectedHead)
      || proofIssues(value.result))) issues.push('operation-proof')
    if (value.failureProof && (value.state !== 'failed' || value.result !== null || value.errorCode !== 'execution-interrupted'
      || value.failureProof.operationId !== value.operationId || value.failureProof.requestHash !== value.requestHash
      || !nativeActionEqual(value.failureProof.action, input.action) || !nativeHeadEqual(value.failureProof.beforeHead, input.expectedHead)
      || failureProofIssues(value.failureProof))) issues.push('operation-failure-proof')
  }
  if ('kind' in value && value.kind === 'native-inspection') {
    if (!modelsUnique(value.models)) issues.push('native-model-catalog')
    if (value.state && (value.state.head.sessionId !== value.binding.runtimeSessionId || nativeControlIssues(value.state).length
      || value.models.length !== value.state.models.length || value.state.models.some(model => !value.models.some(item => item.provider === model.provider && item.id === model.id
        && item.name === model.name && item.contextWindow === model.contextWindow && item.maxTokens === model.maxTokens
        && item.thinkingLevels.length === model.thinkingLevels.length && item.thinkingLevels.every(level => model.thinkingLevels.includes(level)))))) issues.push('native-state-binding')
    if (new Set(value.operations.map(operation => operation.operationId)).size !== value.operations.length) issues.push('native-operation-duplicate')
    if (value.operations.some(operation => operation.conversationId !== value.binding.conversationId || operation.bindingId !== value.binding.bindingId || operation.generation !== value.binding.generation
      || operation.runtimeSessionId !== value.binding.runtimeSessionId || nativeControlIssues(operation).length)) issues.push('native-operation-scope')
  }
  return issues
}
