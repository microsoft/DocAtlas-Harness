import { randomUUID } from 'node:crypto'
import { checkpointHistoryPage, NATIVE_HISTORY_MESSAGE_CHARS, NATIVE_HISTORY_PAGE_CHARS } from '@docatlas/runtime-pi/worker'
import { productHistoryIssues, type ProductBinding, type ProductHistoryMessage, type ProductHistoryPage, type ProductPiCheckpoint } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { ApiError } from '../http/auth.js'
import { ControlStore, type ProductActor } from '../storage/control-store.js'

/** Private host path capability, never supplied by a browser or stored in a public cursor. */
export type HistoryCheckpointFile = (binding: Readonly<ProductBinding>, checkpoint: Readonly<ProductPiCheckpoint>) => string | Promise<string>
export type ConversationHistoryPage = ProductHistoryPage
export interface ProjectedHistoryPages { page(actor: ProductActor, cursor?: string): Promise<ProductHistoryPage> }
interface HistoryCursor {
  ownerActorId: string
  workspaceId: string
  bindingId: string
  generation: number
  runtimeSessionId: string
  transcriptHash: string
  prefixBytes: number
  leafEntryId: string
  checkpoint: string
  beforeEntryId: string
  expiresAt: number
}
const CURSOR_TTL_MS = 300000, MAX_CURSORS = 128
const seal = (checkpoint: ProductPiCheckpoint) => JSON.stringify([
  checkpoint.schemaVersion, checkpoint.kind, checkpoint.submissionId, checkpoint.requestHash, checkpoint.runtimeSessionId,
  checkpoint.userEntryId, checkpoint.leafEntryId, checkpoint.transcriptHash, checkpoint.byteLength, checkpoint.entryCount, checkpoint.settledAt,
])

/** Read-only host pagination. Its cursor cache is not conversation storage or execution authority.
 * Only ControlStore's completed checkpoint chooses the head; no SDK/model startup or task replay.
 */
export class ConversationHistory {
  private readonly actor: ProductActor
  private readonly binding: ProductBinding
  private readonly cursors = new Map<string, HistoryCursor>()
  private reads = 0
  private disposed = false
  constructor(private readonly store: ControlStore, actor: ProductActor, conversationId: string,
    private readonly checkpointFile: HistoryCheckpointFile, private readonly clock: () => number = Date.now, private readonly projected?: ProjectedHistoryPages) {
    this.actor = { ...actor }
    this.binding = structuredClone(store.binding(this.actor, conversationId))
  }

  async page(actor: ProductActor, cursor?: string): Promise<ConversationHistoryPage> {
    this.authorize(actor)
    if (this.projected) return this.projected.page(actor, cursor)
    const now = this.now()
    for (const [key, entry] of this.cursors) if (entry.expiresAt <= now) this.cursors.delete(key)
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^history:[a-f0-9-]{36}$/u.test(cursor))) throw new ApiError('invalid-request')
    const checkpoint = this.currentCheckpoint(actor)
    if (!checkpoint) {
      if (cursor !== undefined) throw new ApiError('conflict')
      return this.valid({ schemaVersion: 1, kind: 'history-page', binding: structuredClone(this.binding), checkpoint: null, messages: [], hasEarlier: false, nextCursor: null })
    }
    const previous = cursor === undefined ? undefined : this.cursors.get(cursor)
    if (cursor !== undefined && (!previous || !this.matches(previous, checkpoint, now))) throw new ApiError('conflict')
    if (this.reads >= 4) throw new ApiError('limit-exceeded')
    this.reads++
    try {
      let file: string
      try { file = await this.checkpointFile(structuredClone(this.binding), structuredClone(checkpoint)) }
      catch (error) { this.assertHead(actor, checkpoint); if (error instanceof ApiError) throw error; throw new ApiError('unavailable') }
      this.assertHead(actor, checkpoint)
      if (previous && !this.matches(previous, checkpoint, this.now())) throw new ApiError('conflict')
      if (typeof file !== 'string') throw new ApiError('unavailable')
      let projection: ReturnType<typeof checkpointHistoryPage>
      try { projection = checkpointHistoryPage(file, checkpoint, previous?.beforeEntryId) }
      catch { throw new ApiError('unavailable') }
      this.assertHead(actor, checkpoint)
      if (previous && !this.matches(previous, checkpoint, this.now())) throw new ApiError('conflict')
      if (seal(projection.checkpoint) !== seal(checkpoint)) throw new ApiError('unavailable')
      let remaining = NATIVE_HISTORY_PAGE_CHARS, hasEarlier = projection.hasEarlier
      const selected: ProductHistoryMessage[] = []
      for (const message of [...projection.messages].reverse()) {
        const original = message.role === 'user' ? this.store.publicUserMessage(actor, this.binding.conversationId, message.entryId) : undefined
        const display: ProductHistoryMessage = message.role === 'assistant' ? { ...message, displayOrigin: 'native' }
          : { ...message, text: typeof original === 'string' ? original : '', truncated: false, displayOrigin: typeof original === 'string' ? 'submission' : 'unavailable' }
        if (display.text.length > NATIVE_HISTORY_MESSAGE_CHARS) throw new ApiError('unavailable')
        if (display.text.length > remaining) { hasEarlier = true; break }
        remaining -= display.text.length
        selected.push(display)
      }
      const messages = selected.reverse()
      this.assertHead(actor, checkpoint)
      let nextCursor: string | null = null
      if (hasEarlier) {
        const oldest = messages[0]
        if (!oldest) throw new ApiError('unavailable')
        if (this.cursors.size >= MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value!)
        nextCursor = `history:${randomUUID()}`
        this.cursors.set(nextCursor, { ownerActorId: this.actor.actorId, workspaceId: this.actor.workspaceId, bindingId: this.binding.bindingId,
          generation: this.binding.generation, runtimeSessionId: this.binding.runtimeSessionId, transcriptHash: checkpoint.transcriptHash,
          prefixBytes: checkpoint.byteLength, leafEntryId: checkpoint.leafEntryId, checkpoint: seal(checkpoint), beforeEntryId: oldest.entryId, expiresAt: this.now() + CURSOR_TTL_MS })
      }
      return this.valid({ schemaVersion: 1, kind: 'history-page', binding: this.binding, checkpoint: projection.checkpoint, messages, hasEarlier, nextCursor })
    } finally { this.reads-- }
  }

  dispose(): void { this.disposed = true; this.cursors.clear() }
  private valid(value: ProductHistoryPage): ProductHistoryPage {
    parseContract('product-history', value)
    if (productHistoryIssues(value).length || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new ApiError('unavailable')
    return structuredClone(value)
  }
  private authorize(actor: ProductActor): void {
    if (this.disposed) throw new ApiError('unavailable')
    if (actor.actorId !== this.actor.actorId || actor.workspaceId !== this.actor.workspaceId) throw new ApiError('not-found')
    const current = this.store.binding(actor, this.binding.conversationId)
    if (current.bindingId !== this.binding.bindingId || current.generation !== this.binding.generation || current.runtimeSessionId !== this.binding.runtimeSessionId
      || current.ownerActorId !== this.binding.ownerActorId || current.workspaceId !== this.binding.workspaceId) throw new ApiError('conflict')
  }
  private currentCheckpoint(actor: ProductActor): ProductPiCheckpoint | undefined {
    const checkpoint = this.store.latestCheckpoint(actor, this.binding.conversationId)
    if (checkpoint && checkpoint.runtimeSessionId !== this.binding.runtimeSessionId) throw new ApiError('conflict')
    return checkpoint
  }
  private assertHead(actor: ProductActor, expected: ProductPiCheckpoint): void {
    this.authorize(actor)
    const current = this.currentCheckpoint(actor)
    if (!current || seal(current) !== seal(expected)) throw new ApiError('conflict')
  }
  private matches(cursor: HistoryCursor, checkpoint: ProductPiCheckpoint, now: number): boolean {
    return cursor.ownerActorId === this.actor.actorId && cursor.workspaceId === this.actor.workspaceId && cursor.bindingId === this.binding.bindingId
      && cursor.generation === this.binding.generation && cursor.runtimeSessionId === this.binding.runtimeSessionId
      && cursor.transcriptHash === checkpoint.transcriptHash && cursor.prefixBytes === checkpoint.byteLength && cursor.leafEntryId === checkpoint.leafEntryId
      && cursor.checkpoint === seal(checkpoint) && cursor.expiresAt > now
  }
  private now(): number {
    const value = this.clock()
    if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('unavailable')
    return value
  }
}
