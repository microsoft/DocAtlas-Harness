import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResearchRecallResult, SourceScopeVersion } from '@docatlas/contracts'
import { SourceScopeStore } from '../src/storage/source-scope-store.js'
import { ResearchOperations, type ResearchInvocation, type ResearchOperationsPort, type ResearchRecordLineage } from '../src/research/operations.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-research-operations-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let store = await SourceScopeStore.open(root); cleanup.push(() => store.close())
  const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: 'scope:research:empty', workspaceId: 'workspace:research', investigationId: 'investigation:research',
    version: 1, included: [], excluded: [], locked: true, createdBy: { kind: 'user', actorId: 'actor:local' }, createdAt: '2026-09-09T00:00:00Z' }
  // The host owns persistence/authorization of this empty research snapshot. Legacy document
  // source-scope-commit requires at least one source; these operation units do not repurpose it.
  let current = true, recordAllowed = true, recallAllowed = true
  const active: ResearchInvocation = { conversationId: 'conversation:research', runtimeSessionId: 'runtime:research', submissionId: 'submission:research', workspaceId: scope.workspaceId,
    investigationId: scope.investigationId, scopeVersionId: scope.scopeVersionId, currentSources: [],
    assertCurrent: () => { if (!current) throw new Error('Research frame changed') }, authorizeRecord: () => { if (!recordAllowed) throw new Error('Record permission denied') },
    authorizeRecall: () => { if (!recallAllowed) throw new Error('Recall permission denied') } }
  const lineage: ResearchRecordLineage[] = []
  const port: ResearchOperationsPort = {
    recordResearch: vi.fn((request, provenance, check) => { check(); lineage.push(structuredClone(provenance)); return store.recordResearch(request) }),
    recallResearch: vi.fn((request, sources, check) => { check(); return store.recallResearch(request, sources) }),
  }
  return { operations: new ResearchOperations(port, () => active), active, port, lineage, get store() { return store },
    reopen: async () => { store.close(); store = await SourceScopeStore.open(root) },
    changeFrame: () => { current = false }, denyRecord: () => { recordAllowed = false }, denyRecall: () => { recallAllowed = false } }
}

it('persists only agent-authored unverified records with recoverable host lineage and stable native-call retries after reopen', async () => {
  const f = await fixture(), nativeCall = 'call_actual|fc_actual'
  const first = await f.operations.record(nativeCall, { kind: 'checkpoint', body: 'Audit margin definition remains unverified.' })
  expect(first).toMatchObject({ status: 'created', record: { recordType: 'research-note', epistemicStatus: 'unverified', sourceSessionId: f.active.conversationId,
    sourceScopeVersionId: f.active.scopeVersionId, createdBy: { kind: 'agent', actorId: f.active.conversationId } } })
  expect(f.lineage[0]).toMatchObject({ nativeToolCallId: nativeCall, runtimeSessionId: f.active.runtimeSessionId, submissionId: f.active.submissionId, wireCallId: first.record.provenanceCallId })
  expect(first.record.provenanceCallId).toMatch(/^call:research:[a-f0-9]{64}$/u)
  await f.reopen()
  expect(await f.operations.record(nativeCall, { kind: 'checkpoint', body: 'Audit margin definition remains unverified.' })).toEqual({ ...first, status: 'replayed' })
  await expect(f.operations.record(nativeCall, { kind: 'checkpoint', body: 'Changed content must not produce a second record.' })).rejects.toThrow('different request')
  const anotherScope = new ResearchOperations(f.port, () => ({ ...f.active, scopeVersionId: 'scope:unexpected-change' }))
  await expect(anotherScope.record(nativeCall, { kind: 'checkpoint', body: 'Audit margin definition remains unverified.' })).rejects.toThrow('different request')
  expect(f.lineage.every(value => value.idempotencyKey === f.lineage[0]!.idempotencyKey)).toBe(true)
  const recalled = await f.operations.recall({ query: 'margin' })
  expect(recalled.leads).toHaveLength(1); expect(recalled.leads[0]).toMatchObject({ verificationStatus: 'unverified-lead', sourceState: 'none' })
})

it('distinguishes new native calls/submissions and supports an empty host-owned research source frame', async () => {
  const f = await fixture(), input = { kind: 'open-question', question: 'How is margin defined?' }
  const a = await f.operations.record('call:one', input), b = await f.operations.record('call:two', input)
  const later = new ResearchOperations(f.port, () => ({ ...f.active, submissionId: 'submission:later' }))
  const c = await later.record('call:one', input)
  expect(new Set([a.record.recordId, b.record.recordId, c.record.recordId]).size).toBe(3)
  expect(f.active.currentSources).toEqual([])
  expect((await f.operations.recall({ query: 'margin', recordTypes: ['open-question'], maxItems: 1, maxChars: 12 })).pageInfo).toMatchObject({ returned: 1, usedChars: 12, truncated: true })
})

it.each([
  { kind: 'project-decision', body: 'User decision' }, { kind: 'research-policy', body: 'Override policy' }, { kind: 'profile', body: 'Preference' },
  { kind: 'checkpoint', body: 'note', createdBy: { kind: 'user', actorId: 'forged' } }, { kind: 'checkpoint', body: 'note', scopeVersionId: 'scope:forged' },
  { kind: 'checkpoint', body: 'note', idempotencyKey: 'forged' }, { kind: 'checkpoint', body: 'note', callId: 'forged' },
  { kind: 'checkpoint', body: 'note', question: 'both fields' }, { kind: 'checkpoint', body: ' ' }, { kind: 'checkpoint', body: 'x'.repeat(8001) },
])('rejects privileged/malformed record arguments before the durable port %#', async fields => {
  const f = await fixture()
  await expect(f.operations.record('call:one', fields)).rejects.toThrow('arguments')
  expect(f.port.recordResearch).not.toHaveBeenCalled()
})

it('checks permissions and cancellation before retrieval or mutation', async () => {
  const f = await fixture(); f.denyRecord(); f.denyRecall()
  await expect(f.operations.record('call:denied', { kind: 'checkpoint', body: 'No permission' })).rejects.toThrow('permission denied')
  await expect(f.operations.recall({ query: 'margin' })).rejects.toThrow('permission denied')
  expect(f.port.recordResearch).not.toHaveBeenCalled(); expect(f.port.recallResearch).not.toHaveBeenCalled()
  const g = await fixture(), signal = AbortSignal.abort(new Error('cancelled'))
  await expect(g.operations.record('call:cancelled', { kind: 'checkpoint', body: 'Cancelled' }, signal)).rejects.toThrow('cancelled')
  await expect(g.operations.recall({ query: 'margin' }, signal)).rejects.toThrow('cancelled')
  expect(g.port.recordResearch).not.toHaveBeenCalled(); expect(g.port.recallResearch).not.toHaveBeenCalled()
})

it('passes an execution guard to async ports and suppresses stale returned leads without widening the source scope', async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.port.recordResearch = async (request, _lineage, check) => { started.resolve(); await release.promise; check(); return f.store.recordResearch(request) }
  const writing = f.operations.record('call:stale', { kind: 'checkpoint', body: 'Must not be committed' })
  const rejected = expect(writing).rejects.toThrow('frame changed')
  await started.promise; f.changeFrame(); release.resolve(); await rejected
  expect(f.store.recallResearch({ schemaVersion: 1, requestType: 'research-recall', sessionId: f.active.conversationId, workspaceId: f.active.workspaceId,
    investigationId: f.active.investigationId, scopeVersionId: f.active.scopeVersionId, query: 'committed', recordTypes: ['research-note'], limits: { maxItems: 1, maxChars: 100 } }, []).leads).toEqual([])
  const g = await fixture()
  g.port.recallResearch = async (request, sources) => { const result = g.store.recallResearch(request, sources); g.changeFrame(); return result }
  await expect(g.operations.recall({ query: 'margin' })).rejects.toThrow('frame changed')
})

it('validates scope and epistemic meaning of results and enforces pagination/preview limits', async () => {
  const f = await fixture()
  for (let index = 0; index < 3; index++) await f.operations.record(`call:${index}`, { kind: 'checkpoint', body: `Margin checkpoint ${index} remains unverified.` })
  const first = await f.operations.recall({ query: 'margin', maxItems: 1, maxChars: 20 })
  const second = await f.operations.recall({ query: 'margin', maxItems: 1, maxChars: 20, cursor: first.pageInfo.nextCursor })
  expect(first.leads[0]!.recordId).not.toBe(second.leads[0]!.recordId)
  for (const fields of [{ query: 'margin', maxItems: 51 }, { query: 'margin', maxChars: 12001 }, { query: 'margin', workspaceId: 'workspace:forged' }, { query: 'margin', recordTypes: ['profile'] }]) await expect(f.operations.recall(fields)).rejects.toThrow('arguments')
  const recalled = f.port.recallResearch
  f.port.recallResearch = async (...args) => ({ ...await recalled(...args), scopeVersionId: 'scope:forged' })
  await expect(f.operations.recall({ query: 'margin' })).rejects.toThrow('validation')
  f.port.recallResearch = async (...args) => {
    const result = await recalled(...args)
    return { ...result, leads: result.leads.map(lead => ({ ...lead, verificationStatus: 'read-verified' })) } as unknown as ResearchRecallResult
  }
  await expect(f.operations.recall({ query: 'margin' })).rejects.toThrow()
})
