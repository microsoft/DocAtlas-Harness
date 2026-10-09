import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import { nativeControlIssues, nativeLineageIssues, nativeSelectedHeadEqual, type NativeConversationHistory, type NativeLineageApply, type NativeSelectedHead,
  type ProductBinding, type ProductNativeCommand, type ProductNativeInspection, type ProductNativeOperation, type ProductLineageCommand, type ProductLineageInspection, type ProductLineageOperation,
  type ProductNativeTreePage, type ProductNativeTreeRequest } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { checkpointConversation, findNativeControlOutcome, findNativeLineageOutcome, inspectNativeSession, nativeModelOptions, verifyNativeLineageOutcome,
  verifyNativeSelectedHead, type NativeSessionSeal } from '@docatlas/runtime-pi/worker'
import { canonical, ControlStore, ControlStoreError, type ProductActor, type WriterLease } from '../storage/control-store.js'
import { RuntimeCatalog, dedicatedDirectory, type RuntimeClaim } from '../storage/runtime-catalog.js'
import type { ResourceStore } from '../storage/resource-store.js'
import { IsolatedPiWorker } from '../execution/pi-worker.js'
import { LinuxExecutor } from '../execution/linux-executor.js'
import { SubmissionCoordinator, prepareDocumentFree, type NativeWorkContext, type PrepareSubmission } from './submission-coordinator.js'
import { ConversationObservations } from './observations.js'
import { NativeOperationStore } from '../storage/native-operation-store.js'
import { ConversationNativeControls, nativeCommand, nativeCommandHash } from './native-controls.js'
import { ConversationHistory } from './history.js'
import type { NativeHandoffRecord } from '../storage/runtime-handoffs.js'
import { installNativeFork } from './native-fork-install.js'
import { LineageHistoryAccess } from './lineage-history.js'
import { NativeConversationTree } from './native-tree.js'

type WorkerOptions = Parameters<typeof IsolatedPiWorker.create>[0]
export interface ManagedRuntimeServices {
  prepare: PrepareSubmission, documents?: WorkerOptions['documents'], modelPolicy?: WorkerOptions['modelPolicy'],
  /** Trusted, optional product observations. Attach before queued execution; never a second run owner. */
  onCoordinator?(coordinator: SubmissionCoordinator): (() => void) | void
  close?(): Promise<void>
}
export interface RuntimeManagerOptions {
  control: ControlStore, catalog: RuntimeCatalog, resources: ResourceStore, actor: ProductActor, approvalId: string,
  workspaceRoot: string, stateRoot: string, rgExecutable: string, modelRuntime: WorkerOptions['modelRuntime'], models: WorkerOptions['models'],
  protectedRoots?: string[], maxActive?: number, services?(binding: ProductBinding): ManagedRuntimeServices | Promise<ManagedRuntimeServices>
}
export interface ManagedRuntime { coordinator: SubmissionCoordinator, observations: ConversationObservations, worker: IsolatedPiWorker, native: LinuxExecutor, controls: ConversationNativeControls }
interface OwnedRuntime extends ManagedRuntime { claim: RuntimeClaim, close(): Promise<void> }
const fail = (code: ConstructorParameters<typeof ControlStoreError>[0], message: string): never => { throw new ControlStoreError(code, message) }
const within = (root: string, path: string) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith('../') }

/** Product composition, not another agent loop. Credentials/configuration are supplied by the trusted application. */
export class RuntimeManager {
  private readonly options: RuntimeManagerOptions
  private readonly active = new Map<string, Promise<OwnedRuntime>>()
  private readonly histories = new Map<string, { bindingId: string, value: ConversationHistory }>()
  private readonly historyAccesses = new Map<string, { bindingId: string, value: LineageHistoryAccess }>()
  private readonly nativeTrees = new Map<string, { bindingId: string, value: NativeConversationTree }>()
  private readonly readonlyObservations = new Map<string, { bindingId: string, value: ConversationObservations }>()
  private readonly operations: NativeOperationStore
  private readonly lineageTasks = new Map<string, Promise<void>>()
  private closed = false
  private closing: Promise<void> | undefined
  constructor(options: RuntimeManagerOptions) {
    const maxActive = options.maxActive ?? 4
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 16) fail('invalid-request', 'Invalid active runtime capacity')
    dedicatedDirectory(options.stateRoot)
    if (within(options.workspaceRoot, options.stateRoot) || within(options.stateRoot, options.workspaceRoot)) fail('invalid-request', 'Private runtime state cannot overlap the native workspace')
    this.options = { ...options, actor: { ...options.actor }, maxActive }
    this.operations = NativeOperationStore.open(options.control)
  }
  create(actor: ProductActor, key: string): { binding: ProductBinding, replayed: boolean } {
    this.authorize(actor)
    return this.options.control.createManagedConversation(actor, key)
  }
  async get(actor: ProductActor, conversationId: string): Promise<ManagedRuntime> {
    this.authorize(actor)
    const binding = this.options.control.binding(actor, conversationId)
    if (this.options.catalog.handoffs.pending(actor, conversationId)) return fail('recovery-required', 'Native lineage handoff must finish before execution can resume')
    let pending = this.active.get(conversationId)
    if (!pending) {
      if (this.active.size >= this.options.maxActive!) fail('limit-exceeded', 'Active runtime capacity reached')
      pending = this.open(binding)
      this.active.set(conversationId, pending)
      void pending.catch(() => { if (this.active.get(conversationId) === pending) this.active.delete(conversationId) })
    }
    const value = await pending
    this.authorize(actor); value.observations.authorize(actor, conversationId)
    return value
  }
  async nativeInspect(actor: ProductActor, conversationId: string): Promise<ProductNativeInspection> {
    this.authorize(actor)
    const binding = this.options.control.binding(actor, conversationId)
    if (this.options.catalog.handoffs.pending(actor, conversationId) || !this.active.has(conversationId) && this.operations.pending(actor, conversationId).length) {
      const approval = this.options.resources.get(actor, this.options.approvalId)
      if (approval.state !== 'approved') return fail('permission-denied', 'Native resources are not approved')
      const listing = this.operations.list(actor, conversationId), operations = listing.operations.filter(operation => operation.bindingId === binding.bindingId && operation.generation === binding.generation)
      const value: ProductNativeInspection = { schemaVersion: 1, kind: 'native-inspection', binding,
        resource: { approvalId: approval.approvalId, version: approval.version, manifestHash: approval.manifestHash }, models: nativeModelOptions(this.options.models),
        state: null, busy: true, queued: this.options.control.pending(actor, conversationId).filter(receipt => ['accepted', 'preparing', 'ready'].includes(receipt.state)).length,
        operations, truncated: listing.truncated || operations.length !== listing.operations.length }
      this.assertBinding(actor, binding); parseContract('native-control', value)
      if (nativeControlIssues(value).length) return fail('integrity-error', 'Inconsistent cold native inspection')
      return structuredClone(value)
    }
    return (await this.get(actor, conversationId)).controls.inspect(actor)
  }
  async nativeCommand(actor: ProductActor, conversationId: string, candidate: unknown, authorize: () => void): Promise<ProductNativeOperation> {
    this.authorize(actor); authorize()
    const request = nativeCommand(candidate)
    if (request.conversationId !== conversationId) fail('invalid-request', 'Native command conversation changed')
    this.options.control.binding(actor, conversationId)
    const old = this.operations.byKey(actor, conversationId, request.idempotencyKey)
    if (old) {
      if (old.requestHash !== nativeCommandHash(request)) fail('conflict', 'Native key belongs to different input')
      // Receipt-only retry must not open a stopped runtime or change the original outcome.
      if (old.state === 'succeeded' || old.state === 'failed' || this.active.has(conversationId) && old.state !== 'outcome-unknown') return old
      if (!this.active.has(conversationId)) return this.recoverColdNative(actor, request, old, authorize)
    }
    const runtime = await this.get(actor, conversationId)
    authorize(); this.authorize(actor)
    return runtime.controls.command(actor, request)
  }
  nativeOperation(actor: ProductActor, conversationId: string, operationId: string): ProductNativeOperation {
    this.authorize(actor)
    return this.operations.get(actor, conversationId, operationId)
  }
  async lineageInspect(actor: ProductActor, conversationId: string): Promise<ProductLineageInspection> {
    this.authorize(actor)
    const config = this.options, binding = config.control.binding(actor, conversationId), approval = this.lineageApproval()
    const pending = config.catalog.handoffs.pending(actor, conversationId)
    const runtime = pending ? undefined : await this.get(actor, conversationId)
    const head = runtime && !runtime.coordinator.busy && !runtime.coordinator.nativeBlocked ? await runtime.worker.lineageInspect() : null
    this.assertBinding(actor, binding)
    if (this.lineageApproval().version !== approval.version) fail('conflict', 'Lineage resource approval changed during inspection')
    const records = config.catalog.handoffs.records(actor, conversationId).filter(value => value.operation.sourceBinding.conversationId === conversationId).reverse()
    const result: ProductLineageInspection = { schemaVersion: 1, kind: 'lineage-inspection', binding,
      resource: { approvalId: approval.approvalId, version: approval.version, manifestHash: approval.manifestHash }, head,
      busy: Boolean(pending) || Boolean(runtime?.coordinator.busy) || Boolean(runtime?.coordinator.nativeBlocked), queued: runtime?.coordinator.queued ?? 0,
      operations: records.slice(0, 32).map(value => value.operation), truncated: records.length > 32 }
    parseContract('native-lineage', result)
    if (nativeLineageIssues(result).length) fail('integrity-error', 'Inconsistent lineage inspection')
    return result
  }
  lineageOperation(actor: ProductActor, conversationId: string, operationId: string): ProductLineageOperation {
    this.authorize(actor); this.options.control.binding(actor, conversationId)
    const value = this.options.catalog.handoffs.get(actor, operationId)
    if (value.operation.sourceBinding.conversationId !== conversationId) return fail('not-found', 'Lineage operation belongs to another conversation')
    return value.operation
  }
  async lineageCommand(actor: ProductActor, conversationId: string, candidate: unknown, authorize: () => void): Promise<ProductLineageOperation> {
    this.authorize(actor); authorize()
    const parsed = parseContract('native-lineage', candidate)
    if (!('kind' in parsed) || parsed.kind !== 'lineage-command' || nativeLineageIssues(parsed).length || parsed.conversationId !== conversationId) return fail('invalid-request', 'Invalid lineage command')
    const request = structuredClone(parsed), config = this.options
    config.control.binding(actor, conversationId)
    const old = config.catalog.handoffs.byKey(actor, conversationId, request.idempotencyKey)
    if (old) {
      if (old.operation.requestHash !== createHash('sha256').update(canonical(request)).digest('hex')) return fail('conflict', 'Lineage key belongs to different complete input')
      if (old.phase === 'complete' || this.lineageTasks.has(conversationId)) return old.operation
      const owned = this.active.get(conversationId)
      if (owned) { const runtime = await owned; await runtime.coordinator.waitForIdle(); await runtime.close(); this.active.delete(conversationId) }
      authorize(); this.authorize(actor)
      return this.finishLineage(actor, config.catalog.handoffs.get(actor, old.operation.operationId)).operation
    }
    const runtime = await this.get(actor, conversationId) as OwnedRuntime
    authorize(); this.authorize(actor); this.assertLineageRequest(actor, request)
    const accepted = runtime.coordinator.runNative(lease => {
      config.control.verifyWriter(lease)
      // The durable accept result must keep the coordinator barrier even if its
      // FULL commit outlives this lease. Execution rechecks after applying COMMIT.
      return config.catalog.handoffs.accept(runtime.claim, request)
    }, (record, context) => this.executeLineage(runtime, record, context), false, true)
    const task = (async () => {
      await runtime.coordinator.waitForIdle()
      let current = config.catalog.handoffs.get(actor, accepted.operation.operationId)
      if (current.phase === 'complete') return
      await runtime.close()
      if (this.active.get(conversationId)) this.active.delete(conversationId)
      current = config.catalog.handoffs.get(actor, accepted.operation.operationId)
      if (!this.closed && current.operation.state !== 'outcome-unknown') this.finishLineage(actor, current)
    })().catch(() => { /* Durable phase/claim remains fenced; original-key recovery never replays the SDK action. */ })
      .finally(() => { if (this.lineageTasks.get(conversationId) === task) this.lineageTasks.delete(conversationId) })
    this.lineageTasks.set(conversationId, task)
    return accepted.operation
  }
  /** Private current/ancestor lookup; the browser never supplies a filesystem path. */
  lineageFile(actor: ProductActor, conversationId: string, bindingId: string): string {
    this.authorize(actor)
    const current = this.options.control.binding(actor, conversationId)
    if (current.bindingId === bindingId) {
      const stored = this.options.catalog.inspect(current)
      if (!stored?.filename) return fail('recovery-required', 'Native history file is unavailable')
      return join(this.options.stateRoot, current.runtimeSessionId, 'sessions', stored.filename)
    }
    const link = this.options.catalog.lineageLinks(actor, current).find(value => value.sourceBinding.bindingId === bindingId)
    if (!link) return fail('not-found', 'Native binding is not an authorized ancestor')
    return join(this.options.stateRoot, link.sourceBinding.runtimeSessionId, 'sessions', link.sourceFilename)
  }
  historyAccess(actor: ProductActor, conversationId: string): LineageHistoryAccess {
    this.authorize(actor)
    const binding = this.options.control.binding(actor, conversationId), previous = this.historyAccesses.get(conversationId)
    if (previous?.bindingId === binding.bindingId) return previous.value
    previous?.value.dispose(); this.historyAccesses.delete(conversationId)
    if (this.historyAccesses.size >= 256) {
      const evict = [...this.historyAccesses.keys()].find(id => !this.active.has(id))
      if (!evict) return fail('limit-exceeded', 'Native history access capacity reached')
      this.historyAccesses.get(evict)!.value.dispose(); this.historyAccesses.delete(evict)
      this.histories.get(evict)?.value.dispose(); this.histories.delete(evict)
    }
    const access = new LineageHistoryAccess(this.options.control, this.options.catalog, { ...actor }, structuredClone(binding), this.options.workspaceRoot,
      (reader, currentId, bindingId) => this.lineageFile(reader, currentId, bindingId))
    this.historyAccesses.set(conversationId, { bindingId: binding.bindingId, value: access }); return access
  }
  async lineageTree(actor: ProductActor, conversationId: string, request: ProductNativeTreeRequest): Promise<ProductNativeTreePage> {
    this.authorize(actor)
    const binding = this.options.control.binding(actor, conversationId), previous = this.nativeTrees.get(conversationId)
    let tree = previous?.bindingId === binding.bindingId ? previous.value : undefined
    if (!tree) {
      previous?.value.dispose(); this.nativeTrees.delete(conversationId)
      if (this.nativeTrees.size >= 256) { const oldest = this.nativeTrees.keys().next().value!; this.nativeTrees.get(oldest)!.value.dispose(); this.nativeTrees.delete(oldest) }
      tree = new NativeConversationTree({ control: this.options.control, actor, binding, cwd: this.options.workspaceRoot,
        head: () => this.treeHead(actor, binding), file: () => this.lineageFile(actor, conversationId, binding.bindingId),
        origins: (head, ids) => this.historyAccess(actor, conversationId).treeOrigins(conversationId, head, ids) })
      this.nativeTrees.set(conversationId, { bindingId: binding.bindingId, value: tree })
    }
    return tree.page(actor, request)
  }
  /** Stop owns no startup or reconciliation authority. A durable handoff fence is
   * not a reason to block cancelling the actual already-owned native operation.
   */
  async stop(actor: ProductActor, conversationId: string): Promise<void> {
    this.authorize(actor)
    const binding = this.options.control.binding(actor, conversationId), owned = this.active.get(conversationId)
    if (owned) {
      const runtime = await owned
      this.authorize(actor); this.assertBinding(actor, binding)
      await runtime.coordinator.cancel(); this.authorize(actor); return
    }
    const pending = this.options.catalog.handoffs.pending(actor, conversationId)
    if (pending) {
      if (this.options.control.writerInfo(actor, conversationId)) fail('recovery-required', 'Stop cannot infer termination of an unowned writer')
      this.options.catalog.handoffs.assertJoined(actor, pending.operation.operationId); return
    }
    if (this.options.catalog.inspect(binding)?.active || this.options.control.writerInfo(actor, conversationId)) fail('recovery-required', 'Stop cannot infer termination of an unowned runtime')
  }
  private async treeHead(actor: ProductActor, binding: ProductBinding): Promise<NativeSelectedHead> {
    this.assertBinding(actor, binding)
    if (this.options.catalog.handoffs.pending(actor, binding.conversationId) || this.operations.pending(actor, binding.conversationId).length) fail('recovery-required', 'Native state is awaiting operation reconciliation')
    const owned = this.active.get(binding.conversationId)
    if (owned) {
      const runtime = await owned
      this.assertBinding(actor, binding)
      if (runtime.coordinator.busy || runtime.coordinator.nativeBlocked) fail('conflict', 'Native tree is changing during execution')
      const head = await runtime.worker.lineageInspect()
      this.assertBinding(actor, binding); return head
    }
    const stored = this.options.catalog.inspect(binding)
    if (stored?.active) fail('recovery-required', 'Native tree ownership is unresolved')
    if (stored?.selectedHead) return structuredClone(stored.selectedHead)
    const inspection = await this.lineageInspect(actor, binding.conversationId)
    this.assertBinding(actor, binding)
    if (!inspection.head) return fail('conflict', 'Native tree is not idle')
    return inspection.head
  }
  async observations(actor: ProductActor, conversationId: string): Promise<ConversationObservations> {
    this.authorize(actor)
    const binding = this.options.control.binding(actor, conversationId)
    if (this.active.has(conversationId)) return (await this.get(actor, conversationId)).observations
    const previous = this.readonlyObservations.get(conversationId)
    if (previous?.bindingId === binding.bindingId) { previous.value.authorize(actor, conversationId); return previous.value }
    previous?.value.dispose(); this.readonlyObservations.delete(conversationId)
    if (!this.operations.pending(actor, conversationId).length) return (await this.get(actor, conversationId)).observations
    if (this.readonlyObservations.size >= 256) {
      const first = this.readonlyObservations.keys().next().value!
      this.readonlyObservations.get(first)!.value.dispose(); this.readonlyObservations.delete(first)
    }
    // A real verified projection with no execution subscription, never a fabricated runtime.
    const value = new ConversationObservations(this.options.control, actor, conversationId, {
      sessionId: binding.runtimeSessionId, publicHistory: () => this.coldHistory(actor, binding), observe: () => () => {},
    }, { subscribe: () => () => {} }, () => this.historyAccess(actor, conversationId).snapshot())
    this.readonlyObservations.set(conversationId, { bindingId: binding.bindingId, value })
    return value
  }
  history(actor: ProductActor, conversationId: string): ConversationHistory {
    this.authorize(actor)
    const binding = this.options.control.binding(actor, conversationId), previous = this.histories.get(conversationId)
    if (previous?.bindingId === binding.bindingId) return previous.value
    previous?.value.dispose()
    if (this.histories.size >= 256) { const first = this.histories.keys().next().value!; this.histories.get(first)!.value.dispose(); this.histories.delete(first) }
    const value = new ConversationHistory(this.options.control, actor, conversationId, async frozen => {
      this.authorize(actor)
      const pending = this.active.get(conversationId)
      if (pending) {
        const runtime = await pending
        this.authorize(actor)
        const file = runtime.worker.verifiedFile
        if (!file) return fail('integrity-error', 'Verified native history file is unavailable')
        return file
      }
      return this.closedFile(actor, frozen)
    }, Date.now, this.historyAccess(actor, conversationId))
    this.histories.set(conversationId, { bindingId: binding.bindingId, value }); return value
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const history of this.histories.values()) history.value.dispose()
    this.histories.clear()
    for (const access of this.historyAccesses.values()) access.value.dispose()
    this.historyAccesses.clear()
    for (const tree of this.nativeTrees.values()) tree.value.dispose()
    this.nativeTrees.clear()
    for (const hub of this.readonlyObservations.values()) hub.value.dispose()
    this.readonlyObservations.clear()
    this.closing = (async () => {
      const opened = await Promise.allSettled(this.active.values())
      const results = await Promise.allSettled(opened.filter((value): value is PromiseFulfilledResult<OwnedRuntime> => value.status === 'fulfilled').map(value => value.value.close()))
      this.active.clear()
      await Promise.allSettled(this.lineageTasks.values())
      const failures = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(value => value.reason), 'Runtime shutdown was not fully verified')
      this.operations.close()
    })()
    return this.closing
  }
  private authorize(actor: ProductActor): void {
    if (this.closed) fail('conflict', 'Runtime manager is closing')
    if (actor.actorId !== this.options.actor.actorId || actor.workspaceId !== this.options.actor.workspaceId) fail('not-found', 'Workspace runtime is not accessible')
  }
  private assertBinding(actor: ProductActor, binding: ProductBinding): void {
    this.authorize(actor)
    const current = this.options.control.binding(actor, binding.conversationId)
    if (current.bindingId !== binding.bindingId || current.generation !== binding.generation || current.runtimeSessionId !== binding.runtimeSessionId) fail('conflict', 'Runtime binding changed')
  }
  private lineageApproval() {
    const value = this.options.resources.get(this.options.actor, this.options.approvalId)
    if (value.state !== 'approved') return fail('permission-denied', 'Lineage resources are not approved')
    return value
  }
  private assertLineageRequest(actor: ProductActor, request: ProductLineageCommand): void {
    this.authorize(actor)
    const current = this.options.control.binding(actor, request.conversationId), approval = this.lineageApproval()
    if (current.bindingId !== request.expectedBindingId || current.generation !== request.expectedGeneration || current.runtimeSessionId !== request.runtimeSessionId) fail('conflict', 'Lineage source binding changed')
    if (approval.approvalId !== request.approvalId || approval.version !== request.expectedApprovalVersion) fail('permission-denied', 'Lineage resource approval changed')
  }
  private async executeLineage(runtime: OwnedRuntime, accepted: NativeHandoffRecord, context: NativeWorkContext): Promise<boolean> {
    const config = this.options, actor = config.actor, request = accepted.operation.request
    let dispatched = false, failure: NonNullable<ProductLineageOperation['errorCode']> = 'execution-interrupted'
    try {
      context.signal.throwIfAborted(); failure = 'not-authorized'; this.assertLineageRequest(actor, request)
      failure = 'execution-interrupted'
      const head = await runtime.worker.lineageInspect()
      context.signal.throwIfAborted(); this.assertLineageRequest(actor, request)
      failure = 'stale-state'
      if (!nativeSelectedHeadEqual(head, request.expectedHead)) fail('conflict', 'Native selected context changed before lineage execution')
      failure = 'invalid-action'
      const file = runtime.worker.verifiedFile
      if (!file) fail('recovery-required', 'Native lineage source file is unavailable')
      const source = inspectNativeSession(file!, request.runtimeSessionId, config.workspaceRoot)
      const target = source.entries.find(entry => entry.id === request.action.targetEntryId)
      if (!target || request.action.kind === 'fork' && request.action.position === 'before'
        && (target.type !== 'message' || !target.message || typeof target.message !== 'object' || Reflect.get(target.message, 'role') !== 'user')) fail('invalid-request', 'Native lineage target is not supported')
      failure = 'execution-interrupted'
      context.resume(); context.signal.throwIfAborted(); context.writer()
      const applying = config.catalog.handoffs.applying(runtime.claim, accepted.operation.operationId, accepted.operation.version)
      context.writer(); context.signal.throwIfAborted()
      dispatched = true
      const result = await runtime.worker.lineageApply({ operationId: applying.operation.operationId, requestHash: applying.operation.requestHash,
        expectedHead: request.expectedHead, action: request.action }, context.signal)
      failure = 'not-authorized'; this.assertLineageRequest(actor, request); context.writer()
      config.catalog.handoffs.prove(runtime.claim, actor, applying.operation.operationId, applying.operation.version, result.outcome, result.forkFilename)
    } catch {
      const current = config.catalog.handoffs.get(actor, accepted.operation.operationId)
      if (current.phase !== 'complete') {
        if (dispatched) config.catalog.handoffs.unknown(runtime.claim, current.operation.operationId, current.operation.version)
        else config.catalog.handoffs.failBeforeDispatch(runtime.claim, current.operation.operationId, current.operation.version, failure)
      }
    }
    return config.catalog.handoffs.get(actor, accepted.operation.operationId).phase !== 'complete'
  }
  private lineageSource(record: NativeHandoffRecord): string {
    return join(this.options.stateRoot, record.operation.sourceBinding.runtimeSessionId, 'sessions', record.sourceFilename)
  }
  private lineageTargetFile(record: NativeHandoffRecord): string {
    if (!record.proof || !record.targetBinding) return fail('recovery-required', 'Native lineage target is not proved')
    if (record.proof.kind === 'native-navigation-proof') return this.lineageSource(record)
    if (record.targetFilename) return join(this.options.stateRoot, record.targetBinding.runtimeSessionId, 'sessions', record.targetFilename)
    if (!record.forkFilename) return fail('integrity-error', 'Native fork proof lost its private SDK filename')
    return join(this.options.stateRoot, record.operation.sourceBinding.runtimeSessionId, 'sessions', record.forkFilename)
  }
  private finishLineage(actor: ProductActor, initial: NativeHandoffRecord): NativeHandoffRecord {
    const config = this.options
    let current = initial
    if (current.phase === 'complete') return current
    if (!['joined', 'installed', 'binding-committed'].includes(current.phase) || !current.closedSourceSeal) return fail('recovery-required', 'Native lineage effects have not been durably joined')
    const sourceFile = this.lineageSource(current), sourceBinding = current.operation.sourceBinding
    if (config.control.writerInfo(actor, sourceBinding.conversationId)) return fail('recovery-required', 'A writer still owns the lineage source')
    if (canonical(inspectNativeSession(sourceFile, sourceBinding.runtimeSessionId, config.workspaceRoot).seal) !== canonical(current.closedSourceSeal)) return fail('integrity-error', 'Joined native source bytes changed')
    const input: NativeLineageApply = { operationId: current.operation.operationId, requestHash: current.operation.requestHash,
      expectedHead: current.operation.request.expectedHead, action: current.operation.request.action }
    if (!current.proof) {
      const found = findNativeLineageOutcome(sourceFile, config.workspaceRoot, input, name => {
        if (basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\.jsonl$/u.test(name)) return fail('integrity-error', 'Invalid recovered SDK fork filename')
        return join(config.stateRoot, sourceBinding.runtimeSessionId, 'sessions', name)
      }, config.models)
      if (!found) return current
      current = config.catalog.handoffs.prove(undefined, actor, input.operationId, current.operation.version, found.outcome, found.forkFilename)
      if (current.phase === 'complete') return current
    }
    const proof = current.proof!
    verifyNativeLineageOutcome(sourceFile, config.workspaceRoot, input, { status: 'replayed', proof }, proof.kind === 'native-fork-proof' ? this.lineageTargetFile(current) : undefined, config.models)
    verifyNativeSelectedHead(sourceFile, config.workspaceRoot, proof.sourceAfterHead, { exactFile: true })
    verifyNativeSelectedHead(this.lineageTargetFile(current), config.workspaceRoot, proof.targetHead, { exactFile: true })
    if (current.phase === 'joined') {
      current = config.catalog.handoffs.installed(actor, input.operationId, current.operation.version, record => {
        this.assertLineageRequest(actor, record.operation.request)
        if (proof.kind === 'native-navigation-proof') return { filename: record.sourceFilename, seal: inspectNativeSession(sourceFile, sourceBinding.runtimeSessionId, config.workspaceRoot, true).seal }
        return installNativeFork(this.lineageTargetFile(record), join(config.stateRoot, record.targetBinding!.runtimeSessionId, 'sessions'), config.workspaceRoot, proof.targetHead, input.operationId)
      })
    }
    if (current.phase === 'installed') {
      current = config.catalog.handoffs.bound(actor, input.operationId, current.operation.version, (source, target) => {
        this.authorize(actor); this.lineageApproval()
        config.control.commitNativeHandoff(actor, source, target)
      })
    }
    if (current.phase === 'binding-committed') {
      this.histories.get(sourceBinding.conversationId)?.value.dispose(); this.histories.delete(sourceBinding.conversationId)
      this.historyAccesses.get(sourceBinding.conversationId)?.value.dispose(); this.historyAccesses.delete(sourceBinding.conversationId)
      this.nativeTrees.get(sourceBinding.conversationId)?.value.dispose(); this.nativeTrees.delete(sourceBinding.conversationId)
      this.readonlyObservations.get(sourceBinding.conversationId)?.value.dispose(); this.readonlyObservations.delete(sourceBinding.conversationId)
      current = config.catalog.handoffs.complete(actor, input.operationId, current.operation.version, target => {
        this.authorize(actor)
        if (canonical(config.control.binding(actor, target.conversationId)) !== canonical(target)) fail('conflict', 'Installed lineage target binding changed')
        if (config.control.writerInfo(actor, target.conversationId)) fail('recovery-required', 'A writer appeared before lineage handoff completed')
      })
    }
    return current
  }
  private sealedFile(binding: ProductBinding, stored: { filename: string | null, seal: NativeSessionSeal | null }): string {
    if (!stored.filename || !stored.seal) return fail('recovery-required', 'Sealed native session is unavailable')
    const file = join(this.options.stateRoot, binding.runtimeSessionId, 'sessions', stored.filename)
    const actual = inspectNativeSession(file, binding.runtimeSessionId, this.options.workspaceRoot).seal
    if (JSON.stringify(actual) !== JSON.stringify(stored.seal)) return fail('integrity-error', 'Closed native history seal changed')
    return file
  }
  private closedFile(actor: ProductActor, binding: ProductBinding): string {
    this.assertBinding(actor, binding)
    const stored = this.options.catalog.inspect(binding)
    if (!stored) return fail('recovery-required', 'Sealed native session is unavailable')
    if (stored.active) return fail('recovery-required', 'Native runtime ownership is unresolved')
    const file = this.sealedFile(binding, stored)
    this.assertBinding(actor, binding)
    return file
  }
  private coldHistory(actor: ProductActor, binding: ProductBinding): NativeConversationHistory {
    this.assertBinding(actor, binding)
    const checkpoint = this.options.control.latestCheckpoint(actor, binding.conversationId)
    if (!checkpoint) return { checkpoint: null, messages: [], hasEarlier: false }
    if (checkpoint.runtimeSessionId !== binding.runtimeSessionId) return fail('integrity-error', 'History checkpoint runtime changed')
    const projection = checkpointConversation(this.closedFile(actor, binding), checkpoint)
    this.assertBinding(actor, binding)
    return projection
  }
  private recoverColdNative(actor: ProductActor, request: ProductNativeCommand, old: ProductNativeOperation, authorize: () => void): ProductNativeOperation {
    const config = this.options, binding = config.control.binding(actor, request.conversationId)
    this.assertBinding(actor, binding); authorize()
    if (request.expectedBindingId !== binding.bindingId || request.expectedGeneration !== binding.generation || request.runtimeSessionId !== binding.runtimeSessionId
      || old.bindingId !== binding.bindingId || old.generation !== binding.generation) return fail('conflict', 'Native recovery belongs to another binding')
    if (config.control.writerInfo(actor, binding.conversationId)) return fail('recovery-required', 'Existing writer must be explicitly reconciled before metadata recovery')
    if (config.control.pending(actor, binding.conversationId).some(receipt => ['dispatching', 'running', 'cancelling'].includes(receipt.state))) return fail('recovery-required', 'Question execution must be reconciled before metadata recovery')
    // No worker, factory, model broker, executor or services are constructed in this path.
    this.closedFile(actor, binding)
    const claim = config.catalog.claim(binding), sessionDir = join(config.stateRoot, binding.runtimeSessionId, 'sessions')
    let lease: WriterLease | undefined
    try {
      lease = config.control.acquireWriter(actor, binding.conversationId, `native-recovery:${randomUUID()}`)
      const file = this.sealedFile(binding, claim)
      config.catalog.assertClaim(claim); this.assertBinding(actor, binding); authorize()
      let current = this.operations.get(actor, binding.conversationId, old.operationId)
      if (current.requestHash !== nativeCommandHash(request)) return fail('conflict', 'Original native recovery request changed')
      if (current.state === 'accepted' || current.state === 'applying') current = this.operations.transition(actor, lease, current.operationId, current.version, 'outcome-unknown', { errorCode: 'execution-interrupted' })
      if (current.state !== 'outcome-unknown') return current
      const outcome = findNativeControlOutcome(file, { operationId: current.operationId, requestHash: current.requestHash, expectedHead: request.expectedHead, action: request.action }, config.models)
      config.catalog.assertClaim(claim); this.assertBinding(actor, binding); authorize(); config.control.verifyWriter(lease)
      if (outcome) current = outcome.status === 'not-applied'
        ? this.operations.transition(actor, lease, current.operationId, current.version, 'failed', { errorCode: 'execution-interrupted', failureProof: outcome.failureProof })
        : this.operations.transition(actor, lease, current.operationId, current.version, 'succeeded', { result: outcome.proof })
      return current
    } finally { this.finishColdNative(actor, binding, claim, sessionDir, lease) }
  }
  private finishColdNative(actor: ProductActor, binding: ProductBinding, claim: RuntimeClaim, sessionDir: string, lease: WriterLease | undefined): void {
    if (lease) {
      try { this.options.control.releaseWriter(lease) }
      catch (error) {
        const current = this.options.control.writerInfo(actor, binding.conversationId)
        if (!current || current.epoch !== lease.epoch || current.workerId !== lease.workerId || current.generation !== lease.generation) throw error
        // This exact metadata-only lease never started execution. No PID/TTL inference,
        // writer transfer or foreign-epoch clearing is used to retire its expired token.
        this.options.control.recoverAfterExecutionStopped(actor, binding.conversationId, lease.epoch)
      }
    }
    this.releaseClean(claim, sessionDir, false)
  }
  private async open(binding: ProductBinding): Promise<OwnedRuntime> {
    const config = this.options, actor = config.actor
    if (this.operations.pending(actor, binding.conversationId).length) return fail('recovery-required', 'Cold native operations must be reconciled before starting resources or execution')
    const claim = config.catalog.claim(binding)
    let worker: IsolatedPiWorker | undefined, native: LinuxExecutor | undefined, coordinator: SubmissionCoordinator | undefined, observations: ConversationObservations | undefined, services: ManagedRuntimeServices | undefined
    const base = join(config.stateRoot, binding.runtimeSessionId), sessionDir = join(base, 'sessions')
    let spawned = false, ownedEpoch: number | undefined, closing: Promise<void> | undefined
    let detachCoordinator: (() => void) | undefined
    const shutdown = (): Promise<void> => closing ??= (async () => {
      try { detachCoordinator?.() } catch { /* Optional observations cannot prevent actual runtime joins. */ }
      detachCoordinator = undefined
      observations?.dispose()
      let controlFailure: unknown
      try { await coordinator?.close() } catch (error) { controlFailure = error }
      let selectedHead: NativeSelectedHead | undefined
      try { selectedHead = await worker?.lineageInspect() } catch { /* An unknown/closed worker cannot attest a selected head; its handoff remains fenced. */ }
      // Do not mark catalog clean or retire an old writer until namespace/native effects actually joined.
      await worker?.dispose(); await native?.abortAll(); await services?.close?.()
      if (controlFailure) {
        const previous = config.control.writerInfo(actor, binding.conversationId)
        if (previous && previous.epoch === ownedEpoch) config.control.recoverAfterExecutionStopped(actor, binding.conversationId, previous.epoch)
        else throw controlFailure
      }
      if (config.control.writerInfo(actor, binding.conversationId)) fail('recovery-required', 'Unowned writer requires explicit reconciliation')
      const handoff = config.catalog.handoffs.pending(actor, binding.conversationId)
      if (handoff) {
        if (!claim.filename) fail('integrity-error', 'Joined lineage lost its source filename')
        const sourceFile = join(sessionDir, claim.filename!), sourceSeal = inspectNativeSession(sourceFile, binding.runtimeSessionId, config.workspaceRoot, true).seal
        let targetSeal: NativeSessionSeal | undefined
        if (handoff.proof) {
          const targetFile = this.lineageTargetFile(handoff)
          verifyNativeSelectedHead(sourceFile, config.workspaceRoot, handoff.proof.sourceAfterHead, { exactFile: true })
          verifyNativeSelectedHead(targetFile, config.workspaceRoot, handoff.proof.targetHead, { exactFile: true })
          if (selectedHead && !nativeSelectedHeadEqual(selectedHead, handoff.proof.targetHead)) fail('integrity-error', 'Stopped SDK selected context differs from its lineage terminal')
          targetSeal = inspectNativeSession(targetFile, handoff.proof.targetHead.fileSeal.sessionId, config.workspaceRoot, true).seal
        }
        config.catalog.handoffs.joined(claim, handoff.operation.operationId, handoff.operation.version, sourceSeal, targetSeal)
      } else this.releaseClean(claim, sessionDir, spawned, selectedHead)
    })()
    try {
      if (config.control.writerInfo(actor, binding.conversationId)) fail('recovery-required', 'An existing writer is not proof of safe restart')
      if (config.control.pending(actor, binding.conversationId).some(receipt => ['dispatching', 'running', 'cancelling'].includes(receipt.state))) fail('recovery-required', 'Dispatched records require explicit reconciliation')
      dedicatedDirectory(sessionDir)
      if (claim.seal && (!claim.filename || !existsSync(join(sessionDir, claim.filename)))) fail('integrity-error', 'Recorded native session is missing')
      if (!claim.seal && readdirSync(sessionDir).some(name => name.endsWith('.jsonl'))) fail('integrity-error', 'Unsealed native session requires explicit reconciliation')
      native = new LinuxExecutor({ workspaceRoot: config.workspaceRoot, scratchRoot: join(base, 'scratch'), outputRoot: join(base, 'output'),
        protectedRoots: [config.control.storageRoot, config.catalog.root, config.resources.root, sessionDir, ...(config.protectedRoots ?? [])], rgExecutable: config.rgExecutable })
      await native.preflight()
      services = await config.services?.(binding) ?? { prepare: prepareDocumentFree }
      if (this.closed) fail('conflict', 'Manager closed during startup')
      if (this.operations.pending(actor, binding.conversationId).length) fail('recovery-required', 'A native operation appeared before worker startup')
      const checkpoint = config.control.latestCheckpoint(actor, binding.conversationId)
      worker = await IsolatedPiWorker.create({ workspaceRoot: config.workspaceRoot, agentDir: join(base, 'agent'), sessionDir, outputDir: join(base, 'output'),
        sessionId: binding.runtimeSessionId, native, modelRuntime: config.modelRuntime, models: config.models,
        resources: { store: config.resources, actor, approvalId: config.approvalId }, protectedRoots: [config.control.storageRoot, config.catalog.root, ...(config.protectedRoots ?? [])],
        ...(claim.seal && claim.filename ? { resume: { file: join(sessionDir, claim.filename), seal: claim.seal, ...(checkpoint ? { checkpoint } : {}),
          ...(claim.selectedHead ? { selectedHead: claim.selectedHead } : {}), ...(claim.lineageConfiguration ? { lineageConfiguration: {
            markerEntryId: claim.lineageConfiguration.markerEntryId, configuration: claim.lineageConfiguration.configuration } } : {}) } } : {}),
        ...(services.documents ? { documents: services.documents } : {}),
        ...(services.modelPolicy ? { modelPolicy: services.modelPolicy } : {}),
        authorize: () => { config.catalog.assertClaim(claim); if (config.control.binding(actor, binding.conversationId).bindingId !== binding.bindingId) fail('conflict', 'Binding changed during runtime execution') },
        onSessionFile: file => { if (file !== join(sessionDir, basename(file))) fail('integrity-error', 'Native filename escaped its private directory'); config.catalog.setFile(claim, basename(file)); spawned = true },
      })
      if (this.closed) fail('conflict', 'Manager closed during startup')
      coordinator = new SubmissionCoordinator(config.control, actor, binding.conversationId, worker, services.prepare)
      ownedEpoch = config.control.writerInfo(actor, binding.conversationId)!.epoch
      try { const detach = services.onCoordinator?.(coordinator); if (typeof detach === 'function') detachCoordinator = detach }
      catch { /* Optional product learning must not disable native execution or change durable receipts. */ }
      const controls = new ConversationNativeControls({ control: config.control, operations: this.operations, resources: config.resources, approvalId: config.approvalId,
        actor, binding, coordinator, worker, models: config.models })
      observations = new ConversationObservations(config.control, actor, binding.conversationId, worker, coordinator, () => this.historyAccess(actor, binding.conversationId).snapshot())
      coordinator.recoverQueued()
      this.readonlyObservations.get(binding.conversationId)?.value.dispose()
      this.readonlyObservations.delete(binding.conversationId)
      return { coordinator, observations, worker, native, controls, claim, close: shutdown }
    } catch (error) {
      try { await shutdown() } catch { /* The durable active claim remains fenced when cleanup/integrity cannot be proved. */ }
      throw error
    }
  }
  private releaseClean(claim: RuntimeClaim, sessionDir: string, spawned: boolean, selectedHead: NativeSelectedHead | undefined = claim.selectedHead): void {
    const file = claim.filename ? join(sessionDir, claim.filename) : undefined
    if (file && existsSync(file)) {
      const actual = inspectNativeSession(file, claim.binding.runtimeSessionId, this.options.workspaceRoot, true).seal
      if (!spawned && JSON.stringify(actual) !== JSON.stringify(claim.seal)) fail('integrity-error', 'Unopened native session changed')
      if (selectedHead) verifyNativeSelectedHead(file, this.options.workspaceRoot, selectedHead, { exactFile: true })
      this.options.catalog.release(claim, actual, selectedHead)
    } else {
      if (claim.seal || existsSync(sessionDir) && readdirSync(sessionDir).some(name => name.endsWith('.jsonl'))) fail('integrity-error', 'Native state cannot be discarded during cleanup')
      this.options.catalog.release(claim, null)
    }
  }
}
