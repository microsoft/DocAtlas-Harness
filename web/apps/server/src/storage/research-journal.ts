import { chmodSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { enrichmentHash } from '@docatlas/core'
import { parseContract } from '@docatlas/contracts/node'
import type { ProductBinding, ResearchCallProvenance, ResearchPolicySet, ResearchSessionPolicy } from '@docatlas/contracts'
import { dedicatedDirectory } from './runtime-catalog.js'
import { ControlStoreError, type ProductActor } from './control-store.js'

const fail = (code: ConstructorParameters<typeof ControlStoreError>[0], message: string): never => { throw new ControlStoreError(code, message) }
const owner = (binding: ProductBinding): ProductActor => ({ actorId: binding.ownerActorId, workspaceId: binding.workspaceId })
const keyFor = (binding: ProductBinding) => enrichmentHash([binding.ownerActorId, binding.workspaceId, binding.conversationId])

/** Private product attribution and consent. Research content stays in the Core Investigation journal. */
export class ResearchJournal {
  private readonly db: DatabaseSync
  constructor(root: string) {
    dedicatedDirectory(root); const file = join(root, 'research-control.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) fail('integrity-error', 'Invalid research control path')
    this.db = new DatabaseSync(file)
    try {
      const app = Number(this.db.prepare('PRAGMA application_id').get()!.application_id), version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n)
      if (!(app === 0x44415243 && version === 1) && !(app === 0 && version === 0 && count === 0)) fail('integrity-error', 'Unknown research control database')
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('integrity-error', 'Invalid research control database')
      chmodSync(file, 0o600); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      if (!version) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE calls(id TEXT PRIMARY KEY,actor TEXT NOT NULL,workspace TEXT NOT NULL,record TEXT,body TEXT NOT NULL,seal TEXT NOT NULL);
        CREATE UNIQUE INDEX calls_record ON calls(record) WHERE record IS NOT NULL;
        CREATE TABLE policies(id TEXT PRIMARY KEY,body TEXT NOT NULL,seal TEXT NOT NULL);
        CREATE TABLE policy_commands(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,body TEXT NOT NULL,seal TEXT NOT NULL);
        PRAGMA application_id=${0x44415243}; PRAGMA user_version=1; COMMIT;`)
      this.db.prepare('SELECT id,actor,workspace,record,body,seal FROM calls LIMIT 0').all()
      this.db.prepare('SELECT id,body,seal FROM policies LIMIT 0').all()
      this.db.prepare('SELECT id,request_hash,body,seal FROM policy_commands LIMIT 0').all()
    } catch (error) { this.db.close(); throw error }
  }
  begin(binding: ProductBinding, candidate: ResearchCallProvenance): ResearchCallProvenance {
    const value = this.validateCall(candidate)
    if (value.actorId !== binding.ownerActorId || value.workspaceId !== binding.workspaceId || value.bindingId !== binding.bindingId || value.generation !== binding.generation
      || value.conversationId !== binding.conversationId || value.runtimeSessionId !== binding.runtimeSessionId || value.recordId !== null) fail('permission-denied', 'Research call does not belong to its host binding')
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM calls WHERE id=?').get(value.idempotencyKey)
      if (row) {
        const prior = this.callRow(owner(binding), row)
        if (enrichmentHash({ ...prior, recordId: null }) !== enrichmentHash(value)) fail('conflict', 'Native research call identity was reused with different input')
        return prior
      }
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM calls').get()!.n) >= 10000) fail('limit-exceeded', 'Research call retention limit reached')
      this.db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?)').run(value.idempotencyKey, value.actorId, value.workspaceId, null, JSON.stringify(value), enrichmentHash(value))
      return structuredClone(value)
    })
  }
  complete(binding: ProductBinding, pending: ResearchCallProvenance, recordId: string): void {
    const value = this.validateCall({ ...pending, recordId })
    if (value.actorId !== binding.ownerActorId || value.workspaceId !== binding.workspaceId || value.bindingId !== binding.bindingId || value.generation !== binding.generation
      || value.conversationId !== binding.conversationId || value.runtimeSessionId !== binding.runtimeSessionId) fail('permission-denied', 'Research completion changed its host binding')
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM calls WHERE id=?').get(value.idempotencyKey)
      if (!row) fail('integrity-error', 'Research call has no durable provenance')
      const previous = this.callRow(owner(binding), row!)
      if (enrichmentHash({ ...previous, recordId: null }) !== enrichmentHash({ ...value, recordId: null }) || previous.recordId !== null && previous.recordId !== recordId) fail('conflict', 'Research publication changed its lineage')
      this.db.prepare('UPDATE calls SET record=?,body=?,seal=? WHERE id=?').run(recordId, JSON.stringify(value), enrichmentHash(value), value.idempotencyKey)
    })
  }
  forRecord(actor: ProductActor, recordId: string): ResearchCallProvenance | undefined {
    const row = this.db.prepare('SELECT * FROM calls WHERE actor=? AND workspace=? AND record=?').get(actor.actorId, actor.workspaceId, recordId)
    return row ? this.callRow(actor, row) : undefined
  }
  policy(binding: ProductBinding): ResearchSessionPolicy {
    const row = this.db.prepare('SELECT * FROM policies WHERE id=?').get(keyFor(binding))
    if (!row) return { schemaVersion: 1, kind: 'research-session-policy', conversationId: binding.conversationId, version: 0, recallPriorResearch: true, contributeResearchState: true }
    return this.policyRow(binding, row)
  }
  setPolicy(binding: ProductBinding, input: ResearchPolicySet): ResearchSessionPolicy {
    parseContract('product-research', input)
    if (input.kind !== 'research-policy-set' || input.expectedGeneration !== binding.generation) fail('conflict', 'Research policy generation changed')
    return this.transaction(() => {
      const id = enrichmentHash([keyFor(binding), input.idempotencyKey]), row = this.db.prepare('SELECT * FROM policy_commands WHERE id=?').get(id), requestHash = enrichmentHash(input)
      if (row) { const value = this.policyRow(binding, row); if (row.request_hash !== requestHash) fail('conflict', 'Research policy key was reused'); return value }
      const current = this.policy(binding)
      if (current.version !== input.expectedVersion) fail('conflict', 'Research policy changed; refresh before editing')
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM policy_commands').get()!.n) >= 10000) fail('limit-exceeded', 'Research policy retention limit reached')
      const value: ResearchSessionPolicy = { ...current, version: current.version + 1, recallPriorResearch: input.recallPriorResearch, contributeResearchState: input.contributeResearchState }
      const text = JSON.stringify(value), seal = enrichmentHash(value)
      this.db.prepare('INSERT INTO policies VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,seal=excluded.seal').run(keyFor(binding), text, seal)
      this.db.prepare('INSERT INTO policy_commands VALUES(?,?,?,?)').run(id, requestHash, text, seal)
      return value
    })
  }
  close(): void { this.db.close() }
  private validateCall(candidate: unknown): ResearchCallProvenance {
    const value = parseContract('product-research', candidate)
    if (value.kind !== 'research-call-provenance') return fail('integrity-error', 'Invalid private research provenance')
    return value
  }
  private callRow(actor: ProductActor, row: Record<string, unknown>): ResearchCallProvenance {
    if (typeof row.body !== 'string' || row.body.length > 8192) fail('integrity-error', 'Research call exceeds bounds')
    const value = this.validateCall(JSON.parse(row.body as string))
    if (enrichmentHash(value) !== row.seal || value.idempotencyKey !== row.id || value.recordId !== row.record || row.actor !== actor.actorId || row.workspace !== actor.workspaceId
      || value.actorId !== actor.actorId || value.workspaceId !== actor.workspaceId) fail('integrity-error', 'Research call seal or owner changed')
    return value
  }
  private policyRow(binding: ProductBinding, row: Record<string, unknown>): ResearchSessionPolicy {
    if (typeof row.body !== 'string' || row.body.length > 4096) fail('integrity-error', 'Research policy exceeds bounds')
    const value = parseContract('product-research', JSON.parse(row.body as string))
    if (value.kind !== 'research-session-policy' || value.conversationId !== binding.conversationId || enrichmentHash(value) !== row.seal) return fail('integrity-error', 'Research policy identity changed')
    return value
  }
  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = work(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error } }
}
