import { afterEach, expect, it, vi } from 'vitest'
import { LiveClient, type EventStream } from '../src/live/client'
import { learningFrame } from '../src/live/learning-state'
import { learningFixture } from './learning-fixture'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.restoreAllMocks() })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
async function setup() {
  const f = await learningFixture(), calls: Array<{ path: string, body: unknown, headers: Headers }> = [], operation = await f.operation()
  let actor = f.actor, respond: ((path: string, body: unknown) => Response | Promise<Response>) | undefined
  const stream: EventStream = { addEventListener() {}, close() {}, onerror: null, onopen: null }
  const client = new LiveClient({ storage: f.storage, events: () => stream, fetch: (async (input, options) => {
    const path = String(input)
    if (path === '/api/bootstrap' || path === '/api/auth/exchange') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
    if (path === '/api/conversations') return json({ schemaVersion: 1, kind: 'conversation-list', items: actor.actorId === f.actor.actorId ? [f.binding] : [], nextCursor: null })
    if (path.endsWith('/snapshot')) return json(f.snapshot)
    const body = options?.body === undefined ? undefined : JSON.parse(String(options.body)) as unknown
    calls.push({ path, body, headers: new Headers(options?.headers) })
    return respond ? respond(path, body) : json(path.endsWith('/query') ? f.view : operation)
  }) as typeof fetch })
  cleanup.push(() => client.dispose()); await client.start()
  const query = { ...learningFrame(f.owner), kind: 'learning-query' as const, messageId: f.material.manifest.messageId }
  return { ...f, client, query, calls, operationValue: operation, respond(fn: typeof respond) { respond = fn },
    changeActor: async () => { actor = { ...actor, actorId: 'actor:learning-next' }; await client.pair('a'.repeat(43)) } }
}

it('uses only the three authenticated learning routes, accepts early null candidates, and leaves Ask drafts/sources unchanged', async () => {
  const f = await setup(); f.client.setDraft('Question stays independent'); f.client.setSources([{ documentId: 'document:chosen', revisionId: 'revision:chosen' }])
  const before = structuredClone(f.client.state()), stored = [...f.values]
  expect(await f.client.learningQuery(f.binding.conversationId, f.query)).toEqual(f.view)
  expect(await f.client.learningCommand(f.binding.conversationId, f.request)).toEqual(f.operationValue)
  expect(await f.client.learningOperation(f.binding.conversationId, f.operationValue.operationId)).toEqual(f.operationValue)
  const base = `/api/conversations/${encodeURIComponent(f.binding.conversationId)}/learning`
  expect(f.calls.map(call => call.path)).toEqual([`${base}/query`, base, `${base}/operations/${encodeURIComponent(f.operationValue.operationId)}`])
  expect(f.calls.slice(0, 2).every(call => call.headers.get('x-docatlas-csrf') === 'a'.repeat(43))).toBe(true)
  expect(f.client.state()).toEqual(before); expect([...f.values]).toEqual(stored)
})
it('rejects changed native material, complete command hashes, epochs and returned operation identity', async () => {
  const f = await setup(), operation = f.operationValue
  f.respond(() => json({ ...f.view, comparison: { ...f.view.comparison!, material: { ...f.material, nativeTextHash: 'f'.repeat(64) } } }))
  await expect(f.client.learningQuery(f.binding.conversationId, f.query)).rejects.toThrow()
  for (const value of [{ ...operation, receipt: null }, { ...operation, receipt: { ...operation.receipt!, requestHash: 'f'.repeat(64) } },
    { ...operation, profileEpoch: 1, receipt: { ...operation.receipt!, profileEpoch: 1 } }, { ...operation, binding: { ...f.binding, bindingId: 'binding:foreign' } }]) {
    f.respond(() => json(value)); await expect(f.client.learningCommand(f.binding.conversationId, f.request)).rejects.toThrow()
  }
  f.respond(() => json(operation))
  await expect(f.client.learningOperation(f.binding.conversationId, `learning-op:${'f'.repeat(64)}`)).rejects.toThrow('identity')
})
it('freezes commands before transport and fences a newly paired actor during async response hashing and late 401', async () => {
  const first = await setup(), gate = Promise.withResolvers<Response>(), original = structuredClone(first.request)
  first.respond(() => gate.promise)
  const work = first.client.learningCommand(first.binding.conversationId, first.request)
  first.request.idempotencyKey = 'learning:mutated-after-call'
  gate.resolve(json(first.operationValue)); expect(await work).toEqual(first.operationValue); expect(first.calls[0]!.body).toEqual(original)
  for (const variant of ['digest', 'unauthorized'] as const) {
    const f = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), delayed = Promise.withResolvers<Response>()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    if (variant === 'digest') vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const result = await digest(algorithm, bytes); entered.resolve(); await release.promise; return result })
    else f.respond(() => delayed.promise)
    const pending = f.client.learningQuery(f.binding.conversationId, f.query), rejected = expect(pending).rejects.toThrow()
    if (variant === 'digest') await entered.promise
    await f.changeActor(); const before = structuredClone(f.client.state())
    if (variant === 'digest') release.resolve(); else delayed.resolve(json({ error: 'expired' }, 401))
    await rejected; expect(f.client.state()).toEqual(before); expect(f.client.state().actor?.actorId).toBe('actor:learning-next')
    vi.restoreAllMocks()
  }
})
