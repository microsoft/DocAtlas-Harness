import { randomUUID } from 'node:crypto'
import type { ConversationObservation, ConversationSnapshot, NativeConversationHistory, ObservationCursor, ObservationUpdate, ProductBinding, RuntimeProgress } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { conversationObservationIssues } from '@docatlas/contracts'
import { ControlStore, type ProductActor } from '../storage/control-store.js'
import type { SubmissionCoordinator } from './submission-coordinator.js'
import { ApiError } from '../http/auth.js'

interface ObservedRuntime {
  readonly sessionId: string
  publicHistory(): NativeConversationHistory
  observe(listener: (submissionId: string, progress: RuntimeProgress) => void): () => void
}
export const observationId = (cursor: ObservationCursor): string => `${cursor.streamId}:${cursor.sequence}`
export function parseObservationId(value: string | undefined): ObservationCursor | undefined {
  if (value === undefined) return undefined
  const match = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):(0|[1-9][0-9]{0,15})$/.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new ApiError('invalid-request')
  return { streamId: match[1]!, sequence: Number(match[2]) }
}

/** Observation-only cache. Durable truth remains in ControlStore and the verified Pi transcript. */
export class ConversationObservations {
  private readonly binding: ProductBinding
  private readonly streamId = randomUUID()
  private sequence = 0
  private readonly ring: Array<{ value: ConversationObservation, bytes: number }> = []
  private ringBytes = 0
  private readonly versions = new Map<string, number>()
  private readonly live = new Map<string, ConversationSnapshot['live'][number]>()
  private readonly activity = new Map<string, ConversationSnapshot['activity'][number]>()
  private liveIncomplete = false
  private readonly listeners = new Set<{ event: (event: ConversationObservation) => void, close: () => void }>()
  private readonly cleanup: Array<() => void>
  private disposed = false
  constructor(private readonly store: ControlStore, private readonly actor: ProductActor, conversationId: string,
    private readonly runtime: ObservedRuntime, coordinator: Pick<SubmissionCoordinator, 'subscribe'>,
    private readonly historyProjection?: () => NativeConversationHistory) {
    this.binding = store.binding(actor, conversationId)
    if (this.binding.runtimeSessionId !== runtime.sessionId) throw new ApiError('conflict')
    this.actor = { ...actor }
    this.cleanup = []
    try {
      this.cleanup.push(runtime.observe((submissionId, progress) => this.onProgress(submissionId, progress)))
      this.cleanup.push(coordinator.subscribe(receipt => this.onReceipt(receipt.submissionId)))
    } catch (error) { this.cleanup.forEach(dispose => dispose()); throw error }
  }
  authorize(actor: ProductActor, conversationId = this.binding.conversationId): void {
    if (this.disposed) throw new ApiError('unavailable')
    if (actor.actorId !== this.actor.actorId || actor.workspaceId !== this.actor.workspaceId || conversationId !== this.binding.conversationId) throw new ApiError('not-found')
    const binding = this.store.binding(actor, this.binding.conversationId)
    if (binding.bindingId !== this.binding.bindingId || binding.generation !== this.binding.generation || binding.runtimeSessionId !== this.runtime.sessionId) throw new ApiError('conflict')
  }
  snapshot(actor: ProductActor, before?: string): ConversationSnapshot {
    this.authorize(actor)
    const receipts = this.store.recent(actor, this.binding.conversationId, before)
    const runs = receipts.items.map(receipt => ({ receipt, text: this.store.recoveryInput(actor, receipt.submissionId)?.text ?? null }))
    const history = this.historyProjection?.() ?? this.runtime.publicHistory()
    if (history.checkpoint && history.checkpoint.runtimeSessionId !== this.binding.runtimeSessionId) throw new ApiError('conflict')
    // Same visible-native rule as paging, before original-user redaction. A later empty
    // unavailable user placeholder remains visible; tool/thinking-only entries do not.
    history.messages = history.messages.filter(message => message.text.length > 0 || this.historyProjection && message.role === 'user')
    for (const user of history.messages) if (user.role === 'user' && !this.historyProjection) {
      // Exact native-user association also covers messages outside the recent receipt window.
      // Missing/purged human text must never fall back to model-prepared source injections.
      user.text = this.store.publicUserMessage(actor, this.binding.conversationId, user.entryId) ?? ''; user.truncated = false
    }
    let remaining = 262144
    const selected: NativeConversationHistory['messages'] = []
    for (const message of [...history.messages].reverse()) {
      if (message.text.length > remaining) { history.hasEarlier = true; break }
      selected.push(message); remaining -= message.text.length
    }
    history.messages = selected.reverse()
    const value: ConversationSnapshot = { schemaVersion: 1, kind: 'conversation-snapshot', binding: this.binding, cursor: this.cursor(),
      runs, nextRunsCursor: receipts.nextCursor, history, live: [...this.live.values()], activity: [...this.activity.values()], liveIncomplete: this.liveIncomplete }
    parseContract('conversation-observation', value)
    if (conversationObservationIssues(value).length) throw new ApiError('unavailable')
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new ApiError('limit-exceeded')
    return structuredClone(value)
  }
  subscribe(actor: ProductActor, cursor: ObservationCursor | undefined, event: (event: ConversationObservation) => void, close: () => void): () => void {
    this.authorize(actor)
    if (this.listeners.size >= 16) throw new ApiError('limit-exceeded')
    const listener = { event, close }; this.listeners.add(listener)
    const first = this.ring[0]?.value.cursor.sequence ?? this.sequence + 1
    const reason = !cursor ? 'initial' : cursor.streamId !== this.streamId ? 'epoch' : cursor.sequence < first - 1 || cursor.sequence > this.sequence ? 'gap' : undefined
    try {
      if (reason) event(this.frame({ type: 'resync', reason }))
      else for (const item of this.ring) if (item.value.cursor.sequence > cursor!.sequence) event(structuredClone(item.value))
    } catch { this.listeners.delete(listener); close() }
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.cleanup.forEach(dispose => dispose())
    for (const listener of this.listeners) try { listener.close() } catch { /* Closing a view is non-authoritative. */ }
    this.listeners.clear(); this.ring.length = 0; this.ringBytes = 0; this.live.clear(); this.activity.clear(); this.versions.clear()
  }
  private onReceipt(id: string): void {
    this.authorize(this.actor)
    const receipt = this.store.get(this.actor, id)
    if (receipt.conversationId !== this.binding.conversationId || receipt.generation !== this.binding.generation || receipt.version <= (this.versions.get(id) ?? 0)) return
    this.versions.set(id, receipt.version)
    if (this.versions.size > 1024) this.versions.delete(this.versions.keys().next().value!)
    if (['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(receipt.state)) {
      for (const [key, value] of this.live) if (value.submissionId === id) this.live.delete(key)
      for (const [key, value] of this.activity) if (value.submissionId === id) this.activity.delete(key)
      if (!this.live.size) this.liveIncomplete = false
    }
    this.publish({ type: 'receipt', receipt })
  }
  private onProgress(submissionId: string, candidate: RuntimeProgress): void {
    this.authorize(this.actor)
    const receipt = this.store.get(this.actor, submissionId)
    if (receipt.conversationId !== this.binding.conversationId || receipt.generation !== this.binding.generation || !['running', 'cancelling'].includes(receipt.state)) return
    const progress = parseContract('runtime-progress', candidate)
    if (progress.type === 'resync') {
      for (const [key, value] of this.live) if (value.submissionId === submissionId) this.live.delete(key)
      for (const [key, value] of this.activity) if (value.submissionId === submissionId) this.activity.delete(key)
      this.liveIncomplete = true; this.publish({ type: 'resync', reason: 'overflow' }); return
    }
    if (progress.type === 'text') {
      let message = this.live.get(progress.messageId)
      if (message && message.submissionId !== submissionId) return
      if (!message) {
        if (this.live.size >= 8) { this.live.delete(this.live.keys().next().value!); this.liveIncomplete = true }
        message = { submissionId, messageId: progress.messageId, text: '', truncated: false }; this.live.set(progress.messageId, message)
      }
      const used = [...this.live.values()].reduce((sum, item) => sum + item.text.length, 0)
      let part = progress.delta.slice(0, Math.max(0, 65536 - used))
      if (part.length < progress.delta.length && /[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1)
      message.text += part; message.truncated ||= part.length < progress.delta.length
      this.liveIncomplete ||= message.truncated
    } else {
      const key = `${submissionId}\0${progress.toolCallId}`
      if (this.activity.size >= 64 && !this.activity.has(key)) { this.activity.delete(this.activity.keys().next().value!); this.liveIncomplete = true }
      this.activity.set(key, { submissionId, toolCallId: progress.toolCallId, toolName: progress.toolName, state: progress.type === 'tool-start' ? 'running' : 'ended' })
    }
    this.publish({ type: 'progress', submissionId, progress })
  }
  private cursor(): ObservationCursor { return { streamId: this.streamId, sequence: this.sequence } }
  private frame(update: ObservationUpdate): ConversationObservation { return { schemaVersion: 1, kind: 'conversation-observation', conversationId: this.binding.conversationId, generation: this.binding.generation, cursor: this.cursor(), update } }
  private publish(update: ObservationUpdate): void {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) { this.dispose(); return }
    this.sequence++
    const value = this.frame(update), bytes = Buffer.byteLength(JSON.stringify(value))
    this.ring.push({ value: structuredClone(value), bytes }); this.ringBytes += bytes
    while (this.ring.length > 256 || this.ringBytes > 1024 * 1024) this.ringBytes -= this.ring.shift()!.bytes
    for (const listener of this.listeners) try { listener.event(structuredClone(value)) } catch { this.listeners.delete(listener); try { listener.close() } catch { /* Isolate failed consumers. */ } }
  }
}
