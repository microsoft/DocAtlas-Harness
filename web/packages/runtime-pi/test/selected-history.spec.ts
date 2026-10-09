import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { captureNativeSelectedHead } from '../src/worker/native-selection.js'
import { flushInitialNativeSession } from '../src/worker/native-state.js'
import { selectedConversation, selectedHistoryPage } from '../src/worker/selected-history.js'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-selected-history-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), sessions = join(root, 'sessions'); mkdirSync(cwd)
  const manager = SessionManager.create(cwd, sessions), file = manager.getSessionFile()!
  manager.appendModelChange('faux', 'faux-1'); manager.appendThinkingLevelChange('off')
  const pair = (question: string, answer: string) => {
    const user = manager.appendMessage({ role: 'user', content: question, timestamp: 0 }), assistant = manager.appendMessage(fauxAssistantMessage(answer))
    return { user, assistant }
  }
  return { root, cwd, manager, file, pair }
}

it('projects only the explicit SDK selection while retaining a full file whose tail is on another branch', () => {
  const f = fixture(), first = f.pair('original user', 'original answer'), other = f.pair('other user', 'OTHER BRANCH ANSWER')
  f.manager.branch(first.assistant); const current = f.pair('selected user PREPARED_SOURCE_SENTINEL', 'selected answer')
  f.manager.branch(other.assistant); f.pair('latest append user', 'LATEST APPEND ANSWER')
  f.manager.branch(current.assistant)
  const head = captureNativeSelectedHead(f.manager, true), bytes = readFileSync(f.file), conversation = selectedConversation(f.file, f.cwd, head), page = selectedHistoryPage(f.file, f.cwd, head)
  expect(head.selectedLeafEntryId).not.toBe(head.fileSeal.tailEntryId)
  expect(conversation.checkpoint).toBeNull(); expect(conversation.selectedHead).toEqual(head)
  expect(conversation.messages.map(message => message.entryId)).toEqual([first.user, first.assistant, current.user, current.assistant])
  expect(page.messages.map(message => message.entryId)).toEqual(conversation.messages.map(message => message.entryId))
  expect(JSON.stringify(conversation)).not.toMatch(/OTHER BRANCH|LATEST APPEND/u)
  expect(conversation.messages.find(message => message.entryId === current.user)?.text).toContain('PREPARED_SOURCE_SENTINEL') // Private projection; host must supply the original human text.
  expect(page.messages.every(message => message.nativeTextHash === hash(message.text))).toBe(true)
  expect(() => selectedHistoryPage(f.file, f.cwd, head, other.user)).toThrow('not visible')
  expect(readFileSync(f.file).equals(bytes)).toBe(true); expect(f.manager.getLeafId()).toBe(current.assistant)
})

it('walks 224 visible entries over bounded pages without counting tool/thinking/metadata or exposing foreign lineage payloads', () => {
  const f = fixture(), expected: string[] = []
  let toolOnly = ''
  for (let index = 0; index < 112; index++) {
    const user = f.manager.appendMessage({ role: 'user', content: `Question ${index}`, timestamp: index })
    toolOnly = f.manager.appendMessage(fauxAssistantMessage([{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, fauxToolCall('bash', { command: 'PRIVATE_COMMAND' })], { stopReason: 'toolUse' }))
    f.manager.appendMessage({ role: 'toolResult', toolCallId: `tool:${index}`, toolName: 'bash', content: [{ type: 'text', text: 'PRIVATE_TOOL_PAYLOAD' }], isError: false, timestamp: index })
    f.manager.appendCustomEntry('docatlas.native-lineage.v1', { phase: 'fork-target', nativeSessionId: 'parent:foreign', PRIVATE_PROVIDER: 'never history authority' })
    const answer = f.manager.appendMessage(fauxAssistantMessage([{ type: 'thinking', thinking: 'PRIVATE_ANSWER_THINKING' }, { type: 'text', text: `Answer ${index}` }]))
    expected.push(user, answer)
  }
  const head = captureNativeSelectedHead(f.manager, true), pages = []; let before: string | undefined
  do {
    const page = selectedHistoryPage(f.file, f.cwd, head, before); pages.unshift(page)
    expect(page.messages.length).toBeLessThanOrEqual(50); expect(page.messages.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(131072)
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|toolCall|thinking|fork-target/u)
    before = page.hasEarlier ? page.messages[0]!.entryId : undefined
  } while (before)
  expect(pages.map(page => page.messages.length)).toEqual([24, 50, 50, 50, 50])
  expect(pages.flatMap(page => page.messages.map(message => message.entryId))).toEqual(expected)
  const conversation = selectedConversation(f.file, f.cwd, head)
  expect(conversation.messages).toHaveLength(100); expect(conversation.hasEarlier).toBe(true); expect(conversation.checkpoint).toBeNull()
  expect(conversation.messages.map(message => message.entryId)).toEqual(expected.slice(-100))
  expect(() => selectedHistoryPage(f.file, f.cwd, head, toolOnly)).toThrow('not visible')
})

it('preserves entire normal entries for the next page and hashes full oversized native text without splitting a surrogate', () => {
  const f = fixture(), text = 'x'.repeat(60000)
  const oldest = f.manager.appendMessage({ role: 'user', content: text, timestamp: 0 })
  const middle = f.manager.appendMessage(fauxAssistantMessage(text)), newest = f.manager.appendMessage(fauxAssistantMessage(text))
  const head = captureNativeSelectedHead(f.manager), page = selectedHistoryPage(f.file, f.cwd, head)
  expect(page.messages.map(message => message.entryId)).toEqual([middle, newest]); expect(page.hasEarlier).toBe(true)
  expect(page.messages.every(message => message.text.length === 60000 && !message.truncated)).toBe(true)
  expect(selectedHistoryPage(f.file, f.cwd, head, middle)).toMatchObject({ messages: [{ entryId: oldest, text, truncated: false }], hasEarlier: false })
  const full = `${'z'.repeat(65535)}😀retained suffix`, id = f.manager.appendMessage(fauxAssistantMessage([{ type: 'text', text: full }, { type: 'text', text: 'second text block' }]))
  const oversized = selectedHistoryPage(f.file, f.cwd, captureNativeSelectedHead(f.manager)).messages.at(-1)!
  expect(oversized).toEqual({ entryId: id, role: 'assistant', text: 'z'.repeat(65535), truncated: true, nativeTextHash: hash(`${full}\nsecond text block`) })
  for (let index = 0; index < 5; index++) f.manager.appendMessage(fauxAssistantMessage(text))
  const conversation = selectedConversation(f.file, f.cwd, captureNativeSelectedHead(f.manager))
  expect(conversation.messages).toHaveLength(4); expect(conversation.hasEarlier).toBe(true)
  expect(conversation.messages.every(message => message.text.length === 60000 && !message.truncated)).toBe(true)
})

it('supports true null/root and metadata-only selections without manufacturing a successful checkpoint', () => {
  const f = fixture(); flushInitialNativeSession(f.manager)
  const metadata = captureNativeSelectedHead(f.manager)
  expect(selectedConversation(f.file, f.cwd, metadata)).toEqual({ checkpoint: null, selectedHead: metadata, messages: [], hasEarlier: false })
  expect(selectedHistoryPage(f.file, f.cwd, metadata)).toEqual({ selectedHead: metadata, messages: [], hasEarlier: false })
  f.manager.resetLeaf(); const root = captureNativeSelectedHead(f.manager)
  expect(root.contextHash).not.toBe(metadata.contextHash)
  expect(selectedConversation(f.file, f.cwd, root)).toEqual({ checkpoint: null, selectedHead: root, messages: [], hasEarlier: false })
  expect(() => selectedHistoryPage(f.file, f.cwd, root, metadata.selectedLeafEntryId!)).toThrow('not visible')
})

it('keeps an older sealed selected history stable after real later appends and rejects non-visible or unsealed anchors', () => {
  const f = fixture(), first = f.pair('first question', 'first answer'), second = f.pair('second question', 'second answer'), head = captureNativeSelectedHead(f.manager)
  const expected = selectedHistoryPage(f.file, f.cwd, head), expectedConversation = selectedConversation(f.file, f.cwd, head)
  const later = f.pair('UNSEALED_LATER_QUESTION', 'UNSEALED_LATER_ANSWER')
  expect(selectedHistoryPage(f.file, f.cwd, head)).toEqual(expected)
  expect(selectedConversation(f.file, f.cwd, head)).toEqual(expectedConversation)
  expect(selectedHistoryPage(f.file, f.cwd, head, second.user).messages.map(message => message.entryId)).toEqual([first.user, first.assistant])
  expect(selectedHistoryPage(f.file, f.cwd, head, first.user)).toMatchObject({ messages: [], hasEarlier: false })
  for (const anchor of [later.user, 'entry:absent', '', '../private']) expect(() => selectedHistoryPage(f.file, f.cwd, head, anchor)).toThrow()
})

it('rejects altered context, file bytes, session, selection and symlink paths without repairing native state', () => {
  const f = fixture(); f.pair('original question', 'original answer'); const head = captureNativeSelectedHead(f.manager), bytes = readFileSync(f.file)
  for (const mutate of [
    (value: typeof head) => { value.contextHash = '0'.repeat(64) },
    (value: typeof head) => { value.fileSeal.transcriptHash = '0'.repeat(64) },
    (value: typeof head) => { value.fileSeal.sessionId = 'foreign:session' },
    (value: typeof head) => { value.selectedLeafEntryId = 'foreign:leaf' },
  ]) { const changed = structuredClone(head); mutate(changed); expect(() => selectedHistoryPage(f.file, f.cwd, changed)).toThrow(); expect(() => selectedConversation(f.file, f.cwd, changed)).toThrow() }
  const alias = join(f.root, 'alias.jsonl'); symlinkSync(f.file, alias); expect(() => selectedHistoryPage(alias, f.cwd, head)).toThrow()
  const altered = Buffer.from(bytes.toString('utf8').replace('original question', 'altered question'))
  writeFileSync(f.file, altered); expect(() => selectedConversation(f.file, f.cwd, head)).toThrow(); expect(readFileSync(f.file).equals(altered)).toBe(true)
})
