import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeProgress, ProductRunReceipt, ConversationObservation } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'
import { ConversationObservations, parseObservationId } from '../src/runs/observations.js'
import { ProductAuth } from '../src/http/auth.js'
import { streamObservations } from '../src/http/observations.js'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const actor = { actorId: 'actor:view', workspaceId: 'workspace:view' }, conversationId = 'conversation:view'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-observations-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = ControlStore.open(root); cleanup.push(() => store.close())
  store.createConversation(actor, { conversationId, runtimeSessionId: 'session:view' })
  let progress!: (submissionId: string, event: RuntimeProgress) => void, receipt!: (value: ProductRunReceipt) => void
  const hub = new ConversationObservations(store, actor, conversationId, { sessionId: 'session:view', publicHistory: () => ({ checkpoint: null, messages: [], hasEarlier: false }),
    observe(callback) { progress = callback; return () => {} } }, { subscribe(callback) { receipt = callback; return () => {} } })
  cleanup.push(() => hub.dispose())
  const lease = store.acquireWriter(actor, conversationId, 'worker:view')
  let sequence = 0
  const run = () => {
    const value = store.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: 1, idempotencyKey: `idempotency:view:${++sequence}`, mode: 'prompt', text: 'question', sourceRefs: [], selectionContextIds: [] }).receipt
    const preparing = store.transition(lease, value.submissionId, value.version, 'preparing')
    const ready = store.transition(lease, value.submissionId, preparing.version, 'ready', { prepared: { schemaVersion: 1, kind: 'prepared', submissionId: value.submissionId, requestHash: value.requestHash, bindingGeneration: 1, scopeVersionId: null, sourceRefs: [], selectionContextIds: [] } })
    const dispatching = store.transition(lease, value.submissionId, ready.version, 'dispatching')
    const running = store.transition(lease, value.submissionId, dispatching.version, 'running'); receipt(running)
    return running
  }
  return { store, hub, progress: (id: string, value: RuntimeProgress) => progress(id, value), receipt: (value: ProductRunReceipt) => receipt(value), lease, run }
}
it('replays a bounded window, resets stale epochs/gaps, and isolates failing consumers', () => {
  const { hub, progress, run } = fixture(), running = run(), initial = hub.snapshot(actor).cursor
  const failed = vi.fn()
  hub.subscribe(actor, initial, () => { throw new Error('broken browser') }, failed)
  progress(running.submissionId, { type: 'text', messageId: 'live:one', delta: 'one' })
  expect(failed).toHaveBeenCalledOnce()
  const replay: ConversationObservation[] = []
  const off = hub.subscribe(actor, initial, value => replay.push(value), () => {})
  expect(replay).toHaveLength(1)
  expect(replay[0]!.update.type).toBe('progress'); off()
  for (let i = 0; i < 300; i++) progress(running.submissionId, { type: 'text', messageId: 'live:one', delta: 'x'.repeat(8192) })
  const reset: ConversationObservation[] = []
  hub.subscribe(actor, initial, value => reset.push(value), () => {})()
  expect(reset[0]!.update).toEqual({ type: 'resync', reason: 'gap' })
  const snapshot = hub.snapshot(actor)
  expect(snapshot.live[0]!.text.length).toBeLessThanOrEqual(65536)
  expect(snapshot.liveIncomplete).toBe(true)
  expect(Reflect.get(hub, 'ringBytes')).toBeLessThanOrEqual(1024 * 1024)
  expect(Reflect.get(hub, 'ring').length).toBeLessThanOrEqual(256)
  hub.subscribe(actor, { streamId: '00000000-0000-4000-8000-000000000000', sequence: 0 }, value => reset.push(value), () => {})()
  expect(reset.at(-1)!.update).toMatchObject({ type: 'resync', reason: 'epoch' })
  for (const value of ['bad', `${initial.streamId}:-1`, `${initial.streamId}:9007199254740992`]) expect(() => parseObservationId(value)).toThrow()
})
it('keeps tools per submission and reads committed receipts, not forged callback data', () => {
  const { hub, run, progress, receipt, store, lease } = fixture(), first = run(), second = run()
  for (const item of [first, second]) progress(item.submissionId, { type: 'tool-start', toolCallId: 'same-id', toolName: 'read' })
  expect(hub.snapshot(actor).activity).toHaveLength(2)
  receipt({ ...first, state: 'completed', version: 999 })
  expect(hub.snapshot(actor).runs.find(run => run.receipt.submissionId === first.submissionId)!.receipt.state).toBe('running')
  const failed = store.transition(lease, first.submissionId, first.version, 'failed', { errorCode: 'runtime-failed' }); receipt(failed)
  progress(first.submissionId, { type: 'text', messageId: 'live:late', delta: 'must not appear' })
  expect(hub.snapshot(actor).live).toEqual([])
  expect(hub.snapshot(actor).activity.map(item => item.submissionId)).toEqual([second.submissionId])
  expect(() => hub.snapshot({ ...actor, workspaceId: 'workspace:other' })).toThrow('not-found')
})
it('bounds actual SSE response buffering and closes subscriptions on logout', () => {
  const { hub, run, progress } = fixture(), running = run(), auth = new ProductAuth('http://127.0.0.1:3000')
  const session = auth.exchange(auth.issueBootstrap(actor).code), cookie = session.cookie.split(';')[0]!
  const request = { headers: { cookie } } as IncomingMessage
  const response = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false, writableLength: 0,
    setHeader: vi.fn(), flushHeaders() { this.headersSent = true }, write: vi.fn(function(this: { headersSent: boolean }) { this.headersSent = true; return false }),
    end() { this.writableEnded = true }, destroy(this: EventEmitter & { destroyed: boolean }) { this.destroyed = true; this.emit('close') } })
  const released = vi.fn()
  streamObservations(request, response as unknown as ServerResponse, auth, hub, undefined, released)
  response.writableLength = 131072
  progress(running.submissionId, { type: 'text', messageId: 'live:buffer', delta: 'overflow' })
  expect(response.destroyed).toBe(true); expect(released).toHaveBeenCalledOnce()
  expect(Reflect.get(hub, 'listeners').size).toBe(0)
  const revoked = vi.fn(), off = auth.watch(cookie, revoked)
  auth.logout(cookie); expect(revoked).toHaveBeenCalledOnce(); off()
})
it('paginates recent receipts without crossing conversations and fences changed bindings', () => {
  const { store, hub, lease, run, receipt } = fixture()
  for (let i = 0; i < 34; i++) { const value = run(); receipt(store.transition(lease, value.submissionId, value.version, 'failed', { errorCode: 'runtime-failed' })) }
  const recent = hub.snapshot(actor)
  expect(recent.runs).toHaveLength(32); expect(recent.nextRunsCursor).not.toBeNull()
  expect(hub.snapshot(actor, recent.nextRunsCursor!).runs).toHaveLength(2)
  store.releaseWriter(lease)
  const binding = store.binding(actor, conversationId)
  store.rebind(actor, conversationId, binding.version, 'session:replacement', null)
  expect(() => hub.snapshot(actor)).toThrow('conflict')
})
