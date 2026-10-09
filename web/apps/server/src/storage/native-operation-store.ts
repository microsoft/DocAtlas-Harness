import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { nativeControlIssues, type NativeCompactFailureProof, type NativeControlProof, type NativeOperationState, type ProductBinding, type ProductNativeCommand, type ProductNativeOperation } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { canonical, ControlStore, ControlStoreError, type ProductActor, type WriterLease } from './control-store.js'

type Row = Record<string, SQLInputValue>
type Detail = { result?: NativeControlProof, errorCode?: NonNullable<ProductNativeOperation['errorCode']>, failureProof?: NativeCompactFailureProof }
const APPLICATION_ID = 0x44414e4f, MAX_OPERATIONS = 1024, MAX_RECORD_BYTES = 65536
const UNSETTLED = new Set<NativeOperationState>(['accepted', 'applying', 'outcome-unknown'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fail(code: ControlStoreError['code'], message: string): never { throw new ControlStoreError(code, message) }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)

/** Private native-control receipts, not a second Agent loop or an authorization override.
 * Host composition verifies resource approval and native proof bytes independently before calls.
 * Reads never recover operations or infer process liveness from clocks/PIDs.
 */
export class NativeOperationStore {
  private closed = false
  private constructor(private readonly control: ControlStore, private readonly db: DatabaseSync, private readonly clock: () => number) {}

  static open(control: ControlStore, clock: () => number = Date.now): NativeOperationStore {
    const root = control.storageRoot, file = join(root, 'native-operations.sqlite3')
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) fail('integrity-error', 'Native operation root changed')
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { const info = lstatSync(file + suffix); if (!info.isFile() || info.isSymbolicLink()) fail('integrity-error', 'Invalid native operation database path') }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error }
    }
    const database = new DatabaseSync(file)
    try {
      const application = Number(database.prepare('PRAGMA application_id').get()!.application_id), version = Number(database.prepare('PRAGMA user_version').get()!.user_version)
      const count = Number(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n)
      if (!(application === APPLICATION_ID && version === 1) && !(application === 0 && version === 0 && count === 0)) fail('integrity-error', 'Unknown native operation database; no automatic migration')
      if (database.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('integrity-error', 'Invalid native operation database')
      chmodSync(file, 0o600)
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;')
      if (!version) database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE native_operations (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL, binding_id TEXT NOT NULL, generation INTEGER NOT NULL, runtime_session_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
          state TEXT NOT NULL, version INTEGER NOT NULL, operation_json TEXT NOT NULL, operation_hash TEXT NOT NULL,
          UNIQUE(actor_id, workspace_id, conversation_id, idempotency_key));
        CREATE UNIQUE INDEX native_operation_unsettled ON native_operations(conversation_id)
          WHERE state IN ('accepted','applying','outcome-unknown');
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`)
      database.prepare('SELECT seq,operation_id,actor_id,workspace_id,conversation_id,binding_id,generation,runtime_session_id,idempotency_key,request_hash,request_json,state,version,operation_json,operation_hash FROM native_operations LIMIT 0').all()
      if (!database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='native_operation_unsettled'").get()) fail('integrity-error', 'Native operation barrier index is missing')
      return new NativeOperationStore(control, database, clock)
    } catch (error) { database.close(); throw error }
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }

  accept(actor: ProductActor, lease: WriterLease, candidate: ProductNativeCommand): { operation: ProductNativeOperation, replayed: boolean } {
    const request = this.command(candidate), requestHash = hash(canonical(request))
    return this.transaction(() => {
      const binding = this.authorizeWriter(actor, lease, request.conversationId)
      const all = this.all(actor, request.conversationId), previous = all.find(operation => operation.request.idempotencyKey === request.idempotencyKey)
      if (previous) {
        if (previous.requestHash !== requestHash) fail('conflict', 'Native command key belongs to a different complete request')
        this.authorizeWriter(actor, lease, request.conversationId)
        return { operation: previous, replayed: true }
      }
      if (all.some(operation => UNSETTLED.has(operation.state))) fail('conflict', 'An unsettled native operation blocks every new command')
      if (all.length >= MAX_OPERATIONS) fail('limit-exceeded', 'Native operation conversation capacity reached')
      if (request.expectedBindingId !== binding.bindingId || request.expectedGeneration !== binding.generation || request.runtimeSessionId !== binding.runtimeSessionId) fail('conflict', 'Native command belongs to another binding or runtime')
      const now = this.now(), operation = this.operation({ schemaVersion: 1, kind: 'native-operation', operationId: `native:${randomUUID()}`,
        conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, runtimeSessionId: binding.runtimeSessionId,
        requestHash, request, state: 'accepted', version: 1, createdAt: now, updatedAt: now, result: null, errorCode: null })
      this.db.prepare(`INSERT INTO native_operations(operation_id,actor_id,workspace_id,conversation_id,binding_id,generation,runtime_session_id,idempotency_key,
        request_hash,request_json,state,version,operation_json,operation_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        operation.operationId, actor.actorId, actor.workspaceId, operation.conversationId, operation.bindingId, operation.generation, operation.runtimeSessionId,
        request.idempotencyKey, requestHash, canonical(request), operation.state, operation.version, canonical(operation), this.recordHash(actor, operation))
      this.authorizeWriter(actor, lease, request.conversationId)
      return { operation: structuredClone(operation), replayed: false }
    })
  }

  byKey(actor: ProductActor, conversationId: string, key: string): ProductNativeOperation | undefined {
    this.authorize(actor, conversationId)
    if (!id(key)) fail('invalid-request', 'Invalid native command key')
    const row = this.db.prepare('SELECT * FROM native_operations WHERE actor_id=? AND workspace_id=? AND conversation_id=? AND idempotency_key=?').get(actor.actorId, actor.workspaceId, conversationId, key) as Row | undefined
    return row ? this.read(row, actor, conversationId) : undefined
  }

  get(actor: ProductActor, conversationId: string, operationId: string): ProductNativeOperation {
    this.authorize(actor, conversationId)
    if (!id(operationId)) fail('invalid-request', 'Invalid native operation identity')
    const row = this.db.prepare('SELECT * FROM native_operations WHERE actor_id=? AND workspace_id=? AND conversation_id=? AND operation_id=?').get(actor.actorId, actor.workspaceId, conversationId, operationId) as Row | undefined
    if (!row) fail('not-found', 'Native operation is not accessible')
    return this.read(row, actor, conversationId)
  }

  list(actor: ProductActor, conversationId: string, limit = 32): { operations: ProductNativeOperation[], truncated: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-request', 'Invalid native operation list limit')
    const all = this.all(actor, conversationId).reverse()
    return { operations: all.slice(0, limit), truncated: all.length > limit }
  }

  pending(actor: ProductActor, conversationId: string): ProductNativeOperation[] {
    // Validate all bounded receipts before interpreting state columns as an admission barrier.
    return this.all(actor, conversationId).filter(operation => UNSETTLED.has(operation.state))
  }

  transition(actor: ProductActor, lease: WriterLease, operationId: string, version: number,
    state: Exclude<NativeOperationState, 'accepted'>, detail: Detail = {}): ProductNativeOperation {
    if (!Number.isSafeInteger(version) || version < 1 || !['applying', 'succeeded', 'failed', 'outcome-unknown'].includes(state)
      || !detail || typeof detail !== 'object' || Array.isArray(detail) || Object.keys(detail).some(key => !['result', 'errorCode', 'failureProof'].includes(key))) fail('invalid-request', 'Invalid native operation transition')
    const captured = structuredClone(detail)
    return this.transaction(() => {
      const binding = this.authorizeWriter(actor, lease, lease.conversationId), current = this.get(actor, lease.conversationId, operationId)
      if (current.bindingId !== binding.bindingId || current.generation !== binding.generation || current.runtimeSessionId !== binding.runtimeSessionId) fail('conflict', 'An old native operation cannot mutate this binding')
      if (current.state === 'succeeded') {
        if (state !== 'succeeded' || !captured.result || captured.errorCode !== undefined || captured.failureProof !== undefined || !same(captured.result, current.result)
          || version !== current.version && version !== current.version - 1) fail('conflict', 'Native success is immutable and only its original proof can replay')
        this.authorizeWriter(actor, lease, lease.conversationId)
        return current
      }
      if (current.state === 'failed' && current.failureProof) {
        if (state !== 'failed' || captured.result !== undefined || captured.errorCode !== current.errorCode || !captured.failureProof || !same(captured.failureProof, current.failureProof)
          || version !== current.version && version !== current.version - 1) fail('conflict', 'Proved native non-application is immutable')
        this.authorizeWriter(actor, lease, lease.conversationId)
        return current
      }
      if (current.version !== version) fail('conflict', 'Native operation version changed')
      const permitted = current.state === 'accepted' ? ['applying', 'failed', 'outcome-unknown']
        : current.state === 'applying' ? ['succeeded', 'failed', 'outcome-unknown'] : current.state === 'outcome-unknown' ? ['succeeded', 'failed'] : []
      if (!permitted.includes(state)) fail('conflict', 'Invalid native operation state transition')
      if (current.state === 'outcome-unknown' && state === 'failed' && !captured.failureProof) fail('conflict', 'Unknown effects need a native non-application proof')
      // Applying is a host admission receipt, not proof of native dispatch. The
      // trusted coordinator may still reject before sending IPC; after dispatch
      // it preserves uncertainty unless an independently verified proof arrives.
      if (state === 'succeeded' ? !captured.result || captured.errorCode !== undefined
        : state === 'applying' ? captured.result !== undefined || captured.errorCode !== undefined
          : captured.result !== undefined || captured.errorCode === undefined) fail('invalid-request', 'Native operation result/error does not match its state')
      if (captured.failureProof && (state !== 'failed' || captured.errorCode !== 'execution-interrupted')) fail('invalid-request', 'Native failure proof is only a terminal non-application witness')
      const operation = this.operation({ ...current, state, version: current.version + 1, updatedAt: this.now(), result: captured.result ?? null, errorCode: captured.errorCode ?? null,
        ...(captured.failureProof ? { failureProof: captured.failureProof } : {}) })
      if (operation.result) this.checkProof(operation)
      const updated = this.db.prepare('UPDATE native_operations SET state=?,version=?,operation_json=?,operation_hash=? WHERE operation_id=? AND version=? AND state=?')
        .run(operation.state, operation.version, canonical(operation), this.recordHash(actor, operation), operationId, version, current.state)
      if (updated.changes !== 1) fail('conflict', 'Native operation changed before commit')
      this.authorizeWriter(actor, lease, lease.conversationId)
      return structuredClone(operation)
    })
  }

  private all(actor: ProductActor, conversationId: string): ProductNativeOperation[] {
    this.authorize(actor, conversationId)
    // Conversation IDs are globally owned in ControlStore. A changed actor/workspace column
    // must surface as corruption, not hide an unsettled operation from admission checks.
    const rows = this.db.prepare('SELECT * FROM native_operations WHERE conversation_id=? ORDER BY seq LIMIT ?').all(conversationId, MAX_OPERATIONS + 1) as Row[]
    if (rows.length > MAX_OPERATIONS) fail('limit-exceeded', 'Native operation history exceeds its bounded inspection window')
    return rows.map(row => this.read(row, actor, conversationId))
  }
  private read(row: Row, actor: ProductActor, conversationId: string): ProductNativeOperation {
    if (typeof row.operation_json !== 'string' || typeof row.request_json !== 'string' || Buffer.byteLength(row.operation_json) > MAX_RECORD_BYTES || Buffer.byteLength(row.request_json) > MAX_RECORD_BYTES) fail('integrity-error', 'Invalid native operation record size')
    let operation: ProductNativeOperation, request: ProductNativeCommand
    try { operation = this.operation(JSON.parse(row.operation_json)); request = this.command(JSON.parse(row.request_json)) }
    catch { return fail('integrity-error', 'Invalid stored native operation') }
    if (row.actor_id !== actor.actorId || row.workspace_id !== actor.workspaceId || row.conversation_id !== conversationId
      || operation.operationId !== row.operation_id || operation.conversationId !== row.conversation_id || operation.bindingId !== row.binding_id
      || operation.generation !== row.generation || operation.runtimeSessionId !== row.runtime_session_id || operation.state !== row.state || operation.version !== row.version
      || request.idempotencyKey !== row.idempotency_key || operation.requestHash !== row.request_hash || hash(row.request_json) !== row.request_hash
      || !same(request, operation.request) || this.recordHash(actor, operation) !== row.operation_hash) fail('integrity-error', 'Native operation receipt columns or hashes disagree')
    if (operation.result) this.checkProof(operation)
    return structuredClone(operation)
  }
  private command(candidate: unknown): ProductNativeCommand {
    try {
      const value = parseContract('native-control', JSON.parse(canonical(candidate)))
      if (!('kind' in value) || value.kind !== 'native-command' || nativeControlIssues(value).length) fail('invalid-request', 'Invalid native command')
      return value
    } catch { return fail('invalid-request', 'Invalid native command shape or semantics') }
  }
  private operation(candidate: unknown): ProductNativeOperation {
    try {
      const value = parseContract('native-control', JSON.parse(canonical(candidate)))
      if (!('kind' in value) || value.kind !== 'native-operation' || nativeControlIssues(value).length
        || value.requestHash !== hash(canonical(value.request)) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
        || ['accepted', 'applying'].includes(value.state) && (value.result !== null || value.errorCode !== null)
        || ['failed', 'outcome-unknown'].includes(value.state) && (value.result !== null || value.errorCode === null)
        || Buffer.byteLength(canonical(value)) > MAX_RECORD_BYTES) fail('invalid-request', 'Invalid native operation semantics')
      return value
    } catch { return fail('invalid-request', 'Invalid native operation shape or semantics') }
  }
  private checkProof(operation: ProductNativeOperation): void {
    const proof = operation.result!
    if (proof.operationId !== operation.operationId || proof.requestHash !== operation.requestHash || !same(proof.action, operation.request.action)
      || !same(proof.beforeHead, operation.request.expectedHead) || proof.afterHead.sessionId !== operation.runtimeSessionId
      || proof.afterHead.byteLength <= proof.beforeHead.byteLength || proof.afterHead.entryCount < proof.beforeHead.entryCount + 2
      || proof.afterHead.leafEntryId !== proof.markerEntryId || proof.intentEntryId === proof.markerEntryId) fail('integrity-error', 'Native operation proof does not pin its original request and extended native prefix')
    if (proof.action.kind === 'set-model' && (proof.configuration.model.provider !== proof.action.provider || proof.configuration.model.id !== proof.action.modelId)
      || proof.action.kind === 'set-queue-mode' && proof.configuration[proof.action.queue === 'steering' ? 'steeringMode' : 'followUpMode'] !== proof.action.mode) fail('integrity-error', 'Native operation proof configuration differs from its action')
    // Thinking clamps are model-specific and remain in the independent native host verifier.
  }
  private recordHash(actor: ProductActor, operation: ProductNativeOperation): string { return hash(canonical({ actorId: actor.actorId, workspaceId: actor.workspaceId, operation })) }
  private authorize(actor: ProductActor, conversationId: string): ProductBinding {
    if (this.closed) fail('conflict', 'Native operation store is closed')
    return this.control.binding(actor, conversationId)
  }
  private authorizeWriter(actor: ProductActor, lease: WriterLease, conversationId: string): ProductBinding {
    const binding = this.authorize(actor, conversationId)
    if (lease.conversationId !== conversationId || lease.generation !== binding.generation) fail('stale-writer', 'Writer belongs to another native binding')
    this.control.verifyWriter(lease)
    return binding
  }
  private now(): string {
    const value = this.clock()
    if (!Number.isSafeInteger(value) || value < 0) fail('integrity-error', 'Invalid native operation clock')
    return new Date(value).toISOString()
  }
  private transaction<T>(operation: () => T): T {
    if (this.closed) fail('conflict', 'Native operation store is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
