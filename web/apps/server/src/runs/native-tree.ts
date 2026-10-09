import { randomUUID } from 'node:crypto'
import { nativeLineageIssues, nativeSelectedHeadEqual, type NativeHistoryOrigin, type NativeSelectedHead, type ProductBinding,
  type ProductNativeTreeEntry, type ProductNativeTreePage, type ProductNativeTreeRequest } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { verifyNativeFileSeal, verifyNativeSelectedHead } from '@docatlas/runtime-pi/worker'
import { canonical, ControlStore, type ProductActor } from '../storage/control-store.js'
import { ApiError } from '../http/auth.js'
import type { HistoricalMessageOrigin } from './lineage-history.js'

type Entry = Record<string, unknown>
interface Cursor { head: string, view: ProductNativeTreeRequest['view'], offset: number, expiresAt: number }
export interface NativeTreeOptions {
  control: ControlStore
  actor: ProductActor
  binding: ProductBinding
  cwd: string
  head(): Promise<NativeSelectedHead>
  file(): string
  origins(head: NativeSelectedHead, entryIds: readonly string[]): Map<string, HistoricalMessageOrigin[]>
  clock?(): number
}
const MAX_PAGE = 100, CURSOR_TTL = 300000, MAX_CURSORS = 128
const object = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value)
function clipped(value: string, limit: number): string {
  const prefix = value.slice(0, limit)
  return /[\uD800-\uDBFF]$/u.test(prefix) ? prefix.slice(0, -1) : prefix
}
function kind(entry: Entry): ProductNativeTreeEntry['type'] {
  if (entry.type === 'message' && object(entry.message)) {
    if (entry.message.role === 'user' || entry.message.role === 'assistant') return entry.message.role
    if (entry.message.role === 'toolResult') return 'tool-result'
  }
  if (entry.type === 'compaction') return 'compaction'
  if (entry.type === 'branch_summary') return 'branch-summary'
  if (entry.type === 'custom_message') return 'custom-message'
  return entry.type === 'label' ? 'label' : 'metadata'
}
function assistantText(entry: Entry): string {
  const content = object(entry.message) ? entry.message.content : undefined
  if (typeof content === 'string') return clipped(content, 1000)
  if (!Array.isArray(content)) return ''
  let value = ''
  for (const block of content) {
    if (!object(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    value += `${value ? '\n' : ''}${clipped(block.text, 1000 - value.length)}`
    if (value.length >= 1000) break
  }
  return clipped(value, 1000)
}
const reference = (origin: HistoricalMessageOrigin): NativeHistoryOrigin => ({ conversationId: origin.binding.conversationId, bindingId: origin.binding.bindingId,
  generation: origin.binding.generation, runtimeSessionId: origin.binding.runtimeSessionId, entryId: origin.entryId })

/** Read-only native tree projection. Cursors are process-local and bind the exact
 * full native file, selected branch, actor, generation and view. Never return
 * SDK editor text, prepared user messages, tools/thinking or summary bodies.
 */
export class NativeConversationTree {
  private readonly options: NativeTreeOptions
  private readonly cursors = new Map<string, Cursor>()
  private reading = 0
  private disposed = false
  constructor(options: NativeTreeOptions) { this.options = { ...options, actor: { ...options.actor }, binding: structuredClone(options.binding) } }
  async page(actor: ProductActor, candidate: ProductNativeTreeRequest): Promise<ProductNativeTreePage> {
    this.authorize(actor)
    const parsed = parseContract('native-lineage', candidate)
    if (!('kind' in parsed) || parsed.kind !== 'native-tree-request' || nativeLineageIssues(parsed).length) throw new ApiError('invalid-request')
    const request = structuredClone(parsed), now = this.now()
    if (request.expectedGeneration !== this.options.binding.generation) throw new ApiError('conflict')
    for (const [key, cursor] of this.cursors) if (cursor.expiresAt <= now) this.cursors.delete(key)
    if (request.cursor !== null && !/^tree:[a-f0-9-]{36}$/u.test(request.cursor)) throw new ApiError('invalid-request')
    const previous = request.cursor ? this.cursors.get(request.cursor) : undefined
    if (request.cursor && (!previous || previous.view !== request.view)) throw new ApiError('conflict')
    if (this.reading >= 4) throw new ApiError('limit-exceeded')
    this.reading++
    try {
      const head = await this.options.head()
      this.authorize(actor)
      if (head.fileSeal.sessionId !== this.options.binding.runtimeSessionId || previous && (previous.head !== canonical(head) || previous.expiresAt <= this.now())) throw new ApiError('conflict')
      const file = this.options.file()
      verifyNativeSelectedHead(file, this.options.cwd, head, { exactFile: true })
      const native = verifyNativeFileSeal(file, this.options.cwd, head.fileSeal, { exactFile: true })
      const byId = new Map(native.entries.map(entry => [entry.id, entry])), selected = new Set<unknown>()
      let selectedId: unknown = head.selectedLeafEntryId
      while (selectedId !== null) {
        const entry = byId.get(selectedId)
        if (!entry || selected.has(selectedId)) throw new ApiError('unavailable')
        selected.add(selectedId); selectedId = entry.parentId
      }
      const children = new Map<string | null, Entry[]>(), labels = new Map<string, string>()
      for (const entry of native.entries) {
        if (typeof entry.id !== 'string' || entry.parentId !== null && typeof entry.parentId !== 'string') throw new ApiError('unavailable')
        const siblings = children.get(entry.parentId) ?? []; siblings.push(entry); children.set(entry.parentId, siblings)
        if (entry.type !== 'label') continue
        if (typeof entry.targetId !== 'string' || entry.label !== undefined && entry.label !== null && typeof entry.label !== 'string') throw new ApiError('unavailable')
        if (typeof entry.label === 'string' && entry.label) labels.set(entry.targetId, clipped(entry.label, 256)); else labels.delete(entry.targetId)
      }
      const stack = [...(children.get(null) ?? [])].reverse().map(entry => ({ entry, depth: 0 })), window: Array<{ entry: Entry, depth: number, type: ProductNativeTreeEntry['type'] }> = []
      let offset = 0, hasNext = false
      while (stack.length) {
        const value = stack.pop()!, type = kind(value.entry)
        if (request.view === 'all' || type === 'user' || type === 'assistant') {
          if (offset >= (previous?.offset ?? 0)) {
            if (window.length === MAX_PAGE) { hasNext = true; break }
            window.push({ ...value, type })
          }
          offset++
        }
        for (const child of [...(children.get(value.entry.id as string) ?? [])].reverse()) stack.push({ entry: child, depth: value.depth + 1 })
      }
      if (previous && offset < previous.offset) throw new ApiError('conflict')
      const finalHead = await this.options.head()
      this.authorize(actor)
      if (!nativeSelectedHeadEqual(head, finalHead) || previous && previous.expiresAt <= this.now()) throw new ApiError('conflict')
      // Origin lookup and original human text reads follow the final await, so a
      // logout, generation change or logical redaction cannot reuse stale text.
      const origins = this.options.origins(head, window.filter(value => value.type === 'user' || value.type === 'assistant').map(value => value.entry.id as string))
      const entries = window.map(({ entry, depth, type }): ProductNativeTreeEntry => {
        const candidates = origins.get(entry.id as string) ?? []
        for (const origin of candidates) {
          if (origin.entryId !== entry.id) throw new ApiError('unavailable')
          const owner = this.options.control.binding(actor, origin.binding.conversationId)
          if (owner.ownerActorId !== origin.binding.ownerActorId || owner.workspaceId !== origin.binding.workspaceId || origin.binding.generation > owner.generation) throw new ApiError('not-found')
        }
        let preview = '', origin: NativeHistoryOrigin | null = null
        if (type === 'assistant') {
          if (!candidates.length || candidates[0]!.binding.bindingId !== this.options.binding.bindingId) throw new ApiError('unavailable')
          preview = assistantText(entry); origin = reference(candidates.at(-1)!)
        }
        if (type === 'user') for (const candidate of candidates) {
          const original = this.options.control.publicUserMessageAt(actor, candidate.binding, entry.id as string)
          if (original) { preview = clipped(original.text ?? '', 1000); origin = reference(candidate); break }
        }
        return { entryId: entry.id as string, parentId: entry.parentId as string | null, type, preview, label: labels.get(entry.id as string) ?? null,
          depth, onSelectedBranch: selected.has(entry.id), canNavigate: true, canForkBefore: type === 'user', canForkAt: true, origin }
      })
      this.authorize(actor)
      let nextCursor: string | null = null
      if (hasNext) {
        if (this.cursors.size >= MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value!)
        nextCursor = `tree:${randomUUID()}`
        this.cursors.set(nextCursor, { head: canonical(head), view: request.view, offset: (previous?.offset ?? 0) + entries.length, expiresAt: this.now() + CURSOR_TTL })
      }
      const result: ProductNativeTreePage = { schemaVersion: 1, kind: 'native-tree-page', binding: structuredClone(this.options.binding), head, view: request.view, entries, nextCursor }
      parseContract('native-lineage', result)
      if (nativeLineageIssues(result).length || Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new ApiError('unavailable')
      return structuredClone(result)
    } finally { this.reading-- }
  }
  dispose(): void { this.disposed = true; this.cursors.clear() }
  private authorize(actor: ProductActor): void {
    if (this.disposed) throw new ApiError('unavailable')
    if (actor.actorId !== this.options.actor.actorId || actor.workspaceId !== this.options.actor.workspaceId) throw new ApiError('not-found')
    if (canonical(this.options.control.binding(actor, this.options.binding.conversationId)) !== canonical(this.options.binding)) throw new ApiError('conflict')
  }
  private now(): number { const value = (this.options.clock ?? Date.now)(); if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('unavailable'); return value }
}
