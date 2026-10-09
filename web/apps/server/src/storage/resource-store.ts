import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { ResourceApproval, ResourceFile, ResourceSnapshot } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { ProductActor } from './control-store.js'

const MAX_BYTES = 32 * 1024 * 1024, MAX_FILES = 512
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const within = (root: string, path: string) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) }
function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/' || path === homedir()) throw new Error('Use a dedicated absolute resource path')
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== ancestor) throw new Error('Resource paths cannot traverse symlinks')
}
function validActor(actor: ProductActor): void {
  if (![actor.actorId, actor.workspaceId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value))) throw new Error('Invalid resource actor')
}
function snapshot(files: ResourceFile[]): ResourceSnapshot {
  const manifestHash = digest(JSON.stringify({ schemaVersion: 1, files }))
  return { schemaVersion: 1, kind: 'resource-snapshot', snapshotId: `resources:${manifestHash}`, manifestHash, byteLength: files.reduce((sum, file) => sum + file.byteLength, 0), files }
}

/** Operator-only filesystem admission. Browser requests use IDs and reviewed hashes, never source paths. */
export class ResourceStore {
  private readonly db: DatabaseSync
  private readonly listeners = new Map<string, Set<() => void>>()
  private closed = false
  constructor(readonly root: string, private readonly protectedRoots: readonly string[] = []) {
    canonical(root); protectedRoots.forEach(canonical)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    mkdirSync(join(root, 'snapshots'), { recursive: true, mode: 0o700 })
    canonical(join(root, 'snapshots'))
    const database = join(root, 'resource-approvals.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(database + suffix) && (!lstatSync(database + suffix).isFile() || lstatSync(database + suffix).isSymbolicLink())) throw new Error('Invalid resource database path')
    this.db = new DatabaseSync(database)
    chmodSync(database, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, actor TEXT NOT NULL, workspace TEXT NOT NULL, snapshot TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(actor,workspace,snapshot));')
  }
  capture(sourceRoot: string): ResourceSnapshot {
    this.open(); canonical(sourceRoot)
    if ([this.root, ...this.protectedRoots].some(path => within(sourceRoot, path) || within(path, sourceRoot))) throw new Error('Resource source overlaps protected state')
    const files = scan(sourceRoot)
    const result = snapshot(files.map(file => file.record))
    parseContract('resource-trust', result)
    const target = this.directory(result.snapshotId)
    if (existsSync(target)) { this.inspect(result.snapshotId); return result }
    const staging = join(this.root, 'snapshots', `.pending-${randomUUID()}`)
    mkdirSync(join(staging, 'tree'), { recursive: true, mode: 0o700 })
    try {
      for (const { record, bytes } of files) {
        const targetFile = join(staging, 'tree', record.path)
        mkdirSync(dirname(targetFile), { recursive: true, mode: 0o700 })
        durableFile(targetFile, bytes, record.executable ? 0o555 : 0o444)
      }
      if (JSON.stringify(snapshot(scan(sourceRoot).map(file => file.record))) !== JSON.stringify(result)) throw new Error('Resource source changed during capture')
      durableFile(join(staging, 'manifest.json'), Buffer.from(JSON.stringify(result)), 0o444)
      syncDirectories(staging)
      renameSync(staging, target)
      syncDirectory(dirname(target))
      return result
    } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }) }
  }
  inspect(id: string): ResourceSnapshot {
    this.open()
    const directory = this.directory(id)
    canonical(directory)
    const manifestPath = join(directory, 'manifest.json')
    if (lstatSync(manifestPath).isSymbolicLink() || lstatSync(manifestPath).size > 1024 * 1024) throw new Error('Invalid resource manifest')
    const manifest = parseContract('resource-trust', JSON.parse(readFileSync(manifestPath, 'utf8')))
    if (manifest.kind !== 'resource-snapshot' || manifest.snapshotId !== id) throw new Error('Resource identity mismatch')
    const actual = snapshot(scan(join(directory, 'tree')).map(file => file.record))
    if (actual.manifestHash !== manifest.manifestHash || actual.byteLength !== manifest.byteLength || actual.files.length !== manifest.files.length
      || actual.files.some((file, index) => { const recorded = manifest.files[index]!; return file.path !== recorded.path || file.contentHash !== recorded.contentHash || file.byteLength !== recorded.byteLength || file.executable !== recorded.executable })) throw new Error('Resource snapshot integrity failure')
    return manifest
  }
  approve(actor: ProductActor, id: string, reviewedHash: string): ResourceApproval {
    this.open(); validActor(actor)
    const manifest = this.inspect(id)
    if (manifest.manifestHash !== reviewedHash) throw new Error('Approval must match the reviewed manifest')
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT value FROM approvals WHERE actor=? AND workspace=? AND snapshot=?').get(actor.actorId, actor.workspaceId, id)
      const existing = previous ? this.parse(previous.value) : undefined
      if (existing && (existing.actorId !== actor.actorId || existing.workspaceId !== actor.workspaceId || existing.snapshotId !== id || existing.manifestHash !== reviewedHash)) throw new Error('Resource approval identity mismatch')
      if (existing?.state === 'approved') return existing
      const approval: ResourceApproval = { schemaVersion: 1, kind: 'resource-approval', approvalId: existing?.approvalId ?? `approval:${randomUUID()}`,
        actorId: actor.actorId, workspaceId: actor.workspaceId, snapshotId: id, manifestHash: reviewedHash, state: 'approved', version: (existing?.version ?? 0) + 1, updatedAt: new Date().toISOString() }
      parseContract('resource-trust', approval)
      this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(approval.approvalId, actor.actorId, actor.workspaceId, id, JSON.stringify(approval))
      return approval
    }, approval => this.notify(approval.approvalId))
  }
  revoke(actor: ProductActor, approvalId: string): ResourceApproval {
    return this.transaction(() => {
      const approval = this.get(actor, approvalId)
      const next: ResourceApproval = { ...approval, state: 'revoked', version: approval.version + 1, updatedAt: new Date().toISOString() }
      this.db.prepare('UPDATE approvals SET value=? WHERE id=?').run(JSON.stringify(next), approvalId)
      return next
    }, () => this.notify(approvalId))
  }
  lease(actor: ProductActor, approvalId: string): { treeRoot: string, approval: ResourceApproval, assertCurrent(): void, subscribe(invalidated: () => void): () => void } {
    const approval = this.get(actor, approvalId)
    if (approval.state !== 'approved') throw new Error('Resource approval is revoked')
    const manifest = this.inspect(approval.snapshotId)
    if (manifest.manifestHash !== approval.manifestHash) throw new Error('Resource approval is stale')
    const assertCurrent = () => {
      const current = this.get(actor, approvalId)
      if (current.state !== 'approved' || current.version !== approval.version || current.manifestHash !== approval.manifestHash) throw new Error('Resource approval changed')
    }
    return { treeRoot: join(this.directory(approval.snapshotId), 'tree'), approval, assertCurrent, subscribe: invalidated => {
      assertCurrent()
      let listeners = this.listeners.get(approvalId)
      if (!listeners) { listeners = new Set(); this.listeners.set(approvalId, listeners) }
      const check = () => { try { assertCurrent() } catch { invalidated() } }
      listeners.add(check)
      return () => { listeners.delete(check); if (!listeners.size) this.listeners.delete(approvalId) }
    } }
  }
  get(actor: ProductActor, id: string): ResourceApproval {
    this.open(); validActor(actor)
    const row = this.db.prepare('SELECT value FROM approvals WHERE id=? AND actor=? AND workspace=?').get(id, actor.actorId, actor.workspaceId)
    if (!row) throw new Error('Resource approval unavailable')
    const value = this.parse(row.value)
    if (value.approvalId !== id || value.actorId !== actor.actorId || value.workspaceId !== actor.workspaceId) throw new Error('Resource approval identity mismatch')
    return value
  }
  close(): void { if (!this.closed) { this.closed = true; for (const id of this.listeners.keys()) this.notify(id); this.db.close() } }
  private parse(value: unknown): ResourceApproval { const parsed = parseContract('resource-trust', JSON.parse(String(value))); if (parsed.kind !== 'resource-approval') throw new Error('Invalid approval record'); return parsed }
  private directory(id: string): string { if (!/^resources:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid resource snapshot ID'); return join(this.root, 'snapshots', id.slice(10)) }
  private open(): void { if (this.closed) throw new Error('Resource store is closed') }
  private transaction<T>(operation: () => T, after: (result: T) => void): T {
    this.open(); this.db.exec('BEGIN IMMEDIATE')
    let result: T
    try { result = operation(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    after(result); return result
  }
  private notify(id: string): void { for (const callback of this.listeners.get(id) ?? []) try { callback() } catch { /* Invalidation observers cannot undo a durable decision. */ } }
}

function scan(root: string): Array<{ record: ResourceFile, bytes: Buffer }> {
  if (process.platform !== 'linux') throw new Error('Safe resource capture requires the Linux fd boundary')
  canonical(root)
  const files: Array<{ record: ResourceFile, bytes: Buffer }> = []
  let total = 0, directories = 0
  const walk = (directoryFd: number, logical: string, depth: number) => {
    if (depth > 24 || ++directories > 256) throw new Error('Resource directory limit exceeded')
    const directory = `/proc/self/fd/${directoryFd}`
    for (const name of readdirSync(directory).sort()) {
      if (['auth.json', 'models.json', 'settings.json', '.env', '.git'].includes(name) || name.startsWith('.env.') || name.includes('\\') || [...name].some(character => character.codePointAt(0)! < 32)) throw new Error('Private/configuration files are not executable resources')
      const path = join(directory, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('Resource symlinks are not permitted')
      if (stat.isDirectory()) {
        const child = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { walk(child, logical ? `${logical}/${name}` : name, depth + 1) } finally { closeSync(child) }
        continue
      }
      if (!stat.isFile()) throw new Error('Only regular resource files are supported')
      if (files.length >= MAX_FILES || stat.size > MAX_BYTES - total) throw new Error('Resource byte/file limit exceeded')
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = fstatSync(fd)
        if (before.ino !== stat.ino || before.dev !== stat.dev || !before.isFile() || before.size !== stat.size || before.ctimeMs !== stat.ctimeMs) throw new Error('Resource changed before capture')
        const buffer = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count }
        const bytes = buffer.subarray(0, offset), after = fstatSync(fd)
        if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Resource changed during capture')
        total += bytes.length
        files.push({ record: { path: logical ? `${logical}/${name}` : name, contentHash: digest(bytes), byteLength: bytes.length, executable: (stat.mode & 0o111) !== 0 }, bytes })
      } finally { closeSync(fd) }
    }
  }
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (realpathSync(`/proc/self/fd/${fd}`) !== root) throw new Error('Resource root changed during open')
    walk(fd, '', 0)
  } finally { closeSync(fd) }
  return files.sort((a, b) => a.record.path < b.record.path ? -1 : a.record.path > b.record.path ? 1 : 0)
}
function durableFile(path: string, bytes: Buffer, mode: number): void { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode); try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) } }
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd) } finally { closeSync(fd) } }
function syncDirectories(path: string): void { for (const name of readdirSync(path)) if (lstatSync(join(path, name)).isDirectory()) syncDirectories(join(path, name)); syncDirectory(path) }
