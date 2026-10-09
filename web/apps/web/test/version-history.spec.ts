import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibraryDocument, LibraryJobResult, ProductRevisionHistory, ProductRevisionImportState, UploadReceipt } from '@docatlas/contracts'
import { RevisionVersionList } from '../src/live/VersionHistory'
import { acknowledgeVersion, advancePendingVersion, bindRevisionImport, mergeRevisionHistory, parsePendingVersion, readVersionOutbox,
  revisionOriginalSource, revisionSourceChoice, savePendingVersion, uploadMatchesVersion, versionOwner, versionOwnerKey, versionStateMatches, versionStorageKey,
  type PendingVersion, type VersionOwner, type VersionStorage } from '../src/live/version-state'
import { canonicalHash } from '../src/live/state'
import { ReaderNavigation } from '../src/live/reader-state'
import type { LiveState } from '../src/live/client'

afterEach(() => vi.restoreAllMocks())
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/library.json', import.meta.url), 'utf8')) as { document: LibraryDocument, jobResult: LibraryJobResult }
function setup() {
  const old = structuredClone(fixture.document), document = structuredClone(old)
  const owner: VersionOwner = { actorId: 'actor:revision', workspaceId: old.workspaceId, conversationId: 'conversation:revision', bindingId: 'binding:revision', generation: 1, documentId: old.documentId }
  document.currentRevision = { ...old.currentRevision, revisionId: 'rev:library:report:2', previousRevisionId: old.currentRevision.revisionId, contentHash: 'd'.repeat(64), byteLength: 1200 }
  document.revisionCount = 2
  for (const representation of document.representations) {
    representation.revisionId = document.currentRevision.revisionId
    if (representation.kind === 'original-bytes') { representation.contentHash = document.currentRevision.contentHash; representation.byteLength = document.currentRevision.byteLength }
  }
  const entry = (value: LibraryDocument) => ({ revision: structuredClone(value.currentRevision), source: { documentId: value.documentId, revisionId: value.currentRevision.revisionId,
    representationId: value.activeRepresentationId, representationContentHash: value.representations.find(item => item.representationId === value.activeRepresentationId)!.contentHash },
    original: { documentId: value.documentId, revisionId: value.currentRevision.revisionId, name: value.displayName, contentHash: value.currentRevision.contentHash, byteLength: value.currentRevision.byteLength, pageCount: value.currentRevision.pageCount! } })
  const latest = entry(document), prior = entry(old)
  prior.revision = { ...prior.revision, status: 'superseded', supersededByRevisionId: latest.revision.revisionId }
  const history: ProductRevisionHistory = { schemaVersion: 1, kind: 'revision-history', conversationId: owner.conversationId, bindingId: owner.bindingId, generation: owner.generation,
    documentId: owner.documentId, currentRevisionId: latest.revision.revisionId, versions: [latest, prior], nextCursor: null, truncated: false }
  const pending: PendingVersion = { schemaVersion: 1, owner, expectedCurrentRevisionId: old.currentRevision.revisionId,
    upload: { schemaVersion: 1, kind: 'upload-start', idempotencyKey: 'upload:original-key', name: 'Updated.pdf', byteLength: document.currentRevision.byteLength, contentHash: document.currentRevision.contentHash },
    uploadReceipt: null, importKey: 'revision:original-key', request: null }
  const receipt: UploadReceipt = { schemaVersion: 1, kind: 'upload', uploadId: 'upload:immutable', conversationId: owner.conversationId, name: pending.upload.name, byteLength: pending.upload.byteLength, contentHash: pending.upload.contentHash, status: 'stored' }
  const values = new Map<string, string>(), changes: string[] = []
  const storage: VersionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); changes.push(`set:${key}`) }, removeItem: key => { values.delete(key); changes.push(`remove:${key}`) }, key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
  return { owner, document, old, history, pending, receipt, storage, values, changes }
}
async function completed(pending: PendingVersion, document: LibraryDocument): Promise<ProductRevisionImportState> {
  return { schemaVersion: 1, kind: 'revision-import-state', conversationId: pending.owner.conversationId, bindingId: pending.owner.bindingId, generation: pending.owner.generation,
    request: pending.request!, requestHash: await canonicalHash(pending.request!), job: { ...structuredClone(fixture.jobResult), status: 'succeeded', phase: 'complete', document } }
}

describe('immutable revision outbox', () => {
  it('binds actor/workspace/conversation/generation and target document without upgrading a selected revision', () => {
    const { owner } = setup()
    const state = { phase: 'ready', actor: { actorId: owner.actorId, workspaceId: owner.workspaceId }, selected: owner.conversationId,
      snapshot: { binding: { conversationId: owner.conversationId, ownerActorId: owner.actorId, workspaceId: owner.workspaceId, bindingId: owner.bindingId, generation: owner.generation } } } as LiveState
    expect(versionOwner(state, owner.documentId)).toEqual(owner)
    expect(versionOwner({ ...state, phase: 'pairing' }, owner.documentId)).toBeNull()
    expect(versionOwner({ ...state, selected: 'conversation:other' }, owner.documentId)).toBeNull()
    for (const key of ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'documentId'] as const) expect(versionStorageKey({ ...owner, [key]: 'other:target' })).not.toBe(versionStorageKey(owner))
    expect(versionOwnerKey({ ...owner, generation: 2 })).not.toBe(versionOwnerKey(owner))
  })
  it('retains a reservation-less upload and restores exact keys without mutating, reserving or importing', () => {
    const test = setup(); savePendingVersion(test.storage, test.pending)
    const raw = test.values.get(versionStorageKey(test.owner))!, before = [...test.changes]
    expect(readVersionOutbox(test.storage, test.owner)).toEqual({ state: 'pending', key: versionStorageKey(test.owner), value: test.pending, current: true })
    expect(parsePendingVersion(raw, test.owner)).toEqual(test.pending)
    expect(test.changes).toEqual(before); expect(test.pending.request).toBeNull(); expect(test.pending.uploadReceipt).toBeNull()
    expect(readVersionOutbox(test.storage, { ...test.owner, generation: 2, bindingId: 'binding:new' })).toMatchObject({ state: 'pending', current: false, value: test.pending })
    expect(readVersionOutbox(test.storage, { ...test.owner, documentId: 'doc:other' })).toEqual({ state: 'empty' })
  })
  it('advances receipt/request stages while preserving the original upload, import key, predecessor and owner', () => {
    const test = setup(); savePendingVersion(test.storage, test.pending)
    const reserved = { ...test.pending, uploadReceipt: test.receipt }
    advancePendingVersion(test.storage, test.pending, reserved)
    const bound = bindRevisionImport(reserved)
    advancePendingVersion(test.storage, reserved, bound)
    expect(bound.request).toEqual({ schemaVersion: 1, kind: 'revision-import', expectedGeneration: 1, idempotencyKey: test.pending.importKey,
      uploadId: test.receipt.uploadId, targetDocumentId: test.owner.documentId, expectedCurrentRevisionId: test.pending.expectedCurrentRevisionId })
    expect(bindRevisionImport(bound).request).toBe(bound.request)
    expect(parsePendingVersion(test.values.get(versionStorageKey(test.owner))!, test.owner)).toEqual(bound)
    expect(() => bindRevisionImport(test.pending)).toThrow('reservation')
    for (const changed of [{ ...bound, expectedCurrentRevisionId: 'revision:new-head' }, { ...bound, importKey: 'replacement:key' },
      { ...bound, upload: { ...bound.upload, contentHash: 'e'.repeat(64) } }, { ...bound, request: { ...bound.request!, idempotencyKey: 'new:key' } },
      { ...bound, uploadReceipt: { ...test.receipt, status: 'pending' as const } }, { ...bound, owner: { ...test.owner, documentId: 'doc:other' } }]) {
      expect(() => advancePendingVersion(test.storage, bound, changed)).toThrow()
    }
  })
  it('rejects malformed drafts, foreign uploads and arbitrary endpoint/identity injection', () => {
    const test = setup(), bound = bindRevisionImport({ ...test.pending, uploadReceipt: test.receipt })
    for (const change of [(value: PendingVersion) => { value.owner.actorId = 'actor:other' }, (value: PendingVersion) => { value.request!.expectedGeneration++ },
      (value: PendingVersion) => { value.request!.uploadId = 'upload:other' }, (value: PendingVersion) => { value.uploadReceipt!.contentHash = 'f'.repeat(64) },
      (value: PendingVersion) => { Reflect.set(value, 'endpoint', 'https://other.example') }, (value: PendingVersion) => { value.expectedCurrentRevisionId = '../escape' }]) {
      const value = structuredClone(bound); change(value); expect(() => parsePendingVersion(JSON.stringify(value), test.owner)).toThrow()
    }
    expect(() => parsePendingVersion('x'.repeat(32769), test.owner)).toThrow()
    test.values.set(versionStorageKey(test.owner), '{broken')
    expect(readVersionOutbox(test.storage, test.owner)).toEqual({ state: 'invalid', key: versionStorageKey(test.owner) })
    expect(test.values.get(versionStorageKey(test.owner))).toBe('{broken')
  })
  it('requires verified local persistence, never overwrites an uncertain or newer operation', () => {
    const test = setup()
    expect(() => savePendingVersion({ ...test.storage, setItem() { throw new Error('quota') } }, test.pending)).toThrow('quota')
    expect(() => savePendingVersion({ ...test.storage, setItem() {} }, test.pending)).toThrow('not retained')
    savePendingVersion(test.storage, test.pending)
    expect(() => savePendingVersion(test.storage, test.pending)).toThrow('uncertain')
    test.values.set(versionStorageKey(test.owner), JSON.stringify({ ...test.pending, importKey: 'newer:key' }))
    expect(() => advancePendingVersion(test.storage, test.pending, { ...test.pending, uploadReceipt: test.receipt })).toThrow()
  })
  it('does not trust an upload receipt with a different name, byte identity or conversation', () => {
    const test = setup()
    expect(uploadMatchesVersion(test.pending, test.receipt)).toBe(true)
    for (const changed of [{ name: 'Other.pdf' }, { byteLength: 22 }, { contentHash: 'e'.repeat(64) }, { conversationId: 'conversation:other' }]) expect(uploadMatchesVersion(test.pending, { ...test.receipt, ...changed })).toBe(false)
  })
  it('keeps unknown/pending outcomes but clears a hash-bound committed new revision only', async () => {
    const test = setup(), pending = bindRevisionImport({ ...test.pending, uploadReceipt: test.receipt }), value = await completed(pending, test.document)
    savePendingVersion(test.storage, pending)
    for (const status of [{ ...value, job: null }, { ...value, job: fixture.jobResult }]) {
      expect(await versionStateMatches(pending, status)).toBe(true)
      expect(await acknowledgeVersion(test.storage, pending, status)).toBe(false)
    }
    for (const status of [{ ...value, requestHash: 'f'.repeat(64) }, { ...value, generation: 2 }, { ...value, bindingId: 'binding:other' },
      { ...value, request: { ...value.request, expectedCurrentRevisionId: 'revision:changed' } }, { ...value, job: { ...value.job!, document: { ...test.document, documentId: 'doc:other' } } }]) {
      expect(await versionStateMatches(pending, status)).toBe(false)
      expect(await acknowledgeVersion(test.storage, pending, status)).toBe(false)
    }
    expect(test.values.size).toBe(1)
    expect(await acknowledgeVersion(test.storage, pending, value)).toBe(true); expect(test.values.size).toBe(0)
  })
  it('recognizes explicit reuse of the current identical bytes without pretending a new revision was created', async () => {
    const test = setup(), reused = { ...test.pending, upload: { ...test.pending.upload, contentHash: test.old.currentRevision.contentHash, byteLength: test.old.currentRevision.byteLength } }
    const pending = bindRevisionImport({ ...reused, uploadReceipt: { ...test.receipt, contentHash: reused.upload.contentHash, byteLength: reused.upload.byteLength } })
    const state = await completed(pending, test.old)
    expect(await versionStateMatches(pending, state)).toBe(true)
    expect(state.job!.document!.currentRevision.revisionId).toBe(pending.expectedCurrentRevisionId)
    expect(await versionStateMatches(pending, await completed(pending, test.document))).toBe(false)
  })
  it('rechecks view authority after asynchronous receipt hashing and never clears a newer local body', async () => {
    const test = setup(), pending = bindRevisionImport({ ...test.pending, uploadReceipt: test.receipt }), state = await completed(pending, test.document)
    savePendingVersion(test.storage, pending)
    let current = true
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
    const acknowledging = acknowledgeVersion(test.storage, pending, state, () => current)
    await entered.promise; current = false; release.resolve()
    expect(await acknowledging).toBe(false); expect(test.values.size).toBe(1)
    test.values.set(versionStorageKey(test.owner), JSON.stringify({ ...pending, importKey: 'newer:key' }))
    expect(await acknowledgeVersion(test.storage, pending, state)).toBe(false)
  })
})

describe('exact revision history and Reader targets', () => {
  it('selects/removes exact document+revision pairs without excluding or upgrading another version', () => {
    const sources = [{ documentId: 'doc:one', revisionId: 'revision:old' }, { documentId: 'doc:other', revisionId: 'revision:other' }]
    const selected = revisionSourceChoice(sources, 'doc:one', 'revision:new', true)
    expect(selected).toEqual([...sources, { documentId: 'doc:one', revisionId: 'revision:new' }])
    expect(revisionSourceChoice(selected, 'doc:one', 'revision:new', true)).toEqual(selected)
    expect(revisionSourceChoice(selected, 'doc:one', 'revision:new', false)).toEqual(sources)
    expect(sources).toHaveLength(2)
  })
  it('merges real pages without sorting IDs/timestamps or mixing changed current heads and owners', () => {
    const { owner, history } = setup()
    const first = { ...history, versions: history.versions.slice(0, 1), nextCursor: 'cursor:older', truncated: true }
    const second = { ...history, versions: history.versions.slice(1) }
    expect(mergeRevisionHistory(owner, null, first).versions).toEqual(first.versions)
    expect(mergeRevisionHistory(owner, first, second, 'cursor:older').versions).toEqual(history.versions)
    expect(() => mergeRevisionHistory(owner, first, second, 'cursor:wrong')).toThrow()
    expect(() => mergeRevisionHistory(owner, first, { ...second, currentRevisionId: 'revision:newer' }, 'cursor:older')).toThrow()
    expect(() => mergeRevisionHistory(owner, first, { ...second, bindingId: 'binding:other' }, 'cursor:older')).toThrow()
    expect(() => mergeRevisionHistory(owner, first, first, 'cursor:older')).toThrow()
  })
  it('maps each immutable original into distinct A/B PDF sources and rejects stale Reader intents', () => {
    const { owner, history } = setup(), newer = revisionOriginalSource(owner, history.versions[0]!), older = revisionOriginalSource(owner, history.versions[1]!)
    expect(newer.serverRevision!.documentId).toBe(older.serverRevision!.documentId)
    expect(newer.serverRevision!.revisionId).not.toBe(older.serverRevision!.revisionId)
    expect(newer.sha256).not.toBe(older.sha256)
    expect(older.url).toBe(`/api/conversations/${encodeURIComponent(owner.conversationId)}/documents/${encodeURIComponent(owner.documentId)}/${encodeURIComponent(older.serverRevision!.revisionId)}/original`)
    const navigation = new ReaderNavigation(); navigation.reset(versionOwnerKey(owner))
    expect(navigation.complete(navigation.begin('A'), older)).toBe(true)
    expect(navigation.complete(navigation.begin('B'), newer)).toBe(true)
    expect(navigation.state().panes.A.location!.source).toEqual(older); expect(navigation.state().panes.B.location!.source).toEqual(newer)
    const late = navigation.begin('A'); navigation.reset(versionOwnerKey({ ...owner, generation: 2 }))
    expect(navigation.complete(late, older)).toBe(false)
  })
  it('does not invent an original URL for missing, wrong-document or hash-mismatched history', () => {
    const { owner, history } = setup(), entry = history.versions[1]!
    expect(() => revisionOriginalSource(owner, { ...entry, original: null })).toThrow()
    expect(() => revisionOriginalSource({ ...owner, documentId: 'doc:other' }, entry)).toThrow()
    expect(() => revisionOriginalSource(owner, { ...entry, original: { ...entry.original!, contentHash: 'f'.repeat(64) } })).toThrow()
    expect(() => revisionOriginalSource({ ...owner, conversationId: '../escape' }, entry)).toThrow()
  })
  it('renders both selected revisions, unavailable originals and escaped labels without silently opening latest bytes', () => {
    const { history } = setup()
    history.versions[0]!.revision.displayName = '<script>unsafe</script>'
    history.versions[1]!.original = null; history.versions[1]!.source = null
    const html = renderToStaticMarkup(createElement(RevisionVersionList, { history,
      sourceRefs: history.versions.map(item => ({ documentId: item.revision.documentId, revisionId: item.revision.revisionId })), selectionDisabled: false, onRead() {}, onSelect() {} }))
    expect(html.match(/checked=""/gu)).toHaveLength(2)
    expect(html).toContain('当前逻辑版本'); expect(html).toContain('历史版本'); expect(html).toContain('放入对照 A'); expect(html).toContain('放入对照 B')
    expect(html).toContain('不会自动打开另一版本'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>')
    expect(html).not.toContain('href=')
  })
})
