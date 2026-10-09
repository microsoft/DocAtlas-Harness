import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { enrichmentHash } from '@docatlas/core'
import type { HumanResearchCommand, HumanResearchOperation, HumanResearchQuery } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { startDocAtlasApplication } from '../src/application.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-human-http-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const model = await createPiTestModel({ answers: ['This model must not run for human authoring.'] })
  const app = await startDocAtlasApplication({ root, projectRoot: resolve('.'), webRoot: resolve('apps/web/dist'), port: 0,
    modelRuntime: model.modelRuntime, models: model.models })
  cleanup.push(() => app.close())
  const binding = app.control.conversations(app.actor).items[0]!
  const headers = { origin: app.origin, 'content-type': 'application/json' }
  const exchange = await fetch(`${app.origin}/api/auth/exchange`, { method: 'POST', headers,
    body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code: app.pairingCode }) })
  expect(exchange.status).toBe(200)
  const bootstrap = parseContract('product-http', await exchange.json())
  if (bootstrap.kind !== 'bootstrap') throw new Error('Missing paired session')
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!
  const authenticated = { ...headers, cookie, 'x-docatlas-csrf': bootstrap.csrfToken }
  const path = `/api/conversations/${encodeURIComponent(binding.conversationId)}/research-workbench`
  const command = (entry: Extract<HumanResearchCommand, { action: 'create' }>['entry'], key: string): HumanResearchCommand => ({ schemaVersion: 1,
    kind: 'human-research-command', expectedBindingId: binding.bindingId, expectedGeneration: binding.generation, idempotencyKey: `human:http:${key}`,
    action: 'create', entry, sourceRefs: [], selections: [] })
  const post = (body: unknown, suffix = '', supplied = authenticated) => fetch(app.origin + path + suffix, { method: 'POST', headers: supplied, body: JSON.stringify(body) })
  const get = (suffix: string, supplied: Record<string, string> = { cookie }) => fetch(app.origin + path + suffix, { headers: supplied })
  const commit = async (request: HumanResearchCommand) => {
    const response = await post(request); expect(response.status).toBe(200)
    const result = parseContract('human-research', await response.json())
    if (!('kind' in result) || result.kind !== 'human-research-operation' || !result.receipt) throw new Error('Missing actual committed human receipt')
    expect(result.receipt.requestHash).toBe(enrichmentHash(request))
    expect(result.receipt).toMatchObject({ actorId: app.actor.actorId, workspaceId: app.actor.workspaceId, conversationId: binding.conversationId,
      bindingId: request.expectedBindingId, generation: request.expectedGeneration, idempotencyKey: request.idempotencyKey, action: request.action })
    return result as HumanResearchOperation & { receipt: NonNullable<HumanResearchOperation['receipt']> }
  }
  const query: HumanResearchQuery = { schemaVersion: 1, kind: 'human-research-query', expectedBindingId: binding.bindingId, expectedGeneration: binding.generation,
    view: 'workspace', recordTypes: ['research-note', 'open-question', 'project-decision', 'research-policy'], recordStatuses: ['active', 'open', 'resolved', 'archived'], maxItems: 50, maxChars: 12000 }
  return { app, model, binding, command, query, commit, post, get, path, cookie, authenticated }
}

it('routes real human authoring through authenticated domain transactions without invoking Pi or admitting a document', async () => {
  const f = await fixture(), commands = [
    f.command({ recordType: 'research-note', noteKind: 'commentary', body: 'A human-owned free note.' }, 'free-note-original'),
    f.command({ recordType: 'open-question', question: 'What should we verify next?' }, 'free-question-original'),
    f.command({ recordType: 'project-decision', title: 'Review approach', decision: 'Read the original revisions independently.' }, 'decision-original'),
    f.command({ recordType: 'research-policy', title: 'Research instruction', directive: 'Keep units visible.', policyScope: 'workspace' }, 'policy-original'),
  ]
  for (const command of commands) {
    const operation = await f.commit(command)
    const response = await f.get(`/entries/${encodeURIComponent(operation.receipt.recordId)}`)
    expect(response.status).toBe(200)
    const value = parseContract('human-research', await response.json())
    expect(value).toMatchObject({ kind: 'human-research-entry', binding: f.binding, entry: { recordType: command.action === 'create' ? command.entry.recordType : null, version: 1 } })
  }
  const listing = await f.post(f.query, '/query')
  expect(listing.status).toBe(200)
  expect(parseContract('human-research', await listing.json())).toMatchObject({ kind: 'human-research-workspace', result: { pageInfo: { total: 4, returned: 4 } } })
  expect(f.app.control.list(f.app.actor, f.binding.conversationId).items).toEqual([])
  expect(f.app.documents.store.get(f.binding.conversationId)).toMatchObject({ status: 'unbound' })
  expect(f.model.getCallCount()).toBe(0)
}, 30000)

it('returns exact original commit metadata after edit, deletion and binding change without resurrecting old text or re-signing a command', async () => {
  const f = await fixture(), request = f.command({ recordType: 'research-note', noteKind: 'scratch', body: 'Sensitive original prose stays out of replay metadata.' }, 'immutable-original')
  const original = await f.commit(request), recordId = original.receipt.recordId
  const edit: HumanResearchCommand = { schemaVersion: 1, kind: 'human-research-command', expectedBindingId: f.binding.bindingId, expectedGeneration: 1,
    idempotencyKey: 'human:http:edit-existing-note', action: 'edit', recordId, expectedVersion: 1, text: 'A later full replacement.' }
  await f.commit(edit)
  await f.commit({ schemaVersion: 1, kind: 'human-research-command', expectedBindingId: f.binding.bindingId, expectedGeneration: 1,
    idempotencyKey: 'human:http:delete-existing-note', action: 'delete', recordId, expectedVersion: 2 })
  const removed = await f.get(`/entries/${encodeURIComponent(recordId)}`)
  expect(removed.status).toBe(200); expect(await removed.json()).toMatchObject({ entry: { status: 'deleted', text: null, locators: [], evidence: [], version: 3 } })
  const next = f.app.control.rebind(f.app.actor, f.binding.conversationId, f.binding.version, f.binding.runtimeSessionId, null)
  const lookup = await f.get(`/operations/${original.operationId}`)
  expect(lookup.status).toBe(200)
  expect(await lookup.json()).toEqual({ ...original, binding: next })
  const replay = await f.post(request)
  expect(replay.status).toBe(200)
  const value = await replay.json()
  expect(value).toEqual({ ...original, binding: next }); expect(JSON.stringify(value)).not.toContain('Sensitive original prose')
  expect((await f.post({ ...request, idempotencyKey: 'human:http:old-frame-new-key' })).status).toBe(409)
  expect((await f.post({ ...request, entry: { recordType: 'research-note', noteKind: 'scratch', body: 'Changed same key.' } })).status).toBe(409)
  expect(f.model.getCallCount()).toBe(0)
}, 30000)

it('authenticates before dispatch and refuses private canonical records, injected identity and arbitrary source paths', async () => {
  const f = await fixture(), method = vi.spyOn(f.app.documents.humanResearch, 'command')
  const request = f.command({ recordType: 'research-note', noteKind: 'hypothesis', body: 'Unverified hypothesis.' }, 'validation-original')
  expect((await f.get('/entries/note:unknown', {})).status).toBe(401)
  expect((await f.post(request, '', { ...f.authenticated, 'x-docatlas-csrf': 'x'.repeat(43) })).status).toBe(403)
  expect((await f.post(request, '', { ...f.authenticated, origin: 'https://foreign.invalid' })).status).toBe(403)
  for (const value of [{ ...request, actorId: 'actor:forged' }, { ...request, profileId: 'profile:forged' },
    { ...request, selections: [{ documentId: 'document:one', revisionId: 'revision:one', physicalPage: 1, quote: 'text', path: '/private/source.pdf' }] },
    { schemaVersion: 1, origin: 'human-command', createdBy: { kind: 'user', actorId: f.app.actor.actorId } }]) expect((await f.post(value)).status).toBe(400)
  expect((await f.get('/query')).status).toBe(404)
  expect((await f.get('/entries/note:unknown?path=not-allowed')).status).toBe(400)
  expect(method).not.toHaveBeenCalled()
  const original = await f.commit(request)
  expect((await f.post({ locator: { path: '/private/source.pdf' } }, `/entries/${original.receipt.recordId}/focus/locator:one`)).status).toBe(400)
  expect(f.model.getCallCount()).toBe(0)
}, 30000)

it('rejects revoked authentication after an await before any human domain effect is committed', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const service = f.app.documents.humanResearch, original = service.command.bind(service)
  vi.spyOn(service, 'command').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
  const request = f.command({ recordType: 'open-question', question: 'This must not be saved after logout.' }, 'logout-before-write')
  const pending = f.post(request)
  await entered.promise
  const logout = await fetch(`${f.app.origin}/api/auth/logout`, { method: 'POST', headers: f.authenticated, body: '{}' })
  expect(logout.status).toBe(204); release.resolve()
  const response = await pending
  expect(response.status).toBe(401)
  const operationId = `human-op:${enrichmentHash([f.app.actor.actorId, f.app.actor.workspaceId, f.binding.conversationId, request.idempotencyKey])}`
  expect(f.app.documents.store.getHumanResearchReceipt(f.app.actor.workspaceId, f.app.actor.actorId, f.binding.conversationId, operationId)).toBeUndefined()
  expect(f.model.getCallCount()).toBe(0)
}, 30000)

it('rejects mismatched same-owner output kinds, record/operation IDs and complete command hashes at the HTTP boundary', async () => {
  const f = await fixture(), request = f.command({ recordType: 'research-note', noteKind: 'commentary', body: 'An actual committed note.' }, 'output-check-original')
  const original = await f.commit(request), service = f.app.documents.humanResearch
  const detail = service.get(f.binding.conversationId, original.receipt.recordId)
  vi.spyOn(service, 'get').mockReturnValue(detail)
  expect((await f.get('/entries/note:a-different-target')).status).toBe(503)
  vi.spyOn(service, 'operation').mockReturnValue(original)
  expect((await f.get(`/operations/human-op:${'a'.repeat(64)}`)).status).toBe(503)
  const output = vi.spyOn(service, 'command').mockResolvedValue({ ...original, receipt: { ...original.receipt, requestHash: 'f'.repeat(64) } })
  expect((await f.post(request)).status).toBe(503)
  output.mockResolvedValue({ ...original, receipt: { ...original.receipt, recordVersion: 2 } })
  expect((await f.post(request)).status).toBe(503)
  output.mockResolvedValue({ ...original, receipt: { ...original.receipt, recordType: 'open-question' } })
  expect((await f.post(request)).status).toBe(503)
  const workspace = service.query(f.binding.conversationId, f.query)
  vi.spyOn(service, 'query').mockReturnValue({ ...workspace, binding: { ...f.binding, bindingId: 'binding:another' } })
  expect((await f.post(f.query, '/query')).status).toBe(503)
  expect(f.app.documents.store.getResearchNote(f.app.actor.workspaceId, original.receipt.recordId)?.version).toBe(1)
  expect(f.model.getCallCount()).toBe(0)
}, 30000)
