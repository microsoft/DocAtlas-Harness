import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@earendil-works/pi-ai'
import type { ProductPiCheckpoint, ProductPreparedSubmission, ProductRunError, ProductRunReceipt, ProductSubmission, RuntimeProgress } from '@docatlas/contracts'
import { checkpointPiSubmission } from './checkpoint.js'

export interface RuntimeExecutionBoundary { readonly activeCount: number, abortAll(): Promise<void>, resume(): void }
export interface RuntimeSubmission { request: ProductSubmission, receipt: ProductRunReceipt, prepared: ProductPreparedSubmission, modelText: string }
export type RuntimeOutcome = { kind: 'completed', checkpoint: ProductPiCheckpoint } | { kind: 'cancelled' } | { kind: 'failed' | 'unknown', errorCode: ProductRunError }
export type { RuntimeProgress } from '@docatlas/contracts'
export interface ProductRuntimeDriver {
  readonly sessionId: string
  readonly busy: boolean
  submit(input: RuntimeSubmission, consumed: () => void, progress?: (event: RuntimeProgress) => void): Promise<RuntimeOutcome>
  stop(): Promise<void>
  resume(): void
}
interface Pending {
  input: RuntimeSubmission
  message?: UserMessage
  consumed: boolean
  accepted: boolean
  forcedOutcome?: RuntimeOutcome
  onConsumed: () => void
  progress?: (event: RuntimeProgress) => void
  resolve: (outcome: RuntimeOutcome) => void
}

/** Maps product submissions to real native messages; Pi still owns every model/tool/retry loop. */
export class PiProductDriver implements ProductRuntimeDriver {
  private readonly pending = new Map<string, Pending>()
  private readonly messages = new Map<object, Pending>()
  private readonly nativeRuns = new Set<Promise<void>>()
  private admission: Promise<void> = Promise.resolve()
  private stopped = false
  private stopping: Promise<void> | undefined
  private readonly unsubscribe: () => void
  private focused: Pending | undefined
  private messageId = `live:${randomUUID()}`

  constructor(private readonly session: AgentSession, private readonly boundary: RuntimeExecutionBoundary,
    private readonly observe: (event: RuntimeProgress) => void = () => {}, private readonly checkpointTime: () => Date = () => new Date()) {
    this.unsubscribe = session.subscribe(event => this.onEvent(event))
  }
  get sessionId(): string { return this.session.sessionId }
  get busy(): boolean { return this.pending.size > 0 || !this.session.isIdle }

  submit(input: RuntimeSubmission, consumed: () => void, progress?: (event: RuntimeProgress) => void): Promise<RuntimeOutcome> {
    if (this.stopped) return Promise.resolve({ kind: 'failed', errorCode: 'runtime-rejected' })
    if (this.pending.has(input.receipt.submissionId)) throw new Error('Submission already admitted to Pi')
    let settle!: (outcome: RuntimeOutcome) => void
    const completion = new Promise<RuntimeOutcome>(resolve => { settle = resolve })
    const pending: Pending = { input, consumed: false, accepted: false, onConsumed: consumed, resolve: settle, ...(progress ? { progress } : {}) }
    this.pending.set(input.receipt.submissionId, pending)
    const admission = this.admission.then(() => this.admit(pending))
    this.admission = admission.catch(() => {
      if (!this.stopped) this.finish(pending, { kind: 'unknown', errorCode: 'execution-interrupted' })
    })
    return completion
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    this.session.clearQueue()
    this.session.abortBash()
    const boundaryStop = this.boundary.abortAll()
    this.stopping = (async () => {
      await this.session.abort()
      await this.admission
      this.session.clearQueue()
      this.session.abortBash()
      await Promise.all([this.session.abort(), boundaryStop, ...this.nativeRuns])
      if (this.boundary.activeCount !== 0 || !this.session.isIdle) throw new Error('Runtime execution has not stopped')
      for (const pending of this.pending.values()) this.finish(pending, pending.forcedOutcome ?? { kind: 'cancelled' })
    })()
    return this.stopping
  }
  resume(): void {
    if (this.busy || this.boundary.activeCount) throw new Error('Cannot resume an active runtime')
    this.boundary.resume(); this.stopping = undefined; this.stopped = false
  }
  async dispose(): Promise<void> { await this.stop(); this.unsubscribe() }

  private async admit(pending: Pending): Promise<void> {
    if (this.stopped || !this.pending.has(pending.input.receipt.submissionId)) return
    if (pending.input.request.mode === 'prompt' || this.session.isCompacting) await this.session.waitForIdle()
    if (this.stopped) return
    let release!: () => void
    const preflight = new Promise<void>(resolve => { release = resolve })
    let accepted = false
    const run = this.session.prompt(pending.input.modelText, {
      source: 'rpc',
      ...(pending.input.request.mode === 'prompt' ? {} : { streamingBehavior: pending.input.request.mode === 'steer' ? 'steer' as const : 'followUp' as const }),
      onUserMessage: message => {
        if (this.stopped) throw new Error('Submission stopped before native admission')
        pending.message = message; this.messages.set(message, pending)
      },
      preflightResult: success => {
        accepted = success; pending.accepted = success; release()
        if (this.stopped) throw new Error('Submission stopped during preflight')
      },
    })
    const tracked = run.catch(() => {
      if (!this.stopped) this.finish(pending, { kind: pending.consumed ? 'unknown' : 'failed', errorCode: pending.consumed ? 'execution-interrupted' : 'runtime-rejected' })
    }).finally(() => { release(); this.nativeRuns.delete(tracked); queueMicrotask(() => this.checkUnconsumed()) })
    this.nativeRuns.add(tracked)
    await preflight
    if (!accepted && !this.stopped) this.finish(pending, { kind: 'failed', errorCode: 'runtime-rejected' })
    if (accepted && !pending.message && !this.stopped) {
      // Extension-handled input may have side effects; do not invent a user entry or saved success.
      this.finish(pending, { kind: 'unknown', errorCode: 'runtime-rejected' })
    }
  }

  private onEvent(event: AgentSessionEvent): void {
    if (event.type === 'message_start' && event.message.role === 'user') {
      const pending = this.messages.get(event.message)
      if (pending && !pending.consumed) {
        pending.consumed = true
        this.focused = pending
        try { pending.onConsumed() } catch { void this.stop().catch(() => {}) }
      }
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') this.messageId = `live:${randomUUID()}`
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta
      this.notify(delta.length <= 8192 ? { type: 'text', messageId: this.messageId, delta } : { type: 'resync' })
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') this.notify(event.toolName.length > 0 && event.toolName.length <= 128 && event.toolCallId.length > 0 && event.toolCallId.length <= 256
      ? { type: event.type === 'tool_execution_start' ? 'tool-start' : 'tool-end', toolName: event.toolName, toolCallId: event.toolCallId } : { type: 'resync' })
    if (event.type === 'agent_settled' && !this.stopped) this.flushSettled()
  }

  private flushSettled(): void {
    for (const pending of this.pending.values()) {
      if (!pending.consumed || !pending.message) continue // May still be waiting for serialized preflight.
      const entry = this.session.sessionManager.getBranch().find(item => item.type === 'message' && item.message === pending.message)
      if (!entry) { this.finish(pending, { kind: 'unknown', errorCode: 'checkpoint-failed' }); continue }
      const last = this.session.messages.findLast(message => message.role === 'assistant')
      if (last?.role !== 'assistant' || last.stopReason !== 'stop') {
        this.finish(pending, { kind: 'failed', errorCode: 'runtime-failed' }); continue
      }
      try {
        const content = pending.message.content
        const expectedText = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        const checkpoint = checkpointPiSubmission(this.session, { submissionId: pending.input.receipt.submissionId,
          requestHash: pending.input.receipt.requestHash, userEntryId: entry.id, expectedText, now: this.checkpointTime })
        this.finish(pending, { kind: 'completed', checkpoint })
      } catch { this.finish(pending, { kind: 'unknown', errorCode: 'checkpoint-failed' }) }
    }
  }
  private checkUnconsumed(): void {
    if (this.stopped || this.nativeRuns.size || !this.session.isIdle) return
    let found = false
    for (const pending of this.pending.values()) if (pending.accepted && pending.message && !pending.consumed) {
      pending.forcedOutcome = { kind: 'unknown', errorCode: 'execution-interrupted' }; found = true
    }
    if (found) void this.stop().catch(() => {}) // Clear stranded native queues only through verified stop; never replay them.
  }
  private finish(pending: Pending, outcome: RuntimeOutcome): void {
    if (!this.pending.delete(pending.input.receipt.submissionId)) return
    if (pending.message) this.messages.delete(pending.message)
    if (this.focused === pending) this.focused = undefined
    pending.resolve(outcome)
  }
  private notify(event: RuntimeProgress): void {
    try { this.observe(event) } catch { /* Observation is not execution or durability. */ }
    try { this.focused?.progress?.(event) } catch { /* A view cannot abort native work. */ }
  }
}
