import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeLineageAction, ProductBinding, ProductLineageCommand, ProductLineageInspection, ProductSourceRef, ProductSubmission, TextBlockItem } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { ControlStore, DocumentApplication, ResourceStore, RuntimeCatalog, RuntimeManager } from '../src/index.js'
import { LineageHistoryAccess } from '../src/runs/lineage-history.js'

const actor = { actorId: 'actor:lineage-publications', workspaceId: 'workspace:lineage-publications' }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const navigate = (targetEntryId: string): NativeLineageAction => ({ kind: 'navigate', targetEntryId, summarize: false, instructions: '', replaceInstructions: false, label: null })
function command(view: ProductLineageInspection, action: NativeLineageAction, key: string): ProductLineageCommand {
  if (!view.head) throw new Error('Expected actual idle native selected head')
  return { schemaVersion: 1, kind: 'lineage-command', conversationId: view.binding.conversationId, expectedBindingId: view.binding.bindingId,
    expectedGeneration: view.binding.generation, runtimeSessionId: view.binding.runtimeSessionId, approvalId: view.resource.approvalId,
    expectedApprovalVersion: view.resource.version, expectedHead: view.head, idempotencyKey: key, action }
}
function toolResult(messages: readonly unknown[], name: string): unknown {
  const message = [...messages].reverse().find(value => value && typeof value === 'object' && Reflect.get(value, 'role') === 'toolResult' && Reflect.get(value, 'toolName') === name)
  if (!message || typeof message !== 'object' || Reflect.get(message, 'isError')) throw new Error(`Missing actual native ${name} result`)
  const content: unknown = Reflect.get(message, 'content')
  if (!Array.isArray(content)) throw new Error('Missing actual tool content')
  const text = content.find(value => value && typeof value === 'object' && value.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Missing actual native tool JSON')
  return JSON.parse(text)
}

/** One actual PDF import, Pi/Read/publication baseline and native nav+fork are shared.
 * Fault injections affect authorization/read ports or temporarily damage already
 * sealed files; no successful checkpoint, message, receipt, publication or proof is fabricated. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-lineage-publications-')), cleanup: Array<() => void | Promise<void>> = [() => rmSync(root, { recursive: true, force: true })]
  let closed = false
  const close = async () => { if (closed) return; closed = true; while (cleanup.length) await cleanup.pop()!() }
  try {
    const work = join(root, 'work'), agent = join(root, 'agent'), state = join(root, 'private'), sources = join(root, 'sources'), cache = join(root, 'document-cache')
    for (const path of [work, agent, state, sources]) mkdirSync(path)
    const pdfBytes = Buffer.from(readFileSync('apps/web/fixtures/sample-report.pdf.base64', 'utf8'), 'base64'); writeFileSync(join(sources, 'lineage-report.pdf'), pdfBytes)
    const control = ControlStore.open(join(state, 'control')); cleanup.push(() => control.close())
    const catalog = new RuntimeCatalog(join(state, 'catalog')); cleanup.push(() => catalog.close())
    const resources = new ResourceStore(join(root, 'resources'), [state]); cleanup.push(() => resources.close())
    const snapshot = resources.capture(agent), approval = resources.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
    const source = control.createManagedConversation(actor, 'create:actual-lineage-publications').binding
    const app = await DocumentApplication.create({ control, actor, projectRoot: resolve('python/docatlas-sidecar'), cacheRoot: cache, sourceRoots: { 'root:reports': sources },
      domainRoot: join(state, 'document-domain'), protectedRoots: [state, resources.root, join(root, 'runtimes')] }); cleanup.push(() => app.close())
    const discovered = await app.library.discover({ schemaVersion: 1, requestType: 'library-discover', sessionId: source.conversationId, workspaceId: actor.workspaceId, limit: 10 })
    expect(discovered.candidates).toHaveLength(1)
    app.library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: source.conversationId, workspaceId: actor.workspaceId,
      candidateId: discovered.candidates[0]!.candidateId, sourceRole: 'primary', idempotencyKey: 'import:actual-lineage-publication' }); await app.library.whenIdle()
    const documents = app.store.listLibraryDocuments(actor.workspaceId); expect(documents).toHaveLength(1)
    const document = documents[0]!, pdf: ProductSourceRef = { documentId: document.documentId, revisionId: document.currentRevision.revisionId }
    const ticket = await app.selections.stage(source.conversationId, { schemaVersion: 1, kind: 'selection-stage', expectedGeneration: source.generation,
      idempotencyKey: 'selection:actual-lineage-publications', proposals: [{ ...pdf, physicalPage: 2, quote: 'Q4 15.2 +9%' }] }, () => {}, new AbortController().signal)
    let phase: 'first' | 'second' | 'fresh' | 'naive' | 'filler' | 'short' = 'first', step = 0, filler = 0
    let firstBlock: TextBlockItem | undefined
    const respond = (messages: readonly unknown[]) => {
      if (phase === 'naive') return `[A retained context reference is not a new Read.](#docatlas.v1.support.${firstBlock!.locator.locatorId})`
      if (phase === 'filler') return `Actual cursor background ${++filler}: ${'x'.repeat(60000)}`
      if (phase === 'short') return 'A genuinely new short answer advances this native checkpoint.'
      if (step++ === 0) return { calls: [{ name: 'docatlas_sources', args: {} }] }
      if (step === 2) {
        const scope = toolResult(messages, 'docatlas_sources') as { sources: Array<{ documentId: string, revisionId: string }> }
        expect(scope.sources).toHaveLength(1); expect(scope.sources[0]).toMatchObject(pdf)
        return { calls: [{ name: 'docatlas_read', args: { ...pdf, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
      }
      const result = parseContract('sidecar-document-rpc', toolResult(messages, 'docatlas_read'))
      if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected actual page Read')
      const block = result.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]
      if (!block) throw new Error('The real PDF Read has no Q4 text')
      if (phase === 'first') firstBlock = block
      else expect(block.locator.locatorId).toBe(firstBlock!.locator.locatorId)
      return `[${phase === 'first' ? 'First genuine cited answer.' : phase === 'second' ? 'Second off-branch cited answer.' : 'Fresh child Read and cited answer.'}](#docatlas.v1.support.${block.locator.locatorId})`
    }
    const model = await createPiTestModel({ answers: Array.from({ length: 64 }, () => respond), tokenSize: 8192 })
    const manager = new RuntimeManager({ control, catalog, resources, ...model, actor, approvalId: approval.approvalId, workspaceRoot: work, stateRoot: join(root, 'runtimes'),
      rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()), protectedRoots: [state, sources, cache],
      services: (binding: ProductBinding) => { const active = app.forConversation(binding.conversationId)
        return { prepare: app.prepare, documents: { operations: active.operations, boundary: active.backend, invalidate: () => active.session.invalidate(), onCheckpoint: active.onCheckpoint } }
      } }); cleanup.push(() => manager.close())
    app.answers.enableHistoricalOrigins({ origins: (id, entryId) => manager.historyAccess(actor, id).origins(id, entryId), frames: id => manager.historyAccess(actor, id).frames(id) })
    let sequence = 0
    const setPhase = (value: typeof phase) => { phase = value; step = 0 }
    const ask = async (binding: ProductBinding, text: string, refs: ProductSourceRef[] = [pdf], selectionContextIds: string[] = []) => {
      const runtime = await manager.get(actor, binding.conversationId), request: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId,
        expectedGeneration: binding.generation, idempotencyKey: `question:lineage-publication:${++sequence}`, mode: 'prompt', text, sourceRefs: refs, selectionContextIds }
      const accepted = runtime.coordinator.submit(request).receipt; await runtime.coordinator.waitForIdle()
      const receipt = control.get(actor, accepted.submissionId); expect(receipt.state).toBe('completed'); expect(receipt.checkpoint).toBeDefined()
      const native = await runtime.worker.snapshot() as { entries: Array<{ id: string, type: string, message?: { role: string, content: string | Array<{ type: string, text?: string }> } }> }
      const last = native.entries.find(entry => entry.id === receipt.checkpoint!.leafEntryId)!
      expect(last.message?.role).toBe('assistant')
      return { receipt, request, runtime, native, answer: app.answers.get(binding.conversationId, last.id), messageId: last.id }
    }
    const first = await ask(source, 'Read this selected Q4 original and give a verified citation.', [pdf], [ticket.selectionContextId])
    setPhase('second'); const second = await ask(source, 'Read Q4 again on this later original branch and cite it.')
    expect(first.answer.status).toBe('available'); expect(first.answer.manifest?.citations).toHaveLength(1)
    expect(second.answer.status).toBe('available'); expect(second.answer.manifest?.citations).toHaveLength(1)
    const sourceFile = first.runtime.worker.verifiedFile!, sourceBefore = readFileSync(sourceFile)
    const raw = first.native.entries.find(entry => entry.id === first.receipt.checkpoint!.userEntryId)!.message!.content
    const preparedText = typeof raw === 'string' ? raw : raw.filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(preparedText).toContain(first.request.text); expect(preparedText).not.toBe(first.request.text)
    const handoff = async (binding: ProductBinding, action: NativeLineageAction) => {
      const view = await manager.lineageInspect(actor, binding.conversationId), accepted = await manager.lineageCommand(actor, binding.conversationId,
        command(view, action, `lineage:publication-handoff:${++sequence}`), () => {})
      await (Reflect.get(manager, 'lineageTasks') as Map<string, Promise<void>>).get(binding.conversationId)
      const completed = manager.lineageOperation(actor, binding.conversationId, accepted.operationId)
      expect(completed, JSON.stringify(completed)).toMatchObject({ state: 'succeeded' })
      return completed.result!
    }
    const nav = await handoff(source, navigate(first.messageId)), fork = await handoff(nav.targetBinding, { kind: 'fork', targetEntryId: first.messageId, position: 'at' })
    const child = fork.targetBinding, childFile = manager.lineageFile(actor, child.conversationId, child.bindingId)
    expect(readFileSync(sourceFile).subarray(0, sourceBefore.length).equals(sourceBefore)).toBe(true)
    return { root, work, control, catalog, resources, manager, app, source, nav, fork, child, sourceFile, childFile, first, second, preparedText, model,
      pdf, pdfBytes, ticket, firstBlock: firstBlock!, setPhase, ask, handoff, close }
  } catch (error) { await close(); throw error }
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('actual native lineage history and immutable Answer publication', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { f = await fixture() }, 60000)
  afterEach(() => { vi.restoreAllMocks() })
  afterAll(async () => { await f?.close() }, 60000)

  it('restores exact original human text after same-CID navigation and keeps old off-branch published Answers unchanged', async () => {
    const history = f.manager.historyAccess(actor, f.source.conversationId).snapshot()
    expect(history.checkpoint).toBeNull(); expect(history.selectedHead?.fileSeal.sessionId).toBe(f.source.runtimeSessionId)
    expect(history.messages.map(message => message.entryId)).toEqual([f.first.receipt.checkpoint!.userEntryId, f.first.messageId])
    expect(history.messages[0]!.text).toBe(f.first.request.text); expect(history.messages[0]!.origin).toMatchObject({ bindingId: f.source.bindingId, generation: f.source.generation })
    expect(JSON.stringify(history)).not.toContain(f.preparedText)
    for (const original of [f.first.answer, f.second.answer]) {
      const current = f.app.answers.get(f.source.conversationId, original.messageId)
      expect(current.status).toBe('available'); expect(current.nativeTextHash).toBe(original.nativeTextHash)
      expect(JSON.stringify(current.manifest)).toBe(JSON.stringify(original.manifest))
      expect(current.origin).toMatchObject({ conversationId: f.source.conversationId, bindingId: f.source.bindingId, runtimeSessionId: f.source.runtimeSessionId, entryId: original.messageId })
    }
    const original = f.second.answer.manifest!, focused = await f.app.answers.focus(f.source.conversationId, original.messageId, original.citations[0]!.citationId, () => {}, new AbortController().signal)
    expect(focused).toMatchObject({ status: 'resolved', exactText: f.firstBlock.text, original: { ...f.pdf, contentHash: hash(f.pdfBytes) } })
  }, 30000)

  it('serves only selected exact-copy origins to a fork and never republishes old Evidence under the child binding', async () => {
    const access = f.manager.historyAccess(actor, f.child.conversationId), page = await access.page(actor), old = f.first.answer
    expect(page.checkpoint).toBeNull(); expect(page.selectedHead).toEqual(f.fork.proof.targetHead)
    const answer = page.messages.find(message => message.entryId === old.messageId)!, user = page.messages.find(message => message.role === 'user')!
    expect(answer.nativeTextHash).toBe(old.nativeTextHash); expect(answer.origin).toMatchObject({ conversationId: f.source.conversationId, bindingId: f.source.bindingId, runtimeSessionId: f.source.runtimeSessionId, entryId: old.messageId })
    expect(user.text).toBe(f.first.request.text); expect(user.nativeTextHash).toBe(hash(f.preparedText))
    const inherited = f.app.answers.get(f.child.conversationId, old.messageId)
    expect(inherited).toMatchObject({ status: 'available', conversationId: f.child.conversationId, origin: { conversationId: f.source.conversationId, bindingId: f.source.bindingId } })
    expect(inherited.manifest?.sessionId).toBe(f.source.conversationId); expect(JSON.stringify(inherited.manifest)).toBe(JSON.stringify(old.manifest))
    expect(f.app.answers.receipts.publication(f.child, old.messageId)).toBeUndefined()
    expect(access.origins(f.child.conversationId, f.second.messageId)).toEqual([])
    expect(f.app.answers.get(f.child.conversationId, f.second.messageId)).toMatchObject({ status: 'unavailable', manifest: null })
    expect(f.app.answers.get(f.child.conversationId, 'entry:not-inherited')).toMatchObject({ status: 'unavailable', manifest: null })
    await expect(f.app.answers.focus(f.child.conversationId, f.second.messageId, f.second.answer.manifest!.citations[0]!.citationId, () => {}, new AbortController().signal)).rejects.toThrow()
    const focused = await f.app.answers.focus(f.child.conversationId, old.messageId, old.manifest!.citations[0]!.citationId, () => {}, new AbortController().signal)
    expect(focused).toMatchObject({ status: 'resolved', exactText: f.firstBlock.text, original: { ...f.pdf, contentHash: hash(f.pdfBytes) } })
  }, 30000)

  it('reauthorizes the original conversation before inherited text counts or Answers are disclosed', async () => {
    const access = f.manager.historyAccess(actor, f.child.conversationId), original = f.control.binding.bind(f.control)
    vi.spyOn(f.control, 'binding').mockImplementation((who, id) => { if (id === f.source.conversationId) throw new Error('Original conversation permission revoked'); return original(who, id) })
    expect(() => access.snapshot()).toThrow('revoked'); await expect(access.page(actor)).rejects.toThrow('revoked')
    expect(() => f.app.answers.get(f.child.conversationId, f.first.messageId)).toThrow('revoked')
  })

  it.each(['revoked', 'hash-changed'] as const)('retains owned native chat when source is %s but denies canonical Answer and original-PDF authority', async variant => {
    const access = f.manager.historyAccess(actor, f.child.conversationId), before = access.snapshot(), original = f.app.store.getEligibleLibrarySource.bind(f.app.store)
    vi.spyOn(f.app.store, 'getEligibleLibrarySource').mockImplementation((...args) => {
      const current = original(...args)
      return current?.documentId === f.pdf.documentId ? variant === 'revoked' ? undefined : { ...current, representationContentHash: '0'.repeat(64) } : current
    })
    expect(access.snapshot()).toEqual(before); expect((await access.page(actor)).messages.some(message => message.entryId === f.first.messageId)).toBe(true)
    expect(() => f.app.answers.get(f.child.conversationId, f.first.messageId)).toThrow()
    expect(() => f.app.answers.get(f.source.conversationId, f.first.messageId)).toThrow()
    await expect(f.app.answers.focus(f.child.conversationId, f.first.messageId, f.first.answer.manifest!.citations[0]!.citationId, () => {}, new AbortController().signal)).rejects.toThrow()
    expect(f.first.answer.manifest!.citations[0]!.locator.representationContentHash).not.toBe('0'.repeat(64))
  })

  it('fails closed when either the inherited child bytes or their original parent native proof changes', () => {
    for (const file of [f.sourceFile, f.childFile]) {
      const bytes = readFileSync(file), changed = Buffer.from(bytes.toString('utf8').replace('First genuine cited answer.', 'Altered genuine cited answer.'))
      expect(changed.equals(bytes)).toBe(false)
      try {
        writeFileSync(file, changed)
        expect(() => f.manager.historyAccess(actor, f.child.conversationId).snapshot()).toThrow()
        expect(() => f.app.answers.get(f.child.conversationId, f.first.messageId)).toThrow()
      } finally { writeFileSync(file, bytes) }
    }
    expect(f.app.answers.get(f.child.conversationId, f.first.messageId).status).toBe('available')
  })

  it('never substitutes prepared native user content when its exact original association is unavailable', async () => {
    vi.spyOn(f.control, 'publicUserMessageAt').mockReturnValue(null)
    const page = await f.manager.historyAccess(actor, f.child.conversationId).page(actor), user = page.messages.find(message => message.role === 'user')!
    expect(user).toMatchObject({ entryId: f.first.receipt.checkpoint!.userEntryId, text: '', truncated: false, displayOrigin: 'unavailable', nativeTextHash: hash(f.preparedText) })
    expect(JSON.stringify(page)).not.toContain(f.preparedText)
  })

  it('requires a fresh actual Read for a new child Answer rather than promoting an inherited citation from native context', async () => {
    const calls = f.model.getCallCount(); f.setPhase('naive')
    const naive = await f.ask(f.child, 'The context remembers an old locator; this question has not read it again.')
    expect(f.model.getCallCount()).toBe(calls + 1)
    const frame = f.app.forConversation(f.child.conversationId).session.invocation()
    expect(frame.submissionId).toBe(naive.receipt.submissionId)
    expect(f.app.answers.receipts.reads(f.child, naive.receipt.submissionId, frame.scope.scope.scopeVersionId)).toEqual([])
    expect(naive.answer.manifest?.citations ?? []).toEqual([])
    expect(f.app.answers.receipts.publication(f.child, f.first.messageId)).toBeUndefined()
    f.setPhase('fresh'); const fresh = await f.ask(f.child, 'Read the original Q4 page again and cite this new Read.')
    expect(f.model.getCallCount()).toBe(calls + 4); expect(fresh.answer.status).toBe('available'); expect(fresh.answer.origin).toBeUndefined()
    expect(fresh.answer.manifest?.sessionId).toBe(f.child.conversationId); expect(fresh.answer.manifest?.citations).toHaveLength(1)
    const publication = f.app.answers.receipts.publication(f.child, fresh.messageId)!
    expect(publication.checkpoint).toEqual(fresh.receipt.checkpoint)
    const reads = f.app.answers.receipts.reads(f.child, fresh.receipt.submissionId, publication.scopeVersionId)
    expect(reads).toHaveLength(1); expect(reads[0]!.locators.some(locator => locator.locatorId === fresh.answer.manifest!.citations[0]!.locator.locatorId)).toBe(true)
    expect(JSON.stringify(f.app.answers.get(f.child.conversationId, f.first.messageId).manifest)).toBe(JSON.stringify(f.first.answer.manifest))
    expect(() => f.app.selections.get(f.child.conversationId, f.ticket.selectionContextId)).toThrow()
  }, 30000)

  it('keeps opaque cursor ownership, TTL, exact native head and generation separate while using real completed native turns', async () => {
    f.setPhase('filler')
    for (let index = 0; index < 3; index++) await f.ask(f.child, `Actual pagination background question ${index}`, [])
    let now = Date.now()
    const access = new LineageHistoryAccess(f.control, f.catalog, actor, f.child, f.work, (who, id, bindingId) => f.manager.lineageFile(who, id, bindingId), () => now)
    try {
      const page = await access.page(actor); expect(page.hasEarlier).toBe(true); expect(page.nextCursor).toMatch(/^history:[a-f0-9-]{36}$/u)
      expect(page.nextCursor).not.toContain(f.child.runtimeSessionId)
      await expect(access.page({ ...actor, actorId: 'actor:other' }, page.nextCursor!)).rejects.toThrow()
      await expect(access.page({ ...actor, workspaceId: 'workspace:other' }, page.nextCursor!)).rejects.toThrow()
      await expect(access.page(actor, 'history:00000000-0000-4000-8000-000000000000')).rejects.toThrow()
      await expect(access.page(actor, '../private')).rejects.toThrow()
      const older = await access.page(actor, page.nextCursor!); expect(older.messages.length).toBeGreaterThan(0)
      now += 300001; await expect(access.page(actor, page.nextCursor!)).rejects.toThrow()
      const beforeChange = await access.page(actor); f.setPhase('short'); await f.ask(f.child, 'A genuine question changes the cursor checkpoint.', [])
      await expect(access.page(actor, beforeChange.nextCursor!)).rejects.toThrow()
      const current = await access.page(actor)
      const moved = await f.handoff(f.child, navigate(f.first.messageId))
      expect(moved.targetBinding.generation).toBe(f.child.generation + 1)
      await expect(access.page(actor, current.nextCursor!)).rejects.toThrow()
    } finally { access.dispose() }
  }, 45000)

  it('honors actual completed-input purge through every inherited candidate without erasing the original Answer publication', async () => {
    const purged = f.control.purgeRecoveryPayload(actor, f.first.receipt.submissionId)
    expect(purged.state).toBe('completed'); expect(purged.payloadRetained).toBe(false)
    for (const id of [f.source.conversationId, f.child.conversationId]) {
      const page = await f.manager.historyAccess(actor, id).page(actor), user = page.messages.find(message => message.entryId === f.first.receipt.checkpoint!.userEntryId)!
      expect(user).toMatchObject({ text: '', truncated: false, displayOrigin: 'unavailable', nativeTextHash: hash(f.preparedText) })
      expect(JSON.stringify(page)).not.toContain(f.preparedText)
      const original = f.app.answers.get(id, f.first.messageId)
      expect(original.status).toBe('available'); expect(JSON.stringify(original.manifest)).toBe(JSON.stringify(f.first.answer.manifest))
    }
  })
})
