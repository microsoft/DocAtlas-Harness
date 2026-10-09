import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { AnswerResponse, CitationFocus, ConversationSnapshot, NativeControlValue, NativeSelectedHead, ProductHistoryMessage, ProductHistoryPage,
  ProductHistoryRequest, ProductNativeInspection } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { canonicalHash } from '../src/live/state'
import { historyHeadKey, mergeHistory } from '../src/live/history-state'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.restoreAllMocks() })
const load = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${file}`, import.meta.url), 'utf8')) as T
const fixtures = load<{ 'native-control': NativeControlValue[], 'product-history': Array<ProductHistoryRequest | ProductHistoryPage> }>('native-history.json')
const answerFixtures = load<{ bases: { response: AnswerResponse, focus: CitationFocus } }>('product-answer.json')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
type Call = { path: string, method: string, headers: Headers, body: unknown }
async function setup() {
  const inspection = structuredClone(fixtures['native-control'].find(value => 'kind' in value && value.kind === 'native-inspection')!) as ProductNativeInspection
  const binding = inspection.binding, actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }
  const operation = inspection.operations[0]!, command = operation.request
  operation.requestHash = await canonicalHash(command); operation.result!.requestHash = operation.requestHash
  const answer = structuredClone(answerFixtures.bases.response), focus = structuredClone(answerFixtures.bases.focus)
  answer.conversationId = binding.conversationId; answer.manifest!.sessionId = binding.conversationId; answer.manifest!.workspaceId = binding.workspaceId
  focus.conversationId = binding.conversationId
  const raw = `[${answer.manifest!.blocks[0]!.segments[0]!.text}](#docatlas.v1.support.${answer.manifest!.citations[0]!.locator.locatorId})`
  answer.nativeTextHash = hash(raw)
  answer.manifest!.answerTextHash = hash(answer.manifest!.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n'))
  const messages: ProductHistoryMessage[] = Array.from({ length: 110 }, (_, index) => ({ entryId: index === 1 ? answer.messageId : `message:${index}`,
    role: index % 2 ? 'assistant' : 'user', text: index === 1 ? raw : `Saved message ${index}`, truncated: false,
    nativeTextHash: hash(index === 1 ? raw : index % 2 ? `Saved message ${index}` : `Prepared source injection ${index}`), displayOrigin: index % 2 ? 'native' : 'submission' }))
  messages[2] = { ...messages[2]!, text: '', displayOrigin: 'unavailable' }
  const checkpoint = { ...(fixtures['product-history'][1] as ProductHistoryPage).checkpoint!, runtimeSessionId: binding.runtimeSessionId,
    userEntryId: messages.at(-2)!.entryId, leafEntryId: messages.at(-1)!.entryId }
  const snapshot: ConversationSnapshot = { schemaVersion: 1, kind: 'conversation-snapshot', binding, cursor: { streamId: '11111111-2222-4333-8444-555555555555', sequence: 0 }, runs: [], nextRunsCursor: null,
    history: { checkpoint, messages: messages.slice(-100).map(({ entryId, role, text, truncated }) => ({ entryId, role, text, truncated })), hasEarlier: true }, live: [], activity: [], liveIncomplete: false }
  const other = { ...binding, conversationId: 'conversation:other', bindingId: 'binding:other', runtimeSessionId: 'session:other' }
  const stored = new Map<string, string>(), calls: Call[] = []
  let respond: ((call: Call) => Response | Promise<Response>) | undefined
  const client = new LiveClient({ storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value) }, removeItem: key => { stored.delete(key) }, key: index => [...stored.keys()][index] ?? null, get length() { return stored.size } },
    events: () => ({ addEventListener() {}, close() {}, onerror: null, onopen: null }) satisfies EventStream,
    fetch: (async (input, options) => {
      const path = String(input)
      if (path === '/api/bootstrap') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
      if (path === '/api/conversations') return json({ schemaVersion: 1, kind: 'conversation-list', items: [binding, other], nextCursor: null })
      if (path.endsWith('/snapshot')) return json(path.includes(encodeURIComponent(other.conversationId)) ? { ...snapshot, binding: other, history: { checkpoint: null, messages: [], hasEarlier: false } } : snapshot)
      if (path === '/api/auth/logout') return new Response(null, { status: 204 })
      const call: Call = { path, method: options?.method ?? 'GET', headers: new Headers(options?.headers), body: options?.body ? JSON.parse(String(options.body)) as unknown : null }; calls.push(call)
      if (respond) return respond(call)
      if (path.endsWith('/history')) {
        const cursor = (call.body as ProductHistoryRequest).cursor, end = cursor ? Number(cursor.split(':').at(-1)) : messages.length
        const start = Math.max(0, end - 50)
        return json({ schemaVersion: 1, kind: 'history-page', binding, checkpoint: snapshot.history.checkpoint, selectedHead: snapshot.history.selectedHead,
          messages: messages.slice(start, end), hasEarlier: start > 0, nextCursor: start > 0 ? `history:before:${start}` : null })
      }
      if (path.endsWith('/native')) return json(call.method === 'POST' ? operation : inspection)
      if (path.includes('/native/operations/')) return json(operation)
      if (path.includes('/answers/')) return json(path.includes('/citations/') ? focus : answer)
      throw new Error('Unexpected test route')
    }) as typeof fetch })
  cleanup.push(() => client.dispose()); await client.start(); expect(client.state().phase).toBe('ready')
  const history = (cursor: string | null = null) => client.historyPage(binding.conversationId, { schemaVersion: 1, kind: 'history-page-request', expectedGeneration: 1, cursor })
  return { client, binding, inspection, operation, command, messages, snapshot, other, answer, focus, calls, stored, history, respond(value: typeof respond) { respond = value } }
}

it('authenticates native routes, verifies the whole command, and never edits question or source state', async () => {
  const test = await setup(), cid = test.binding.conversationId
  test.client.setDraft('Unchanged draft'); test.client.setSources([{ documentId: 'document:selected', revisionId: 'revision:selected' }])
  const before = structuredClone(test.client.state()), stored = [...test.stored]
  await expect(test.client.nativeInspect(cid)).resolves.toEqual(test.inspection)
  await expect(test.client.nativeCommand(cid, test.command)).resolves.toEqual(test.operation)
  await expect(test.client.nativeOperation(cid, test.operation.operationId)).resolves.toEqual(test.operation)
  expect(test.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET'])
  expect(test.calls[1]!.body).toEqual(test.command); expect(test.calls[1]!.headers.get('x-docatlas-csrf')).toBe('a'.repeat(43))
  expect(test.client.state()).toEqual(before); expect([...test.stored]).toEqual(stored)
})
it('does not accept a matching-looking native value with a wrong whole-body hash or foreign binding', async () => {
  const test = await setup()
  for (const value of [{ ...test.operation, requestHash: 'f'.repeat(64) }, { ...test.operation, bindingId: 'binding:other' },
    { ...test.operation, result: { ...test.operation.result!, beforeHead: { ...test.operation.result!.beforeHead, transcriptHash: 'd'.repeat(64) } } }]) {
    test.respond(() => json(value))
    await expect(test.client.nativeCommand(test.binding.conversationId, test.command)).rejects.toThrow()
  }
  expect(test.calls).toHaveLength(3)
})
it('freezes a native command before caller mutation and keeps accepted/unknown as non-success results', async () => {
  const test = await setup(), gate = Promise.withResolvers<Response>(), request = structuredClone(test.command)
  test.respond(() => gate.promise)
  const work = test.client.nativeCommand(test.binding.conversationId, request)
  request.action = { kind: 'set-thinking', level: 'low' }
  gate.resolve(json({ ...test.operation, state: 'outcome-unknown', errorCode: 'execution-interrupted', result: null }))
  await expect(work).resolves.toMatchObject({ state: 'outcome-unknown', result: null })
  expect(test.calls[0]!.body).toEqual(test.command)
})
it('fences native responses after asynchronous hashing when the selected conversation changes', async () => {
  const test = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
  const work = test.client.nativeOperation(test.binding.conversationId, test.operation.operationId), rejected = expect(work).rejects.toThrow()
  await entered.promise; await test.client.select(test.other.conversationId)
  const before = structuredClone(test.client.state()); release.resolve(); await rejected
  expect(test.client.state()).toEqual(before)
})
it('skips two overlapping pages in one gesture, retains all visible messages, and never hashes original user text as prepared input', async () => {
  const test = await setup(), seen: number[] = []
  const off = test.client.subscribe(() => { const state = test.client.state(); seen.push(state.history.loaded ? state.history.messages.length : state.snapshot!.history.messages.length) })
  await test.history(); off()
  expect(test.calls).toHaveLength(3); expect(Math.min(...seen)).toBe(100)
  expect(test.client.state().history.messages).toEqual(test.messages)
  expect(test.client.state().history).toMatchObject({ hasEarlier: false, nextCursor: null, loaded: true, loading: false })
  expect(test.client.state().history.messages[2]!.text).toBe('')
  expect(test.calls.map(call => (call.body as ProductHistoryRequest).cursor)).toEqual([null, 'history:before:60', 'history:before:10'])
})
it('lets an older fully verified Answer and its original PDF citation be requested after pagination', async () => {
  const test = await setup()
  await expect(test.client.answerRequest(test.binding.conversationId, test.answer.messageId)).rejects.toThrow('complete persisted message')
  await test.history()
  await expect(test.client.answerRequest(test.binding.conversationId, test.answer.messageId)).resolves.toEqual(test.answer)
  await expect(test.client.answerRequest(test.binding.conversationId, test.answer.messageId, test.focus.citationId)).resolves.toEqual(test.focus)
  expect(test.calls.at(-1)!.body).toEqual({})
  expect(test.client.state().snapshot!.history.messages.some(message => message.entryId === test.answer.messageId)).toBe(false)
})
it('rejects altered complete assistant text instead of merging a valid-looking native hash', async () => {
  const test = await setup(), before = structuredClone(test.client.state().snapshot)
  test.respond(() => json({ schemaVersion: 1, kind: 'history-page', binding: test.binding, checkpoint: test.snapshot.history.checkpoint,
    messages: [{ ...test.messages.at(-1)!, text: 'Not the native answer' }], hasEarlier: false, nextCursor: null }))
  await expect(test.history()).rejects.toThrow('hash')
  expect(test.client.state().snapshot).toEqual(before); expect(test.client.state().history.loaded).toBe(false)
})
it('does not let a page awaiting hashes cross a checkpoint change or reset the newer view', async () => {
  const test = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
  const work = test.history(), rejected = expect(work).rejects.toThrow()
  await entered.promise; test.snapshot.history.checkpoint!.transcriptHash = 'e'.repeat(64); await test.client.refresh()
  const before = structuredClone(test.client.state()); release.resolve(); await rejected
  expect(test.client.state()).toEqual(before); expect(test.calls).toHaveLength(1)
})
it('treats an expired cursor as a read-only restart, without replaying questions or hiding current messages', async () => {
  const test = await setup()
  test.respond(() => json({ schemaVersion: 1, kind: 'api-error', code: 'conflict' }, 409))
  await expect(test.history()).rejects.toThrow()
  expect(test.client.state().history).toMatchObject({ loaded: false, loading: false })
  expect(test.client.state().snapshot!.history.messages).toHaveLength(100)
  expect(test.calls.every(call => call.path.endsWith('/history'))).toBe(true)
})
it('rejects foreign cursors before transport and invalidates loaded history when the checkpoint changes', async () => {
  const test = await setup()
  await expect(test.history('history:not-owned')).rejects.toThrow(); expect(test.calls).toHaveLength(0)
  await test.history(); test.snapshot.history.checkpoint!.transcriptHash = 'e'.repeat(64); await test.client.refresh()
  expect(test.client.state().history.loaded).toBe(false)
})
it('preserves chronology, upgrades truncated prefixes, and refuses contradictory page order or unbounded accumulation', async () => {
  const test = await setup(), page = test.messages.slice(-50), window = test.messages.slice(-100)
  expect(mergeHistory(window, page, false)).toEqual(window)
  expect(() => mergeHistory(window, [...page].reverse(), false)).toThrow('order')
  const full = test.messages.at(-1)!
  expect(mergeHistory([{ ...full, text: full.text.slice(0, 3), truncated: true }], [full], false)).toEqual([full])
  const many = Array.from({ length: 2000 }, (_, index) => ({ ...full, entryId: `many:${index}` }))
  expect(() => mergeHistory(many, [{ ...full, entryId: 'many:older' }], true)).toThrow('历史显示上限')
})

function selection(snapshot: ConversationSnapshot): NativeSelectedHead {
  return { version: 1, fileSeal: { version: 1, sessionId: snapshot.binding.runtimeSessionId, transcriptHash: 'e'.repeat(64), byteLength: 10000,
    entryCount: 200, tailEntryId: 'entry:physical-tail' }, selectedLeafEntryId: snapshot.history.messages.at(-1)!.entryId, contextHash: 'd'.repeat(64) }
}
it('pages the verified selected branch without fabricating a question checkpoint and preserves original message origins', async () => {
  const test = await setup(), selectedHead = selection(test.snapshot)
  const origin = { conversationId: 'conversation:parent', bindingId: 'binding:parent', generation: 2, runtimeSessionId: 'session:parent', entryId: test.messages[109]!.entryId }
  test.messages[109]!.origin = origin
  test.snapshot.history = { ...test.snapshot.history, checkpoint: null, selectedHead, messages: test.snapshot.history.messages.map(message =>
    message.entryId === origin.entryId ? { ...message, origin } : message) }
  await test.client.refresh(); await test.history()
  expect(test.client.state().history).toMatchObject({ head: null, selectedHead, loaded: true, messages: test.messages })
  expect(test.calls.every(call => call.path.endsWith('/history'))).toBe(true)
})
it('pins a selected head including explicit root rather than treating the physical tail as a checkpoint', async () => {
  const test = await setup(), head = selection(test.snapshot), root = { ...head, selectedLeafEntryId: null, contextHash: 'a'.repeat(64) }
  expect(historyHeadKey(null, head)).not.toBe(historyHeadKey(null, root))
  expect(historyHeadKey(null, root)).not.toBe(historyHeadKey(null))
  expect(historyHeadKey(null, head)).not.toBe(historyHeadKey(null, { ...head, fileSeal: { ...head.fileSeal, tailEntryId: 'entry:other' } }))
  expect(historyHeadKey(null, head)).toBe(historyHeadKey(null, { selectedLeafEntryId: head.selectedLeafEntryId, contextHash: head.contextHash,
    fileSeal: { ...head.fileSeal }, version: 1 }))
  test.snapshot.history = { checkpoint: null, selectedHead: root, messages: [], hasEarlier: false }
  await test.client.refresh()
  test.respond(() => json({ schemaVersion: 1, kind: 'history-page', binding: test.binding, checkpoint: null, selectedHead: root, messages: [], hasEarlier: false, nextCursor: null }))
  await test.history()
  expect(test.client.state().history).toMatchObject({ head: null, selectedHead: root, messages: [], hasEarlier: false })
})
it('fences in-flight pages when native selection changes without any new question or file append', async () => {
  const test = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
  test.snapshot.history = { ...test.snapshot.history, checkpoint: null, selectedHead: selection(test.snapshot) }; await test.client.refresh()
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
  const work = test.history(), rejected = expect(work).rejects.toThrow()
  await entered.promise
  test.snapshot.history.selectedHead!.contextHash = 'b'.repeat(64); await test.client.refresh()
  const before = structuredClone(test.client.state()); release.resolve(); await rejected
  expect(test.client.state()).toEqual(before); expect(test.calls).toHaveLength(1)
})
it('rejects changed historical provenance even when native text and its digest are identical', async () => {
  const test = await setup(), full = test.messages.at(-1)!
  const origin = { conversationId: 'conversation:parent', bindingId: 'binding:parent', generation: 1, runtimeSessionId: 'session:parent', entryId: full.entryId }
  expect(() => mergeHistory([{ ...full, origin }], [full], false)).toThrow('History entry changed')
  expect(() => mergeHistory([{ ...full, origin }], [{ ...full, origin: { ...origin, generation: 2 } }], false)).toThrow('History entry changed')
  expect(mergeHistory([{ ...full, origin }], [{ ...full, origin: { entryId: full.entryId, runtimeSessionId: origin.runtimeSessionId,
    conversationId: origin.conversationId, generation: 1, bindingId: origin.bindingId } }], false)[0]!.origin).toEqual(origin)
})

it('pins Web Stop to its exact original binding without modifying its question or source selections', async () => {
  const test = await setup()
  test.client.setDraft('Unsent question'); test.client.setSources([{ documentId: 'document:chosen', revisionId: 'revision:chosen' }])
  const before = structuredClone(test.client.state())
  test.respond(() => json({ schemaVersion: 1, kind: 'runtime-stopped', conversationId: test.binding.conversationId, generation: 1 }))
  await test.client.stop()
  expect(test.calls).toHaveLength(1); expect(test.calls[0]).toMatchObject({ method: 'POST', body: {} })
  expect(test.calls[0]!.headers.get('if-match')).toBe(JSON.stringify(test.binding.bindingId))
  expect(test.calls[0]!.headers.get('x-docatlas-csrf')).toBe('a'.repeat(43))
  expect(test.client.state()).toMatchObject({ draft: before.draft, sourceRefs: before.sourceRefs, stopping: false })
})

it('does not rebase or repeat a stopped old-generation request after the server rejects its binding condition', async () => {
  const test = await setup(), release = Promise.withResolvers<Response>()
  test.respond(() => release.promise)
  const work = test.client.stop(), original = test.binding.bindingId
  test.snapshot.binding = { ...test.binding, bindingId: 'binding:new-generation', generation: 2, version: 2 }
  await test.client.refresh()
  release.resolve(json({ schemaVersion: 1, kind: 'api-error', code: 'conflict' }, 409)); await work
  expect(test.calls).toHaveLength(1); expect(test.calls[0]!.headers.get('if-match')).toBe(JSON.stringify(original))
  expect(test.client.state().snapshot!.binding.generation).toBe(2); expect(test.client.state().stopping).toBe(false)
})
