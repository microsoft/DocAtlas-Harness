import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { compileSourceAnswerManifest, enrichmentHash, type SelectionResolverPort, type SourceScopeStore } from '@docatlas/core'
import type { AnswerManifest, DocumentLocator, DocumentRevision, LibraryDocument, ProductPiCheckpoint, ProductRunReceipt, ResolveRequest, ResolveResult, ScopedSourceIdentity, SourceRepresentation, SourceScopeVersion } from '@docatlas/contracts'
import { ProductAnswers } from '../src/documents/answers.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ControlStore } from '../src/storage/control-store.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const canonical = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as {
  quoteLocator: DocumentLocator, sourceScope: SourceScopeVersion, documentRevision: DocumentRevision, originalRepresentation: SourceRepresentation, textRepresentation: SourceRepresentation,
}
type DomainGate = Pick<SourceScopeStore, 'getAnswerManifest' | 'getSourceScopeVersion' | 'getEligibleLibrarySource' | 'get' | 'getLibraryDocument' | 'getLibraryRepresentations' | 'getLibraryRevisions'>
type ControlGate = Pick<ControlStore, 'binding' | 'get'>
type Reader = SelectionResolverPort & { close(): Promise<void> }

/** Typed in-memory domain/control read ports isolate publication policy; actual immutable receipt storage is used.
 * This does not stand in for ingestion, checkpoint generation or native/HTTP acceptance tests.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-answers-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(join(root, 'control')); cleanups.push(() => control.close())
  const actor = { actorId: 'actor:product-answers', workspaceId: 'workspace:product-answers' }, binding = control.createManagedConversation(actor, 'conversation:product-answers').binding
  const receipts = new AnswerReceipts(join(root, 'answers')); cleanups.push(() => receipts.close())
  const locator = structuredClone(canonical.quoteLocator), source: ScopedSourceIdentity = { documentId: locator.documentId, revisionId: locator.revisionId, representationId: locator.representationId, representationContentHash: locator.representationContentHash }
  const scope: SourceScopeVersion = { ...structuredClone(canonical.sourceScope), workspaceId: binding.workspaceId }
  const initial = control.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation, idempotencyKey: 'submission:product-answer-test',
    mode: 'prompt', text: 'What changed?', sourceRefs: [{ documentId: source.documentId, revisionId: source.revisionId }], selectionContextIds: [] }).receipt
  const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: initial.submissionId, requestHash: initial.requestHash, runtimeSessionId: binding.runtimeSessionId,
    userEntryId: '11111111', leafEntryId: '22222222', transcriptHash: 'c'.repeat(64), byteLength: 1234, entryCount: 3, settledAt: initial.createdAt }
  const manifest = compileSourceAnswerManifest({ sessionId: binding.conversationId, turn: 1, scope, sources: [source], message: { id: '22222222', createdAt: initial.createdAt,
    blocks: [{ index: 0, text: `[Revenue increased by 12%.](#docatlas.v1.support.${locator.locatorId})` }] }, reads: [{ callId: 'call:read', scopeVersionId: scope.scopeVersionId, locators: [locator] }] })!
  const document: LibraryDocument = { schemaVersion: 1, workspaceId: actor.workspaceId, documentId: source.documentId, displayName: 'Annual Report.pdf', mediaType: 'application/pdf', sourceRole: 'primary', status: 'ready', revisionCount: 1,
    currentRevision: { ...structuredClone(canonical.documentRevision), displayName: 'Annual Report.pdf' }, representations: [structuredClone(canonical.originalRepresentation), structuredClone(canonical.textRepresentation)], activeRepresentationId: source.representationId,
    capabilities: ['text', 'original'], createdAt: initial.createdAt, updatedAt: initial.createdAt }
  const state: { receipt: ProductRunReceipt, manifest: AnswerManifest | undefined, source: ScopedSourceIdentity | undefined, scope: SourceScopeVersion, document: LibraryDocument, frame: { scope: SourceScopeVersion, sources: ScopedSourceIdentity[] } | undefined } = {
    receipt: { ...initial, state: 'completed', checkpoint }, manifest, source, scope, document, frame: { scope: structuredClone(scope), sources: [structuredClone(source)] },
  }
  const domain: DomainGate = {
    getAnswerManifest: vi.fn(() => state.manifest), getSourceScopeVersion: vi.fn(() => state.frame),
    getEligibleLibrarySource: vi.fn<DomainGate['getEligibleLibrarySource']>((_workspace, documentId, revisionId) => { const current = state.source; return current && current.documentId === documentId && current.revisionId === revisionId ? current : undefined }),
    get: vi.fn<DomainGate['get']>(sessionId => ({ schemaVersion: 1, resultType: 'source-scope', sessionId, status: 'active', scope: state.scope, sources: state.source ? [state.source] : [] })),
    getLibraryDocument: vi.fn(() => state.document), getLibraryRepresentations: vi.fn(() => state.document.representations),
    getLibraryRevisions: vi.fn(() => [{ revision: state.document.currentRevision, representations: state.document.representations }]),
  }
  const gate: ControlGate = { binding: control.binding.bind(control), get: vi.fn(() => state.receipt) }
  const resolution = (): ResolveResult => ({ schemaVersion: 1, resultType: 'resolve', documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId,
    resolutionId: 'resolve:citation', locatorId: locator.locatorId, status: 'resolved', checkedAt: initial.createdAt, checkedRepresentationHash: source.representationContentHash,
    exactText: 'Revenue increased by 12%.', resolvedLocator: structuredClone(locator), candidates: [] })
  const behavior: { resolve(request: ResolveRequest, signal?: AbortSignal): Promise<ResolveResult>, close(): Promise<void> } = { resolve: async () => resolution(), close: async () => {} }
  const made: Reader[] = [], createReader = vi.fn((): Reader => {
    const reader: Reader = { call: vi.fn(async (method: string, request: ResolveRequest, signal?: AbortSignal) => {
      expect(method).toBe('resolve'); return behavior.resolve(request, signal)
    }) as SelectionResolverPort['call'], close: vi.fn(() => behavior.close()) }
    made.push(reader); return reader
  })
  const answers = new ProductAnswers(receipts, domain as SourceScopeStore, gate as ControlStore, actor, createReader); cleanups.push(() => answers.close())
  const publish = (published: AnswerManifest = manifest) => receipts.publish(binding, { messageId: published.messageId, manifestId: published.manifestId, manifestHash: enrichmentHash(published),
    nativeTextHash: 'd'.repeat(64), scopeVersionId: published.sourceScopeVersionId, checkpoint })
  return { answers, receipts, state, binding, checkpoint, manifest, domain, behavior, resolution, createReader, made, publish,
    get: () => answers.get(binding.conversationId, manifest.messageId), focus: (signal = new AbortController().signal, authorize = () => {}) => answers.focus(binding.conversationId, manifest.messageId, manifest.citations[0]!.citationId, authorize, signal) }
}

it('publishes only after the matching durable completion; missing, incomplete or mismatched checkpoint remains unavailable', () => {
  const f = fixture()
  expect(f.get()).toMatchObject({ status: 'unavailable', manifest: null })
  f.publish(); f.state.receipt.state = 'running'
  expect(f.get()).toMatchObject({ status: 'unavailable', nativeTextHash: null })
  f.state.receipt.state = 'completed'; f.state.receipt.checkpoint = { ...f.checkpoint, transcriptHash: 'f'.repeat(64) }
  expect(f.get().status).toBe('unavailable')
  f.state.receipt.checkpoint = f.checkpoint
  expect(f.get()).toMatchObject({ status: 'available', manifest: f.manifest })
  f.state.manifest = { ...f.manifest, createdAt: '2026-09-10T00:00:00Z' }
  expect(f.get).toThrow('publication')
})

it.each(['missing', 'revision', 'representation', 'policy', 'missing-frame', 'foreign-frame'] as const)('refuses %s source drift before making an attested answer available', variant => {
  const f = fixture(); f.publish()
  if (variant === 'missing') f.state.source = undefined
  if (variant === 'revision') f.state.source = { ...f.state.source!, revisionId: 'rev:changed' }
  if (variant === 'representation') f.state.source = { ...f.state.source!, representationContentHash: 'f'.repeat(64) }
  if (variant === 'policy') f.state.scope = { ...f.state.scope, excluded: [{ documentId: f.state.source!.documentId, revisionId: f.state.source!.revisionId, reason: 'policy' }] }
  if (variant === 'missing-frame') f.state.frame = undefined
  if (variant === 'foreign-frame') f.state.frame = { ...f.state.frame!, sources: [] }
  expect(f.get).toThrow()
  expect(f.createReader).not.toHaveBeenCalled()
})

it('resolves only the original source revision and exact attested quote, without candidate expansion', async () => {
  const f = fixture(); f.publish()
  const focus = await f.focus()
  expect(focus).toMatchObject({ status: 'resolved', exactText: 'Revenue increased by 12%.', physicalPage: 17, original: { name: 'Annual Report.pdf', contentHash: canonical.originalRepresentation.contentHash } })
  expect(f.made[0]!.call).toHaveBeenCalledWith('resolve', { schemaVersion: 1, requestType: 'resolve', locator: f.manifest.citations[0]!.locator, allowCandidates: false, maxCandidates: 1 }, expect.any(AbortSignal))
  expect(f.made[0]!.close).toHaveBeenCalledOnce()
  await expect(f.answers.focus(f.binding.conversationId, f.manifest.messageId, 'citation:invented', () => {}, new AbortController().signal)).rejects.toThrow('no attested')
  expect(f.createReader).toHaveBeenCalledOnce()
})

it('keeps original revision metadata and an attested quote readable after a newer edition becomes current', async () => {
  const f = fixture(), old = structuredClone(f.state.document); f.publish()
  f.state.document = { ...old, displayName: 'New edition.pdf', revisionCount: 2, currentRevision: { ...old.currentRevision, revisionId: 'revision:new', previousRevisionId: old.currentRevision.revisionId, displayName: 'New edition.pdf', contentHash: 'f'.repeat(64) } }
  vi.mocked(f.domain.getLibraryRevisions).mockReturnValue([{ revision: { ...old.currentRevision, status: 'superseded', supersededByRevisionId: 'revision:new' }, representations: old.representations }])
  const value = f.answers.originalDocument(f.binding.conversationId, old.documentId, old.currentRevision.revisionId)
  expect(value.original).toMatchObject({ name: 'Annual Report.pdf', revisionId: old.currentRevision.revisionId, contentHash: old.currentRevision.contentHash })
  expect((await f.focus()).original).toEqual(value.original)
  expect((await f.focus()).exactText).toBe('Revenue increased by 12%.')
  expect(() => f.answers.originalDocument(f.binding.conversationId, old.documentId, 'revision:missing')).toThrowError(expect.objectContaining({ code: 'stale' }))
  f.state.source = undefined
  expect(() => f.answers.originalDocument(f.binding.conversationId, old.documentId, old.currentRevision.revisionId)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
})

it('allows authorized raw Library originals without claiming an Answer publication, and returns detached private metadata', () => {
  const f = fixture(), document = f.state.document
  expect(f.get().status).toBe('unavailable')
  const value = f.answers.originalDocument(f.binding.conversationId, document.documentId, document.currentRevision.revisionId)
  value.original.name = 'caller changed'; value.representation.contentHash = 'f'.repeat(64)
  expect(f.answers.originalDocument(f.binding.conversationId, document.documentId, document.currentRevision.revisionId).original.name).toBe('Annual Report.pdf')
  expect(f.get().status).toBe('unavailable')
})

it.each(['archived', 'quarantined', 'page-count', 'bytes', 'media', 'representation-status', 'foreign-document'] as const)('rejects %s historical original metadata without choosing another revision', variant => {
  const f = fixture(), document = f.state.document, original = document.representations[0]!
  if (variant === 'archived') document.status = 'archived'
  if (variant === 'quarantined') document.currentRevision.status = 'quarantined'
  if (variant === 'page-count') original.pageCount = 999
  if (variant === 'bytes') original.byteLength++
  if (variant === 'media') original.mediaType = 'text/markdown'
  if (variant === 'representation-status') original.status = 'stale'
  if (variant === 'foreign-document') original.documentId = 'document:foreign'
  expect(() => f.answers.originalDocument(f.binding.conversationId, document.documentId, document.currentRevision.revisionId)).toThrow()
})

it('fences a binding generation change during trusted original metadata lookup', () => {
  const f = fixture(), original = f.answers.binding.bind(f.answers)
  let reads = 0
  vi.spyOn(f.answers, 'binding').mockImplementation(id => ({ ...original(id), generation: ++reads === 1 ? f.binding.generation : f.binding.generation + 1 }))
  expect(() => f.answers.originalDocument(f.binding.conversationId, f.state.document.documentId, f.state.document.currentRevision.revisionId)).toThrow('binding changed')
})

it.each(['fabricated-text', 'wrong-locator', 'ambiguous', 'missing'] as const)('never returns a precise highlight for %s resolver output', async variant => {
  const f = fixture(); f.publish()
  f.behavior.resolve = async () => {
    const value = f.resolution()
    if (variant === 'fabricated-text') value.exactText = 'Revenue increased by 99%.'
    if (variant === 'wrong-locator') value.resolvedLocator = { ...value.resolvedLocator!, locatorId: 'loc:invented' }
    if (variant === 'ambiguous' || variant === 'missing') { value.status = variant; delete value.resolvedLocator; delete value.exactText }
    return value
  }
  expect(await f.focus()).toMatchObject({ status: variant === 'ambiguous' ? 'ambiguous' : 'page-only', exactText: null })
})

it('rejects locator-only citations and unavailable original PDFs before invoking a resolver', async () => {
  const f = fixture()
  f.state.manifest = compileSourceAnswerManifest({ sessionId: f.binding.conversationId, turn: 1, scope: f.state.scope, sources: [], message: { id: f.manifest.messageId, createdAt: f.manifest.createdAt,
    blocks: [{ index: 0, text: `[Revenue increased by 12%.](#docatlas.v1.support.${canonical.quoteLocator.locatorId})` }] }, reads: [{ callId: 'call:read', scopeVersionId: f.state.scope.scopeVersionId, locators: [canonical.quoteLocator] }] })!
  f.publish(f.state.manifest)
  await expect(f.focus()).rejects.toThrow('no attested')
  expect(f.createReader).not.toHaveBeenCalled()
  const g = fixture(); g.publish(); g.state.document.representations = []
  await expect(g.focus()).rejects.toThrow('Original citation PDF')
  expect(g.createReader).not.toHaveBeenCalled()
})

it.each(['authorization', 'policy', 'original-hash', 'cancel', 'resolver-hash'] as const)('rechecks %s after asynchronous resolution and still joins the reader', async variant => {
  const f = fixture(), controller = new AbortController(); f.publish()
  let revoked = false
  f.behavior.resolve = async () => {
    const result = f.resolution()
    if (variant === 'authorization') revoked = true
    if (variant === 'policy') f.state.scope.excluded.push({ documentId: result.documentId, revisionId: result.revisionId, reason: 'policy' })
    if (variant === 'original-hash') f.state.document.representations[0]!.contentHash = 'f'.repeat(64)
    if (variant === 'cancel') controller.abort(new Error('cancelled'))
    if (variant === 'resolver-hash') result.checkedRepresentationHash = 'f'.repeat(64)
    return result
  }
  await expect(f.focus(controller.signal, () => { if (revoked) throw new Error('revoked') })).rejects.toThrow()
  expect(f.made[0]!.close).toHaveBeenCalled()
})

it('holds all four cancelled reader slots until actual join, then permits another verification', async () => {
  const f = fixture(), join = Promise.withResolvers<void>(); f.publish()
  f.behavior.close = () => join.promise
  f.behavior.resolve = (_request, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  const controllers = Array.from({ length: 4 }, () => new AbortController()), tasks = controllers.map(controller => f.focus(controller.signal).catch(error => error))
  await vi.waitFor(() => expect(f.createReader).toHaveBeenCalledTimes(4))
  for (const controller of controllers) controller.abort()
  await expect(f.focus()).rejects.toThrow('capacity')
  expect(f.createReader).toHaveBeenCalledTimes(4)
  join.resolve(); await Promise.all(tasks)
  f.behavior.resolve = async () => f.resolution()
  expect((await f.focus()).status).toBe('resolved')
  expect(f.createReader).toHaveBeenCalledTimes(5)
})

it('rechecks revocation after actual join and makes close wait for the owned reader', async () => {
  const f = fixture(); f.publish()
  f.behavior.close = async () => { f.state.scope.excluded.push({ documentId: canonical.quoteLocator.documentId, revisionId: canonical.quoteLocator.revisionId, reason: 'policy' }) }
  await expect(f.focus()).rejects.toThrow('authorized')
  const g = fixture(), joined = Promise.withResolvers<void>(), stopped = Promise.withResolvers<ResolveResult>(); g.publish()
  g.behavior.resolve = () => stopped.promise
  g.behavior.close = () => { stopped.reject(new Error('reader stopped')); return joined.promise }
  const work = g.focus().catch(error => error); let closed = false
  const closing = g.answers.close().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  joined.resolve(); await closing; await work
  expect(closed).toBe(true); expect(() => g.get()).toThrow('closed')
})
