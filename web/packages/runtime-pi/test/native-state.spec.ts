import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { flushInitialNativeSession } from '../src/worker/native-state.js'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-bootstrap-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), sessions = join(root, 'sessions'); mkdirSync(cwd)
  return { root, cwd, manager: SessionManager.create(cwd, sessions) }
}

it('persists original pre-prompt native metadata without a synthetic message and lets the first assistant append once', () => {
  const f = fixture(), manager = f.manager, file = manager.getSessionFile()!
  manager.appendModelChange('faux', 'model:two'); manager.appendThinkingLevelChange('high')
  manager.appendCustomEntry('docatlas.test-native-control.v1', { operationId: 'operation:one' })
  const before = structuredClone(manager.getEntries()), id = manager.getSessionId()
  expect(existsSync(file)).toBe(false)
  expect(flushInitialNativeSession(manager)).toEqual({ created: true })
  expect(manager.getEntries()).toEqual(before); expect(manager.getSessionId()).toBe(id)
  expect(manager.buildSessionContext().messages).toEqual([])
  const original = readFileSync(file)
  expect(flushInitialNativeSession(manager)).toEqual({ created: false }); expect(readFileSync(file)).toEqual(original)
  manager.appendMessage({ role: 'user', content: 'The first real question.', timestamp: Date.now() })
  manager.appendMessage({ ...fauxAssistantMessage('The first real answer.'), model: 'model:two' })
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
  expect(lines.filter(line => line.type === 'session')).toHaveLength(1)
  expect(readFileSync(file).subarray(0, original.length)).toEqual(original)
  const reopened = SessionManager.open(file)
  expect(reopened.getSessionId()).toBe(id); expect(reopened.getEntries()).toEqual(manager.getEntries())
  expect(reopened.buildSessionContext()).toMatchObject({ model: { provider: 'faux', modelId: 'model:two' }, thinkingLevel: 'high', messages: [{ role: 'user' }, { role: 'assistant' }] })
})

it('keeps the complete native tree and original selected leaf instead of exporting only its current branch', () => {
  const { manager } = fixture()
  const first = manager.appendModelChange('faux', 'model:one'); manager.appendThinkingLevelChange('high'); manager.branch(first)
  const entries = structuredClone(manager.getEntries())
  flushInitialNativeSession(manager)
  expect(manager.getEntries()).toEqual(entries); expect(manager.getLeafId()).toBe(first)
  const next = manager.appendCustomEntry('docatlas.test-native-control.v1', { phase: 'intent' })
  expect(manager.getEntry(next)?.parentId).toBe(first)
  expect(SessionManager.open(manager.getSessionFile()!).getEntries()).toEqual(manager.getEntries())
})

it('does not rewrite an existing file or follow an unexpected native target symlink', () => {
  const f = fixture(), file = f.manager.getSessionFile()!, other = join(f.root, 'other.jsonl')
  f.manager.appendModelChange('faux', 'model:one')
  writeFileSync(file, 'EXISTING_UNVERIFIED_BYTES')
  expect(() => flushInitialNativeSession(f.manager)).toThrow(); expect(readFileSync(file, 'utf8')).toBe('EXISTING_UNVERIFIED_BYTES')
  const g = fixture(), target = g.manager.getSessionFile()!; writeFileSync(other, 'UNRELATED_BYTES'); symlinkSync(other, target)
  expect(() => flushInitialNativeSession(g.manager)).toThrow(); expect(readFileSync(other, 'utf8')).toBe('UNRELATED_BYTES')
  expect(() => flushInitialNativeSession(SessionManager.inMemory(f.cwd))).toThrow('bootstrap identity')
})
