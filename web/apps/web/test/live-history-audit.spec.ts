import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, NativeConversationMessage, ProductHistoryMessage, ProductPiCheckpoint } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { mergeHistory } from '../src/live/history-state'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.restoreAllMocks() })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

it('merges visible pages across legacy empty tool-call assistant entries without deleting unavailable human entries', () => {
  const snapshot: NativeConversationMessage[] = [
    { entryId: 'user:original', role: 'user', text: 'Original human question', truncated: false },
    { entryId: 'assistant:tool-call', role: 'assistant', text: '', truncated: false },
    { entryId: 'user:unavailable', role: 'user', text: '', truncated: false },
    { entryId: 'assistant:answer', role: 'assistant', text: 'The actual native answer', truncated: false },
  ]
  const page: ProductHistoryMessage[] = [
    { ...snapshot[0]!, displayOrigin: 'submission', nativeTextHash: hash('Prepared text containing a source injection') },
    { ...snapshot[2]!, displayOrigin: 'unavailable', nativeTextHash: hash('Prepared unknown human input is not display authority') },
    { ...snapshot[3]!, displayOrigin: 'native', nativeTextHash: hash(snapshot[3]!.text) },
  ]
  expect(mergeHistory(snapshot, page, false)).toEqual(page)
  expect(() => mergeHistory(snapshot, [...page].reverse(), false)).toThrow('order')
  expect(() => mergeHistory(snapshot, [page[0]!, page[2]!], false)).toThrow('order')
})

it('does not let an older Answer authorization error expire a newly paired owner during conversation-list loading', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: ConversationSnapshot[] }
  const snapshot = structuredClone(fixtures.valid.find(value => value.kind === 'conversation-snapshot')!)
  const controls = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product/control.json', import.meta.url), 'utf8')) as { valid: ProductPiCheckpoint[] }
  const checkpoint = controls.valid.find(value => value.kind === 'pi-checkpoint')!
  snapshot.history = { checkpoint: { ...checkpoint, runtimeSessionId: snapshot.binding.runtimeSessionId, leafEntryId: 'answer:client-audit' },
    messages: [{ entryId: 'answer:client-audit', role: 'assistant', text: 'Complete saved native answer.', truncated: false }], hasEarlier: false }
  snapshot.runs = []; snapshot.live = []; snapshot.activity = []; snapshot.cursor.sequence = 0
  const binding = snapshot.binding, message = snapshot.history.messages.find(message => message.role === 'assistant' && !message.truncated)!
  let actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }
  const stored = new Map<string, string>(), answer = Promise.withResolvers<Response>(), listing = Promise.withResolvers<Response>()
  let listLoading = false
  const client = new LiveClient({ storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value) }, removeItem: key => { stored.delete(key) }, key: index => [...stored.keys()][index] ?? null, get length() { return stored.size } },
    events: () => ({ addEventListener() {}, close() {}, onerror: null, onopen: null }) satisfies EventStream,
    fetch: (async input => {
      const path = String(input)
      if (path === '/api/bootstrap' || path === '/api/auth/exchange') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
      if (path === '/api/conversations') return listLoading ? listing.promise : json({ schemaVersion: 1, kind: 'conversation-list', items: [binding], nextCursor: null })
      if (path.endsWith('/snapshot')) return json(snapshot)
      if (path.includes('/answers/')) return answer.promise
      throw new Error('Unexpected audit route')
    }) as typeof fetch })
  cleanup.push(() => client.dispose()); await client.start()
  const work = client.answerRequest(binding.conversationId, message.entryId), rejected = expect(work).rejects.toThrow()
  actor = { ...actor, actorId: 'actor:newly-paired' }; listLoading = true
  const pairing = client.pair('a'.repeat(43))
  await vi.waitFor(() => expect(client.state().actor).toEqual(actor))
  answer.resolve(json({ schemaVersion: 1, kind: 'api-error', code: 'unauthenticated' }, 401)); await rejected
  const current = client.state()
  listing.resolve(json({ schemaVersion: 1, kind: 'conversation-list', items: [], nextCursor: null })); await pairing
  expect(current.actor).toEqual(actor); expect(current.phase).toBe('ready')
})
