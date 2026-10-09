import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { SourceScopeVersion } from '@docatlas/contracts'
import { ResearchScopeSnapshots } from '../src/research/scope-snapshots.js'
import { SourceScopeStore } from '../src/storage/source-scope-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })
const source = { documentId: 'doc:research', revisionId: 'rev:research', role: 'primary' as const }
const scope = (id = 'scope:research:capture'): SourceScopeVersion => ({ schemaVersion: 1, scopeVersionId: id, workspaceId: 'workspace:research', investigationId: 'investigation:research',
  version: 1, included: [], excluded: [], locked: true, createdBy: { kind: 'user', actorId: 'actor:research' }, createdAt: '2026-09-09T00:00:00Z' })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'docatlas-research-scopes-')); cleanup.push(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'snapshots'), file = join(root, 'research-scope-snapshots.sqlite3')
  let store = new ResearchScopeSnapshots(root); cleanup.push(() => store.close())
  const tamper = (change: (database: DatabaseSync) => void) => { const database = new DatabaseSync(file); try { change(database) } finally { database.close() } }
  return { parent, root, file, get store() { return store }, reopen: () => { store.close(); store = new ResearchScopeSnapshots(root) }, tamper }
}

it('keeps immutable empty/capture snapshots in their partition without document admission, content or scope binding', async () => {
  const f = fixture(), legacy = await SourceScopeStore.open(join(f.parent, 'legacy-domain')); cleanup.push(() => legacy.close())
  const empty = scope(), capture = { ...scope('scope:human-selection'), included: [source] }
  const first = f.store.record(empty)
  expect(first).toEqual({ status: 'created', scope: empty })
  first.scope.createdBy.actorId = 'actor:mutated-return'
  expect(f.store.get(empty.workspaceId, empty.scopeVersionId)).toEqual(empty)
  expect(f.store.record(capture)).toEqual({ status: 'created', scope: capture })
  expect(legacy.get('conversation:unbound').status).toBe('unbound')
  expect(legacy.getEligibleLibrarySource(capture.workspaceId, source.documentId, source.revisionId)).toBeUndefined()
  expect(legacy.getSourceScopeVersion(capture.workspaceId, capture.scopeVersionId)).toBeUndefined()
  expect(statSync(f.root).mode & 0o777).toBe(0o700); expect(statSync(f.file).mode & 0o777).toBe(0o600)
  const database = new DatabaseSync(f.file, { readOnly: true })
  try {
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'scopes' }])
    const values = database.prepare('SELECT body FROM scopes').all().map(row => JSON.parse(String(row.body)))
    expect(values.every(value => !('text' in value) && !('representations' in value) && !('evidence' in value))).toBe(true)
  } finally { database.close() }
})

it('reopens and replays exact snapshots across handles, without allowing identity updates or cross-workspace lookup', () => {
  const f = fixture(), value = scope()
  f.store.record(value); f.reopen()
  const reversed = Object.fromEntries(Object.entries(value).reverse()) as unknown as SourceScopeVersion
  expect(f.store.record(reversed)).toEqual({ status: 'replayed', scope: value })
  const second = new ResearchScopeSnapshots(f.root)
  try { expect(second.record(value).status).toBe('replayed') } finally { second.close() }
  expect(() => f.store.record({ ...value, included: [source] })).toThrow('different content')
  expect(f.store.get('workspace:other', value.scopeVersionId)).toBeUndefined()
  const other = { ...value, workspaceId: 'workspace:other' }
  expect(f.store.record(other).status).toBe('created'); expect(f.store.get(other.workspaceId, other.scopeVersionId)).toEqual(other)
  expect(f.store.get(value.workspaceId, value.scopeVersionId)).toEqual(value)
  f.store.close(); f.store.close(); expect(() => f.store.get(value.workspaceId, value.scopeVersionId)).toThrow('closed')
})

it.each([
  { schemaVersion: 2 }, { version: 2 }, { locked: false }, { previousScopeVersionId: 'scope:previous' },
  { excluded: [{ documentId: source.documentId, revisionId: source.revisionId, reason: 'user' }] },
  { included: [source, { ...source, role: 'secondary' }] },
  { included: Array.from({ length: 65 }, (_, index) => ({ ...source, documentId: `doc:${index}` })) },
  { text: 'document content cannot be stored here' }, { representations: [] }, { evidence: [] },
])('rejects unsupported capture semantics/fields without saving anything %#', patch => {
  const f = fixture(), candidate = { ...scope(), ...patch } as unknown as SourceScopeVersion
  expect(() => f.store.record(candidate)).toThrow()
  expect(f.store.get(scope().workspaceId, scope().scopeVersionId)).toBeUndefined()
})

it.each(['hash', 'workspace', 'scope-id', 'seal', 'resealed-invalid'])('detects %s corruption on lookup and reopening', kind => {
  const f = fixture(), value = scope(); f.store.record(value)
  f.tamper(database => {
    if (kind === 'hash') database.prepare('UPDATE scopes SET body_hash=?').run('f'.repeat(64))
    if (kind === 'workspace') database.prepare('UPDATE scopes SET workspace_id=?').run('workspace:forged')
    if (kind === 'scope-id') database.prepare('UPDATE scopes SET scope_id=?').run('scope:forged')
    if (kind === 'seal') database.prepare('UPDATE scopes SET seal=?').run('f'.repeat(64))
    if (kind === 'resealed-invalid') {
      const row = database.prepare('SELECT * FROM scopes').get()!, candidate = JSON.parse(String(row.body)); candidate.locked = false
      const body = JSON.stringify(candidate), bodyHash = hash(body)
      database.prepare('UPDATE scopes SET body=?,body_hash=?,seal=?').run(body, bodyHash, hash(JSON.stringify([1, row.id, row.workspace_id, row.scope_id, bodyHash])))
    }
  })
  expect(() => f.store.get(value.workspaceId, value.scopeVersionId)).toThrow()
  expect(f.reopen).toThrow()
})

it('rejects unknown schema versions/table layouts and directory/database symlinks without overwriting their targets', () => {
  const f = fixture(); f.store.close()
  f.tamper(database => { database.exec('PRAGMA user_version=7') })
  expect(() => new ResearchScopeSnapshots(f.root)).toThrow('Unknown research scope schema')
  const raw = new DatabaseSync(f.file); expect(raw.prepare('PRAGMA user_version').get()!.user_version).toBe(7); raw.close()
  const unknown = join(f.parent, 'unknown'); mkdirSync(unknown)
  const database = new DatabaseSync(join(unknown, 'research-scope-snapshots.sqlite3')); database.exec('CREATE TABLE unrelated(sentinel TEXT)'); database.close()
  expect(() => new ResearchScopeSnapshots(unknown)).toThrow('Unknown research scope schema')
  const target = join(f.parent, 'target'), alias = join(f.parent, 'alias'); mkdirSync(target); symlinkSync(target, alias, 'dir')
  expect(() => new ResearchScopeSnapshots(alias)).toThrow('symlinks')
  expect(() => new ResearchScopeSnapshots('relative')).toThrow('dedicated absolute')
  const linked = join(f.parent, 'linked-database'), sentinel = join(f.parent, 'sentinel'); mkdirSync(linked); writeFileSync(sentinel, 'untouched')
  symlinkSync(sentinel, join(linked, 'research-scope-snapshots.sqlite3'))
  expect(() => new ResearchScopeSnapshots(linked)).toThrow('database path'); expect(readFileSync(sentinel, 'utf8')).toBe('untouched')
})

it('enforces whole-snapshot bytes and global retention while permitting exact replay at capacity', () => {
  const f = fixture(), value = scope()
  expect(() => f.store.record({ ...value, included: Array.from({ length: 64 }, (_, index) => ({ ...source, documentId: `doc:${index}`, reason: 'x'.repeat(1000) })) })).toThrow('byte budget')
  f.store.record(value)
  // Seed legitimate bounded rows in one test-only transaction instead of issuing 4095 fsync-heavy API calls.
  f.tamper(database => {
    const sample = JSON.parse(String(database.prepare('SELECT body FROM scopes').get()!.body)), insert = database.prepare('INSERT INTO scopes VALUES(?,?,?,?,?,?)')
    database.exec('BEGIN IMMEDIATE')
    try {
      for (let index = 1; index < 4096; index++) {
        sample.scopeVersionId = `scope:capacity:${index}`
        const body = JSON.stringify(sample), bodyHash = hash(body), id = hash(JSON.stringify([sample.workspaceId, sample.scopeVersionId]))
        insert.run(id, sample.workspaceId, sample.scopeVersionId, body, bodyHash, hash(JSON.stringify([1, id, sample.workspaceId, sample.scopeVersionId, bodyHash])))
      }
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
  })
  f.reopen()
  expect(f.store.record(value).status).toBe('replayed')
  expect(() => f.store.record(scope('scope:capacity:overflow'))).toThrow('capacity')
  expect(f.store.get(value.workspaceId, value.scopeVersionId)).toEqual(value)
})
