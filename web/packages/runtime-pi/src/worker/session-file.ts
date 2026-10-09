import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

export interface NativeSessionSeal { version: 1, sessionId: string, cwd: string, transcriptHash: string, byteLength: number, entryCount: number, leafEntryId: string | null }

/** Reads one bounded, unchanged native file. No repair, migration, truncation or guessed session discovery. */
export function inspectNativeSession(file: string, sessionId: string, cwd: string, durable = false): { seal: NativeSessionSeal, entries: Record<string, unknown>[] } {
  if (realpathSync(file) !== file) throw new Error('Native session path changed')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (durable) {
      fsyncSync(fd)
      const directory = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > 64 * 1024 * 1024) throw new Error('Native session size invalid')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error('Incomplete native file'); offset += count }
    const after = fstatSync(fd), current = statSync(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs) throw new Error('Native session changed while reading')
    const rows = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    const header = rows.shift()
    if (header?.type !== 'session' || header.version !== 3 || header.id !== sessionId || header.cwd !== cwd) throw new Error('Native session identity mismatch')
    const ids = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row.type !== 'string' || typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(row.id) || ids.has(row.id)
        || row.parentId !== null && (typeof row.parentId !== 'string' || !ids.has(row.parentId))) throw new Error('Invalid native branch topology')
      ids.add(row.id)
    }
    return { seal: { version: 1, sessionId, cwd, transcriptHash: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
      entryCount: rows.length, leafEntryId: rows.at(-1)?.id as string ?? null }, entries: rows }
  } finally { closeSync(fd) }
}
export function openNativeSession(file: string, sessionDir: string, expected: NativeSessionSeal): SessionManager {
  const { seal, entries } = inspectNativeSession(file, expected.sessionId, expected.cwd)
  if (JSON.stringify(seal) !== JSON.stringify(expected)) throw new Error('Closed native session seal mismatch')
  const manager = SessionManager.open(file, sessionDir)
  if (manager.getSessionId() !== expected.sessionId || manager.getCwd() !== expected.cwd || manager.getLeafId() !== expected.leafEntryId
    || JSON.stringify(manager.getEntries()) !== JSON.stringify(entries)) throw new Error('SDK native session did not restore exactly')
  return manager
}
