import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildSessionContext, SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent'
import type { NativeFileSeal, NativeSelectedHead } from '@docatlas/contracts'

type Entry = Record<string, unknown>
export interface NativeFileSnapshot {
  seal: NativeFileSeal
  header: Entry
  entries: Entry[]
  /** Private fixed-byte prefix derivation; never serializable browser/worker result data. */
  prefixSeal(entryCount: number): NativeFileSeal
}
const object = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const exact = (value: Entry, keys: string) => Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const invalid = (): never => { throw new Error('Native selected-head verification failed') }
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)

function parseSeal(value: unknown): NativeFileSeal {
  if (!object(value) || !exact(value, 'version,sessionId,transcriptHash,byteLength,entryCount,tailEntryId') || value.version !== 1 || !id(value.sessionId)
    || !digest(value.transcriptHash) || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 1 || (value.byteLength as number) > 67108864
    || !Number.isSafeInteger(value.entryCount) || (value.entryCount as number) < 0 || value.tailEntryId !== null && !id(value.tailEntryId)
    || ((value.entryCount === 0) !== (value.tailEntryId === null))) return invalid()
  return structuredClone(value) as unknown as NativeFileSeal
}
function parseHead(value: unknown): NativeSelectedHead {
  if (!object(value) || !exact(value, 'version,fileSeal,selectedLeafEntryId,contextHash') || value.version !== 1
    || value.selectedLeafEntryId !== null && !id(value.selectedLeafEntryId) || !digest(value.contextHash)) return invalid()
  return { version: 1, fileSeal: parseSeal(value.fileSeal), selectedLeafEntryId: value.selectedLeafEntryId as string | null, contextHash: value.contextHash }
}

function read(file: string, sessionId: string, cwd: string, options: { expected?: NativeFileSeal, exactFile?: boolean, durable?: boolean } = {}): NativeFileSnapshot {
  if (!id(sessionId) || realpathSync(file) !== file) return invalid()
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (options.durable) {
      fsyncSync(fd)
      const directory = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    const before = fstatSync(fd), length = options.expected?.byteLength ?? before.size
    if (!before.isFile() || !Number.isSafeInteger(length) || length < 1 || length > 67108864 || before.size < length || before.size > 67108864
      || options.exactFile && before.size !== length) return invalid()
    const bytes = Buffer.alloc(length)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) return invalid(); offset += count }
    const after = fstatSync(fd), current = statSync(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs || bytes.at(-1) !== 10) return invalid()
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n'); lines.pop()
    if (!lines.length || lines.some(line => !line)) return invalid()
    const rows: unknown[] = lines.map(line => JSON.parse(line)), header = rows.shift()
    if (!object(header) || header.type !== 'session' || header.version !== 3 || header.id !== sessionId || header.cwd !== cwd) return invalid()
    const entries: Entry[] = [], seen = new Set<string>()
    for (const row of rows) {
      if (!object(row) || typeof row.type !== 'string' || row.type === 'session' || !id(row.id) || seen.has(row.id)
        || row.parentId !== null && (!id(row.parentId) || !seen.has(row.parentId))) return invalid()
      seen.add(row.id); entries.push(row)
    }
    const seal: NativeFileSeal = { version: 1, sessionId, transcriptHash: sha(bytes), byteLength: bytes.length, entryCount: entries.length, tailEntryId: entries.at(-1)?.id as string ?? null }
    if (options.expected && !same(seal, options.expected)) return invalid()
    const ends: number[] = []; let end = Buffer.byteLength(lines[0]!, 'utf8') + 1
    ends.push(end)
    for (const line of lines.slice(1)) { end += Buffer.byteLength(line, 'utf8') + 1; ends.push(end) }
    const prefixSeal = (entryCount: number): NativeFileSeal => {
      if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > entries.length) return invalid()
      const byteLength = ends[entryCount]!
      return { version: 1, sessionId, transcriptHash: sha(bytes.subarray(0, byteLength)), byteLength, entryCount, tailEntryId: entries[entryCount - 1]?.id as string ?? null }
    }
    return { seal, header, entries, prefixSeal }
  } finally { closeSync(fd) }
}

/** Exact full-file integrity. tailEntryId is append position, never a guess about the selected branch. */
export function inspectNativeFile(file: string, sessionId: string, cwd: string, durable = false): NativeFileSnapshot {
  return read(file, sessionId, cwd, { durable, exactFile: true })
}

/** Verify one immutable native prefix. Cold restore must additionally require exactFile: true. */
export function verifyNativeFileSeal(file: string, cwd: string, candidate: NativeFileSeal, options: { exactFile?: boolean } = {}): NativeFileSnapshot {
  const expected = parseSeal(candidate)
  return read(file, expected.sessionId, cwd, { expected, exactFile: options.exactFile === true })
}

function selectedContextHash(entries: Entry[], selectedLeafEntryId: string | null): string {
  // Pi's omitted argument means latest append; an explicit null means the genuine empty root.
  // Require existence ourselves: the SDK's fallback behavior is not a selection authorization.
  if (selectedLeafEntryId !== null && !entries.some(entry => entry.id === selectedLeafEntryId)) return invalid()
  return sha(canonical(buildSessionContext(entries as unknown as SessionEntry[], selectedLeafEntryId)))
}

/** Private verification only: no raw entries, tool payloads or context are returned in the public head. */
export function verifyNativeSelectedHead(file: string, cwd: string, candidate: NativeSelectedHead, options: { exactFile?: boolean } = {}): NativeSelectedHead {
  const head = parseHead(candidate), snapshot = verifyNativeFileSeal(file, cwd, head.fileSeal, options)
  if (selectedContextHash(snapshot.entries, head.selectedLeafEntryId) !== head.contextHash) return invalid()
  return structuredClone(head)
}

/** Hold the exclusive runtime boundary. Selection comes from the public manager, not JSONL order. */
export function captureNativeSelectedHead(manager: SessionManager, durable = false): NativeSelectedHead {
  const file = manager.getSessionFile()
  if (!file || !manager.isPersisted()) return invalid()
  const snapshot = inspectNativeFile(file, manager.getSessionId(), manager.getCwd(), durable), selectedLeafEntryId = manager.getLeafId()
  if (!same(snapshot.entries, manager.getEntries())) return invalid()
  const contextHash = selectedContextHash(snapshot.entries, selectedLeafEntryId)
  if (sha(canonical(manager.buildSessionContext())) !== contextHash) return invalid()
  return { version: 1, fileSeal: snapshot.seal, selectedLeafEntryId, contextHash }
}

/** Restore the complete native file and explicit selection before any SDK/extension factory runs. */
export function restoreNativeSelectedSession(file: string, sessionDir: string, cwd: string, candidate: NativeSelectedHead): SessionManager {
  const expected = verifyNativeSelectedHead(file, cwd, candidate, { exactFile: true }), snapshot = verifyNativeFileSeal(file, cwd, expected.fileSeal, { exactFile: true })
  const manager = SessionManager.open(file, sessionDir)
  if (manager.getSessionId() !== expected.fileSeal.sessionId || manager.getCwd() !== cwd || manager.getSessionFile() !== file || !same(manager.getEntries(), snapshot.entries)) return invalid()
  if (expected.selectedLeafEntryId === null) manager.resetLeaf()
  else manager.branch(expected.selectedLeafEntryId)
  if (!same(captureNativeSelectedHead(manager), expected)) return invalid()
  return manager
}
