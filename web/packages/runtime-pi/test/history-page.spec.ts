import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProductPiCheckpoint } from '@docatlas/contracts'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { checkpointHistoryPage } from '../src/worker/history-page.js'
import { checkpointConversation } from '../src/worker/checkpoint.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sessionId = '00000000-0000-4000-8000-000000000000', timestamp = '2026-09-10T00:00:00.000Z'
function fixture(turns = 2) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-history-page-')); directories.push(root)
  const file = join(root, 'native.jsonl'), entries: Array<Record<string, unknown>> = []
  const message = (id: string, parentId: string | null, role: string, content: unknown, stopReason = 'stop') => ({ type: 'message', id, parentId, timestamp,
    message: { role, content, stopReason, provider: 'private-provider', system: 'private-system', usage: { tokens: 900 } } })
  let parent: string | null = null
  for (let turn = 0; turn < turns; turn++) {
    const user = `user:${turn}`, answer = `answer:${turn}`
    entries.push(message(user, parent, 'user', `Question ${turn}`),
      message(`thought:${turn}`, user, 'assistant', [{ type: 'thinking', thinking: 'PRIVATE THINKING' }, { type: 'toolCall', name: 'bash', id: `call:${turn}`, arguments: { secret: 'PRIVATE ARGUMENT' } }], 'toolUse'),
      message(`tool:${turn}`, `thought:${turn}`, 'toolResult', [{ type: 'text', text: 'PRIVATE TOOL RESULT' }]),
      { type: turn % 2 ? 'compaction' : 'branch_summary', id: `metadata:${turn}`, parentId: `tool:${turn}`, summary: 'PRIVATE COMPACTION SUMMARY' },
      message(answer, `metadata:${turn}`, 'assistant', [{ type: 'thinking', thinking: 'PRIVATE ANSWER THINKING' }, { type: 'text', text: `Answer ${turn}` }, { type: 'image', data: 'PRIVATE IMAGE' }]))
    parent = answer
  }
  const save = (leafEntryId = `answer:${turns - 1}`, userEntryId = `user:${turns - 1}`): ProductPiCheckpoint => {
    const bytes = Buffer.from([{ type: 'session', version: 3, id: sessionId, cwd: '/private/native', provider: 'PRIVATE HEADER' }, ...entries].map(value => JSON.stringify(value)).join('\n') + '\n')
    writeFileSync(file, bytes)
    return { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: 'submission:history', requestHash: hash('original native input'), runtimeSessionId: sessionId,
      userEntryId, leafEntryId, byteLength: bytes.length, entryCount: entries.length, transcriptHash: hash(bytes), settledAt: timestamp }
  }
  return { root, file, entries, message, save }
}

describe('verified native history paging', () => {
  it('projects genuine SDK-persisted branches with stable native identities and no model execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'docatlas-sdk-history-page-')); directories.push(root)
    const native = SessionManager.create(root, root)
    const assistant = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE SDK THINKING' }, { type: 'text', text }],
      api: 'openai-responses', provider: 'openai', model: 'unused-no-model-execution', stopReason: 'stop', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
    const rootUser = native.appendMessage({ role: 'user', content: 'Original question', timestamp: 0 }), rootAnswer = native.appendMessage(assistant('Original answer'))
    const sideUser = native.appendMessage({ role: 'user', content: 'Other branch question', timestamp: 0 })
    native.appendMessage(assistant('PRIVATE SIDE BRANCH'))
    native.branch(rootAnswer)
    const mainUser = native.appendMessage({ role: 'user', content: 'Main branch follow-up', timestamp: 0 }), mainAnswer = native.appendMessage(assistant('Main branch answer'))
    const file = native.getSessionFile()!, bytes = readFileSync(file)
    const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: 'submission:sdk-history', requestHash: hash('Main branch follow-up'),
      runtimeSessionId: native.getSessionId(), userEntryId: mainUser, leafEntryId: native.getLeafId()!, byteLength: bytes.length, entryCount: native.getEntries().length,
      transcriptHash: hash(bytes), settledAt: timestamp }
    const page = checkpointHistoryPage(file, checkpoint)
    expect(page.messages.map(item => item.entryId)).toEqual([rootUser, rootAnswer, mainUser, mainAnswer])
    expect(page.messages.map(item => item.text)).toEqual(['Original question', 'Original answer', 'Main branch follow-up', 'Main branch answer'])
    expect(() => checkpointHistoryPage(file, checkpoint, sideUser)).toThrow('not visible')
    expect(readFileSync(file)).toEqual(bytes)
    expect(native.getLeafId()).toBe(mainAnswer)
  })

  it('walks the actual parent branch over many pages without exposing native internals or changing snapshot limits', () => {
    const f = fixture(112)
    f.entries.splice(5, 0, f.message('sibling:user', 'answer:0', 'user', 'PRIVATE OTHER BRANCH'), f.message('sibling:answer', 'sibling:user', 'assistant', 'PRIVATE OTHER ANSWER'))
    const checkpoint = f.save(), bytes = readFileSync(f.file), pages = []
    let before: string | undefined
    do {
      const page = checkpointHistoryPage(f.file, checkpoint, before)
      expect(page.messages.length).toBeLessThanOrEqual(50)
      expect(page.messages.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(131072)
      expect(JSON.stringify(page)).not.toMatch(/PRIVATE|private-provider|private-system|toolCall|tokens|thinking/u)
      for (const item of page.messages) {
        expect(Object.keys(item).sort()).toEqual(['entryId', 'nativeTextHash', 'role', 'text', 'truncated'])
        expect(item.nativeTextHash).toBe(hash(item.text)); expect(item.truncated).toBe(false)
      }
      pages.unshift(page)
      before = page.hasEarlier ? page.messages[0]!.entryId : undefined
    } while (before)
    expect(pages.map(page => page.messages.length)).toEqual([24, 50, 50, 50, 50])
    expect(pages.flatMap(page => page.messages.map(item => item.entryId))).toEqual(Array.from({ length: 112 }, (_, index) => [`user:${index}`, `answer:${index}`]).flat())
    expect(readFileSync(f.file)).toEqual(bytes)
    // Existing snapshot API remains independent: its 100 entries include native empty-text rows.
    expect(checkpointConversation(f.file, checkpoint).messages).toHaveLength(100)
  })

  it('accepts only exclusive visible boundaries from the same verified branch and prefix', () => {
    const f = fixture(3), checkpoint = f.save()
    expect(checkpointHistoryPage(f.file, checkpoint, 'user:1').messages.map(item => item.entryId)).toEqual(['user:0', 'answer:0'])
    expect(checkpointHistoryPage(f.file, checkpoint, 'user:0')).toMatchObject({ messages: [], hasEarlier: false })
    appendFileSync(f.file, `${JSON.stringify(f.message('tail:user', 'answer:2', 'user', 'UNCOMMITTED TAIL'))}\n`)
    const page = checkpointHistoryPage(f.file, checkpoint)
    expect(page.messages).toHaveLength(6); expect(JSON.stringify(page)).not.toContain('UNCOMMITTED')
    for (const boundary of ['thought:1', 'tool:1', 'metadata:1', 'tail:user', 'not-present', '../private', '']) {
      expect(() => checkpointHistoryPage(f.file, checkpoint, boundary)).toThrow()
    }
    f.entries.splice(5, 0, f.message('sibling', 'answer:0', 'assistant', 'Other branch'))
    expect(() => checkpointHistoryPage(f.file, f.save(), 'sibling')).toThrow('not visible')
  })

  it('never splits a normal message merely to fill a page budget and hashes the full text of oversized messages', () => {
    const f = fixture(1), text = 'x'.repeat(60000)
    f.entries.splice(0, f.entries.length, f.message('user:0', null, 'user', text), f.message('middle', 'user:0', 'assistant', text), f.message('answer:0', 'middle', 'assistant', text))
    const checkpoint = f.save(), page = checkpointHistoryPage(f.file, checkpoint)
    expect(page.messages.map(item => item.entryId)).toEqual(['middle', 'answer:0'])
    expect(page.messages.every(item => item.text.length === 60000 && !item.truncated)).toBe(true)
    expect(page.hasEarlier).toBe(true)
    expect(checkpointHistoryPage(f.file, checkpoint, page.messages[0]!.entryId)).toMatchObject({ messages: [{ entryId: 'user:0', text, truncated: false }], hasEarlier: false })
    const full = `${'x'.repeat(65535)}😀after`
    f.entries.at(-1)!.message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: full }, { type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'second native block' }] }
    const huge = checkpointHistoryPage(f.file, f.save()).messages.at(-1)!
    expect(huge).toMatchObject({ text: 'x'.repeat(65535), truncated: true, nativeTextHash: hash(`${full}\nsecond native block`) })
    expect(huge.nativeTextHash).not.toBe(hash(huge.text))
  })

  it('requires the whole earlier branch topology even when the latest checkpoint user/answer interval is valid', () => {
    for (const damage of ['cycle', 'missing-parent', 'invalid-id', 'duplicate-id', 'unfinished-answer'] as const) {
      const f = fixture(2)
      if (damage === 'cycle') f.entries[0]!.parentId = 'answer:0'
      if (damage === 'missing-parent') f.entries[0]!.parentId = 'missing:root'
      if (damage === 'invalid-id') { f.entries[0]!.id = 'invalid/id'; f.entries[1]!.parentId = 'invalid/id' }
      if (damage === 'duplicate-id') f.entries.splice(2, 0, structuredClone(f.entries[0]!))
      if (damage === 'unfinished-answer') (f.entries.at(-1)!.message as Record<string, unknown>).stopReason = 'toolUse'
      const checkpoint = f.save()
      expect(() => checkpointHistoryPage(f.file, checkpoint)).toThrow()
    }
  })

  it('rejects altered bytes, foreign sessions and symlink paths without repairing native state', () => {
    const f = fixture(), checkpoint = f.save(), link = join(f.root, 'link.jsonl')
    symlinkSync(f.file, link)
    expect(() => checkpointHistoryPage(link, checkpoint)).toThrow()
    expect(() => checkpointHistoryPage(f.file, { ...checkpoint, runtimeSessionId: 'session:foreign' })).toThrow('identity')
    const changed = readFileSync(f.file, 'utf8').replace('Question 0', 'ALTERED Q0')
    writeFileSync(f.file, changed)
    expect(() => checkpointHistoryPage(f.file, checkpoint)).toThrow('hash mismatch')
    expect(readFileSync(f.file, 'utf8')).toBe(changed)
  })
})
