import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { NativeSelectedHead } from '@docatlas/contracts'
import { inspectNativeSession, verifyNativeSelectedHead, type NativeSessionSeal } from '@docatlas/runtime-pi/worker'
import { ControlStoreError } from '../storage/control-store.js'
import { dedicatedDirectory } from '../storage/runtime-catalog.js'

const fail = (message: string): never => { throw new ControlStoreError('integrity-error', message) }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Caller holds Catalog's exclusive installation transaction after native joins.
 * Preserve the SDK's exact bytes/header/IDs; never recreate a child from receipts,
 * overwrite another destination, or remove staging on an elapsed-time guess.
 */
export function installNativeFork(sourceFile: string, targetDirectory: string, cwd: string, head: NativeSelectedHead, operationId: string): { filename: string, seal: NativeSessionSeal } {
  if (!/^lineage:[a-f0-9-]{36}$/u.test(operationId)) fail('Invalid native fork reservation')
  const filename = basename(sourceFile)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\.jsonl$/u.test(filename) || sourceFile === join(targetDirectory, filename)) fail('Invalid native fork installation path')
  verifyNativeSelectedHead(sourceFile, cwd, head, { exactFile: true })
  dedicatedDirectory(targetDirectory)
  const target = join(targetDirectory, filename), staging = join(targetDirectory, `.${filename}.${operationId.slice(8)}.install`)
  const removeStage = (sourceBytes?: Buffer) => {
    if (!existsSync(staging)) return
    const status = lstatSync(staging)
    if (!status.isFile() || status.isSymbolicLink() || realpathSync(staging) !== staging) fail('Native fork staging is not its reserved regular file')
    if (existsSync(target)) {
      const installed = lstatSync(target)
      if (status.ino !== installed.ino || status.dev !== installed.dev) fail('Native fork staging does not match the installed inode')
    } else {
      // Only an exact partial prefix of this immutable SDK output is recoverable
      // staging. Different data is an integrity error, not disposable user data.
      if (!sourceBytes || status.nlink !== 1 || status.size > sourceBytes.length
        || !readFileSync(staging).equals(sourceBytes.subarray(0, status.size))) fail('Native fork staging differs from its reserved SDK bytes')
    }
    unlinkSync(staging); syncDirectory(targetDirectory)
  }
  if (existsSync(target)) {
    verifyNativeSelectedHead(target, cwd, head, { exactFile: true })
    removeStage()
    return { filename, seal: inspectNativeSession(target, head.fileSeal.sessionId, cwd, true).seal }
  }
  if (realpathSync(sourceFile) !== sourceFile) fail('Native fork source path changed')
  const source = openSync(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try { bytes = readFileSync(source) } finally { closeSync(source) }
  if (bytes.length !== head.fileSeal.byteLength || hash(bytes) !== head.fileSeal.transcriptHash) fail('Native fork source changed before installation')
  removeStage(bytes)
  const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (!count) fail('Native fork staging write was incomplete'); offset += count }
    fsyncSync(fd)
  } finally { closeSync(fd) }
  verifyNativeSelectedHead(staging, cwd, head, { exactFile: true })
  linkSync(staging, target) // Exclusive final name, never rename-overwrite.
  syncDirectory(targetDirectory)
  removeStage()
  return { filename, seal: inspectNativeSession(target, head.fileSeal.sessionId, cwd, true).seal }
}
