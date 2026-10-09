import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LibraryService, SourceScopeStore, enrichmentHash, type LibraryRuntimePort } from '@docatlas/core'
import type { IngestRequest, IngestResult, LibraryImportRequest, ProductRevisionImport, SourceScopeVersion } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { DocumentApplication } from '../src/documents/application.js'
import { ProductAnswers } from '../src/documents/answers.js'
import { DocumentHttp } from '../src/documents/http.js'
import { UploadStore } from '../src/documents/uploads.js'
import { ProductLibrary } from '../src/documents/versions.js'
import { ProductAuth } from '../src/http/auth.js'
import { createProductHttpHandler } from '../src/http/handler.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ControlStore } from '../src/storage/control-store.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

/** The ingest adapter is deterministic here; uploads, Library/Control journals, product authority
 * callbacks and HTTP handlers are real. PDF parsing/old-asset integrity have a separate test. */
function ingest(request: IngestRequest): IngestResult {
  const revision = request.revision, id = `rep:${hash(revision.revisionId).slice(0, 32)}`
  return { schemaVersion: 1, resultType: 'ingest', idempotencyKey: request.idempotencyKey, documentId: revision.documentId, revisionId: revision.revisionId, cacheStatus: 'created',
    representations: [{ schemaVersion: 1, representationId: `${id}:original`, documentId: revision.documentId, revisionId: revision.revisionId, kind: 'original-bytes',
      mediaType: 'application/pdf', contentHash: revision.contentHash, byteLength: revision.byteLength, pageCount: 1, textQuality: 'not-applicable', derivedFromRepresentationIds: [], createdAt: revision.ingestedAt, status: 'current' },
    { schemaVersion: 1, representationId: `${id}:text`, documentId: revision.documentId, revisionId: revision.revisionId, kind: 'embedded-text', mediaType: 'text/plain',
      contentHash: hash(`${revision.contentHash}:text`), byteLength: 20, pageCount: 1, textQuality: 'usable', derivedFromRepresentationIds: [`${id}:original`],
      generator: { name: 'explicit-unit-engine', version: '1', configHash: hash('engine') }, createdAt: revision.ingestedAt, status: 'current' }],
    index: { status: 'ready', blockCount: 1, indexedPages: 1, totalPages: 1, textQuality: 'usable' }, warnings: [] }
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-library-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const actor = { actorId: 'actor:product-library', workspaceId: 'workspace:product-library' }, control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const binding = control.createManagedConversation(actor, 'creation:product-library:one').binding, conversationId = binding.conversationId
  const store = await SourceScopeStore.open(join(root, 'domain')); cleanup.push(() => store.close())
  const uploads = new UploadStore(join(root, 'upload-control'), join(root, 'upload-files'), actor); cleanup.push(() => uploads.close())
  const call = vi.fn(async (_method: string, request: IngestRequest) => ingest(request))
  const runtime = { call, registerEligibleSources: vi.fn(), assertBrowserSession: (id: string, workspace: string) => {
    if (control.binding(actor, id).workspaceId !== workspace) throw new Error('Workspace denied')
  } } as unknown as LibraryRuntimePort
  const library = new LibraryService(runtime, store, uploads); cleanup.push(() => library.dispose())
  const upload = async (key: string, text: string, ownerConversation = conversationId) => {
    const bytes = Buffer.from(text), reserved = uploads.reserve(ownerConversation, { schemaVersion: 1, kind: 'upload-start', idempotencyKey: key, name: 'Report.pdf', byteLength: bytes.length, contentHash: hash(bytes) })
    return uploads.put(ownerConversation, reserved.uploadId, Readable.from([bytes]), () => {})
  }
  const firstUpload = await upload('upload:product-library:first', '%PDF-original-product-library')
  const initial = library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: conversationId, workspaceId: actor.workspaceId, candidateId: firstUpload.uploadId, sourceRole: 'primary', idempotencyKey: 'import:product-library:first' })
  await library.whenIdle(); const document = store.getLibraryJob(actor.workspaceId, initial.jobId)!.document!
  const source = store.getEligibleLibrarySource(actor.workspaceId, document.documentId, document.currentRevision.revisionId)!
  const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: 'scope:product-library:initial', workspaceId: actor.workspaceId, investigationId: 'investigation:product-library', version: 1, locked: true,
    included: [{ documentId: document.documentId, revisionId: document.currentRevision.revisionId, role: 'primary' }], excluded: [], createdBy: { kind: 'user', actorId: actor.actorId }, createdAt: new Date().toISOString() }
  store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: conversationId, idempotencyKey: 'scope:product-library:initial', scope, sources: [source] })
  const receipts = new AnswerReceipts(join(root, 'answers')), answers = new ProductAnswers(receipts, store, control, actor, () => { throw new Error('Revision operations must not create a PDF resolver or Agent') })
  cleanup.push(() => receipts.close()); cleanup.push(() => answers.close())
  const application = { store, library, answers, research: { binding: (id: string) => control.binding(actor, id) } } as unknown as DocumentApplication
  const http = new DocumentHttp(application, uploads, join(root, 'cache')), versions = http.versions
  const nextUpload = await upload('upload:product-library:second', '%PDF-revised-product-library')
  const command = (key = 'revision:product-library:one'): ProductRevisionImport => ({ schemaVersion: 1, kind: 'revision-import', expectedGeneration: binding.generation,
    idempotencyKey: key, uploadId: nextUpload.uploadId, targetDocumentId: document.documentId, expectedCurrentRevisionId: document.currentRevision.revisionId })
  const inner = (request: ProductRevisionImport): LibraryImportRequest => ({ schemaVersion: 1, requestType: 'library-import', sessionId: conversationId, workspaceId: actor.workspaceId, candidateId: request.uploadId,
    sourceRole: document.sourceRole, idempotencyKey: `revision:${enrichmentHash([actor.actorId, actor.workspaceId, conversationId, request.idempotencyKey])}`,
    revisionTarget: { documentId: request.targetDocumentId, expectedCurrentRevisionId: request.expectedCurrentRevisionId } })
  const inspect = (fn: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(root, 'domain', 'investigations', `${hash(actor.workspaceId)}.sqlite3`)); try { fn(db) } finally { db.close() } }
  return { root, actor, control, binding, conversationId, store, library, runtime, uploads, versions, answers, http, source, scope, document, command, inner, upload, firstUpload, nextUpload, call, inspect }
}

describe('ProductLibrary authority over real import and upload stores', () => {
  it('keeps status absolutely read-only and hashes the whole product body without activating native sources', async () => {
    const f = await fixture(), request = f.command(), before = f.store.get(f.conversationId), accepted = vi.spyOn(f.library, 'acceptImport')
    expect(f.versions.status(f.conversationId, request)).toMatchObject({ request, requestHash: enrichmentHash(request), job: null })
    const input = f.inner(request), jobId = `job:${hash(`${f.actor.workspaceId}\0${input.idempotencyKey}`).slice(0, 32)}`
    // Simulate only an already-durable queued acceptance, not a fake completed domain result.
    f.store.acceptLibraryJob(input, jobId, new Date().toISOString(), enrichmentHash(request))
    for (let i = 0; i < 3; i++) expect(f.versions.status(f.conversationId, request)).toMatchObject({ job: { jobId, status: 'queued' } })
    await f.library.whenIdle(); expect(accepted).not.toHaveBeenCalled(); expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.store.get(f.conversationId)).toEqual(before)
    f.inspect(db => expect(db.prepare('SELECT request_hash FROM library_job_idempotency WHERE idempotency_key = ?').get(input.idempotencyKey)?.request_hash).toBe(enrichmentHash({ request: input, productCommandHash: enrichmentHash(request) })))
    f.versions.import(f.conversationId, request); await f.library.whenIdle()
    const result = f.versions.status(f.conversationId, request)
    expect(result).toMatchObject({ job: { status: 'succeeded', document: { documentId: f.document.documentId, revisionCount: 2 } } })
    expect(f.versions.import(f.conversationId, request)).toEqual(result); expect(f.call).toHaveBeenCalledTimes(2)
    // expectedGeneration does not occur in the narrower LibraryImportRequest: the full hash must bind it.
    expect(() => f.versions.status(f.conversationId, { ...request, expectedGeneration: request.expectedGeneration + 1 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.get(f.conversationId)).toEqual(before)
    expect(f.versions.history(f.conversationId, f.document.documentId).versions).toHaveLength(2)
    expect(f.store.get(f.conversationId)).toEqual(before)
  })

  it('rejects injected identity, stale generation, foreign targets and uploads before creating an import job', async () => {
    const f = await fixture(), request = f.command(), before = f.store.get(f.conversationId)
    const second = f.control.createManagedConversation(f.actor, 'creation:product-library:other').binding
    const foreignUpload = await f.upload('upload:product-library:foreign', '%PDF-foreign-conversation', second.conversationId)
    for (const [input, code] of [
      [{ ...request, actorId: 'actor:forged' }, 'invalid-request'], [{ ...request, expectedGeneration: 2 }, 'stale'],
      [{ ...request, targetDocumentId: 'doc:not-owned' }, 'permission-denied'], [{ ...request, expectedCurrentRevisionId: 'revision:not-owned' }, 'permission-denied'],
      [{ ...request, uploadId: foreignUpload.uploadId }, 'not-found'],
    ] as const) expect(() => f.versions.import(f.conversationId, input)).toThrowError(expect.objectContaining({ code }))
    const foreignActor = { ...f.actor, actorId: 'actor:foreign' }, owned = f.control.createManagedConversation(foreignActor, 'creation:product-library:foreign').binding
    const foreign = new ProductLibrary(f.store, f.library, f.uploads, id => f.control.binding(foreignActor, id), f.answers)
    expect(() => foreign.status(owned.conversationId, request)).toThrowError(expect.objectContaining({ code: 'stale' }))
    expect(f.versions.status(f.conversationId, request).job).toBeNull()
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.store.get(f.conversationId)).toEqual(before)
  })

  it('only an explicit original import repairs a legacy committed job after reopen and later revisions, with no parsing or admission', async () => {
    const f = await fixture(), request = f.command('revision:legacy-gap'), before = f.store.get(f.conversationId)
    const original = f.store.recordLibraryDocument.bind(f.store)
    // Fault fixture: precisely the old domain-only writer, before a separate succeeded job write.
    const legacy = vi.spyOn(f.store, 'recordLibraryDocument').mockImplementationOnce(input => original(input))
    const accepted = f.versions.import(f.conversationId, request); await f.library.whenIdle(); legacy.mockRestore()
    expect(f.versions.status(f.conversationId, request).job?.status).toBe('running')
    const committed = f.store.getLibraryDocument(f.actor.workspaceId, f.document.documentId)!
    const nextUpload = await f.upload('upload:third-after-gap', '%PDF-third revision after legacy job gap')
    const laterRequest = { ...request, idempotencyKey: 'revision:after-gap', uploadId: nextUpload.uploadId, expectedCurrentRevisionId: committed.currentRevision.revisionId }
    f.versions.import(f.conversationId, laterRequest); await f.library.whenIdle()
    const latest = f.versions.status(f.conversationId, laterRequest).job!.document!
    expect(latest.revisionCount).toBe(3)
    await f.library.dispose(); f.store.close()
    const store = await SourceScopeStore.open(join(f.root, 'domain')); cleanup.push(() => store.close())
    const library = new LibraryService(f.runtime, store, f.uploads); cleanup.push(() => library.dispose())
    const versions = new ProductLibrary(store, library, f.uploads, id => f.control.binding(f.actor, id), f.answers)
    const materialize = vi.spyOn(f.uploads, 'materialize'), failed = versions.status(f.conversationId, request)
    expect(failed).toMatchObject({ request, job: { jobId: accepted.job!.jobId, status: 'failed', error: { code: 'unavailable' } } })
    for (let i = 0; i < 3; i++) expect(versions.status(f.conversationId, request)).toEqual(failed)
    expect(f.call).toHaveBeenCalledTimes(3); expect(materialize).not.toHaveBeenCalled()
    expect(() => versions.import(f.conversationId, { ...request, expectedGeneration: request.expectedGeneration + 1 })).toThrowError(expect.objectContaining({ code: 'stale' }))
    expect(() => versions.status(f.conversationId, { ...request, expectedGeneration: request.expectedGeneration + 1 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const repaired = versions.import(f.conversationId, request)
    expect(repaired).toMatchObject({ job: { status: 'succeeded', document: committed } })
    expect(versions.status(f.conversationId, request)).toEqual(repaired)
    expect(versions.import(f.conversationId, request)).toEqual(repaired)
    expect(store.getLibraryDocument(f.actor.workspaceId, latest.documentId)).toEqual(latest)
    expect(store.get(f.conversationId)).toEqual(before)
    await library.whenIdle(); expect(f.call).toHaveBeenCalledTimes(3); expect(materialize).not.toHaveBeenCalled()
  })

  it.each(['policy', 'binding'] as const)('late %s change prevents a completed ingest from committing its revision or source alias', async (change) => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), request = f.command()
    let retainedSource = f.source
    if (change === 'policy') {
      const upload = await f.upload('upload:product-library:policy-source', '%PDF-independent-retained-policy-source')
      const accepted = f.library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: f.conversationId, workspaceId: f.actor.workspaceId,
        candidateId: upload.uploadId, sourceRole: 'primary', idempotencyKey: 'import:product-library:policy-source' })
      await f.library.whenIdle()
      const document = f.store.getLibraryJob(f.actor.workspaceId, accepted.jobId)!.document!
      retainedSource = f.store.getEligibleLibrarySource(f.actor.workspaceId, document.documentId, document.currentRevision.revisionId)!
    }
    f.call.mockImplementationOnce(async (_method, input) => { entered.resolve(); await release.promise; return ingest(input) })
    const accepted = f.versions.import(f.conversationId, request)
    try {
      await entered.promise
      if (change === 'binding') f.control.rebind(f.actor, f.conversationId, f.binding.version, randomUUID(), null)
      else f.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: f.conversationId, idempotencyKey: 'scope:policy:revoked', expectedScopeVersionId: f.scope.scopeVersionId,
        scope: { ...f.scope, scopeVersionId: 'scope:product-library:revoked', previousScopeVersionId: f.scope.scopeVersionId, version: 2,
          included: [{ documentId: retainedSource.documentId, revisionId: retainedSource.revisionId, role: 'primary' }],
          excluded: [{ documentId: f.document.documentId, revisionId: f.document.currentRevision.revisionId, reason: 'permission' }] }, sources: [retainedSource] })
      release.resolve(); await f.library.whenIdle()
      expect(f.store.getLibraryJob(f.actor.workspaceId, accepted.job!.jobId)).toMatchObject({ status: 'failed' })
      expect(f.store.getLibraryDocument(f.actor.workspaceId, f.document.documentId)).toEqual(f.document)
      f.inspect(db => expect(db.prepare('SELECT document_id FROM library_source_bindings WHERE source_key = ?').get(hash(`uploads\0${f.nextUpload.contentHash}.pdf`))).toBeUndefined())
      if (change === 'binding') {
        expect(f.versions.status(f.conversationId, request)).toMatchObject({ generation: 2, request, job: { status: 'failed' } })
        expect(() => f.versions.import(f.conversationId, request)).toThrowError(expect.objectContaining({ code: 'stale' }))
        expect(() => f.versions.status(f.conversationId, { ...request, expectedGeneration: 2 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
      } else expect(() => f.versions.status(f.conversationId, request)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    } finally { release.resolve(); await f.library.whenIdle() }
  })

  it('authenticates HTTP history/status/import and binds the route upload to the exact body without implicit source admission', async () => {
    const f = await fixture(), request = f.command(), before = f.store.get(f.conversationId)
    let handler: ReturnType<typeof createProductHttpHandler>
    const server = createServer((req, res) => handler(req, res))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) })
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth = new ProductAuth(origin)
    handler = createProductHttpHandler({ auth, control: f.control, coordinator() { throw new Error('Library operations must not run Pi') }, documents: () => f.http })
    const paired = auth.exchange(auth.issueBootstrap(f.actor).code), headers = { cookie: paired.cookie.split(';')[0]!, origin, 'content-type': 'application/json', 'x-docatlas-csrf': paired.csrfToken }
    const base = `${origin}/api/conversations/${encodeURIComponent(f.conversationId)}`, path = `${base}/uploads/${encodeURIComponent(request.uploadId)}`
    const post = (url: string, input: unknown = request, supplied = headers) => fetch(url, { method: 'POST', headers: supplied, body: JSON.stringify(input) })
    expect((await fetch(`${base}/documents/${encodeURIComponent(f.document.documentId)}/revisions`)).status).toBe(401)
    expect((await post(`${path}/revision-status`, request, { ...headers, 'x-docatlas-csrf': 'A'.repeat(43) })).status).toBe(403)
    expect((await post(`${base}/uploads/${encodeURIComponent(f.firstUpload.uploadId)}/revision-import`)).status).toBe(400)
    expect((await post(`${path}/revision-import`, { ...request, actorId: f.actor.actorId })).status).toBe(400)
    const other = f.control.createManagedConversation(f.actor, 'creation:product-library:http-other').binding
    expect((await post(`${origin}/api/conversations/${encodeURIComponent(other.conversationId)}/uploads/${encodeURIComponent(request.uploadId)}/revision-status`)).status).toBe(404)
    const status = await post(`${path}/revision-status`); expect(status.status).toBe(200)
    expect(parseContract('product-library', await status.json())).toMatchObject({ request, job: null })
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.store.get(f.conversationId)).toEqual(before)
    const accepted = await post(`${path}/revision-import`); expect(accepted.status).toBe(202)
    expect(parseContract('product-library', await accepted.json())).toMatchObject({ kind: 'revision-import-state', request })
    await f.library.whenIdle()
    for (let i = 0; i < 2; i++) {
      const response = await post(`${path}/revision-status`); expect(response.status).toBe(200)
      expect(parseContract('product-library', await response.json())).toMatchObject({ requestHash: enrichmentHash(request), job: { status: 'succeeded', document: { revisionCount: 2 } } })
    }
    const history = await fetch(`${base}/documents/${encodeURIComponent(f.document.documentId)}/revisions`, { headers })
    expect(history.status).toBe(200)
    const value = parseContract('product-library', await history.json())
    expect(value).toMatchObject({ kind: 'revision-history', documentId: f.document.documentId })
    expect(f.call).toHaveBeenCalledTimes(2); expect(f.store.get(f.conversationId)).toEqual(before)
  })
})
