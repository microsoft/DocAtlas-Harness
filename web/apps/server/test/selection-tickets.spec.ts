import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { VerifiedSelectionItem, ProductSubmission } from '@docatlas/contracts'
import { SelectionTickets } from '../src/storage/selection-tickets.js'
import { ControlStore } from '../src/storage/control-store.js'
import { ProductSelections } from '../src/documents/selections.js'
import type { SourceScopeStore } from '@docatlas/core'
import { DatabaseSync } from 'node:sqlite'

const actor = { actorId: 'actor:selections', workspaceId: 'workspace:selections' }
const item = (text: string): VerifiedSelectionItem => ({ text, locator: { schemaVersion: 1, locatorId: `loc:${text}`, documentId: 'doc:one', revisionId: 'rev:one', representationId: 'rep:text', representationContentHash: 'a'.repeat(64), physicalPage: 1,
  selectors: [{ type: 'text-quote', exact: text, normalizedHash: createHash('sha256').update(text).digest('hex') }], createdAt: '2026-09-09T00:00:00.000Z' } })
it('keeps cancelled verification slots occupied until their cache-only readers actually join', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-selection-join-')), control = ControlStore.open(join(root, 'control')), tickets = new SelectionTickets(join(root, 'tickets'))
  const binding = control.createManagedConversation(actor, 'conversation:selection-join').binding, joined = Promise.withResolvers<void>()
  let readers = 0
  const store = { getEligibleLibrarySource: () => ({ documentId: 'doc:one', revisionId: 'rev:one', representationId: 'rep:text', representationContentHash: 'a'.repeat(64) }), get: () => ({}) } as unknown as SourceScopeStore
  const selections = new ProductSelections(tickets, store, () => binding, () => { readers++; return {
    close: () => joined.promise,
    call: (_method, _request, signal) => new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
  } })
  const request = { schemaVersion: 1 as const, kind: 'selection-stage' as const, expectedGeneration: 1, idempotencyKey: 'selection:join-test', proposals: [{ documentId: 'doc:one', revisionId: 'rev:one', physicalPage: 1, quote: 'first' }] }
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const tasks = controllers.map((controller, index) => selections.stage(binding.conversationId, { ...request, idempotencyKey: `${request.idempotencyKey}:${index}` }, () => {}, controller.signal).catch(() => {}))
  try {
    expect(readers).toBe(4); for (const controller of controllers) controller.abort()
    await expect(selections.stage(binding.conversationId, request, () => {}, new AbortController().signal)).rejects.toThrow('capacity')
    expect(readers).toBe(4); expect(tickets.existing(binding, request)).toBeUndefined()
  } finally { joined.resolve(); await Promise.all(tasks); await selections.close(); tickets.close(); control.close(); rmSync(root, { recursive: true, force: true }) }
})
it('persists an all-or-none one-shot group; recovery keeps its binding and never lets another submission reuse it', () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-selections-')), control = ControlStore.open(join(root, 'control'))
  let now = Date.now(), tickets = new SelectionTickets(join(root, 'tickets'), () => now)
  try {
    const binding = control.createManagedConversation(actor, 'conversation:selection-test').binding
    const stage = (key: string) => tickets.stage(binding, { schemaVersion: 1, kind: 'selection-stage', expectedGeneration: 1, idempotencyKey: `stage:selection-${key}`, proposals: [{ documentId: 'doc:one', revisionId: 'rev:one', physicalPage: 1, quote: key }] }, [item(key)])
    const first = stage('first'), second = stage('second')
    const request: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: 1, idempotencyKey: 'question:selection-one', mode: 'prompt', text: 'compare these quotes', sourceRefs: [{ documentId: 'doc:one', revisionId: 'rev:one' }], selectionContextIds: [first.selectionContextId, 'selection:missing'] }
    const invalid = control.accept(actor, request).receipt
    expect(() => tickets.bind(binding, request, invalid)).toThrow('accessible')
    expect(tickets.get(binding, first.selectionContextId).state).toBe('staged')
    const valid = { ...request, idempotencyKey: 'question:selection-valid', selectionContextIds: [first.selectionContextId, second.selectionContextId] }, receipt = control.accept(actor, valid).receipt
    expect(tickets.bind(binding, valid, receipt).map(value => value.state)).toEqual(['bound', 'bound'])
    tickets.close(); tickets = new SelectionTickets(join(root, 'tickets'), () => now)
    expect(tickets.bind(binding, valid, receipt).map(value => value.state)).toEqual(['bound', 'bound'])
    expect(() => tickets.cancel(binding, first.selectionContextId)).toThrow('belongs to a submission')
    const other = { ...valid, idempotencyKey: 'question:other-submission' }, otherReceipt = control.accept(actor, other).receipt
    expect(() => tickets.bind(binding, other, otherReceipt)).toThrow('another submission')
    tickets.consume(binding, valid, receipt); tickets.consume(binding, valid, receipt)
    expect(tickets.get(binding, second.selectionContextId).state).toBe('consumed')
    expect(() => tickets.bind(binding, valid, receipt)).toThrow('consumed')
    const expired = stage('expired')
    now += 15 * 60_000 + 1
    const fresh = stage('fresh'), expiredRequest = { ...valid, idempotencyKey: 'question:expired-ticket', selectionContextIds: [fresh.selectionContextId, expired.selectionContextId] }
    expect(() => tickets.bind(binding, expiredRequest, control.accept(actor, expiredRequest).receipt)).toThrow('expired')
    expect(tickets.get(binding, fresh.selectionContextId).state).toBe('staged')
    expect(() => tickets.get({ ...binding, ownerActorId: 'actor:foreign' }, first.selectionContextId)).toThrow('accessible')
    expect(() => tickets.get({ ...binding, bindingId: 'binding:new' }, first.selectionContextId)).toThrow('accessible')
    const tamper = new DatabaseSync(join(root, 'tickets', 'selection-tickets.sqlite3'))
    try { tamper.prepare('UPDATE tickets SET value_hash=? WHERE id=?').run('b'.repeat(64), first.selectionContextId) } finally { tamper.close() }
    expect(() => tickets.get(binding, first.selectionContextId)).toThrow('identity changed')
  } finally { tickets.close(); control.close(); rmSync(root, { recursive: true, force: true }) }
})
