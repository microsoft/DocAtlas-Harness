import type { ProductRevisionHistory, ProductRevisionImport, ProductRevisionImportState, ProductSubmission, UploadReceipt, UploadStart } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { PdfReaderSource } from '../PdfReader'
import type { LiveState } from './client'
import { canonical, canonicalHash } from './state'

export interface VersionOwner { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number, documentId: string }
export interface PendingVersion {
  schemaVersion: 1
  owner: VersionOwner
  expectedCurrentRevisionId: string
  upload: UploadStart
  uploadReceipt: UploadReceipt | null
  importKey: string
  request: ProductRevisionImport | null
}
export type VersionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
export type VersionOutbox = { state: 'empty' } | { state: 'invalid', key: string } | { state: 'pending', key: string, value: PendingVersion, current: boolean }
export type RevisionEntry = ProductRevisionHistory['versions'][number]
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const sameAccountTarget = (left: VersionOwner, right: VersionOwner) => left.actorId === right.actorId && left.workspaceId === right.workspaceId && left.conversationId === right.conversationId && left.documentId === right.documentId
export const versionOwnerKey = (value: VersionOwner): string => JSON.stringify([value.actorId, value.workspaceId, value.conversationId, value.bindingId, value.generation, value.documentId])
export function versionOwner(state: LiveState, documentId: string): VersionOwner | null {
  const binding = state.snapshot?.binding, actor = state.actor
  return state.phase === 'ready' && binding && actor && opaque(documentId) && state.selected === binding.conversationId
    && binding.ownerActorId === actor.actorId && binding.workspaceId === actor.workspaceId
    ? { ...actor, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, documentId } : null
}
export function versionPrefix(owner: VersionOwner): string {
  return `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@revision:${encodeURIComponent(owner.conversationId)}:${encodeURIComponent(owner.documentId)}:`
}
export function versionStorageKey(owner: VersionOwner): string { return `${versionPrefix(owner)}${encodeURIComponent(owner.bindingId)}:${owner.generation}` }
export function uploadMatchesVersion(pending: PendingVersion, receipt: UploadReceipt): boolean {
  return receipt.conversationId === pending.owner.conversationId && receipt.name === pending.upload.name && receipt.contentHash === pending.upload.contentHash && receipt.byteLength === pending.upload.byteLength
    && (!pending.uploadReceipt || pending.uploadReceipt.uploadId === receipt.uploadId)
}
export function parsePendingVersion(raw: string, owner: VersionOwner): PendingVersion {
  if (new TextEncoder().encode(raw).byteLength > 32768) throw new Error('Revision outbox exceeds its bound')
  const value = JSON.parse(raw) as PendingVersion
  if (!value || !exact(value, ['schemaVersion', 'owner', 'expectedCurrentRevisionId', 'upload', 'uploadReceipt', 'importKey', 'request']) || value.schemaVersion !== 1 || !value.owner
    || !exact(value.owner, ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'generation', 'documentId'])
    || ![value.owner.actorId, value.owner.workspaceId, value.owner.conversationId, value.owner.bindingId, value.owner.documentId, value.expectedCurrentRevisionId, value.importKey].every(opaque)
    || !Number.isSafeInteger(value.owner.generation) || value.owner.generation < 1 || !sameAccountTarget(value.owner, owner)) throw new Error('Invalid revision outbox owner')
  const upload = parseBrowserContract('document-http', value.upload)
  if (upload.kind !== 'upload-start') throw new Error('Invalid immutable upload request')
  let uploadReceipt: UploadReceipt | null = null
  if (value.uploadReceipt !== null) {
    const checked = parseBrowserContract('document-http', value.uploadReceipt)
    if (checked.kind !== 'upload' || !uploadMatchesVersion({ ...value, upload, uploadReceipt: null }, checked)) throw new Error('Revision upload identity differs')
    uploadReceipt = checked
  }
  let request: ProductRevisionImport | null = null
  if (value.request !== null) {
    const checked = parseBrowserContract('product-library', value.request)
    if (checked.kind !== 'revision-import' || !uploadReceipt || checked.uploadId !== uploadReceipt.uploadId || checked.targetDocumentId !== value.owner.documentId
      || checked.expectedCurrentRevisionId !== value.expectedCurrentRevisionId || checked.expectedGeneration !== value.owner.generation || checked.idempotencyKey !== value.importKey) throw new Error('Revision import changed target or original key')
    request = checked
  }
  return { ...value, upload, uploadReceipt, request }
}
export function readVersionOutbox(storage: VersionStorage, owner: VersionOwner): VersionOutbox {
  if (storage.length > 2048) throw new Error('Too many tab drafts')
  const prefix = versionPrefix(owner), keys: string[] = []
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key) }
  if (!keys.length) return { state: 'empty' }
  keys.sort(); const key = keys[0]!
  if (keys.length > 1) return { state: 'invalid', key }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { state: 'invalid', key }
    const value = parsePendingVersion(raw, owner)
    return versionStorageKey(value.owner) === key ? { state: 'pending', key, value, current: versionOwnerKey(value.owner) === versionOwnerKey(owner) } : { state: 'invalid', key }
  } catch { return { state: 'invalid', key } }
}
function retain(storage: VersionStorage, value: PendingVersion): void {
  const raw = JSON.stringify(value), key = versionStorageKey(value.owner)
  parsePendingVersion(raw, value.owner); storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('Revision outbox was not retained')
}
export function savePendingVersion(storage: VersionStorage, value: PendingVersion): void {
  if (readVersionOutbox(storage, value.owner).state !== 'empty') throw new Error('A revision import remains uncertain')
  retain(storage, value)
}
export function advancePendingVersion(storage: VersionStorage, previous: PendingVersion, next: PendingVersion): void {
  if (versionOwnerKey(previous.owner) !== versionOwnerKey(next.owner) || previous.expectedCurrentRevisionId !== next.expectedCurrentRevisionId || previous.importKey !== next.importKey
    || canonical(previous.upload) !== canonical(next.upload) || previous.request && canonical(previous.request) !== canonical(next.request)
    || previous.uploadReceipt && (!next.uploadReceipt || !uploadMatchesVersion(previous, next.uploadReceipt) || previous.uploadReceipt.status === 'stored' && next.uploadReceipt.status !== 'stored')
    || storage.getItem(versionStorageKey(previous.owner)) !== JSON.stringify(previous)) throw new Error('The original revision operation cannot be replaced')
  retain(storage, next)
}
export function bindRevisionImport(pending: PendingVersion): PendingVersion {
  if (!pending.uploadReceipt) throw new Error('Upload reservation has not been verified')
  const request: ProductRevisionImport = pending.request ?? { schemaVersion: 1, kind: 'revision-import', expectedGeneration: pending.owner.generation, idempotencyKey: pending.importKey,
    uploadId: pending.uploadReceipt.uploadId, targetDocumentId: pending.owner.documentId, expectedCurrentRevisionId: pending.expectedCurrentRevisionId }
  return { ...pending, request }
}
export async function versionStateMatches(pending: PendingVersion, candidate: unknown): Promise<boolean> {
  try {
    const value = parseBrowserContract('product-library', candidate), request = pending.request, owner = pending.owner
    if (!request || value.kind !== 'revision-import-state' || value.conversationId !== owner.conversationId || value.bindingId !== owner.bindingId || value.generation !== owner.generation
      || canonical(value.request) !== canonical(request) || value.requestHash !== await canonicalHash(request) || value.job && value.job.workspaceId !== owner.workspaceId) return false
    if (value.job?.status === 'succeeded') {
      const document = value.job.document, revision = document?.currentRevision
      if (!document || !revision || document.documentId !== owner.documentId || document.workspaceId !== owner.workspaceId || revision.contentHash !== pending.upload.contentHash || revision.byteLength !== pending.upload.byteLength
        || revision.revisionId !== pending.expectedCurrentRevisionId && revision.previousRevisionId !== pending.expectedCurrentRevisionId) return false
    }
    return true
  } catch { return false }
}
export async function acknowledgeVersion(storage: VersionStorage, pending: PendingVersion, state: ProductRevisionImportState, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (state.job?.status !== 'succeeded' || !await versionStateMatches(pending, state)) return false
  const key = versionStorageKey(pending.owner)
  if (!isCurrent() || storage.getItem(key) !== JSON.stringify(pending)) return false
  storage.removeItem(key); return true
}
export function revisionSourceChoice(sources: ProductSubmission['sourceRefs'], documentId: string, revisionId: string, selected: boolean): ProductSubmission['sourceRefs'] {
  if (![documentId, revisionId].every(opaque)) throw new Error('Invalid revision selection')
  const included = sources.some(value => value.documentId === documentId && value.revisionId === revisionId)
  return selected ? included ? structuredClone(sources) : [...structuredClone(sources), { documentId, revisionId }]
    : sources.filter(value => value.documentId !== documentId || value.revisionId !== revisionId).map(value => ({ ...value }))
}
export function mergeRevisionHistory(owner: VersionOwner, previous: ProductRevisionHistory | null, next: ProductRevisionHistory, cursor?: string): ProductRevisionHistory {
  const value = parseBrowserContract('product-library', next)
  if (value.kind !== 'revision-history' || value.conversationId !== owner.conversationId || value.bindingId !== owner.bindingId || value.generation !== owner.generation || value.documentId !== owner.documentId
    || cursor && (!previous || previous.nextCursor !== cursor || previous.documentId !== value.documentId || previous.currentRevisionId !== value.currentRevisionId || previous.bindingId !== value.bindingId || previous.generation !== value.generation)) throw new Error('Revision history changed while paging')
  const versions = cursor ? [...previous!.versions, ...value.versions] : value.versions
  if (versions.length > 256 || new Set(versions.map(item => item.revision.revisionId)).size !== versions.length) throw new Error('Revision page overlap or display limit')
  return { ...value, versions: structuredClone(versions) }
}
export function revisionOriginalSource(owner: VersionOwner, entry: RevisionEntry): PdfReaderSource {
  const { revision, original } = entry
  if (!original || ![owner.conversationId, owner.documentId, revision.revisionId].every(opaque) || revision.documentId !== owner.documentId
    || original.documentId !== owner.documentId || original.revisionId !== revision.revisionId || original.contentHash !== revision.contentHash || original.byteLength !== revision.byteLength
    || revision.mediaType !== 'application/pdf' || original.pageCount !== revision.pageCount) throw new Error('Original revision PDF is unavailable or changed')
  return { id: `${owner.documentId}:${revision.revisionId}`, name: original.name, kind: 'server', sha256: original.contentHash, bytes: original.byteLength, pages: original.pageCount,
    serverRevision: { documentId: owner.documentId, revisionId: revision.revisionId },
    url: `/api/conversations/${encodeURIComponent(owner.conversationId)}/documents/${encodeURIComponent(owner.documentId)}/${encodeURIComponent(revision.revisionId)}/original` }
}
