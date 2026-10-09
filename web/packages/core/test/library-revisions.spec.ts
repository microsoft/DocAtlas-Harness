import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnswerManifest, IngestRequest, IngestResult, LibraryDocument, LibraryImportRequest, LibraryRevisionTarget } from '@docatlas/contracts'
import { LibraryService, type LibraryImportAuthority } from '../src/document/library-service.js'
import type { LibraryDiscoveryPort, LibraryRuntimePort, MaterializedLibraryCandidate } from '../src/document/ports.js'
import { SourceScopeStore, type LibraryRecordInput } from '../src/storage/source-scope-store.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const workspaceId = 'workspace:revision-import', sessionId = 'session:revision-import'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

function ingested(request: IngestRequest): IngestResult {
  const revision = request.revision, originalId = `rep:${hash(`${revision.revisionId}:original`).slice(0, 32)}`
  return { schemaVersion: 1, resultType: 'ingest', idempotencyKey: request.idempotencyKey, documentId: revision.documentId, revisionId: revision.revisionId, cacheStatus: 'created',
    representations: [{ schemaVersion: 1, representationId: originalId, documentId: revision.documentId, revisionId: revision.revisionId, kind: 'original-bytes', mediaType: revision.mediaType,
      contentHash: revision.contentHash, byteLength: revision.byteLength, pageCount: 30, textQuality: 'not-applicable', derivedFromRepresentationIds: [], createdAt: revision.ingestedAt, status: 'current' },
    { schemaVersion: 1, representationId: `rep:${hash(`${revision.revisionId}:text`).slice(0, 32)}`, documentId: revision.documentId, revisionId: revision.revisionId, kind: 'embedded-text', mediaType: 'text/plain',
      contentHash: hash(`${revision.contentHash}:text`), byteLength: 20, pageCount: 30, textQuality: 'usable', derivedFromRepresentationIds: [originalId],
      generator: { name: 'fixture-sidecar', version: '1', configHash: hash('fixture') }, createdAt: revision.ingestedAt, status: 'current' }],
    index: { status: 'ready', blockCount: 1, indexedPages: 30, totalPages: 30, textQuality: 'usable' }, warnings: [] }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'docatlas-library-revisions-')), store = await SourceScopeStore.open(root)
  const candidates = new Map<string, MaterializedLibraryCandidate>()
  const materialize = vi.fn(async (id: string) => { const value = candidates.get(id); if (!value) throw new Error('No candidate'); return structuredClone(value) })
  const call = vi.fn(async (_method: string, request: IngestRequest): Promise<IngestResult> => ingested(request))
  const assertBrowserSession = vi.fn(), registerEligibleSources = vi.fn()
  let clock = Date.parse('2026-09-10T00:00:00.000Z')
  const runtime = { assertBrowserSession, registerEligibleSources, call } as unknown as LibraryRuntimePort
  const discovery = { materialize, discover: async () => { throw new Error('Explicit uploads only') } } as LibraryDiscoveryPort
  const onError = vi.fn(), service = new LibraryService(runtime, store, discovery, () => clock++, onError)
  cleanup.push(async () => { await service.dispose(); store.close(); await rm(root, { recursive: true, force: true }) })
  const candidate = (id: string, text: string, relativePath = `${hash(text)}.pdf`) => {
    const value: MaterializedLibraryCandidate = { candidateId: `upload:${id}`, rootId: 'uploads', relativePath, displayName: 'Report.pdf', mediaType: 'application/pdf', byteLength: Buffer.byteLength(text), contentHash: hash(text) }
    candidates.set(value.candidateId, value); return value
  }
  const request = (source: MaterializedLibraryCandidate, key: string, revisionTarget?: LibraryRevisionTarget): LibraryImportRequest => ({ schemaVersion: 1, requestType: 'library-import',
    sessionId, workspaceId, candidateId: source.candidateId, sourceRole: 'primary', idempotencyKey: key, ...(revisionTarget ? { revisionTarget } : {}) })
  const importSource = async (source: MaterializedLibraryCandidate, key: string, revisionTarget?: LibraryRevisionTarget, authority?: LibraryImportAuthority) => {
    const accepted = service.acceptImport(request(source, key, revisionTarget), authority); await service.whenIdle(); return store.getLibraryJob(workspaceId, accepted.jobId)!
  }
  const sourceKey = (source: MaterializedLibraryCandidate) => hash(`${source.rootId}\0${source.relativePath}`)
  const database = (fn: (database: DatabaseSync) => void) => { const db = new DatabaseSync(join(root, 'investigations', `${hash(workspaceId)}.sqlite3`)); try { fn(db) } finally { db.close() } }
  const target = (document: LibraryDocument) => ({ documentId: document.documentId, expectedCurrentRevisionId: document.currentRevision.revisionId })
  const reopen = async () => {
    await service.dispose(); store.close()
    const reopened = await SourceScopeStore.open(root), library = new LibraryService(runtime, reopened, discovery, () => clock++, onError)
    cleanup.push(async () => { await library.dispose(); reopened.close() })
    return { store: reopened, service: library }
  }
  return { root, store, service, call, materialize, assertBrowserSession, registerEligibleSources, onError, candidate, request, importSource, sourceKey, database, target, reopen }
}

/** Reproduce the pre-atomic writer exactly: domain+record receipt committed, job left running. */
async function legacyOrphan(f: Awaited<ReturnType<typeof setup>>, source: MaterializedLibraryCandidate, key: string, target?: LibraryRevisionTarget, authority?: LibraryImportAuthority) {
  const original = f.store.recordLibraryDocument.bind(f.store)
  let document: LibraryDocument | undefined
  const legacy = vi.spyOn(f.store, 'recordLibraryDocument').mockImplementationOnce(input => { const result = original(input); document = result.document; return result })
  const job = await f.importSource(source, key, target, authority)
  legacy.mockRestore()
  expect(job.status).toBe('running')
  return { job, document: document!, request: f.request(source, key, target) }
}

describe('explicit Library revision imports keep original bytes and canonical source identity', () => {
  it('creates a native revision from a new immutable upload path without changing old Evidence or representations', async () => {
    const f = await setup(), a = f.candidate('old', '%PDF original bytes'), b = f.candidate('new', '%PDF replacement bytes')
    const first = (await f.importSource(a, 'import:first')).document!, firstSource = f.store.getEligibleLibrarySource(workspaceId, first.documentId, first.currentRevision.revisionId)!
    const originalRepresentations = f.store.getLibraryRepresentations(workspaceId, first.documentId, first.currentRevision.revisionId)
    const answer = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/answer-manifest.json', import.meta.url), 'utf8')).manifest as AnswerManifest
    Object.assign(answer, { workspaceId, sessionId, investigationId: 'investigation:revisions', sourceScopeVersionId: 'scope:revision:old' })
    Object.assign(answer.citations[0]!.locator, firstSource)
    Object.assign(answer.citations[0]!.evidence!, { documentId: firstSource.documentId, revisionId: firstSource.revisionId, representationId: firstSource.representationId })
    f.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId, idempotencyKey: 'scope:old', sources: [firstSource], scope: {
      schemaVersion: 1, scopeVersionId: answer.sourceScopeVersionId, workspaceId, investigationId: answer.investigationId, version: 1, locked: true,
      included: [{ documentId: first.documentId, revisionId: first.currentRevision.revisionId, role: 'primary' }], excluded: [], createdBy: { kind: 'user', actorId: 'user:revisions' }, createdAt: '2026-09-10T00:00:00.000Z' } })
    f.store.recordAnswerManifest(answer)
    const before = f.store.getCanonicalEvidence(workspaceId, answer.investigationId, answer.sourceScopeVersionId, answer.citations[0]!.evidence!.evidenceId)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.call.mockImplementationOnce(async (_method, req) => { entered.resolve(); await release.promise; return ingested(req) })
    const pending = f.importSource(b, 'import:second', f.target(first))
    await entered.promise
    f.database(db => expect(db.prepare('SELECT document_id FROM library_source_bindings WHERE source_key = ?').get(f.sourceKey(b))).toBeUndefined())
    expect(f.store.getLibraryDocument(workspaceId, first.documentId)).toEqual(first)
    release.resolve(); const completed = await pending, second = completed.document!
    expect(completed.status).toBe('succeeded'); expect(second.documentId).toBe(first.documentId)
    expect(second.currentRevision.previousRevisionId).toBe(first.currentRevision.revisionId)
    expect(second.currentRevision.contentHash).toBe(b.contentHash)
    expect(second.currentRevision.revisionId).toBe(`rev:${hash(`${first.documentId}\0${b.contentHash}`).slice(0, 32)}`)
    expect(f.call.mock.calls.at(-1)![1].sourceBinding.relativePath).toBe(b.relativePath)
    expect(f.store.getLibraryRevisions(workspaceId, first.documentId)).toEqual([
      { revision: { ...first.currentRevision, status: 'superseded', supersededByRevisionId: second.currentRevision.revisionId }, representations: originalRepresentations }, { revision: second.currentRevision, representations: second.representations },
    ])
    expect(f.store.getLibraryRepresentations(workspaceId, first.documentId, first.currentRevision.revisionId)).toEqual(originalRepresentations)
    expect(f.store.getEligibleLibrarySource(workspaceId, first.documentId, first.currentRevision.revisionId)).toEqual(firstSource)
    expect(f.store.getCanonicalEvidence(workspaceId, answer.investigationId, answer.sourceScopeVersionId, answer.citations[0]!.evidence!.evidenceId)).toEqual(before)
    f.database(db => expect(db.prepare('SELECT document_id FROM library_source_bindings WHERE source_key = ?').get(f.sourceKey(b))?.document_id).toBe(first.documentId))
  })

  it('reuses only exact current bytes and rejects historical bytes on targeted, bound and unbound ordinary imports', async () => {
    const f = await setup(), a = f.candidate('old', '%PDF old'), b = f.candidate('new', '%PDF new')
    const first = (await f.importSource(a, 'first')).document!, target = f.target(first), second = (await f.importSource(b, 'second', target)).document!
    expect((await f.importSource(b, 'current-reuse', f.target(second))).document).toEqual(second)
    const count = f.call.mock.calls.length
    for (const [source, explicit] of [[a, true], [a, false], [f.candidate('old-copy', '%PDF old', 'copy-of-old.pdf'), false]] as const) {
      const result = await f.importSource(source, `historical:${source.candidateId}:${explicit}`, explicit ? f.target(second) : undefined)
      expect(result).toMatchObject({ status: 'failed', error: { code: 'conflict' } })
    }
    expect(f.call).toHaveBeenCalledTimes(count)
    expect(f.store.getLibraryRevisions(workspaceId, first.documentId)).toHaveLength(2)
    expect(f.store.getLibraryDocument(workspaceId, first.documentId)).toEqual(second)
  })

  it('does not reparent a different document through a source alias or existing content hash', async () => {
    const f = await setup(), a = f.candidate('one', '%PDF one'), b = f.candidate('two', '%PDF two')
    const first = (await f.importSource(a, 'first')).document!, second = (await f.importSource(b, 'second')).document!, count = f.call.mock.calls.length
    const byHash = f.candidate('hash-copy', '%PDF two', 'copied.pdf'), byAlias = f.candidate('alias-copy', '%PDF different bytes', b.relativePath)
    for (const source of [byHash, byAlias]) expect(await f.importSource(source, source.candidateId, f.target(first))).toMatchObject({ status: 'failed', error: { code: 'conflict' } })
    expect(f.call).toHaveBeenCalledTimes(count)
    expect(f.store.getLibraryDocument(workspaceId, first.documentId)).toEqual(first)
    expect(f.store.getLibraryDocument(workspaceId, second.documentId)).toEqual(second)
    f.database(db => expect(db.prepare('SELECT document_id FROM library_source_bindings WHERE source_key = ?').get(f.sourceKey(byHash))).toBeUndefined())
  })

  it('freezes the queued target and includes it in durable job idempotency without rerunning completed receipts', async () => {
    const f = await setup(), a = f.candidate('one', '%PDF one'), b = f.candidate('two', '%PDF two')
    const first = (await f.importSource(a, 'first')).document!, request = f.request(b, 'targeted', f.target(first)), original = structuredClone(request)
    const accepted = f.service.acceptImport(request)
    request.revisionTarget!.documentId = 'doc:mutated'; request.revisionTarget!.expectedCurrentRevisionId = 'rev:mutated'
    await f.service.whenIdle()
    expect(f.store.getLibraryJob(workspaceId, accepted.jobId)).toMatchObject({ status: 'succeeded', document: { documentId: first.documentId, revisionCount: 2 } })
    expect(f.service.acceptImport(original)).toMatchObject({ status: 'replayed', jobId: accepted.jobId })
    await f.service.whenIdle(); expect(f.call).toHaveBeenCalledTimes(2)
    expect(() => f.service.acceptImport(request)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const ordinary = structuredClone(original); delete ordinary.revisionTarget
    expect(() => f.service.acceptImport(ordinary)).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })

  it.each(['materialize', 'ingest'] as const)('rechecks captured host authority after %s before any domain or alias commit', async (phase) => {
    const f = await setup(), a = f.candidate('one', '%PDF one'), b = f.candidate('two', '%PDF two'), first = (await f.importSource(a, 'first')).document!
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let authorized = true
    const authority = { assertCurrent() { if (!authorized) throw new Error('permission revoked') } }
    if (phase === 'materialize') f.materialize.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return structuredClone(b) })
    else f.call.mockImplementationOnce(async (_method, req) => { entered.resolve(); await release.promise; return ingested(req) })
    const pending = f.importSource(b, 'targeted', f.target(first), authority)
    await entered.promise; authorized = false; release.resolve()
    expect((await pending).status).toBe('failed')
    expect(f.store.getLibraryDocument(workspaceId, first.documentId)).toEqual(first)
    f.database(db => expect(db.prepare('SELECT document_id FROM library_source_bindings WHERE source_key = ?').get(f.sourceKey(b))).toBeUndefined())
  })

  it('rejects asynchronous authority before accepting a job and rechecks legacy session permissions after ingest', async () => {
    const f = await setup(), a = f.candidate('one', '%PDF one')
    expect(() => f.service.acceptImport(f.request(a, 'async'), { assertCurrent: async () => {} })).toThrowError(expect.objectContaining({ code: 'unavailable' }))
    expect(f.call).not.toHaveBeenCalled()
    f.call.mockImplementationOnce(async (_method, request) => { f.assertBrowserSession.mockImplementation(() => { throw new Error('session revoked') }); return ingested(request) })
    expect((await f.importSource(a, 'legacy')).status).toBe('failed')
    expect(f.store.listLibraryDocuments(workspaceId)).toEqual([])
  })

  it('looks up an original whole product command without accepting, scheduling or changing a queued job', async () => {
    const f = await setup(), source = f.candidate('queued', '%PDF queued'), request = f.request(source, 'read-only-key'), authority = { commandHash: hash('whole product body A'), assertCurrent() {} }
    expect(f.service.lookupImport(request, authority)).toBeUndefined()
    expect(existsSync(join(f.root, 'investigations', `${hash(workspaceId)}.sqlite3`))).toBe(false)
    const jobId = `job:${hash(`${workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`
    f.store.acceptLibraryJob(request, jobId, '2026-09-10T00:00:00.000Z', authority.commandHash)
    expect(f.service.lookupImport(request, authority)).toMatchObject({ jobId, status: 'queued', phase: 'queued' })
    await f.service.whenIdle(); expect(f.call).not.toHaveBeenCalled(); expect(f.materialize).not.toHaveBeenCalled()
    for (const lookup of [() => f.service.lookupImport(request, { ...authority, commandHash: hash('whole product body B') }), () => f.service.lookupImport(request),
      () => f.service.acceptImport(request, { ...authority, commandHash: hash('whole product body B') })]) expect(lookup).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.service.lookupImport(request, { ...authority, commandHash: 'bad' })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const denied = { ...authority, assertCurrent() { throw new Error('revoked') } }
    expect(() => f.service.lookupImport(request, denied)).toThrow('revoked')
    f.service.acceptImport(request, authority); await f.service.whenIdle()
    const saved = f.service.lookupImport(request, authority)
    expect(saved?.status).toBe('succeeded'); expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.service.acceptImport(request, authority).status).toBe('replayed')
    expect(f.service.lookupImport(request, authority)).toEqual(saved); expect(f.call).toHaveBeenCalledTimes(1)
    f.database(db => db.prepare('UPDATE library_jobs SET session_id = ? WHERE job_id = ?').run('session:foreign', jobId))
    expect(() => f.service.lookupImport(request, authority)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it('derives a missing legacy supersededBy only from the verified revision chain without rewriting the old row', async () => {
    const f = await setup(), a = f.candidate('one', '%PDF one'), b = f.candidate('two', '%PDF two'), first = (await f.importSource(a, 'first')).document!
    const second = (await f.importSource(b, 'second', f.target(first))).document!, expected = f.store.getLibraryRevisions(workspaceId, first.documentId)
    const legacy = JSON.stringify({ ...first.currentRevision, status: 'superseded' })
    f.database(db => db.prepare('UPDATE library_revisions SET revision_json = ? WHERE revision_id = ?').run(legacy, first.currentRevision.revisionId))
    expect(f.store.getLibraryRevisions(workspaceId, first.documentId)).toEqual(expected)
    expect(expected[0]!.revision.supersededByRevisionId).toBe(second.currentRevision.revisionId)
    f.database(db => expect(db.prepare('SELECT revision_json FROM library_revisions WHERE revision_id = ?').get(first.currentRevision.revisionId)?.revision_json).toBe(legacy))
    const other = await SourceScopeStore.open(f.root)
    try { expect(other.getLibraryRevisions(workspaceId, first.documentId)).toEqual(expected) } finally { other.close() }
  })

  it('performs final target CAS and source alias resolution inside one writer transaction', async () => {
    const f = await setup(), a = f.candidate('one', '%PDF one'), first = (await f.importSource(a, 'first')).document!
    const next = (suffix: string): LibraryRecordInput => {
      const source = f.candidate(suffix, `%PDF ${suffix}`), revision = { ...first.currentRevision, revisionId: `rev:${suffix}`, previousRevisionId: first.currentRevision.revisionId,
        contentHash: source.contentHash, byteLength: source.byteLength }, ingest = ingested({ revision, idempotencyKey: suffix } as IngestRequest)
      return { workspaceId, idempotencyKey: `record:${suffix}`, sourceKey: f.sourceKey(source), rootId: source.rootId, relativePath: source.relativePath, revisionTarget: f.target(first),
        document: { ...first, revisionCount: 2, currentRevision: revision, representations: ingest.representations, activeRepresentationId: ingest.representations[1]!.representationId } }
    }
    const winner = next('winner'), loser = next('loser'), original = f.store.resolveLibraryImport.bind(f.store)
    let lockChecked = false
    vi.spyOn(f.store, 'resolveLibraryImport').mockImplementation((...args) => {
      f.database(db => { db.exec('PRAGMA busy_timeout=0'); expect(() => db.prepare('UPDATE library_documents SET aggregate_version = aggregate_version WHERE document_id = ?').run(first.documentId)).toThrow(/locked/u); lockChecked = true })
      return original(...args)
    })
    expect(f.store.recordLibraryDocument(winner).status).toBe('updated'); expect(lockChecked).toBe(true)
    const other = await SourceScopeStore.open(f.root)
    try { expect(() => other.recordLibraryDocument(loser)).toThrowError(expect.objectContaining({ code: 'conflict' })) }
    finally { other.close() }
    f.database(db => expect(db.prepare('SELECT document_id FROM library_source_bindings WHERE source_key = ?').get(loser.sourceKey)).toBeUndefined())
    expect(f.store.getLibraryRevisions(workspaceId, first.documentId).map(item => item.revision.revisionId)).toEqual([first.currentRevision.revisionId, 'rev:winner'])
  })

  it('rolls back revision, alias, journal and record receipt when the job-success SQL write faults', async () => {
    const f = await setup(), a = f.candidate('atomic-old', '%PDF atomic old'), b = f.candidate('atomic-new', '%PDF atomic new')
    const first = (await f.importSource(a, 'atomic:first')).document!
    f.database(db => db.exec(`CREATE TRIGGER library_completion_fault BEFORE UPDATE ON library_jobs
      WHEN json_extract(NEW.state_json, '$.status') = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'injected completion fault'); END`))
    const failed = await f.importSource(b, 'atomic:failed', f.target(first))
    expect(failed.status).toBe('failed'); expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'injected completion fault' }))
    expect(f.store.getLibraryDocument(workspaceId, first.documentId)).toEqual(first)
    expect(f.store.getLibraryRevisions(workspaceId, first.documentId)).toHaveLength(1)
    f.database(db => {
      expect(db.prepare('SELECT source_key FROM library_source_bindings WHERE source_key = ?').get(f.sourceKey(b))).toBeUndefined()
      expect(db.prepare('SELECT result_json FROM library_record_idempotency WHERE idempotency_key = ?').get(`${failed.jobId}:record`)).toBeUndefined()
      expect(db.prepare('SELECT event_id FROM journal_events WHERE idempotency_key = ?').get(`library:${failed.jobId}:record`)).toBeUndefined()
    })
    const reopened = await f.reopen()
    expect(reopened.store.getLibraryRevisions(workspaceId, first.documentId)).toHaveLength(1)
    expect(reopened.service.lookupImport(f.request(b, 'atomic:failed', f.target(first)))).toEqual(failed)
  })

  it('keeps the original durable success across a post-COMMIT fault, stale failure write and reopen', async () => {
    const f = await setup(), source = f.candidate('post-commit', '%PDF committed'), original = f.store.recordLibraryDocument.bind(f.store)
    const writer = vi.spyOn(f.store, 'recordLibraryDocument').mockImplementationOnce((input, completion) => {
      original(input, completion)
      throw new Error('injected process-boundary fault after COMMIT')
    })
    const success = await f.importSource(source, 'post-commit:first'); writer.mockRestore()
    expect(success.status).toBe('succeeded'); expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'injected process-boundary fault after COMMIT' }))
    f.store.updateLibraryJob({ schemaVersion: 1, resultType: 'library-job', workspaceId, jobId: success.jobId, status: 'cancelled', phase: 'complete', createdAt: success.createdAt, updatedAt: '2026-09-11T00:00:00.000Z' })
    expect(f.store.getLibraryJob(workspaceId, success.jobId)).toEqual(success)
    const reopened = await f.reopen(), request = f.request(source, 'post-commit:first')
    expect(reopened.service.lookupImport(request)).toEqual(success)
    reopened.service.acceptImport(request); await reopened.service.whenIdle()
    expect(reopened.service.lookupImport(request)).toEqual(success)
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.materialize).toHaveBeenCalledTimes(1)
  })

  it('reports registry refresh as recoverable without reversing a successful import or changing source admission', async () => {
    const f = await setup(), source = f.candidate('registry', '%PDF registry'), before = f.store.get(sessionId)
    f.registerEligibleSources.mockImplementationOnce(() => { throw new Error('registry unavailable') })
    const success = await f.importSource(source, 'registry:first')
    expect(success.status).toBe('succeeded')
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unavailable', retryable: true, message: expect.stringContaining('commit succeeded') }))
    expect(f.store.get(sessionId)).toEqual(before)
    f.service.acceptImport(f.request(source, 'registry:first')); await f.service.whenIdle()
    expect(f.registerEligibleSources).toHaveBeenCalledTimes(2)
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.materialize).toHaveBeenCalledTimes(1)
    expect(f.service.lookupImport(f.request(source, 'registry:first'))).toEqual(success)
    expect(f.store.get(sessionId)).toEqual(before)
  })

  it.each(['created', 'updated', 'reused', 'linked'] as const)('repairs only the fixed original %s receipt on explicit retry after reopen, with zero ingest', async (kind) => {
    const f = await setup(), a = f.candidate('orphan-first', '%PDF orphan first'), b = f.candidate('orphan-second', '%PDF orphan second'), c = f.candidate('orphan-third', '%PDF orphan third')
    const first = kind === 'created' ? undefined : (await f.importSource(a, 'orphan:base')).document!
    const source = kind === 'created' ? a : kind === 'reused' ? a : kind === 'linked' ? f.candidate('orphan-linked', '%PDF orphan first', 'linked-copy.pdf') : b
    const authority = { commandHash: hash('whole original orphan product command'), assertCurrent() {} }
    const orphan = await legacyOrphan(f, source, 'orphan:original', first && f.target(first), authority)
    const later = (await f.importSource(c, 'orphan:later', f.target(orphan.document))).document!, before = f.store.get(sessionId)
    const ingests = f.call.mock.calls.length, materializations = f.materialize.mock.calls.length
    const reopened = await f.reopen(), failed = reopened.service.lookupImport(orphan.request, authority)
    expect(failed).toMatchObject({ jobId: orphan.job.jobId, status: 'failed', error: { code: 'unavailable' } })
    // Polling the original body never closes the gap or invokes parsing/preparation.
    for (let i = 0; i < 3; i++) expect(reopened.service.lookupImport(orphan.request, authority)).toEqual(failed)
    const journal = () => { let rows: unknown; f.database(db => { rows = db.prepare('SELECT * FROM journal_events ORDER BY rowid').all() }); return rows }
    const oldJournal = journal()
    expect(() => reopened.service.acceptImport(orphan.request, { ...authority, commandHash: hash('different product body') })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const accepted = reopened.service.acceptImport(orphan.request, authority)
    expect(accepted).toMatchObject({ status: 'replayed', jobId: orphan.job.jobId }); await reopened.service.whenIdle()
    const repaired = reopened.service.lookupImport(orphan.request, authority)
    expect(repaired).toMatchObject({ status: 'succeeded', document: orphan.document, createdAt: orphan.job.createdAt })
    expect(repaired?.document).not.toEqual(later)
    expect(reopened.store.getLibraryDocument(workspaceId, later.documentId)).toEqual(later)
    expect(reopened.store.get(sessionId)).toEqual(before); expect(journal()).toEqual(oldJournal)
    expect(f.call).toHaveBeenCalledTimes(ingests); expect(f.materialize).toHaveBeenCalledTimes(materializations)
    expect(reopened.service.reconcileImport(orphan.request, authority)).toEqual(repaired)
  })

  it.each(['record-hash', 'record-image', 'binding-path', 'journal', 'session'] as const)('refuses orphan repair when the canonical %s no longer verifies', async (damage) => {
    const f = await setup(), source = f.candidate('damaged-orphan', '%PDF damaged orphan'), orphan = await legacyOrphan(f, source, 'orphan:damaged')
    f.database(db => {
      if (damage === 'record-hash') db.prepare('UPDATE library_record_idempotency SET request_hash = ? WHERE idempotency_key = ?').run(hash('forged'), `${orphan.job.jobId}:record`)
      else if (damage === 'record-image') db.prepare('UPDATE library_record_idempotency SET result_json = ? WHERE idempotency_key = ?').run(JSON.stringify({ status: 'created', document: { ...orphan.document, updatedAt: '2026-09-12T00:00:00.000Z' } }), `${orphan.job.jobId}:record`)
      else if (damage === 'binding-path') db.prepare('UPDATE library_source_bindings SET relative_path = ? WHERE source_key = ?').run('another.pdf', f.sourceKey(source))
      else if (damage === 'journal') db.prepare('UPDATE journal_events SET payload_hash = ? WHERE idempotency_key = ?').run(hash('forged'), `library:${orphan.job.jobId}:record`)
      else db.prepare('UPDATE library_jobs SET session_id = ? WHERE job_id = ?').run('session:other', orphan.job.jobId)
    })
    expect(() => f.service.reconcileImport(orphan.request)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    expect(f.store.getLibraryJob(workspaceId, orphan.job.jobId)?.status).toBe('running')
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.materialize).toHaveBeenCalledTimes(1)
  })

  it('rechecks host authority under the writer lock before repair and rolls back a revoked final completion', async () => {
    const f = await setup(), source = f.candidate('authority-orphan', '%PDF authority orphan'), orphan = await legacyOrphan(f, source, 'orphan:authority')
    let locks = 0
    const authority = { assertCurrent() {
      f.database(db => {
        db.exec('PRAGMA busy_timeout=0')
        try { db.prepare('UPDATE library_jobs SET updated_at = updated_at WHERE job_id = ?').run(orphan.job.jobId) }
        catch (error) { if (!String(error).includes('locked')) throw error; locks++; if (locks === 2) throw new Error('revoked under commit lock') }
      })
    } }
    expect(() => f.service.reconcileImport(orphan.request, authority)).toThrow('revoked under commit lock')
    expect(locks).toBe(2); expect(f.store.getLibraryJob(workspaceId, orphan.job.jobId)?.status).toBe('running')
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.service.reconcileImport(orphan.request)?.status).toBe('succeeded')
  })

  it.each(['revision', 'representations', 'journal', 'current'] as const)('verifies exact historical %s before returning it, including across reopen', async (damage) => {
    const f = await setup(), a = f.candidate('one', '%PDF one'), b = f.candidate('two', '%PDF two'), first = (await f.importSource(a, 'first')).document!
    await f.importSource(b, 'second', f.target(first))
    const history = f.store.getLibraryRevisions(workspaceId, first.documentId)
    const other = await SourceScopeStore.open(f.root)
    try {
      expect(other.getLibraryRevisions(workspaceId, first.documentId)).toEqual(history)
      expect(other.getLibraryRevisions('workspace:other', first.documentId)).toEqual([])
      expect(other.getLibraryRevisions(workspaceId, 'doc:other')).toEqual([])
      f.database(db => {
        if (damage === 'revision') db.prepare('UPDATE library_revisions SET revision_json = ? WHERE revision_id = ?').run('{}', first.currentRevision.revisionId)
        else if (damage === 'representations') db.prepare('UPDATE library_revisions SET representations_json = ? WHERE revision_id = ?').run('[]', first.currentRevision.revisionId)
        else if (damage === 'journal') db.prepare("UPDATE journal_events SET payload_hash = ? WHERE event_type = 'library.document-imported' AND aggregate_version = 1").run('0'.repeat(64))
        else db.prepare('UPDATE library_documents SET current_content_hash = ? WHERE document_id = ?').run('0'.repeat(64), first.documentId)
      })
      expect(() => other.getLibraryRevisions(workspaceId, first.documentId)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    } finally { other.close() }
  })
})
