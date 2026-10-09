import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProductBinding, ProductPiCheckpoint, ProductSubmission } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const actor = { actorId: 'actor:binding-handoff', workspaceId: 'workspace:binding-handoff' }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-binding-handoff-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const open = () => { const store = ControlStore.open(root); cleanup.push(() => store.close()); return store }
  const store = open(), source = store.createConversation(actor, { conversationId: 'conversation:handoff-parent', runtimeSessionId: 'native:handoff-parent', investigationId: 'investigation:original' })
  const target = (kind: 'navigate' | 'fork'): ProductBinding => ({ ...source, bindingId: `binding:planned-${kind}`, branchEntryId: 'entry:selected',
    ...(kind === 'navigate' ? { generation: source.generation + 1, version: source.version + 1 }
      : { conversationId: 'conversation:handoff-child', runtimeSessionId: 'native:sdk-generated-child', generation: 1, version: 1 }) })
  const inspect = (run: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(root, 'control.sqlite3')); try { run(db) } finally { db.close() } }
  const request: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: source.conversationId, expectedGeneration: source.generation,
    idempotencyKey: 'question:before-handoff', mode: 'prompt', text: 'Original human wording', sourceRefs: [], selectionContextIds: [] }
  const running = () => {
    const lease = store.acquireWriter(actor, source.conversationId, 'writer:handoff-test'), accepted = store.accept(actor, request).receipt
    let receipt = store.transition(lease, accepted.submissionId, accepted.version, 'preparing')
    receipt = store.transition(lease, receipt.submissionId, receipt.version, 'ready', { prepared: { schemaVersion: 1, kind: 'prepared',
      submissionId: receipt.submissionId, requestHash: receipt.requestHash, bindingGeneration: source.generation, scopeVersionId: null, sourceRefs: [], selectionContextIds: [] } })
    receipt = store.transition(lease, receipt.submissionId, receipt.version, 'dispatching')
    receipt = store.transition(lease, receipt.submissionId, receipt.version, 'running')
    return { lease, receipt }
  }
  return { root, open, store, source, target, request, inspect, running }
}

describe('exact product binding commit after independently proved native handoff', () => {
  it('commits the preplanned navigation once, retains original receipts/checkpoints/input, and gives the next writer a fresh generation', () => {
    const f = fixture(), next = f.target('navigate'), { lease, receipt } = f.running()
    const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
      runtimeSessionId: f.source.runtimeSessionId, userEntryId: 'entry:original-user', leafEntryId: 'entry:original-answer', transcriptHash: 'a'.repeat(64),
      byteLength: 300, entryCount: 4, settledAt: receipt.updatedAt }
    const completed = f.store.transition(lease, receipt.submissionId, receipt.version, 'completed', { checkpoint })
    f.store.releaseWriter(lease)
    expect(f.store.commitNativeHandoff(actor, f.source, next)).toEqual(next)
    const reopened = f.open()
    expect(reopened.commitNativeHandoff(actor, f.source, next)).toEqual(next)
    expect(reopened.get(actor, receipt.submissionId)).toEqual(completed)
    expect(reopened.recoveryInput(actor, receipt.submissionId)).toEqual(f.request)
    expect(reopened.list(actor, f.source.conversationId).items).toEqual([completed])
    expect(reopened.latestCheckpoint(actor, f.source.conversationId)).toBeUndefined() // No forged checkpoint for the new generation.
    const fresh = reopened.acquireWriter(actor, f.source.conversationId, 'writer:after-navigation')
    expect(fresh.generation).toBe(next.generation); expect(fresh.epoch).toBeGreaterThan(lease.epoch)
    expect(() => reopened.heartbeat(lease)).toThrow()
    reopened.releaseWriter(fresh)
    f.inspect(db => { expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(1); expect(db.prepare('SELECT COUNT(*) AS n FROM checkpoint_bindings').get()!.n).toBe(1) })
  })

  it('creates the exact fork child without rebinding its parent or copying any submission, prepared scope or checkpoint', () => {
    const f = fixture(), target = f.target('fork'), original = structuredClone(target)
    expect(f.store.commitNativeHandoff(actor, f.source, target)).toEqual(original)
    target.branchEntryId = 'entry:mutated-after-call'
    const second = f.open()
    expect(second.binding(actor, f.source.conversationId)).toEqual(f.source)
    expect(second.binding(actor, original.conversationId)).toEqual(original)
    expect(second.commitNativeHandoff(actor, f.source, original)).toEqual(original)
    expect(second.list(actor, original.conversationId).items).toEqual([])
    expect(second.latestCheckpoint(actor, original.conversationId)).toBeUndefined()
    expect(second.writerInfo(actor, original.conversationId)).toBeNull()
    expect(() => second.commitNativeHandoff(actor, f.source, target)).toThrow()
    expect(() => second.commitNativeHandoff(actor, f.source, { ...original, runtimeSessionId: 'native:replacement-child' })).toThrow()
  })

  it.each(['writer', 'queued', 'unknown'] as const)('rejects navigation and fork with an unresolved source %s, without creating the child or clearing authority', state => {
    const f = fixture()
    if (state === 'writer') f.store.acquireWriter(actor, f.source.conversationId, 'writer:still-owned')
    if (state === 'queued') f.store.accept(actor, f.request)
    if (state === 'unknown') {
      const { lease, receipt } = f.running()
      f.store.transition(lease, receipt.submissionId, receipt.version, 'outcome-unknown', { errorCode: 'execution-interrupted' })
      f.store.releaseWriter(lease)
    }
    for (const kind of ['navigate', 'fork'] as const) expect(() => f.store.commitNativeHandoff(actor, f.source, f.target(kind))).toThrow()
    expect(f.store.binding(actor, f.source.conversationId)).toEqual(f.source)
    expect(() => f.store.binding(actor, f.target('fork').conversationId)).toThrow()
    if (state === 'writer') expect(f.store.writerInfo(actor, f.source.conversationId)?.workerId).toBe('writer:still-owned')
    if (state === 'unknown') expect(f.store.pending(actor, f.source.conversationId)[0]?.state).toBe('outcome-unknown')
  })

  it('rejects forged owners, old binding plans, wrong native identities/generations, and another actor’s fork destination', () => {
    const f = fixture(), next = f.target('navigate'), child = f.target('fork')
    for (const target of [
      { ...next, ownerActorId: 'actor:foreign' }, { ...next, workspaceId: 'workspace:foreign' },
      { ...next, runtimeSessionId: 'native:not-same-session' }, { ...next, generation: 4 }, { ...next, version: 9 },
      { ...next, bindingId: f.source.bindingId }, { ...next, investigationId: null },
      { ...child, runtimeSessionId: f.source.runtimeSessionId }, { ...child, generation: 2 },
    ]) expect(() => f.store.commitNativeHandoff(actor, f.source, target)).toThrow()
    expect(() => f.store.commitNativeHandoff(actor, { ...f.source, branchEntryId: 'entry:not-current' }, next)).toThrow()
    f.store.createConversation({ ...actor, actorId: 'actor:foreign' }, { conversationId: child.conversationId, runtimeSessionId: 'native:foreign' })
    expect(() => f.store.commitNativeHandoff(actor, f.source, child)).toThrow()
    expect(f.store.binding(actor, f.source.conversationId)).toEqual(f.source)
  })

  it.each(['navigate', 'fork'] as const)('rolls back an injected %s binding write failure and retries only the exact preplanned identity', kind => {
    const f = fixture(), target = f.target(kind)
    f.inspect(db => db.exec(`CREATE TRIGGER injected_handoff_fault BEFORE ${kind === 'navigate' ? 'UPDATE' : 'INSERT'} ON bindings BEGIN SELECT RAISE(ABORT,'injected handoff write failure'); END`))
    expect(() => f.store.commitNativeHandoff(actor, f.source, target)).toThrow('injected handoff write failure')
    expect(f.store.binding(actor, f.source.conversationId)).toEqual(f.source)
    if (kind === 'fork') expect(() => f.store.binding(actor, target.conversationId)).toThrow()
    f.inspect(db => db.exec('DROP TRIGGER injected_handoff_fault'))
    expect(f.open().commitNativeHandoff(actor, f.source, target)).toEqual(target)
  })
})
