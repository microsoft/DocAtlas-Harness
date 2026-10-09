import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { enrichmentHash, type EnrichmentModelPort } from '@docatlas/core'
import { createDocumentBackend, createNodeUvSidecarSpawner, documentSupervisorOptions, SidecarSupervisor, type ManagedDocumentBackend } from '@docatlas/runtime-document'
import type { EnrichmentStart } from '@docatlas/contracts'
import { DocumentApplication } from '../src/documents/application.js'
import { DocumentEnrichments } from '../src/documents/enrichments.js'
import { ControlStore } from '../src/storage/control-store.js'
import { EnrichmentJobs } from '../src/storage/enrichment-jobs.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Same small six-page/embedded-outline pattern as the browser's long PDF
 * fixture. Keep the server test inside its package root; no external corpus. */
function parallelPdf(): Buffer {
  const objects: string[] = [], add = (value: string) => { objects.push(value); return objects.length }
  const catalog = add(''), pages = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'), pageIds: number[] = []
  for (let page = 1; page <= 6; page++) {
    const lines = [`BT /F1 18 Tf 50 750 Td (Section ${page}: Experiment Results) Tj /F1 11 Tf`]
    for (let line = 0; line < 20; line++) lines.push(`0 -24 Td (Experiment ${page} observation ${line + 1}: calibrated sensors record repeatable measurements.) Tj`)
    lines.push('ET')
    const stream = lines.join('\n'), content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    pageIds.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
  }
  const outlines = add(''), entries = pageIds.map(() => add(''))
  for (let index = 0; index < entries.length; index++) objects[entries[index]! - 1] = `<< /Title (Section ${index + 1}) /Parent ${outlines} 0 R /Dest [${pageIds[index]} 0 R /FitH 792]${index ? ` /Prev ${entries[index - 1]} 0 R` : ''}${index + 1 < entries.length ? ` /Next ${entries[index + 1]} 0 R` : ''} >>`
  objects[outlines - 1] = `<< /Type /Outlines /First ${entries[0]} 0 R /Last ${entries.at(-1)} 0 R /Count ${entries.length} >>`
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /Outlines ${outlines} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`
  let output = '%PDF-1.4\n'; const offsets = [0]
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n` }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output)
}
function heldModel() {
  type Output = Awaited<ReturnType<EnrichmentModelPort['complete']>>
  type Call = { signal: AbortSignal, done: ReturnType<typeof Promise.withResolvers<Output>>, aborted: ReturnType<typeof Promise.withResolvers<void>>, joined: ReturnType<typeof Promise.withResolvers<void>> }
  const calls: Call[] = [], waiters: Array<{ count: number, done: ReturnType<typeof Promise.withResolvers<void>> }> = []
  let automatic = false, active = 0
  const response: Output = { text: '{"summary":"Verified source navigation only, not Evidence."}', inputTokens: 20, outputTokens: 10 }
  const port: EnrichmentModelPort = { identity: { provider: 'held-host-test', model: 'controlled-provider' }, complete(_prompt, _limits, signal) {
    const done = Promise.withResolvers<Output>(), aborted = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>()
    calls.push({ signal, done, aborted, joined }); active++
    if (signal.aborted) aborted.resolve(); else signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    for (const waiter of waiters.splice(0)) { if (calls.length >= waiter.count) waiter.done.resolve(); else waiters.push(waiter) }
    if (automatic) done.resolve(response)
    return done.promise.finally(() => { active--; joined.resolve() })
  } }
  return { port, calls, active: () => active, respond: (index: number) => calls[index]!.done.resolve(response),
    auto: () => { automatic = true }, release: () => { automatic = true; for (const call of calls) call.done.resolve(response) },
    wait: (count: number) => { if (calls.length >= count) return Promise.resolve(); const done = Promise.withResolvers<void>(); waiters.push({ count, done }); return done.promise } }
}

/** Real DocumentApplication, immutable PDF ingest, namespaced cache-only tree/page
 * workers, ControlStore and EnrichmentJobs. Only provider completion is held. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-enrichment-parallel-')), sourceRoot = join(root, 'sources')
  mkdirSync(sourceRoot); writeFileSync(join(sourceRoot, 'parallel.pdf'), parallelPdf())
  const actor = { actorId: 'actor:parallel', workspaceId: 'workspace:parallel' }, control = ControlStore.open(join(root, 'control'))
  const binding = control.createManagedConversation(actor, 'enrichment:parallel:conversation').binding
  const options = { projectRoot: resolve('python/docatlas-sidecar'), cacheRoot: join(root, 'cache'), sourceRoots: { 'root:source': sourceRoot } }
  const app = await DocumentApplication.create({ ...options, domainRoot: join(root, 'domain'), control, actor })
  const model = heldModel(), jobs = new EnrichmentJobs(join(root, 'jobs'))
  const backends: Array<{ backend: ManagedDocumentBackend, supervisor: SidecarSupervisor, joined: ReturnType<typeof Promise.withResolvers<void>> }> = []
  const factory = () => {
    const execution = { ...options, sourceRoots: {}, protectedRoots: [join(root, 'domain'), control.storageRoot] }
    const supervisor = new SidecarSupervisor(documentSupervisorOptions(createNodeUvSidecarSpawner(execution))), backend = createDocumentBackend(supervisor, execution), joined = Promise.withResolvers<void>()
    const abort = backend.abortAll.bind(backend)
    backend.abortAll = async () => { await abort(); joined.resolve() } // Delegate the real namespace/process join, never replace it.
    backends.push({ backend, supervisor, joined }); return backend
  }
  const service = new DocumentEnrichments(jobs, app.store, id => control.binding(actor, id), factory, model.port)
  cleanup.push(async () => { model.release(); await service.close(); await app.close(); jobs.close(); control.close(); rmSync(root, { recursive: true, force: true }) })
  const discovered = await app.library.discover({ schemaVersion: 1, requestType: 'library-discover', sessionId: binding.conversationId, workspaceId: actor.workspaceId, limit: 10 })
  expect(discovered.candidates).toHaveLength(1)
  app.library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: binding.conversationId, workspaceId: actor.workspaceId, candidateId: discovered.candidates[0]!.candidateId,
    sourceRole: 'primary', idempotencyKey: 'enrichment:parallel:import' })
  await app.library.whenIdle()
  const documents = app.store.listLibraryDocuments(actor.workspaceId)
  expect(documents, app.supervisor.stderrTail).toHaveLength(1)
  const document = documents[0]!, source = { documentId: document.documentId, revisionId: document.currentRevision.revisionId }
  const tree = await service.tree(binding.conversationId, source.documentId, source.revisionId, 'raw', new AbortController().signal)
  const parents = new Set(tree.tree.nodes.map(node => node.parentId)), leaves = tree.tree.nodes.filter(node => !parents.has(node.nodeId))
  expect(leaves.length).toBeGreaterThanOrEqual(2)
  const request = (key: string): EnrichmentStart => ({ schemaVersion: 1, kind: 'enrichment-start', idempotencyKey: `enrichment:parallel:${key}`, recipe: 'docatlas-flash-enrichment.v2',
    ...source, baseMode: 'raw', mode: 'summary', nodeIds: leaves.slice(0, 2).map(node => node.nodeId),
    budget: { maxNodes: 8, maxPages: 12, maxModelCalls: 8, maxInputChars: 50000, maxOutputTokens: 4096, maxOutputChars: 12000, wallMs: 60000 } })
  return { root, actor, binding, control, app, model, jobs, backends, service, request, scope: app.store.get(binding.conversationId) }
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('real host parallel-enrichment ownership, not model-quality evaluation', () => {
  it('retains cancelled-job capacity after document workers join until both actual provider calls settle, then admits a new sealed v2 job', async () => {
    const f = await fixture(), cid = f.binding.conversationId
    const first = f.service.accept(cid, f.request('first')), second = f.service.accept(cid, f.request('second')), third = f.service.accept(cid, f.request('third'))
    const firstRun = f.service.start(cid, first.jobId); await f.model.wait(2); const firstBackend = f.backends.at(-1)!
    const secondRun = f.service.start(cid, second.jobId); await f.model.wait(4)
    expect(f.model.active()).toBe(4); expect(() => f.service.start(cid, third.jobId)).toThrow('Two enrichment jobs')
    let cancelled = false
    const cancel = f.service.cancel(cid, first.jobId).finally(() => { cancelled = true })
    await Promise.all([firstBackend.joined.promise, f.model.calls[0]!.aborted.promise, f.model.calls[1]!.aborted.promise])
    expect(firstBackend.supervisor.state).toBe('stopped'); expect(firstBackend.backend.activeCount).toBe(0)
    expect(cancelled).toBe(false); expect(f.jobs.get(f.binding, first.jobId).state).toBe('generating')
    expect(() => f.service.start(cid, third.jobId)).toThrow('Two enrichment jobs')
    f.model.respond(0); await f.model.calls[0]!.joined.promise
    expect(cancelled).toBe(false); expect(() => f.service.start(cid, third.jobId)).toThrow('Two enrichment jobs')
    f.model.respond(1)
    expect(await cancel).toMatchObject({ state: 'cancelled', result: null }); expect(await firstRun).toEqual(await cancel)
    f.model.auto()
    const completed = await f.service.start(cid, third.jobId)
    expect(completed).toMatchObject({ state: 'completed', request: { recipe: 'docatlas-flash-enrichment.v2' }, result: { recipe: 'docatlas-flash-enrichment.v2', navigationOnly: true, usage: { calls: 2 } } })
    const { resultHash, ...unsigned } = completed.result!; expect(enrichmentHash(unsigned)).toBe(resultHash)
    expect(f.jobs.accept(f.binding, f.request('third'))).toEqual(completed)
    const secondCancel = f.service.cancel(cid, second.jobId); f.model.respond(2); f.model.respond(3)
    expect(await secondCancel).toMatchObject({ state: 'cancelled' }); await secondRun
    expect(f.model.active()).toBe(0); expect(f.app.store.get(cid)).toEqual(f.scope)
  }, 90000)

  it('does not persist a failed result or release its actual document backend before an abort-ignoring sibling has joined', async () => {
    const f = await fixture(), cid = f.binding.conversationId, job = f.service.accept(cid, f.request('failure'))
    let settled = false
    const run = f.service.start(cid, job.jobId).finally(() => { settled = true }); await f.model.wait(2)
    const backend = f.backends.at(-1)!
    f.model.calls[0]!.done.resolve({ text: 'invalid JSON', inputTokens: 1, outputTokens: 1 }); await f.model.calls[1]!.aborted.promise
    expect(settled).toBe(false); expect(f.model.active()).toBe(1); expect(f.jobs.get(f.binding, job.jobId)).toMatchObject({ state: 'generating', result: null })
    expect(backend.supervisor.state).toBe('ready')
    f.model.respond(1)
    expect(await run).toMatchObject({ state: 'failed', error: 'invalid-output', result: null })
    await backend.joined.promise; expect(backend.supervisor.state).toBe('stopped'); expect(backend.backend.activeCount).toBe(0)
    expect(await f.service.start(cid, job.jobId)).toMatchObject({ state: 'failed', error: 'invalid-output' })
    expect(f.model.calls).toHaveLength(2); expect(f.app.store.get(cid)).toEqual(f.scope)
  }, 60000)

  it('keeps host close pending even after the real PDF namespace stops, until every actual provider sibling joins', async () => {
    const f = await fixture(), cid = f.binding.conversationId, job = f.service.accept(cid, f.request('close'))
    const run = f.service.start(cid, job.jobId); await f.model.wait(2)
    const backend = f.backends.at(-1)!; let closed = false
    const closing = f.service.close().finally(() => { closed = true })
    await Promise.all([backend.joined.promise, ...f.model.calls.map(call => call.aborted.promise)])
    expect(closed).toBe(false); expect(backend.supervisor.state).toBe('stopped'); expect(f.jobs.get(f.binding, job.jobId).state).toBe('generating')
    expect(() => f.service.accept(cid, f.request('after-close'))).toThrow('closed')
    f.model.respond(1); await f.model.calls[1]!.joined.promise
    expect(closed).toBe(false); expect(f.jobs.get(f.binding, job.jobId).state).toBe('generating')
    f.model.respond(0); await closing
    expect(await run).toMatchObject({ state: 'cancelled', result: null }); expect(f.model.active()).toBe(0)
    expect(f.jobs.get(f.binding, job.jobId)).toMatchObject({ state: 'cancelled', result: null }); expect(f.app.store.get(cid)).toEqual(f.scope)
  }, 60000)
})
