import type { DatabaseSync } from 'node:sqlite'
import { ControlStoreError } from './control-store.js'

const APPLICATION_ID = 0x44415452
const originalColumns = ['conversation_id', 'binding_id', 'session_id', 'actor', 'workspace', 'filename', 'seal', 'owner_hash']
const columns = [...originalColumns, 'binding_json', 'selected_head', 'handoff_id', 'lineage_configuration']
const journalColumns = ['operation_id', 'source_conversation_id', 'source_binding_id', 'target_conversation_id', 'actor', 'workspace', 'idempotency_key', 'request_hash', 'phase', 'record_json', 'record_hash']
function invalid(message: string): never { throw new ControlStoreError('integrity-error', message) }
function assertColumns(db: DatabaseSync, table: string, expected: string[]): void {
  const found = db.prepare(`PRAGMA table_info(${table})`).all()
  if (found.length !== expected.length || found.some((column, index) => column.name !== expected[index] || column.type !== 'TEXT'
    || column.pk !== (index === 0 ? 1 : 0) || column.notnull !== (table === 'runtimes' ? index >= 1 && index <= 4 ? 1 : 0 : index === 0 || index === 3 ? 0 : 1))) invalid('Runtime catalog schema differs from its reviewed version')
}
function assertUnique(db: DatabaseSync, table: string, expected: string[][]): void {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all().filter(index => index.partial === 0)
  if (indexes.length !== expected.length || indexes.some(index => index.unique !== 1)) invalid('Runtime catalog identity indexes differ from the reviewed schema')
  const actual = indexes.map(index => db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(row => row.name).join(',')).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected.map(value => value.join(',')).sort())) invalid('Runtime catalog identity indexes are missing')
}
function assertTables(db: DatabaseSync, expected: string[]): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
  if (JSON.stringify(tables) !== JSON.stringify([...expected].sort())) invalid('Runtime catalog has an unknown schema')
}
function journal(db: DatabaseSync): void {
  db.exec(`CREATE TABLE lineage_handoffs (
    operation_id TEXT PRIMARY KEY, source_conversation_id TEXT NOT NULL, source_binding_id TEXT NOT NULL,
    target_conversation_id TEXT, actor TEXT NOT NULL, workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL, phase TEXT NOT NULL, record_json TEXT NOT NULL, record_hash TEXT NOT NULL,
    UNIQUE(source_conversation_id,actor,workspace,idempotency_key));
    CREATE UNIQUE INDEX lineage_active_source ON lineage_handoffs(source_conversation_id) WHERE phase!='complete';
    CREATE UNIQUE INDEX lineage_active_target ON lineage_handoffs(target_conversation_id) WHERE phase!='complete' AND target_conversation_id IS NOT NULL;`)
}

/** Reviewed v1 → v2 only. Never infer stopped ownership, rebuild, discard rows,
 * clear a claim or touch a different application database to make migration fit.
 */
export function initializeRuntimeCatalog(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const application = Number(db.prepare('PRAGMA application_id').get()!.application_id), version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    if (!((application === APPLICATION_ID && [1, 2].includes(version)) || (application === 0 && version === 0))) invalid('Unknown runtime catalog identity/version')
    if (db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') invalid('Runtime catalog integrity failed')
    if (version === 0) {
      assertTables(db, [])
      db.exec(`CREATE TABLE runtimes (
        conversation_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, workspace TEXT NOT NULL,
        filename TEXT, seal TEXT, owner_hash TEXT, binding_json TEXT, selected_head TEXT, handoff_id TEXT, lineage_configuration TEXT);`)
      journal(db)
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=2;`)
    } else if (version === 1) {
      assertTables(db, ['runtimes']); assertColumns(db, 'runtimes', originalColumns)
      assertUnique(db, 'runtimes', [['conversation_id'], ['session_id']])
      if (db.prepare('SELECT conversation_id FROM runtimes WHERE owner_hash IS NOT NULL LIMIT 1').get()) {
        throw new ControlStoreError('recovery-required', 'Cleanly join and release v1 runtime owners before catalog migration')
      }
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' LIMIT 1").get()) invalid('Unexpected runtime catalog trigger')
      db.exec('ALTER TABLE runtimes ADD COLUMN binding_json TEXT; ALTER TABLE runtimes ADD COLUMN selected_head TEXT; ALTER TABLE runtimes ADD COLUMN handoff_id TEXT; ALTER TABLE runtimes ADD COLUMN lineage_configuration TEXT;')
      journal(db)
      db.exec('PRAGMA user_version=2;')
    }
    assertTables(db, ['runtimes', 'lineage_handoffs']); assertColumns(db, 'runtimes', columns); assertColumns(db, 'lineage_handoffs', journalColumns)
    assertUnique(db, 'runtimes', [['conversation_id'], ['session_id']])
    assertUnique(db, 'lineage_handoffs', [['operation_id'], ['source_conversation_id', 'actor', 'workspace', 'idempotency_key']])
    if (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").get()) invalid('Unexpected runtime catalog trigger or view')
    for (const [name, column] of [['lineage_active_source', 'source_conversation_id'], ['lineage_active_target', 'target_conversation_id']] as const) {
      const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)
      const expected = `CREATE UNIQUE INDEX ${name} ON lineage_handoffs(${column}) WHERE phase!='complete'${column === 'target_conversation_id' ? ' AND target_conversation_id IS NOT NULL' : ''}`
      if (typeof index?.sql !== 'string' || index.sql.trim().replace(/\s+/gu, ' ').toLowerCase() !== expected.toLowerCase()) invalid('Runtime handoff fence index is missing or changed')
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
