import { randomUUID } from 'node:crypto'
import type { ProductPreparedSubmission, ProductRunReceipt, ProductSubmission } from '@docatlas/contracts'
import type { ProductRuntimeDriver, RuntimeOutcome } from '@docatlas/runtime-pi'
import { ControlStore, ControlStoreError, type ProductActor, type WriterLease } from '../storage/control-store.js'

export type PrepareSubmission = (input: { request: ProductSubmission, receipt: ProductRunReceipt, signal: AbortSignal }) => Promise<{ prepared: ProductPreparedSubmission, modelText: string, onConsumed?: () => void }>
interface Task { receipt: ProductRunReceipt, controller: AbortController, enqueued: boolean, promise?: Promise<void> }
export interface NativeWorkContext { signal: AbortSignal, writer(): WriterLease, resume(): void }
interface NativeTask { controller: AbortController, promise?: Promise<void> }

/** One actor/conversation dispatcher. Durable state is in ControlStore, not this in-memory queue. */
export class SubmissionCoordinator {
  private lease: WriterLease
  private readonly tasks = new Map<string, Task>()
  private readonly timer: ReturnType<typeof setInterval>
  private paused = false
  private closed = false
  private pumping = false
  private fatal: unknown
  private fencing: Promise<void> | undefined
  private readonly waiters = new Set<() => void>()
  private readonly observers = new Set<(receipt: ProductRunReceipt) => void>()
  private nativeTask: NativeTask | undefined
  private nativeBarrier = false
  private handoffAdmission = false
  private stopping: Promise<void> | undefined

  constructor(private readonly store: ControlStore, private readonly actor: ProductActor, private readonly conversationId: string,
    private readonly runtime: ProductRuntimeDriver, private readonly prepare: PrepareSubmission,
    private readonly observe: (receipt: ProductRunReceipt) => void = () => {}, private readonly ttlMs = 30_000) {
    const binding = store.binding(actor, conversationId)
    if (binding.runtimeSessionId !== runtime.sessionId) throw new Error('Runtime does not match the product binding')
    this.lease = store.acquireWriter(actor, conversationId, `worker:${randomUUID()}`, ttlMs)
    this.paused = store.pending(actor, conversationId).some(item => item.state === 'outcome-unknown')
    this.timer = setInterval(() => {
      try { this.lease = store.heartbeat(this.lease, ttlMs) }
      catch (error) { this.fence(error) }
    }, Math.max(25, Math.floor(ttlMs / 3)))
    this.timer.unref()
  }

  submit(request: ProductSubmission): { receipt: ProductRunReceipt, replayed: boolean } {
    if (this.closed || this.fatal) throw new Error('Submission coordinator is unavailable')
    if (this.stopping) throw new ControlStoreError('conflict', 'Execution is still joining after stop')
    if (this.handoffAdmission) throw new ControlStoreError('conflict', 'Native lineage handoff is changing the conversation binding')
    if (request.conversationId !== this.conversationId) throw new Error('Submission belongs to another conversation')
    const accepted = this.store.accept(this.actor, request)
    this.notify(accepted.receipt)
    if (['accepted', 'preparing', 'ready'].includes(accepted.receipt.state)) {
      if (this.paused && !this.nativeBarrier && !this.nativeTask && !this.runtime.busy && !this.store.pending(this.actor, this.conversationId).some(item => item.state === 'outcome-unknown')) {
        this.runtime.resume(); this.paused = false
      }
      this.schedule(accepted.receipt)
    }
    return accepted
  }
  subscribe(listener: (receipt: ProductRunReceipt) => void): () => void {
    if (this.observers.size >= 32) throw new Error('Receipt observer limit reached')
    this.observers.add(listener); return () => { this.observers.delete(listener) }
  }

  get busy(): boolean { return Boolean(this.stopping) || Boolean(this.nativeTask) || this.runtime.busy || [...this.tasks.values()].some(task => Boolean(task.promise)) }
  get queued(): number { return [...this.tasks.values()].filter(task => !task.enqueued).length }
  get nativeBlocked(): boolean { return this.nativeBarrier }

  /** Host-only startup hook, before recoverQueued. No writer transfer or native execution. */
  initializeNative(recover: (lease: WriterLease) => boolean): void {
    if (this.closed || this.fatal || this.tasks.size || this.nativeTask) throw new ControlStoreError('conflict', 'Native recovery must precede dispatch')
    this.store.verifyWriter(this.lease)
    this.nativeBarrier = recover(this.lease)
  }

  /** One native operation uses the same writer and cancellation/join lifecycle as questions.
   * Acceptance is synchronous under the barrier; execution is deferred until after its durable receipt.
   * A true result means unresolved durable native state still blocks dispatch.
   */
  runNative<T>(accept: (lease: WriterLease) => T, execute: (accepted: T, context: NativeWorkContext) => Promise<boolean>, recovery = false, handoff = false): T {
    if (this.closed || this.fatal || this.busy || !recovery && (this.nativeBarrier || this.tasks.size
      || this.store.pending(this.actor, this.conversationId).some(item => item.state === 'outcome-unknown')) || this.handoffAdmission && !handoff) throw new ControlStoreError('conflict', 'Native controls require an idle reconciled runtime')
    this.store.verifyWriter(this.lease)
    const wasBlocked = this.nativeBarrier
    const wasHandoff = this.handoffAdmission
    this.nativeBarrier = true
    if (handoff) this.handoffAdmission = true
    let value: T
    try { value = accept(this.lease) }
    catch (error) { this.nativeBarrier = wasBlocked; this.handoffAdmission = wasHandoff; throw error }
    const task: NativeTask = { controller: new AbortController() }
    this.nativeTask = task
    const context: NativeWorkContext = { signal: task.controller.signal, writer: () => {
      if (this.fatal) throw new ControlStoreError('stale-writer', 'Native operation writer is fenced')
      this.store.verifyWriter(this.lease); return this.lease
    }, resume: () => {
      task.controller.signal.throwIfAborted()
      if (this.stopping) throw new ControlStoreError('conflict', 'Native effects are still joining after stop')
      this.store.verifyWriter(this.lease)
      if (this.paused) {
        if (this.store.pending(this.actor, this.conversationId).some(item => item.state === 'outcome-unknown')) throw new ControlStoreError('recovery-required', 'Question outcome is unresolved')
        this.runtime.resume(); this.paused = false
      }
    } }
    task.promise = Promise.resolve().then(() => execute(value, context)).then(blocked => { this.nativeBarrier = blocked; if (!blocked) this.handoffAdmission = false })
      .catch(error => { this.nativeBarrier = true; this.fence(error) }).finally(() => {
        if (this.nativeTask === task) this.nativeTask = undefined
        this.notifyIdle(); queueMicrotask(() => this.pump())
      })
    return value
  }

  /** Load durable pre-dispatch requests on startup; never re-dispatch unknown/active records. */
  recoverQueued(): void {
    const receipts = this.store.pending(this.actor, this.conversationId)
    if (receipts.some(item => item.state === 'outcome-unknown')) this.paused = true
    for (const receipt of receipts) if (['accepted', 'preparing', 'ready'].includes(receipt.state)) this.schedule(receipt)
  }

  cancel(): Promise<void> {
    if (this.stopping) return this.stopping
    const completion = Promise.withResolvers<void>()
    this.stopping = completion.promise
    // Reserve before abort callbacks or driver.stop can reenter application code.
    void this.stopExecution().then(() => {
      if (this.stopping === completion.promise) this.stopping = undefined
      this.notifyIdle(); completion.resolve()
    }, error => { this.fatal = error; this.notifyIdle(); completion.reject(error) })
    return completion.promise
  }
  private async stopExecution(): Promise<void> {
    this.paused = true
    const nativeTask = this.nativeTask
    nativeTask?.controller.abort()
    let controlFailure: unknown
    for (const task of this.tasks.values()) {
      task.controller.abort()
      try {
        const receipt = this.store.get(this.actor, task.receipt.submissionId)
        if (!['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(receipt.state)) this.notify(this.store.requestCancel(this.actor, receipt.submissionId, receipt.version))
      } catch (error) { controlFailure ??= error }
    }
    await this.runtime.stop()
    await Promise.all([...this.tasks.values()].map(task => task.promise).concat(nativeTask?.promise))
    this.tasks.clear()
    if (controlFailure) throw controlFailure // Receipt failure never skips the actual execution join.
  }

  async waitForIdle(): Promise<void> {
    if (this.fatal) throw this.fatal
    if (!this.stopping && !this.nativeTask && (!this.tasks.size || ((this.paused || this.nativeBarrier) && ![...this.tasks.values()].some(task => task.promise))) && !this.runtime.busy) return
    await new Promise<void>(resolve => this.waiters.add(resolve))
    if (this.fatal) throw this.fatal
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    await this.cancel()
    await this.fencing
    if (!this.fatal) this.store.releaseWriter(this.lease)
  }

  private schedule(receipt: ProductRunReceipt): void {
    if (this.tasks.has(receipt.submissionId)) return
    this.tasks.set(receipt.submissionId, { receipt, controller: new AbortController(), enqueued: false })
    queueMicrotask(() => this.pump())
  }
  private pump(): void {
    if (this.pumping || this.stopping || this.paused || this.nativeBarrier || this.nativeTask || this.closed || this.fatal) return
    this.pumping = true
    try {
      for (const task of this.tasks.values()) {
        if (task.promise) { if (!task.enqueued) break; continue }
        const busy = this.runtime.busy || [...this.tasks.values()].some(item => item !== task && item.promise)
        if (task.receipt.mode === 'prompt' && busy) continue
        task.promise = this.execute(task).catch(error => { this.fence(error) }).finally(() => {
          this.tasks.delete(task.receipt.submissionId); this.notifyIdle(); queueMicrotask(() => this.pump())
        })
        break // Keep preparation/admission order; already-enqueued native runs may still execute concurrently.
      }
    } finally { this.pumping = false }
  }

  private async execute(task: Task): Promise<void> {
    const id = task.receipt.submissionId
    let dispatched = false
    try {
      let receipt = this.store.get(this.actor, id)
      if (receipt.state === 'cancelled') return
      if (receipt.state === 'accepted' || receipt.state === 'ready') receipt = this.change(receipt, 'preparing')
      const request = this.store.recoveryInput(this.actor, id)
      if (!request) throw new Error('Missing durable submission input')
      const prepared = await this.prepare({ request, receipt, signal: task.controller.signal })
      if (task.controller.signal.aborted || this.paused || this.fatal) return
      receipt = this.change(receipt, 'ready', { prepared: prepared.prepared })
      receipt = this.change(receipt, 'dispatching'); dispatched = true
      const admitted = this.store.executionInput(this.lease, id)
      const completion = this.runtime.submit({ ...admitted, receipt, modelText: prepared.modelText }, () => {
        if (this.fatal) throw new Error('Writer is fenced')
        prepared.onConsumed?.()
        const current = this.store.get(this.actor, id)
        if (current.state === 'dispatching') this.change(current, 'running')
      })
      task.enqueued = true
      queueMicrotask(() => this.pump())
      const outcome = await completion
      if (!this.fatal) this.finish(id, outcome)
    } catch (error) {
      if (this.fatal) return
      const current = this.store.get(this.actor, id)
      if (['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(current.state)) return
      if (task.controller.signal.aborted && !dispatched) return
      this.change(current, dispatched ? 'outcome-unknown' : 'failed', { errorCode: dispatched ? 'execution-interrupted' : 'preparation-failed' })
      if (dispatched) this.paused = true
      void error // Error payloads are not forwarded as uncontrolled browser/provider data.
    }
  }

  private finish(id: string, outcome: RuntimeOutcome): void {
    let current = this.store.get(this.actor, id)
    if (['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(current.state)) return
    if (outcome.kind === 'completed') this.change(current, 'completed', { checkpoint: outcome.checkpoint })
    else if (outcome.kind === 'cancelled') {
      if (current.state !== 'cancelling') current = this.store.requestCancel(this.actor, id, current.version)
      if (current.state === 'cancelling') this.change(current, 'cancelled')
    } else {
      this.change(current, outcome.kind === 'unknown' ? 'outcome-unknown' : 'failed', { errorCode: outcome.errorCode })
      if (outcome.kind === 'unknown') this.paused = true
    }
  }
  private change(receipt: ProductRunReceipt, state: Parameters<ControlStore['transition']>[3], detail?: Parameters<ControlStore['transition']>[4]): ProductRunReceipt {
    const next = this.store.transition(this.lease, receipt.submissionId, receipt.version, state, detail)
    this.notify(next); return next
  }
  private fence(error: unknown): void {
    if (this.fencing) return
    this.fatal = error; this.paused = true; clearInterval(this.timer)
    this.fencing = (async () => {
      const nativeTask = this.nativeTask
      nativeTask?.controller.abort()
      for (const task of this.tasks.values()) task.controller.abort()
      await (this.stopping ?? this.runtime.stop())
      await Promise.all([...this.tasks.values()].map(task => task.promise).concat(nativeTask?.promise))
      const writer = this.store.writerInfo(this.actor, this.conversationId)
      if (writer?.epoch === this.lease.epoch) this.store.recoverAfterExecutionStopped(this.actor, this.conversationId, this.lease.epoch)
      this.tasks.clear(); this.notifyIdle()
    })().catch(stopError => { this.fatal = stopError; this.notifyIdle() })
  }
  private notify(receipt: ProductRunReceipt): void {
    try { this.observe(receipt) } catch { /* Projections cannot roll back committed state. */ }
    for (const listener of this.observers) try { listener(receipt) } catch { /* Only the store owns receipt truth. */ }
  }
  private notifyIdle(): void {
    if (!this.fatal && (this.stopping || this.nativeTask || this.runtime.busy || (this.tasks.size && (!(this.paused || this.nativeBarrier) || [...this.tasks.values()].some(task => task.promise))))) return
    for (const resolve of this.waiters) resolve(); this.waiters.clear()
  }
}

/** Explicit no-document preparation for the first live chat lane; never fabricates source admission. */
export const prepareDocumentFree: PrepareSubmission = async ({ request, receipt, signal }) => {
  if (signal.aborted) throw new Error('Preparation cancelled')
  if (request.sourceRefs.length || request.selectionContextIds.length) throw new Error('Document admission service is required for this submission')
  return { modelText: request.text, prepared: { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId,
    requestHash: receipt.requestHash, bindingGeneration: receipt.generation, scopeVersionId: null, sourceRefs: [], selectionContextIds: [] } }
}
