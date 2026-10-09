import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlStore } from '../src/storage/control-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!() })
const actor = { actorId: 'actor:public-user', workspaceId: 'workspace:public-user' }, conversationId = 'conversation:public-user', sessionId = 'session:public-user'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-public-user-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = ControlStore.open(root); cleanup.push(() => store.close())
  const binding = store.createConversation(actor, { conversationId, runtimeSessionId: sessionId }), lease = store.acquireWriter(actor, conversationId, 'worker:public-user')
  const completed = (key: string, text: string) => {
    const accepted = store.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: binding.generation, idempotencyKey: `question:public-user:${key}`, mode: 'prompt', text, sourceRefs: [], selectionContextIds: [] }).receipt
    const preparing = store.transition(lease, accepted.submissionId, accepted.version, 'preparing')
    const ready = store.transition(lease, accepted.submissionId, preparing.version, 'ready', { prepared: { schemaVersion: 1, kind: 'prepared', submissionId: accepted.submissionId, requestHash: accepted.requestHash,
      bindingGeneration: binding.generation, scopeVersionId: null, sourceRefs: [], selectionContextIds: [] } })
    const dispatching = store.transition(lease, accepted.submissionId, ready.version, 'dispatching'), running = store.transition(lease, accepted.submissionId, dispatching.version, 'running')
    return store.transition(lease, accepted.submissionId, running.version, 'completed', { checkpoint: { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: accepted.submissionId, requestHash: accepted.requestHash,
      runtimeSessionId: sessionId, userEntryId: `user:${key}`, leafEntryId: `answer:${key}`, transcriptHash: hash(key), byteLength: 100, entryCount: 2, settledAt: new Date().toISOString() } })
  }
  const inspect = (fn: (database: DatabaseSync) => void) => { const database = new DatabaseSync(join(root, 'control.sqlite3')); try { fn(database) } finally { database.close() } }
  return { root, store, binding, lease, completed, inspect }
}

describe('exact original user display lookup (native prefix verification remains the caller responsibility)', () => {
  it('returns only the exact retained original text, read-only across purge and reopen', () => {
    const f = fixture(), first = f.completed('first', 'Original human question'), second = f.completed('second', 'Another original question')
    const accept = vi.spyOn(f.store, 'accept'), transition = vi.spyOn(f.store, 'transition')
    expect(f.store.publicUserMessage(actor, conversationId, first.checkpoint!.userEntryId)).toBe('Original human question')
    expect(f.store.publicUserMessage(actor, conversationId, second.checkpoint!.userEntryId)).toBe('Another original question')
    expect(f.store.publicUserMessage(actor, conversationId, 'user:unknown')).toBeNull()
    expect(f.store.publicUserMessage(actor, conversationId, first.checkpoint!.leafEntryId)).toBeNull()
    expect(accept).not.toHaveBeenCalled(); expect(transition).not.toHaveBeenCalled()
    f.store.purgeRecoveryPayload(actor, first.submissionId)
    expect(f.store.publicUserMessage(actor, conversationId, first.checkpoint!.userEntryId)).toBeNull()
    f.store.releaseWriter(f.lease); f.store.close()
    const reopened = ControlStore.open(f.root); cleanup.push(() => reopened.close())
    expect(reopened.publicUserMessage(actor, conversationId, first.checkpoint!.userEntryId)).toBeNull()
    expect(reopened.publicUserMessage(actor, conversationId, second.checkpoint!.userEntryId)).toBe('Another original question')
  })

  it('fences owner, workspace, conversation and native session instead of granting authority through an entry ID', () => {
    const f = fixture(), first = f.completed('first', 'Private original input'), entry = first.checkpoint!.userEntryId
    for (const denied of [{ ...actor, actorId: 'actor:other' }, { ...actor, workspaceId: 'workspace:other' }]) {
      expect(() => f.store.publicUserMessage(denied, conversationId, entry)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    }
    f.store.createConversation(actor, { conversationId: 'conversation:other', runtimeSessionId: sessionId })
    expect(f.store.publicUserMessage(actor, 'conversation:other', entry)).toBeNull()
    expect(() => f.store.publicUserMessage(actor, conversationId, '../file')).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    f.store.releaseWriter(f.lease)
    f.store.rebind(actor, conversationId, f.binding.version, 'session:replacement', null)
    expect(f.store.publicUserMessage(actor, conversationId, entry)).toBeNull()
  })

  it('retains exact authorized older-generation mappings when the actual native session is unchanged', () => {
    const f = fixture(), first = f.completed('first', 'Same-session historical human input')
    f.store.releaseWriter(f.lease)
    f.store.rebind(actor, conversationId, f.binding.version, sessionId, first.checkpoint!.leafEntryId)
    expect(f.store.publicUserMessage(actor, conversationId, first.checkpoint!.userEntryId)).toBe('Same-session historical human input')
  })

  it.each(['payload', 'native-link', 'receipt-identity'] as const)('rejects damaged %s rather than falling back to prepared or current text', damage => {
    const f = fixture(), first = f.completed('first', 'First original question'), second = f.completed('second', 'Second original question')
    f.inspect(database => {
      if (damage === 'payload') {
        const row = database.prepare('SELECT payload FROM submissions WHERE submission_id=?').get(first.submissionId)!
        const payload = JSON.parse(String(row.payload)) as { text: string }; payload.text = 'PRIVATE PREPARED SOURCE INJECTION'
        database.prepare('UPDATE submissions SET payload=? WHERE submission_id=?').run(JSON.stringify(payload), first.submissionId)
      } else if (damage === 'native-link') {
        database.prepare('DELETE FROM checkpoint_bindings WHERE submission_id=?').run(second.submissionId)
        database.prepare('UPDATE checkpoint_bindings SET submission_id=? WHERE runtime_session_id=? AND user_entry_id=?').run(second.submissionId, sessionId, first.checkpoint!.userEntryId)
      } else {
        const row = database.prepare('SELECT receipt FROM submissions WHERE submission_id=?').get(first.submissionId)!
        const receipt = JSON.parse(String(row.receipt)) as { checkpoint: { runtimeSessionId: string } }; receipt.checkpoint.runtimeSessionId = 'session:forged'
        database.prepare('UPDATE submissions SET receipt=? WHERE submission_id=?').run(JSON.stringify(receipt), first.submissionId)
      }
    })
    expect(() => f.store.publicUserMessage(actor, conversationId, first.checkpoint!.userEntryId)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })
})
