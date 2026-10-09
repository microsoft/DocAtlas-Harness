import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { createPiRuntime } from '../src/create-runtime.js'
import { flushInitialNativeSession } from '../src/worker/native-state.js'
import { captureNativeSelectedHead, inspectNativeFile, restoreNativeSelectedSession, verifyNativeFileSeal, verifyNativeSelectedHead } from '../src/worker/native-selection.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-selection-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), sessionDir = join(root, 'sessions'), agentDir = join(root, 'agent'); mkdirSync(cwd); mkdirSync(agentDir)
  const manager = SessionManager.create(cwd, sessionDir)
  return { root, cwd, sessionDir, agentDir, manager, file: manager.getSessionFile()! }
}

it('seals the entire original tree independently of explicit selected/null heads with deterministic canonical context hashes', () => {
  const f = fixture(), first = f.manager.appendModelChange('faux', 'chosen-model')
  f.manager.appendThinkingLevelChange('high'); flushInitialNativeSession(f.manager)
  const full = captureNativeSelectedHead(f.manager, true), bytes = readFileSync(f.file)
  expect(full.selectedLeafEntryId).toBe(full.fileSeal.tailEntryId)
  f.manager.branch(first)
  const selected = captureNativeSelectedHead(f.manager, true)
  expect(selected.fileSeal).toEqual(full.fileSeal); expect(selected.selectedLeafEntryId).not.toBe(selected.fileSeal.tailEntryId)
  expect(selected.contextHash).not.toBe(full.contextHash)
  expect(selected.contextHash).toBe(hash('{"messages":[],"model":{"modelId":"chosen-model","provider":"faux"},"thinkingLevel":"off"}'))
  expect(verifyNativeSelectedHead(f.file, f.cwd, selected, { exactFile: true })).toEqual(selected)
  const restored = restoreNativeSelectedSession(f.file, f.sessionDir, f.cwd, selected)
  expect(restored.getLeafId()).toBe(first); expect(restored.getEntries()).toEqual(f.manager.getEntries())
  restored.resetLeaf(); const root = captureNativeSelectedHead(restored)
  expect(root.selectedLeafEntryId).toBeNull(); expect(root.fileSeal).toEqual(full.fileSeal)
  expect(root.contextHash).toBe(hash('{"messages":[],"model":null,"thinkingLevel":"off"}'))
  expect(restoreNativeSelectedSession(f.file, f.sessionDir, f.cwd, root).getLeafId()).toBeNull()
  expect(readFileSync(f.file).equals(bytes)).toBe(true)
})

it('restores the selected native branch before SDK services/factories rather than replaying or reconstructing its messages', async () => {
  const f = fixture(), modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })
  const faux = fauxProvider({ tokenSize: { min: 8192, max: 8192 } }); modelRuntime.registerNativeProvider(faux.provider)
  const make = async (manager: SessionManager, observed: Array<string | null>) => {
    const runtime = await createPiRuntime({ cwd: f.cwd, agentDir: f.agentDir, modelRuntime, sessionManager: manager, session: { model: faux.getModel() }, services: () => {
      observed.push(manager.getLeafId()); return { settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'never', compaction: { enabled: false } }) }
    } }); cleanup.push(() => runtime.dispose()); return runtime
  }
  const runtime = await make(f.manager, []); faux.setResponses([fauxAssistantMessage('selected first answer'), fauxAssistantMessage('unselected second answer')])
  await runtime.session.prompt('selected first original question'); const first = f.manager.getLeafId()!
  await runtime.session.prompt('unselected second original question'); const second = f.manager.getLeafId()!
  await runtime.session.navigateTree(first)
  const witness = f.manager.appendCustomEntry('docatlas.selected-spike.v1', { selectedLeafEntryId: first }); f.manager.branch(first)
  const head = captureNativeSelectedHead(f.manager, true), fullEntries = f.manager.getEntries(), bytes = readFileSync(f.file)
  expect(head.fileSeal.tailEntryId).toBe(witness); expect(head.selectedLeafEntryId).toBe(first)
  await runtime.dispose()
  const restored = restoreNativeSelectedSession(f.file, f.sessionDir, f.cwd, head), seen: Array<string | null> = []
  const resumed = await make(restored, seen)
  expect(seen).toEqual([first]); expect(resumed.session.sessionManager.getEntries()).toEqual(fullEntries)
  expect(resumed.session.sessionManager.getEntry(second)).toBeDefined()
  expect(JSON.stringify(resumed.session.messages)).toContain('selected first answer'); expect(JSON.stringify(resumed.session.messages)).not.toContain('unselected second answer')
  expect(faux.state.callCount).toBe(2); expect(readFileSync(f.file).equals(bytes)).toBe(true)
})

it('verifies historical file prefixes while refusing cold restore after any unsealed append', () => {
  const f = fixture(); f.manager.appendModelChange('faux', 'model'); flushInitialNativeSession(f.manager)
  const head = captureNativeSelectedHead(f.manager, true)
  f.manager.appendCustomEntry('docatlas.extra-native-metadata.v1', { later: true })
  expect(verifyNativeSelectedHead(f.file, f.cwd, head)).toEqual(head)
  expect(verifyNativeFileSeal(f.file, f.cwd, head.fileSeal).seal).toEqual(head.fileSeal)
  expect(() => verifyNativeSelectedHead(f.file, f.cwd, head, { exactFile: true })).toThrow()
  expect(() => restoreNativeSelectedSession(f.file, f.sessionDir, f.cwd, head)).toThrow()
})

it('rejects forged selections, context hashes, file seals and non-exact wire fields', () => {
  const f = fixture(); f.manager.appendModelChange('faux', 'model'); f.manager.appendThinkingLevelChange('high'); flushInitialNativeSession(f.manager)
  const head = captureNativeSelectedHead(f.manager)
  for (const mutate of [
    (value: typeof head) => { value.selectedLeafEntryId = 'entry:absent' },
    (value: typeof head) => { value.selectedLeafEntryId = null },
    (value: typeof head) => { value.contextHash = '0'.repeat(64) },
    (value: typeof head) => { value.fileSeal.tailEntryId = value.fileSeal.sessionId },
    (value: typeof head) => { value.fileSeal.transcriptHash = '0'.repeat(64) },
    (value: typeof head) => { value.fileSeal.entryCount-- },
  ]) { const changed = structuredClone(head); mutate(changed); expect(() => verifyNativeSelectedHead(f.file, f.cwd, changed)).toThrow() }
  expect(() => verifyNativeSelectedHead(f.file, f.cwd, { ...head, guessedLatest: true } as typeof head)).toThrow()
  expect(() => verifyNativeSelectedHead(f.file, join(f.root, 'foreign-cwd'), head)).toThrow()
})

it('never repairs malformed UTF-8, incomplete/duplicate rows, unsafe paths, or swapped bytes', () => {
  const f = fixture(); f.manager.appendModelChange('faux', 'model'); flushInitialNativeSession(f.manager)
  const head = captureNativeSelectedHead(f.manager), bytes = readFileSync(f.file), alias = join(f.root, 'alias.jsonl')
  symlinkSync(f.file, alias); expect(() => verifyNativeSelectedHead(alias, f.cwd, head)).toThrow()
  const variants = [Buffer.from([0xff, 10]), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('\n')]),
    Buffer.from(bytes.toString('utf8') + bytes.toString('utf8').trim().split('\n').at(-1)! + '\n'), Buffer.from(bytes.toString('utf8').replace('"model"', '"other"'))]
  for (const invalid of variants) {
    writeFileSync(f.file, invalid)
    expect(() => verifyNativeSelectedHead(f.file, f.cwd, head, { exactFile: true })).toThrow()
    expect(readFileSync(f.file).equals(invalid)).toBe(true)
  }
  writeFileSync(f.file, bytes)
  expect(inspectNativeFile(f.file, f.manager.getSessionId(), f.cwd).seal).toEqual(head.fileSeal)
})
