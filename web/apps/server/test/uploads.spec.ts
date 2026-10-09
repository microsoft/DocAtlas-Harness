import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { UploadStore } from '../src/documents/uploads.js'

const actor = { actorId: 'actor:upload', workspaceId: 'workspace:upload' }, conversation = 'conversation:upload'
const bytes = Buffer.from('%PDF-upload-byte-fixture'), contentHash = createHash('sha256').update(bytes).digest('hex')
const request = { schemaVersion: 1 as const, kind: 'upload-start' as const, idempotencyKey: 'upload:fixture-key', name: 'fixture.pdf', byteLength: bytes.length, contentHash }
it('reserves stable identity, verifies bytes, survives reopen and fences foreign conversation/actor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-uploads-')), metadata = join(root, 'metadata'), files = join(root, 'files')
  let store = new UploadStore(metadata, files, actor)
  try {
    const receipt = store.reserve(conversation, request)
    expect(store.reserve(conversation, request)).toEqual(receipt)
    expect(() => store.reserve(conversation, { ...request, name: 'changed.pdf' })).toThrow('different')
    expect(() => store.get('conversation:other', receipt.uploadId)).toThrow('accessible')
    await expect(store.put(conversation, receipt.uploadId, Readable.from([Buffer.from('wrong')]), () => {})).rejects.toThrow('declared')
    expect(store.get(conversation, receipt.uploadId).status).toBe('pending')
    expect(readdirSync(files)).toEqual([])
    expect((await store.put(conversation, receipt.uploadId, Readable.from([bytes]), () => {})).status).toBe('stored')
    const materialized = await store.materialize(receipt.uploadId, conversation, actor.workspaceId)
    expect(materialized.displayName).toBe('fixture.pdf'); expect(materialized.relativePath).toBe(`${contentHash}.pdf`)
    expect(readFileSync(join(files, materialized.relativePath))).toEqual(bytes)
    await store.close(); store = new UploadStore(metadata, files, actor)
    expect(store.get(conversation, receipt.uploadId).status).toBe('stored')
    const foreign = new UploadStore(metadata, files, { ...actor, actorId: 'actor:foreign' })
    try { expect(() => foreign.get(conversation, receipt.uploadId)).toThrow('accessible') } finally { await foreign.close() }
    chmodSync(join(files, materialized.relativePath), 0o600); writeFileSync(join(files, materialized.relativePath), Buffer.alloc(bytes.length, 1))
    await expect(store.materialize(receipt.uploadId, conversation, actor.workspaceId)).rejects.toThrow('integrity')
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }) }
})
it('joins an interrupted transfer and leaves a resumable reservation without a partial file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-upload-abort-')), metadata = join(root, 'metadata'), files = join(root, 'files')
  const store = new UploadStore(metadata, files, actor)
  try {
    const receipt = store.reserve(conversation, request), input = new PassThrough()
    const pending = store.put(conversation, receipt.uploadId, input, () => {}).catch(() => null)
    input.write(bytes.subarray(0, 5)); await store.close(); expect(await pending).toBeNull()
    expect(readdirSync(files)).toEqual([])
    const reopened = new UploadStore(metadata, files, actor)
    try { expect(reopened.get(conversation, receipt.uploadId).status).toBe('pending') } finally { await reopened.close() }
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }) }
})
it('does not overwrite or remove an orphan/other-process staging file for the same reservation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-upload-orphan-')), files = join(root, 'files'), store = new UploadStore(join(root, 'metadata'), files, actor)
  try {
    const receipt = store.reserve(conversation, request), file = join(files, `.upload-${createHash('sha256').update(receipt.uploadId).digest('hex')}.part`)
    writeFileSync(file, 'partial owned bytes')
    await expect(store.put(conversation, receipt.uploadId, Readable.from([bytes]), () => {})).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('partial owned bytes')
    expect(store.get(conversation, receipt.uploadId).status).toBe('pending')
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }) }
})
