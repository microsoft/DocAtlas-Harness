import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersonalizationCommandRequest } from '@docatlas/contracts'
import { PersonalizationStore } from '../src/storage/personalization-store.js'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m6/personalization.valid.json', import.meta.url), 'utf8')) as {
  commands: { setSessionPolicyRequest: PersonalizationCommandRequest, setPreferenceRequest: PersonalizationCommandRequest },
}
const setting = fixture.commands.setPreferenceRequest, policy = fixture.commands.setSessionPolicyRequest, profileId = setting.profileId
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'docatlas-profile-epoch-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const store = await open(root); return { root, store }
}
async function open(root: string) { const store = await PersonalizationStore.open(root); cleanups.push(() => store.close()); return store }
function erase(store: PersonalizationStore, key = 'erase:profile:first'): PersonalizationCommandRequest {
  return { schemaVersion: 1, requestType: 'personalization-command', profileId, sessionId: setting.sessionId, actor: setting.actor,
    action: 'forget', target: 'profile', idempotencyKey: key, expectedProfileRevision: store.ledgerRevision(profileId), mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true }
}
function makeV1(path: string) {
  const database = new DatabaseSync(path)
  try { database.exec('ALTER TABLE personalization_metadata DROP COLUMN profile_epoch'); database.exec('UPDATE personalization_metadata SET schema_version = 1') }
  finally { database.close() }
}

describe('trusted profile-epoch erasure fences with legacy-compatible commands', () => {
  it('rejects old submitted and never-submitted commands after erasure, permits only its exact receipt replay, and admits explicit new-epoch settings', async () => {
    const { root, store } = await setup()
    expect(store.profileEpoch(profileId)).toBe(0)
    store.command(setting, 0); store.command(policy, 0)
    const request = erase(store), erased = store.command(request, 0)
    expect(erased).toMatchObject({ status: 'completed', action: 'forget', receipt: { mode: 'privacy-erasure', backupDisposition: 'compacted' } })
    expect(store.profileEpoch(profileId)).toBe(1); expect(store.currentMemories(profileId)).toEqual([])
    expect(store.sessionPolicy(profileId, setting.sessionId)).toBeUndefined()
    for (const command of [setting, policy, { ...setting, idempotencyKey: 'old:never-submitted' }]) {
      expect(() => store.command(command, 0)).toThrowError(expect.objectContaining({ code: 'conflict', message: expect.stringContaining('epoch changed') }))
    }
    expect(store.command(request, 0)).toMatchObject({ status: 'replayed', receipt: erased.action === 'forget' ? erased.receipt : undefined })
    expect(store.profileEpoch(profileId)).toBe(1)
    expect(() => store.command({ ...request, idempotencyKey: 'different:erase' }, 0)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => store.command(request, 99)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.command({ ...setting, idempotencyKey: 'new:setting' }, 1)).toMatchObject({ action: 'set-preference', status: 'created' })
    expect(store.command({ ...policy, idempotencyKey: 'new:policy' }, 1)).toMatchObject({ action: 'set-session-policy', status: 'applied' })
    expect(store.currentMemories(profileId)).toHaveLength(1)
    const second = erase(store, 'erase:profile:second'); store.command(second, 1)
    expect(store.profileEpoch(profileId)).toBe(2); expect(store.command(second, 1).status).toBe('replayed')
    expect(() => store.command(request, 0)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const path = store.databasePath(profileId); store.close()
    expect((await readFile(path)).toString('utf8')).not.toContain('Show key figures with their table context.')
    const reopened = await open(root)
    expect(reopened.profileEpoch(profileId)).toBe(2); expect(reopened.currentMemories(profileId)).toEqual([])
    expect(reopened.command(second, 1).status).toBe('replayed')
  })

  it('checks the durable epoch under the write transaction even with another already-open store handle', async () => {
    const { root, store: first } = await setup(), second = await open(root)
    const stale = first.profileEpoch(profileId)
    first.command(setting, stale); expect(second.profileEpoch(profileId)).toBe(0)
    const request = erase(second); second.command(request, 0)
    expect(first.profileEpoch(profileId)).toBe(1)
    expect(() => first.command({ ...setting, idempotencyKey: 'cached-handle:late-request' }, stale)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(first.currentMemories(profileId)).toEqual([])
    expect(first.command(request, stale).status).toBe('replayed')
    expect(first.profileEpoch(profileId)).toBe(1)
  })

  it('keeps the omitted guard compatible with existing DSH command/replay behavior', async () => {
    const { store } = await setup()
    expect(store.command(setting).status).toBe('created'); expect(store.command(setting).status).toBe('replayed')
    const request = erase(store); store.command(request)
    expect(store.command(request).status).toBe('replayed'); expect(store.profileEpoch(profileId)).toBe(1)
    // Legacy callers have no epoch-bearing envelope. Product hosts must supply the trusted guard.
    expect(store.command(setting).status).toBe('created')
    expect(() => store.command(setting, 0)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.command(setting, 1).status).toBe('replayed')
  })

  it('migrates an ordinary v1 profile without changing existing memories, receipts, ledger revision or private backup guarantees', async () => {
    const { root, store } = await setup()
    const saved = store.command(setting), revision = store.ledgerRevision(profileId), path = store.databasePath(profileId)
    store.close(); makeV1(path)
    const migrated = await open(root)
    expect(migrated.profileEpoch(profileId)).toBe(0); expect(migrated.ledgerRevision(profileId)).toBe(revision)
    expect(migrated.command(setting, 0)).toEqual({ ...saved, status: 'replayed' })
    expect(migrated.currentMemories(profileId)).toHaveLength(1)
    const backups = await readdir(join(root, 'profiles', 'backups'))
    expect(backups.some(name => name.includes('.v1.'))).toBe(true)
    for (const name of backups) expect((await stat(join(root, 'profiles', 'backups', name))).mode & 0o777).toBe(0o600)
    const database = new DatabaseSync(path, { readOnly: true })
    try { expect(database.prepare('SELECT schema_version, profile_epoch FROM personalization_metadata').get()).toMatchObject({ schema_version: 3, profile_epoch: 0 }) } finally { database.close() }
  })

  it('migrates a v1 privacy receipt to a nonzero fence and still compacts migration backups/exports on the next erasure', async () => {
    const { root, store } = await setup(); store.command(setting); store.command(policy)
    const original = erase(store); store.command(original)
    const path = store.databasePath(profileId); store.close(); makeV1(path)
    const migrated = await open(root)
    expect(migrated.profileEpoch(profileId)).toBe(1)
    expect(() => migrated.command(setting, 0)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => migrated.command(policy, 0)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(migrated.command(original, 0).status).toBe('replayed')
    migrated.command({ ...setting, idempotencyKey: 'migration:new-setting' }, 1)
    const exportResult = migrated.command({ schemaVersion: 1, requestType: 'personalization-command', profileId, sessionId: setting.sessionId, actor: setting.actor,
      idempotencyKey: 'migration:export', action: 'export', format: 'json', includeProvenanceRefs: false, includeStatuses: ['active'] }, 1)
    if (exportResult.action !== 'export') throw new Error('Expected managed export')
    migrated.command(erase(migrated, 'migration:second-erase'), 1)
    expect(migrated.profileEpoch(profileId)).toBe(2)
    expect(await readdir(join(root, 'profiles', 'backups'))).toEqual([])
    expect(await readdir(join(root, 'profiles', 'exports'))).toEqual([])
    expect(() => migrated.exportAsset(profileId, exportResult.export.assetId)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    try { expect((await stat(`${path}-wal`)).size).toBe(0) } catch (error) { expect(error).toMatchObject({ code: 'ENOENT' }) }
  })

  it('does not advance an epoch on failed erasure and rejects invalid or exhausted guards', async () => {
    const { root, store } = await setup(); store.command(setting, 0)
    for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => store.command(setting, value)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const backup = join(root, 'profiles', 'backups', `${createProfileHash(profileId)}.corrupt.sqlite3`)
    await writeFile(backup, 'not a database', { mode: 0o600 })
    expect(() => store.command(erase(store), 0)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    expect(store.profileEpoch(profileId)).toBe(0); expect(store.currentMemories(profileId)).toHaveLength(1)
    const database = new DatabaseSync(store.databasePath(profileId))
    try { database.prepare('UPDATE personalization_metadata SET profile_epoch = ?').run(Number.MAX_SAFE_INTEGER) } finally { database.close() }
    expect(() => store.command(erase(store), Number.MAX_SAFE_INTEGER)).toThrowError(expect.objectContaining({ code: 'limit-exceeded' }))
    expect(store.profileEpoch(profileId)).toBe(Number.MAX_SAFE_INTEGER); expect(store.currentMemories(profileId)).toHaveLength(1)
  })
})

function createProfileHash(value: string) {
  // Same profile path namespace, used only to create a corrupt managed-backup fixture.
  return createHash('sha256').update(value).digest('hex')
}
