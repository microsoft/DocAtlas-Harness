import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import { productControlIssues, type ProductPiCheckpoint } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

/** Generate a checkpoint from an idle, actually persisted native session, never a UI callback. */
export function checkpointPiSubmission(session: AgentSession, input: {
  submissionId: string, requestHash: string, userEntryId: string, expectedText: string,
  maxBytes?: number, now?: () => Date,
}): ProductPiCheckpoint {
  if (!session.isIdle) throw new Error('Pi session has not settled')
  const file = session.sessionFile
  if (!file || realpathSync(file) !== resolve(file)) throw new Error('Pi checkpoint requires an existing non-symlink native file')
  const branch = session.sessionManager.getBranch()
  const user = branch.find(entry => entry.id === input.userEntryId)
  if (user?.type !== 'message' || user.message.role !== 'user') throw new Error('Submission user entry is not on the current native branch')
  const content = user.message.content
  const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (text !== input.expectedText) throw new Error('Native user entry does not match the submitted model input')
  const last = session.messages.findLast(message => message.role === 'assistant')
  if (last?.role !== 'assistant' || last.stopReason !== 'stop') throw new Error('Pi has not produced a successful final answer')
  const leafEntryId = session.sessionManager.getLeafId()
  if (!leafEntryId || leafEntryId === input.userEntryId) throw new Error('Missing native completion leaf')
  const maxBytes = input.maxBytes ?? 64 * 1024 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw new Error('Invalid native checkpoint byte limit')
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > maxBytes) throw new Error('Native transcript exceeds checkpoint resource limit')
    // Flush both file data and its directory entry before allowing a saved-success receipt.
    fsyncSync(fd)
    const bytes = readFileSync(fd)
    const parent = openSync(dirname(file), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
    try { fsyncSync(parent) } finally { closeSync(parent) }
    const after = fstatSync(fd)
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Native transcript changed during checkpoint')
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) JSON.parse(line)
    const restored = SessionManager.open(file)
    if (restored.getSessionId() !== session.sessionId || restored.getLeafId() !== leafEntryId
      || !restored.getBranch().some(entry => entry.id === input.userEntryId)) throw new Error('Disk transcript does not match the current Pi session/branch')
    const current = statSync(file)
    if (current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs
      || JSON.stringify(restored.getEntries()) !== JSON.stringify(session.sessionManager.getEntries())) throw new Error('Native file or message contents changed during checkpoint')
    const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: input.submissionId,
      requestHash: input.requestHash, runtimeSessionId: session.sessionId, userEntryId: input.userEntryId, leafEntryId,
      transcriptHash: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
      entryCount: restored.getEntries().length, settledAt: (input.now ?? (() => new Date()))().toISOString() }
    parseContract('product-control', checkpoint)
    if (productControlIssues(checkpoint).length) throw new Error('Invalid native checkpoint semantics')
    return checkpoint
  } finally { closeSync(fd) }
}
