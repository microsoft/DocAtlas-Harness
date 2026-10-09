import { createHash, randomUUID } from 'node:crypto'
import { productHistoryIssues, type NativeConversationHistory, type NativeConversationMessage, type NativeHistoryOrigin, type NativeSelectedHead,
  type ProductBinding, type ProductHistoryMessage, type ProductHistoryPage, type ProductPiCheckpoint } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { checkpointConversation, checkpointHistoryPage, selectedConversation, selectedHistoryPage, verifyWorkerCheckpoint, verifyNativeFileSeal,
  verifyNativeSelectedHead, verifyNativeLineageOutcome } from '@docatlas/runtime-pi/worker'
import { ControlStore, type ProductActor } from '../storage/control-store.js'
import type { RuntimeCatalog } from '../storage/runtime-catalog.js'
import { ApiError } from '../http/auth.js'

type Entry = Record<string, unknown>
type Authority = { checkpoint: ProductPiCheckpoint, selectedHead?: never } | { checkpoint: null, selectedHead: NativeSelectedHead }
export interface HistoricalMessageOrigin { binding: ProductBinding, entryId: string, nativeTextHash: string }
export interface HistoricalAnswerOrigins {
  origins(conversationId: string, entryId: string): HistoricalMessageOrigin[]
  /** Original publications in this conversation remain readable even off its currently selected branch. */
  frames(conversationId: string): ProductBinding[]
}
interface Cursor { key: string, beforeEntryId: string, expiresAt: number }
const MAX_PROOF_BYTES = 512 * 1024 * 1024, TTL = 300000
const object = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value)
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const bindingKey = (value: ProductBinding) => canonical(value)
const authorityKey = (value: Authority) => canonical(value)
const originRef = (value: HistoricalMessageOrigin): NativeHistoryOrigin => ({ conversationId: value.binding.conversationId, bindingId: value.binding.bindingId,
  generation: value.binding.generation, runtimeSessionId: value.binding.runtimeSessionId, entryId: value.entryId })
function text(entry: Entry): string {
  const message = object(entry.message) ? entry.message : undefined, content = message?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(value => object(value) && value.type === 'text' && typeof value.text === 'string').map(value => value.text).join('\n') : ''
}
function messageStamp(entry: Entry): string { return hash(canonical({ id: entry.id, type: entry.type, timestamp: entry.timestamp, message: entry.message })) }
function branch(entries: Entry[], leaf: string | null): Set<string> {
  const byId = new Map(entries.map(entry => [entry.id, entry])), found = new Set<string>()
  let id: unknown = leaf
  while (id !== null) {
    const entry = byId.get(id)
    if (!entry || typeof id !== 'string' || found.has(id)) throw new ApiError('unavailable')
    found.add(id); id = entry.parentId
  }
  return found
}

/** Native lineage is an authorization/reference graph, never a second transcript or a new Read receipt. */
export class LineageHistoryAccess implements HistoricalAnswerOrigins {
  private readonly cursors = new Map<string, Cursor>()
  private disposed = false
  constructor(private readonly control: ControlStore, private readonly catalog: RuntimeCatalog, private readonly actor: ProductActor,
    private readonly binding: ProductBinding, private readonly cwd: string,
    private readonly file: (actor: ProductActor, viewingConversationId: string, bindingId: string) => string, private readonly clock: () => number = Date.now) {}

  snapshot(): NativeConversationHistory {
    this.authorize()
    const authority = this.authority()
    if (!authority) return { checkpoint: null, messages: [], hasEarlier: false }
    const file = this.file(this.actor, this.binding.conversationId, this.binding.bindingId)
    const raw = authority.checkpoint ? checkpointConversation(file, authority.checkpoint) : selectedConversation(file, this.cwd, authority.selectedHead)
    const origins = this.context(authority, raw.messages.map(message => message.entryId))
    const mapped = raw.messages.filter(message => message.role === 'user' || message.text.length > 0).map(message => this.display(message, origins.get(message.entryId) ?? []))
    let remaining = 262144, hasEarlier = raw.hasEarlier
    const messages: NativeConversationMessage[] = []
    for (const message of [...mapped].reverse()) {
      if (message.text.length > remaining) { hasEarlier = true; break }
      remaining -= message.text.length; messages.push(message)
    }
    this.assertAuthority(authority)
    return { ...authority, messages: messages.reverse(), hasEarlier }
  }

  async page(actor: ProductActor, cursor?: string): Promise<ProductHistoryPage> {
    this.authorize(actor)
    const now = this.now()
    for (const [key, value] of this.cursors) if (value.expiresAt <= now) this.cursors.delete(key)
    if (cursor !== undefined && !/^history:[a-f0-9-]{36}$/u.test(cursor)) throw new ApiError('invalid-request')
    const authority = this.authority()
    if (!authority) {
      if (cursor) throw new ApiError('conflict')
      return this.checked({ schemaVersion: 1, kind: 'history-page', binding: this.binding, checkpoint: null, messages: [], hasEarlier: false, nextCursor: null })
    }
    const previous = cursor ? this.cursors.get(cursor) : undefined, key = authorityKey(authority)
    if (cursor && (!previous || previous.key !== key || previous.expiresAt <= now)) throw new ApiError('conflict')
    const file = this.file(this.actor, this.binding.conversationId, this.binding.bindingId)
    const raw = authority.checkpoint ? checkpointHistoryPage(file, authority.checkpoint, previous?.beforeEntryId)
      : selectedHistoryPage(file, this.cwd, authority.selectedHead, previous?.beforeEntryId)
    const origins = this.context(authority, raw.messages.map(message => message.entryId))
    let remaining = 131072, hasEarlier = raw.hasEarlier
    const selected: ProductHistoryMessage[] = []
    for (const message of [...raw.messages].reverse()) {
      const display = this.display(message, origins.get(message.entryId) ?? [])
      if (display.text.length > 65536) throw new ApiError('unavailable')
      if (display.text.length > remaining) { hasEarlier = true; break }
      remaining -= display.text.length
      selected.push({ ...display, nativeTextHash: message.nativeTextHash, displayOrigin: message.role === 'assistant' ? 'native' : display.text ? 'submission' : 'unavailable' })
    }
    const messages = selected.reverse()
    this.assertAuthority(authority)
    let nextCursor: string | null = null
    if (hasEarlier) {
      if (!messages[0]) throw new ApiError('unavailable')
      if (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!)
      nextCursor = `history:${randomUUID()}`
      this.cursors.set(nextCursor, { key, beforeEntryId: messages[0].entryId, expiresAt: this.now() + TTL })
    }
    return this.checked({ schemaVersion: 1, kind: 'history-page', binding: this.binding, ...authority, messages, hasEarlier, nextCursor })
  }

  origins(conversationId: string, entryId: string): HistoricalMessageOrigin[] {
    if (conversationId !== this.binding.conversationId) throw new ApiError('not-found')
    this.authorize()
    const authority = this.authority()
    if (!authority) return []
    const result = this.context(authority, [entryId]).get(entryId) ?? []
    this.assertAuthority(authority)
    return result
  }
  /** Private full-tree display only. This does not grant off-branch inherited Answer access. */
  treeOrigins(conversationId: string, head: NativeSelectedHead, entryIds: readonly string[]): Map<string, HistoricalMessageOrigin[]> {
    if (conversationId !== this.binding.conversationId) throw new ApiError('not-found')
    this.authorize()
    if (entryIds.length > 100 || new Set(entryIds).size !== entryIds.length) throw new ApiError('limit-exceeded')
    if (head.fileSeal.sessionId !== this.binding.runtimeSessionId) throw new ApiError('conflict')
    const file = this.file(this.actor, this.binding.conversationId, this.binding.bindingId)
    const verified = verifyNativeSelectedHead(file, this.cwd, head, { exactFile: true })
    const entries = verifyNativeFileSeal(file, this.cwd, verified.fileSeal, { exactFile: true }).entries
    const result = this.projectOrigins(entries, entryIds)
    this.authorize()
    verifyNativeSelectedHead(file, this.cwd, verified, { exactFile: true })
    return result
  }
  frames(conversationId: string): ProductBinding[] {
    if (conversationId !== this.binding.conversationId) throw new ApiError('not-found')
    this.authorize()
    const frames = [this.binding, ...this.catalog.historicalBindings(this.actor, this.binding).filter(binding => binding.conversationId === conversationId)]
    for (const frame of frames) this.authorizeOrigin(frame)
    this.authorize()
    return structuredClone(frames)
  }
  dispose(): void { this.disposed = true; this.cursors.clear() }

  private display(message: NativeConversationMessage, candidates: HistoricalMessageOrigin[]): NativeConversationMessage {
    if (!candidates.length) throw new ApiError('unavailable')
    if (message.role === 'assistant') {
      // The oldest proved copy is an explicit historical origin, not a newly published Answer.
      const origin = candidates.at(-1)!
      return { ...message, ...(origin.binding.bindingId === this.binding.bindingId ? {} : { origin: originRef(origin) }) }
    }
    for (const origin of candidates) {
      const original = this.control.publicUserMessageAt(this.actor, origin.binding, message.entryId)
      if (original) return { ...message, text: original.text ?? '', truncated: false,
        ...(origin.binding.bindingId === this.binding.bindingId ? {} : { origin: originRef(origin) }) }
    }
    return { ...message, text: '', truncated: false }
  }

  private context(authority: Authority, requested: string[]): Map<string, HistoricalMessageOrigin[]> {
    this.assertAuthority(authority)
    const file = this.file(this.actor, this.binding.conversationId, this.binding.bindingId)
    let entries: Entry[] = [], leaf: string | null
    if (authority.checkpoint) { verifyWorkerCheckpoint(file, authority.checkpoint, values => { entries = values }); leaf = authority.checkpoint.leafEntryId }
    else { verifyNativeSelectedHead(file, this.cwd, authority.selectedHead); entries = verifyNativeFileSeal(file, this.cwd, authority.selectedHead.fileSeal).entries; leaf = authority.selectedHead.selectedLeafEntryId }
    const result = this.projectOrigins(entries, requested, branch(entries, leaf))
    this.assertAuthority(authority)
    return result
  }

  private projectOrigins(entries: Entry[], requested: readonly string[], selected?: Set<string>): Map<string, HistoricalMessageOrigin[]> {
    const byId = new Map(entries.map(entry => [entry.id, entry])), stamps = new Map<string, string>()
    const result = new Map<string, HistoricalMessageOrigin[]>()
    for (const id of requested) {
      const entry = byId.get(id), message = entry && object(entry.message) ? entry.message : undefined
      if (!entry || selected && !selected.has(id) || entry.type !== 'message' || message?.role !== 'user' && message?.role !== 'assistant') continue
      stamps.set(id, messageStamp(entry)); result.set(id, [{ binding: this.binding, entryId: id, nativeTextHash: hash(text(entry)) }])
    }
    let current = this.binding, budget = 0
    const links = this.catalog.lineageLinks(this.actor, this.binding)
    if (links.length > 64) throw new ApiError('limit-exceeded')
    for (const link of links) {
      if (bindingKey(link.targetBinding) !== bindingKey(current)) throw new ApiError('unavailable')
      this.authorizeOrigin(link.sourceBinding)
      const proof = link.proof
      budget += proof.sourceAfterHead.fileSeal.byteLength + proof.targetHead.fileSeal.byteLength
      if (budget > MAX_PROOF_BYTES) throw new ApiError('limit-exceeded')
      const sourceFile = this.file(this.actor, this.binding.conversationId, link.sourceBinding.bindingId), targetFile = this.file(this.actor, this.binding.conversationId, link.targetBinding.bindingId)
      verifyNativeLineageOutcome(sourceFile, this.cwd, { operationId: proof.operationId, requestHash: proof.requestHash, expectedHead: proof.beforeHead, action: proof.action },
        { status: 'replayed', proof }, proof.kind === 'native-fork-proof' ? targetFile : undefined)
      const source = verifyNativeFileSeal(sourceFile, this.cwd, proof.kind === 'native-fork-proof' ? proof.forkBasisSeal : proof.beforeHead.fileSeal)
      const sources = new Map(source.entries.map(entry => [entry.id, entry]))
      const inherited = proof.kind === 'native-fork-proof'
        ? new Set(verifyNativeFileSeal(targetFile, this.cwd, proof.targetHead.fileSeal).entries.slice(0, proof.inheritedEntryCount).map(entry => entry.id)) : undefined
      for (const [id, candidates] of result) {
        if (candidates.at(-1)?.binding.bindingId !== current.bindingId || inherited && !inherited.has(id)) continue
        const original = sources.get(id)
        if (!original || original.type !== 'message' || messageStamp(original) !== stamps.get(id)) continue
        candidates.push({ binding: link.sourceBinding, entryId: id, nativeTextHash: hash(text(original)) })
      }
      current = link.sourceBinding
    }
    this.authorize()
    return result
  }

  private authority(): Authority | undefined {
    this.authorize()
    const checkpoint = this.control.latestCheckpoint(this.actor, this.binding.conversationId)
    if (checkpoint) {
      if (checkpoint.runtimeSessionId !== this.binding.runtimeSessionId) throw new ApiError('unavailable')
      return { checkpoint }
    }
    const selectedHead = this.catalog.inspect(this.binding)?.selectedHead
    if (!selectedHead) return undefined
    if (selectedHead.fileSeal.sessionId !== this.binding.runtimeSessionId) throw new ApiError('unavailable')
    return { checkpoint: null, selectedHead }
  }
  private assertAuthority(expected: Authority): void {
    this.authorize()
    const current = this.authority()
    if (!current || authorityKey(current) !== authorityKey(expected)) throw new ApiError('conflict')
  }
  private authorizeOrigin(binding: ProductBinding): void {
    const current = this.control.binding(this.actor, binding.conversationId)
    if (binding.workspaceId !== this.binding.workspaceId || binding.ownerActorId !== this.binding.ownerActorId
      || current.workspaceId !== binding.workspaceId || current.ownerActorId !== binding.ownerActorId || binding.generation > current.generation) throw new ApiError('not-found')
  }
  private authorize(actor = this.actor): void {
    if (this.disposed) throw new ApiError('unavailable')
    if (actor.actorId !== this.actor.actorId || actor.workspaceId !== this.actor.workspaceId || bindingKey(this.control.binding(actor, this.binding.conversationId)) !== bindingKey(this.binding)) throw new ApiError('conflict')
  }
  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('unavailable'); return value }
  private checked(value: ProductHistoryPage): ProductHistoryPage {
    parseContract('product-history', value)
    if (productHistoryIssues(value).length || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new ApiError('unavailable')
    return structuredClone(value)
  }
}
