import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ProgressRelay } from '../src/worker/progress-relay.js'
import { checkpointConversation } from '../src/worker/checkpoint.js'

it('does not await slow observation sinks and bounds burst progress with resync', async () => {
  const gate = Promise.withResolvers<void>(), sent: string[] = []
  const relay = new ProgressRelay(async value => { sent.push(value.type); await gate.promise })
  for (let index = 0; index < 10000; index++) relay.push({ type: 'text', messageId: `live:${index}`, delta: 'x'.repeat(8192) })
  expect(sent).toEqual(['text'])
  relay.close()
  expect(sent).toEqual(['text', 'resync'])
  gate.resolve(); await Promise.resolve()
  relay.push({ type: 'resync' }); expect(sent).toHaveLength(2)
})
it('projects visible text from verified native bytes without thoughts, tool payloads or system data', () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-public-history-')), sessionId = randomUUID()
  const entries = [
    { type: 'session', id: sessionId, secret: 'SESSION_PRIVATE' },
    { type: 'message', id: 'user0001', parentId: null, message: { role: 'user', content: 'actual user' } },
    { type: 'message', id: 'tool0001', parentId: 'user0001', message: { role: 'toolResult', content: [{ type: 'text', text: 'PRIVATE_TOOL_BODY' }] } },
    { type: 'message', id: 'last0001', parentId: 'tool0001', message: { role: 'assistant', stopReason: 'stop', apiKey: 'PRIVATE_MODEL', content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHTS' }, { type: 'text', text: 'visible answer' }, { type: 'toolCall', arguments: { secret: 'PRIVATE_ARGUMENT' } }] } },
  ]
  const data = Buffer.from(entries.map(value => JSON.stringify(value)).join('\n') + '\n'), file = join(root, 'session.jsonl')
  writeFileSync(file, data)
  const checkpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: 'submission:history', requestHash: 'a'.repeat(64), runtimeSessionId: sessionId,
    userEntryId: 'user0001', leafEntryId: 'last0001', transcriptHash: createHash('sha256').update(data).digest('hex'), byteLength: data.length, entryCount: 3, settledAt: new Date().toISOString() }
  try {
    const projection = checkpointConversation(file, checkpoint)
    expect(projection.messages.map(value => value.text)).toEqual(['actual user', 'visible answer'])
    expect(JSON.stringify(projection)).not.toContain('PRIVATE')
    writeFileSync(file, 'corrupt')
    expect(() => checkpointConversation(file, checkpoint)).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
