import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProductLineageInspection, ProductLineageOperation, ProductNativeTreePage, ProductNativeTreeRequest } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { canonical, ControlStore } from '../src/storage/control-store.js'
import { ProductAuth } from '../src/http/auth.js'
import { createProductHttpHandler, type ProductHttpOptions } from '../src/http/handler.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks() })
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const shared = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/native-lineage-cases.json', import.meta.url), 'utf8')) as { templates: Record<string, unknown> }

/** HTTP boundary fixture only. SDK/installation proofs are exercised independently
 * by native-lineage-manager and the real RuntimeManager-backed browser journeys. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-lineage-http-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(root); cleanup.push(() => control.close())
  const actor = { actorId: 'actor:lineage-http', workspaceId: 'workspace:lineage-http' }
  const binding = control.createConversation(actor, { conversationId: 'conversation:source', runtimeSessionId: 'session:source' })
  control.createConversation({ ...actor, actorId: 'actor:foreign' }, { conversationId: 'conversation:foreign', runtimeSessionId: 'session:foreign' })
  const templates = structuredClone(shared.templates)
  templates.sourceBinding = binding
  templates.navBinding = { ...binding, bindingId: 'binding:target', branchEntryId: 'entry:navigation', generation: binding.generation + 1, version: binding.version + 1 }
  templates.navCommand = { ...(templates.navCommand as object), expectedBindingId: binding.bindingId, expectedGeneration: binding.generation }
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand)
    if (!value || typeof value !== 'object') return value
    const input = value as Record<string, unknown>
    if (typeof input.$template === 'string') return expand(templates[input.$template])
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, expand(item)]))
  }
  const operation = expand(templates.navOperation) as ProductLineageOperation
  operation.requestHash = digest(operation.request); operation.result!.proof.requestHash = operation.requestHash
  parseContract('native-lineage', operation)
  const command = operation.request, accepted: ProductLineageOperation = { ...operation, state: 'accepted', result: null, version: 1 }
  const inspection: ProductLineageInspection = { schemaVersion: 1, kind: 'lineage-inspection', binding, resource: { approvalId: command.approvalId,
    version: command.expectedApprovalVersion, manifestHash: 'a'.repeat(64) }, head: command.expectedHead, busy: false, queued: 0, operations: [], truncated: false }
  const treeRequest: ProductNativeTreeRequest = { schemaVersion: 1, kind: 'native-tree-request', expectedGeneration: 1, view: 'messages', cursor: null }
  const tree: ProductNativeTreePage = { schemaVersion: 1, kind: 'native-tree-page', binding, head: command.expectedHead, view: 'messages', entries: [], nextCursor: null }
  const ports = { inspect: vi.fn(async () => structuredClone(inspection)), operation: vi.fn(async () => structuredClone(accepted)),
    command: vi.fn(async () => structuredClone(accepted)), tree: vi.fn(async () => structuredClone(tree)) } satisfies ProductHttpOptions['lineage']
  const coordinator = vi.fn(() => { throw new Error('A lineage read or stop must not start a cold runtime') }), stop = vi.fn(async () => {})
  let handler: ReturnType<typeof createProductHttpHandler>
  const server = createServer((request, response) => handler(request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth = new ProductAuth(origin)
  const session = auth.exchange(auth.issueBootstrap(actor).code), cookie = session.cookie.split(';')[0]!
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-docatlas-csrf': session.csrfToken }
  handler = createProductHttpHandler({ auth, control, coordinator, lineage: ports, stop })
  const path = `/api/conversations/${encodeURIComponent(binding.conversationId)}/lineage`
  const get = (suffix = '', supplied: Record<string, string> = { cookie }) => fetch(origin + path + suffix, { headers: supplied })
  const post = (value: unknown, suffix = '', supplied = headers) => fetch(origin + path + suffix, { method: 'POST', headers: supplied, body: JSON.stringify(value) })
  return { actor, binding, control, operation, accepted, command, inspection, treeRequest, tree, ports, coordinator, stop, origin, path, auth, cookie, headers, get, post }
}

it('authenticates all lineage reads and mutations before calling trusted ports; no client path or actor is accepted', async () => {
  const f = await fixture()
  expect((await f.get('', {})).status).toBe(401)
  expect((await f.post(f.command, '', { ...f.headers, origin: 'https://foreign.invalid' })).status).toBe(403)
  expect((await f.post(f.command, '', { ...f.headers, 'x-docatlas-csrf': 'z'.repeat(43) })).status).toBe(403)
  expect((await f.post({ ...f.command, actorId: 'actor:foreign' })).status).toBe(400)
  expect((await f.post({ ...f.treeRequest, path: '/private/native.jsonl' }, '/tree')).status).toBe(400)
  expect((await f.post({ ...f.command, conversationId: 'conversation:other' })).status).toBe(400)
  expect((await f.post({ ...f.treeRequest, expectedGeneration: 2 }, '/tree')).status).toBe(409)
  expect((await fetch(`${f.origin}/api/conversations/conversation:foreign/lineage`, { headers: { cookie: f.cookie } })).status).toBe(404)
  expect((await f.get('?cursor=not-a-route-parameter')).status).toBe(400)
  expect((await f.get('/tree')).status).toBe(404)
  expect((await f.post({}, `/operations/${f.accepted.operationId}`)).status).toBe(404)
  for (const port of Object.values(f.ports)) expect(port).not.toHaveBeenCalled()
  expect(f.coordinator).not.toHaveBeenCalled()
})

it('keeps GET strictly read-only and tree POST as bounded inspection, while pending command returns 202', async () => {
  const f = await fixture()
  const inspected = await f.get(); expect(inspected.status).toBe(200); expect(await inspected.json()).toEqual(f.inspection)
  const original = await f.get(`/operations/${f.accepted.operationId}`); expect(original.status).toBe(200); expect(await original.json()).toEqual(f.accepted)
  const tree = await f.post(f.treeRequest, '/tree'); expect(tree.status).toBe(200); expect(await tree.json()).toEqual(f.tree)
  expect(f.ports.command).not.toHaveBeenCalled(); expect(f.coordinator).not.toHaveBeenCalled()
  const accepted = await f.post(f.command); expect(accepted.status).toBe(202); expect(await accepted.json()).toEqual(f.accepted)
  expect(f.ports.command).toHaveBeenCalledOnce()
  expect(accepted.headers.get('cache-control')).toBe('no-store')
})

it('permits the exact original operation receipt after a legitimate generation handoff without rebasing its command', async () => {
  const f = await fixture(), original = structuredClone(f.command)
  f.ports.command.mockImplementation(async () => {
    f.control.commitNativeHandoff(f.actor, f.binding, f.operation.result!.targetBinding)
    return structuredClone(f.operation)
  })
  const response = await f.post(f.command)
  expect(response.status).toBe(200); expect(await response.json()).toEqual(f.operation)
  expect(f.control.binding(f.actor, f.binding.conversationId).generation).toBe(2)
  f.ports.operation.mockResolvedValue(f.operation)
  const lookup = await f.get(`/operations/${f.operation.operationId}`)
  expect(lookup.status).toBe(200); expect(await lookup.json()).toEqual(f.operation)
  const retry = await f.post(original)
  expect(retry.status).toBe(200); expect(await retry.json()).toEqual(f.operation)
  expect(f.ports.command.mock.calls).toHaveLength(2)
  expect(f.command).toEqual(original)
})

it('rejects stale tree/inspection responses but never mistakes a forged operation hash, owner or body for recovery', async () => {
  const f = await fixture()
  f.ports.inspect.mockImplementation(async () => { f.control.commitNativeHandoff(f.actor, f.binding, f.operation.result!.targetBinding); return f.inspection })
  expect((await f.get()).status).toBe(409)
  f.ports.command.mockResolvedValue({ ...f.accepted, requestHash: '0'.repeat(64) })
  expect((await f.post(f.command)).status).toBe(503)
  f.ports.command.mockResolvedValue({ ...f.accepted, sourceBinding: { ...f.binding, ownerActorId: 'actor:foreign' } })
  expect((await f.post(f.command)).status).toBe(503)
  const changed = { ...f.command, action: { ...f.command.action, targetEntryId: 'entry:changed' } }
  f.ports.command.mockResolvedValue({ ...f.accepted, request: changed, requestHash: digest(changed) })
  expect((await f.post(f.command)).status).toBe(503)
  f.ports.operation.mockResolvedValue({ ...f.accepted, operationId: 'lineage:another-operation' })
  expect((await f.get(`/operations/${f.accepted.operationId}`)).status).toBe(503)
})

it('reauthenticates after awaited lineage inspection and does not disclose late results after logout', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.ports.inspect.mockImplementation(async () => { entered.resolve(); await release.promise; return f.inspection })
  const pending = f.get(); await entered.promise; f.auth.logout(f.cookie); release.resolve()
  const response = await pending
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ schemaVersion: 1, kind: 'api-error', code: 'unauthenticated' })
})

it('uses the dedicated owned-task stop port and waits for its actual join instead of cold coordinator lookup', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.stop.mockImplementation(async () => { entered.resolve(); await release.promise })
  let finished = false
  const work = fetch(`${f.origin}/api/conversations/${encodeURIComponent(f.binding.conversationId)}/stop`, { method: 'POST', headers: f.headers, body: '{}' })
    .then(response => { finished = true; return response })
  await entered.promise; expect(finished).toBe(false); expect(f.coordinator).not.toHaveBeenCalled()
  release.resolve(); const response = await work
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ kind: 'runtime-stopped', conversationId: f.binding.conversationId, generation: 1 })
  expect(f.stop).toHaveBeenCalledWith(f.actor, f.binding.conversationId)
})

it('rejects a stale Web Stop tag before it can cancel the new binding, while retaining the legacy empty-body API', async () => {
  const f = await fixture(), target = f.operation.result!.targetBinding
  f.control.commitNativeHandoff(f.actor, f.binding, target)
  const stop = (tag?: string) => fetch(`${f.origin}/api/conversations/${encodeURIComponent(f.binding.conversationId)}/stop`, {
    method: 'POST', headers: { ...f.headers, ...(tag === undefined ? {} : { 'if-match': tag }) }, body: '{}',
  })
  const stale = await stop(JSON.stringify(f.binding.bindingId))
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'conflict' })
  for (const tag of ['*', `W/${JSON.stringify(target.bindingId)}`, target.bindingId, `${JSON.stringify(target.bindingId)}, ${JSON.stringify(target.bindingId)}`]) {
    expect((await stop(tag)).status).toBe(400)
  }
  expect(f.stop).not.toHaveBeenCalled(); expect(f.coordinator).not.toHaveBeenCalled()
  expect((await stop(JSON.stringify(target.bindingId))).status).toBe(200)
  expect(f.stop).toHaveBeenCalledOnce()
  expect((await stop()).status).toBe(200)
  expect(f.stop).toHaveBeenCalledTimes(2)
})
