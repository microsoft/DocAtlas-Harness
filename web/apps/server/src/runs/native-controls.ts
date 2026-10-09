import { createHash } from 'node:crypto'
import { nativeControlIssues, nativeHeadEqual, type NativeControlApply, type NativeControlOutcome, type ProductBinding, type ProductNativeCommand,
  type ProductNativeInspection, type ProductNativeOperation } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { findNativeControlOutcome, nativeModelOptions } from '@docatlas/runtime-pi/worker'
import type { IsolatedPiWorker } from '../execution/pi-worker.js'
import { ControlStore, ControlStoreError, type ProductActor } from '../storage/control-store.js'
import type { NativeOperationStore } from '../storage/native-operation-store.js'
import type { ResourceStore } from '../storage/resource-store.js'
import { SubmissionCoordinator, type NativeWorkContext } from './submission-coordinator.js'

const fail = (code: ConstructorParameters<typeof ControlStoreError>[0], message: string): never => { throw new ControlStoreError(code, message) }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
export const nativeCommandHash = (value: ProductNativeCommand): string => createHash('sha256').update(canonical(value)).digest('hex')
export function nativeCommand(candidate: unknown): ProductNativeCommand {
  let value: ReturnType<typeof parseContract<'native-control'>>
  try { value = parseContract('native-control', candidate) } catch { return fail('invalid-request', 'Invalid native command') }
  if (!('kind' in value) || value.kind !== 'native-command' || nativeControlIssues(value).length) return fail('invalid-request', 'Invalid native command')
  return structuredClone(value)
}
type WorkerModels = Parameters<typeof IsolatedPiWorker.create>[0]['models']
interface Options {
  control: ControlStore, operations: NativeOperationStore, resources: ResourceStore, approvalId: string,
  actor: ProductActor, binding: ProductBinding, coordinator: SubmissionCoordinator, worker: IsolatedPiWorker, models: WorkerModels
}

/** Product operation metadata surrounds the native SDK; it never owns a second loop or transcript. */
export class ConversationNativeControls {
  private readonly options: Options
  constructor(options: Options) {
    this.options = { ...options, actor: { ...options.actor }, binding: structuredClone(options.binding) }
    options.coordinator.initializeNative(lease => {
      for (const operation of options.operations.pending(options.actor, options.binding.conversationId)) {
        if (operation.generation !== options.binding.generation || operation.bindingId !== options.binding.bindingId) continue
        if (operation.state === 'accepted' || operation.state === 'applying') options.operations.transition(options.actor, lease, operation.operationId, operation.version,
          'outcome-unknown', { errorCode: 'execution-interrupted' })
      }
      return options.operations.pending(options.actor, options.binding.conversationId).length > 0
    })
  }
  async inspect(actor: ProductActor): Promise<ProductNativeInspection> {
    const config = this.options, binding = this.authorize(actor), approval = this.approval()
    const state = config.coordinator.busy ? null : await config.worker.nativeInspect()
    this.authorize(actor)
    const now = this.approval()
    if (approval.version !== now.version || approval.manifestHash !== now.manifestHash) fail('conflict', 'Resource approval changed during inspection')
    const listing = config.operations.list(actor, binding.conversationId)
    const operations = listing.operations.filter(operation => operation.bindingId === binding.bindingId && operation.generation === binding.generation)
    const value: ProductNativeInspection = { schemaVersion: 1, kind: 'native-inspection', binding,
      resource: { approvalId: approval.approvalId, version: approval.version, manifestHash: approval.manifestHash },
      models: nativeModelOptions(config.models), state, busy: config.coordinator.busy || config.coordinator.nativeBlocked || Boolean(state?.busy),
      queued: config.coordinator.queued, operations, truncated: listing.truncated || operations.length !== listing.operations.length }
    parseContract('native-control', value)
    if (nativeControlIssues(value).length) fail('integrity-error', 'Inconsistent native inspection')
    return value
  }
  command(actor: ProductActor, candidate: unknown): ProductNativeOperation {
    const request = nativeCommand(candidate), config = this.options, binding = this.authorize(actor)
    if (request.conversationId !== binding.conversationId) fail('invalid-request', 'Native command conversation changed')
    const old = config.operations.byKey(actor, binding.conversationId, request.idempotencyKey)
    if (old) {
      if (old.requestHash !== nativeCommandHash(request)) fail('conflict', 'Native key belongs to different input')
      if (old.state !== 'outcome-unknown') return old
      this.assertRequest(request)
      return config.coordinator.runNative(lease => { config.control.verifyWriter(lease); return old }, (operation, context) => this.execute(operation, context, true), true)
    }
    this.assertRequest(request)
    const approval = this.approval()
    if (request.approvalId !== approval.approvalId || request.expectedApprovalVersion !== approval.version) fail('conflict', 'Native resource approval changed')
    return config.coordinator.runNative(lease => config.operations.accept(actor, lease, request).operation,
      (operation, context) => this.execute(operation, context, false))
  }
  private async execute(accepted: ProductNativeOperation, context: NativeWorkContext, recovery: boolean): Promise<boolean> {
    const config = this.options, actor = config.actor, request = accepted.request
    let dispatched = false, failure: NonNullable<ProductNativeOperation['errorCode']> = 'execution-interrupted'
    try {
      context.signal.throwIfAborted(); this.assertRequest(request)
      const input: NativeControlApply = { operationId: accepted.operationId, requestHash: accepted.requestHash, expectedHead: request.expectedHead, action: request.action }
      if (recovery) {
        // Explicit original-key recovery reads proof only. Never send another native setter call.
        const file = config.worker.verifiedFile
        if (!file) fail('recovery-required', 'Native file is unavailable')
        const outcome = findNativeControlOutcome(file!, input, config.models)
        context.signal.throwIfAborted(); this.assertRequest(request)
        if (outcome) this.settle(accepted, context, outcome)
      } else {
        const approval = this.approval()
        failure = 'not-authorized'
        if (request.approvalId !== approval.approvalId || request.expectedApprovalVersion !== approval.version) fail('permission-denied', 'Native resource approval changed')
        failure = 'execution-interrupted'
        const state = await config.worker.nativeInspect()
        context.signal.throwIfAborted(); this.assertRequest(request)
        failure = 'not-authorized'
        if (this.approval().version !== approval.version) fail('permission-denied', 'Native resource approval changed before execution')
        failure = 'stale-state'
        if (state.busy || !nativeHeadEqual(state.head, request.expectedHead)) fail('conflict', 'Native head changed before execution')
        failure = 'invalid-action'
        if (request.action.kind === 'set-model' && !state.models.some(model => request.action.kind === 'set-model' && model.provider === request.action.provider && model.id === request.action.modelId)
          || request.action.kind === 'set-thinking' && !state.thinkingLevels.includes(request.action.level)
          || request.action.kind === 'compact' && state.compaction?.canCompact !== true) fail('invalid-request', 'Native capability is not supported')
        failure = 'execution-interrupted'
        context.resume(); context.signal.throwIfAborted()
        const applying = config.operations.transition(actor, context.writer(), accepted.operationId, accepted.version, 'applying')
        // FULL-sync COMMIT may outlast a lease. Recheck after it, not just inside the transaction.
        context.writer(); context.signal.throwIfAborted()
        dispatched = true
        const outcome = await config.worker.nativeApply(input, context.signal)
        this.assertRequest(request)
        // The worker wrapper independently verifies the immutable native before/after bytes.
        failure = 'not-authorized'
        if (this.approval().version !== approval.version) fail('permission-denied', 'Native resource approval changed during execution')
        this.settle(applying, context, outcome)
      }
    } catch {
      const current = config.operations.get(actor, request.conversationId, accepted.operationId)
      if (!['succeeded', 'failed', 'outcome-unknown'].includes(current.state)) {
        config.operations.transition(actor, context.writer(), accepted.operationId, current.version, dispatched ? 'outcome-unknown' : 'failed', { errorCode: failure })
      }
      // Unknown recovery failures do not erase the barrier or infer an outcome from settings.
    }
    return config.operations.pending(actor, request.conversationId).length > 0
  }
  private settle(operation: ProductNativeOperation, context: NativeWorkContext, outcome: NativeControlOutcome): void {
    const { operations, actor } = this.options
    if (outcome.status === 'not-applied') operations.transition(actor, context.writer(), operation.operationId, operation.version, 'failed', {
      errorCode: 'execution-interrupted', failureProof: outcome.failureProof,
    })
    else operations.transition(actor, context.writer(), operation.operationId, operation.version, 'succeeded', { result: outcome.proof })
  }
  private authorize(actor: ProductActor): ProductBinding {
    const config = this.options
    if (actor.actorId !== config.actor.actorId || actor.workspaceId !== config.actor.workspaceId) return fail('not-found', 'Native controls are not accessible')
    const binding = config.control.binding(actor, config.binding.conversationId)
    if (binding.bindingId !== config.binding.bindingId || binding.generation !== config.binding.generation || binding.runtimeSessionId !== config.binding.runtimeSessionId) fail('conflict', 'Native binding changed')
    return binding
  }
  private assertRequest(request: ProductNativeCommand): void {
    const binding = this.authorize(this.options.actor)
    if (request.expectedBindingId !== binding.bindingId || request.expectedGeneration !== binding.generation || request.runtimeSessionId !== binding.runtimeSessionId) fail('conflict', 'Native request binding changed')
  }
  private approval() {
    try {
      const approval = this.options.resources.get(this.options.actor, this.options.approvalId)
      if (approval.state !== 'approved') return fail('permission-denied', 'Native resources are not approved')
      return approval
    } catch { return fail('permission-denied', 'Native resources are not accessible') }
  }
}
