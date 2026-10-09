import { afterEach, expect, it, vi } from 'vitest'
import type { ProductBinding } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { lineageFixture } from './lineage-fixture'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
type Call = { path: string, method: string, headers: Headers, body: unknown }
async function setup() {
  const fixture = await lineageFixture(), calls: Call[] = []
  let currentBinding = fixture.binding, actor = { actorId: fixture.identity.actorId, workspaceId: fixture.identity.workspaceId }
  const other = { ...fixture.binding, conversationId: 'conversation:other', bindingId: 'binding:other', runtimeSessionId: 'session:other' }
  let respond: ((call: Call) => Response | Promise<Response>) | undefined
  const bindings = (): ProductBinding[] => actor.actorId === fixture.identity.actorId ? [currentBinding, other]
    : [{ ...other, conversationId: 'conversation:new-actor', bindingId: 'binding:new-actor', ownerActorId: actor.actorId, workspaceId: actor.workspaceId }]
  const client = new LiveClient({ storage: fixture.storage,
    events: () => ({ addEventListener() {}, close() {}, onerror: null, onopen: null }) satisfies EventStream,
    fetch: (async (input, options) => {
      const path = String(input)
      if (path === '/api/bootstrap') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
      if (path === '/api/conversations') return json({ schemaVersion: 1, kind: 'conversation-list', items: bindings(), nextCursor: null })
      if (path.endsWith('/snapshot')) {
        const binding = bindings().find(value => path.includes(encodeURIComponent(value.conversationId)))!
        return json({ ...fixture.snapshot, binding })
      }
      if (path === '/api/auth/logout') return new Response(null, { status: 204 })
      const call: Call = { path, method: options?.method ?? 'GET', headers: new Headers(options?.headers), body: options?.body ? JSON.parse(String(options.body)) as unknown : null }
      calls.push(call)
      if (respond) return respond(call)
      if (path.endsWith('/lineage/tree')) return json({ ...fixture.tree, binding: currentBinding, head: currentBinding.generation === 1 ? fixture.head : fixture.targetHead })
      if (path.endsWith('/lineage') && call.method === 'GET') return json({ ...fixture.inspection, binding: currentBinding, head: currentBinding.generation === 1 ? fixture.head : fixture.targetHead })
      if (path.endsWith('/lineage') || path.includes('/lineage/operations/')) return json(fixture.operation)
      throw new Error('Unexpected lineage test route')
    }) as typeof fetch })
  cleanup.push(() => client.dispose()); await client.start(); expect(client.state().phase).toBe('ready')
  return { ...fixture, client, other, calls, respond(value: typeof respond) { respond = value },
    async generationChanged() { currentBinding = fixture.target; await client.refresh() },
    async actorChanged() { await client.logout(); actor = { actorId: 'actor:replacement', workspaceId: 'workspace:replacement' }; await client.start() } }
}

it('authenticates all four lineage APIs, freezes complete bodies, and never changes question/source state', async () => {
  const test = await setup(), cid = test.identity.conversationId
  test.client.setDraft('保留我自己的问题草稿'); test.client.setSources([{ documentId: 'document:chosen', revisionId: 'revision:chosen' }])
  const before = structuredClone(test.client.state()), stored = [...test.values]
  await expect(test.client.lineageInspect(cid)).resolves.toEqual(test.inspection)
  await expect(test.client.lineageTree(cid, { schemaVersion: 1, kind: 'native-tree-request', expectedGeneration: 1, view: 'messages', cursor: null })).resolves.toEqual(test.tree)
  await expect(test.client.lineageCommand(cid, test.pending.request)).resolves.toEqual(test.operation)
  await expect(test.client.lineageOperation(cid, test.operation.operationId)).resolves.toEqual(test.operation)
  expect(test.calls.map(call => call.method)).toEqual(['GET', 'POST', 'POST', 'GET'])
  expect(test.calls[2]!.body).toEqual(test.pending.request); expect(test.calls[2]!.headers.get('x-docatlas-csrf')).toBe('a'.repeat(43))
  expect(test.client.state()).toEqual(before); expect([...test.values]).toEqual(stored)
})
it('accepts a matching completed source receipt if SSE advanced to its new generation first, without auto-selecting', async () => {
  const test = await setup(), gate = Promise.withResolvers<Response>(), request = structuredClone(test.pending.request)
  test.respond(() => gate.promise)
  const work = test.client.lineageCommand(test.identity.conversationId, request)
  request.action = { kind: 'fork', targetEntryId: 'entry:changed', position: 'at' }
  await test.generationChanged()
  const before = structuredClone(test.client.state())
  gate.resolve(json(test.operation)); await expect(work).resolves.toEqual(test.operation)
  expect(test.calls[0]!.body).toEqual(test.pending.request)
  expect(test.client.state()).toEqual(before); expect(test.client.state().snapshot!.binding.generation).toBe(2)
})
it('allows old-generation metadata-only recovery only after GET matches the exact original operation and body', async () => {
  const test = await setup(), cid = test.identity.conversationId
  await test.generationChanged()
  await expect(test.client.lineageCommand(cid, test.pending.request)).rejects.toThrow('original generation')
  expect(test.calls).toHaveLength(0)
  const before = structuredClone(test.client.state())
  await expect(test.client.lineageCommand(cid, test.pending.request, test.operation.operationId)).resolves.toEqual(test.operation)
  expect(test.calls.map(call => call.method)).toEqual(['GET', 'POST']); expect(test.calls[1]!.body).toEqual(test.pending.request)
  expect((test.calls[1]!.body as typeof test.pending.request).expectedGeneration).toBe(1)
  expect(test.client.state()).toEqual(before)
})
it('does not POST a rewritten original key/body when the preflight operation hash differs', async () => {
  const test = await setup(); await test.generationChanged()
  await expect(test.client.lineageCommand(test.identity.conversationId, { ...test.pending.request, idempotencyKey: 'lineage:rewritten-original-key' }, test.operation.operationId)).rejects.toThrow('complete original command')
  expect(test.calls).toHaveLength(1); expect(test.calls[0]!.method).toBe('GET')
})
it('rejects foreign target owners, wrong full hashes and stale tree generations', async () => {
  const test = await setup()
  for (const value of [
    { ...test.operation, requestHash: '0'.repeat(64) },
    { ...test.operation, result: { ...test.operation.result!, targetBinding: { ...test.target, ownerActorId: 'actor:foreign' } } },
    { ...test.operation, result: { ...test.operation.result!, editorText: 'A private SDK prompt is not public history' } },
  ]) {
    test.respond(() => json(value))
    await expect(test.client.lineageOperation(test.identity.conversationId, test.operation.operationId)).rejects.toThrow()
  }
  const count = test.calls.length
  await expect(test.client.lineageTree(test.identity.conversationId, { schemaVersion: 1, kind: 'native-tree-request', expectedGeneration: 2, view: 'messages', cursor: null })).rejects.toThrow('generation')
  expect(test.calls).toHaveLength(count)
})
it('fences a response after async hashing when the user selects another conversation', async () => {
  const test = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
  const work = test.client.lineageOperation(test.identity.conversationId, test.operation.operationId), rejected = expect(work).rejects.toThrow()
  await entered.promise; await test.client.select(test.other.conversationId)
  const before = structuredClone(test.client.state()); release.resolve(); await rejected
  expect(test.client.state()).toEqual(before)
})
it('does not let an old 401 erase a newly paired actor or their draft', async () => {
  const test = await setup(), gate = Promise.withResolvers<Response>()
  test.respond(() => gate.promise)
  const work = test.client.lineageOperation(test.identity.conversationId, test.operation.operationId), rejected = expect(work).rejects.toThrow()
  await test.actorChanged(); test.client.setDraft('新用户草稿')
  const before = structuredClone(test.client.state())
  gate.resolve(json({ schemaVersion: 1, kind: 'api-error', code: 'unauthorized' }, 401)); await rejected
  expect(test.client.state()).toEqual(before); expect(test.client.state().actor?.actorId).toBe('actor:replacement')
})
