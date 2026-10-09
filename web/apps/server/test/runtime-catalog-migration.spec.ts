import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProductBinding } from '@docatlas/contracts'
import { RuntimeCatalog } from '../src/storage/runtime-catalog.js'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
function fixture(active = false, unique = true) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-catalog-migration-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'runtime-catalog.sqlite3'), db = new DatabaseSync(file)
  db.exec(`CREATE TABLE runtimes (conversation_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, session_id TEXT NOT NULL ${unique ? 'UNIQUE' : ''}, actor TEXT NOT NULL, workspace TEXT NOT NULL,
    filename TEXT, seal TEXT, owner_hash TEXT); PRAGMA application_id=1145132114; PRAGMA user_version=1;`)
  const binding: ProductBinding = { schemaVersion: 1, kind: 'binding', bindingId: 'binding:catalog-v1', conversationId: 'conversation:catalog-v1',
    workspaceId: 'workspace:catalog-v1', ownerActorId: 'actor:catalog-v1', investigationId: null, runtimeSessionId: 'native:catalog-v1', branchEntryId: null,
    generation: 1, version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }
  const seal = { version: 1, sessionId: binding.runtimeSessionId, cwd: join(root, 'work'), transcriptHash: 'a'.repeat(64), byteLength: 4321, entryCount: 6, leafEntryId: 'entry:catalog-v1-tail' }
  db.prepare('INSERT INTO runtimes VALUES(?,?,?,?,?,?,?,?)').run(binding.conversationId, binding.bindingId, binding.runtimeSessionId, binding.ownerActorId, binding.workspaceId,
    'original-native.jsonl', JSON.stringify(seal), active ? 'b'.repeat(64) : null)
  const original = db.prepare('SELECT * FROM runtimes').all()
  db.close()
  const inspect = (run: (value: DatabaseSync) => void) => { const value = new DatabaseSync(file); try { run(value) } finally { value.close() } }
  const open = () => { const catalog = new RuntimeCatalog(root); cleanup.push(() => catalog.close()); return catalog }
  return { root, file, binding, seal, original, inspect, open }
}

describe('reviewed non-destructive RuntimeCatalog v1 to v2 upgrade', () => {
  it('preserves every existing identity, filename and native seal, adds empty handoff metadata, and reopens idempotently', () => {
    const f = fixture(), catalog = f.open()
    expect(catalog.inspect(f.binding)).toMatchObject({ filename: 'original-native.jsonl', seal: f.seal, active: false })
    f.inspect(db => {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(2)
      expect(db.prepare('SELECT conversation_id,binding_id,session_id,actor,workspace,filename,seal,owner_hash FROM runtimes').all()).toEqual(f.original)
      expect(db.prepare('SELECT binding_json,selected_head,handoff_id,lineage_configuration FROM runtimes').get()).toEqual({ binding_json: null, selected_head: null, handoff_id: null, lineage_configuration: null })
      expect(db.prepare('SELECT COUNT(*) AS n FROM lineage_handoffs').get()!.n).toBe(0)
    })
    expect(f.open().inspect(f.binding)).toEqual(catalog.inspect(f.binding))
  })

  it('refuses an active v1 owner without expiring, clearing or migrating it', () => {
    const f = fixture(true)
    expect(() => f.open()).toThrowError(expect.objectContaining({ code: 'recovery-required' }))
    f.inspect(db => {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(1)
      expect(db.prepare('SELECT * FROM runtimes').all()).toEqual(f.original)
      expect(db.prepare('PRAGMA table_info(runtimes)').all()).toHaveLength(8)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lineage_handoffs'").get()).toBeUndefined()
    })
  })

  it.each(['extra-table', 'extra-column', 'trigger', 'version', 'application', 'identity-index'] as const)('rejects unknown %s schema with the original rows and version preserved', issue => {
    const f = fixture(false, issue !== 'identity-index')
    f.inspect(db => {
      if (issue === 'extra-table') db.exec('CREATE TABLE unreviewed_handoff(value TEXT)')
      if (issue === 'extra-column') db.exec('ALTER TABLE runtimes ADD COLUMN unreviewed TEXT')
      if (issue === 'trigger') db.exec("CREATE TRIGGER unreviewed AFTER UPDATE ON runtimes BEGIN SELECT RAISE(ABORT,'unreviewed'); END")
      if (issue === 'version') db.exec('PRAGMA user_version=99')
      if (issue === 'application') db.exec('PRAGMA application_id=1')
    })
    expect(() => f.open()).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    f.inspect(db => {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(issue === 'version' ? 99 : 1)
      expect(db.prepare('SELECT conversation_id,binding_id,session_id,actor,workspace,filename,seal,owner_hash FROM runtimes').all()).toEqual(f.original)
    })
  })
})
