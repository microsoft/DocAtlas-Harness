import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { nativeLineageIssues, type NativeLineageOutcome, type NativeLineageProof, type NativeSelectedHead,
  type ProductBinding, type ProductLineageCommand, type ProductLineageOperation } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { NativeSessionSeal } from '@docatlas/runtime-pi/worker'
import { canonical, ControlStoreError, type ProductActor } from './control-store.js'
import type { RuntimeClaim } from './runtime-catalog.js'

type Row = Record<string, SQLInputValue>
export type HandoffPhase = 'reserved' | 'proved' | 'joined' | 'installed' | 'binding-committed' | 'complete'
export interface NativeHandoffRecord {
  version: 1
  phase: HandoffPhase
  operation: ProductLineageOperation
  sourceFilename: string
  targetConversationId: string
  proof?: NativeLineageProof
  forkFilename?: string
  targetFilename?: string
  targetBinding?: ProductBinding
  closedSourceSeal?: NativeSessionSeal
  closedTargetSeal?: NativeSessionSeal
}
export interface NativeLineageLink {
  sourceBinding: ProductBinding
  targetBinding: ProductBinding
  proof: NativeLineageProof
  sourceFilename: string
  targetFilename: string
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)
function fail(code: ControlStoreError['code'], message: string): never { throw new ControlStoreError(code, message) }
const phases: HandoffPhase[] = ['reserved', 'proved', 'joined', 'installed', 'binding-committed', 'complete']
function filename(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\.jsonl$/u.test(value)) fail('integrity-error', 'Invalid private lineage filename')
}
function seal(value: NativeSessionSeal): void {
  if (!value || Object.keys(value).sort().join(',') !== 'byteLength,cwd,entryCount,leafEntryId,sessionId,transcriptHash,version'
    || value.version !== 1 || typeof value.sessionId !== 'string' || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)
    || !/^[a-f0-9]{64}$/u.test(value.transcriptHash) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > 67108864
    || !Number.isSafeInteger(value.entryCount) || value.entryCount < 0 || value.leafEntryId !== null && typeof value.leafEntryId !== 'string') fail('integrity-error', 'Invalid joined native seal')
}
function matchesSeal(value: NativeSessionSeal, head: NativeSelectedHead): boolean {
  const { cwd: _cwd, leafEntryId, ...before } = value
  return same({ ...before, tailEntryId: leafEntryId }, head.fileSeal)
}
function command(candidate: unknown): ProductLineageCommand {
  const parsed = parseContract('native-lineage', candidate)
  if (!('kind' in parsed) || parsed.kind !== 'lineage-command' || nativeLineageIssues(parsed).length) return fail('invalid-request', 'Invalid lineage command')
  return structuredClone(parsed)
}
function operation(candidate: unknown): ProductLineageOperation {
  const parsed = parseContract('native-lineage', candidate)
  if (!('kind' in parsed) || parsed.kind !== 'lineage-operation' || nativeLineageIssues(parsed).length
    || parsed.requestHash !== hash(canonical(parsed.request))) return fail('integrity-error', 'Invalid lineage operation receipt')
  return structuredClone(parsed)
}

/** Shares Catalog's FULL-sync transaction, claim fences and journal. It is never
 * a second native transcript or a browser-controlled recovery authority.
 */
export class RuntimeHandoffs {
  constructor(private readonly db: DatabaseSync, private readonly assertClaim: (claim: RuntimeClaim) => void, private readonly clock: () => number = Date.now) {}

  accept(claim: RuntimeClaim, candidate: ProductLineageCommand): NativeHandoffRecord {
    const request = command(candidate), source = claim.binding, actor = { actorId: source.ownerActorId, workspaceId: source.workspaceId }
    return this.transaction(() => {
      this.assertClaim(claim)
      const old = this.byKey(actor, source.conversationId, request.idempotencyKey)
      if (old) { if (old.operation.requestHash !== hash(canonical(request))) fail('conflict', 'Lineage key belongs to different complete input'); return old }
      if (request.conversationId !== source.conversationId || request.expectedBindingId !== source.bindingId || request.expectedGeneration !== source.generation
        || request.runtimeSessionId !== source.runtimeSessionId || request.expectedHead.fileSeal.sessionId !== source.runtimeSessionId) fail('conflict', 'Lineage source binding changed')
      if (!claim.filename) fail('recovery-required', 'Native source file is not established')
      filename(claim.filename)
      if (this.pending(actor, source.conversationId)) fail('conflict', 'Another lineage handoff is pending')
      if (this.records(actor, source.conversationId).length >= 1024) fail('limit-exceeded', 'Lineage operation capacity reached')
      const operationId = `lineage:${randomUUID()}`, now = this.now()
      const targetConversationId = request.action.kind === 'navigate' ? source.conversationId : `conversation:${hash(canonical([actor, operationId]))}`
      if (request.action.kind === 'fork' && this.db.prepare('SELECT conversation_id FROM runtimes WHERE conversation_id=?').get(targetConversationId)) fail('conflict', 'Native fork destination already exists')
      const value: NativeHandoffRecord = { version: 1, phase: 'reserved', sourceFilename: claim.filename, targetConversationId,
        operation: operation({ schemaVersion: 1, kind: 'lineage-operation', operationId, sourceBinding: source, requestHash: hash(canonical(request)), request,
          state: 'accepted', version: 1, createdAt: now, updatedAt: now, result: null, errorCode: null }) }
      this.db.prepare('INSERT INTO lineage_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(operationId, source.conversationId, source.bindingId, targetConversationId,
        actor.actorId, actor.workspaceId, request.idempotencyKey, value.operation.requestHash, value.phase, canonical(value), this.digest(value))
      const changed = this.db.prepare('UPDATE runtimes SET handoff_id=? WHERE conversation_id=? AND handoff_id IS NULL').run(operationId, source.conversationId)
      if (changed.changes !== 1) fail('conflict', 'Source runtime already has a handoff fence')
      this.assertClaim(claim); return structuredClone(value)
    })
  }
  get(actor: ProductActor, operationId: string): NativeHandoffRecord {
    const row = this.db.prepare('SELECT * FROM lineage_handoffs WHERE operation_id=?').get(operationId) as Row | undefined
    if (!row) return fail('not-found', 'Lineage operation is unavailable')
    return this.read(row, actor)
  }
  byKey(actor: ProductActor, conversationId: string, key: string): NativeHandoffRecord | undefined {
    const row = this.db.prepare('SELECT * FROM lineage_handoffs WHERE source_conversation_id=? AND actor=? AND workspace=? AND idempotency_key=?')
      .get(conversationId, actor.actorId, actor.workspaceId, key) as Row | undefined
    return row ? this.read(row, actor) : undefined
  }
  records(actor: ProductActor, conversationId: string): NativeHandoffRecord[] {
    const rows = this.db.prepare('SELECT * FROM lineage_handoffs WHERE source_conversation_id=? OR target_conversation_id=? ORDER BY rowid LIMIT 2049').all(conversationId, conversationId) as Row[]
    if (rows.length > 2048) fail('limit-exceeded', 'Lineage history capacity exceeded')
    return rows.map(row => this.read(row, actor))
  }
  pending(actor: ProductActor, conversationId: string): NativeHandoffRecord | undefined {
    const records = this.records(actor, conversationId).filter(value => value.phase !== 'complete')
    if (records.length > 1) fail('integrity-error', 'Multiple lineage operations share one runtime fence')
    const row = this.db.prepare('SELECT * FROM runtimes WHERE conversation_id=?').get(conversationId)
    if (row && (row.actor !== actor.actorId || row.workspace !== actor.workspaceId)) fail('not-found', 'Lineage runtime is unavailable')
    if (row && (records[0] ? row.handoff_id !== records[0].operation.operationId : row.handoff_id !== null)) fail('integrity-error', 'Runtime handoff fence disagrees with its journal')
    return records[0]
  }
  /** Read-only actual-join/fence check, e.g. a Stop with no owned worker. */
  assertJoined(actor: ProductActor, operationId: string): void {
    const value = this.get(actor, operationId)
    this.owner(value, undefined, value.phase === 'binding-committed')
  }

  applying(claim: RuntimeClaim, operationId: string, version: number): NativeHandoffRecord {
    return this.change(claim, operationId, version, value => {
      if (value.phase !== 'reserved' || value.operation.state !== 'accepted') fail('conflict', 'Lineage is not ready for native dispatch')
      return this.bump(value, 'applying')
    })
  }
  failBeforeDispatch(claim: RuntimeClaim, operationId: string, version: number, errorCode: NonNullable<ProductLineageOperation['errorCode']>): NativeHandoffRecord {
    return this.change(claim, operationId, version, value => {
      if (value.phase !== 'reserved' || !['accepted', 'applying'].includes(value.operation.state)) fail('conflict', 'Dispatched or unknown lineage cannot be guessed failed')
      this.clearFence(value)
      return this.bump({ ...value, phase: 'complete' }, 'failed', { errorCode })
    })
  }
  unknown(claim: RuntimeClaim, operationId: string, version: number): NativeHandoffRecord {
    return this.change(claim, operationId, version, value => {
      if (value.phase === 'complete') return fail('conflict', 'Terminal lineage is immutable')
      return this.bump(value, 'outcome-unknown', { errorCode: 'execution-interrupted' })
    })
  }
  prove(claim: RuntimeClaim | undefined, actor: ProductActor, operationId: string, version: number, outcome: NativeLineageOutcome, forkFilename?: string): NativeHandoffRecord {
    const parsed = parseContract('native-lineage', outcome)
    if (!('status' in parsed) || nativeLineageIssues(parsed).length) fail('integrity-error', 'Invalid native lineage outcome')
    return this.mutate(actor, operationId, version, value => {
      this.owner(value, claim)
      if (!['reserved', 'proved', 'joined'].includes(value.phase)) fail('conflict', 'Native lineage proof arrived after installation')
      const proof = outcome.status === 'not-applied' ? outcome.failureProof : outcome.proof
      if (proof.operationId !== operationId || proof.requestHash !== value.operation.requestHash || !same(proof.action, value.operation.request.action)
        || !same(proof.beforeHead, value.operation.request.expectedHead)) fail('integrity-error', 'Native lineage proof changed its original request')
      if (outcome.status === 'not-applied') {
        if (forkFilename !== undefined) fail('integrity-error', 'Non-application cannot install a fork')
        this.db.prepare('UPDATE runtimes SET selected_head=? WHERE conversation_id=?').run(canonical(outcome.failureProof.afterHead), value.operation.sourceBinding.conversationId)
        this.clearFence(value)
        return this.bump({ ...value, phase: 'complete' }, 'failed', { errorCode: 'execution-interrupted', failureProof: outcome.failureProof })
      }
      if (outcome.proof.kind === 'native-fork-proof') filename(forkFilename)
      else if (forkFilename !== undefined) fail('integrity-error', 'Navigation cannot adopt a different native filename')
      if (value.proof && !same(value.proof, outcome.proof)) fail('conflict', 'Native lineage proof is immutable')
      const source = value.operation.sourceBinding, now = this.now()
      const target: ProductBinding = value.targetBinding ?? { ...source, bindingId: `binding:${randomUUID()}`, conversationId: value.targetConversationId,
        runtimeSessionId: outcome.proof.targetHead.fileSeal.sessionId, branchEntryId: outcome.proof.targetHead.selectedLeafEntryId,
        generation: outcome.proof.kind === 'native-navigation-proof' ? source.generation + 1 : 1,
        version: outcome.proof.kind === 'native-navigation-proof' ? source.version + 1 : 1,
        createdAt: outcome.proof.kind === 'native-navigation-proof' ? source.createdAt : now, updatedAt: now }
      return this.bump({ ...value, phase: value.phase === 'joined' ? 'joined' : 'proved', proof: outcome.proof, targetBinding: target,
        ...(forkFilename === undefined ? {} : { forkFilename }) }, 'handoff')
    })
  }
  joined(claim: RuntimeClaim, operationId: string, version: number, sourceSeal: NativeSessionSeal, targetSeal?: NativeSessionSeal): NativeHandoffRecord {
    seal(sourceSeal); if (targetSeal) seal(targetSeal)
    return this.change(claim, operationId, version, value => {
      if (!['reserved', 'proved'].includes(value.phase) || sourceSeal.sessionId !== value.operation.sourceBinding.runtimeSessionId) fail('conflict', 'Unexpected lineage join stage')
      if (value.proof && (!matchesSeal(sourceSeal, value.proof.sourceAfterHead) || !targetSeal || !matchesSeal(targetSeal, value.proof.targetHead))) fail('integrity-error', 'Actual joined bytes differ from the native lineage proof')
      this.db.prepare('UPDATE runtimes SET owner_hash=NULL,seal=?,selected_head=? WHERE conversation_id=?')
        .run(canonical(sourceSeal), value.proof ? canonical(value.proof.sourceAfterHead) : null, value.operation.sourceBinding.conversationId)
      return this.bump({ ...value, phase: 'joined', closedSourceSeal: sourceSeal, ...(targetSeal ? { closedTargetSeal: targetSeal } : {}) }, value.operation.state)
    }, false)
  }

  /** install is synchronous, bounded and exclusive under this same cross-process
   * transaction. The caller verifies/copies immutable SDK bytes and fsyncs before
   * this method can commit the installed state. No native factory runs here.
   */
  installed(actor: ProductActor, operationId: string, version: number, install: (record: NativeHandoffRecord) => { filename: string, seal: NativeSessionSeal }): NativeHandoffRecord {
    return this.mutate(actor, operationId, version, value => {
      this.owner(value)
      if (value.phase !== 'joined' || !value.proof || !value.targetBinding) fail('conflict', 'Lineage installation requires joined native proof')
      const result = install(structuredClone(value)); filename(result.filename); seal(result.seal)
      if (!matchesSeal(result.seal, value.proof.targetHead)) fail('integrity-error', 'Installed native target differs from its SDK proof')
      const target = value.targetBinding
      if (target.conversationId !== value.operation.sourceBinding.conversationId) {
        if (this.db.prepare('SELECT conversation_id FROM runtimes WHERE conversation_id=? OR session_id=?').get(target.conversationId, target.runtimeSessionId)) fail('conflict', 'Native fork target was already reserved by another runtime')
        this.db.prepare('INSERT INTO runtimes(conversation_id,binding_id,session_id,actor,workspace,filename,seal,binding_json,selected_head,handoff_id,lineage_configuration) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(target.conversationId, target.bindingId, target.runtimeSessionId, target.ownerActorId, target.workspaceId, result.filename, canonical(result.seal), canonical(target),
            canonical(value.proof.targetHead), operationId, canonical({ operationId, markerEntryId: value.proof.targetMarkerEntryId, configuration: value.proof.configuration }))
      }
      return this.bump({ ...value, phase: 'installed', targetFilename: result.filename, closedTargetSeal: result.seal }, 'handoff')
    })
  }
  bound(actor: ProductActor, operationId: string, version: number, commitBinding: (source: ProductBinding, target: ProductBinding) => void): NativeHandoffRecord {
    return this.mutate(actor, operationId, version, value => {
      this.owner(value)
      if (value.phase !== 'installed' || !value.proof || !value.targetBinding || !value.closedTargetSeal || !value.targetFilename) fail('conflict', 'Native target is not durably installed')
      commitBinding(structuredClone(value.operation.sourceBinding), structuredClone(value.targetBinding))
      const target = value.targetBinding
      if (target.conversationId === value.operation.sourceBinding.conversationId) {
        this.db.prepare('UPDATE runtimes SET binding_id=?,binding_json=?,filename=?,seal=?,selected_head=?,lineage_configuration=? WHERE conversation_id=?')
          .run(target.bindingId, canonical(target), value.targetFilename, canonical(value.closedTargetSeal), canonical(value.proof.targetHead),
            canonical({ operationId, markerEntryId: value.proof.targetMarkerEntryId, configuration: value.proof.configuration }), target.conversationId)
      } else {
        this.db.prepare('UPDATE runtimes SET lineage_configuration=? WHERE conversation_id=?').run(canonical({ operationId,
          markerEntryId: value.proof.sourceMarkerEntryId, configuration: value.proof.sourceConfiguration }), value.operation.sourceBinding.conversationId)
      }
      return this.bump({ ...value, phase: 'binding-committed' }, 'handoff')
    })
  }
  complete(actor: ProductActor, operationId: string, version: number, assertBinding: (target: ProductBinding) => void): NativeHandoffRecord {
    return this.mutate(actor, operationId, version, value => {
      if (value.phase !== 'binding-committed' || !value.proof || !value.targetBinding) fail('conflict', 'Native handoff is not installed and bound')
      this.owner(value, undefined, true); assertBinding(structuredClone(value.targetBinding))
      this.clearFence(value)
      return this.bump({ ...value, phase: 'complete' }, 'succeeded', { result: { proof: value.proof, targetBinding: value.targetBinding } })
    })
  }

  lineageLinks(actor: ProductActor, current: ProductBinding): ReadonlyArray<NativeLineageLink> {
    if (current.ownerActorId !== actor.actorId || current.workspaceId !== actor.workspaceId) return fail('not-found', 'Lineage history is unavailable')
    const links: NativeLineageLink[] = [], seen = new Set<string>()
    let binding = current
    for (;;) {
      if (seen.has(binding.bindingId) || links.length >= 64) fail('integrity-error', 'Native lineage is cyclic or exceeds its reviewed depth')
      seen.add(binding.bindingId)
      const matching = this.records(actor, binding.conversationId).filter(value => value.phase === 'complete' && value.operation.state === 'succeeded' && value.targetBinding !== undefined && same(value.targetBinding, binding))
      if (!matching.length) return Object.freeze(links)
      if (matching.length !== 1) fail('integrity-error', 'Native binding has ambiguous origin')
      const value = matching[0]!
      if (!value.proof || !value.targetBinding || !value.targetFilename) fail('integrity-error', 'Complete lineage lost its immutable origin')
      links.push(Object.freeze({ sourceBinding: structuredClone(value.operation.sourceBinding), targetBinding: structuredClone(value.targetBinding),
        proof: structuredClone(value.proof), sourceFilename: value.sourceFilename, targetFilename: value.targetFilename }))
      binding = value.operation.sourceBinding
    }
  }

  private change(claim: RuntimeClaim, operationId: string, version: number, update: (value: NativeHandoffRecord) => NativeHandoffRecord, retainOwner = true): NativeHandoffRecord {
    return this.mutate({ actorId: claim.binding.ownerActorId, workspaceId: claim.binding.workspaceId }, operationId, version, value => {
      this.owner(value, claim); const next = update(value); if (retainOwner) this.assertClaim(claim); return next
    })
  }
  private owner(value: NativeHandoffRecord, claim?: RuntimeClaim, rebound = false): void {
    const source = value.operation.sourceBinding, row = this.db.prepare('SELECT * FROM runtimes WHERE conversation_id=?').get(source.conversationId)
    if (!row || row.actor !== source.ownerActorId || row.workspace !== source.workspaceId || row.handoff_id !== value.operation.operationId
      || row.binding_id !== (rebound && value.targetBinding?.conversationId === source.conversationId ? value.targetBinding.bindingId : source.bindingId)) fail('conflict', 'Native handoff lost its runtime fence')
    if (claim) this.assertClaim(claim)
    else if (row.owner_hash !== null || !['joined', 'installed', 'binding-committed'].includes(value.phase)) fail('recovery-required', 'Native effects have not been durably joined')
    if (value.targetBinding && value.targetBinding.conversationId !== source.conversationId && ['installed', 'binding-committed'].includes(value.phase)) {
      const target = this.db.prepare('SELECT * FROM runtimes WHERE conversation_id=?').get(value.targetBinding.conversationId)
      if (!target || target.owner_hash !== null || target.handoff_id !== value.operation.operationId || target.binding_id !== value.targetBinding.bindingId
        || target.session_id !== value.targetBinding.runtimeSessionId || target.actor !== source.ownerActorId || target.workspace !== source.workspaceId) fail('recovery-required', 'Native fork target no longer has its exclusive installation fence')
    }
  }
  private clearFence(value: NativeHandoffRecord): void {
    this.db.prepare('UPDATE runtimes SET handoff_id=NULL WHERE handoff_id=?').run(value.operation.operationId)
  }
  private bump(value: NativeHandoffRecord, state: ProductLineageOperation['state'], detail: Partial<Pick<ProductLineageOperation, 'result' | 'failureProof' | 'errorCode'>> = {}): NativeHandoffRecord {
    return { ...value, operation: operation({ ...value.operation, state, version: value.operation.version + 1, updatedAt: this.now(),
      errorCode: state === 'outcome-unknown' || state === 'failed' ? value.operation.errorCode ?? 'execution-interrupted' : null, result: null, ...detail }) }
  }
  private mutate(actor: ProductActor, operationId: string, version: number, update: (value: NativeHandoffRecord) => NativeHandoffRecord): NativeHandoffRecord {
    return this.transaction(() => {
      const before = this.get(actor, operationId)
      if (before.operation.version !== version) fail('conflict', 'Native handoff version changed')
      const after = update(structuredClone(before))
      this.validate(after)
      const changed = this.db.prepare('UPDATE lineage_handoffs SET phase=?,record_json=?,record_hash=? WHERE operation_id=? AND record_hash=?')
        .run(after.phase, canonical(after), this.digest(after), operationId, this.digest(before))
      if (changed.changes !== 1) fail('conflict', 'Native handoff changed before commit')
      return structuredClone(after)
    })
  }
  private read(row: Row, actor: ProductActor): NativeHandoffRecord {
    if (row.actor !== actor.actorId || row.workspace !== actor.workspaceId) return fail('not-found', 'Lineage operation is not accessible')
    if (typeof row.record_json !== 'string' || Buffer.byteLength(row.record_json) > 262144) return fail('integrity-error', 'Invalid lineage journal size')
    let value: NativeHandoffRecord
    try { value = JSON.parse(row.record_json) as NativeHandoffRecord; this.validate(value) } catch { return fail('integrity-error', 'Invalid lineage journal record') }
    const source = value.operation.sourceBinding
    if (row.operation_id !== value.operation.operationId || row.source_conversation_id !== source.conversationId || row.source_binding_id !== source.bindingId
      || row.target_conversation_id !== value.targetConversationId || row.actor !== source.ownerActorId || row.workspace !== source.workspaceId
      || row.idempotency_key !== value.operation.request.idempotencyKey || row.request_hash !== value.operation.requestHash || row.phase !== value.phase
      || row.record_hash !== this.digest(value)) fail('integrity-error', 'Lineage journal columns or digest disagree')
    return structuredClone(value)
  }
  private validate(value: NativeHandoffRecord): void {
    if (!value || Object.keys(value).some(key => !['version', 'phase', 'operation', 'sourceFilename', 'targetConversationId', 'proof', 'forkFilename', 'targetFilename', 'targetBinding', 'closedSourceSeal', 'closedTargetSeal'].includes(key))
      || value.version !== 1 || !phases.includes(value.phase)) fail('integrity-error', 'Invalid private lineage journal shape')
    operation(value.operation); filename(value.sourceFilename)
    if (value.forkFilename !== undefined) filename(value.forkFilename)
    if (value.targetFilename !== undefined) filename(value.targetFilename)
    if (value.closedSourceSeal) seal(value.closedSourceSeal)
    if (value.closedTargetSeal) seal(value.closedTargetSeal)
    if (typeof value.targetConversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value.targetConversationId)
      || value.phase === 'complete' && !['succeeded', 'failed'].includes(value.operation.state)
      || value.operation.state === 'succeeded' && (value.phase !== 'complete' || !value.proof || !value.targetBinding || !value.closedSourceSeal || !value.closedTargetSeal || !value.targetFilename
        || !same(value.operation.result, { proof: value.proof, targetBinding: value.targetBinding }))
      || ['proved', 'installed', 'binding-committed'].includes(value.phase) && (!value.proof || !value.targetBinding)
      || ['joined', 'installed', 'binding-committed'].includes(value.phase) && !value.closedSourceSeal) fail('integrity-error', 'Lineage journal stage is inconsistent')
    if (value.proof) {
      const parsed = parseContract('native-lineage', { status: 'applied', proof: value.proof })
      if (nativeLineageIssues(parsed).length || value.proof.operationId !== value.operation.operationId || value.proof.requestHash !== value.operation.requestHash
        || !same(value.proof.beforeHead, value.operation.request.expectedHead) || !same(value.proof.action, value.operation.request.action)) fail('integrity-error', 'Private lineage proof changed identity')
    }
    if (value.targetBinding) {
      const parsed = parseContract('product-control', value.targetBinding)
      if (parsed.kind !== 'binding' || !value.proof || value.targetBinding.conversationId !== value.targetConversationId
        || value.targetBinding.ownerActorId !== value.operation.sourceBinding.ownerActorId || value.targetBinding.workspaceId !== value.operation.sourceBinding.workspaceId
        || value.targetBinding.runtimeSessionId !== value.proof.targetHead.fileSeal.sessionId || value.targetBinding.branchEntryId !== value.proof.targetHead.selectedLeafEntryId) fail('integrity-error', 'Lineage target binding is inconsistent')
    }
  }
  private digest(value: NativeHandoffRecord): string { return hash(canonical(value)) }
  private now(): string { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) return fail('integrity-error', 'Invalid lineage journal clock'); return new Date(value).toISOString() }
  private transaction<T>(run: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = run(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error } }
}
