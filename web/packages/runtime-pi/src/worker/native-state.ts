import { closeSync, constants, existsSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { inspectNativeSession } from './session-file.js'

/**
 * Pi 0.85.1 intentionally delays a new JSONL file until its first assistant message.
 * Explicit pre-prompt configuration needs durable native metadata, not a fabricated
 * user/assistant pair. There is no public flush method: use the complete public SDK
 * snapshot, exclusive creation, and the public same-file reopen to adopt flushed state.
 * Existing files are only verified. No private SDK fields, branch-only export, repair,
 * transcript rewriting, or product-receipt reconstruction is involved.
 * Caller must hold the exclusive idle runtime boundary throughout this synchronous call.
 */
export function flushInitialNativeSession(manager: SessionManager): { created: boolean } {
  const file = manager.getSessionFile(), header = manager.getHeader(), entries = manager.getEntries(), leaf = manager.getLeafId()
  if (!manager.isPersisted() || !file || !header || !isAbsolute(file) || resolve(file) !== file
    || realpathSync(dirname(file)) !== dirname(file) || header.id !== manager.getSessionId() || header.cwd !== manager.getCwd()
    || leaf !== null && !entries.some(entry => entry.id === leaf)) throw new Error('Invalid native session bootstrap identity')
  const expected = JSON.stringify(entries)
  if (existsSync(file)) {
    const actual = inspectNativeSession(file, header.id, header.cwd)
    if (JSON.stringify(actual.entries) !== expected) throw new Error('Existing native bytes differ from the SDK state; bootstrap cannot overwrite them')
    return { created: false }
  }
  const bytes = Buffer.from([header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Native bootstrap exceeds its bounded snapshot')
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  // An interrupted partial write remains a fenced native file for explicit recovery;
  // never remove it and retry under the assumption that no durable operation happened.
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  const actual = inspectNativeSession(file, header.id, header.cwd)
  if (JSON.stringify(actual.entries) !== expected) throw new Error('Native bootstrap readback differs from its public SDK snapshot')
  manager.setSessionFile(file)
  if (leaf === null) manager.resetLeaf()
  else if (manager.getLeafId() !== leaf) manager.branch(leaf)
  if (manager.getSessionFile() !== file || manager.getSessionId() !== header.id || manager.getCwd() !== header.cwd
    || manager.getLeafId() !== leaf || JSON.stringify(manager.getEntries()) !== expected) throw new Error('Public SDK reopen changed native bootstrap identity')
  return { created: true }
}
