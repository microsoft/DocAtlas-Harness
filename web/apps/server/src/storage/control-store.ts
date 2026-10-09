import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  productControlIssues, type ProductBinding, type ProductControlValue, type ProductPiCheckpoint,
  type ProductPreparedSubmission, type ProductRunError, type ProductRunReceipt, type ProductRunState, type ProductSubmission,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

const APPLICATION_ID = 0x44415443
const TERMINAL = new Set<ProductRunState>(['completed', 'failed', 'cancelled'])
const DISPATCHED = new Set<ProductRunState>(['dispatching', 'running', 'cancelling'])
type Row = Record<string, SQLInputValue>
export interface ProductActor { actorId: string, workspaceId: string }
export interface WriterLease {
  conversationId: string
  generation: number
  epoch: number
  workerId: string
  /** Process-local capability. Only its hash is persisted; never a browser field. */
  token: string
  expiresAt: number
}
export class ControlStoreError extends Error {
  constructor(readonly code: 'invalid-request' | 'not-found' | 'conflict' | 'permission-denied' | 'stale-writer' | 'recovery-required' | 'limit-exceeded' | 'integrity-error', message: string) {
    super(message); this.name = 'ControlStoreError'
  }
}

/** Trusted application API. Actor values come from auth, never from a submitted JSON body. */
export class ControlStore {
  private closed = false
  private constructor(private readonly db: DatabaseSync, private readonly clock: () => number, readonly storageRoot: string) {}

  static open(root: string, clock: () => number = Date.now): ControlStore {
    if (!isAbsolute(root) || resolve(root) !== root || root === '/' || root === homedir() || root === process.cwd()) fail('invalid-request', 'Use a dedicated absolute private control directory')
    let ancestor = root
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) fail('invalid-request', 'Control storage cannot traverse symlinks')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) fail('invalid-request', 'Control root must be a real directory')
    const file = join(root, 'control.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) fail('invalid-request', 'Control files must be regular, non-symlink files')
    }
    const db = new DatabaseSync(file)
    try {
      const appId = Number((db.prepare('PRAGMA application_id').get() as Row).application_id)
      const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version)
      const count = Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as Row).n)
      if ((appId !== APPLICATION_ID || version !== 1) && !(appId === 0 && version === 0 && count === 0)) fail('integrity-error', 'Unknown control database identity/version; no automatic migration')
      if ((db.prepare('PRAGMA quick_check').get() as Row).quick_check !== 'ok') fail('integrity-error', 'Control database integrity check failed')
      chmodSync(root, 0o700); chmodSync(file, 0o600)
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      if (version === 0) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE bindings (conversation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
            generation INTEGER NOT NULL, version INTEGER NOT NULL, writer_epoch INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
          CREATE TABLE submissions (queue_seq INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE,
            conversation_id TEXT NOT NULL REFERENCES bindings(conversation_id), owner_actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
            payload TEXT, prepared TEXT, receipt TEXT NOT NULL, UNIQUE(conversation_id, owner_actor_id, idempotency_key));
          CREATE INDEX submission_queue ON submissions(conversation_id, queue_seq);
          CREATE TABLE writers (conversation_id TEXT PRIMARY KEY REFERENCES bindings(conversation_id), generation INTEGER NOT NULL,
            epoch INTEGER NOT NULL, worker_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
          CREATE TABLE checkpoint_bindings (runtime_session_id TEXT NOT NULL, user_entry_id TEXT NOT NULL,
            submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(submission_id), PRIMARY KEY(runtime_session_id,user_entry_id));
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`)
      }
      // Detect incomplete/tampered schema even if its numeric version looks familiar.
      db.prepare('SELECT conversation_id,workspace_id,owner_actor_id,generation,version,writer_epoch,data FROM bindings LIMIT 0').all()
      db.prepare('SELECT queue_seq,submission_id,run_id,conversation_id,owner_actor_id,idempotency_key,request_hash,generation,state,version,payload,prepared,receipt FROM submissions LIMIT 0').all()
      db.prepare('SELECT conversation_id,generation,epoch,worker_id,token_hash,expires_at FROM writers LIMIT 0').all()
      db.prepare('SELECT runtime_session_id,user_entry_id,submission_id FROM checkpoint_bindings LIMIT 0').all()
      return new ControlStore(db, clock, root)
    } catch (error) { db.close(); throw error }
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }

  createConversation(actor: ProductActor, input: { conversationId: string, runtimeSessionId: string, investigationId?: string | null }, maxPerActor = 1024): ProductBinding {
    if (!Number.isSafeInteger(maxPerActor) || maxPerActor < 1 || maxPerActor > 1024) fail('invalid-request', 'Invalid conversation capacity')
    const now = this.now()
    const binding = validate({ schemaVersion: 1, kind: 'binding', bindingId: `binding:${randomUUID()}`,
      conversationId: input.conversationId, workspaceId: actor.workspaceId, ownerActorId: actor.actorId,
      investigationId: input.investigationId ?? null, runtimeSessionId: input.runtimeSessionId, branchEntryId: null,
      generation: 1, version: 1, createdAt: now, updatedAt: now }, 'binding')
    return this.transaction(() => {
      if (this.getRow('SELECT * FROM bindings WHERE conversation_id=?', binding.conversationId)) fail('conflict', 'Conversation already exists')
      if (Number(this.getRow('SELECT COUNT(*) AS n FROM bindings WHERE owner_actor_id=? AND workspace_id=?', actor.actorId, actor.workspaceId)!.n) >= maxPerActor) fail('limit-exceeded', 'Conversation capacity reached')
      this.db.prepare('INSERT INTO bindings(conversation_id,workspace_id,owner_actor_id,generation,version,data) VALUES(?,?,?,?,?,?)')
        .run(binding.conversationId, binding.workspaceId, binding.ownerActorId, 1, 1, canonical(binding))
      return binding
    })
  }

  createManagedConversation(actor: ProductActor, key: string): { binding: ProductBinding, replayed: boolean } {
    validateId(key)
    if (key.length < 16) fail('invalid-request', 'Creation key is too short')
    const conversationId = `conversation:${hash(canonical([actor.actorId, actor.workspaceId, key]))}`
    try { return { binding: this.createConversation(actor, { conversationId, runtimeSessionId: randomUUID() }, 256), replayed: false } }
    catch (error) { if (error instanceof ControlStoreError && error.code === 'conflict') return { binding: this.binding(actor, conversationId), replayed: true }; throw error }
  }

  latestCheckpoint(actor: ProductActor, conversationId: string): ProductPiCheckpoint | undefined {
    const binding = this.binding(actor, conversationId)
    const row = this.getRow("SELECT * FROM submissions WHERE conversation_id=? AND generation=? AND state='completed' ORDER BY json_extract(receipt,'$.checkpoint.byteLength') DESC LIMIT 1", conversationId, binding.generation)
    return row ? this.receiptFromRow(row).checkpoint : undefined
  }

  /** Original human input for an entry already located in an independently verified native branch.
   * Never infer from prepared.modelText, text similarity or the current run. Unknown/foreign or
   * purged payloads stay unavailable; retained input still has to verify its complete request hash.
   */
  publicUserMessage(actor: ProductActor, conversationId: string, userEntryId: string): string | null {
    const binding = this.binding(actor, conversationId)
    validateId(userEntryId)
    const link = this.getRow('SELECT submission_id FROM checkpoint_bindings WHERE runtime_session_id=? AND user_entry_id=?', binding.runtimeSessionId, userEntryId)
    if (!link) return null
    const row = this.getRow('SELECT * FROM submissions WHERE submission_id=?', link.submission_id!)
    if (!row) fail('integrity-error', 'Native user entry lost its original submission')
    if (row.owner_actor_id !== actor.actorId || row.conversation_id !== conversationId) return null
    const receipt = this.receiptFromRow(row), checkpoint = receipt.checkpoint
    if (receipt.state !== 'completed' || !checkpoint || checkpoint.runtimeSessionId !== binding.runtimeSessionId
      || checkpoint.userEntryId !== userEntryId || receipt.generation > binding.generation) fail('integrity-error', 'Native user entry disagrees with its original completed checkpoint')
    if (row.payload === null) return null
    return this.inputFromRow(row).text
  }

  /** Host-only historical frame lookup. Callers must independently prove native lineage/entry membership. */
  publicUserMessageAt(actor: ProductActor, origin: Readonly<ProductBinding>, userEntryId: string): { text: string | null, submissionId: string } | null {
    const current = this.binding(actor, origin.conversationId)
    validateId(userEntryId)
    if (origin.ownerActorId !== actor.actorId || origin.workspaceId !== actor.workspaceId || origin.generation > current.generation) fail('not-found', 'Historical user frame is not accessible')
    const link = this.getRow('SELECT submission_id FROM checkpoint_bindings WHERE runtime_session_id=? AND user_entry_id=?', origin.runtimeSessionId, userEntryId)
    if (!link) return null
    const row = this.getRow('SELECT * FROM submissions WHERE submission_id=?', link.submission_id!)
    if (!row) fail('integrity-error', 'Historical native user lost its submission')
    if (row.owner_actor_id !== actor.actorId || row.conversation_id !== origin.conversationId || row.generation !== origin.generation) return null
    const receipt = this.receiptFromRow(row), checkpoint = receipt.checkpoint
    if (receipt.state !== 'completed' || !checkpoint || checkpoint.runtimeSessionId !== origin.runtimeSessionId || checkpoint.userEntryId !== userEntryId) fail('integrity-error', 'Historical native user association changed')
    return { text: row.payload === null ? null : this.inputFromRow(row).text, submissionId: receipt.submissionId }
  }

  /** Host-only lookup for a final message already proved to belong to this exact native frame. */
  publicLeafSubmissionAt(actor: ProductActor, origin: Readonly<ProductBinding>, entryId: string): string | null {
    const current = this.binding(actor, origin.conversationId)
    validateId(entryId)
    if (origin.ownerActorId !== actor.actorId || origin.workspaceId !== actor.workspaceId || origin.generation > current.generation) fail('not-found', 'Historical message frame is not accessible')
    const rows = this.db.prepare("SELECT * FROM submissions WHERE conversation_id=? AND generation=? AND state='completed' AND json_extract(receipt,'$.checkpoint.leafEntryId')=? LIMIT 2").all(origin.conversationId, origin.generation, entryId) as Row[]
    if (rows.length > 1) fail('integrity-error', 'Native leaf has multiple original submissions')
    const row = rows[0]
    if (!row) return null
    if (row.owner_actor_id !== actor.actorId) fail('not-found', 'Historical message owner changed')
    const receipt = this.receiptFromRow(row), checkpoint = receipt.checkpoint
    if (receipt.state !== 'completed' || !checkpoint || checkpoint.runtimeSessionId !== origin.runtimeSessionId || checkpoint.leafEntryId !== entryId) fail('integrity-error', 'Native leaf disagrees with its completed checkpoint')
    return receipt.submissionId
  }

  binding(actor: ProductActor, conversationId: string): ProductBinding {
    const row = this.getRow('SELECT * FROM bindings WHERE conversation_id=?', conversationId)
    if (!row || row.workspace_id !== actor.workspaceId || row.owner_actor_id !== actor.actorId) fail('not-found', 'Conversation is not accessible')
    const value = decode(row.data, 'binding')
    if (value.conversationId !== row.conversation_id || value.workspaceId !== row.workspace_id || value.ownerActorId !== row.owner_actor_id || value.generation !== row.generation || value.version !== row.version) fail('integrity-error', 'Binding columns disagree with its record')
    return value
  }

  /** Replacement requires no active/unknown submissions and no writer (stop/reconcile first). */
  rebind(actor: ProductActor, conversationId: string, expectedVersion: number, runtimeSessionId: string, branchEntryId: string | null): ProductBinding {
    return this.transaction(() => {
      const old = this.binding(actor, conversationId)
      if (old.version !== expectedVersion) fail('conflict', 'Binding version changed')
      if (this.getRow('SELECT * FROM writers WHERE conversation_id=?', conversationId)
        || this.getRow("SELECT submission_id FROM submissions WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled') LIMIT 1", conversationId)) fail('conflict', 'Stop and reconcile the conversation before replacing its binding')
      const next = validate({ ...old, bindingId: `binding:${randomUUID()}`, runtimeSessionId, branchEntryId,
        generation: old.generation + 1, version: old.version + 1, updatedAt: this.now() }, 'binding')
      this.db.prepare('UPDATE bindings SET generation=?,version=?,data=? WHERE conversation_id=?').run(next.generation, next.version, canonical(next), conversationId)
      return next
    })
  }

  /** Trusted native lifecycle commit, after Catalog's exact proof and actual process
   * join. The planned binding is durable there before this CAS; never allocate a
   * different identity on retry or treat this method as native execution proof.
   * Historical binding/entry lineage remains in Catalog, not copied submissions.
   */
  commitNativeHandoff(actor: ProductActor, source: ProductBinding, target: ProductBinding): ProductBinding {
    const before = validate(source, 'binding'), next = validate(target, 'binding')
    if (before.ownerActorId !== actor.actorId || before.workspaceId !== actor.workspaceId
      || next.ownerActorId !== actor.actorId || next.workspaceId !== actor.workspaceId) fail('not-found', 'Native handoff is not accessible')
    const navigation = before.conversationId === next.conversationId
    if (next.bindingId === before.bindingId || next.investigationId !== before.investigationId
      || Date.parse(next.updatedAt) < Date.parse(before.updatedAt)
      || (navigation ? next.runtimeSessionId !== before.runtimeSessionId || next.generation !== before.generation + 1
        || next.version !== before.version + 1 || next.createdAt !== before.createdAt
        : next.runtimeSessionId === before.runtimeSessionId || next.generation !== 1 || next.version !== 1
          || Date.parse(next.createdAt) < Date.parse(before.createdAt))) fail('invalid-request', 'Invalid native binding handoff plan')
    return this.transaction(() => {
      const current = this.binding(actor, before.conversationId)
      if (navigation && canonical(current) === canonical(next)) return current
      if (canonical(current) !== canonical(before)) fail('conflict', 'Native source binding changed before handoff')
      if (!navigation && this.getRow('SELECT * FROM bindings WHERE conversation_id=?', next.conversationId)) {
        const existing = this.binding(actor, next.conversationId)
        if (canonical(existing) !== canonical(next)) fail('conflict', 'Native fork target belongs to another binding')
        return existing
      }
      if (this.getRow('SELECT * FROM writers WHERE conversation_id=?', before.conversationId)
        || this.getRow("SELECT submission_id FROM submissions WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled') LIMIT 1", before.conversationId)) {
        fail('conflict', 'Native handoff requires a joined writer and settled source requests')
      }
      if (navigation) {
        const changed = this.db.prepare('UPDATE bindings SET generation=?,version=?,data=? WHERE conversation_id=? AND generation=? AND version=?')
          .run(next.generation, next.version, canonical(next), before.conversationId, before.generation, before.version)
        if (changed.changes !== 1) fail('conflict', 'Native binding changed during handoff')
      } else {
        if (Number(this.getRow('SELECT COUNT(*) AS n FROM bindings WHERE owner_actor_id=? AND workspace_id=?', actor.actorId, actor.workspaceId)!.n) >= 256) fail('limit-exceeded', 'Conversation capacity reached')
        this.db.prepare('INSERT INTO bindings(conversation_id,workspace_id,owner_actor_id,generation,version,data) VALUES(?,?,?,?,?,?)')
          .run(next.conversationId, next.workspaceId, next.ownerActorId, next.generation, next.version, canonical(next))
      }
      return this.binding(actor, next.conversationId)
    })
  }

  /** Returns only after the SQLite FULL-synchronous transaction commits. */
  accept(actor: ProductActor, candidate: unknown): { receipt: ProductRunReceipt, replayed: boolean } {
    const request = validate(candidate, 'submission')
    const requestHash = hash(canonical(request))
    return this.transaction(() => {
      const binding = this.binding(actor, request.conversationId)
      const old = this.getRow('SELECT * FROM submissions WHERE conversation_id=? AND owner_actor_id=? AND idempotency_key=?', request.conversationId, actor.actorId, request.idempotencyKey)
      if (old) {
        if (old.request_hash !== requestHash) fail('conflict', 'Idempotency key already belongs to different input')
        return { receipt: this.receiptFromRow(old), replayed: true }
      }
      if (binding.generation !== request.expectedGeneration) fail('conflict', 'Conversation generation changed; refresh before submitting')
      const count = this.getRow("SELECT COUNT(*) AS n FROM submissions WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled')", request.conversationId)!
      if (Number(count.n) >= 32) fail('limit-exceeded', 'Conversation pending queue is full')
      const now = this.now()
      const receipt = validate({ schemaVersion: 1, kind: 'run-receipt', submissionId: `submission:${randomUUID()}`, runId: `run:${randomUUID()}`,
        conversationId: binding.conversationId, generation: binding.generation, mode: request.mode, state: 'accepted', version: 1,
        requestHash, createdAt: now, updatedAt: now, payloadRetained: true }, 'run-receipt')
      this.db.prepare(`INSERT INTO submissions(submission_id,run_id,conversation_id,owner_actor_id,idempotency_key,request_hash,generation,state,version,payload,receipt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.submissionId, receipt.runId, binding.conversationId, actor.actorId, request.idempotencyKey,
        requestHash, binding.generation, receipt.state, receipt.version, canonical(request), canonical(receipt))
      return { receipt, replayed: false }
    })
  }

  get(actor: ProductActor, submissionId: string): ProductRunReceipt { return this.receiptFromRow(this.authorizedRow(actor, submissionId)) }

  conversations(actor: ProductActor, after?: string): { items: ProductBinding[], nextCursor: string | null } {
    if (after !== undefined) this.binding(actor, after)
    const rows = this.db.prepare('SELECT conversation_id FROM bindings WHERE owner_actor_id=? AND workspace_id=? AND conversation_id>? ORDER BY conversation_id LIMIT 33').all(actor.actorId, actor.workspaceId, after ?? '') as Row[]
    const items = rows.slice(0, 32).map(row => this.binding(actor, String(row.conversation_id)))
    return { items, nextCursor: rows.length > 32 ? items.at(-1)!.conversationId : null }
  }

  recent(actor: ProductActor, conversationId: string, before?: string): { items: ProductRunReceipt[], nextCursor: string | null } {
    this.binding(actor, conversationId)
    const previous = before === undefined ? undefined : this.authorizedRow(actor, before)
    if (previous && previous.conversation_id !== conversationId) fail('invalid-request', 'Cursor belongs to another conversation')
    const rows = this.db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND queue_seq < ? ORDER BY queue_seq DESC LIMIT 33').all(conversationId, previous?.queue_seq ?? Number.MAX_SAFE_INTEGER) as Row[]
    const selected = rows.slice(0, 32).map(row => this.receiptFromRow(row))
    return { items: selected.reverse(), nextCursor: rows.length > 32 ? String(rows[31]!.submission_id) : null }
  }

  pending(actor: ProductActor, conversationId: string): ProductRunReceipt[] {
    this.binding(actor, conversationId)
    return (this.db.prepare("SELECT * FROM submissions WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled') ORDER BY queue_seq LIMIT 100").all(conversationId) as Row[])
      .map(row => this.receiptFromRow(row))
  }

  list(actor: ProductActor, conversationId: string, limit = 32, after?: string): { items: ProductRunReceipt[], nextCursor?: string } {
    this.binding(actor, conversationId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-request', 'Invalid list limit')
    const previous = after === undefined ? undefined : this.authorizedRow(actor, after)
    if (previous && previous.conversation_id !== conversationId) fail('invalid-request', 'Cursor belongs to another conversation')
    const rows = this.db.prepare('SELECT * FROM submissions WHERE conversation_id=? AND queue_seq>? ORDER BY queue_seq LIMIT ?').all(conversationId, previous?.queue_seq ?? 0, limit + 1) as Row[]
    const items = rows.slice(0, limit).map(row => this.receiptFromRow(row))
    return rows.length > limit ? { items, nextCursor: items.at(-1)!.submissionId } : { items }
  }

  recoveryInput(actor: ProductActor, submissionId: string): ProductSubmission | null {
    const row = this.authorizedRow(actor, submissionId)
    this.receiptFromRow(row)
    if (row.payload === null) return null
    return this.inputFromRow(row)
  }

  /** Stable product acceptance ordinal; not a Pi-internal turn counter. */
  submissionOrdinal(actor: ProductActor, submissionId: string): number {
    const row = this.authorizedRow(actor, submissionId)
    this.receiptFromRow(row)
    const ordinal = Number(row.queue_seq)
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) fail('integrity-error', 'Invalid product submission ordinal')
    return ordinal
  }

  executionInput(lease: WriterLease, submissionId: string): { request: ProductSubmission, prepared: ProductPreparedSubmission } {
    this.assertWriter(lease)
    const row = this.leasedRow(lease, submissionId)
    const receipt = this.receiptFromRow(row)
    if (receipt.state !== 'dispatching' && receipt.state !== 'running') fail('conflict', 'Input is not admitted for execution')
    const request = this.inputFromRow(row)
    return { request, prepared: this.preparedFromRow(row, request) }
  }

  acquireWriter(actor: ProductActor, conversationId: string, workerId: string, ttlMs = 30_000): WriterLease {
    validateId(workerId)
    checkTtl(ttlMs)
    return this.transaction(() => {
      const binding = this.binding(actor, conversationId)
      const existing = this.getRow('SELECT * FROM writers WHERE conversation_id=?', conversationId)
      if (existing) fail(Number(existing.expires_at) > this.clock() ? 'conflict' : 'recovery-required', 'Writer must be explicitly retired after execution stops; expiry is not proof of termination')
      const previous = this.getRow('SELECT writer_epoch FROM bindings WHERE conversation_id=?', conversationId)!
      const epoch = Number(previous.writer_epoch) + 1
      if (!Number.isSafeInteger(epoch)) fail('integrity-error', 'Writer epoch exhausted')
      const lease = { conversationId, generation: binding.generation, epoch, workerId, token: randomBytes(32).toString('base64url'), expiresAt: this.clock() + ttlMs }
      this.db.prepare('UPDATE bindings SET writer_epoch=? WHERE conversation_id=?').run(epoch, conversationId)
      this.db.prepare('INSERT INTO writers VALUES(?,?,?,?,?,?)').run(conversationId, binding.generation, epoch, workerId, hash(lease.token), lease.expiresAt)
      return lease
    })
  }

  heartbeat(lease: WriterLease, ttlMs = 30_000): WriterLease {
    checkTtl(ttlMs)
    return this.transaction(() => {
      this.assertWriter(lease)
      const next = { ...lease, expiresAt: this.clock() + ttlMs }
      this.db.prepare('UPDATE writers SET expires_at=? WHERE conversation_id=?').run(next.expiresAt, lease.conversationId)
      return next
    })
  }

  /** Narrow trusted-store guard; possessing a conversation ID is never writer authority. */
  verifyWriter(lease: WriterLease): void { this.assertWriter(lease) }

  writerInfo(actor: ProductActor, conversationId: string): Omit<WriterLease, 'token'> | null {
    this.binding(actor, conversationId)
    const row = this.getRow('SELECT * FROM writers WHERE conversation_id=?', conversationId)
    return row ? { conversationId, generation: Number(row.generation), epoch: Number(row.epoch), workerId: String(row.worker_id), expiresAt: Number(row.expires_at) } : null
  }

  releaseWriter(lease: WriterLease): void {
    this.transaction(() => {
      this.assertWriter(lease)
      if (this.getRow("SELECT submission_id FROM submissions WHERE conversation_id=? AND state IN ('dispatching','running','cancelling') LIMIT 1", lease.conversationId)) fail('conflict', 'Cannot release a writer with possible active execution')
      this.db.prepare('DELETE FROM writers WHERE conversation_id=?').run(lease.conversationId)
    })
  }

  /** Internal recovery operation: caller MUST first verify the associated process tree has stopped. */
  recoverAfterExecutionStopped(actor: ProductActor, conversationId: string, expectedEpoch: number): ProductRunReceipt[] {
    return this.transaction(() => {
      this.binding(actor, conversationId)
      const writer = this.getRow('SELECT * FROM writers WHERE conversation_id=?', conversationId)
      if (!writer || writer.epoch !== expectedEpoch) fail('conflict', 'Writer changed during recovery')
      const receipts = (this.db.prepare("SELECT * FROM submissions WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled','outcome-unknown') ORDER BY queue_seq").all(conversationId) as Row[]).map(row => {
        const receipt = this.receiptFromRow(row)
        if (!DISPATCHED.has(receipt.state)) {
          // Prepared permission/selection leases must be revalidated after recovery.
          if (receipt.state === 'ready' || receipt.state === 'preparing') {
            this.db.prepare('UPDATE submissions SET prepared=NULL WHERE submission_id=?').run(receipt.submissionId)
            return this.writeReceipt(row, { ...receipt, state: 'preparing' })
          }
          return receipt
        }
        return this.writeReceipt(row, { ...receipt, state: 'outcome-unknown', errorCode: 'execution-interrupted' })
      })
      this.db.prepare('DELETE FROM writers WHERE conversation_id=?').run(conversationId)
      return receipts
    })
  }

  transition(lease: WriterLease, submissionId: string, expectedVersion: number, state: ProductRunState,
    detail: { prepared?: ProductPreparedSubmission, checkpoint?: ProductPiCheckpoint, errorCode?: ProductRunError } = {}): ProductRunReceipt {
    return this.transaction(() => {
      this.assertWriter(lease)
      const row = this.leasedRow(lease, submissionId)
      const old = this.receiptFromRow(row)
      if (old.version !== expectedVersion) fail('conflict', 'Submission version changed')
      validate({ schemaVersion: 1, kind: 'run-transition', from: old.state, to: state }, 'run-transition')
      if (state === 'ready') {
        const prepared = validate(detail.prepared, 'prepared')
        const request = this.inputFromRow(row)
        if (prepared.submissionId !== submissionId || prepared.requestHash !== old.requestHash || prepared.bindingGeneration !== lease.generation
          || canonical(prepared.sourceRefs) !== canonical(request.sourceRefs) || canonical(prepared.selectionContextIds) !== canonical(request.selectionContextIds)) fail('conflict', 'Prepared scope/selection does not match the entire submission')
        this.db.prepare('UPDATE submissions SET prepared=? WHERE submission_id=?').run(canonical(prepared), submissionId)
      } else if (detail.prepared) fail('invalid-request', 'Prepared context is only accepted at ready')
      if (state === 'dispatching') {
        if (row.prepared === null) fail('conflict', 'Submission has not been prepared')
        this.preparedFromRow(row, this.inputFromRow(row))
        if (this.getRow("SELECT submission_id FROM submissions WHERE conversation_id=? AND state='outcome-unknown' LIMIT 1", lease.conversationId)) fail('recovery-required', 'Reconcile unknown execution before dispatching more work')
      }
      if (detail.checkpoint) {
        const proof = validate(detail.checkpoint, 'pi-checkpoint')
        const binding = decode(this.getRow('SELECT data FROM bindings WHERE conversation_id=?', lease.conversationId)!.data, 'binding')
        if (proof.submissionId !== submissionId || proof.requestHash !== old.requestHash || proof.runtimeSessionId !== binding.runtimeSessionId) fail('conflict', 'Checkpoint does not belong to this submission and Pi session')
        const mapped = this.getRow('SELECT * FROM checkpoint_bindings WHERE (runtime_session_id=? AND user_entry_id=?) OR submission_id=?', proof.runtimeSessionId, proof.userEntryId, submissionId)
        if (mapped && (mapped.submission_id !== submissionId || mapped.runtime_session_id !== proof.runtimeSessionId || mapped.user_entry_id !== proof.userEntryId)) fail('conflict', 'Native user entry is already bound to a different submission')
        if (!mapped) this.db.prepare('INSERT INTO checkpoint_bindings VALUES(?,?,?)').run(proof.runtimeSessionId, proof.userEntryId, submissionId)
      }
      const next = { ...old, state, ...detail }
      delete (next as { prepared?: unknown }).prepared
      if (state === 'completed') delete next.errorCode
      return this.writeReceipt(row, next)
    })
  }

  requestCancel(actor: ProductActor, submissionId: string, expectedVersion: number): ProductRunReceipt {
    return this.transaction(() => {
      const row = this.authorizedRow(actor, submissionId), old = this.receiptFromRow(row)
      if (old.version !== expectedVersion) fail('conflict', 'Submission version changed')
      if (TERMINAL.has(old.state) || old.state === 'cancelling') return old
      if (old.state === 'outcome-unknown') fail('recovery-required', 'Unknown execution must be reconciled, not claimed cancelled')
      return this.writeReceipt(row, { ...old, state: DISPATCHED.has(old.state) ? 'cancelling' : 'cancelled' })
    })
  }

  /** Only completed, checkpoint-bound input is eligible; this is logical, not forensic deletion. */
  purgeRecoveryPayload(actor: ProductActor, submissionId: string): ProductRunReceipt {
    return this.transaction(() => {
      const row = this.authorizedRow(actor, submissionId), old = this.receiptFromRow(row)
      if (old.state !== 'completed' || !old.checkpoint) fail('conflict', 'Cannot purge recovery input without completed native checkpoint')
      if (!old.payloadRetained) return old
      this.db.prepare('UPDATE submissions SET payload=NULL,prepared=NULL WHERE submission_id=?').run(submissionId)
      return this.writeReceipt(row, { ...old, payloadRetained: false })
    })
  }

  private writeReceipt(row: Row, candidate: ProductRunReceipt): ProductRunReceipt {
    const next = validate({ ...candidate, version: Number(row.version) + 1, updatedAt: this.now() }, 'run-receipt')
    this.db.prepare('UPDATE submissions SET state=?,version=?,receipt=? WHERE submission_id=?').run(next.state, next.version, canonical(next), next.submissionId)
    return next
  }
  private inputFromRow(row: Row): ProductSubmission {
    const request = decode(row.payload, 'submission')
    if (hash(canonical(request)) !== row.request_hash || request.conversationId !== row.conversation_id || request.expectedGeneration !== row.generation) fail('integrity-error', 'Stored submission input has changed')
    return request
  }
  private preparedFromRow(row: Row, request: ProductSubmission): ProductPreparedSubmission {
    const value = decode(row.prepared, 'prepared')
    if (value.submissionId !== row.submission_id || value.requestHash !== row.request_hash || value.bindingGeneration !== row.generation
      || canonical(value.sourceRefs) !== canonical(request.sourceRefs) || canonical(value.selectionContextIds) !== canonical(request.selectionContextIds)) fail('integrity-error', 'Prepared context has changed')
    return value
  }
  private authorizedRow(actor: ProductActor, id: string): Row {
    const row = this.getRow('SELECT * FROM submissions WHERE submission_id=?', id)
    if (!row || row.owner_actor_id !== actor.actorId) fail('not-found', 'Submission is not accessible')
    this.binding(actor, String(row.conversation_id))
    return row
  }
  private leasedRow(lease: WriterLease, id: string): Row {
    const row = this.getRow('SELECT * FROM submissions WHERE submission_id=?', id)
    if (!row || row.conversation_id !== lease.conversationId || row.generation !== lease.generation) fail('stale-writer', 'Submission is outside this runtime binding')
    return row
  }
  private receiptFromRow(row: Row): ProductRunReceipt {
    const value = decode(row.receipt, 'run-receipt')
    if (value.submissionId !== row.submission_id || value.runId !== row.run_id || value.conversationId !== row.conversation_id || value.generation !== row.generation
      || value.requestHash !== row.request_hash || value.state !== row.state || value.version !== row.version || value.payloadRetained !== (row.payload !== null)) fail('integrity-error', 'Submission columns disagree with its receipt')
    return value
  }
  private assertWriter(lease: WriterLease): void {
    const row = this.getRow('SELECT * FROM writers WHERE conversation_id=?', lease.conversationId)
    const expected = typeof row?.token_hash === 'string' ? row.token_hash : ''
    const actual = typeof lease.token === 'string' ? hash(lease.token) : ''
    if (!row || row.epoch !== lease.epoch || row.generation !== lease.generation || row.worker_id !== lease.workerId
      || Number(row.expires_at) <= this.clock() || expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) fail('stale-writer', 'Writer capability is no longer active')
  }
  private getRow(sql: string, ...params: SQLInputValue[]): Row | undefined { this.assertOpen(); return this.db.prepare(sql).get(...params) as Row | undefined }
  private now(): string { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) fail('integrity-error', 'Invalid control clock'); return new Date(value).toISOString() }
  private assertOpen(): void { if (this.closed) fail('conflict', 'Control store is closed') }
  private transaction<T>(fn: () => T): T {
    this.assertOpen(); this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  const result = JSON.stringify(value)
  if (result === undefined) fail('invalid-request', 'Expected JSON input')
  return result
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function validate<K extends ProductControlValue['kind']>(value: unknown, kind: K): Extract<ProductControlValue, { kind: K }> {
  try {
    const parsed = parseContract('product-control', value)
    if (parsed.kind !== kind || productControlIssues(parsed).length) fail('invalid-request', `Invalid ${kind} semantics`)
    return structuredClone(parsed) as Extract<ProductControlValue, { kind: K }>
  } catch (error) { if (error instanceof ControlStoreError) throw error; fail('invalid-request', `Invalid ${kind} shape`) }
}
function decode<K extends ProductControlValue['kind']>(value: SQLInputValue | undefined, kind: K): Extract<ProductControlValue, { kind: K }> {
  try { if (typeof value !== 'string') throw new Error('Missing JSON'); return validate(JSON.parse(value), kind) }
  catch { fail('integrity-error', `Corrupt stored ${kind}`) }
}
function validateId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) fail('invalid-request', 'Invalid opaque identifier') }
function checkTtl(ttl: number): void { if (!Number.isSafeInteger(ttl) || ttl < 100 || ttl > 60_000) fail('invalid-request', 'Writer TTL must be between 100 and 60000 ms') }
function fail(code: ControlStoreError['code'], message: string): never { throw new ControlStoreError(code, message) }
