import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ModelRuntime, SessionManager, SettingsManager, type AgentSessionEvent, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import type { NativeControlApply, NativeControlOutcome } from '@docatlas/contracts'
import { createPiRuntime } from '../src/create-runtime.js'
import { findNativeControlOutcome, NativeControls, verifyNativeCompactFailureProof, verifyNativeControlProof } from '../src/worker/native-controls.js'
import { NativeModelPurpose, type NativeModelRequestPurpose } from '../src/worker/model-purpose.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function applied(value: NativeControlOutcome) { if (value.status === 'not-applied') throw new Error('Expected applied compact'); return value }
function failed(value: NativeControlOutcome) { if (value.status !== 'not-applied') throw new Error('Expected proven compact rejection'); return value }

async function setup(extensions: ExtensionFactory[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-compact-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions'); mkdirSync(cwd); mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })
  const faux = fauxProvider({ tokenSize: { min: 8192, max: 8192 } }); modelRuntime.registerNativeProvider(faux.provider)
  const events: AgentSessionEvent[] = [], purposes: NativeModelRequestPurpose[] = []
  const make = async (manager: SessionManager) => {
    const runtime = await createPiRuntime({ cwd, agentDir, sessionManager: manager, modelRuntime, session: { model: faux.getModel() }, services: () => ({
      settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'always', compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 512 }, retry: { enabled: false } }),
      resourceLoaderOptions: { extensionFactories: extensions },
    }) })
    const purpose = new NativeModelPurpose(), original = runtime.session.agent.streamFunction
    runtime.session.agent.streamFunction = (model, context, options) => { purposes.push(purpose.consume(context, options?.signal)); return original(model, context, options) }
    purpose.bind(runtime.session)
    const detach = runtime.session.subscribe(event => events.push(event))
    cleanup.push(async () => { detach(); purpose.invalidate(); await runtime.dispose() })
    const controls = new NativeControls(runtime.session, faux.models, () => false); controls.initialize()
    return { runtime, controls }
  }
  const first = await make(SessionManager.create(cwd, sessionDir)); let sequence = 0
  const input = (instructions = ''): NativeControlApply => ({ operationId: `compact:${++sequence}`, requestHash: hash(`compact envelope ${sequence} ${instructions}`), expectedHead: first.controls.inspect().head, action: { kind: 'compact', instructions } })
  const seed = async () => {
    faux.setResponses([fauxAssistantMessage(`first factual answer ${'A'.repeat(700)}`), fauxAssistantMessage(`second factual answer ${'B'.repeat(700)}`)])
    await first.runtime.session.prompt(`first actual question ${'Q'.repeat(700)}`)
    await first.runtime.session.prompt(`second actual question ${'R'.repeat(700)}`)
  }
  return { ...first, input, seed, make, faux, events, purposes, sessionDir, file: first.runtime.session.sessionFile! }
}

it('performs real manual compact, proves the exact native entry, uses only auxiliary summaries, and restores/replays the original proof', async () => {
  const f = await setup(); expect(f.controls.inspect().compaction).toEqual({ canCompact: false }); await f.seed()
  expect(f.controls.inspect().compaction).toEqual({ canCompact: true })
  const input = f.input('保留文档版本与未解决问题'), before = readFileSync(f.file), calls = f.faux.state.callCount
  f.faux.setResponses([fauxAssistantMessage('native history summary'), fauxAssistantMessage('native turn prefix summary')])
  const outcome = applied(await f.controls.apply(input, new AbortController().signal)), proof = outcome.proof.compaction!
  expect(f.faux.state.callCount).toBeGreaterThan(calls)
  expect(f.purposes.slice(calls)).toEqual(Array.from({ length: f.faux.state.callCount - calls }, () => 'auxiliary'))
  expect(f.events.filter(event => event.type === 'compaction_start')).toEqual([{ type: 'compaction_start', reason: 'manual' }])
  const entry = f.runtime.session.sessionManager.getEntries().find(entry => entry.id === proof.entryId)
  expect(entry?.type).toBe('compaction')
  if (entry?.type !== 'compaction') throw new Error('Missing actual compact entry')
  expect(proof).toEqual({ entryId: entry.id, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore, summaryHash: hash(entry.summary) })
  expect(readFileSync(f.file).subarray(0, before.length)).toEqual(before)
  expect(JSON.stringify(outcome)).not.toContain('native history summary')
  expect(f.controls.inspect().compaction).toEqual({ canCompact: false })
  const saved = readFileSync(f.file), messages = f.runtime.session.messages
  await f.runtime.dispose(); const reopened = await f.make(SessionManager.open(f.file, f.sessionDir))
  expect(reopened.runtime.session.messages).toEqual(messages)
  expect(readFileSync(f.file).subarray(0, saved.length)).toEqual(saved)
  expect(findNativeControlOutcome(f.file, input, f.faux.models)).toEqual({ ...outcome, status: 'replayed' })
  expect(await reopened.controls.apply(input, new AbortController().signal)).toEqual({ ...outcome, status: 'replayed' })
})

it('preflights empty and immediately repeated compact against actual SDK behavior without appending an intent or replaying a user turn', async () => {
  const f = await setup(), emptyInput = f.input(), emptyBytes = readFileSync(f.file)
  await expect(f.runtime.session.compact()).rejects.toThrow('Nothing to compact')
  await expect(f.controls.apply(emptyInput, new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
  expect(f.faux.state.callCount).toBe(0); expect(readFileSync(f.file)).toEqual(emptyBytes)
  expect(findNativeControlOutcome(f.file, emptyInput, f.faux.models)).toBeUndefined()
  await f.seed(); f.faux.setResponses([fauxAssistantMessage('history summary'), fauxAssistantMessage('prefix summary')])
  applied(await f.controls.apply(f.input(), new AbortController().signal)); const calls = f.faux.state.callCount
  expect(f.controls.inspect().compaction?.canCompact).toBe(false)
  const compactedBytes = readFileSync(f.file)
  await expect(f.runtime.session.compact()).rejects.toThrow('Nothing to compact')
  await expect(f.controls.apply(f.input(), new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
  expect(f.faux.state.callCount).toBe(calls); expect(readFileSync(f.file)).toEqual(compactedBytes)
  f.faux.setResponses([fauxAssistantMessage('fresh answer after compact rejection')]); await f.runtime.session.prompt('a new actual user question')
  expect(f.faux.state.callCount).toBe(calls + 1)
  expect(JSON.stringify(f.runtime.session.messages)).toContain('fresh answer after compact rejection')
})

it('keeps Stop joined to the real before-compact hook, proves cancelled not-applied and permits a later turn', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await setup([pi => { pi.on('session_before_compact', async () => { started.resolve(); await release.promise; return { cancel: true } }) }]); cleanup.push(() => release.resolve())
  await f.seed(); const input = f.input(), controller = new AbortController(), work = f.controls.apply(input, controller.signal)
  await started.promise; controller.abort()
  let stopped = false; const stop = f.controls.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false); expect(f.controls.busy).toBe(true)
  release.resolve(); const outcome = failed(await work); await stop
  expect(outcome.failureProof.reason).toBe('cancelled'); expect(f.faux.state.callCount).toBe(2)
  expect(findNativeControlOutcome(f.file, input, f.faux.models)).toEqual(outcome)
  f.controls.resume(); f.faux.setResponses([fauxAssistantMessage('resumed without redoing compact')]); await f.runtime.session.prompt('continue')
  expect(f.faux.state.callCount).toBe(3)
})

it('treats compaction appended before a blocked after-hook as applied even when Stop arrives before the hook joins', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await setup([pi => {
    pi.on('session_before_compact', event => ({ compaction: { summary: 'operator hook summary', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }))
    pi.on('session_compact', async () => { started.resolve(); await release.promise })
  }]); cleanup.push(() => release.resolve()); await f.seed()
  const input = f.input(), controller = new AbortController(), work = f.controls.apply(input, controller.signal)
  await started.promise
  expect(f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'compaction')).toHaveLength(1)
  controller.abort(); let stopped = false; const stop = f.controls.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false); release.resolve()
  const outcome = applied(await work); await stop
  expect(outcome.proof.compaction?.summaryHash).toBe(hash('operator hook summary'))
  expect(f.faux.state.callCount).toBe(2)
  expect(findNativeControlOutcome(f.file, input, f.faux.models)).toEqual({ ...outcome, status: 'replayed' })
})

it('does not terminally reject a hook cancellation that made another native write', async () => {
  const f = await setup([pi => { pi.on('session_before_compact', () => { pi.appendEntry('native-hook-audit', { changed: true }); return { cancel: true } }) }]); await f.seed()
  const input = f.input(), calls = f.faux.state.callCount
  await expect(f.controls.apply(input, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' })
  expect(() => findNativeControlOutcome(f.file, input, f.faux.models)).toThrowError(expect.objectContaining({ code: 'failed' }))
  await expect(f.controls.apply(input, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' })
  expect(f.faux.state.callCount).toBe(calls)
})

it('rejects fabricated compact hashes, native entry identities, and not-applied proof reasons or prefixes', async () => {
  let cancel = true
  const f = await setup([pi => { pi.on('session_before_compact', () => cancel ? { cancel: true } : undefined) }]); await f.seed()
  const emptyInput = f.input(), rejection = failed(await f.controls.apply(emptyInput, new AbortController().signal))
  for (const mutate of [
    (proof: typeof rejection.failureProof) => { proof.reason = 'cancelled' },
    (proof: typeof rejection.failureProof) => { proof.afterHead.transcriptHash = '0'.repeat(64) },
    (proof: typeof rejection.failureProof) => { proof.markerEntryId = proof.intentEntryId },
  ]) { const proof = structuredClone(rejection.failureProof); mutate(proof); expect(() => verifyNativeCompactFailureProof(f.file, emptyInput, proof)).toThrow() }
  cancel = false; f.faux.setResponses([fauxAssistantMessage('native summary'), fauxAssistantMessage('turn summary')])
  const input = f.input(), result = applied(await f.controls.apply(input, new AbortController().signal))
  for (const mutate of [
    (proof: typeof result.proof) => { proof.compaction!.summaryHash = '0'.repeat(64) },
    (proof: typeof result.proof) => { proof.compaction!.entryId = proof.intentEntryId },
    (proof: typeof result.proof) => { proof.compaction!.firstKeptEntryId = proof.markerEntryId },
    (proof: typeof result.proof) => { proof.compaction!.tokensBefore++ },
  ]) { const outcome = structuredClone(result); mutate(outcome.proof); expect(() => verifyNativeControlProof(f.file, input, outcome, f.faux.models)).toThrow() }
})
