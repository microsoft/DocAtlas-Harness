import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { ResearchOperations, SourceScopeStore, type ResearchInvocation, type ResearchOperationsPort, type ResearchRecordLineage } from '@docatlas/core'
import { createPiDocumentTools, type DocumentToolOperations } from '../src/document-tools.js'
import { documentBroker, remoteDocuments } from '../src/worker/document-bridge.js'
import { WorkerPeer, WorkerRpcError } from '../src/worker/peer.js'
import { createPiTestRuntime } from '../src/testing.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-research-bridge-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = await SourceScopeStore.open(join(root, 'domain')); cleanup.push(() => store.close())
  const sessionId = '00000000-0000-4000-8000-000000000001', lineage: ResearchRecordLineage[] = []
  let permitted = true
  const active: ResearchInvocation = { conversationId: 'conversation:research', runtimeSessionId: sessionId, submissionId: 'submission:research', workspaceId: 'workspace:research',
    investigationId: 'investigation:research', scopeVersionId: 'scope:research:empty', currentSources: [], assertCurrent: () => { if (!permitted) throw new Error('revoked') }, authorizeRecord() {}, authorizeRecall() {} }
  const port: ResearchOperationsPort = { recordResearch: (request, provenance, check) => { check(); lineage.push(structuredClone(provenance)); return store.recordResearch(request) },
    recallResearch: (request, sources, check) => { check(); return store.recallResearch(request, sources) } }
  const research = new ResearchOperations(port, () => active), noDocuments = () => { throw new Error('No document scope, independent of the research frame') }
  const host: DocumentToolOperations = { assertRuntime: id => { if (id !== sessionId) throw new WorkerRpcError('denied') }, sources: noDocuments, search: noDocuments, read: noDocuments, tree: noDocuments, enrichment: noDocuments,
    record: research.record.bind(research), recall: research.recall.bind(research) }
  const a = new PassThrough(), b = new PassThrough(), authorize = () => { if (!permitted) throw new WorkerRpcError('denied') }
  const hostPeer = new WorkerPeer(a, b, new Map([['document.call', documentBroker(host, authorize)]]), () => {}), workerPeer = new WorkerPeer(b, a, new Map(), () => {})
  cleanup.push(() => { hostPeer.close(); workerPeer.close() })
  return { root, sessionId, store, active, host, port, lineage, hostPeer, workerPeer, remote: remoteDocuments(workerPeer, sessionId), revoke: () => { permitted = false } }
}

it('preserves native call identity across IPC, retries idempotently, and returns only unverified recall leads', async () => {
  const f = await fixture(), args = { kind: 'checkpoint', body: 'Margin investigation remains open.' }
  const first = await f.remote.record!('call:read|fc_native', args)
  expect(first.status).toBe('created')
  expect(await f.remote.record!('call:read|fc_native', args)).toEqual({ ...first, status: 'replayed' })
  expect(f.lineage.map(item => item.nativeToolCallId)).toEqual(['call:read|fc_native', 'call:read|fc_native'])
  const leads = await f.remote.recall!({ query: 'margin', maxItems: 1, maxChars: 20 })
  expect(leads.leads).toHaveLength(1); expect(leads.leads[0]).toMatchObject({ verificationStatus: 'unverified-lead', sourceState: 'none' })
  expect(f.active.currentSources).toEqual([])
  await expect(f.remote.record!('call:read|fc_native', { ...args, body: 'Conflicting revision' })).rejects.toThrow()
})

it('rejects forged runtime identity, record authority fields and unknown write operations at the inherited-pipe boundary', async () => {
  const f = await fixture(), fields = { kind: 'checkpoint', body: 'must not write' }
  await expect(f.workerPeer.call('document.call', { operation: 'record', sessionId: 'runtime:forged', toolCallId: 'call:bad', fields })).rejects.toMatchObject({ code: 'denied' })
  await expect(f.remote.record!('call:bad', { ...fields, workspaceId: 'workspace:forged' })).rejects.toThrow()
  await expect(f.remote.record!('call:decision', { kind: 'project-decision', body: 'An agent cannot decide as the user' })).rejects.toThrow()
  await expect(f.workerPeer.call('document.call', { operation: 'profile', sessionId: f.sessionId, fields: {} })).rejects.toMatchObject({ code: 'denied' })
  expect(f.lineage).toEqual([])
  f.revoke()
  await expect(f.remote.recall!({ query: 'margin' })).rejects.toMatchObject({ code: 'denied' })
})

it('does not release an interrupted research handler before its guarded async port settles', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.port.recordResearch = async (request, _lineage, check) => { entered.resolve(); await release.promise; check(); return f.store.recordResearch(request) }
  const controller = new AbortController(), work = f.remote.record!('call:cancel', { kind: 'checkpoint', body: 'Cancelled pending write' }, controller.signal)
  const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' })
  await entered.promise; controller.abort(); await rejected
  expect(f.hostPeer.activeCount).toBe(1)
  release.resolve(); await f.hostPeer.quiesce()
  expect(f.hostPeer.activeCount).toBe(0)
  expect((await f.remote.recall!({ query: 'cancelled' })).leads).toEqual([])
})

it('runs Record and Recall in Pi while keeping all native tools and document tools registered for ordinary tasks', async () => {
  const f = await fixture(), cwd = join(f.root, 'work'), agentDir = join(f.root, 'agent')
  mkdirSync(cwd); mkdirSync(agentDir)
  const { runtime } = await createPiTestRuntime({ cwd, agentDir, sessionDir: join(f.root, 'sessions'), sessionId: f.sessionId, customTools: createPiDocumentTools(f.remote),
    answers: [{ calls: [{ name: 'docatlas_record', args: { kind: 'open-question', question: 'How should margin be compared?' } }] },
      { calls: [{ name: 'docatlas_recall', args: { query: 'margin' } }] }, 'A research lead was saved; it is not verified evidence.'] })
  cleanup.push(() => runtime.dispose())
  const registered = runtime.session.getAllTools().map(tool => tool.name)
  for (const name of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'docatlas_sources', 'docatlas_read', 'docatlas_tree', 'docatlas_enrichment', 'docatlas_record', 'docatlas_recall']) expect(registered).toContain(name)
  await runtime.session.prompt('Save the open research question and recall it. No document was selected.')
  const results = runtime.session.sessionManager.getEntries().flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : [])
  expect(results).toHaveLength(2); expect(results.every(result => !result.isError)).toBe(true)
  expect(f.lineage[0]!.nativeToolCallId).toBe(results[0]!.toolCallId)
  expect(results.map(result => result.toolName)).toEqual(['docatlas_record', 'docatlas_recall'])
})

it('keeps legacy adapters constructible without a research facet; missing research does not disable native tools', async () => {
  const f = await fixture(), without = { ...f.host }; delete without.record; delete without.recall
  const tools = createPiDocumentTools(without), record = tools.find(tool => tool.name === 'docatlas_record')!
  const context = { sessionManager: { getSessionId: () => f.sessionId } } as Parameters<typeof record.execute>[4]
  await expect(record.execute('call:absent', { kind: 'checkpoint', body: 'no facet' }, undefined, undefined, context)).rejects.toThrow('Research operation unavailable')
  expect(f.lineage).toEqual([])
})
