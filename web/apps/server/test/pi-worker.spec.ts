import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { createAzureLunaModel } from '@docatlas/runtime-pi'
import type { ReadResult } from '@docatlas/contracts'
import { ControlStore, DocumentApplication, IsolatedPiWorker, LinuxExecutor, ResourceStore, SubmissionCoordinator, prepareDocumentFree } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'user:worker', workspaceId: 'workspace:worker' }, conversationId = 'conversation:worker'
describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('isolated Pi and host brokers', () => {
  it('initializes the exact Azure Responses model through the isolated broker without acquiring credentials', async () => {
    const context = await fixture(), token = vi.fn(async () => 'offline-canary-token-not-real'), fetch = vi.fn(async () => { throw new Error('Initialization must not call a model') })
    const model = await createAzureLunaModel({ token, fetch }), diagnostics: string[] = []
    const worker = await IsolatedPiWorker.create({ ...context.config, ...model, resources: approveResources(context.root, context.config.agentDir), onDiagnostic: line => diagnostics.push(line) })
      .catch(error => { throw new Error(`Offline Responses worker init failed: ${diagnostics.join('')}`, { cause: error }) })
    cleanup.push(() => worker.dispose())
    expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(await worker.snapshot()).toBeDefined()
  }, 30000)
  it('round-trips actual Responses tool IDs through Sources, PDF Read, host attestation and citation publication offline', async () => {
    const context = await fixture(), sourceRoot = join(context.root, 'responses-sources')
    mkdirSync(sourceRoot); writeFileSync(join(sourceRoot, 'report.pdf'), Buffer.from(readFileSync('apps/web/fixtures/sample-report.pdf.base64', 'utf8'), 'base64'))
    const app = await DocumentApplication.create({ actor, control: context.control, domainRoot: join(context.privateRoot, 'responses-domain'), cacheRoot: join(context.root, 'responses-cache'),
      projectRoot: resolve('python/docatlas-sidecar'), sourceRoots: { docs: sourceRoot } })
    cleanup.push(() => app.close())
    const discovered = await app.library.discover({ schemaVersion: 1, requestType: 'library-discover', sessionId: conversationId, workspaceId: actor.workspaceId, limit: 10 })
    app.library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: conversationId, workspaceId: actor.workspaceId, candidateId: discovered.candidates[0]!.candidateId,
      idempotencyKey: 'responses:actual-pdf:import', sourceRole: 'primary' })
    await app.library.whenIdle()
    const document = app.store.listLibraryDocuments(actor.workspaceId)[0]!, source = { documentId: document.documentId, revisionId: document.currentRevision.revisionId }
    let calls = 0, read: ReadResult | undefined
    const model = await createAzureLunaModel({ token: async () => 'offline-responses-token-not-real', fetch: async input => {
      const payload = await (input as Request).json() as { input: Array<{ type?: string, name?: string, call_id?: string, output?: string }> }
      for (const output of payload.input.filter(item => item.type === 'function_call_output')) expect(payload.input.some(item => item.type === 'function_call' && item.call_id === output.call_id)).toBe(true)
      const output = payload.input.filter(item => item.type === 'function_call_output').at(-1)
      if (++calls === 1) return responsesFixture({ type: 'function_call', id: 'fc_sources', call_id: 'call_sources', name: 'docatlas_sources', arguments: '{}' })
      if (calls === 2) {
        expect(JSON.parse(output!.output!)).toMatchObject({ sources: [source] })
        return responsesFixture({ type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'docatlas_read', arguments: JSON.stringify({ documentId: source.documentId, mode: 'page', physicalPage: 2 }) })
      }
      if (calls !== 3) throw new Error('Unexpected extra model call')
      read = JSON.parse(output!.output!) as ReadResult
      expect(read).toMatchObject({ resultType: 'read', mode: 'page', source })
      const locator = read.items.find(item => item.itemType === 'block' && item.text.includes('15.2'))!.locator
      return responsesFixture({ type: 'message', id: 'msg_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `[Q4 revenue was 15.2.](#docatlas.v1.support.${locator.locatorId})`, annotations: [] }] })
    } })
    const documents = app.forConversation(conversationId), worker = await IsolatedPiWorker.create({ ...context.config, ...model, resources: approveResources(context.root, context.config.agentDir),
      documents: { operations: documents.operations, boundary: documents.backend, invalidate: () => documents.session.invalidate(), onCheckpoint: documents.onCheckpoint } })
    cleanup.push(() => worker.dispose())
    const coordinator = new SubmissionCoordinator(context.control, actor, conversationId, worker, app.prepare); cleanup.push(() => coordinator.close())
    const accepted = coordinator.submit({ ...submission('responses-documents'), sourceRefs: [source] })
    await coordinator.waitForIdle()
    const snapshot = await worker.snapshot() as { entries: Array<{ id: string, message?: { role: string, toolCallId?: string, toolName?: string, isError?: boolean, content?: unknown[] } }> }
    expect(context.control.get(actor, accepted.receipt.submissionId), JSON.stringify(snapshot)).toMatchObject({ state: 'completed' })
    const toolResults = snapshot.entries.filter(entry => entry.message?.role === 'toolResult')
    expect(toolResults.map(entry => ({ name: entry.message!.toolName, id: entry.message!.toolCallId, error: entry.message!.isError }))).toEqual([
      { name: 'docatlas_sources', id: 'call_sources|fc_sources', error: false }, { name: 'docatlas_read', id: 'call_read|fc_read', error: false },
    ])
    expect(calls).toBe(3); expect(read).toBeDefined()
    const message = snapshot.entries.filter(entry => entry.message?.role === 'assistant').at(-1)!
    expect(app.answers.get(conversationId, message.id)).toMatchObject({ status: 'available', manifest: { citations: [{ verificationStatus: 'read-verified' }] } })
  }, 60000)
  it('fences a failed exact-consumption callback before subsequent model frames are authorized', async () => {
    const context = await fixture(), model = await createPiTestModel({ answers: ['must not run'] })
    const worker = await IsolatedPiWorker.create({ ...context.config, ...model, resources: approveResources(context.root, context.config.agentDir) })
    cleanup.push(() => worker.dispose())
    const coordinator = new SubmissionCoordinator(context.control, actor, conversationId, worker, async input => ({ ...await prepareDocumentFree(input), onConsumed() { throw new Error('selection expired at consumption') } }))
    cleanup.push(() => coordinator.close())
    const accepted = coordinator.submit(submission('rejected-consumption'))
    await coordinator.waitForIdle(); await worker.stop()
    expect(context.control.get(actor, accepted.receipt.submissionId).state).toBe('outcome-unknown')
    expect(model.getCallCount()).toBe(0); expect(context.native.activeCount).toBe(0)
  }, 15000)
  it('executes actual native tools and a trusted extension, keeps the model on the host, and verifies the native checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docatlas-pi-worker-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const workspaceRoot = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'session'), outputDir = join(root, 'outputs'), privateRoot = join(root, 'private')
    for (const directory of [workspaceRoot, agentDir, privateRoot]) mkdirSync(directory)
    const secret = join(privateRoot, 'credential'), target = join(workspaceRoot, 'note.txt')
    writeFileSync(secret, 'PRIVATE_HOST_CANARY')
    mkdirSync(join(agentDir, 'extensions'))
    writeFileSync(join(agentDir, 'extensions', 'probe.ts'), `export default async function(pi) {
      const startup=await pi.exec(process.execPath,['-e',${JSON.stringify(`process.stdout.write(JSON.stringify({privateVisible:require('node:fs').existsSync(${JSON.stringify(sessionDir)}),arg:process.argv[1]}));process.stderr.write('separate stderr');process.exitCode=7`)},'literal ; $unsafe'],{cwd:${JSON.stringify(workspaceRoot)}});
      pi.registerTool({name:'probe_boundary',label:'Boundary test',description:'Test-only trusted extension',parameters:{type:'object',properties:{}},async execute(){const fs=await import('node:fs');
      let resourceWritable=false;try{fs.writeFileSync(${JSON.stringify(join(agentDir, 'extensions', 'probe.ts'))},'unapproved rewrite');resourceWritable=true}catch{}
      return {content:[{type:'text',text:JSON.stringify({pid:process.pid,privateVisible:fs.existsSync(${JSON.stringify(secret)}),secretEnv:!!process.env.DOCATLAS_WORKER_CANARY,startup,resourceWritable})}],details:{}};}});
    }`)
    const native = new LinuxExecutor({ workspaceRoot, scratchRoot: join(root, 'scratch'), outputRoot: outputDir, protectedRoots: [privateRoot, agentDir, sessionDir],
      rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()) })
    cleanup.push(() => native.abortAll())
    await native.preflight()
    const pids: number[] = []
    const model = await createPiTestModel({ beforeResponse: async () => { pids.push(process.pid) }, answers: [
      { calls: [{ name: 'write', args: { path: target, content: 'alpha\n' } }] },
      { calls: [{ name: 'edit', args: { path: target, oldText: 'alpha', newText: 'beta' } }] },
      { calls: [{ name: 'read', args: { path: target } }, { name: 'bash', args: { command: 'cat note.txt' } }, { name: 'probe_boundary', args: {} },
        { name: 'grep', args: { pattern: 'beta' } }, { name: 'find', args: { pattern: '*.txt' } }, { name: 'ls', args: {} }] },
      'Host-provider answer after isolated native operations',
    ] })
    const control = ControlStore.open(join(privateRoot, 'control')), sessionId = randomUUID()
    cleanup.push(() => control.close())
    control.createConversation(actor, { conversationId, runtimeSessionId: sessionId })
    const previous = process.env.DOCATLAS_WORKER_CANARY
    process.env.DOCATLAS_WORKER_CANARY = 'NOT_FOR_WORKER'
    const diagnostics: string[] = []
    const resources = approveResources(root, agentDir)
    writeFileSync(join(agentDir, 'auth.json'), 'UNAPPROVED_ORIGINAL_FILE')
    const worker = await IsolatedPiWorker.create({ workspaceRoot, agentDir, sessionDir, outputDir, sessionId, resources, protectedRoots: [privateRoot], native, ...model,
      authorize: () => { control.binding(actor, conversationId) }, onDiagnostic: line => diagnostics.push(line) }).catch(error => { throw new Error(diagnostics.join(''), { cause: error }) })
    if (previous === undefined) delete process.env.DOCATLAS_WORKER_CANARY; else process.env.DOCATLAS_WORKER_CANARY = previous
    cleanup.push(() => worker.dispose())
    expect((await native.readFile(join(agentDir, 'extensions', 'probe.ts'))).toString()).toContain('probe_boundary')
    await expect(native.readFile(join(agentDir, 'auth.json'))).rejects.toThrow()
    await expect(native.writeFile(join(agentDir, 'extensions', 'probe.ts'), 'rewrite')).rejects.toThrow()
    await worker.setActiveTools(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'probe_boundary'])
    const coordinator = new SubmissionCoordinator(control, actor, conversationId, worker, prepareDocumentFree)
    cleanup.push(() => coordinator.close())
    const accepted = coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: 1, idempotencyKey: 'idempotency:worker:test', mode: 'prompt', text: 'Write, edit, inspect and report', sourceRefs: [], selectionContextIds: [] })
    await coordinator.waitForIdle()
    expect(control.get(actor, accepted.receipt.submissionId), JSON.stringify(await worker.snapshot()) + diagnostics.join('')).toMatchObject({ state: 'completed', checkpoint: { runtimeSessionId: sessionId } })
    expect(readFileSync(target, 'utf8')).toBe('beta\n')
    expect(pids).toEqual([process.pid, process.pid, process.pid, process.pid])
    const snapshot = await worker.snapshot() as { entries: Array<{ message?: { role: string, toolName?: string, isError?: boolean, content?: Array<{ text?: string }> } }> }
    const results = snapshot.entries.flatMap(entry => entry.message?.role === 'toolResult' ? [entry.message] : [])
    expect(results).toHaveLength(8)
    expect(results.filter(result => result.isError !== false)).toEqual([])
    const probe = JSON.parse(results.find(result => result.toolName === 'probe_boundary')!.content![0]!.text!)
    expect(probe).toMatchObject({ privateVisible: false, secretEnv: false })
    expect(probe.resourceWritable).toBe(false)
    expect(probe.pid).not.toBe(process.pid)
    expect(probe.startup).toMatchObject({ code: 7, killed: false, stderr: 'separate stderr' })
    expect(JSON.parse(probe.startup.stdout)).toEqual({ privateVisible: false, arg: 'literal ; $unsafe' })
  }, 60000)
  it('waits for host model cancellation and resumes with a new submission', async () => {
    const started = Promise.withResolvers<void>()
    let calls = 0, aborted = false
    const context = await fixture()
    const model = await createPiTestModel({ answers: ['never accepted as success', 'resumed answer'], beforeResponse: async signal => {
      if (++calls !== 1) return
      started.resolve()
      await new Promise<void>((_resolve, reject) => { signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason) }, { once: true }) })
    } })
    const worker = await IsolatedPiWorker.create({ ...context.config, ...model, resources: approveResources(context.root, context.config.agentDir) })
    cleanup.push(() => worker.dispose())
    const coordinator = new SubmissionCoordinator(context.control, actor, conversationId, worker, prepareDocumentFree)
    cleanup.push(() => coordinator.close())
    const first = coordinator.submit(submission('cancel-first'))
    await started.promise
    await coordinator.cancel()
    expect(aborted).toBe(true)
    expect(context.native.activeCount).toBe(0)
    expect(context.control.get(actor, first.receipt.submissionId).state).toBe('cancelled')
    const next = coordinator.submit(submission('after-cancel'))
    await coordinator.waitForIdle()
    expect(context.control.get(actor, next.receipt.submissionId).state).toBe('completed')
  }, 30000)
  it('retains real scoped PDF/Flash/image operations across the isolated worker', async () => {
    const context = await fixture(), sourceRoot = join(context.root, 'sources'), cacheRoot = join(context.root, 'document-cache')
    mkdirSync(sourceRoot)
    writeFileSync(join(sourceRoot, 'report.pdf'), Buffer.from(readFileSync(resolve('apps/web/fixtures/sample-report.pdf.base64'), 'utf8'), 'base64'))
    const app = await DocumentApplication.create({ actor, control: context.control, domainRoot: join(context.privateRoot, 'domain'),
      cacheRoot, projectRoot: resolve('python/docatlas-sidecar'), sourceRoots: { docs: sourceRoot }, protectedRoots: [context.config.agentDir, context.config.sessionDir] })
    cleanup.push(() => app.close())
    const candidates = await app.library.discover({ schemaVersion: 1, requestType: 'library-discover', sessionId: conversationId, workspaceId: actor.workspaceId, limit: 10 })
    app.library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: conversationId, workspaceId: actor.workspaceId, candidateId: candidates.candidates[0]!.candidateId, idempotencyKey: 'worker:pdf:import', sourceRole: 'primary' })
    await app.library.whenIdle()
    const document = app.store.listLibraryDocuments(actor.workspaceId)[0]!
    const source = { documentId: document.documentId, revisionId: document.currentRevision.revisionId }
    const enrichments = app.enableEnrichments({ identity: { provider: 'test', model: 'navigation-fixture' }, complete: async () => ({ text: '{"summary":"Navigation summary only"}', inputTokens: 30, outputTokens: 10 }) })
    const tree = await enrichments.tree(conversationId, source.documentId, source.revisionId, 'merge', new AbortController().signal)
    const enrichment = enrichments.accept(conversationId, { schemaVersion: 1, kind: 'enrichment-start', idempotencyKey: 'worker:enrichment:import', ...source,
      baseMode: 'merge', mode: 'summary', nodeIds: [tree.tree.nodes[0]!.nodeId], budget: { maxNodes: 32, maxPages: 12, maxModelCalls: 8, maxInputChars: 50000, maxOutputTokens: 4096, maxOutputChars: 12000, wallMs: 60000 } })
    expect((await enrichments.start(conversationId, enrichment.jobId)).state).toBe('completed')
    const model = await createPiTestModel({ answers: [
      { calls: [{ name: 'docatlas_sources', args: {} }, { name: 'docatlas_tree', args: { documentId: source.documentId, mode: 'merge' } },
        { name: 'docatlas_enrichment', args: { documentId: source.documentId } }, { name: 'docatlas_enrichment', args: { documentId: source.documentId, jobId: enrichment.jobId } }] },
      { calls: [{ name: 'docatlas_search', args: { query: 'revenue' } }] },
      { calls: [{ name: 'docatlas_read', args: { documentId: source.documentId, mode: 'page', physicalPage: 1 } },
        { name: 'docatlas_read', args: { documentId: source.documentId, mode: 'visual', physicalPage: 1, maxPixels: 250000 } }] }, 'Document tools completed through the host',
    ] })
    const documents = app.forConversation(conversationId)
    const worker = await IsolatedPiWorker.create({ ...context.config, ...model, resources: approveResources(context.root, context.config.agentDir), documents: { operations: documents.operations, boundary: documents.backend, invalidate: () => documents.session.invalidate(), onCheckpoint: documents.onCheckpoint } })
    cleanup.push(() => worker.dispose())
    const coordinator = new SubmissionCoordinator(context.control, actor, conversationId, worker, app.prepare)
    cleanup.push(() => coordinator.close())
    const accepted = coordinator.submit({ ...submission('pdf'), sourceRefs: [source] })
    await coordinator.waitForIdle()
    expect(context.control.get(actor, accepted.receipt.submissionId)).toMatchObject({ state: 'completed' })
    const snapshot = await worker.snapshot() as { entries: Array<{ message?: { role: string, isError?: boolean, content?: Array<{ type: string, data?: string }> } }> }
    const results = snapshot.entries.flatMap(entry => entry.message?.role === 'toolResult' ? [entry.message] : [])
    expect(results).toHaveLength(7)
    expect(results.every(result => result.isError === false)).toBe(true)
    expect(results.flatMap(result => result.content ?? []).some(block => block.type === 'image' && Buffer.from(block.data!, 'base64').subarray(1, 4).toString() === 'PNG')).toBe(true)
  }, 60000)
  it('records an actual worker crash after a side effect as unknown without replay', async () => {
    const context = await fixture(), target = join(context.config.workspaceRoot, 'effect.txt')
    mkdirSync(join(context.config.agentDir, 'extensions'))
    writeFileSync(join(context.config.agentDir, 'extensions', 'crash.ts'), `export default function(pi){pi.registerTool({name:'crash_worker',label:'Crash test',description:'Test-only process crash',parameters:{type:'object',properties:{}},async execute(){process.kill(process.pid,'SIGKILL');return {content:[],details:{}}}})}`)
    const model = await createPiTestModel({ answers: [{ calls: [{ name: 'write', args: { path: target, content: 'one side effect' } }] }, { calls: [{ name: 'crash_worker', args: {} }] }, 'must not run'] })
    const worker = await IsolatedPiWorker.create({ ...context.config, ...model, resources: approveResources(context.root, context.config.agentDir) })
    cleanup.push(() => worker.dispose())
    const coordinator = new SubmissionCoordinator(context.control, actor, conversationId, worker, prepareDocumentFree)
    cleanup.push(() => coordinator.close())
    const accepted = coordinator.submit(submission('real-crash'))
    await coordinator.waitForIdle()
    expect(context.control.get(actor, accepted.receipt.submissionId)).toMatchObject({ state: 'outcome-unknown' })
    await worker.stop()
    expect(context.native.activeCount).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('one side effect')
    expect(model.getCallCount()).toBe(2)
  }, 30000)
  it('fences and stops a live runtime when its resource approval is revoked', async () => {
    const context = await fixture(), resources = approveResources(context.root, context.config.agentDir), entered = Promise.withResolvers<void>()
    let stopped = false
    const model = await createPiTestModel({ answers: ['must not complete'], beforeResponse: async signal => {
      entered.resolve()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => { stopped = true; reject(signal!.reason) }, { once: true }))
    } })
    const worker = await IsolatedPiWorker.create({ ...context.config, ...model, resources })
    cleanup.push(() => worker.dispose())
    const coordinator = new SubmissionCoordinator(context.control, actor, conversationId, worker, prepareDocumentFree)
    cleanup.push(() => coordinator.close())
    const accepted = coordinator.submit(submission('resource-revocation'))
    await entered.promise
    resources.store.revoke(actor, resources.approvalId)
    await coordinator.waitForIdle(); await worker.stop()
    expect(stopped).toBe(true)
    expect(context.control.get(actor, accepted.receipt.submissionId).state).toBe('outcome-unknown')
    expect(context.native.activeCount).toBe(0)
    await expect(IsolatedPiWorker.create({ ...context.config, ...model, resources })).rejects.toThrow('revoked')
  }, 30000)
  it('joins a Pi namespace when resource approval is revoked during startup', async () => {
    const context = await fixture(), resources = approveResources(context.root, context.config.agentDir)
    const lease = resources.store.lease.bind(resources.store)
    const spy = vi.spyOn(resources.store, 'lease').mockImplementation((...args) => {
      const result = lease(...args)
      return { ...result, subscribe(callback) {
        const off = result.subscribe(callback)
        resources.store.revoke(actor, resources.approvalId)
        return off
      } }
    })
    const model = await createPiTestModel({ answers: ['must never run'] })
    try { await expect(IsolatedPiWorker.create({ ...context.config, ...model, resources })).rejects.toThrow() }
    finally { spy.mockRestore() }
    expect(model.getCallCount()).toBe(0)
    expect(context.native.activeCount).toBe(0)
  }, 15000)
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-worker-case-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'session'), outputDir = join(root, 'outputs'), privateRoot = join(root, 'private')
  for (const directory of [workspaceRoot, agentDir, privateRoot]) mkdirSync(directory)
  const native = new LinuxExecutor({ workspaceRoot, scratchRoot: join(root, 'scratch'), outputRoot: outputDir, protectedRoots: [privateRoot, agentDir, sessionDir],
    rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()) })
  cleanup.push(() => native.abortAll())
  await native.preflight()
  const control = ControlStore.open(join(privateRoot, 'control')), sessionId = randomUUID()
  cleanup.push(() => control.close())
  control.createConversation(actor, { conversationId, runtimeSessionId: sessionId })
  return { root, privateRoot, control, native, config: { workspaceRoot, agentDir, sessionDir, outputDir, sessionId, protectedRoots: [privateRoot], native,
    authorize: () => { control.binding(actor, conversationId) } } }
}
function submission(key: string) { return { schemaVersion: 1 as const, kind: 'submission' as const, conversationId, expectedGeneration: 1, idempotencyKey: `idempotency:worker:${key}`, mode: 'prompt' as const, text: key, sourceRefs: [], selectionContextIds: [] } }
function responsesFixture(item: Record<string, unknown>): Response {
  const text = item.type === 'message' ? (item.content as Array<{ text: string }>)[0]!.text : ''
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: item.type === 'message' ? { ...item, content: [] } : item },
    ...(item.type === 'message' ? [{ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
function approveResources(root: string, source: string) {
  const store = new ResourceStore(join(root, 'approved-resources'), [join(root, 'private')])
  cleanup.push(() => store.close())
  const snapshot = store.capture(source), approval = store.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
  return { store, actor, approvalId: approval.approvalId }
}
