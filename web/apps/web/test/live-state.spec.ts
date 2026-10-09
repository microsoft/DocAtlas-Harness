import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ConversationSnapshot, ConversationObservation, ProductSubmission } from '@docatlas/contracts'
import { applyObservation, canonical, parseDraft, submissionHash } from '../src/live/state'
import { parseBrowserContract } from '@docatlas/contracts/browser'

const time = '2026-09-08T00:00:00Z'
export function snapshot(): ConversationSnapshot {
  return { schemaVersion: 1, kind: 'conversation-snapshot', binding: { schemaVersion: 1, kind: 'binding', bindingId: 'binding:one', conversationId: 'conversation:one', workspaceId: 'workspace:one', ownerActorId: 'actor:one', investigationId: null, runtimeSessionId: 'session:one', branchEntryId: null, generation: 1, version: 1, createdAt: time, updatedAt: time },
    cursor: { streamId: randomUUID(), sequence: 0 }, runs: [{ text: 'question', receipt: { schemaVersion: 1, kind: 'run-receipt', submissionId: 'submission:one', runId: 'run:one', conversationId: 'conversation:one', generation: 1, mode: 'prompt', state: 'running', version: 5, requestHash: 'a'.repeat(64), createdAt: time, updatedAt: time, payloadRetained: true } }], nextRunsCursor: null,
    history: { checkpoint: null, messages: [], hasEarlier: false }, live: [], activity: [], liveIncomplete: false }
}
it('applies contiguous observations, ignores duplicates/other conversations, and resyncs gaps', () => {
  const first = snapshot()
  const event: ConversationObservation = { schemaVersion: 1, kind: 'conversation-observation', conversationId: first.binding.conversationId, generation: 1, cursor: { ...first.cursor, sequence: 1 }, update: { type: 'progress', submissionId: 'submission:one', progress: { type: 'text', messageId: 'live:one', delta: '真实文本' } } }
  const applied = applyObservation(first, event)
  expect(applied.snapshot.live[0]!.text).toBe('真实文本'); expect(first.live).toEqual([])
  expect(applyObservation(applied.snapshot, event).snapshot).toBe(applied.snapshot)
  expect(applyObservation(first, { ...event, cursor: { ...event.cursor, sequence: 2 } }).refresh).toBe(true)
  expect(applyObservation(first, { ...event, cursor: { ...event.cursor, streamId: randomUUID() } }).refresh).toBe(true)
  expect(applyObservation(first, { ...event, conversationId: 'conversation:other' }).snapshot).toBe(first)
  expect(applyObservation(first, { ...event, generation: 2 }).refresh).toBe(true)
})
it('validates tab drafts and keeps canonical request identity independent of object order', async () => {
  const request: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: 'conversation:one', expectedGeneration: 1, idempotencyKey: 'idempotency:browser:one', mode: 'prompt', text: '你好', sourceRefs: [], selectionContextIds: [] }
  expect(parseDraft(JSON.stringify({ version: 1, draft: request.text, request }), request.conversationId).request).toEqual(request)
  expect(() => parseDraft(JSON.stringify({ version: 1, draft: request.text, request }), 'conversation:other')).toThrow()
  expect(() => parseDraft('{"version":2,"draft":"text","request":null}', request.conversationId)).toThrow()
  expect(await submissionHash(request)).toBe(await submissionHash(Object.fromEntries(Object.entries(request).reverse()) as unknown as ProductSubmission))
  expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
})
it('uses strict static browser validators including semantic identity checks', () => {
  const value = snapshot()
  expect(parseBrowserContract('conversation-observation', value)).toEqual(value)
  expect(() => parseBrowserContract('conversation-observation', { ...value, cookie: 'forbidden' })).toThrow()
  expect(() => parseBrowserContract('conversation-observation', { ...value, history: { ...value.history, messages: [{ entryId: 'fake', role: 'assistant', text: 'unverified', truncated: false }] } })).toThrow()
})
