import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readResultIssues, productControlIssues, type ProductBinding, type ProductPiCheckpoint, type ReadResult } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { DocumentInvocation } from '@docatlas/core'
import type { CheckpointReadAttestation } from '@docatlas/runtime-pi'
import { dedicatedDirectory } from './runtime-catalog.js'
import { ControlStoreError } from './control-store.js'

interface Owner { bindingId: string, conversationId: string, workspaceId: string, actorId: string, runtimeSessionId: string, generation: number }
interface SavedRead extends Owner { schemaVersion: 1, kind: 'answer-read', submissionId: string, callId: string, scopeVersionId: string, result: ReadResult }
export interface AnswerPublication extends Owner { schemaVersion: 1, kind: 'answer-publication', messageId: string, manifestId: string, manifestHash: string, nativeTextHash: string, scopeVersionId: string, checkpoint: ProductPiCheckpoint }
export const answerHash = (value: string): string => createHash('sha256').update(value).digest('hex')
const owner = (binding: ProductBinding): Owner => ({ bindingId: binding.bindingId, conversationId: binding.conversationId, workspaceId: binding.workspaceId, actorId: binding.ownerActorId, runtimeSessionId: binding.runtimeSessionId, generation: binding.generation })
const invalid = (message: string): never => { throw new ControlStoreError('integrity-error', message) }
const exactKeys = (value: object, keys: string) => Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const ownerKeys = 'bindingId,conversationId,workspaceId,actorId,runtimeSessionId,generation'

/** Host-owned Read attestations and publication links; canonical manifests stay in SourceScopeStore. */
export class AnswerReceipts {
  private readonly db: DatabaseSync
  constructor(readonly root: string) {
    dedicatedDirectory(root); const file = join(root, 'answers.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) invalid('Invalid answer database path')
    this.db = new DatabaseSync(file)
    try {
      const app = Number(this.db.prepare('PRAGMA application_id').get()!.application_id), version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n)
      if (!(app === 0x44414152 && version === 1) && !(app === 0 && version === 0 && count === 0)) invalid('Unknown answer database')
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') invalid('Answer database integrity failed')
      chmodSync(file, 0o600); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      if (!version) this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE records(binding TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,submission TEXT NOT NULL,body TEXT NOT NULL,seal TEXT NOT NULL,PRIMARY KEY(binding,kind,id)); PRAGMA application_id=${0x44414152}; PRAGMA user_version=1; COMMIT;`)
      this.db.prepare('SELECT binding,kind,id,submission,body,seal FROM records LIMIT 0').all()
    } catch (error) { this.db.close(); throw error }
  }
  recordRead(binding: ProductBinding, active: DocumentInvocation, callId: string, result: ReadResult): void {
    active.assertCurrent()
    if (active.scope.scope.workspaceId !== binding.workspaceId) invalid('Read workspace does not match its owner')
    if (!callId || callId.length > 256 || result.mode === 'locate') invalid('Invalid Read attestation call')
    const source = active.source(result.source.documentId, result.source.revisionId)
    if (result.source.representationId !== source.representationId || result.items.some(item => item.locator.representationContentHash !== source.representationContentHash)) invalid('Read source changed')
    const value: SavedRead = { schemaVersion: 1, kind: 'answer-read', ...owner(binding), submissionId: active.submissionId, callId, scopeVersionId: active.scope.scope.scopeVersionId, result }
    this.put(binding, value, JSON.stringify([active.submissionId, callId]), active.submissionId); active.assertCurrent()
  }
  reads(binding: ProductBinding, submissionId: string, scopeVersionId: string): CheckpointReadAttestation[] {
    const rows = this.db.prepare('SELECT * FROM records WHERE binding=? AND kind=? AND submission=? ORDER BY id LIMIT 257').all(binding.bindingId, 'answer-read', submissionId)
    if (rows.length > 256) invalid('Read attestation count changed')
    return rows.map(row => {
      const value = this.row(binding, row)
      if (value.kind !== 'answer-read' || value.submissionId !== submissionId || value.scopeVersionId !== scopeVersionId || row.id !== JSON.stringify([submissionId, value.callId])) invalid('Read execution binding changed')
      const read = value as SavedRead
      return { callId: read.callId, scopeVersionId: read.scopeVersionId, locators: read.result.items.map(item => item.locator), result: read.result }
    })
  }
  publish(binding: ProductBinding, value: Omit<AnswerPublication, keyof Owner | 'schemaVersion' | 'kind'>): void {
    this.put(binding, { schemaVersion: 1, kind: 'answer-publication', ...owner(binding), ...value }, value.messageId, value.checkpoint.submissionId)
  }
  publication(binding: ProductBinding, messageId: string): AnswerPublication | undefined {
    const row = this.db.prepare('SELECT * FROM records WHERE binding=? AND kind=? AND id=?').get(binding.bindingId, 'answer-publication', messageId)
    if (!row) return undefined
    const value = this.row(binding, row)
    if (value.kind !== 'answer-publication' || value.messageId !== messageId || row.submission !== value.checkpoint.submissionId) invalid('Answer publication identity changed')
    return value as AnswerPublication
  }
  close(): void { this.db.close() }
  private row(binding: ProductBinding, row: Record<string, unknown>): SavedRead | AnswerPublication {
    if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 262144 || answerHash(row.body) !== row.seal || row.binding !== binding.bindingId) invalid('Answer record seal changed')
    const value = this.validate(binding, JSON.parse(row.body as string))
    if (row.kind !== value.kind) invalid('Answer record kind changed')
    return value
  }
  private validate(binding: ProductBinding, value: unknown): SavedRead | AnswerPublication {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid answer record')
    const record = value as SavedRead | AnswerPublication
    if (record.schemaVersion !== 1 || Object.entries(owner(binding)).some(([key, expected]) => Reflect.get(record, key) !== expected) || typeof record.scopeVersionId !== 'string' || !record.scopeVersionId) invalid('Answer owner changed')
    if (record.kind === 'answer-read') {
      if (!exactKeys(record, `${ownerKeys},schemaVersion,kind,submissionId,callId,scopeVersionId,result`) || typeof record.submissionId !== 'string' || !record.submissionId || typeof record.callId !== 'string' || !record.callId || record.callId.length > 256) invalid('Invalid Read record')
      const result = parseContract('sidecar-document-rpc', record.result)
      if (!('resultType' in result) || result.resultType !== 'read' || result.mode === 'locate' || readResultIssues(result).length) invalid('Invalid attested Read')
    } else if (record.kind === 'answer-publication') {
      if (!exactKeys(record, `${ownerKeys},schemaVersion,kind,messageId,manifestId,manifestHash,nativeTextHash,scopeVersionId,checkpoint`)
        || typeof record.messageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(record.messageId)
        || typeof record.manifestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(record.manifestId)
        || typeof record.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.manifestHash) || typeof record.nativeTextHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.nativeTextHash)) invalid('Invalid publication record')
      const checkpoint = parseContract('product-control', record.checkpoint)
      if (checkpoint.kind !== 'pi-checkpoint' || checkpoint.runtimeSessionId !== binding.runtimeSessionId || productControlIssues(checkpoint).length) invalid('Invalid publication checkpoint')
    } else invalid('Unknown answer record')
    return record
  }
  private put(binding: ProductBinding, candidate: SavedRead | AnswerPublication, id: string, submission: string): void {
    const value = this.validate(binding, candidate), body = JSON.stringify(value)
    if (Buffer.byteLength(body) > 262144) throw new ControlStoreError('limit-exceeded', 'Answer record exceeds budget')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT * FROM records WHERE binding=? AND kind=? AND id=?').get(binding.bindingId, value.kind, id)
      if (previous) { this.row(binding, previous); if (previous.body !== body || previous.submission !== submission) throw new ControlStoreError('conflict', 'Immutable answer identity already has another value') }
      else {
        const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM records').get()!.n), perRun = Number(this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE binding=? AND kind=? AND submission=?').get(binding.bindingId, value.kind, submission)!.n)
        if (total >= 8192 || perRun >= 256) throw new ControlStoreError('limit-exceeded', 'Answer retention budget reached')
        this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(binding.bindingId, value.kind, id, submission, body, answerHash(body))
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
