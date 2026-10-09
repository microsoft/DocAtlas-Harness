import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProductPiCheckpoint, ProductPreparedSubmission, ProductRunReceipt, ProductSubmission } from '@docatlas/contracts'
import { ControlStore, ControlStoreError, type WriterLease } from '../src/index.js'

const roots: string[] = [], stores: ControlStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const actor = { actorId: 'user:one', workspaceId: 'workspace:one' }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-control-')); roots.push(root)
  let time = Date.parse('2026-09-08T12:00:00Z')
  const open = () => { const store = ControlStore.open(root, () => time); stores.push(store); return store }
  const store = open()
  store.createConversation(actor, { conversationId: 'conversation:one', runtimeSessionId: 'pi:one' })
  return { root, store, open, advance: (ms: number) => { time += ms } }
}
function request(key = 'idempotency:request:one'): ProductSubmission {
  return { schemaVersion: 1, kind: 'submission', conversationId: 'conversation:one', expectedGeneration: 1, mode: 'prompt',
    idempotencyKey: key, text: 'Keep this question safely.', sourceRefs: [], selectionContextIds: [] }
}
function prepare(store: ControlStore, lease: WriterLease, receipt: ProductRunReceipt, input = request()): ProductRunReceipt {
  const preparing = store.transition(lease, receipt.submissionId, receipt.version, 'preparing')
  const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId,
    requestHash: receipt.requestHash, bindingGeneration: 1, scopeVersionId: input.sourceRefs.length || input.selectionContextIds.length ? 'scope:one' : null,
    sourceRefs: input.sourceRefs, selectionContextIds: input.selectionContextIds }
  return store.transition(lease, receipt.submissionId, preparing.version, 'ready', { prepared })
}
function proof(receipt: ProductRunReceipt): ProductPiCheckpoint {
  return { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
    runtimeSessionId: 'pi:one', userEntryId: 'entry:one', leafEntryId: 'entry:two', transcriptHash: 'b'.repeat(64),
    byteLength: 1024, entryCount: 4, settledAt: receipt.updatedAt }
}
function running(store: ControlStore, lease: WriterLease, receipt: ProductRunReceipt): ProductRunReceipt {
  const ready = prepare(store, lease, receipt)
  const dispatch = store.transition(lease, receipt.submissionId, ready.version, 'dispatching')
  return store.transition(lease, receipt.submissionId, dispatch.version, 'running')
}
const code = (value: ControlStoreError['code']) => expect.objectContaining({ code: value })

describe('durable product submission control', () => {
  it('persists the complete first question before execution and replays only the same payload', () => {
    const { root, store, open } = setup()
    const input = request()
    const accepted = store.accept(actor, input)
    expect(accepted.replayed).toBe(false)
    expect(accepted.receipt.state).toBe('accepted')
    store.close()
    const restored = open()
    expect(restored.recoveryInput(actor, accepted.receipt.submissionId)).toEqual(input)
    expect(restored.accept(actor, { ...input })).toEqual({ receipt: accepted.receipt, replayed: true })
    expect(() => restored.accept(actor, { ...input, text: 'different question' })).toThrowError(code('conflict'))
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'control.sqlite3')).mode & 0o777).toBe(0o600)
  })

  it('authenticates every read/list/replay and never accepts a submitted actor', () => {
    const { store } = setup(), accepted = store.accept(actor, request()).receipt
    const other = { ...actor, actorId: 'user:other' }, cross = { ...actor, workspaceId: 'workspace:other' }
    for (const unauthorized of [other, cross]) {
      expect(() => store.get(unauthorized, accepted.submissionId)).toThrowError(code('not-found'))
      expect(() => store.recoveryInput(unauthorized, accepted.submissionId)).toThrowError(code('not-found'))
      expect(() => store.list(unauthorized, 'conversation:one')).toThrowError(code('not-found'))
      expect(() => store.accept(unauthorized, request())).toThrowError(code('not-found'))
    }
    expect(() => store.accept(actor, { ...request(), actorId: 'user:admin' })).toThrowError(code('invalid-request'))
    expect(() => store.accept(actor, { ...request(), text: '   ' })).toThrowError(code('invalid-request'))
    expect(store.list(actor, 'conversation:one').items).toHaveLength(1)
  })

  it('enforces a single writer across database connections, capability hash, expiry and explicit recovery', () => {
    const { root, store, open, advance } = setup(), second = open()
    const lease = store.acquireWriter(actor, 'conversation:one', 'worker:one', 100)
    expect(() => second.acquireWriter(actor, 'conversation:one', 'worker:two')).toThrowError(code('conflict'))
    expect(() => store.heartbeat({ ...lease, token: 'wrong' })).toThrowError(code('stale-writer'))
    const db = new DatabaseSync(join(root, 'control.sqlite3'), { readOnly: true })
    expect(JSON.stringify(db.prepare('SELECT * FROM writers').all())).not.toContain(lease.token)
    db.close()
    advance(101)
    expect(() => second.acquireWriter(actor, 'conversation:one', 'worker:two')).toThrowError(code('recovery-required'))
    expect(() => store.heartbeat(lease)).toThrowError(code('stale-writer'))
    // In production, only the lifecycle manager calls this after confirming worker termination.
    second.recoverAfterExecutionStopped(actor, 'conversation:one', lease.epoch)
    const next = second.acquireWriter(actor, 'conversation:one', 'worker:two')
    expect(next.epoch).toBeGreaterThan(lease.epoch)
    expect(() => store.heartbeat(lease)).toThrowError(code('stale-writer'))
  })

  it('admits all sources/selections together and does not dispatch before ready', () => {
    const { store } = setup(), lease = store.acquireWriter(actor, 'conversation:one', 'worker:one')
    const input = { ...request(), sourceRefs: [{ documentId: 'doc:a', revisionId: 'rev:a' }], selectionContextIds: ['selection:a', 'selection:b'] }
    const accepted = store.accept(actor, input).receipt
    expect(() => store.transition(lease, accepted.submissionId, accepted.version, 'dispatching')).toThrowError(code('invalid-request'))
    const preparing = store.transition(lease, accepted.submissionId, accepted.version, 'preparing')
    const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: accepted.submissionId, requestHash: accepted.requestHash,
      bindingGeneration: 1, scopeVersionId: 'scope:a', sourceRefs: input.sourceRefs, selectionContextIds: ['selection:a'] }
    expect(() => store.transition(lease, accepted.submissionId, preparing.version, 'ready', { prepared })).toThrowError(code('conflict'))
    expect(store.get(actor, accepted.submissionId).state).toBe('preparing')
    const ready = store.transition(lease, accepted.submissionId, preparing.version, 'ready', { prepared: { ...prepared, selectionContextIds: input.selectionContextIds } })
    store.transition(lease, accepted.submissionId, ready.version, 'dispatching')
    expect(store.executionInput(lease, accepted.submissionId).request).toEqual(input)
  })

  it('refuses blind replay after possible execution and keeps unknown input recoverable', () => {
    const { store, open } = setup(), receipt = store.accept(actor, request()).receipt
    const lease = store.acquireWriter(actor, 'conversation:one', 'worker:one')
    const run = running(store, lease, receipt)
    expect(() => store.releaseWriter(lease)).toThrowError(code('conflict'))
    store.close()
    const restored = open()
    restored.recoverAfterExecutionStopped(actor, 'conversation:one', lease.epoch)
    const unknown = restored.get(actor, run.submissionId)
    expect(unknown.state).toBe('outcome-unknown')
    expect(unknown.errorCode).toBe('execution-interrupted')
    expect(restored.recoveryInput(actor, unknown.submissionId)).toEqual(request())
    const nextLease = restored.acquireWriter(actor, 'conversation:one', 'worker:two')
    expect(() => restored.transition(nextLease, unknown.submissionId, unknown.version, 'ready')).toThrowError(code('invalid-request'))
    const next = restored.accept(actor, request('idempotency:next:one')).receipt
    const ready = prepare(restored, nextLease, next, request('idempotency:next:one'))
    expect(() => restored.transition(nextLease, next.submissionId, ready.version, 'dispatching')).toThrowError(code('recovery-required'))
    expect(() => restored.requestCancel(actor, unknown.submissionId, unknown.version)).toThrowError(code('recovery-required'))
  })

  it('distinguishes cancellation request from stopped and fences late callbacks with CAS', () => {
    const { store } = setup(), lease = store.acquireWriter(actor, 'conversation:one', 'worker:one')
    const accepted = store.accept(actor, request()).receipt
    const run = running(store, lease, accepted)
    const cancelling = store.requestCancel(actor, run.submissionId, run.version)
    expect(cancelling.state).toBe('cancelling')
    expect(() => store.transition(lease, run.submissionId, run.version, 'completed', { checkpoint: proof(run) })).toThrowError(code('conflict'))
    const cancelled = store.transition(lease, run.submissionId, cancelling.version, 'cancelled')
    expect(cancelled.state).toBe('cancelled')
    expect(() => store.transition(lease, run.submissionId, cancelled.version, 'dispatching')).toThrowError(code('invalid-request'))
    store.releaseWriter(lease)
  })

  it('allows success racing with cancel only with a correctly bound checkpoint', () => {
    const { store } = setup(), lease = store.acquireWriter(actor, 'conversation:one', 'worker:one')
    const run = running(store, lease, store.accept(actor, request()).receipt)
    const cancelling = store.requestCancel(actor, run.submissionId, run.version)
    expect(() => store.transition(lease, run.submissionId, cancelling.version, 'completed')).toThrowError(code('invalid-request'))
    expect(() => store.transition(lease, run.submissionId, cancelling.version, 'completed', { checkpoint: { ...proof(run), runtimeSessionId: 'pi:other' } })).toThrowError(code('conflict'))
    const completed = store.transition(lease, run.submissionId, cancelling.version, 'completed', { checkpoint: proof(run) })
    expect(completed.state).toBe('completed')
    expect(store.recoveryInput(actor, run.submissionId)).not.toBeNull()
    const purged = store.purgeRecoveryPayload(actor, run.submissionId)
    expect(purged.payloadRetained).toBe(false)
    expect(store.recoveryInput(actor, run.submissionId)).toBeNull()
    expect(store.accept(actor, request())).toEqual({ receipt: purged, replayed: true })
  })

  it('keeps pre-dispatch work recoverable and rejects stale binding generations', () => {
    const { store } = setup(), lease = store.acquireWriter(actor, 'conversation:one', 'worker:one')
    const accepted = store.accept(actor, request()).receipt
    prepare(store, lease, accepted)
    store.recoverAfterExecutionStopped(actor, 'conversation:one', lease.epoch)
    const recovered = store.get(actor, accepted.submissionId)
    expect(recovered.state).toBe('preparing')
    expect(() => store.rebind(actor, 'conversation:one', 1, 'pi:two', null)).toThrowError(code('conflict'))
    store.requestCancel(actor, accepted.submissionId, recovered.version)
    const rebound = store.rebind(actor, 'conversation:one', 1, 'pi:two', null)
    expect(rebound.generation).toBe(2)
    expect(() => store.accept(actor, request('idempotency:stale:request'))).toThrowError(code('conflict'))
    expect(store.accept(actor, request()).replayed).toBe(true) // Receipt lookup is not a new execution.
    expect(() => store.heartbeat(lease)).toThrowError(code('stale-writer'))
  })

  it('does not reuse a prior native user entry as proof of a new submission', () => {
    const { store } = setup(), lease = store.acquireWriter(actor, 'conversation:one', 'worker:one')
    const first = running(store, lease, store.accept(actor, request()).receipt)
    store.transition(lease, first.submissionId, first.version, 'completed', { checkpoint: proof(first) })
    const second = running(store, lease, store.accept(actor, request('idempotency:second:question')).receipt)
    expect(() => store.transition(lease, second.submissionId, second.version, 'completed', { checkpoint: proof(second) })).toThrowError(code('conflict'))
    expect(store.get(actor, second.submissionId).state).toBe('running')
    const completed = store.transition(lease, second.submissionId, second.version, 'completed', { checkpoint: { ...proof(second), userEntryId: 'entry:next' } })
    expect(completed.state).toBe('completed')
  })

  it('rejects tampered persisted input before dispatch and leaves the state unchanged', () => {
    const { root, store } = setup(), lease = store.acquireWriter(actor, 'conversation:one', 'worker:one')
    const accepted = store.accept(actor, request()).receipt
    const ready = prepare(store, lease, accepted)
    const db = new DatabaseSync(join(root, 'control.sqlite3'))
    db.prepare('UPDATE submissions SET payload=?').run(JSON.stringify({ ...request(), text: 'forged' })); db.close()
    expect(() => store.recoveryInput(actor, accepted.submissionId)).toThrowError(code('integrity-error'))
    expect(() => store.transition(lease, accepted.submissionId, ready.version, 'dispatching')).toThrowError(code('integrity-error'))
    expect(store.get(actor, accepted.submissionId).state).toBe('ready')
  })

  it('bounds pending work and paginates without crossing conversation scope', () => {
    const { store } = setup()
    for (let n = 0; n < 32; n++) store.accept(actor, request(`idempotency:request:${n}`))
    expect(() => store.accept(actor, request('idempotency:overflow:request'))).toThrowError(code('limit-exceeded'))
    const first = store.list(actor, 'conversation:one', 10)
    const second = store.list(actor, 'conversation:one', 10, first.nextCursor)
    expect(first.items).toHaveLength(10); expect(second.items).toHaveLength(10)
    expect(new Set([...first.items, ...second.items].map(item => item.submissionId)).size).toBe(20)
    store.createConversation(actor, { conversationId: 'conversation:two', runtimeSessionId: 'pi:two' })
    expect(() => store.list(actor, 'conversation:two', 10, first.nextCursor)).toThrowError(code('invalid-request'))
    expect(() => store.purgeRecoveryPayload(actor, first.items[0]!.submissionId)).toThrowError(code('conflict'))
  })

  it('rejects unknown database versions and symlink roots without overwriting existing data', () => {
    const { root, store } = setup()
    store.close()
    const file = join(root, 'control.sqlite3'), db = new DatabaseSync(file)
    db.exec('PRAGMA user_version=99'); db.close()
    const before = readFileSync(file)
    expect(() => ControlStore.open(root)).toThrowError(code('integrity-error'))
    expect(readFileSync(file)).toEqual(before)
    const container = mkdtempSync(join(tmpdir(), 'docatlas-symlink-')); roots.push(container)
    mkdirSync(join(container, 'real'))
    symlinkSync(join(container, 'real'), join(container, 'alias'))
    expect(() => ControlStore.open(join(container, 'alias'))).toThrowError(code('invalid-request'))
  })
})
