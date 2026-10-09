import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { enrichmentIssues, type EnrichmentStart, type EnrichmentJob, type ProductBinding } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { canonicalEnrichment, enrichmentHash } from '@docatlas/core'
import { dedicatedDirectory } from './runtime-catalog.js'
import { ControlStoreError } from './control-store.js'

function fail(code: ConstructorParameters<typeof ControlStoreError>[0], message: string): never { throw new ControlStoreError(code, message) }
export class EnrichmentJobs {
  private readonly db: DatabaseSync
  constructor(readonly root: string) {
    dedicatedDirectory(root); const file = join(root, 'enrichments.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) fail('integrity-error', 'Invalid enrichment database path')
    this.db = new DatabaseSync(file)
    try {
      const app = Number(this.db.prepare('PRAGMA application_id').get()!.application_id), version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version), count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n)
      if (!(app === 0x4441454a && version === 1) && !(app === 0 && version === 0 && count === 0)) fail('integrity-error', 'Unknown enrichment database')
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('integrity-error', 'Enrichment database integrity failed')
      chmodSync(file, 0o600); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      if (!version) this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE jobs(id TEXT PRIMARY KEY,binding TEXT NOT NULL,actor TEXT NOT NULL,workspace TEXT NOT NULL,state TEXT NOT NULL,request_hash TEXT NOT NULL,value_hash TEXT NOT NULL,value TEXT NOT NULL,owner TEXT,input_hash TEXT); PRAGMA application_id=${0x4441454a}; PRAGMA user_version=1; COMMIT;`)
      this.db.prepare('SELECT id,binding,actor,workspace,state,request_hash,value_hash,value,owner,input_hash FROM jobs LIMIT 0').all()
    } catch (error) { this.db.close(); throw error }
  }
  accept(binding: ProductBinding, request: EnrichmentStart): EnrichmentJob {
    const parsed = parseContract('enrichment', request)
    if (parsed.kind !== 'enrichment-start' || enrichmentIssues(parsed).length) fail('invalid-request', 'Invalid enrichment request')
    const id = `job:enrichment:${enrichmentHash([binding.ownerActorId, binding.workspaceId, binding.bindingId, request.idempotencyKey]).slice(0, 32)}`
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT request_hash FROM jobs WHERE id=?').get(id)
      if (previous) { if (previous.request_hash !== enrichmentHash(request)) fail('conflict', 'Enrichment key already identifies a different request'); return this.get(binding, id) }
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE actor=? AND workspace=?').get(binding.ownerActorId, binding.workspaceId)!.n) >= 256) fail('limit-exceeded', 'Enrichment retention capacity reached')
      const now = new Date().toISOString(), value: EnrichmentJob = { schemaVersion: 1, kind: 'enrichment-job', jobId: id, conversationId: binding.conversationId, bindingId: binding.bindingId, runtimeSessionId: binding.runtimeSessionId, generation: binding.generation,
        actorId: binding.ownerActorId, workspaceId: binding.workspaceId, request: structuredClone(request), state: 'queued', createdAt: now, updatedAt: now, result: null, error: null }
      this.validate(value)
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,NULL,NULL)').run(id, binding.bindingId, binding.ownerActorId, binding.workspaceId, value.state, enrichmentHash(request), enrichmentHash(value), canonicalEnrichment(value))
      return value
    })
  }
  get(binding: ProductBinding, id: string): EnrichmentJob {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=? AND binding=? AND actor=? AND workspace=?').get(id, binding.bindingId, binding.ownerActorId, binding.workspaceId)
    if (!row) fail('not-found', 'Enrichment job is not accessible')
    if (typeof row.value !== 'string' || row.value.length > 524288) fail('integrity-error', 'Invalid enrichment record size')
    const value = this.validate(JSON.parse(row.value))
    if (value.jobId !== id || value.bindingId !== binding.bindingId || value.runtimeSessionId !== binding.runtimeSessionId || value.generation !== binding.generation || value.conversationId !== binding.conversationId
      || value.actorId !== binding.ownerActorId || value.workspaceId !== binding.workspaceId || enrichmentHash(value) !== row.value_hash || enrichmentHash(value.request) !== row.request_hash || value.state !== row.state) fail('integrity-error', 'Enrichment record identity changed')
    if (value.result && value.result.inputHash !== row.input_hash) fail('integrity-error', 'Enrichment input binding changed')
    return value
  }
  /** Bounded, owner-bound enumeration; every payload still passes the sealed get path. */
  *completed(binding: ProductBinding): Iterable<EnrichmentJob> {
    const rows = this.db.prepare('SELECT id FROM jobs WHERE binding=? AND actor=? AND workspace=? AND state=? ORDER BY id LIMIT 257').all(binding.bindingId, binding.ownerActorId, binding.workspaceId, 'completed')
    if (rows.length > 256) fail('integrity-error', 'Enrichment retention bound changed')
    for (const row of rows) {
      if (typeof row.id !== 'string') fail('integrity-error', 'Invalid enrichment identifier')
      yield this.get(binding, row.id as string)
    }
  }
  claim(binding: ProductBinding, id: string): { job: EnrichmentJob, token: string } {
    return this.transaction(() => {
      const job = this.get(binding, id)
      if (job.state !== 'queued') fail('recovery-required', 'Job already has an owner or terminal result; no automatic replay')
      const active = this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE actor=? AND workspace=? AND owner IS NOT NULL').get(binding.ownerActorId, binding.workspaceId)!
      if (Number(active.n) >= 2) fail('limit-exceeded', 'Two enrichment jobs already own execution slots')
      const token = randomUUID(); job.state = 'preparing'; this.write(job)
      this.db.prepare('UPDATE jobs SET owner=? WHERE id=?').run(enrichmentHash(token), id)
      return { job, token }
    })
  }
  generating(binding: ProductBinding, id: string, token: string, inputHash: string): void {
    this.transaction(() => {
      const job = this.owned(binding, id, token)
      if (job.state !== 'preparing' || !/^[a-f0-9]{64}$/.test(inputHash)) fail('conflict', 'Invalid generating transition')
      job.state = 'generating'; this.write(job); this.db.prepare('UPDATE jobs SET input_hash=? WHERE id=?').run(inputHash, id)
    })
  }
  finish(binding: ProductBinding, id: string, token: string, state: 'completed' | 'failed' | 'cancelled', result: EnrichmentJob['result'], error: EnrichmentJob['error']): EnrichmentJob {
    return this.transaction(() => {
      const job = this.owned(binding, id, token)
      if (!['preparing', 'generating'].includes(job.state) || state === 'completed' && (job.state !== 'generating' || !result)) fail('conflict', 'Invalid enrichment completion')
      if (result && this.db.prepare('SELECT input_hash FROM jobs WHERE id=?').get(id)!.input_hash !== result.inputHash) fail('integrity-error', 'Completion does not match the prepared input')
      job.state = state; job.result = result; job.error = error; this.write(job)
      this.db.prepare('UPDATE jobs SET owner=NULL WHERE id=?').run(id)
      return job
    })
  }
  cancelQueued(binding: ProductBinding, id: string): EnrichmentJob {
    return this.transaction(() => { const job = this.get(binding, id); if (job.state !== 'queued') fail('recovery-required', 'Cannot cancel an unowned live claim'); job.state = 'cancelled'; this.write(job); return job })
  }
  assertOwner(binding: ProductBinding, id: string, token: string): void { this.owned(binding, id, token) }
  close(): void { this.db.close() }
  private owned(binding: ProductBinding, id: string, token: string): EnrichmentJob {
    const value = this.get(binding, id)
    if (this.db.prepare('SELECT owner FROM jobs WHERE id=?').get(id)!.owner !== enrichmentHash(token)) fail('stale-writer', 'Enrichment execution claim does not match')
    return value
  }
  private validate(candidate: unknown): EnrichmentJob {
    const value = parseContract('enrichment', candidate)
    if (value.kind !== 'enrichment-job' || enrichmentIssues(value).length || Buffer.byteLength(canonicalEnrichment(value)) > 524288) return fail('integrity-error', 'Invalid enrichment job')
    if (value.result) { const { resultHash, ...unsigned } = value.result; if (resultHash !== enrichmentHash(unsigned)) fail('integrity-error', 'Enrichment result hash changed') }
    return value
  }
  private write(job: EnrichmentJob): void { job.updatedAt = new Date().toISOString(); this.validate(job); this.db.prepare('UPDATE jobs SET state=?,value_hash=?,value=? WHERE id=?').run(job.state, enrichmentHash(job), canonicalEnrichment(job), job.jobId) }
  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = work(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error } }
}
