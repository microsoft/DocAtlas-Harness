import { createHash } from 'node:crypto'
import { chmodSync, constants, existsSync, lstatSync } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import type { LibraryDiscoverRequest, LibraryDiscoverResult, UploadReceipt, UploadStart } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { LibraryDiscoveryError, type LibraryDiscoveryPort, type MaterializedLibraryCandidate } from '@docatlas/core'
import { dedicatedDirectory } from '../storage/runtime-catalog.js'
import type { ProductActor } from '../storage/control-store.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const error = (code: ConstructorParameters<typeof LibraryDiscoveryError>[0], message: string): never => { throw new LibraryDiscoveryError(code, message) }
/** Durable reservations and immutable bytes; never parses PDFs or owns model work. */
export class UploadStore implements LibraryDiscoveryPort {
  private readonly db: DatabaseSync
  private readonly active = new Map<string, { controller: AbortController, done: Promise<UploadReceipt> }>()
  private closed = false
  constructor(readonly metadataRoot: string, readonly filesRoot: string, readonly actor: ProductActor) {
    const overlaps = (root: string, path: string) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith('../') }
    if (overlaps(metadataRoot, filesRoot) || overlaps(filesRoot, metadataRoot)) error('invalid-request', 'Upload metadata and byte grants must be separate')
    dedicatedDirectory(metadataRoot); dedicatedDirectory(filesRoot)
    const file = join(metadataRoot, 'uploads.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) error('invalid-request', 'Invalid upload database path')
    this.db = new DatabaseSync(file)
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version), application = Number(this.db.prepare('PRAGMA application_id').get()!.application_id)
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n)
      if (!(application === 0x44415550 && version === 1) && !(application === 0 && version === 0 && count === 0)) error('invalid-request', 'Unknown upload database; no automatic migration')
      chmodSync(file, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      if (!version) this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE uploads(id TEXT PRIMARY KEY, actor TEXT NOT NULL, workspace TEXT NOT NULL, conversation TEXT NOT NULL, request_hash TEXT NOT NULL, bytes INTEGER NOT NULL, value TEXT NOT NULL); PRAGMA application_id=${0x44415550}; PRAGMA user_version=1; COMMIT;`)
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') error('invalid-request', 'Upload database integrity failed')
      this.db.prepare('SELECT id,actor,workspace,conversation,request_hash,bytes,value FROM uploads LIMIT 0').all()
    } catch (cause) { this.db.close(); throw cause }
  }
  reserve(conversationId: string, input: UploadStart): UploadReceipt {
    this.requireOpen(); parseContract('document-http', input)
    const uploadId = `upload:${digest(JSON.stringify([this.actor.actorId, this.actor.workspaceId, conversationId, input.idempotencyKey]))}`
    const requestHash = digest(JSON.stringify([input.name, input.byteLength, input.contentHash]))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.db.prepare('SELECT request_hash FROM uploads WHERE id=?').get(uploadId)
      if (prior) {
        if (prior.request_hash !== requestHash) error('invalid-request', 'Upload key belongs to different bytes or metadata')
        const value = this.get(conversationId, uploadId); this.db.exec('COMMIT'); return value
      }
      const used = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM uploads WHERE actor=? AND workspace=?').get(this.actor.actorId, this.actor.workspaceId)!
      if (Number(used.count) >= 256 || Number(used.bytes) + input.byteLength > 512 * 1024 * 1024) error('limit-exceeded', 'Upload reservation quota reached')
      const value: UploadReceipt = { schemaVersion: 1, kind: 'upload', uploadId, conversationId, name: input.name, byteLength: input.byteLength, contentHash: input.contentHash, status: 'pending' }
      this.db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?,?,?)').run(uploadId, this.actor.actorId, this.actor.workspaceId, conversationId, requestHash, value.byteLength, JSON.stringify(value))
      this.db.exec('COMMIT'); return value
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause }
  }
  get(conversationId: string, id: string): UploadReceipt {
    this.requireOpen()
    const row = this.db.prepare('SELECT value,bytes FROM uploads WHERE id=? AND conversation=? AND actor=? AND workspace=?').get(id, conversationId, this.actor.actorId, this.actor.workspaceId)
    if (!row || typeof row.value !== 'string' || row.value.length > 8192) return error('not-found', 'Upload is not accessible')
    const value = parseContract('document-http', JSON.parse(row.value))
    if (value.kind !== 'upload' || value.uploadId !== id || value.conversationId !== conversationId || value.byteLength !== row.bytes) return error('invalid-request', 'Upload record integrity failed')
    return value
  }
  async put(conversationId: string, id: string, input: Readable, authorize: () => void, signal?: AbortSignal): Promise<UploadReceipt> {
    this.requireOpen(); authorize()
    if (this.active.size >= 2 || this.active.has(id)) return error('limit-exceeded', 'Upload transfer capacity reached')
    const value = this.get(conversationId, id), controller = new AbortController()
    const lifetime = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
    const done = this.write(value, input, authorize, lifetime)
    this.active.set(id, { controller, done })
    try { return await done } finally { this.active.delete(id) }
  }
  async materialize(candidateId: string, conversationId: string, workspaceId: string): Promise<MaterializedLibraryCandidate> {
    if (workspaceId !== this.actor.workspaceId) return error('not-found', 'Upload workspace is not accessible')
    const value = this.get(conversationId, candidateId)
    if (value.status !== 'stored') return error('stale', 'Upload bytes are not committed')
    await this.verify(value)
    return { candidateId, rootId: 'uploads', relativePath: `${value.contentHash}.pdf`, displayName: value.name, mediaType: 'application/pdf', byteLength: value.byteLength, contentHash: value.contentHash }
  }
  async discover(_request: LibraryDiscoverRequest): Promise<LibraryDiscoverResult> { return error('invalid-request', 'Use explicit authenticated upload tickets') }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const job of this.active.values()) job.controller.abort()
    await Promise.allSettled([...this.active.values()].map(job => job.done)); this.db.close()
  }
  private async write(value: UploadReceipt, input: Readable, authorize: () => void, signal: AbortSignal): Promise<UploadReceipt> {
    signal.throwIfAborted()
    // Exclusive, bounded staging identity across processes too. After abrupt death an orphan is fenced,
    // not deleted on a TTL guess while another writer might still own it.
    const temporary = join(this.filesRoot, `.upload-${digest(value.uploadId)}.part`)
    const handle = await open(temporary, 'wx', 0o600), hash = createHash('sha256')
    const abort = () => input.destroy(new Error('Upload interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    let size = 0, header = Buffer.alloc(0)
    try {
      for await (const chunk of input) {
        signal.throwIfAborted(); authorize()
        const bytes = Buffer.from(chunk); size += bytes.length
        if (size > value.byteLength) error('limit-exceeded', 'Upload exceeds reserved bytes')
        if (header.length < 5) header = Buffer.concat([header, bytes.subarray(0, 5 - header.length)])
        hash.update(bytes)
        let offset = 0
        while (offset < bytes.length) { const written = await handle.write(bytes, offset, bytes.length - offset); if (!written.bytesWritten) throw new Error('Upload write stalled'); offset += written.bytesWritten }
      }
      if (size !== value.byteLength || hash.digest('hex') !== value.contentHash || header.toString('ascii') !== '%PDF-') error('invalid-request', 'Upload does not match the declared PDF bytes')
      signal.throwIfAborted(); authorize(); await handle.chmod(0o400); await handle.sync()
      try { await link(temporary, join(this.filesRoot, `${value.contentHash}.pdf`)) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; await this.verify(value) }
      const directory = await open(this.filesRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
      signal.throwIfAborted(); authorize()
      const stored = { ...value, status: 'stored' as const }
      this.db.prepare('UPDATE uploads SET value=? WHERE id=? AND actor=? AND workspace=?').run(JSON.stringify(stored), value.uploadId, this.actor.actorId, this.actor.workspaceId)
      return stored
    } finally { signal.removeEventListener('abort', abort); await handle.close(); await unlink(temporary).catch(() => {}) }
  }
  private async verify(value: UploadReceipt): Promise<void> {
    const handle = await open(join(this.filesRoot, `${value.contentHash}.pdf`), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size !== BigInt(value.byteLength)) error('stale', 'Stored upload bytes changed')
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      const after = await handle.stat({ bigint: true })
      if (after.mtimeNs !== before.mtimeNs || after.size !== before.size || hash.digest('hex') !== value.contentHash) error('stale', 'Stored upload integrity failed')
    } finally { await handle.close() }
  }
  private requireOpen(): void { if (this.closed) error('invalid-request', 'Upload service is closed') }
}
