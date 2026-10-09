import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocAtlasAssetStore } from '@docatlas/runtime-document'
import { parseContract } from '@docatlas/contracts/node'
import type { LibraryDocument, SourceScopeVersion } from '@docatlas/contracts'
import { DocumentApplication } from '../src/documents/application.js'
import { DocumentHttp } from '../src/documents/http.js'
import { UploadStore } from '../src/documents/uploads.js'
import { ProductAuth } from '../src/http/auth.js'
import { createProductHttpHandler } from '../src/http/handler.js'
import { ControlStore } from '../src/storage/control-store.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

/** Real Library revision commits, isolated PDF parsing/selection/resolve, asset bytes and HTTP
 * authentication. No Pi/model invocation or Answer-provenance simulation is used in this test. */
describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('authenticated historical original PDFs', () => {
  it('keeps old bytes/name/quote exact after replacement and fails closed for source, byte, descriptor and mid-read changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docatlas-historical-originals-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const sourceRoot = join(root, 'sources'), cacheRoot = join(root, 'cache'); mkdirSync(sourceRoot)
    const firstBytes = Buffer.from(readFileSync('apps/web/fixtures/sample-report.pdf.base64', 'utf8'), 'base64')
    const secondBytes = Buffer.concat([firstBytes, Buffer.from('\n% Independently stored second revision\n')])
    writeFileSync(join(sourceRoot, 'Original edition.pdf'), firstBytes)
    const actor = { actorId: 'actor:historical-pdf', workspaceId: 'workspace:historical-pdf' }, control = ControlStore.open(join(root, 'control'))
    cleanup.push(() => control.close())
    const binding = control.createManagedConversation(actor, 'creation:historical-pdf:first').binding, conversationId = binding.conversationId
    const app = await DocumentApplication.create({ projectRoot: resolve('python/docatlas-sidecar'), sourceRoots: { 'root:history': sourceRoot }, cacheRoot, domainRoot: join(root, 'domain'), control, actor })
    cleanup.push(() => app.close())
    const importFile = async (name: string, key: string, previous?: LibraryDocument) => {
      const found = await app.library.discover({ schemaVersion: 1, requestType: 'library-discover', sessionId: conversationId, workspaceId: actor.workspaceId, limit: 10 })
      const candidate = found.candidates.find(item => item.displayName === name)!
      const accepted = app.library.acceptImport({ schemaVersion: 1, requestType: 'library-import', sessionId: conversationId, workspaceId: actor.workspaceId, idempotencyKey: key,
        candidateId: candidate.candidateId, sourceRole: 'primary', ...(previous ? { revisionTarget: { documentId: previous.documentId, expectedCurrentRevisionId: previous.currentRevision.revisionId } } : {}) })
      await app.library.whenIdle(); const job = app.store.getLibraryJob(actor.workspaceId, accepted.jobId)!
      expect(job).toMatchObject({ status: 'succeeded' }); return job.document!
    }
    const first = await importFile('Original edition.pdf', 'import:old'), oldRevision = first.currentRevision.revisionId, documentId = first.documentId
    const staged = await app.selections.stage(conversationId, { schemaVersion: 1, kind: 'selection-stage', expectedGeneration: binding.generation, idempotencyKey: 'selection:historical-original',
      proposals: [{ documentId, revisionId: oldRevision, physicalPage: 2, quote: 'Q4 15.2 +9%' }] }, () => {}, new AbortController().signal)
    const note = app.research.save(conversationId, { schemaVersion: 1, kind: 'note-save', expectedGeneration: binding.generation, idempotencyKey: 'note:historical-original',
      selectionContextId: staged.selectionContextId, noteKind: 'commentary', body: 'Keep the original edition anchor.' })
    if (note.result.record.recordType !== 'research-note') throw new Error('Expected actual saved note')
    const noteId = note.result.record.noteId, locatorId = note.result.locators[0]!.locatorId
    writeFileSync(join(sourceRoot, 'Revised edition.pdf'), secondBytes)
    const second = await importFile('Revised edition.pdf', 'import:new', first)
    expect(second.documentId).toBe(documentId); expect(second.currentRevision.revisionId).not.toBe(oldRevision)
    const original = app.answers.originalDocument(conversationId, documentId, oldRevision)
    expect(original.original).toMatchObject({ name: 'Original edition.pdf', revisionId: oldRevision, contentHash: hash(firstBytes), byteLength: firstBytes.length })
    expect(app.answers.originalDocument(conversationId, documentId, second.currentRevision.revisionId).original.name).toBe('Revised edition.pdf')
    const focus = await app.research.focus(conversationId, noteId, locatorId, () => {}, new AbortController().signal)
    expect(focus).toMatchObject({ status: 'resolved', exactText: 'Q4 15.2 +9%', original: original.original })
    expect(app.answers.get(conversationId, 'message:unpublished').status).toBe('unavailable')
    await expect(app.answers.focus(conversationId, 'message:unpublished', 'citation:invented', () => {}, new AbortController().signal)).rejects.toThrow('attested')

    const uploads = new UploadStore(join(root, 'upload-control'), join(root, 'upload-bytes'), actor); cleanup.push(() => uploads.close())
    const documents = new DocumentHttp(app, uploads, cacheRoot)
    let handler: ReturnType<typeof createProductHttpHandler>
    const server = createServer((request, response) => handler(request, response))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) })
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth = new ProductAuth(origin)
    handler = createProductHttpHandler({ auth, control, coordinator() { throw new Error('Raw historical access must not start an Agent') }, documents: () => documents })
    const exchange = await fetch(`${origin}/api/auth/exchange`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code: auth.issueBootstrap(actor).code }) })
    expect(exchange.status).toBe(200); parseContract('product-http', await exchange.json())
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!, url = (revision = oldRevision) => `${origin}/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(documentId)}/${encodeURIComponent(revision)}/original`
    const get = (revision = oldRevision) => fetch(url(revision), { headers: { cookie } })
    expect((await fetch(url())).status).toBe(401)
    for (const [revision, expected] of [[oldRevision, firstBytes], [second.currentRevision.revisionId, secondBytes]] as const) {
      const response = await get(revision); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/pdf')
      expect(response.headers.get('etag')).toBe(`"${hash(expected)}"`); expect(Buffer.from(await response.arrayBuffer())).toEqual(expected)
    }
    expect((await get('revision:does-not-exist')).status).toBe(409)
    const originalDocument = app.store.getLibraryDocument.bind(app.store)
    const archived = vi.spyOn(app.store, 'getLibraryDocument').mockImplementation((...args) => { const value = originalDocument(...args); return value?.documentId === documentId ? { ...value, status: 'archived' } : value })
    expect((await get()).status).toBe(403); archived.mockRestore()

    const source = app.store.getEligibleLibrarySource(actor.workspaceId, documentId, second.currentRevision.revisionId)!
    const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: 'scope:history:user', workspaceId: actor.workspaceId, investigationId: 'investigation:history-policy', version: 1, locked: true,
      included: [{ documentId, revisionId: second.currentRevision.revisionId, role: 'primary' }], excluded: [{ documentId, revisionId: oldRevision, reason: 'user' }],
      createdBy: { kind: 'user', actorId: actor.actorId }, createdAt: new Date().toISOString() }
    app.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: conversationId, idempotencyKey: 'scope:user', scope, sources: [source] })
    const allowed = await get(); expect(allowed.status).toBe(200); await allowed.arrayBuffer()
    const denied = vi.spyOn(app.store, 'get').mockImplementation(id => ({ schemaVersion: 1, resultType: 'source-scope', sessionId: id, status: 'active', sources: [source],
      scope: { ...scope, excluded: [{ documentId, revisionId: oldRevision, reason: 'permission' }] } }))
    expect((await get()).status).toBe(403); denied.mockRestore()

    const directory = join(cacheRoot, 'assets', hash(original.representation.representationId)), contentPath = join(directory, 'content.bin'), descriptorPath = join(directory, 'descriptor.json')
    renameSync(contentPath, `${contentPath}.held`)
    try { expect((await get()).status).toBe(404) } finally { renameSync(`${contentPath}.held`, contentPath) }
    chmodSync(contentPath, 0o600); const bad = Buffer.from(firstBytes); bad[0] = 0
    writeFileSync(contentPath, bad)
    try { expect((await get()).status).toBe(503) } finally { writeFileSync(contentPath, firstBytes); chmodSync(contentPath, 0o400) }
    const descriptor = readFileSync(descriptorPath), changed = { ...JSON.parse(descriptor.toString('utf8')), revisionId: second.currentRevision.revisionId }
    chmodSync(descriptorPath, 0o600); writeFileSync(descriptorPath, JSON.stringify(changed))
    try { expect((await get()).status).not.toBe(200) } finally { writeFileSync(descriptorPath, descriptor); chmodSync(descriptorPath, 0o400) }

    const lookup = app.store.getEligibleLibrarySource.bind(app.store), open = DocAtlasAssetStore.prototype.openAuthorized
    let revoked = false, opened: Awaited<ReturnType<typeof open>>
    const sourceGate = vi.spyOn(app.store, 'getEligibleLibrarySource').mockImplementation((...args) => revoked && args[2] === oldRevision ? undefined : lookup(...args))
    const openGate = vi.spyOn(DocAtlasAssetStore.prototype, 'openAuthorized').mockImplementationOnce(async function (this: DocAtlasAssetStore, ...args) { opened = await open.apply(this, args); revoked = true; return opened })
    expect((await get()).status).not.toBe(200)
    expect(opened).toBeDefined(); await expect(opened!.handle.stat()).rejects.toThrow()
    openGate.mockRestore(); sourceGate.mockRestore()
    const restored = await get(); expect(restored.status).toBe(200); expect(Buffer.from(await restored.arrayBuffer())).toEqual(firstBytes)
    auth.logout(cookie); expect((await get()).status).toBe(401)
  }, 60000)
})
