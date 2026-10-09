import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { DocumentInvocation } from '@docatlas/core'
import type { DocumentLocator, ProductPiCheckpoint, ReadResult, SourceScopeVersion } from '@docatlas/contracts'
import { AnswerReceipts, answerHash } from '../src/storage/answer-receipts.js'
import { ControlStore } from '../src/storage/control-store.js'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const fixtureData = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as { quoteLocator: DocumentLocator, sourceScope: SourceScopeVersion }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-answer-receipts-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(join(root, 'control'))
  cleanups.push(() => control.close())
  const binding = control.createManagedConversation({ actorId: 'actor:answers', workspaceId: 'workspace:answers' }, 'conversation:answer-receipts').binding
  let store = new AnswerReceipts(join(root, 'answers'))
  cleanups.push(() => store.close())
  const locator = structuredClone(fixtureData.quoteLocator), scope = { ...structuredClone(fixtureData.sourceScope), workspaceId: binding.workspaceId }
  const source = { documentId: locator.documentId, revisionId: locator.revisionId, representationId: locator.representationId, representationContentHash: locator.representationContentHash }
  const result: ReadResult = { schemaVersion: 1, resultType: 'read', mode: 'page', source: { documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId }, textQuality: 'usable',
    items: [{ itemType: 'block', blockId: 'p00017.b00004.text.abc123', physicalPage: 17, kind: 'paragraph', text: 'Revenue increased by 12%.', locator }],
    pageInfo: { schemaVersion: 1, limit: 20, returned: 1, total: 1, usedChars: 24, truncated: false, completeness: 'complete' } }
  const active: DocumentInvocation = { submissionId: 'submission:answer', scope: { scope, sources: [source] }, assertCurrent: vi.fn(), source: (documentId, revisionId) => {
    if (documentId !== source.documentId || revisionId !== source.revisionId) throw new Error('Inactive source')
    return source
  }, originalHash: () => 'a'.repeat(64) }
  const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: active.submissionId, requestHash: 'b'.repeat(64), runtimeSessionId: binding.runtimeSessionId,
    userEntryId: '11111111', leafEntryId: '33333333', transcriptHash: 'c'.repeat(64), byteLength: 1234, entryCount: 3, settledAt: '2026-09-09T00:00:00Z' }
  const publication = { messageId: '22222222', manifestId: 'answer-manifest:receipt', manifestHash: 'd'.repeat(64), nativeTextHash: 'e'.repeat(64), scopeVersionId: scope.scopeVersionId, checkpoint }
  const tamper = (change: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(root, 'answers', 'answers.sqlite3')); try { change(db) } finally { db.close() } }
  return { get store() { return store }, reopen: () => { store.close(); store = new AnswerReceipts(join(root, 'answers')) }, root, binding, active, result, publication, tamper }
}

it('reopens immutable native-call Read receipts without changing JSON field order or conflating submission scopes', () => {
  const f = fixture(), nativeCallId = 'call:native-read', before = JSON.stringify(f.result)
  f.store.recordRead(f.binding, f.active, nativeCallId, f.result)
  f.store.recordRead(f.binding, f.active, nativeCallId, structuredClone(f.result))
  f.reopen()
  const reads = f.store.reads(f.binding, f.active.submissionId, f.active.scope.scope.scopeVersionId)
  expect(reads).toEqual([{ callId: nativeCallId, scopeVersionId: f.active.scope.scope.scopeVersionId, locators: f.result.items.map(item => item.locator), result: f.result }])
  expect(JSON.stringify(reads[0]!.result)).toBe(before)
  const next = { ...f.active, submissionId: 'submission:next', scope: { ...f.active.scope, scope: { ...f.active.scope.scope, scopeVersionId: 'scope:next' } } }
  f.store.recordRead(f.binding, next, nativeCallId, f.result)
  expect(f.store.reads(f.binding, next.submissionId, 'scope:next')).toHaveLength(1)
  expect(() => f.store.reads(f.binding, f.active.submissionId, 'scope:next')).toThrow('binding')
  expect(() => f.store.recordRead(f.binding, f.active, nativeCallId, { ...f.result, textQuality: 'sparse' })).toThrow('another value')
  expect(f.active.assertCurrent).toHaveBeenCalled()
})

it('does not permit other owners, runtimes or generations to read stored attestations/publications', () => {
  const f = fixture()
  f.store.recordRead(f.binding, f.active, 'call:native', f.result); f.store.publish(f.binding, f.publication)
  expect(f.store.reads({ ...f.binding, bindingId: 'binding:another' }, f.active.submissionId, f.active.scope.scope.scopeVersionId)).toEqual([])
  expect(f.store.publication({ ...f.binding, bindingId: 'binding:another' }, f.publication.messageId)).toBeUndefined()
  for (const change of [{ ownerActorId: 'actor:foreign' }, { workspaceId: 'workspace:foreign' }, { runtimeSessionId: '00000000-0000-4000-8000-000000000000' }, { generation: f.binding.generation + 1 }]) {
    expect(() => f.store.reads({ ...f.binding, ...change }, f.active.submissionId, f.active.scope.scope.scopeVersionId)).toThrow('owner')
    expect(() => f.store.publication({ ...f.binding, ...change }, f.publication.messageId)).toThrow('owner')
  }
})

it('rejects locate, stale source/frame, foreign workspace, invalid shape and malformed native call references before admission', () => {
  const f = fixture()
  expect(() => f.store.recordRead(f.binding, f.active, 'call:locate', { ...f.result, mode: 'locate' })).toThrow()
  for (const callId of ['', 'x'.repeat(257)]) expect(() => f.store.recordRead(f.binding, f.active, callId, f.result)).toThrow()
  expect(() => f.store.recordRead(f.binding, { ...f.active, assertCurrent: () => { throw new Error('source frame changed') } }, 'call:stale', f.result)).toThrow('frame changed')
  expect(() => f.store.recordRead(f.binding, { ...f.active, scope: { ...f.active.scope, scope: { ...f.active.scope.scope, workspaceId: 'workspace:foreign' } } }, 'call:foreign', f.result)).toThrow()
  expect(() => f.store.recordRead(f.binding, f.active, 'call:changed', { ...f.result, items: f.result.items.map(item => ({ ...item, locator: { ...item.locator, representationContentHash: 'f'.repeat(64) } })) })).toThrow('source changed')
  expect(() => f.store.recordRead(f.binding, f.active, 'call:bad-shape', { ...f.result, unexpected: true } as ReadResult)).toThrow()
  expect(f.store.reads(f.binding, f.active.submissionId, f.active.scope.scope.scopeVersionId)).toEqual([])
})

it('publishes only immutable owner-bound pointers while canonical manifests remain external to this store', () => {
  const f = fixture()
  f.store.publish(f.binding, f.publication); f.store.publish(f.binding, structuredClone(f.publication)); f.reopen()
  expect(f.store.publication(f.binding, f.publication.messageId)).toMatchObject({ ...f.publication, kind: 'answer-publication', bindingId: f.binding.bindingId, actorId: f.binding.ownerActorId })
  // Native metadata can follow the final assistant entry; message ID is deliberately not the leaf ID.
  expect(f.publication.messageId).not.toBe(f.publication.checkpoint.leafEntryId)
  expect(() => f.store.publish(f.binding, { ...f.publication, manifestHash: 'f'.repeat(64) })).toThrow('another value')
  expect(() => f.store.publish(f.binding, { ...f.publication, nativeTextHash: 'not-a-hash' })).toThrow()
  expect(() => f.store.publish(f.binding, { ...f.publication, checkpoint: { ...f.publication.checkpoint, runtimeSessionId: '00000000-0000-4000-8000-000000000000' } })).toThrow('checkpoint')
  expect(f.store.publication(f.binding, 'native:missing')).toBeUndefined()
})

it.each(['seal', 'submission-column', 'call-id-body', 'unknown-field', 'locate-body'] as const)('detects %s Read record tampering even when a payload is resealed', variant => {
  const f = fixture()
  f.store.recordRead(f.binding, f.active, 'call:read', f.result)
  f.tamper(db => {
    if (variant === 'seal') { db.prepare('UPDATE records SET seal=?').run('f'.repeat(64)); return }
    if (variant === 'submission-column') { db.prepare('UPDATE records SET submission=?').run('submission:forged'); return }
    const row = db.prepare('SELECT body FROM records').get()!, value = JSON.parse(String(row.body))
    if (variant === 'call-id-body') value.callId = 'call:forged'
    if (variant === 'unknown-field') value.unknown = true
    if (variant === 'locate-body') value.result.mode = 'locate'
    const body = JSON.stringify(value); db.prepare('UPDATE records SET body=?,seal=?').run(body, answerHash(body))
  })
  expect(() => f.store.reads(f.binding, variant === 'submission-column' ? 'submission:forged' : f.active.submissionId, f.active.scope.scope.scopeVersionId)).toThrow()
})

it.each(['manifestId', 'messageId', 'nativeTextHash', 'unknownField'] as const)('rejects malformed %s in resealed durable publication payloads', field => {
  const f = fixture()
  f.store.publish(f.binding, f.publication)
  f.tamper(db => {
    const value = JSON.parse(String(db.prepare('SELECT body FROM records').get()!.body))
    value[field] = field === 'nativeTextHash' ? 'bad' : { not: 'a string' }
    const body = JSON.stringify(value); db.prepare('UPDATE records SET body=?,seal=?').run(body, answerHash(body))
  })
  expect(() => f.store.publication(f.binding, f.publication.messageId)).toThrow()
})

it('enforces per-submission count and whole-record byte budgets without erasing existing evidence receipts', () => {
  const f = fixture()
  for (let index = 0; index < 256; index++) f.store.recordRead(f.binding, f.active, `call:${index}`, f.result)
  expect(() => f.store.recordRead(f.binding, f.active, 'call:overflow', f.result)).toThrow('budget')
  expect(f.store.reads(f.binding, f.active.submissionId, f.active.scope.scope.scopeVersionId)).toHaveLength(256)
  f.store.recordRead(f.binding, f.active, 'call:0', f.result)
  const many: ReadResult = { ...f.result, items: Array.from({ length: 100 }, (_, index) => ({ ...f.result.items[0]!, blockId: `block:${index}`, text: 'x'.repeat(4000) })),
    pageInfo: { schemaVersion: 1, limit: 100, returned: 100, total: 100, usedChars: 400000, truncated: false, completeness: 'complete' } }
  expect(() => f.store.recordRead(f.binding, { ...f.active, submissionId: 'submission:oversized' }, 'call:large', many)).toThrow('budget')
  expect(f.store.reads(f.binding, 'submission:oversized', f.active.scope.scope.scopeVersionId)).toEqual([])
})
