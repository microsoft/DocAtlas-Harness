import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentOperations } from '@docatlas/core'
import { createPiDocumentTools, PiProductDriver } from '@docatlas/runtime-pi'
import { createPiTestRuntime } from '@docatlas/runtime-pi/testing'
import type { ProductSourceRef, ProductSubmission, ReadResult } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { ControlStore, DocumentApplication, SubmissionCoordinator } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'user:documents', workspaceId: 'workspace:documents' }, conversationId = 'conversation:documents'
const request = (key: string, refs: ProductSourceRef[]): ProductSubmission => ({ schemaVersion: 1, kind: 'submission', conversationId,
  idempotencyKey: `idempotency:${key}`, expectedGeneration: 1, mode: 'prompt', text: 'Inspect the approved source', sourceRefs: refs, selectionContextIds: [] })
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-document-integration-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'sources'), cwd = join(root, 'work'), agentDir = join(root, 'agent')
  for (const directory of [sourceRoot, cwd, agentDir]) mkdirSync(directory)
  writeFileSync(join(sourceRoot, 'report.pdf'), Buffer.from(readFileSync('apps/web/fixtures/sample-report.pdf.base64', 'utf8'), 'base64'))
  writeFileSync(join(sourceRoot, 'other.md'), '# Other source\n\nThis separate source describes satellites, not revenue.')
  const control = ControlStore.open(join(root, 'control')), sessionId = randomUUID()
  cleanup.push(() => control.close())
  control.createConversation(actor, { conversationId, runtimeSessionId: sessionId })
  const app = await DocumentApplication.create({ projectRoot: resolve('python/docatlas-sidecar'), cacheRoot: join(root, 'cache'), sourceRoots: { 'root:docs': sourceRoot },
    domainRoot: join(root, 'domain'), control, actor })
  cleanup.push(() => app.close())
  const discovered = await app.library.discover({ schemaVersion: 1, requestType: 'library-discover', sessionId: conversationId, workspaceId: actor.workspaceId, limit: 10 })
  for (const candidate of discovered.candidates) app.library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: conversationId, workspaceId: actor.workspaceId,
    candidateId: candidate.candidateId, sourceRole: 'primary', idempotencyKey: `import:${candidate.candidateId}` })
  await app.library.whenIdle()
  const documents = app.store.listLibraryDocuments(actor.workspaceId)
  expect(documents, `Sidecar state=${app.supervisor.state}: ${app.supervisor.stderrTail}`).toHaveLength(2)
  const pdf = documents.find(doc => doc.mediaType === 'application/pdf')!, other = documents.find(doc => doc.mediaType !== 'application/pdf')!
  const ref = (doc: typeof pdf): ProductSourceRef => ({ documentId: doc.documentId, revisionId: doc.currentRevision.revisionId })
  return { root, cwd, agentDir, sessionId, control, app, pdf: ref(pdf), other: ref(other) }
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('real document application and Pi bridge', () => {
  it('installs frozen search policy only at exact consumption and routes real tree nodes despite omitted model options', async () => {
    const { app, control, pdf } = await setup(), current = app.forConversation(conversationId)
    const complete = vi.fn(async () => ({ text: '{"schemaVersion":1,"kind":"tree-search-selection","nodes":[{"key":"n0","reason":"Financial report section"}]}', inputTokens: 30, outputTokens: 20 }))
    app.enableTreeSearch({ identity: { provider: 'test', model: 'tree-router' }, complete })
    const original = request('search-default-frame', [pdf])
    current.session.prepare(original, control.accept(actor, original).receipt).onConsumed()
    const explicit = { ...request('search-explicit-frame', [pdf]), documentSearch: { recipe: 'tree-search.v1' as const, strategy: 'tree' as const } }
    const prepared = current.session.prepare(explicit, control.accept(actor, explicit).receipt)
    const fields = { query: 'revenue', strategy: 'fts', limits: { maxItems: 10, maxChars: 6000 } }
    expect((await current.operations.search(fields)).searchExecution).toBeUndefined()
    expect(complete).not.toHaveBeenCalled()
    expect(current.session.invocation().searchPolicy).toBeUndefined()
    // The received request is not an authority to mutate a prepared frame later.
    Object.assign(explicit.documentSearch, { strategy: 'fts' })
    prepared.onConsumed()
    expect(current.session.invocation().searchPolicy?.strategy).toBe('tree')
    const result = await current.operations.search(fields)
    expect(result.searchExecution?.strategies).toEqual(['tree'])
    expect(result.result.candidates[0]).toMatchObject({ ...pdf, blockIds: [], matchKind: 'tree' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result.searchExecution?.treeRefs[0]?.nodeId).toContain(result.searchExecution!.treeRefs[0]!.generationId)
    const cleared = request('search-no-source-frame', [])
    current.session.prepare(cleared, control.accept(actor, cleared).receipt).onConsumed()
    await expect(current.operations.search(fields)).rejects.toThrow(/No document sources/)
  }, 60000)

  it('reads only explicitly completed fresh Flash overlays without activating queued source frames or rerunning models', async () => {
    const { app, control, pdf, other } = await setup(), current = app.forConversation(conversationId)
    const input = request('enrichment-active', [pdf])
    current.session.prepare(input, control.accept(actor, input).receipt).onConsumed()
    const activeScope = current.operations.sources().scope.scopeVersionId
    const complete = vi.fn(async () => ({ text: '{"summary":"Navigation summary only"}', inputTokens: 30, outputTokens: 10 }))
    const enrichments = app.enableEnrichments({ identity: { provider: 'test', model: 'fixture' }, complete })
    const signal = new AbortController().signal
    const base = await enrichments.tree(conversationId, pdf.documentId, pdf.revisionId, 'merge', signal)
    const job = enrichments.accept(conversationId, { schemaVersion: 1, kind: 'enrichment-start', idempotencyKey: 'enrichment:document-navigation', ...pdf,
      baseMode: 'merge', mode: 'summary', nodeIds: [base.tree.nodes[0]!.nodeId],
      budget: { maxNodes: 32, maxPages: 12, maxModelCalls: 8, maxInputChars: 50000, maxOutputTokens: 4096, maxOutputChars: 12000, wallMs: 60000 } })
    expect(await current.operations.enrichment(pdf.documentId, undefined, undefined, 0, 10, 12000)).toMatchObject({ total: 0 })
    await expect(current.operations.enrichment(pdf.documentId, undefined, job.jobId, 0, 10, 12000)).rejects.toThrow('never starts')
    expect(enrichments.get(conversationId, job.jobId).state).toBe('queued'); expect(complete).not.toHaveBeenCalled()
    const nextInput = request('enrichment-queued-frame', [other]), next = current.session.prepare(nextInput, control.accept(actor, nextInput).receipt)
    const done = await enrichments.start(conversationId, job.jobId)
    expect(done.state).toBe('completed'); const calls = complete.mock.calls.length
    expect(current.operations.sources().scope.scopeVersionId).toBe(activeScope)
    const list = await current.operations.enrichment(pdf.documentId, undefined, undefined, 0, 10, 12000)
    expect(list).toMatchObject({ kind: 'enrichment-list', total: 1, jobs: [{ jobId: job.jobId, resultHash: done.result!.resultHash }] })
    const page = await current.operations.enrichment(pdf.documentId, pdf.revisionId, job.jobId, 0, 10, 12000)
    expect(page).toMatchObject({ kind: 'enrichment-page', navigationOnly: true, resultHash: done.result!.resultHash })
    expect(await enrichments.start(conversationId, job.jobId)).toEqual(done); expect(complete).toHaveBeenCalledTimes(calls)
    const originalLookup = app.store.getEligibleLibrarySource.bind(app.store)
    const changed = vi.spyOn(app.store, 'getEligibleLibrarySource').mockImplementation((...args) => {
      const value = originalLookup(...args)
      return value?.documentId === pdf.documentId ? { ...value, representationContentHash: 'f'.repeat(64) } : value
    })
    expect(() => enrichments.get(conversationId, job.jobId)).toThrow('representation changed')
    expect(() => enrichments.accept(conversationId, job.request)).toThrow('representation changed')
    await expect(current.operations.enrichment(pdf.documentId, undefined, job.jobId, 0, 10, 12000)).rejects.toThrow('representation changed')
    changed.mockRestore()
    const originalRepresentations = app.store.getLibraryRepresentations.bind(app.store)
    const originalChanged = vi.spyOn(app.store, 'getLibraryRepresentations').mockImplementation((...args) => originalRepresentations(...args).map(value => value.kind === 'original-bytes' ? { ...value, contentHash: 'e'.repeat(64) } : value))
    expect(() => enrichments.get(conversationId, job.jobId)).toThrow('representation changed')
    expect(await current.operations.enrichment(pdf.documentId, undefined, undefined, 0, 10, 12000)).toMatchObject({ total: 0 })
    originalChanged.mockRestore()
    next.onConsumed()
    await expect(current.operations.enrichment(pdf.documentId, undefined, job.jobId, 0, 10, 12000)).rejects.toThrow('approved')
    expect(complete).toHaveBeenCalledTimes(calls)
  }, 60000)
  it('verifies complete multi-source groups and refuses a bad member, stale binding, forged quote or policy revocation', async () => {
    const { app, control, pdf, other } = await setup()
    const proposals = [{ ...pdf, physicalPage: 2, quote: 'Q4 15.2 +9%' }, { ...other, physicalPage: 1, quote: 'This separate source describes satellites, not revenue.' }]
    const stage = { schemaVersion: 1 as const, kind: 'selection-stage' as const, expectedGeneration: 1, idempotencyKey: 'selection:multi-source-test', proposals }
    const signal = new AbortController().signal
    await expect(app.selections.stage(conversationId, { ...stage, expectedGeneration: 2 }, () => {}, signal)).rejects.toThrow('generation')
    await expect(app.selections.stage(conversationId, { ...stage, proposals: [...proposals, { ...pdf, physicalPage: 2, quote: 'entirely fabricated quotation' }] }, () => {}, signal)).rejects.toThrow('missing or ambiguous')
    const ticket = await app.selections.stage(conversationId, stage, () => {}, signal)
    expect(ticket.items).toHaveLength(2)
    expect(app.selections.get(conversationId, ticket.selectionContextId).state).toBe('staged')
    expect(() => app.forConversation(conversationId).session.invocation()).toThrow('No document sources')
    const input = { ...request('selection-multi', [pdf, other]), selectionContextIds: [ticket.selectionContextId] }, receipt = control.accept(actor, input).receipt
    const prepared = await app.prepare({ request: input, receipt, signal })
    expect(prepared.modelText).toContain('satellites'); expect(prepared.prepared.selectionContextIds).toEqual([ticket.selectionContextId])
    expect(app.selections.get(conversationId, ticket.selectionContextId).state).toBe('bound')
    prepared.onConsumed?.(); expect(app.selections.get(conversationId, ticket.selectionContextId).state).toBe('consumed')
    await expect(app.prepare({ request: input, receipt, signal })).rejects.toThrow('consumed')
    const revoking = { ...stage, idempotencyKey: 'selection:revocation-test' }
    let checks = 0
    await expect(app.selections.stage(conversationId, revoking, () => { if (++checks >= 2) throw new Error('revoked actor') }, signal)).rejects.toThrow('revoked actor')
    expect(app.selections.tickets.existing(control.binding(actor, conversationId), revoking)).toBeUndefined()
    const late = await app.selections.stage(conversationId, { ...stage, idempotencyKey: 'selection:late-revoke-test' }, () => {}, signal)
    const lateInput = { ...request('selection-late-revoke', [pdf, other]), selectionContextIds: [late.selectionContextId] }
    const latePrepared = await app.prepare({ request: lateInput, receipt: control.accept(actor, lateInput).receipt, signal })
    const scope = app.store.get(conversationId).scope!
    app.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: conversationId, idempotencyKey: 'policy:selection-late-revoke', expectedScopeVersionId: scope.scopeVersionId,
      scope: { ...scope, scopeVersionId: 'scope:selection-late-revoke', previousScopeVersionId: scope.scopeVersionId, version: scope.version + 1,
        included: scope.included.filter(source => source.documentId !== other.documentId), excluded: [{ ...other, reason: 'policy' }] }, sources: app.store.get(conversationId).sources!.filter(source => source.documentId !== other.documentId) })
    expect(() => latePrepared.onConsumed?.()).toThrow('revoked')
    expect(app.selections.tickets.get(control.binding(actor, conversationId), late.selectionContextId).state).toBe('bound')
  }, 30000)
  it('imports, navigates Flash, searches, reads text/images and checkpoints the native Pi run', async () => {
    const { root, cwd, agentDir, sessionId, control, app, pdf } = await setup()
    const mapping = app.store.getEligibleLibrarySource(actor.workspaceId, pdf.documentId, pdf.revisionId)!
    const initialPage = await app.supervisor.call('read', { schemaVersion: 1, requestType: 'read', mode: 'page', source: { ...pdf, representationId: mapping.representationId }, physicalPage: 1, limits: { maxItems: 20, maxChars: 6000 } })
    const blockId = initialPage.items.find(item => item.itemType === 'block')!.locator.selectors.find(selector => selector.type === 'block')
    const firstBlock = initialPage.items.find(item => item.itemType === 'block')!
    expect(blockId).toBeDefined()
    const { runtime } = await createPiTestRuntime({ cwd, agentDir, sessionDir: join(root, 'sessions'), sessionId,
      customTools: createPiDocumentTools(() => app.forConversation(conversationId).operations),
      answers: [{ calls: [{ name: 'docatlas_sources', args: {} }, { name: 'docatlas_tree', args: { documentId: pdf.documentId, mode: 'merge' } }, { name: 'bash', args: { command: 'printf native-preserved' } }] },
        { calls: [{ name: 'docatlas_search', args: { query: 'revenue' } }] },
        { calls: [{ name: 'docatlas_read', args: { documentId: pdf.documentId, mode: 'page', physicalPage: 1 } },
          { name: 'docatlas_read', args: { documentId: pdf.documentId, mode: 'visual', physicalPage: 1, maxPixels: 250000 } }] },
        { calls: [{ name: 'docatlas_read', args: { documentId: pdf.documentId, mode: 'locate', query: 'revenue' } }, { name: 'docatlas_read', args: { documentId: pdf.documentId, mode: 'sequential', maxItems: 2 } }] },
        { calls: [{ name: 'docatlas_read', args: { documentId: pdf.documentId, mode: 'blocks', blockIds: [firstBlock.itemType === 'block' ? firstBlock.blockId : ''] } },
          { name: 'docatlas_read', args: { documentId: pdf.documentId, mode: 'expand', targetBlockId: firstBlock.itemType === 'block' ? firstBlock.blockId : '' } }] },
        'Test-provider response after actual document operations'] })
    cleanup.push(() => runtime.dispose())
    for (const name of ['read', 'bash', 'edit', 'write', 'docatlas_sources', 'docatlas_read', 'docatlas_tree']) expect(runtime.session.getActiveToolNames()).toContain(name)
    const driver = new PiProductDriver(runtime.session, app.forConversation(conversationId).backend)
    cleanup.push(() => driver.dispose())
    const coordinator = new SubmissionCoordinator(control, actor, conversationId, driver, app.prepare)
    cleanup.push(() => coordinator.close())
    const submitted = coordinator.submit(request('real-pdf', [pdf]))
    await coordinator.waitForIdle()
    expect(control.get(actor, submitted.receipt.submissionId)).toMatchObject({ state: 'completed', checkpoint: { runtimeSessionId: sessionId } })
    const results = runtime.session.sessionManager.getEntries().flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : [])
    expect(results).toHaveLength(10)
    expect(results.map(result => ({ name: result.toolName, error: result.isError, text: result.content[0] }))).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'docatlas_tree', error: false })]))
    expect(results.filter(result => result.isError).map(result => ({ tool: result.toolName, content: result.content }))).toEqual([])
    const read = results.find(result => result.content.some(item => item.type === 'image'))!
    expect(read).toBeDefined()
    const image = read.content.find(item => item.type === 'image')!
    const text = read.content.find(item => item.type === 'text')!
    const value = JSON.parse(text.type === 'text' ? text.text : '') as ReadResult
    const visual = value.items.find(item => item.itemType === 'visual')!
    expect(image.type === 'image' ? createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex') : '').toBe(visual.itemType === 'visual' ? visual.asset.contentHash : '')
    const meta = parseContract('docatlas-tool-meta', read.details)
    expect(meta.locators?.[0]?.documentId).toBe(pdf.documentId)
    expect(meta.scopeVersionId).toBe(app.forConversation(conversationId).operations.sources().scope.scopeVersionId)
  }, 60000)

  it('stages without changing an active frame, rejects partial admission and suppresses stale results', async () => {
    const { control, app, pdf, other } = await setup()
    const session = app.forConversation(conversationId).session
    const a = request('frame-a', [pdf]), b = request('frame-b', [other])
    const pa = session.prepare(a, control.accept(actor, a).receipt)
    expect(pa.modelText).toContain('docatlas-current-attachments')
    expect(pa.modelText).toContain(pdf.documentId); expect(pa.modelText).not.toContain(other.documentId)
    expect(() => session.invocation()).toThrow('No document')
    pa.onConsumed()
    const pb = session.prepare(b, control.accept(actor, b).receipt)
    expect(pb.modelText).toContain(other.documentId); expect(pb.modelText).not.toContain(pdf.documentId)
    expect(session.invocation().source(pdf.documentId).revisionId).toBe(pdf.revisionId)
    const bad = request('frame-bad', [pdf, { documentId: 'doc:missing', revisionId: 'rev:missing' }])
    const previous = app.store.get(conversationId).scope?.scopeVersionId
    expect(() => session.prepare(bad, control.accept(actor, bad).receipt)).toThrow('not eligible')
    expect(app.store.get(conversationId).scope?.scopeVersionId).toBe(previous)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const delayed = new DocumentOperations(session, { ...app.forConversation(conversationId).backend, call: async (method, input, signal) => {
      const result = await app.forConversation(conversationId).backend.call(method, input, signal); started.resolve(); await release.promise; return result
    } })
    const reading = delayed.read(pdf.documentId, undefined, { mode: 'page', physicalPage: 1, limits: { maxItems: 20, maxChars: 6000 } })
    const rejected = expect(reading).rejects.toThrow('changed')
    await started.promise; pb.onConsumed(); release.resolve(); await rejected
    await expect(delayed.read(pdf.documentId, undefined, { mode: 'sequential', limits: { maxItems: 1, maxChars: 100 } })).rejects.toThrow('approved')
    const noDocs = request('frame-none', [])
    const withoutDocuments = session.prepare(noDocs, control.accept(actor, noDocs).receipt)
    expect(withoutDocuments.modelText).toBe(noDocs.text)
    withoutDocuments.onConsumed()
    expect(() => session.invocation()).toThrow('No document')
    expect(() => app.forConversation('conversation:foreign')).toThrow()
    control.createConversation({ ...actor, actorId: 'user:someone-else' }, { conversationId: 'conversation:foreign-owner', runtimeSessionId: randomUUID() })
    expect(() => app.forConversation('conversation:foreign-owner')).toThrow()
  }, 30000)

  it('waits for tree cancellation and restarts the document process for the next operation', async () => {
    const { control, app, pdf } = await setup()
    const input = request('cancel-tree', [pdf])
    app.forConversation(conversationId).session.prepare(input, control.accept(actor, input).receipt).onConsumed()
    const controller = new AbortController()
    const work = app.forConversation(conversationId).operations.tree(pdf.documentId, undefined, 'merge', 0, 10, controller.signal)
    const rejected = expect(work).rejects.toThrow()
    await vi.waitFor(() => expect(app.forConversation(conversationId).backend.activeCount).toBeGreaterThan(0))
    controller.abort(); await app.forConversation(conversationId).backend.abortAll(); await rejected
    expect(app.forConversation(conversationId).backend.activeCount).toBe(0); expect(app.forConversation(conversationId).supervisor.state).toBe('stopped')
    app.forConversation(conversationId).backend.resume()
    const result = await app.forConversation(conversationId).operations.read(pdf.documentId, undefined, { mode: 'page', physicalPage: 1, limits: { maxItems: 20, maxChars: 6000 } })
    expect(result.result.items.length).toBeGreaterThan(0)
  }, 30000)

  it('cancellation is conversation-local and obsolete Pi session IDs cannot use a rebound context', async () => {
    const { control, app, pdf, other } = await setup()
    const secondId = 'conversation:second'
    control.createConversation(actor, { conversationId: secondId, runtimeSessionId: randomUUID() })
    const a = request('isolated-a', [pdf]), b = { ...request('isolated-b', [other]), conversationId: secondId }
    const first = app.forConversation(conversationId), second = app.forConversation(secondId)
    first.session.prepare(a, control.accept(actor, a).receipt).onConsumed()
    const secondReceipt = control.accept(actor, b).receipt
    second.session.prepare(b, secondReceipt).onConsumed()
    await second.operations.read(other.documentId, undefined, { mode: 'sequential', limits: { maxItems: 2, maxChars: 1000 } })
    await first.backend.abortAll()
    expect(second.supervisor.state).toBe('ready')
    expect((await second.operations.read(other.documentId, undefined, { mode: 'sequential', limits: { maxItems: 2, maxChars: 1000 } })).result.items.length).toBeGreaterThan(0)
    const binding = control.binding(actor, secondId)
    await second.backend.abortAll()
    control.requestCancel(actor, secondReceipt.submissionId, secondReceipt.version)
    control.rebind(actor, secondId, binding.version, randomUUID(), null)
    expect(() => second.operations.sources()).toThrow('stale')
    expect(() => app.forConversation(secondId).operations.assertRuntime(binding.runtimeSessionId)).toThrow('Native session')
  }, 30000)

  it('rejects forged representation hashes and modified image bytes', async () => {
    const { control, app, pdf } = await setup(), current = app.forConversation(conversationId)
    const input = request('forged', [pdf])
    current.session.prepare(input, control.accept(actor, input).receipt).onConsumed()
    const bad = new DocumentOperations(current.session, { ...current.backend, call: async (method, request, signal) => {
      const result = structuredClone(await current.backend.call(method, request, signal))
      if (result.resultType === 'read') for (const item of result.items) item.locator.representationContentHash = 'f'.repeat(64)
      return result
    } })
    await expect(bad.read(pdf.documentId, undefined, { mode: 'page', physicalPage: 1, limits: { maxItems: 20, maxChars: 6000 } })).rejects.toThrow('validation')
    const changed = new DocumentOperations(current.session, { ...current.backend, visualAsset: async (...args) => {
      const asset = await current.backend.visualAsset(...args)
      asset.bytes = Uint8Array.from(asset.bytes); asset.bytes[0] = asset.bytes[0]! ^ 1
      return asset
    } })
    await expect(changed.read(pdf.documentId, undefined, { mode: 'visual', physicalPage: 1, maxPixels: 10000, limits: { maxItems: 1, maxChars: 1 } })).rejects.toThrow('validation')
  }, 30000)

  it('does not let queued user selection override a policy exclusion', async () => {
    const { control, app, pdf, other } = await setup(), session = app.forConversation(conversationId).session
    const initial = request('policy-initial', [pdf])
    session.prepare(initial, control.accept(actor, initial).receipt).onConsumed()
    const current = app.store.get(conversationId)
    const scope = current.scope!
    app.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: conversationId, idempotencyKey: 'policy:exclude', expectedScopeVersionId: scope.scopeVersionId,
      scope: { ...scope, scopeVersionId: 'scope:policy-exclusion', previousScopeVersionId: scope.scopeVersionId, version: scope.version + 1,
        excluded: [{ ...other, reason: 'policy' }] }, sources: current.sources })
    const blocked = request('policy-blocked', [other])
    expect(() => session.prepare(blocked, control.accept(actor, blocked).receipt)).toThrow('Policy-excluded')
    expect(app.store.get(conversationId).scope?.scopeVersionId).toBe('scope:policy-exclusion')
    const same = request('policy-preserved', [pdf])
    session.prepare(same, control.accept(actor, same).receipt)
    expect(app.store.get(conversationId).scope?.excluded).toContainEqual({ ...other, reason: 'policy' })
  }, 30000)

  it('continues a shared Investigation without resetting its source version or another active frame', async () => {
    const { control, app, pdf, other } = await setup(), first = app.forConversation(conversationId)
    const a = request('shared-a', [pdf])
    first.session.prepare(a, control.accept(actor, a).receipt).onConsumed()
    const existing = first.operations.sources().scope
    const secondId = 'conversation:shared-investigation'
    control.createConversation(actor, { conversationId: secondId, runtimeSessionId: randomUUID(), investigationId: existing.investigationId })
    const second = app.forConversation(secondId), b = { ...request('shared-b', [other]), conversationId: secondId }
    second.session.prepare(b, control.accept(actor, b).receipt).onConsumed()
    expect(second.operations.sources().scope).toMatchObject({ investigationId: existing.investigationId, version: existing.version + 1, previousScopeVersionId: existing.scopeVersionId })
    expect(first.operations.sources().scope.scopeVersionId).toBe(existing.scopeVersionId)
    expect(first.session.invocation().source(pdf.documentId)).toMatchObject(pdf)
  }, 30000)
})
