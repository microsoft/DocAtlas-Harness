import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProductLearningCommand, ProductLearningOperation, ProductLearningQuery, ProductLearningView } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { enrichmentHash } from '@docatlas/core'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { startDocAtlasApplication } from '../src/application.js'
import { ProductLearning } from '../src/personalization/learning.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-learning-http-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const model = await createPiTestModel({ answers: ['Human learning configuration must not call the model.'] })
  const app = await startDocAtlasApplication({ root, projectRoot: resolve('.'), webRoot: resolve('apps/web/dist'), port: 0, modelRuntime: model.modelRuntime, models: model.models })
  cleanup.push(() => app.close())
  const binding = app.control.conversations(app.actor).items[0]!, headers = { origin: app.origin, 'content-type': 'application/json' }
  const auth = await fetch(`${app.origin}/api/auth/exchange`, { method: 'POST', headers,
    body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code: app.pairingCode }) })
  expect(auth.status).toBe(200)
  const bootstrap = parseContract('product-http', await auth.json()); if (bootstrap.kind !== 'bootstrap') throw new Error('Missing actual pairing')
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!, authenticated = { ...headers, cookie, 'x-docatlas-csrf': bootstrap.csrfToken }
  const base = `${app.origin}/api/conversations/${encodeURIComponent(binding.conversationId)}/learning`
  const post = (body: unknown, suffix = '', supplied = authenticated) => fetch(base + suffix, { method: 'POST', headers: supplied, body: JSON.stringify(body) })
  const get = (suffix: string, supplied: Record<string, string> = { cookie }) => fetch(base + suffix, { headers: supplied })
  const query: ProductLearningQuery = { schemaVersion: 1, kind: 'learning-query', expectedBindingId: binding.bindingId, expectedGeneration: binding.generation }
  const configure: ProductLearningCommand = { ...query, kind: 'learning-command', expectedProfileEpoch: 0, idempotencyKey: 'learning:http:configure', action: 'configure', expectedSettingsVersion: 0, enabled: true }
  const view = async () => { const response = await post(query, '/query'); expect(response.status).toBe(200); return await response.json() as ProductLearningView }
  const commit = async (command = configure) => { const response = await post(command); expect(response.status).toBe(200); return parseContract('product-learning', await response.json()) as ProductLearningOperation }
  return { app, model, binding, query, configure, post, get, view, commit, authenticated }
}

it('authenticates learning settings and keeps invitation, contribution and Pi execution independent', async () => {
  const f = await fixture(), initial = await f.view()
  expect(initial).toMatchObject({ kind: 'learning-view', binding: f.binding, profileEpoch: 0, settings: { version: 0, enabled: false }, contributionAllowed: false, offers: [], messageId: null, comparison: null })
  const before = f.app.control.list(f.app.actor, f.binding.conversationId).items
  const operation = await f.commit()
  expect(operation.receipt).toMatchObject({ action: 'configure', idempotencyKey: f.configure.idempotencyKey, requestHash: enrichmentHash(f.configure),
    actorId: f.app.actor.actorId, workspaceId: f.app.actor.workspaceId, conversationId: f.binding.conversationId, bindingId: f.binding.bindingId,
    profileEpoch: 0, targetVersion: 1, candidateId: null, memoryVersionId: null })
  expect(await f.view()).toMatchObject({ settings: { version: 1, enabled: true }, contributionAllowed: false, offers: [] })
  expect(await f.view()).toMatchObject({ settings: { version: 1, enabled: true }, offers: [] })
  expect(f.app.control.list(f.app.actor, f.binding.conversationId).items).toEqual(before)
  expect(f.app.documents.store.get(f.binding.conversationId)).toMatchObject({ status: 'unbound' })
  expect(f.model.getCallCount()).toBe(0)
}, 30000)

it('queries immutable original command metadata across authorized binding changes without rebasing or issuing a new effect', async () => {
  const f = await fixture(), original = await f.commit()
  const next = f.app.control.rebind(f.app.actor, f.binding.conversationId, f.binding.version, f.binding.runtimeSessionId, null)
  const response = await f.get(`/operations/${original.operationId}`)
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...original, binding: next })
  expect(await f.commit()).toEqual({ ...original, binding: next })
  expect((await f.post({ ...f.configure, enabled: false })).status).toBe(409)
  expect((await f.post({ ...f.configure, idempotencyKey: 'learning:http:stale-new-key' })).status).toBe(409)
  expect(f.model.getCallCount()).toBe(0)
}, 30000)

it('rejects foreign identity, non-CSRF writes, source paths and server records before dispatch', async () => {
  const f = await fixture(), command = vi.spyOn(ProductLearning.prototype, 'command')
  expect((await f.get(`/operations/learning-op:${'a'.repeat(64)}`, {})).status).toBe(401)
  expect((await f.post(f.configure, '', { ...f.authenticated, 'x-docatlas-csrf': 'x'.repeat(43) })).status).toBe(403)
  expect((await f.post(f.configure, '', { ...f.authenticated, origin: 'https://untrusted.invalid' })).status).toBe(403)
  for (const body of [{ ...f.configure, actorId: 'actor:other' }, { ...f.configure, profileId: 'profile:other' }, { ...f.configure, path: '/private/profile.sqlite3' },
    { ...f.configure, action: 'auto-activate' }, { ...f.query, kind: 'learning-view' }]) expect((await f.post(body)).status).toBe(400)
  expect((await f.get('/query')).status).toBe(404)
  expect(command).not.toHaveBeenCalled()
}, 30000)

it('independently validates current reply ownership, query target and original command hashes at HTTP boundaries', async () => {
  const f = await fixture(), original = await f.commit(), view = await f.view()
  const query = vi.spyOn(ProductLearning.prototype, 'query').mockReturnValue({ ...view, messageId: 'message:another' })
  expect((await f.post(f.query, '/query')).status).toBe(503)
  query.mockReturnValue({ ...view, profileEpoch: view.profileEpoch + 1 })
  expect((await f.post(f.query, '/query')).status).toBe(503)
  query.mockReturnValue({ ...view, profileId: 'profile:another' })
  expect((await f.post(f.query, '/query')).status).toBe(503)
  const command = vi.spyOn(ProductLearning.prototype, 'command').mockReturnValue({ ...original, receipt: { ...original.receipt!, requestHash: 'f'.repeat(64) } })
  expect((await f.post(f.configure)).status).toBe(503)
  command.mockReturnValue({ ...original, receipt: { ...original.receipt!, targetVersion: 2 } })
  expect((await f.post(f.configure)).status).toBe(503)
  vi.spyOn(ProductLearning.prototype, 'operation').mockReturnValue(original)
  expect((await f.get(`/operations/learning-op:${'b'.repeat(64)}`)).status).toBe(503)
  expect(f.model.getCallCount()).toBe(0)
}, 30000)
