import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sourceScopeIssues, type SourceScopeVersion } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

const APP_ID = 0x44525353, VERSION = 1, MAX_SCOPES = 4096, MAX_BYTES = 32768
const columns = `id,workspace_id,scope_id,CASE WHEN length(CAST(body AS BLOB))<=${MAX_BYTES} THEN body ELSE NULL END AS body,body_hash,seal`
type ErrorCode = 'invalid-request' | 'integrity-error' | 'conflict' | 'limit-exceeded' | 'unavailable'
export class ResearchScopeSnapshotError extends Error { constructor(readonly code: ErrorCode, message: string) { super(message); this.name = 'ResearchScopeSnapshotError' } }
const fail = (code: ErrorCode, message: string): never => { throw new ResearchScopeSnapshotError(code, message) }

/** Immutable research capture scopes only: an empty ordinary-task frame or an explicitly saved human
 * selection. These snapshots contain no representations, document text or Evidence and grant no Read
 * admission. They never bind a DocumentSession or overwrite its canonical active source scope.
 */
export class ResearchScopeSnapshots {
  private readonly db: DatabaseSync
  private closed = false
  constructor(readonly root: string) {
    if (!isAbsolute(root) || resolve(root) !== root || ['/', homedir(), process.cwd()].includes(root)) fail('invalid-request', 'Use a dedicated absolute research scope directory')
    let parent = root
    while (!existsSync(parent)) parent = dirname(parent)
    if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) fail('invalid-request', 'Research scope directory cannot traverse symlinks')
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
    if (realpathSync(root) !== root) fail('invalid-request', 'Invalid research scope directory')
    const file = join(root, 'research-scope-snapshots.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) fail('integrity-error', 'Invalid research scope database path')
    this.db = new DatabaseSync(file)
    try {
      const application = Number(this.db.prepare('PRAGMA application_id').get()!.application_id), version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      if (!(application === APP_ID && version === VERSION && tables.length === 1 && tables[0]!.name === 'scopes') && !(application === 0 && version === 0 && tables.length === 0)) fail('integrity-error', 'Unknown research scope schema; no automatic migration')
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('integrity-error', 'Research scope database integrity failed')
      chmodSync(file, 0o600); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      if (!version) this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE scopes(id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL,scope_id TEXT NOT NULL,body TEXT NOT NULL,body_hash TEXT NOT NULL,seal TEXT NOT NULL,UNIQUE(workspace_id,scope_id)); PRAGMA application_id=${APP_ID}; PRAGMA user_version=${VERSION}; COMMIT;`)
      const shape = this.db.prepare('PRAGMA table_info(scopes)').all()
      if (shape.map(column => column.name).join(',') !== 'id,workspace_id,scope_id,body,body_hash,seal' || shape.some((column, index) => column.type !== 'TEXT' || column.notnull !== 1 || column.pk !== (index ? 0 : 1))) fail('integrity-error', 'Research scope table shape changed')
      let count = 0
      for (const row of this.db.prepare(`SELECT ${columns} FROM scopes`).iterate()) { if (++count > MAX_SCOPES) fail('integrity-error', 'Research scope retention bound changed'); this.decode(row) }
    } catch (error) { this.db.close(); throw error }
  }
  record(candidate: SourceScopeVersion): { status: 'created' | 'replayed', scope: SourceScopeVersion } {
    this.requireOpen()
    const scope = validate(candidate, 'invalid-request'), body = canonical(scope)
    if (Buffer.byteLength(body) > MAX_BYTES) fail('limit-exceeded', 'Research scope snapshot exceeds the byte budget')
    const id = key(scope.workspaceId, scope.scopeVersionId), bodyHash = hash(body)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare(`SELECT ${columns} FROM scopes WHERE id=?`).get(id)
      let result: { status: 'created' | 'replayed', scope: SourceScopeVersion }
      if (previous) {
        const existing = this.decode(previous)
        if (canonical(existing) !== body) fail('conflict', 'Immutable research scope identity already has different content')
        result = { status: 'replayed', scope: existing }
      } else {
        if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM scopes').get()!.n) >= MAX_SCOPES) fail('limit-exceeded', 'Research scope retention capacity reached')
        this.db.prepare('INSERT INTO scopes VALUES(?,?,?,?,?,?)').run(id, scope.workspaceId, scope.scopeVersionId, body, bodyHash, seal(id, scope.workspaceId, scope.scopeVersionId, bodyHash))
        result = { status: 'created', scope: structuredClone(scope) }
      }
      this.db.exec('COMMIT'); return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  get(workspaceId: string, scopeVersionId: string): SourceScopeVersion | undefined {
    this.requireOpen(); requireId(workspaceId); requireId(scopeVersionId)
    const row = this.db.prepare(`SELECT ${columns} FROM scopes WHERE id=?`).get(key(workspaceId, scopeVersionId))
    if (!row) return undefined
    const scope = this.decode(row)
    if (scope.workspaceId !== workspaceId || scope.scopeVersionId !== scopeVersionId) fail('integrity-error', 'Research scope lookup identity changed')
    return scope
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private requireOpen(): void { if (this.closed) fail('unavailable', 'Research scope store is closed') }
  private decode(row: Record<string, unknown>): SourceScopeVersion {
    if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > MAX_BYTES || typeof row.body_hash !== 'string' || hash(row.body) !== row.body_hash) return fail('integrity-error', 'Research scope payload seal changed')
    let scope: SourceScopeVersion
    try { scope = validate(JSON.parse(row.body), 'integrity-error') } catch { return fail('integrity-error', 'Invalid stored research scope') }
    const id = key(scope.workspaceId, scope.scopeVersionId)
    if (row.id !== id || row.workspace_id !== scope.workspaceId || row.scope_id !== scope.scopeVersionId || row.body !== canonical(scope)
      || row.seal !== seal(id, scope.workspaceId, scope.scopeVersionId, row.body_hash)) return fail('integrity-error', 'Research scope identity seal changed')
    return scope
  }
}

function validate(candidate: unknown, code: ErrorCode): SourceScopeVersion {
  let scope: SourceScopeVersion
  try { scope = parseContract('source-scope-version', candidate) } catch { return fail(code, 'Invalid research source scope') }
  if (sourceScopeIssues(scope).length || scope.version !== 1 || scope.locked !== true || scope.previousScopeVersionId !== undefined || scope.excluded.length !== 0 || scope.included.length > 64) return fail(code, 'Research scopes require an immutable first-version capture with at most 64 sources and no exclusions')
  return JSON.parse(JSON.stringify(scope)) as SourceScopeVersion
}
function requireId(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)) fail('invalid-request', 'Invalid research scope reference') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`
  return JSON.stringify(value)
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const key = (workspaceId: string, scopeVersionId: string) => hash(JSON.stringify([workspaceId, scopeVersionId]))
const seal = (id: string, workspaceId: string, scopeVersionId: string, bodyHash: string) => hash(JSON.stringify([VERSION, id, workspaceId, scopeVersionId, bodyHash]))
