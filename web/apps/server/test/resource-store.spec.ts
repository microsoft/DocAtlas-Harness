import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceStore } from '../src/storage/resource-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const actor = { actorId: 'actor:resource', workspaceId: 'workspace:resource' }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-resources-')), source = join(root, 'source'), state = join(root, 'state')
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(source, 'extensions'), { recursive: true })
  mkdirSync(join(source, 'skills', 'example'), { recursive: true })
  writeFileSync(join(source, 'extensions', 'example.js'), 'export default function() {}')
  writeFileSync(join(source, 'skills', 'example', 'SKILL.md'), '# Approved skill')
  const store = new ResourceStore(state)
  cleanup.push(() => store.close())
  return { root, source, state, store }
}
it('captures exact content, binds approval to actor/hash, and persists across reopen', () => {
  const { source, state, store } = fixture(), captured = store.capture(source)
  expect(store.capture(source)).toEqual(captured)
  expect(() => store.approve(actor, captured.snapshotId, '0'.repeat(64))).toThrow('reviewed')
  const approved = store.approve(actor, captured.snapshotId, captured.manifestHash)
  expect(store.approve(actor, captured.snapshotId, captured.manifestHash)).toEqual(approved)
  expect(() => store.lease({ ...actor, workspaceId: 'workspace:other' }, approved.approvalId)).toThrow('unavailable')
  const lease = store.lease(actor, approved.approvalId)
  writeFileSync(join(source, 'extensions', 'example.js'), 'unreviewed replacement')
  expect(readFileSync(join(lease.treeRoot, 'extensions', 'example.js'), 'utf8')).toBe('export default function() {}')
  expect(store.capture(source).snapshotId).not.toBe(captured.snapshotId)
  store.close()
  const reopened = new ResourceStore(state); cleanup.push(() => reopened.close())
  expect(reopened.get(actor, approved.approvalId)).toEqual(approved)
})
it('revokes outstanding leases synchronously and requires a new grant version', () => {
  const { store, source } = fixture(), captured = store.capture(source), grant = store.approve(actor, captured.snapshotId, captured.manifestHash)
  const lease = store.lease(actor, grant.approvalId), changed = vi.fn()
  const off = lease.subscribe(changed)
  store.approve(actor, captured.snapshotId, captured.manifestHash)
  expect(changed).not.toHaveBeenCalled()
  store.revoke(actor, grant.approvalId)
  expect(changed).toHaveBeenCalledOnce()
  expect(() => lease.assertCurrent()).toThrow('changed')
  expect(() => store.lease(actor, grant.approvalId)).toThrow('revoked')
  expect(store.approve(actor, captured.snapshotId, captured.manifestHash).version).toBe(3)
  expect(() => lease.assertCurrent()).toThrow('changed')
  off()
})
it('rejects oversized files before reading and detects malformed durable approval rows', () => {
  const { source, state, store } = fixture(), captured = store.capture(source), approved = store.approve(actor, captured.snapshotId, captured.manifestHash)
  const oversized = join(source, 'oversized.bin'); writeFileSync(oversized, ''); truncateSync(oversized, 32 * 1024 * 1024 + 1)
  expect(() => store.capture(source)).toThrow('limit')
  const db = new DatabaseSync(join(state, 'resource-approvals.sqlite3'))
  try { db.prepare('UPDATE approvals SET value=? WHERE id=?').run(JSON.stringify({ ...approved, actorId: 'actor:forged' }), approved.approvalId) } finally { db.close() }
  expect(() => store.get(actor, approved.approvalId)).toThrow('identity')
  expect(() => store.approve(actor, captured.snapshotId, captured.manifestHash)).toThrow('identity')
})
it('rejects symlinks, credential/configuration files, protected roots and tampered snapshots', () => {
  const { root, source, store } = fixture()
  const captured = store.capture(source), approval = store.approve(actor, captured.snapshotId, captured.manifestHash), lease = store.lease(actor, approval.approvalId)
  const file = join(lease.treeRoot, 'extensions', 'example.js')
  chmodSync(file, 0o600); writeFileSync(file, 'tampered')
  expect(() => store.lease(actor, approval.approvalId)).toThrow('integrity')
  writeFileSync(join(source, 'auth.json'), '{}')
  expect(() => store.capture(source)).toThrow('Private')
  const separate = join(root, 'linked'); mkdirSync(separate); symlinkSync(join(source, 'auth.json'), join(separate, 'resource.js'))
  expect(() => store.capture(separate)).toThrow('symlinks')
  expect(() => store.capture(root)).toThrow('protected')
})
