import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductPiCheckpoint } from '@docatlas/contracts'
import { ConversationHistory } from '../src/runs/history.js'
import { ControlStore, ControlStoreError } from '../src/storage/control-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!() })
const actor = { actorId: 'actor:history', workspaceId: 'workspace:history' }, conversationId = 'conversation:history'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function fixture(completed = true, preparedText?: string) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-history-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let now = Date.parse('2026-09-10T00:00:00.000Z')
  const store = ControlStore.open(join(root, 'control'), () => now); cleanup.push(() => store.close())
  const binding = store.createConversation(actor, { conversationId, runtimeSessionId: '00000000-0000-4000-8000-000000000000' })
  const file = join(root, 'native.jsonl'), entries: Record<string, unknown>[] = []
  const lease = store.acquireWriter(actor, conversationId, 'worker:history')
  let sequence = 0
  const addTurn = () => {
    const index = sequence++, previous = entries.at(-1)?.id ?? null
    entries.push({ type: 'message', id: `user:${index}`, parentId: previous, message: { role: 'user', content: `Question ${index}` } },
      { type: 'message', id: `answer:${index}`, parentId: `user:${index}`, message: { role: 'assistant', stopReason: 'stop', provider: 'PRIVATE PROVIDER',
        content: [{ type: 'thinking', thinking: 'PRIVATE THINKING' }, { type: 'text', text: `Answer ${index}` }] } })
    return index
  }
  const commit = (originalText = `Question ${sequence - 1}`) => {
    const index = sequence - 1, bytes = Buffer.from([{ type: 'session', version: 3, id: binding.runtimeSessionId, cwd: root }, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    writeFileSync(file, bytes)
    const accepted = store.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: 1, idempotencyKey: `question:history:${index}`, mode: 'prompt',
      text: originalText, sourceRefs: [], selectionContextIds: [] }).receipt
    const preparing = store.transition(lease, accepted.submissionId, accepted.version, 'preparing')
    const ready = store.transition(lease, accepted.submissionId, preparing.version, 'ready', { prepared: { schemaVersion: 1, kind: 'prepared', submissionId: accepted.submissionId,
      requestHash: accepted.requestHash, bindingGeneration: 1, scopeVersionId: null, sourceRefs: [], selectionContextIds: [] } })
    const dispatching = store.transition(lease, accepted.submissionId, ready.version, 'dispatching'), running = store.transition(lease, accepted.submissionId, dispatching.version, 'running')
    const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: accepted.submissionId, requestHash: accepted.requestHash, runtimeSessionId: binding.runtimeSessionId,
      userEntryId: `user:${index}`, leafEntryId: `answer:${index}`, transcriptHash: hash(bytes), byteLength: bytes.length, entryCount: entries.length, settledAt: new Date(now).toISOString() }
    store.transition(lease, accepted.submissionId, running.version, 'completed', { checkpoint })
    return checkpoint
  }
  if (completed) {
    for (let index = 0; index < 28; index++) addTurn()
    if (preparedText !== undefined) (entries.at(-2)!.message as Record<string, unknown>).content = preparedText
    commit()
  }
  const checkpointFile = vi.fn(async () => file), history = new ConversationHistory(store, actor, conversationId, checkpointFile, () => now)
  cleanup.push(() => history.dispose())
  return { root, store, binding, file, entries, lease, addTurn, commit, checkpointFile, history, advance: (milliseconds: number) => { now += milliseconds } }
}

describe('read-only host native history pages and opaque cursor authority', () => {
  it('returns pre-first empty history without obtaining a file or creating execution', async () => {
    const f = fixture(false), accept = vi.spyOn(f.store, 'accept'), transition = vi.spyOn(f.store, 'transition')
    expect(await f.history.page(actor)).toEqual({ schemaVersion: 1, kind: 'history-page', binding: f.binding, checkpoint: null, messages: [], hasEarlier: false, nextCursor: null })
    expect(f.checkpointFile).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(transition).not.toHaveBeenCalled()
    await expect(f.history.page(actor, 'history:00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'conflict' })
    expect(f.checkpointFile).not.toHaveBeenCalled()
  })

  it('paginates the exact committed native prefix without submit, replay, checkpoint writes or raw internal content', async () => {
    const f = fixture(), original = readFileSync(f.file), checkpoint = f.store.latestCheckpoint(actor, conversationId)
    const accept = vi.spyOn(f.store, 'accept'), transition = vi.spyOn(f.store, 'transition'), before = f.store.recent(actor, conversationId)
    const first = await f.history.page(actor)
    expect(first.messages).toHaveLength(50); expect(first.hasEarlier).toBe(true); expect(first.nextCursor).toMatch(/^history:[a-f0-9-]{36}$/u)
    expect(first.checkpoint).toEqual(checkpoint)
    expect(first.messages[0]!.entryId).toBe('user:3')
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|thinking|provider|native\.jsonl/u)
    const cursor = first.nextCursor!
    const second = await f.history.page(actor, cursor)
    expect(second.messages.map(item => item.entryId)).toEqual(['user:0', 'answer:0', 'user:1', 'answer:1', 'user:2', 'answer:2'])
    expect(second).toMatchObject({ hasEarlier: false, nextCursor: null })
    expect(await f.history.page(actor, cursor)).toEqual(second)
    for (const message of [...second.messages, ...first.messages]) {
      if (message.displayOrigin === 'native') expect(message.nativeTextHash).toBe(hash(message.text))
      else if (message.entryId === 'user:27') expect(message).toMatchObject({ text: 'Question 27', displayOrigin: 'submission', truncated: false })
      else expect(message).toMatchObject({ text: '', displayOrigin: 'unavailable', truncated: false })
    }
    expect(f.store.recent(actor, conversationId)).toEqual(before); expect(readFileSync(f.file)).toEqual(original)
    expect(accept).not.toHaveBeenCalled(); expect(transition).not.toHaveBeenCalled()
    first.messages[0]!.text = 'client mutation'; first.checkpoint!.leafEntryId = 'fake'
    expect((await f.history.page(actor)).messages[0]!).toMatchObject({ text: '', displayOrigin: 'unavailable' })
  })

  it('maps only the exact original submission and never exposes prepared source injections after payload purge', async () => {
    const injection = 'PRIVATE PREPARED SOURCE INJECTION\nQuestion 27', f = fixture(true, injection)
    const before = await f.history.page(actor), checkpoint = before.checkpoint!
    const user = before.messages.find(message => message.entryId === 'user:27')!
    expect(user).toEqual({ entryId: 'user:27', role: 'user', text: 'Question 27', truncated: false, displayOrigin: 'submission', nativeTextHash: hash(injection) })
    expect(JSON.stringify(before)).not.toContain('PRIVATE PREPARED')
    f.store.purgeRecoveryPayload(actor, checkpoint.submissionId)
    const after = await f.history.page(actor)
    expect(after.messages.find(message => message.entryId === 'user:27')).toEqual({ ...user, text: '', displayOrigin: 'unavailable' })
    expect(JSON.stringify(after)).not.toContain('Question 27')
    expect(JSON.stringify(after)).not.toContain('PRIVATE PREPARED')
    expect(readFileSync(f.file, 'utf8')).toContain(injection.replaceAll('\n', '\\n'))
    expect(after.checkpoint).toEqual(checkpoint)
  })

  it('reapplies page bounds after exact original-user projection without truncating or dropping a human question', async () => {
    const f = fixture(false), text = 'x'.repeat(6000)
    for (let index = 0; index < 22; index++) { f.addTurn(); f.commit(text) }
    const first = await f.history.page(actor)
    expect(first.messages.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(131072)
    expect(first.hasEarlier).toBe(true)
    expect(first.messages.map(message => message.entryId)).toEqual(['answer:0', ...Array.from({ length: 21 }, (_, index) => [`user:${index + 1}`, `answer:${index + 1}`]).flat()])
    const second = await f.history.page(actor, first.nextCursor!)
    expect(second).toMatchObject({ hasEarlier: false, nextCursor: null, messages: [{ entryId: 'user:0', text, truncated: false, displayOrigin: 'submission' }] })
    expect([...second.messages, ...first.messages].filter(message => message.role === 'user').every(message => message.text === text && !message.truncated)).toBe(true)
  })

  it('fences cross-actor/workspace cursors, unknown and expired opaque tokens before private file access', async () => {
    const f = fixture(), first = await f.history.page(actor), calls = f.checkpointFile.mock.calls.length
    for (const denied of [{ ...actor, actorId: 'actor:other' }, { ...actor, workspaceId: 'workspace:other' }]) {
      await expect(f.history.page(denied, first.nextCursor!)).rejects.toMatchObject({ code: 'not-found' })
    }
    await expect(f.history.page(actor, '../native.jsonl')).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(f.history.page(actor, 'history:00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'conflict' })
    f.advance(300000)
    await expect(f.history.page(actor, first.nextCursor!)).rejects.toMatchObject({ code: 'conflict' })
    expect(f.checkpointFile).toHaveBeenCalledTimes(calls)
    expect((await f.history.page(actor)).messages).toHaveLength(50)
  })

  it('rejects a cursor owned by another host conversation view and any changed binding', async () => {
    const f = fixture(), first = await f.history.page(actor)
    f.store.createConversation(actor, { conversationId: 'conversation:other', runtimeSessionId: 'session:other' })
    const other = new ConversationHistory(f.store, actor, 'conversation:other', f.checkpointFile)
    cleanup.push(() => other.dispose())
    await expect(other.page(actor, first.nextCursor!)).rejects.toMatchObject({ code: 'conflict' })
    f.store.releaseWriter(f.lease)
    f.store.rebind(actor, conversationId, f.binding.version, 'session:replacement', null)
    await expect(f.history.page(actor, first.nextCursor!)).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.history.page(actor)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('allows a verified prefix behind an uncommitted tail but rejects old cursors when a new head commits', async () => {
    const f = fixture(), first = await f.history.page(actor), calls = f.checkpointFile.mock.calls.length
    appendFileSync(f.file, `${JSON.stringify({ type: 'message', id: 'uncommitted', parentId: 'answer:27', message: { role: 'user', content: 'PRIVATE UNCOMMITTED QUESTION' } })}\n`)
    expect((await f.history.page(actor, first.nextCursor!)).messages).toHaveLength(6)
    f.addTurn(); const newHead = f.commit()
    await expect(f.history.page(actor, first.nextCursor!)).rejects.toMatchObject({ code: 'conflict' })
    expect(f.checkpointFile).toHaveBeenCalledTimes(calls + 1)
    const fresh = await f.history.page(actor)
    expect(fresh.checkpoint).toEqual(newHead); expect(fresh.messages.at(-1)!.entryId).toBe('answer:28')
  })

  it.each(['head', 'permission', 'expiry', 'dispose'] as const)('rechecks %s after the asynchronous private file capability before returning any text', async change => {
    const f = fixture(), first = await f.history.page(actor), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.checkpointFile.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.file })
    const pending = f.history.page(actor, first.nextCursor!), rejected = expect(pending).rejects.toBeDefined()
    await entered.promise
    if (change === 'head') { f.addTurn(); f.commit() }
    if (change === 'permission') vi.spyOn(f.store, 'binding').mockImplementation(() => { throw new ControlStoreError('not-found', 'revoked') })
    if (change === 'expiry') f.advance(300000)
    if (change === 'dispose') f.history.dispose()
    release.resolve(); await rejected
  })

  it('bounds concurrent reads and cursor memory without acquiring execution authority', async () => {
    const f = fixture(), release = Promise.withResolvers<void>()
    f.checkpointFile.mockImplementation(async () => { await release.promise; return f.file })
    const requests = Array.from({ length: 4 }, () => f.history.page(actor))
    await expect(f.history.page(actor)).rejects.toMatchObject({ code: 'limit-exceeded' })
    release.resolve(); await Promise.all(requests)
    f.checkpointFile.mockImplementation(async () => f.file)
    const first = await f.history.page(actor)
    for (let index = 0; index < 128; index++) await f.history.page(actor)
    expect(Reflect.get(f.history, 'cursors').size).toBe(128)
    await expect(f.history.page(actor, first.nextCursor!)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('fails closed on changed native bytes and hides private path errors without altering the transcript', async () => {
    const f = fixture(), first = await f.history.page(actor)
    const changed = readFileSync(f.file, 'utf8').replace('Question 0', 'TAMPERED 0')
    writeFileSync(f.file, changed)
    await expect(f.history.page(actor, first.nextCursor!)).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' })
    expect(readFileSync(f.file, 'utf8')).toBe(changed)
    f.checkpointFile.mockRejectedValueOnce(new Error(`PRIVATE filesystem failure at ${f.file}`))
    await expect(f.history.page(actor)).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' })
  })
})
