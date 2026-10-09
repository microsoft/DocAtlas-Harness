import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import type { ConversationSnapshot, ProductSubmission, ProductRunReceipt, ProductSelectionTicket } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { submissionHash } from '../src/live/state'
import { outgoingMessage } from '../src/live/outgoing-message'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
class TabStorage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  key(index: number) { return [...this.values.keys()][index] ?? null }
}
class Stream implements EventStream {
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  readonly listeners = new Map<string, EventListener>()
  addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener) }
  close() {}
  emit(value: unknown, id: string) { this.listeners.get('observation')!(new MessageEvent('observation', { data: JSON.stringify(value), lastEventId: id })) }
}
function setup(storage = new TabStorage()) {
  const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: ConversationSnapshot[] }
  const snapshot = structuredClone(fixtures.valid.find(value => value.kind === 'conversation-snapshot')!)
  snapshot.runs = []; snapshot.live = []; snapshot.cursor.sequence = 0
  const conversations = [snapshot.binding]
  const actor = { actorId: snapshot.binding.ownerActorId, workspaceId: snapshot.binding.workspaceId }, bodies: ProductSubmission[] = [], streams: Stream[] = []
  let mode: 'lost' | 'accepted' | 'sse-first' = 'lost', delayed: Promise<ConversationSnapshot> | undefined, logout: Promise<void> | undefined
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const client = new LiveClient({ storage, events: () => { const stream = new Stream(); streams.push(stream); return stream }, fetch: (async (input, options) => {
    const path = String(input)
    if (path === '/api/bootstrap') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
    if (path === '/api/conversations') return json({ schemaVersion: 1, kind: 'conversation-list', items: conversations, nextCursor: null })
    if (path.endsWith('/snapshot')) return json(delayed ? await delayed : { ...snapshot, binding: conversations.find(item => path.includes(encodeURIComponent(item.conversationId))) ?? snapshot.binding })
    if (path === '/api/submissions') {
      const request = JSON.parse(String(options?.body)) as ProductSubmission; bodies.push(request)
      if (mode === 'lost') throw new TypeError('network unavailable')
      const receipt: ProductRunReceipt = { schemaVersion: 1, kind: 'run-receipt', conversationId: request.conversationId, generation: request.expectedGeneration, submissionId: 'submission:confirmed', runId: 'run:confirmed', mode: request.mode, state: 'accepted', version: 1, requestHash: await submissionHash(request), createdAt: snapshot.binding.createdAt, updatedAt: snapshot.binding.updatedAt, payloadRetained: true }
      snapshot.runs = [{ receipt, text: request.text }]
      if (mode === 'sse-first') { snapshot.cursor.sequence++; streams.at(-1)!.emit({ schemaVersion: 1, kind: 'conversation-observation', conversationId: request.conversationId, generation: 1, cursor: snapshot.cursor, update: { type: 'receipt', receipt } }, `${snapshot.cursor.streamId}:${snapshot.cursor.sequence}`) }
      return json(receipt)
    }
    if (path === '/api/auth/logout') { await logout; return new Response(null, { status: 204 }) }
    throw new Error(`Unexpected test route ${path}`)
  }) as typeof fetch })
  cleanup.push(() => client.dispose())
  return { client, storage, bodies, streams, snapshot, conversations, setMode(value: typeof mode) { mode = value }, delay(value: Promise<ConversationSnapshot>) { delayed = value }, delayLogout(value: Promise<void>) { logout = value } }
}
it('waits for logout acknowledgement before allowing another pairing cookie exchange', async () => {
  const value = setup(); await value.client.start()
  const gate = Promise.withResolvers<void>(); value.delayLogout(gate.promise)
  const stopping = value.client.logout()
  expect(value.client.state().sending).toBe(true)
  await value.client.pair('a'.repeat(43))
  expect(value.client.state().error).toBe('')
  gate.resolve(); await stopping
  expect(value.client.state().phase).toBe('pairing'); expect(value.client.state().sending).toBe(false)
})
it('freezes search strategy in the original outbox body across explicit retry and reload', async () => {
  const first = setup(); await first.client.start(); first.client.setDraft('Find the relevant chapter')
  await first.client.submit('prompt', { recipe: 'tree-search.v1', strategy: 'tree' })
  const original = structuredClone(first.bodies[0]!)
  expect(original.documentSearch?.strategy).toBe('tree')
  expect(await submissionHash({ ...original, documentSearch: { recipe: 'tree-search.v1', strategy: 'fts' } })).not.toBe(await submissionHash(original))
  await first.client.submit('prompt', { recipe: 'tree-search.v1', strategy: 'combined' })
  expect(first.bodies[1]).toEqual(original)
  const restored = setup(first.storage); await restored.client.start()
  await restored.client.submit('prompt', { recipe: 'tree-search.v1', strategy: 'fts' })
  expect(restored.bodies[0]).toEqual(original)
})
it('exposes the frozen send before the first await and fences duplicate sends and edits', async () => {
  const f = setup(); await f.client.start(); f.client.setDraft('Immediate question')
  const pending = f.client.submit()
  const preview = outgoingMessage(f.client.state())!
  expect(preview.request.text).toBe('Immediate question'); expect(preview.requestHash).toBeNull(); expect(preview.receipt).toBeNull()
  f.client.setDraft('Must not overwrite the frozen request'); await f.client.submit(); await pending
  expect(f.bodies).toHaveLength(1); expect(f.client.state().draft).toBe('Immediate question')
  expect(outgoingMessage(f.client.state())!.request.idempotencyKey).toBe(f.bodies[0]!.idempotencyKey)
  expect(f.client.state().request).toEqual(f.bodies[0]); expect(f.client.state().error).not.toBe('')
  f.client.discard(); expect(outgoingMessage(f.client.state())).toBeNull()
})
it.each(['accepted', 'sse-first'] as const)('keeps the local text through %s until the exact authoritative projection arrives', async mode => {
  const f = setup(); await f.client.start(); f.client.setDraft('Do not blink away'); f.setMode(mode)
  const gate = Promise.withResolvers<ConversationSnapshot>(); f.delay(gate.promise)
  const sending = f.client.submit()
  await expect.poll(() => f.client.state().outgoing?.receipt?.submissionId).toBe('submission:confirmed')
  expect(f.client.state().draft).toBe(''); expect(f.client.state().request).toBeNull()
  expect(outgoingMessage(f.client.state())!.request.text).toBe('Do not blink away')
  if (mode === 'sse-first') expect(f.client.state().snapshot!.runs[0]!.text).toBeNull()
  gate.resolve(structuredClone(f.snapshot)); await sending
  expect(f.client.state().outgoing).toBeNull()
  expect(f.client.state().snapshot!.runs[0]!.text).toBe('Do not blink away')
})
it('does not deduplicate by equal text, leak outgoing previews across bindings or revive them after purge', async () => {
  const f = setup(); await f.client.start(); f.client.setDraft('same words'); await f.client.submit()
  const current = f.client.state(), outgoing = current.outgoing!
  const other = structuredClone(f.snapshot); other.runs = [{ receipt: { schemaVersion: 1, kind: 'run-receipt', conversationId: current.selected!, generation: other.binding.generation,
    submissionId: 'submission:other', runId: 'run:other', mode: 'prompt', state: 'completed', version: 1, requestHash: 'f'.repeat(64), createdAt: other.binding.createdAt, updatedAt: other.binding.updatedAt, payloadRetained: true }, text: 'same words' }]
  expect(outgoingMessage({ ...current, snapshot: other })).toBe(outgoing)
  expect(outgoingMessage({ ...current, snapshot: { ...other, binding: { ...other.binding, bindingId: 'binding:other' } } })).toBeNull()
  other.runs[0]!.receipt.requestHash = outgoing.requestHash!; other.runs[0]!.receipt.payloadRetained = false; other.runs[0]!.text = null
  expect(outgoingMessage({ ...current, snapshot: other })).toBeNull()
  await f.client.select(f.snapshot.binding.conversationId); expect(f.client.state().outgoing).toBeNull()
})
it('a repeated or stale selection release never opens another selection owner’s send gate', async () => {
  const f = setup(); await f.client.start(); f.client.setDraft('Use the selected passage')
  const old = f.client.holdSelectionVerification(); old()
  const current = f.client.holdSelectionVerification(); old()
  expect(f.client.state().verifyingSelection).toBe(true)
  await f.client.submit(); expect(f.bodies).toHaveLength(0)
  current(); expect(f.client.state().verifyingSelection).toBe(false)
  const detached = f.client.holdSelectionVerification()
  await f.client.select(f.snapshot.binding.conversationId)
  const next = f.client.holdSelectionVerification(); detached()
  expect(f.client.state().verifyingSelection).toBe(true)
  next(); expect(f.client.state().verifyingSelection).toBe(false)
})
it('freezes restored selection IDs into an uncertain submission and removes one-shot tickets only on matching receipt', async () => {
  const fixture = setup(); await fixture.client.start()
  const records = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document-http.json', import.meta.url), 'utf8')) as { valid: ProductSelectionTicket[] }
  const example = records.valid.find(value => value.kind === 'selection-ticket')!, binding = fixture.snapshot.binding
  const ticket: ProductSelectionTicket = { ...example, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, actorId: binding.ownerActorId, workspaceId: binding.workspaceId,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }
  fixture.client.addSelection(ticket); fixture.client.setDraft('问这个选区')
  const release = fixture.client.holdSelectionVerification()
  await fixture.client.submit(); expect(fixture.bodies).toHaveLength(0)
  release(); await fixture.client.submit()
  const request = fixture.client.state().request!
  expect(request.selectionContextIds).toEqual([ticket.selectionContextId])
  fixture.client.forgetSelection(ticket.selectionContextId); expect(fixture.client.state().selections).toHaveLength(1)
  fixture.client.dispose()
  const next = setup(fixture.storage); await next.client.start()
  expect(next.client.state().request).toEqual(request); expect(next.client.state().selections).toHaveLength(1)
  expect(next.bodies).toHaveLength(0)
  next.setMode('accepted'); await next.client.submit()
  expect(next.bodies[0]).toEqual(request); expect(next.client.state().selections).toHaveLength(0)
  expect(next.client.state().sourceRefs).toEqual(request.sourceRefs)
})
it('restores the selected authorized conversation without posting a new request', async () => {
  const first = setup(), other = { ...first.snapshot.binding, bindingId: 'binding:other', conversationId: 'conversation:other', runtimeSessionId: 'session:other' }
  first.conversations.push(other); await first.client.start(); await first.client.select(other.conversationId); first.client.dispose()
  const next = setup(first.storage); next.conversations.push(other); await next.client.start()
  expect(next.client.state().selected).toBe(other.conversationId)
  expect(next.client.state().snapshot?.binding.conversationId).toBe(other.conversationId)
  expect(next.bodies).toEqual([])
})
it('retains exact uncertain input/key across reload and never submits on startup/reconnect', async () => {
  const first = setup(); await first.client.start(); first.client.setSources([{ documentId: 'document:selected', revisionId: 'revision:selected' }]); first.client.setDraft('同一条问题')
  await first.client.submit()
  const request = first.client.state().request!
  expect(request).not.toBeNull(); expect(first.bodies).toHaveLength(1)
  first.client.setSources([])
  expect(first.client.state().sourceRefs).toEqual(request.sourceRefs)
  first.client.dispose()
  const resumed = setup(first.storage); await resumed.client.start()
  expect(resumed.bodies).toHaveLength(0)
  expect(resumed.client.state().request).toEqual(request)
  expect(resumed.client.state().sourceRefs).toEqual(request.sourceRefs)
  resumed.streams[0]!.onerror!(new Event('error'))
  expect(resumed.bodies).toHaveLength(0)
  resumed.setMode('accepted'); await resumed.client.submit()
  expect(resumed.bodies).toEqual([request]); expect(resumed.client.state().request).toBeNull(); expect(resumed.client.state().draft).toBe('')
})
it('accepts an SSE receipt arriving before the HTTP acknowledgement without a false failure', async () => {
  const value = setup(); await value.client.start(); value.setMode('sse-first'); value.client.setDraft('race')
  await value.client.submit()
  expect(value.client.state().error).toBe(''); expect(value.client.state().draft).toBe(''); expect(value.bodies).toHaveLength(1)
})
it('discards late snapshot/SSE after logout and removes only this actor tab drafts', async () => {
  const value = setup(); await value.client.start(); value.client.setDraft('private question')
  value.storage.setItem('unrelated', 'untouched')
  const gate = Promise.withResolvers<ConversationSnapshot>(); value.delay(gate.promise)
  const pending = value.client.refresh()
  await value.client.logout()
  gate.resolve(value.snapshot); await pending
  value.streams[0]!.emit({ schemaVersion: 1, kind: 'conversation-observation', conversationId: value.snapshot.binding.conversationId, generation: 1, cursor: { ...value.snapshot.cursor, sequence: 1 }, update: { type: 'resync', reason: 'gap' } }, `${value.snapshot.cursor.streamId}:1`)
  expect(value.client.state().phase).toBe('pairing'); expect(value.client.state().snapshot).toBeNull()
  expect(value.storage.length).toBe(1); expect(value.storage.getItem('unrelated')).toBe('untouched')
})
