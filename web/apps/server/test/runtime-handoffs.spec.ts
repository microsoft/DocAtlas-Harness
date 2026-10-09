import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeConfiguration, NativeLineageFailureProof, NativeLineageProof, NativeSelectedHead, ProductLineageCommand } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'
import { RuntimeCatalog } from '../src/storage/runtime-catalog.js'
import type { NativeHandoffRecord } from '../src/storage/runtime-handoffs.js'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const actor = { actorId: 'actor:lineage-journal', workspaceId: 'workspace:lineage-journal' }
const configuration: NativeConfiguration = { model: { provider: 'faux', id: 'native-model' }, thinkingLevel: 'off', steeringMode: 'one-at-a-time', followUpMode: 'all' }
const closedSeal = (head: NativeSelectedHead, cwd: string) => { const { tailEntryId, ...value } = head.fileSeal; return { ...value, cwd, leafEntryId: tailEntryId } }
function fixture(kind: 'navigate' | 'fork' = 'navigate') {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-lineage-journal-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const source = control.createConversation(actor, { conversationId: 'conversation:lineage-journal', runtimeSessionId: 'native:lineage-parent' })
  const catalogRoot = join(root, 'catalog'), catalog = new RuntimeCatalog(catalogRoot); cleanup.push(() => catalog.close())
  const claim = catalog.claim(source); catalog.setFile(claim, 'parent.jsonl')
  const head: NativeSelectedHead = { version: 1, fileSeal: { version: 1, sessionId: source.runtimeSessionId, transcriptHash: 'a'.repeat(64), byteLength: 100, entryCount: 4, tailEntryId: 'entry:before' },
    selectedLeafEntryId: 'entry:before', contextHash: 'b'.repeat(64) }
  const request: ProductLineageCommand = { schemaVersion: 1, kind: 'lineage-command', conversationId: source.conversationId,
    expectedBindingId: source.bindingId, expectedGeneration: source.generation, runtimeSessionId: source.runtimeSessionId,
    approvalId: 'approval:lineage-journal', expectedApprovalVersion: 1, expectedHead: head, idempotencyKey: 'lineage:journal:original',
    action: kind === 'navigate' ? { kind: 'navigate', targetEntryId: 'entry:chosen', summarize: false, instructions: '', replaceInstructions: false, label: null }
      : { kind: 'fork', targetEntryId: 'entry:chosen', position: 'at' } }
  const inspect = (run: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(catalogRoot, 'runtime-catalog.sqlite3')); try { run(db) } finally { db.close() } }
  const proof = (record: NativeHandoffRecord): NativeLineageProof => {
    const sourceAfterHead: NativeSelectedHead = { version: 1, fileSeal: { ...head.fileSeal, transcriptHash: 'c'.repeat(64), byteLength: 400, entryCount: 6, tailEntryId: 'entry:source-terminal' },
      selectedLeafEntryId: 'entry:source-terminal', contextHash: head.contextHash }
    const base = { operationId: record.operation.operationId, requestHash: record.operation.requestHash, beforeHead: head, sourceAfterHead, intentEntryId: 'entry:intent',
      sourceMarkerEntryId: 'entry:source-terminal', sourceConfiguration: configuration, configuration }
    return request.action.kind === 'navigate' ? { ...base, kind: 'native-navigation-proof', action: request.action, targetHead: sourceAfterHead,
      targetMarkerEntryId: 'entry:source-terminal', landingEntryId: 'entry:chosen', summary: null }
      : { ...base, kind: 'native-fork-proof', action: request.action, targetHead: { version: 1,
        fileSeal: { version: 1, sessionId: 'native:sdk-child', transcriptHash: 'd'.repeat(64), byteLength: 350, entryCount: 3, tailEntryId: 'entry:child-terminal' },
        selectedLeafEntryId: 'entry:child-terminal', contextHash: 'e'.repeat(64) }, targetMarkerEntryId: 'entry:child-terminal',
      forkBasisSeal: { ...head.fileSeal, transcriptHash: 'f'.repeat(64), byteLength: 200, entryCount: 5, tailEntryId: 'entry:intent' }, inheritedEntryCount: 2, inheritanceHash: '1'.repeat(64) }
  }
  const begin = () => {
    const accepted = catalog.handoffs.accept(claim, request), applying = catalog.handoffs.applying(claim, accepted.operation.operationId, accepted.operation.version), result = proof(applying)
    const proved = catalog.handoffs.prove(claim, actor, applying.operation.operationId, applying.operation.version, { status: 'applied', proof: result }, kind === 'fork' ? 'fork.jsonl' : undefined)
    return { accepted, applying, proved, result }
  }
  const joined = (value: NativeHandoffRecord, result = value.proof!) => catalog.handoffs.joined(claim, value.operation.operationId, value.operation.version,
    closedSeal(result.sourceAfterHead, root), closedSeal(result.targetHead, root))
  const install = (value: NativeHandoffRecord) => catalog.handoffs.installed(actor, value.operation.operationId, value.operation.version, row => {
    inspect(db => { db.exec('PRAGMA busy_timeout=0'); expect(() => db.prepare('UPDATE runtimes SET owner_hash=owner_hash').run()).toThrow(/locked/u) })
    return { filename: kind === 'fork' ? 'fork.jsonl' : 'parent.jsonl', seal: closedSeal(row.proof!.targetHead, root) }
  })
  const bind = (value: NativeHandoffRecord) => catalog.handoffs.bound(actor, value.operation.operationId, value.operation.version, (before, target) => { control.commitNativeHandoff(actor, before, target) })
  const complete = (value: NativeHandoffRecord) => catalog.handoffs.complete(actor, value.operation.operationId, value.operation.version, target => { expect(control.binding(actor, target.conversationId)).toEqual(target) })
  return { root, control, catalog, claim, source, request, inspect, proof, begin, joined, install, bind, complete }
}

/** These are trusted-store shape/transaction fixtures, not fabricated native
 * acceptance: actual SDK byte/lineage and process verification has separate tests. */
describe('private native lineage journal and cross-database handoff fences', () => {
  it.each(['navigate', 'fork'] as const)('keeps %s fenced through actual join, exclusive installation and binding commit, then atomically publishes success plus immutable ancestry', kind => {
    const f = fixture(kind), { accepted, applying, proved, result } = f.begin()
    expect(f.catalog.handoffs.byKey(actor, f.source.conversationId, f.request.idempotencyKey)).toEqual(proved)
    expect(() => f.catalog.handoffs.installed(actor, proved.operation.operationId, proved.operation.version, () => { throw new Error('must not execute') })).toThrow()
    expect(() => f.catalog.claim(f.source)).toThrowError(expect.objectContaining({ code: 'recovery-required' }))
    const joined = f.joined(proved)
    expect(f.catalog.inspect(f.source)).toMatchObject({ active: true }) // Fence, not a claim that processes remain alive.
    expect(() => f.catalog.assertClaim(f.claim)).toThrow()
    const installed = f.install(joined), target = installed.targetBinding!
    expect(() => f.catalog.claim(target)).toThrow()
    expect(f.control.binding(actor, f.source.conversationId)).toEqual(f.source)
    const bound = f.bind(installed)
    expect(f.control.binding(actor, target.conversationId)).toEqual(target)
    expect(() => f.catalog.claim(target)).toThrow()
    const complete = f.complete(bound)
    expect(complete.operation).toMatchObject({ state: 'succeeded', result: { proof: result, targetBinding: target } })
    expect(f.catalog.handoffs.pending(actor, f.source.conversationId)).toBeUndefined()
    expect(f.catalog.historicalBindings(actor, target)).toEqual([f.source])
    expect(f.catalog.lineageLinks(actor, target)[0]).toMatchObject({ sourceBinding: f.source, targetBinding: target, proof: result, sourceFilename: 'parent.jsonl' })
    const nextClaim = f.catalog.claim(target)
    expect(nextClaim.selectedHead).toEqual(result.targetHead)
    expect(nextClaim.lineageConfiguration).toMatchObject({ markerEntryId: result.targetMarkerEntryId, configuration: result.configuration })
    f.catalog.release(nextClaim, closedSeal(result.targetHead, f.root), result.targetHead)
    expect(complete.operation.version).toBeGreaterThan(applying.operation.version)
    expect(accepted.operation.request).toEqual(f.request)
    if (kind === 'fork') expect(f.control.binding(actor, f.source.conversationId)).toEqual(f.source)
  })

  it.each(['navigate', 'fork'] as const)('rolls forward %s when ControlStore committed but the Catalog stage update failed, without allocating another binding or generation', kind => {
    const f = fixture(kind), { proved } = f.begin(), installed = f.install(f.joined(proved)), planned = installed.targetBinding!
    f.inspect(db => db.exec("CREATE TRIGGER injected_bound_fault BEFORE UPDATE ON lineage_handoffs WHEN NEW.phase='binding-committed' BEGIN SELECT RAISE(ABORT,'injected catalog commit fault'); END"))
    expect(() => f.bind(installed)).toThrow('injected catalog commit fault')
    expect(f.control.binding(actor, planned.conversationId)).toEqual(planned)
    expect(f.catalog.handoffs.get(actor, installed.operation.operationId)).toEqual(installed)
    expect(() => f.catalog.claim(planned)).toThrow()
    f.inspect(db => db.exec('DROP TRIGGER injected_bound_fault'))
    const completed = f.complete(f.bind(installed))
    expect(completed.operation.result?.targetBinding).toEqual(planned)
    expect(f.control.binding(actor, planned.conversationId).generation).toBe(planned.generation)
  })

  it('retains a joined unknown barrier across connections until an exact independent non-application proof arrives', () => {
    const f = fixture(), accepted = f.catalog.handoffs.accept(f.claim, f.request)
    const unknown = f.catalog.handoffs.unknown(f.claim, accepted.operation.operationId, accepted.operation.version)
    const afterHead = f.proof(unknown).sourceAfterHead
    const joined = f.catalog.handoffs.joined(f.claim, unknown.operation.operationId, unknown.operation.version, closedSeal(afterHead, f.root))
    expect(joined.operation.state).toBe('outcome-unknown')
    expect(() => f.catalog.claim(f.source)).toThrow()
    const failureProof: NativeLineageFailureProof = { kind: 'native-lineage-failure', operationId: unknown.operation.operationId, requestHash: unknown.operation.requestHash,
      action: f.request.action, beforeHead: f.request.expectedHead, afterHead, intentEntryId: 'entry:intent', markerEntryId: 'entry:source-terminal', reason: 'cancelled' }
    expect(() => f.catalog.handoffs.prove(undefined, actor, joined.operation.operationId, joined.operation.version,
      { status: 'not-applied', failureProof: { ...failureProof, requestHash: 'f'.repeat(64) } })).toThrow()
    expect(f.catalog.handoffs.get(actor, joined.operation.operationId)).toEqual(joined)
    const failed = f.catalog.handoffs.prove(undefined, actor, joined.operation.operationId, joined.operation.version, { status: 'not-applied', failureProof })
    expect(failed.operation).toMatchObject({ state: 'failed', result: null, failureProof })
    expect(f.catalog.handoffs.pending(actor, f.source.conversationId)).toBeUndefined()
  })

  it('protects claim authority, whole request identity and committed proof from replay or replacement', () => {
    const f = fixture(), { proved } = f.begin()
    expect(() => f.catalog.handoffs.accept({ ...f.claim, token: 'forged' }, f.request)).toThrow()
    expect(() => f.catalog.handoffs.accept(f.claim, { ...f.request, expectedApprovalVersion: 2 })).toThrow()
    expect(() => f.catalog.handoffs.get({ ...actor, actorId: 'actor:foreign' }, proved.operation.operationId)).toThrow()
    expect(() => f.catalog.handoffs.prove(f.claim, actor, proved.operation.operationId, proved.operation.version, { status: 'applied', proof: { ...proved.proof!, intentEntryId: 'entry:different-intent' } })).toThrow()
    expect(f.catalog.handoffs.get(actor, proved.operation.operationId)).toEqual(proved)
  })

  it.each(['phase', 'record_hash', 'source_conversation_id', 'runtime-fence'] as const)('does not let corrupted %s hide a pending handoff from new execution', field => {
    const f = fixture(); f.catalog.handoffs.accept(f.claim, f.request)
    f.inspect(db => field === 'runtime-fence' ? db.exec('UPDATE runtimes SET handoff_id=NULL')
      : db.prepare(`UPDATE lineage_handoffs SET ${field}=?`).run(field === 'phase' ? 'complete' : 'corrupted'))
    expect(() => f.catalog.handoffs.pending(actor, f.source.conversationId)).toThrow()
    expect(() => f.catalog.claim(f.source)).toThrow()
  })
})
