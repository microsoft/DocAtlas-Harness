import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { selectionTicketValid, type ProductBinding, type ProductSelectionStage, type ProductSelectionTicket, type VerifiedSelectionItem, type ProductSubmission, type ProductRunReceipt } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { ControlStoreError } from './control-store.js'
import { dedicatedDirectory } from './runtime-catalog.js'

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}` : JSON.stringify(value)
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const fail = (code: ConstructorParameters<typeof ControlStoreError>[0], message: string): never => { throw new ControlStoreError(code, message) }
type Row = Record<string, SQLInputValue>
/** Private expiring input tickets, not canonical Evidence or native history. */
export class SelectionTickets {
  private readonly db: DatabaseSync
  constructor(root: string, private readonly now: () => number = Date.now) {
    dedicatedDirectory(root)
    const file = join(root, 'selection-tickets.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) fail('integrity-error', 'Invalid selection database path')
    this.db = new DatabaseSync(file)
    try {
      const application = Number(this.db.prepare('PRAGMA application_id').get()!.application_id), version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n)
      if (!(application === 0x44415354 && version === 1) && !(application === 0 && version === 0 && count === 0)) fail('integrity-error', 'Unknown selection database; no automatic migration')
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('integrity-error', 'Invalid selection database')
      chmodSync(file, 0o600); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      if (!version) this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE tickets(id TEXT PRIMARY KEY, binding TEXT NOT NULL, actor TEXT NOT NULL, workspace TEXT NOT NULL, stage_hash TEXT NOT NULL, value_hash TEXT NOT NULL, value TEXT NOT NULL); PRAGMA application_id=${0x44415354}; PRAGMA user_version=1; COMMIT;`)
      this.db.prepare('SELECT id,binding,actor,workspace,stage_hash,value_hash,value FROM tickets LIMIT 0').all()
    } catch (error) { this.db.close(); throw error }
  }
  existing(binding: ProductBinding, request: ProductSelectionStage): ProductSelectionTicket | undefined {
    const id = this.id(binding, request.idempotencyKey), row = this.row(id)
    if (!row) return undefined
    if (row.stage_hash !== hash(request)) fail('conflict', 'Selection key was already used with different text')
    return this.get(binding, id)
  }
  stage(binding: ProductBinding, request: ProductSelectionStage, items: VerifiedSelectionItem[]): ProductSelectionTicket {
    const parsed = parseContract('document-http', request)
    if (parsed.kind !== 'selection-stage' || items.length !== request.proposals.length || items.some((item, index) => {
      const proposal = request.proposals[index]!
      return item.locator.documentId !== proposal.documentId || item.locator.revisionId !== proposal.revisionId || item.locator.physicalPage !== proposal.physicalPage || item.text.replace(/\s+/gu, ' ').trim() !== proposal.quote.replace(/\s+/gu, ' ').trim()
    })) fail('invalid-request', 'Verified selection does not match the requested group')
    return this.transaction(() => {
      const prior = this.existing(binding, request); if (prior) return prior
      if (request.expectedGeneration !== binding.generation) fail('conflict', 'Selection binding changed')
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE actor=? AND workspace=?').get(binding.ownerActorId, binding.workspaceId)!
      if (Number(count.n) >= 1024) fail('limit-exceeded', 'Selection ticket capacity reached')
      const created = this.now(), value: ProductSelectionTicket = { schemaVersion: 1, kind: 'selection-ticket', selectionContextId: this.id(binding, request.idempotencyKey),
        conversationId: binding.conversationId, workspaceId: binding.workspaceId, actorId: binding.ownerActorId, bindingId: binding.bindingId, generation: binding.generation,
        state: 'staged', items, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 15 * 60_000).toISOString(), submissionId: null, requestHash: null }
      this.validate(value)
      this.db.prepare('INSERT INTO tickets VALUES(?,?,?,?,?,?,?)').run(value.selectionContextId, value.bindingId, value.actorId, value.workspaceId, hash(request), hash(value), canonical(value))
      return structuredClone(value)
    })
  }
  get(binding: ProductBinding, id: string): ProductSelectionTicket {
    const row = this.row(id)
    if (!row || row.actor !== binding.ownerActorId || row.workspace !== binding.workspaceId || row.binding !== binding.bindingId) fail('not-found', 'Selection ticket is not accessible in this binding')
    if (typeof row!.value !== 'string' || row!.value.length > 65536) fail('integrity-error', 'Selection record exceeds bounds')
    const value = this.validate(JSON.parse(row!.value as string))
    if (hash(value) !== row!.value_hash || value.selectionContextId !== id || value.bindingId !== binding.bindingId || value.generation !== binding.generation
      || value.actorId !== binding.ownerActorId || value.workspaceId !== binding.workspaceId || value.conversationId !== binding.conversationId) fail('integrity-error', 'Selection ticket identity changed')
    if (['staged', 'bound'].includes(value.state) && Date.parse(value.expiresAt) <= this.now()) value.state = 'expired'
    return value
  }
  cancel(binding: ProductBinding, id: string): ProductSelectionTicket {
    return this.transaction(() => { const value = this.get(binding, id); if (value.submissionId !== null) fail('conflict', 'Selection already belongs to a submission'); if (value.state !== 'expired') { value.state = 'cancelled'; this.write(value) }; return value })
  }
  bind(binding: ProductBinding, request: ProductSubmission, receipt: ProductRunReceipt): ProductSelectionTicket[] {
    return this.transition(binding, request, receipt, false)
  }
  consume(binding: ProductBinding, request: ProductSubmission, receipt: ProductRunReceipt): void { this.transition(binding, request, receipt, true) }
  close(): void { this.db.close() }
  private transition(binding: ProductBinding, request: ProductSubmission, receipt: ProductRunReceipt, consume: boolean): ProductSelectionTicket[] {
    return this.transaction(() => {
      if (request.conversationId !== binding.conversationId || request.expectedGeneration !== binding.generation || receipt.conversationId !== binding.conversationId || receipt.generation !== binding.generation || receipt.requestHash !== hash(request)) fail('conflict', 'Selection submission identity mismatch')
      const ids = request.selectionContextIds
      if (ids.length > 8 || new Set(ids).size !== ids.length) fail('invalid-request', 'Invalid selection group')
      const values = ids.map(id => this.get(binding, id))
      if (values.flatMap(value => value.items).reduce((sum, item) => sum + [...item.text].length, 0) > 8000) fail('limit-exceeded', 'Selected text exceeds prompt budget')
      for (const value of values) {
        if (consume ? !['bound', 'consumed'].includes(value.state) : !['staged', 'bound'].includes(value.state)) fail('conflict', 'Selection ticket is expired, cancelled or consumed')
        if (value.submissionId !== null && (value.submissionId !== receipt.submissionId || value.requestHash !== receipt.requestHash)) fail('conflict', 'One-shot selection belongs to another submission')
        if (value.items.some(item => !request.sourceRefs.some(ref => ref.documentId === item.locator.documentId && ref.revisionId === item.locator.revisionId))) fail('permission-denied', 'Every selected source must be explicitly admitted')
      }
      for (const value of values) { value.state = consume ? 'consumed' : 'bound'; value.submissionId = receipt.submissionId; value.requestHash = receipt.requestHash; this.write(value) }
      return values
    })
  }
  private id(binding: ProductBinding, key: string): string { return `selection:${hash([binding.ownerActorId, binding.workspaceId, binding.bindingId, key])}` }
  private row(id: string): Row | undefined { return this.db.prepare('SELECT * FROM tickets WHERE id=?').get(id) }
  private validate(candidate: unknown): ProductSelectionTicket {
    const value = parseContract('document-http', candidate)
    if (value.kind !== 'selection-ticket' || !selectionTicketValid(value)) return fail('integrity-error', 'Invalid verified selection ticket')
    for (const item of value.items) if (!item.locator.selectors.some(selector => selector.type === 'text-quote' && selector.normalizedHash === createHash('sha256').update(item.text).digest('hex'))) fail('integrity-error', 'Selection content hash changed')
    if (Buffer.byteLength(canonical(value)) > 65536) fail('limit-exceeded', 'Selection context exceeds storage budget')
    return value
  }
  private write(value: ProductSelectionTicket): void { this.validate(value); this.db.prepare('UPDATE tickets SET value_hash=?,value=? WHERE id=?').run(hash(value), canonical(value), value.selectionContextId) }
  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = work(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error } }
}
