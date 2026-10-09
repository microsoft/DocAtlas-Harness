import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import type { NativeControlAction, NativeControlApply, NativeControlOutcome, NativeThinkingLevel } from '@docatlas/contracts'
import { createPiRuntime } from '../src/create-runtime.js'
import { findNativeControlOutcome, NATIVE_CONTROL_MARKER, NativeControls, verifyNativeControlProof, verifyNativeRuntimeState } from '../src/worker/native-controls.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function applied(outcome: NativeControlOutcome) { if (outcome.status === 'not-applied') throw new Error('Configuration cannot return compact rejection'); return outcome }

async function setup(extensions: ExtensionFactory[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-controls-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions'); mkdirSync(cwd); mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })
  const faux = fauxProvider({ models: [{ id: 'model/plain', reasoning: false }, { id: 'model/reasoning', reasoning: true }] }); modelRuntime.registerNativeProvider(faux.provider)
  const make = async (manager: SessionManager) => {
    const recorded = manager.buildSessionContext(), recordedThinking = manager.getBranch().some(entry => entry.type === 'thinking_level_change')
    const runtime = await createPiRuntime({ cwd, agentDir, sessionManager: manager, modelRuntime,
      session: { model: recorded.model ? faux.getModel(recorded.model.modelId)! : faux.getModel(), ...(recordedThinking ? { thinkingLevel: recorded.thinkingLevel as NativeThinkingLevel } : {}) },
      services: () => ({ settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'always', compaction: { enabled: false } }), resourceLoaderOptions: { extensionFactories: extensions } }) })
    cleanup.push(() => runtime.dispose())
    const controls = new NativeControls(runtime.session, faux.models, () => false); controls.initialize()
    return { runtime, controls }
  }
  const first = await make(SessionManager.create(cwd, sessionDir)); let sequence = 0
  const input = (action: NativeControlAction): NativeControlApply => ({ operationId: `operation:${++sequence}`, requestHash: hash(`full product envelope ${sequence}`), expectedHead: first.controls.inspect().head, action })
  return { root, cwd, agentDir, sessionDir, faux, make, ...first, input, file: first.runtime.session.sessionFile! }
}

it('configures model, reasoning and both queue modes before the first prompt, then restores the same SDK-native state', async () => {
  const f = await setup(), original = f.controls.inspect()
  expect(original.configuration).toMatchObject({ model: { id: 'model/plain' }, thinkingLevel: 'off' })
  expect(f.runtime.session.messages).toEqual([])
  const modelInput = f.input({ kind: 'set-model', provider: f.faux.models[0].provider, modelId: 'model/reasoning' })
  const switched = await f.controls.apply(modelInput, new AbortController().signal)
  const thinkingInput = f.input({ kind: 'set-thinking', level: 'high' }); await f.controls.apply(thinkingInput, new AbortController().signal)
  await f.controls.apply(f.input({ kind: 'set-queue-mode', queue: 'steering', mode: 'all' }), new AbortController().signal)
  await f.controls.apply(f.input({ kind: 'set-queue-mode', queue: 'follow-up', mode: 'all' }), new AbortController().signal)
  const state = f.controls.inspect(), before = readFileSync(f.file)
  expect(state.configuration).toMatchObject({ model: { id: 'model/reasoning' }, thinkingLevel: 'high', steeringMode: 'all', followUpMode: 'all' })
  expect(verifyNativeRuntimeState(f.file, state, f.faux.models)).toEqual(state)
  expect(f.faux.state.callCount).toBe(0); expect(f.runtime.session.messages).toEqual([])
  await f.runtime.dispose()
  const reopened = await f.make(SessionManager.open(f.file, f.sessionDir))
  expect(reopened.controls.inspect().configuration).toEqual(state.configuration)
  expect(reopened.runtime.session.sessionId).toBe(original.head.sessionId)
  expect(readFileSync(f.file).subarray(0, before.length)).toEqual(before)
  expect(findNativeControlOutcome(f.file, modelInput, f.faux.models)).toEqual({ ...switched, status: 'replayed' })
  f.faux.setResponses([fauxAssistantMessage('first actual response')]); await reopened.runtime.session.prompt('first actual question')
  const rows = readFileSync(f.file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
  expect(rows.filter(row => row.type === 'session')).toHaveLength(1)
  expect(reopened.runtime.session.messages.map(message => message.role)).toEqual(['user', 'assistant'])
})

it('proves an exact no-op through intent/commit markers and returns the original receipt after later different settings', async () => {
  const f = await setup(), input = f.input({ kind: 'set-thinking', level: 'off' }), result = applied(await f.controls.apply(input, new AbortController().signal))
  expect(result.proof.afterHead.entryCount - result.proof.beforeHead.entryCount).toBe(2)
  expect(result.proof.configuration.thinkingLevel).toBe('off')
  await f.controls.apply(f.input({ kind: 'set-model', provider: f.faux.models[0].provider, modelId: 'model/reasoning' }), new AbortController().signal)
  await f.controls.apply(f.input({ kind: 'set-thinking', level: 'high' }), new AbortController().signal)
  const before = readFileSync(f.file)
  expect(await f.controls.apply(input, new AbortController().signal)).toEqual({ ...result, status: 'replayed' })
  expect(findNativeControlOutcome(f.file, input, f.faux.models)).toEqual({ ...result, status: 'replayed' })
  expect(readFileSync(f.file)).toEqual(before); expect(f.controls.inspect().configuration.thinkingLevel).toBe('high')
  await expect(f.controls.apply({ ...input, requestHash: hash('another full body') }, new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
  await expect(f.controls.apply({ ...input, action: { kind: 'set-thinking', level: 'high' } }, new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
})

it('uses native capability clamping and rejects stale heads, unavailable models and malformed controls before any intent', async () => {
  const f = await setup(), high = f.input({ kind: 'set-thinking', level: 'xhigh' })
  expect(applied(await f.controls.apply(high, new AbortController().signal)).proof.configuration.thinkingLevel).toBe('off')
  const unknown = f.input({ kind: 'set-model', provider: 'provider:unavailable', modelId: 'model/secret' }), before = readFileSync(f.file)
  await expect(f.controls.apply(unknown, new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
  await expect(f.controls.apply({ ...high, operationId: 'operation:stale' }, new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
  await expect(f.controls.apply({ ...unknown, requestHash: 'not-a-hash' }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid' })
  expect(readFileSync(f.file)).toEqual(before)
  expect(findNativeControlOutcome(f.file, unknown, f.faux.models)).toBeUndefined()
})

it('never infers execution from current configuration when only an intent survived, and preserves the pending marker through restart', async () => {
  const f = await setup(), input = f.input({ kind: 'set-thinking', level: 'high' })
  f.runtime.session.sessionManager.appendCustomEntry(NATIVE_CONTROL_MARKER, { version: 1, phase: 'intent', input })
  f.runtime.session.setThinkingLevel('high')
  const before = readFileSync(f.file)
  await expect(f.controls.apply(input, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' })
  expect(() => findNativeControlOutcome(f.file, input, f.faux.models)).toThrowError(expect.objectContaining({ code: 'failed' }))
  expect(readFileSync(f.file)).toEqual(before)
  await f.runtime.dispose(); const reopened = await f.make(SessionManager.open(f.file, f.sessionDir))
  await expect(reopened.controls.apply(input, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' })
})

it('holds the native control mutex and stop until an actual asynchronous model-select hook joins, without committing after cancellation', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await setup([pi => { pi.on('model_select', async () => { started.resolve(); await release.promise }) }])
  const input = f.input({ kind: 'set-model', provider: f.faux.models[0].provider, modelId: 'model/reasoning' })
  const work = f.controls.apply(input, new AbortController().signal), rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' })
  await started.promise
  expect(f.controls.inspect().busy).toBe(true)
  await expect(f.controls.exclusive(async () => {})).rejects.toMatchObject({ code: 'denied' })
  let stopped = false; const stop = f.controls.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  release.resolve(); await rejected; await stop
  expect(f.controls.busy).toBe(false)
  expect(f.controls.inspect()).toMatchObject({ busy: false, configuration: { model: { id: 'model/reasoning' } } })
  expect(() => findNativeControlOutcome(f.file, input, f.faux.models)).toThrowError(expect.objectContaining({ code: 'failed' }))
  f.controls.resume()
  await expect(f.controls.apply(input, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' })
})

it('independently rejects fabricated result configuration, hash/prefix or marker identity without trusting the worker response', async () => {
  const f = await setup(), input = f.input({ kind: 'set-queue-mode', queue: 'steering', mode: 'all' }), result = applied(await f.controls.apply(input, new AbortController().signal))
  for (const mutate of [
    (value: typeof result) => { value.proof.configuration.steeringMode = 'one-at-a-time' },
    (value: typeof result) => { value.proof.afterHead.transcriptHash = '0'.repeat(64) },
    (value: typeof result) => { value.proof.intentEntryId = value.proof.markerEntryId },
    (value: typeof result) => { value.proof.beforeHead.entryCount++ },
  ]) {
    const changed = structuredClone(result); mutate(changed)
    expect(() => verifyNativeControlProof(f.file, input, changed, f.faux.models)).toThrow()
  }
  const state = f.controls.inspect(); state.configuration.model.id = 'model/unavailable'
  expect(() => verifyNativeRuntimeState(f.file, state, f.faux.models)).toThrow()
})
