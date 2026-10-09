import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeCompactFailureProof, NativeControlProof, ProductNativeCommand, ProductNativeOperation } from '@docatlas/contracts'
import { canonical, ControlStore } from '../src/storage/control-store.js'
import { NativeOperationStore } from '../src/storage/native-operation-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!() })
const actor = { actorId: 'actor:native-operation', workspaceId: 'workspace:native-operation' }, conversationId = 'conversation:native-operation'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture(open = true) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-operations-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let now = Date.parse('2026-09-10T00:00:00.000Z')
  const control = ControlStore.open(root, () => now); cleanup.push(() => control.close())
  const binding = control.createConversation(actor, { conversationId, runtimeSessionId: 'session:native-operation' }), lease = control.acquireWriter(actor, conversationId, 'worker:native-operation')
  const store = open ? NativeOperationStore.open(control, () => now) : undefined; if (store) cleanup.push(() => store.close())
  const command = (key = 'native:command:one'): ProductNativeCommand => ({ schemaVersion: 1, kind: 'native-command', conversationId, expectedBindingId: binding.bindingId,
    expectedGeneration: binding.generation, runtimeSessionId: binding.runtimeSessionId, approvalId: 'approval:native-operation', expectedApprovalVersion: 1,
    expectedHead: { version: 1, sessionId: binding.runtimeSessionId, transcriptHash: hash('original native prefix'), byteLength: 100, entryCount: 3, leafEntryId: 'entry:before' },
    idempotencyKey: key, action: { kind: 'set-thinking', level: 'high' } })
  const inspect = (fn: (db: DatabaseSync) => void) => { const database = new DatabaseSync(join(root, 'native-operations.sqlite3')); try { fn(database) } finally { database.close() } }
  return { root, control, binding, lease, store: store!, command, inspect, clock: () => now, advance: (ms: number) => { now += ms } }
}
/** A shape/identity-valid receipt supplied by the trusted host; actual native-prefix verification
 * is exercised separately by runtime-pi's verifier and is not invented by this storage fixture. */
function proof(operation: ProductNativeOperation): NativeControlProof {
  const intentEntryId = `intent:${operation.operationId}`, markerEntryId = `marker:${operation.operationId}`
  return { operationId: operation.operationId, requestHash: operation.requestHash, action: operation.request.action, beforeHead: operation.request.expectedHead,
    afterHead: { ...operation.request.expectedHead, transcriptHash: hash('new verified prefix'), byteLength: 400, entryCount: 6, leafEntryId: markerEntryId }, intentEntryId, markerEntryId,
    configuration: { model: { provider: 'openai', id: 'model:native' }, thinkingLevel: 'high', steeringMode: 'all', followUpMode: 'one-at-a-time' } }
}
function compactFailure(operation: ProductNativeOperation): NativeCompactFailureProof {
  if (operation.request.action.kind !== 'compact') throw new Error('Compact fixture required')
  const intentEntryId = `intent:${operation.operationId}`, markerEntryId = `marker:${operation.operationId}`
  return { operationId: operation.operationId, requestHash: operation.requestHash, action: operation.request.action, beforeHead: operation.request.expectedHead,
    afterHead: { ...operation.request.expectedHead, transcriptHash: hash('verified non-application prefix'), byteLength: 400,
      entryCount: operation.request.expectedHead.entryCount + 2, leafEntryId: markerEntryId }, intentEntryId, markerEntryId, reason: 'cancelled' }
}

describe('private native operation receipt store', () => {
  it.each(['applying', 'outcome-unknown'] as const)('settles %s compact with an exact immutable non-application proof and admits a new operation', state => {
    const f = fixture(), request = { ...f.command(), action: { kind: 'compact' as const, instructions: 'Retain evidence references' } }
    const accepted = f.store.accept(actor, f.lease, request).operation
    const pending = f.store.transition(actor, f.lease, accepted.operationId, 1, state, state === 'outcome-unknown' ? { errorCode: 'execution-interrupted' } : {})
    if (state === 'outcome-unknown') expect(() => f.store.transition(actor, f.lease, pending.operationId, 2, 'failed', { errorCode: 'execution-interrupted' })).toThrow()
    const failureProof = compactFailure(pending), detail = { errorCode: 'execution-interrupted' as const, failureProof }
    for (const bad of [
      { ...failureProof, requestHash: hash('wrong request') }, { ...failureProof, operationId: 'native:wrong' },
      { ...failureProof, action: { kind: 'compact' as const, instructions: 'different variable' } },
      { ...failureProof, beforeHead: { ...failureProof.beforeHead, transcriptHash: hash('replaced before') } },
      { ...failureProof, afterHead: { ...failureProof.afterHead, entryCount: failureProof.afterHead.entryCount + 1 } },
      { ...failureProof, markerEntryId: failureProof.intentEntryId },
    ]) expect(() => f.store.transition(actor, f.lease, pending.operationId, 2, 'failed', { ...detail, failureProof: bad })).toThrow()
    expect(f.store.get(actor, conversationId, pending.operationId)).toEqual(pending)
    const failed = f.store.transition(actor, f.lease, pending.operationId, 2, 'failed', detail)
    expect(failed).toMatchObject({ state: 'failed', result: null, failureProof, errorCode: 'execution-interrupted', version: 3 })
    expect(f.store.transition(actor, f.lease, pending.operationId, 2, 'failed', detail)).toEqual(failed)
    expect(() => f.store.transition(actor, f.lease, pending.operationId, 3, 'failed', { ...detail, failureProof: { ...failureProof, reason: 'sdk-rejected' } })).toThrow()
    expect(() => f.store.transition(actor, f.lease, pending.operationId, 3, 'succeeded', { result: proof(pending) })).toThrow()
    expect(f.store.pending(actor, conversationId)).toEqual([])
    f.store.close(); const reopened = NativeOperationStore.open(f.control, f.clock); cleanup.push(() => reopened.close())
    expect(reopened.accept(actor, f.lease, request)).toEqual({ operation: failed, replayed: true })
    expect(reopened.accept(actor, f.lease, f.command('native:after:proved-rejection')).operation.state).toBe('accepted')
  })

  it('requires successful compact metadata, never accepts it on a setter, and does not attach failure witnesses to success', () => {
    const f = fixture(), request = { ...f.command(), action: { kind: 'compact' as const, instructions: '' } }
    const accepted = f.store.accept(actor, f.lease, request).operation, applying = f.store.transition(actor, f.lease, accepted.operationId, 1, 'applying')
    const result = proof(applying), compaction = { entryId: 'entry:actual-compact', firstKeptEntryId: 'entry:before', tokensBefore: 41000, summaryHash: hash('actual summary') }
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result })).toThrow()
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result: { ...result, compaction }, failureProof: compactFailure(applying) })).toThrow()
    expect(f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result: { ...result, compaction } }).result?.compaction).toEqual(compaction)
    const next = f.store.accept(actor, f.lease, f.command('native:setter:metadata')).operation
    f.store.transition(actor, f.lease, next.operationId, 1, 'applying')
    expect(() => f.store.transition(actor, f.lease, next.operationId, 2, 'succeeded', { result: { ...proof(next), compaction } })).toThrow()
  })

  it('freezes and hashes the entire command, preserves ordinary ControlStore v1, and replays only the original key/body', () => {
    const f = fixture(), command = f.command(), original = structuredClone(command), accepted = f.store.accept(actor, f.lease, command)
    expect(accepted.replayed).toBe(false)
    expect(accepted.operation).toMatchObject({ requestHash: hash(canonical(original)), request: original, state: 'accepted', version: 1, result: null, errorCode: null })
    command.expectedApprovalVersion = 2; command.action = { kind: 'set-queue-mode', queue: 'follow-up', mode: 'all' }
    expect(f.store.byKey(actor, conversationId, original.idempotencyKey)).toEqual(accepted.operation)
    expect(f.store.accept(actor, f.lease, original)).toEqual({ operation: accepted.operation, replayed: true })
    expect(() => f.store.accept(actor, f.lease, command)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    for (const change of [{ approvalId: 'approval:other' }, { expectedApprovalVersion: 2 }, { expectedHead: { ...original.expectedHead, transcriptHash: hash('another prefix') } }]) {
      expect(() => f.store.accept(actor, f.lease, { ...original, ...change })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    }
    expect(() => f.store.accept(actor, f.lease, f.command('native:command:two'))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(JSON.stringify(accepted)).not.toContain(f.lease.token)
    f.inspect(db => { expect(db.prepare('PRAGMA synchronous').get()!.synchronous).toBe(2); expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(1) })
    expect(statSync(join(f.root, 'native-operations.sqlite3')).mode & 0o777).toBe(0o600)
    const control = new DatabaseSync(join(f.root, 'control.sqlite3'))
    try { expect(control.prepare('PRAGMA user_version').get()!.user_version).toBe(1); expect(control.prepare("SELECT name FROM sqlite_master WHERE name='native_operations'").get()).toBeUndefined() } finally { control.close() }
  })

  it('makes a successful proof immutable, permits exact original completion replay and retains it after reopen', () => {
    const f = fixture(), accepted = f.store.accept(actor, f.lease, f.command()).operation
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 1, 'succeeded', { result: proof(accepted) })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const applying = f.store.transition(actor, f.lease, accepted.operationId, 1, 'applying'), result = proof(applying)
    const succeeded = f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result })
    expect(succeeded).toMatchObject({ state: 'succeeded', version: 3, result, errorCode: null })
    expect(f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result })).toEqual(succeeded)
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 3, 'failed', { errorCode: 'execution-interrupted' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 3, 'succeeded', { result: { ...result, markerEntryId: 'marker:other' } })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.accept(actor, f.lease, f.command())).toEqual({ operation: succeeded, replayed: true })
    f.store.close()
    const reopened = NativeOperationStore.open(f.control, f.clock); cleanup.push(() => reopened.close())
    expect(reopened.get(actor, conversationId, accepted.operationId)).toEqual(succeeded)
    expect(reopened.pending(actor, conversationId)).toEqual([])
  })

  it('keeps unknown outcomes as a barrier until an exact verified success proof arrives, never clock-based recovery', () => {
    const f = fixture(), accepted = f.store.accept(actor, f.lease, f.command()).operation
    const unknown = f.store.transition(actor, f.lease, accepted.operationId, 1, 'outcome-unknown', { errorCode: 'execution-interrupted' })
    expect(unknown).toMatchObject({ state: 'outcome-unknown', result: null, errorCode: 'execution-interrupted' })
    for (const state of ['failed', 'applying'] as const) expect(() => f.store.transition(actor, f.lease, accepted.operationId, 2, state, { errorCode: 'stale-state' })).toThrow()
    expect(() => f.store.accept(actor, f.lease, f.command('native:next:blocked'))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    f.store.close(); const reopened = NativeOperationStore.open(f.control, f.clock); cleanup.push(() => reopened.close())
    expect(reopened.pending(actor, conversationId)).toEqual([unknown])
    expect(reopened.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result: proof(unknown) }).state).toBe('succeeded')
  })

  it('does not automatically change accepted/applying rows on reopen or expire their barrier with the writer lease', () => {
    const f = fixture(), accepted = f.store.accept(actor, f.lease, f.command()).operation
    f.store.close(); const reopened = NativeOperationStore.open(f.control, f.clock); cleanup.push(() => reopened.close())
    expect(reopened.pending(actor, conversationId)).toEqual([accepted])
    const applying = reopened.transition(actor, f.lease, accepted.operationId, 1, 'applying')
    reopened.close(); const again = NativeOperationStore.open(f.control, f.clock); cleanup.push(() => again.close())
    f.advance(30001)
    expect(again.pending(actor, conversationId)).toEqual([applying])
    expect(() => again.transition(actor, f.lease, accepted.operationId, 2, 'failed', { errorCode: 'execution-interrupted' })).toThrowError(expect.objectContaining({ code: 'stale-writer' }))
    expect(() => f.control.acquireWriter(actor, conversationId, 'worker:new')).toThrowError(expect.objectContaining({ code: 'recovery-required' }))
  })

  it('preserves old-generation receipts and blocks new commands rather than silently bypassing unknown effects', () => {
    const f = fixture(), accepted = f.store.accept(actor, f.lease, f.command()).operation
    const unknown = f.store.transition(actor, f.lease, accepted.operationId, 1, 'outcome-unknown', { errorCode: 'execution-interrupted' })
    f.control.releaseWriter(f.lease)
    const binding = f.control.rebind(actor, conversationId, f.binding.version, 'session:new', null), lease = f.control.acquireWriter(actor, conversationId, 'worker:new')
    const command = { ...f.command('native:new:binding'), expectedBindingId: binding.bindingId, expectedGeneration: binding.generation, runtimeSessionId: binding.runtimeSessionId,
      expectedHead: { ...f.command().expectedHead, sessionId: binding.runtimeSessionId } }
    expect(f.store.pending(actor, conversationId)).toEqual([unknown])
    expect(f.store.list(actor, conversationId).operations).toEqual([unknown])
    expect(() => f.store.accept(actor, lease, command)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.transition(actor, lease, accepted.operationId, 2, 'succeeded', { result: proof(unknown) })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.byKey(actor, conversationId, f.command().idempotencyKey)).toEqual(unknown)
  })

  it('checks owner, workspace, current binding and real writer capability independently of browser fields', () => {
    const f = fixture(), command = f.command()
    for (const denied of [{ ...actor, actorId: 'actor:other' }, { ...actor, workspaceId: 'workspace:other' }]) {
      expect(() => f.store.accept(denied, f.lease, command)).toThrowError(expect.objectContaining({ code: 'not-found' }))
      expect(() => f.store.list(denied, conversationId)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    }
    expect(() => f.store.accept(actor, { ...f.lease, token: 'forged' }, command)).toThrowError(expect.objectContaining({ code: 'stale-writer' }))
    for (const change of [{ expectedGeneration: 2 }, { expectedBindingId: 'binding:other' }, { runtimeSessionId: 'session:other', expectedHead: { ...command.expectedHead, sessionId: 'session:other' } }]) {
      expect(() => f.store.accept(actor, f.lease, { ...command, ...change })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    }
    expect(() => f.store.accept(actor, f.lease, { ...command, actorId: 'actor:forged' } as ProductNativeCommand)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(f.store.pending(actor, conversationId)).toEqual([])
  })

  it.each(['accept', 'transition'] as const)('rechecks writer under the native-store transaction and rolls back %s after revocation', phase => {
    const f = fixture(), accepted = phase === 'transition' ? f.store.accept(actor, f.lease, f.command()).operation : undefined
    const original = f.control.verifyWriter.bind(f.control); let checks = 0
    vi.spyOn(f.control, 'verifyWriter').mockImplementation(lease => {
      f.inspect(db => { db.exec('PRAGMA busy_timeout=0'); expect(() => db.prepare('UPDATE native_operations SET version=version').run()).toThrow(/locked/u) })
      if (++checks === 2) f.control.releaseWriter(lease)
      original(lease)
    })
    expect(() => phase === 'accept' ? f.store.accept(actor, f.lease, f.command()) : f.store.transition(actor, f.lease, accepted!.operationId, 1, 'applying'))
      .toThrowError(expect.objectContaining({ code: 'stale-writer' }))
    expect(checks).toBe(2)
    expect(f.store.pending(actor, conversationId)).toEqual(accepted ? [accepted] : [])
  })

  it('atomically retains applying when a successful receipt SQL write faults', () => {
    const f = fixture(), accepted = f.store.accept(actor, f.lease, f.command()).operation, applying = f.store.transition(actor, f.lease, accepted.operationId, 1, 'applying')
    f.inspect(db => db.exec("CREATE TRIGGER operation_fault BEFORE UPDATE ON native_operations WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'injected completion fault'); END"))
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result: proof(applying) })).toThrow('injected completion fault')
    expect(f.store.get(actor, conversationId, accepted.operationId)).toEqual(applying)
    f.inspect(db => db.exec('DROP TRIGGER operation_fault'))
    expect(f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result: proof(applying) }).state).toBe('succeeded')
  })

  it.each(['state', 'actor_id', 'workspace_id', 'request_hash', 'operation_hash', 'request_json', 'idempotency_key'] as const)('does not let corrupted %s hide an unsettled operation from admission', column => {
    const f = fixture(); f.store.accept(actor, f.lease, f.command())
    f.inspect(db => db.prepare(`UPDATE native_operations SET ${column}=?`).run(column === 'state' ? 'failed' : 'forged'))
    expect(() => f.store.pending(actor, conversationId)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    expect(() => f.store.accept(actor, f.lease, f.command('native:next:blocked'))).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it('rejects stale CAS, missing state-specific detail and a proof for another request or prefix', () => {
    const f = fixture(), accepted = f.store.accept(actor, f.lease, f.command()).operation
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 1, 'failed')).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 1, 'applying', { errorCode: 'execution-interrupted' })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const applying = f.store.transition(actor, f.lease, accepted.operationId, 1, 'applying'), original = proof(applying)
    expect(() => f.store.transition(actor, f.lease, accepted.operationId, 1, 'failed', { errorCode: 'stale-state' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    for (const change of [{ requestHash: hash('wrong request') }, { beforeHead: { ...original.beforeHead, transcriptHash: hash('wrong prefix') } },
      { afterHead: { ...original.afterHead, byteLength: original.beforeHead.byteLength } }, { markerEntryId: 'marker:wrong' }]) {
      expect(() => f.store.transition(actor, f.lease, accepted.operationId, 2, 'succeeded', { result: { ...original, ...change } })).toThrow()
      expect(f.store.get(actor, conversationId, accepted.operationId)).toEqual(applying)
    }
  })

  it('lists original receipts by insertion order with explicit truncation and cross-connection key serialization', () => {
    const f = fixture(), operations: ProductNativeOperation[] = []
    const other = NativeOperationStore.open(f.control, f.clock); cleanup.push(() => other.close())
    for (const key of ['native:command:key:z', 'native:command:key:a', 'native:command:key:m']) {
      const request = f.command(key), accepted = f.store.accept(actor, f.lease, request).operation
      expect(other.accept(actor, f.lease, request)).toEqual({ operation: accepted, replayed: true })
      operations.push(other.transition(actor, f.lease, accepted.operationId, 1, 'failed', { errorCode: 'invalid-action' }))
    }
    expect(f.store.list(actor, conversationId, 2)).toEqual({ operations: [operations[2], operations[1]], truncated: true })
    expect(f.store.list(actor, conversationId)).toEqual({ operations: [...operations].reverse(), truncated: false })
    for (const limit of [0, 101, 1.5]) expect(() => f.store.list(actor, conversationId, limit)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
  })

  it('refuses unknown schemas and dangling symlinks instead of creating a store outside its private root', () => {
    const f = fixture(false), file = join(f.root, 'native-operations.sqlite3'), database = new DatabaseSync(file)
    database.exec('PRAGMA application_id=1; PRAGMA user_version=1'); database.close()
    expect(() => NativeOperationStore.open(f.control)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    unlinkSync(file)
    const target = join(f.root, 'must-not-create.sqlite3'); symlinkSync(target, file)
    expect(() => NativeOperationStore.open(f.control)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    expect(existsSync(target)).toBe(false)
  })
})
