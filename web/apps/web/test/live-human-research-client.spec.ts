import { afterEach, expect, it, vi } from 'vitest'
import type { HumanResearchCommand, ProductBinding } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { humanResearchReceiptMatches } from '../src/live/human-research-state'
import { humanResearchFixture } from './human-research-fixture'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
type Call = { path: string, method: string, headers: Headers, body: unknown }
async function setup() {
  const f = await humanResearchFixture(), calls: Call[] = [], committed = await f.operation()
  let binding = f.binding, actor = { actorId: f.owner.actorId, workspaceId: f.owner.workspaceId }, respond: ((call: Call) => Response | Promise<Response>) | undefined
  const other = { ...binding, conversationId: 'conversation:other', bindingId: 'binding:other', runtimeSessionId: 'session:other' }
  const bindings = (): ProductBinding[] => actor.actorId === f.owner.actorId ? [binding, other] : [{ ...other, conversationId: 'conversation:replacement', ownerActorId: actor.actorId, workspaceId: actor.workspaceId }]
  const client = new LiveClient({ storage: f.storage, events: () => ({ addEventListener() {}, close() {}, onerror: null, onopen: null }) satisfies EventStream,
    fetch: (async (input, options) => {
      const path = String(input)
      if (path === '/api/bootstrap') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
      if (path === '/api/conversations') return json({ schemaVersion: 1, kind: 'conversation-list', items: bindings(), nextCursor: null })
      if (path.endsWith('/snapshot')) return json({ ...f.snapshot, binding: bindings().find(value => path.includes(encodeURIComponent(value.conversationId)))! })
      if (path === '/api/auth/logout') return new Response(null, { status: 204 })
      const call: Call = { path, method: options?.method ?? 'GET', headers: new Headers(options?.headers), body: options?.body ? JSON.parse(String(options.body)) as unknown : null }
      calls.push(call)
      if (path === '/api/submissions') throw new TypeError('Transport outcome intentionally unknown; never a fake durable receipt')
      if (respond) return respond(call)
      if (path.endsWith('/research-workbench')) return json(committed)
      if (path.includes('/operations/')) return json({ ...committed, binding })
      if (path.endsWith('/query')) return json({ ...f.workspace, binding })
      if (path.endsWith('/overlay')) return json({ ...f.overlay, binding })
      if (path.includes('/focus/')) return json({ ...f.focus, binding })
      if (path.includes('/entries/')) return json({ ...f.entry, binding })
      throw new Error('Unexpected human research test route')
    }) as typeof fetch })
  cleanup.push(() => client.dispose()); await client.start(); expect(client.state().phase).toBe('ready')
  return { ...f, client, committed, other, calls, respond(value: typeof respond) { respond = value },
    async generationChanged() { binding = { ...binding, generation: 2, version: 2, bindingId: 'binding:next' }; await client.refresh(); return binding },
    async actorChanged() { await client.logout(); actor = { actorId: 'actor:replacement', workspaceId: 'workspace:replacement' }; await client.start() } }
}

it('keeps a genuine uncertain Ask outbox independent while all six human APIs authenticate and return typed results', async () => {
  const f = await setup(), cid = f.owner.conversationId
  f.client.setDraft('这条问题结果尚未确认，不要替换原键或资料。'); f.client.setSources([f.sourceRef]); await f.client.submit('prompt')
  expect(f.client.state().request).not.toBeNull()
  const before = structuredClone(f.client.state()), stored = [...f.values]
  await expect(f.client.humanResearchCommand(cid, f.command)).resolves.toEqual(f.committed)
  await expect(f.client.humanResearchOperation(cid, f.committed.operationId)).resolves.toEqual(f.committed)
  await expect(f.client.humanResearchQuery(cid, f.query)).resolves.toEqual(f.workspace)
  await expect(f.client.humanResearchEntry(cid, f.entry.entry.recordId)).resolves.toEqual(f.entry)
  await expect(f.client.humanResearchOverlay(cid, f.overlayQuery)).resolves.toEqual(f.overlay)
  await expect(f.client.humanResearchFocus(cid, f.entry.entry.recordId, f.locator.locatorId)).resolves.toEqual(f.focus)
  const calls = f.calls.filter(value => value.path.includes('/research-workbench'))
  expect(calls.map(value => value.method)).toEqual(['POST', 'GET', 'POST', 'GET', 'POST', 'POST'])
  expect(calls.filter(value => value.method === 'POST').every(value => value.headers.get('x-docatlas-csrf') === 'a'.repeat(43))).toBe(true)
  expect(calls[0]!.body).toEqual(f.command); expect(calls[5]!.body).toEqual({})
  expect(f.client.state()).toEqual(before); expect([...f.values]).toEqual(stored)
})
it('freezes the entire command before sending and hashes the same original data after the response', async () => {
  const f = await setup(), gate = Promise.withResolvers<Response>(), command = structuredClone(f.command)
  f.respond(() => gate.promise)
  const work = f.client.humanResearchCommand(f.owner.conversationId, command)
  if (command.action !== 'create') throw new Error('Create fixture expected')
  command.entry = { recordType: 'open-question', question: 'Do not rewrite the original call' }; command.sourceRefs.push(f.sourceRef)
  gate.resolve(json(f.committed)); await expect(work).resolves.toEqual(f.committed)
  expect(f.calls[0]!.body).toEqual(f.command)
})
it('rejects malformed, stale and model-authored command fields before issuing any HTTP request', async () => {
  const f = await setup(), cid = f.owner.conversationId
  for (const candidate of [{ ...f.command, expectedGeneration: 2 }, { ...f.command, expectedBindingId: 'binding:other' }, { ...f.command, createdBy: { kind: 'agent', actorId: 'model' } },
    { ...f.command, sourceRefs: undefined }, { ...f.command, entry: { recordType: 'research-policy', title: 'Rule', directive: 'Stored, not enforced', policyScope: 'workspace' }, selections: [f.proposal] }]) {
    await expect(f.client.humanResearchCommand(cid, candidate as HumanResearchCommand)).rejects.toThrow()
  }
  expect(f.calls).toEqual([])
})
it('treats a null operation lookup as unknown, but never as a successful POST receipt', async () => {
  const f = await setup(), missing = { ...f.committed, receipt: null }
  f.respond(() => json(missing))
  await expect(f.client.humanResearchOperation(f.owner.conversationId, missing.operationId)).resolves.toEqual(missing)
  await expect(f.client.humanResearchCommand(f.owner.conversationId, f.command)).rejects.toThrow('receipt')
})
it('allows only read-only original-operation lookup after generation advance; fresh writes cannot reuse the old frame', async () => {
  const f = await setup(), current = await f.generationChanged(), before = structuredClone(f.client.state())
  const result = await f.client.humanResearchOperation(f.owner.conversationId, f.committed.operationId)
  expect(result.binding).toEqual(current); expect(await humanResearchReceiptMatches(f.pending, result)).toBe(true)
  await expect(f.client.humanResearchCommand(f.owner.conversationId, f.command)).rejects.toThrow('binding')
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.method).toBe('GET'); expect(f.client.state()).toEqual(before)
})
it('rejects changed full hashes, foreign owners, wrong entry IDs, filter views and wrong original source', async () => {
  const f = await setup(), cid = f.owner.conversationId
  for (const value of [{ ...f.committed, receipt: { ...f.committed.receipt!, requestHash: '0'.repeat(64) } }, { ...f.committed, binding: { ...f.binding, ownerActorId: 'actor:other' } }]) {
    f.respond(() => json(value)); await expect(f.client.humanResearchCommand(cid, f.command)).rejects.toThrow()
  }
  f.respond(() => json({ ...f.entry, entry: { ...f.entry.entry, recordId: 'note:other' } })); await expect(f.client.humanResearchEntry(cid, f.entry.entry.recordId)).rejects.toThrow()
  f.respond(() => json({ ...f.workspace, result: { ...f.workspace.result, view: 'working' } })); await expect(f.client.humanResearchQuery(cid, f.query)).rejects.toThrow()
  f.respond(() => json({ ...f.overlay, result: { ...f.overlay.result, source: { ...f.overlay.result.source, revisionId: 'rev:other' } } })); await expect(f.client.humanResearchOverlay(cid, f.overlayQuery)).rejects.toThrow()
  f.respond(() => json({ ...f.focus, focus: { ...f.focus.focus, recordId: 'note:other' } })); await expect(f.client.humanResearchFocus(cid, f.entry.entry.recordId, f.locator.locatorId)).rejects.toThrow()
})
it('fences late successful and unauthorized responses after a same-conversation binding change', async () => {
  for (const status of [200, 401]) {
    const f = await setup(), gate = Promise.withResolvers<Response>()
    f.respond(() => gate.promise)
    const work = f.client.humanResearchEntry(f.owner.conversationId, f.entry.entry.recordId), rejected = expect(work).rejects.toThrow()
    await f.generationChanged(); f.client.setDraft('新代际草稿')
    const before = structuredClone(f.client.state()), stored = [...f.values]
    gate.resolve(json(status === 200 ? f.entry : { schemaVersion: 1, kind: 'api-error', code: 'unauthorized' }, status)); await rejected
    expect(f.client.state()).toEqual(before); expect([...f.values]).toEqual(stored)
  }
})
it('does not allow an old unauthorized response to erase a newly paired user or a new conversation', async () => {
  const f = await setup(), gate = Promise.withResolvers<Response>()
  f.respond(() => gate.promise)
  const work = f.client.humanResearchOperation(f.owner.conversationId, f.committed.operationId), rejected = expect(work).rejects.toThrow()
  await f.actorChanged(); f.client.setDraft('新用户草稿')
  const before = structuredClone(f.client.state())
  gate.resolve(json({ schemaVersion: 1, kind: 'api-error', code: 'unauthorized' }, 401)); await rejected
  expect(f.client.state()).toEqual(before)
})
it('rechecks the actual owner after asynchronous operation hashing, not just when response parsing finishes', async () => {
  const f = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
  f.respond(() => json(f.committed))
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
  const work = f.client.humanResearchCommand(f.owner.conversationId, f.command), rejected = expect(work).rejects.toThrow()
  await entered.promise; await f.client.select(f.other.conversationId)
  const before = structuredClone(f.client.state()); release.resolve(); await rejected
  expect(f.client.state()).toEqual(before)
})
