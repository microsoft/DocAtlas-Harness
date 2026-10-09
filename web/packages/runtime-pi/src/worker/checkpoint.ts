import { createHash } from 'node:crypto'
import { openSync, closeSync, readSync, fstatSync, realpathSync, statSync, constants } from 'node:fs'
import type { ProductPiCheckpoint, NativeConversationHistory, NativeConversationMessage } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

/** Verify the committed prefix even if a later native turn already appended to the same file. */
export function verifyWorkerCheckpoint(file: string, candidate: unknown, inspect?: (entries: Record<string, unknown>[], checkpoint: ProductPiCheckpoint) => void): ProductPiCheckpoint {
  const checkpoint = parseContract('product-control', candidate)
  if (checkpoint.kind !== 'pi-checkpoint' || checkpoint.byteLength > 64 * 1024 * 1024 || realpathSync(file) !== file) throw new Error('Invalid worker checkpoint')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < checkpoint.byteLength) throw new Error('Incomplete native checkpoint')
    const bytes = Buffer.alloc(checkpoint.byteLength)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error('Incomplete checkpoint prefix'); offset += count }
    if (createHash('sha256').update(bytes).digest('hex') !== checkpoint.transcriptHash) throw new Error('Native checkpoint hash mismatch')
    const current = statSync(file)
    if (before.ino !== current.ino || before.dev !== current.dev) throw new Error('Native transcript replaced')
    const entries = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    const header = entries.shift()
    if (header?.type !== 'session' || header.id !== checkpoint.runtimeSessionId || entries.length !== checkpoint.entryCount) throw new Error('Native checkpoint identity mismatch')
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    if (byId.size !== entries.length || entries.some(entry => typeof entry.id !== 'string')) throw new Error('Duplicate or missing native identity')
    const seen = new Set<unknown>()
    let entry = byId.get(checkpoint.leafEntryId), final = false, foundUser = false
    while (entry) {
      if (seen.has(entry.id)) throw new Error('Cyclic native branch')
      seen.add(entry.id)
      const message = entry.type === 'message' ? entry.message as Record<string, unknown> | undefined : undefined
      if (!final && message?.role === 'assistant') { if (message.stopReason !== 'stop') throw new Error('Native answer did not finish'); final = true }
      if (entry.id === checkpoint.userEntryId) { foundUser = message?.role === 'user'; break }
      entry = byId.get(entry.parentId)
    }
    if (!final || !foundUser) throw new Error('Checkpoint has no matching user/answer branch')
    inspect?.(entries, checkpoint)
    return checkpoint
  } finally { closeSync(fd) }
}

/** Public text projection from the SAME verified prefix; no model metadata, thinking or tool payloads. */
export function checkpointConversation(file: string, candidate: unknown): NativeConversationHistory {
  let result: NativeConversationHistory | undefined
  verifyWorkerCheckpoint(file, candidate, (entries, checkpoint) => {
    const byId = new Map(entries.map(entry => [entry.id, entry])), seen = new Set<unknown>()
    const branch: Record<string, unknown>[] = []
    let entry = byId.get(checkpoint.leafEntryId)
    while (entry) {
      if (seen.has(entry.id) || typeof entry.id !== 'string' || entry.id.length > 128) throw new Error('Invalid native branch identity')
      seen.add(entry.id); branch.push(entry)
      if (entry.parentId === null) break
      entry = byId.get(entry.parentId)
      if (!entry) throw new Error('Incomplete native branch')
    }
    let remaining = 262144, hasEarlier = false
    const messages: NativeConversationMessage[] = []
    for (const entry of branch) {
      const message = entry.type === 'message' ? entry.message as Record<string, unknown> | undefined : undefined
      if (!message || message.role !== 'user' && message.role !== 'assistant') continue
      if (messages.length >= 100 || remaining <= 0) { hasEarlier = true; break }
      const content = message.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : ''
      const limit = Math.min(65536, remaining), truncated = text.length > limit
      let selected = text.slice(0, limit)
      if (truncated && /[\uD800-\uDBFF]$/.test(selected)) selected = selected.slice(0, -1)
      remaining -= selected.length
      messages.push({ entryId: entry.id as string, role: message.role, text: selected, truncated })
    }
    result = { checkpoint, messages: messages.reverse(), hasEarlier }
  })
  return result!
}
