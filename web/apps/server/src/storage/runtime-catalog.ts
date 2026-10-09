import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { NativeConfiguration, NativeSelectedHead, ProductBinding } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { NativeSessionSeal } from '@docatlas/runtime-pi/worker'
import { canonical, ControlStoreError, type ProductActor } from './control-store.js'
import { initializeRuntimeCatalog } from './runtime-catalog-schema.js'
import { RuntimeHandoffs, type NativeLineageLink } from './runtime-handoffs.js'

type Row = Record<string, SQLInputValue>
export interface NativeLineageConfiguration { operationId: string, markerEntryId: string, configuration: NativeConfiguration }
export interface RuntimeClaim { binding: ProductBinding, token: string, filename: string | null, seal: NativeSessionSeal | null,
  selectedHead?: NativeSelectedHead, lineageConfiguration?: NativeLineageConfiguration }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (code: ConstructorParameters<typeof ControlStoreError>[0], message: string): never => { throw new ControlStoreError(code, message) }
export function dedicatedDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || [homedir(), '/', process.cwd()].includes(path)) fail('invalid-request', 'Use a dedicated absolute runtime directory')
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) fail('invalid-request', 'Runtime directory cannot traverse symlinks')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (realpathSync(path) !== path) fail('invalid-request', 'Invalid runtime directory')
}
function filename(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\.jsonl$/.test(value))) fail('integrity-error', 'Invalid stored native filename')
}
function decodeSeal(value: SQLInputValue): NativeSessionSeal | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 8192) fail('integrity-error', 'Invalid native seal record')
  const seal = JSON.parse(value as string) as NativeSessionSeal
  if (!seal || Object.keys(seal).sort().join(',') !== 'byteLength,cwd,entryCount,leafEntryId,sessionId,transcriptHash,version' || seal.version !== 1
    || typeof seal.sessionId !== 'string' || typeof seal.cwd !== 'string' || !isAbsolute(seal.cwd) || !/^[a-f0-9]{64}$/.test(seal.transcriptHash)
    || !Number.isSafeInteger(seal.byteLength) || seal.byteLength < 1 || seal.byteLength > 67108864 || !Number.isSafeInteger(seal.entryCount) || seal.entryCount < 0
    || seal.leafEntryId !== null && (typeof seal.leafEntryId !== 'string' || seal.leafEntryId.length > 128)) fail('integrity-error', 'Invalid native seal')
  // Journal records use canonical key order; legacy native restore compares the
  // established seal representation. Normalize fields without changing bytes or
  // weakening any identity/content checks.
  return { version: seal.version, sessionId: seal.sessionId, cwd: seal.cwd, transcriptHash: seal.transcriptHash,
    byteLength: seal.byteLength, entryCount: seal.entryCount, leafEntryId: seal.leafEntryId }
}

/** Private application catalog. Active claims never expire into authority to launch another worker. */
export class RuntimeCatalog {
  private readonly db: DatabaseSync
  readonly handoffs: RuntimeHandoffs
  constructor(readonly root: string) {
    dedicatedDirectory(root)
    const file = join(root, 'runtime-catalog.sqlite3')
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).isSymbolicLink())) fail('integrity-error', 'Invalid runtime database path')
    this.db = new DatabaseSync(file)
    try {
      const application = Number(this.db.prepare('PRAGMA application_id').get()!.application_id), version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
      if (!((application === 0x44415452 && [1, 2].includes(version)) || application === 0 && version === 0)) fail('integrity-error', 'Unknown runtime catalog identity/version')
      chmodSync(file, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      initializeRuntimeCatalog(this.db)
      this.handoffs = new RuntimeHandoffs(this.db, claim => this.assertClaim(claim))
    } catch (error) { this.db.close(); throw error }
  }
  claim(binding: ProductBinding): RuntimeClaim {
    return this.transaction(() => {
      if (this.handoffs.pending({ actorId: binding.ownerActorId, workspaceId: binding.workspaceId }, binding.conversationId)) fail('recovery-required', 'Native lineage handoff must be reconciled before starting execution')
      let row = this.row(binding.conversationId)
      if (row) {
        this.assertBinding(row, binding)
        if (row.owner_hash !== null) fail('recovery-required', 'Prior runtime ownership was not cleanly released')
      } else {
        this.db.prepare('INSERT INTO runtimes(conversation_id,binding_id,session_id,actor,workspace,binding_json) VALUES(?,?,?,?,?,?)')
          .run(binding.conversationId, binding.bindingId, binding.runtimeSessionId, binding.ownerActorId, binding.workspaceId, JSON.stringify(binding))
        row = this.row(binding.conversationId)!
      }
      filename(row.filename)
      const seal = decodeSeal(row.seal ?? null)
      if (seal && (seal.sessionId !== binding.runtimeSessionId || !row.filename)) fail('integrity-error', 'Native seal belongs to another runtime')
      const extra = this.extras(row, binding)
      const token = randomBytes(32).toString('base64url')
      this.db.prepare('UPDATE runtimes SET owner_hash=?,binding_json=? WHERE conversation_id=?').run(hash(token), canonical(binding), binding.conversationId)
      return { binding: structuredClone(binding), token, filename: row.filename, seal, ...extra }
    })
  }
  setFile(claim: RuntimeClaim, value: string): void {
    filename(value)
    this.transaction(() => { this.assertClaim(claim); this.db.prepare('UPDATE runtimes SET filename=? WHERE conversation_id=?').run(value, claim.binding.conversationId) })
    claim.filename = value
  }
  /** Call only after every owned runtime/native process has actually joined. */
  release(claim: RuntimeClaim, seal: NativeSessionSeal | null, selectedHead?: NativeSelectedHead): void {
    this.transaction(() => {
      this.assertClaim(claim)
      if (this.row(claim.binding.conversationId)!.handoff_id !== null) fail('conflict', 'A lineage handoff must record its own actual join before releasing its claim')
      if (seal) { decodeSeal(JSON.stringify(seal)); if (seal.sessionId !== claim.binding.runtimeSessionId || !claim.filename) fail('integrity-error', 'Invalid clean runtime seal') }
      if (selectedHead && (!seal || !sameSeal(seal, selectedHead))) fail('integrity-error', 'Selected native head differs from the closed file seal')
      this.db.prepare('UPDATE runtimes SET seal=?,selected_head=?,owner_hash=NULL WHERE conversation_id=?')
        .run(seal ? JSON.stringify(seal) : null, selectedHead ? canonical(selectedHead) : null, claim.binding.conversationId)
    })
  }
  assertClaim(claim: RuntimeClaim): void {
    const row = this.row(claim.binding.conversationId)
    if (!row) fail('conflict', 'Runtime claim disappeared')
    this.assertBinding(row!, claim.binding)
    if (row!.owner_hash !== hash(claim.token)) fail('conflict', 'Runtime owner changed')
  }
  /** Host-only read lookup; no claim, launch, recovery or browser filename authority. */
  inspect(binding: ProductBinding): { filename: string | null, seal: NativeSessionSeal | null, active: boolean, selectedHead?: NativeSelectedHead, lineageConfiguration?: NativeLineageConfiguration } | undefined {
    const row = this.row(binding.conversationId)
    if (!row) return undefined
    this.assertBinding(row, binding); filename(row.filename)
    const seal = decodeSeal(row.seal ?? null)
    if (seal && (seal.sessionId !== binding.runtimeSessionId || !row.filename)) fail('integrity-error', 'Native seal belongs to another runtime')
    return { filename: row.filename, seal, active: row.owner_hash !== null || row.handoff_id !== null, ...this.extras(row, binding) }
  }
  historicalBindings(actor: ProductActor, currentBinding: ProductBinding): ReadonlyArray<Readonly<ProductBinding>> {
    return Object.freeze(this.lineageLinks(actor, currentBinding).map(link => Object.freeze(structuredClone(link.sourceBinding))))
  }
  lineageLinks(actor: ProductActor, currentBinding: ProductBinding): ReadonlyArray<NativeLineageLink> {
    if (actor.actorId !== currentBinding.ownerActorId || actor.workspaceId !== currentBinding.workspaceId) fail('not-found', 'Native lineage history is unavailable')
    const row = this.row(currentBinding.conversationId)
    if (row) this.assertBinding(row, currentBinding)
    return this.handoffs.lineageLinks(actor, currentBinding)
  }
  close(): void { this.db.close() }
  private row(id: string): Row | undefined { return this.db.prepare('SELECT * FROM runtimes WHERE conversation_id=?').get(id) }
  private assertBinding(row: Row, binding: ProductBinding): void {
    if (row.actor !== binding.ownerActorId || row.workspace !== binding.workspaceId) fail('not-found', 'Runtime is not accessible')
    if (row.binding_id !== binding.bindingId || row.session_id !== binding.runtimeSessionId) fail('conflict', 'Runtime binding changed; explicit reconciliation required')
    if (row.binding_json !== null) {
      const stored = parseContract('product-control', JSON.parse(String(row.binding_json)))
      if (stored.kind !== 'binding' || canonical(stored) !== canonical(binding)) fail('integrity-error', 'Runtime binding envelope changed')
    }
  }
  private extras(row: Row, binding: ProductBinding): { selectedHead?: NativeSelectedHead, lineageConfiguration?: NativeLineageConfiguration } {
    const result: { selectedHead?: NativeSelectedHead, lineageConfiguration?: NativeLineageConfiguration } = {}
    if (row.selected_head !== null) {
      const value = JSON.parse(String(row.selected_head)) as NativeSelectedHead
      if (!value || Object.keys(value).sort().join(',') !== 'contextHash,fileSeal,selectedLeafEntryId,version' || value.version !== 1
        || !/^[a-f0-9]{64}$/u.test(value.contextHash) || value.selectedLeafEntryId !== null && typeof value.selectedLeafEntryId !== 'string'
        || value.fileSeal?.sessionId !== binding.runtimeSessionId) fail('integrity-error', 'Invalid selected native context')
      const oldSeal = decodeSeal(row.seal ?? null)
      if (oldSeal && row.owner_hash === null && !sameSeal(oldSeal!, value)) fail('integrity-error', 'Selected native context and sealed file disagree')
      result.selectedHead = value
    }
    if (row.lineage_configuration !== null) {
      const value = JSON.parse(String(row.lineage_configuration)) as NativeLineageConfiguration
      if (!value || Object.keys(value).sort().join(',') !== 'configuration,markerEntryId,operationId') fail('integrity-error', 'Invalid native lineage configuration seed')
      const record = this.handoffs.get({ actorId: binding.ownerActorId, workspaceId: binding.workspaceId }, value.operationId), proof = record.proof
      if (!proof) fail('integrity-error', 'Configuration seed lost its verified native operation')
      const target = proof!.targetHead.fileSeal.sessionId === binding.runtimeSessionId
      if ((!target && proof!.sourceAfterHead.fileSeal.sessionId !== binding.runtimeSessionId)
        || value.markerEntryId !== (target ? proof!.targetMarkerEntryId : proof!.sourceMarkerEntryId)
        || canonical(value.configuration) !== canonical(target ? proof!.configuration : proof!.sourceConfiguration)) fail('integrity-error', 'Configuration seed differs from its native lineage proof')
      result.lineageConfiguration = value
    }
    return structuredClone(result)
  }
  private transaction<T>(run: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = run(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error } }
}
function sameSeal(seal: NativeSessionSeal, head: NativeSelectedHead): boolean {
  const { cwd: _cwd, leafEntryId, ...value } = seal
  return canonical({ ...value, tailEntryId: leafEntryId }) === canonical(head.fileSeal)
}
