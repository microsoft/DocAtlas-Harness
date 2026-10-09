import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import type { NativeControlAction, NativeLineageAction, NativeLineageApply, NativeLineageOutcome, NativeThinkingLevel } from '@docatlas/contracts'
import { createPiRuntime } from '../src/create-runtime.js'
import { NativeControls } from '../src/worker/native-controls.js'
import { NativeLineage, findNativeLineageOutcome, verifyNativeLineageFailureProof, verifyNativeLineageOutcome, type NativeLineageConfigurationSeed } from '../src/worker/native-lineage.js'
import { restoreNativeSelectedSession } from '../src/worker/native-selection.js'
import { NativeModelPurpose, type NativeModelRequestPurpose } from '../src/worker/model-purpose.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const applied = (value: NativeLineageOutcome) => { if (value.status === 'not-applied') throw new Error('Expected proven native lineage'); return value }
const failed = (value: NativeLineageOutcome) => { if (value.status !== 'not-applied') throw new Error('Expected proven no lineage effect'); return value }
const navigate = (targetEntryId: string): NativeLineageAction => ({ kind: 'navigate', targetEntryId, summarize: false, instructions: '', replaceInstructions: false, label: null })

async function setup(extensions: ExtensionFactory[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-lineage-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions'); mkdirSync(cwd); mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })
  const faux = fauxProvider({ models: [{ id: 'lineage-plain', reasoning: false }, { id: 'lineage-reason', reasoning: true }], tokenSize: { min: 8192, max: 8192 } }); modelRuntime.registerNativeProvider(faux.provider)
  let sequence = 0
  const purposes: NativeModelRequestPurpose[] = []
  const make = async (manager: SessionManager, seed?: NativeLineageConfigurationSeed) => {
    let lineage: NativeLineage | undefined
    const purpose = new NativeModelPurpose(), recorded = manager.buildSessionContext()
    const runtime = await createPiRuntime({ cwd, agentDir, modelRuntime, sessionManager: manager,
      session: { model: recorded.model ? faux.getModel(recorded.model.modelId)! : faux.getModel('lineage-plain')!, thinkingLevel: recorded.thinkingLevel as NativeThinkingLevel },
      services: () => ({ settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'always', compaction: { enabled: false }, branchSummary: { reserveTokens: 512 }, retry: { enabled: false } }), resourceLoaderOptions: { extensionFactories: extensions } }),
      onBeforeSessionCreate: (manager, event) => lineage?.beforeSessionCreate(manager, event),
      onInvalidate: () => { lineage?.onInvalidate(); purpose.invalidate() },
      onBound: session => { const original = session.agent.streamFunction; session.agent.streamFunction = (model, context, options) => { purposes.push(purpose.consume(context, options?.signal)); return original(model, context, options) }; purpose.bind(session) },
    })
    cleanup.push(async () => { purpose.invalidate(); await runtime.dispose() })
    const controls = new NativeControls(runtime.session, faux.models, () => false); controls.initialize(seed)
    lineage = new NativeLineage(runtime, faux.models, () => controls.busy)
    const request = (action: NativeLineageAction): NativeLineageApply => ({ operationId: `lineage:${++sequence}`, requestHash: hash(`lineage full body ${sequence}`), expectedHead: lineage!.inspect(), action })
    const control = (action: NativeControlAction) => controls.apply({ operationId: `control:${++sequence}`, requestHash: hash(`control full body ${sequence}`), expectedHead: controls.inspect().head, action }, new AbortController().signal)
    return { runtime, controls, lineage, request, control }
  }
  const first = await make(SessionManager.create(cwd, sessionDir))
  const seed = async () => {
    faux.setResponses([fauxAssistantMessage('first native answer'), fauxAssistantMessage('second native answer')]); await first.runtime.session.prompt('first genuine question PREPARED_NATIVE_SENTINEL')
    const firstId = first.runtime.session.sessionManager.getLeafId()!; await first.runtime.session.prompt('second genuine question')
    return { firstId, secondId: first.runtime.session.sessionManager.getLeafId()!, users: first.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user') }
  }
  return { ...first, root, cwd, sessionDir, faux, make, seed, purposes, file: first.runtime.session.sessionFile! }
}

it('persists a real navigation proof across different branches, preserves current configuration, and restores queues by selected-branch journal order', async () => {
  const f = await setup(), { firstId } = await f.seed()
  await f.control({ kind: 'set-model', provider: f.faux.models[0]!.provider, modelId: 'lineage-reason' }); await f.control({ kind: 'set-thinking', level: 'high' })
  await f.control({ kind: 'set-queue-mode', queue: 'steering', mode: 'all' })
  const input = f.request(navigate(firstId)), before = readFileSync(f.file), calls = f.faux.state.callCount
  const outcome = applied((await f.lineage.apply(input, new AbortController().signal)).outcome), proof = outcome.proof
  expect(proof.kind).toBe('native-navigation-proof'); expect(proof.targetHead).toEqual(proof.sourceAfterHead)
  expect(proof.configuration).toMatchObject({ model: { id: 'lineage-reason' }, thinkingLevel: 'high', steeringMode: 'all' })
  expect(f.runtime.session.sessionManager.getBranch().some(entry => entry.id === proof.intentEntryId)).toBe(false)
  expect(readFileSync(f.file).subarray(0, before.length).equals(before)).toBe(true); expect(f.faux.state.callCount).toBe(calls)
  expect(JSON.stringify(outcome)).not.toContain('PREPARED_NATIVE_SENTINEL')
  expect(verifyNativeLineageOutcome(f.file, f.cwd, input, outcome, undefined, f.faux.models)).toEqual(outcome)
  await expect(f.lineage.apply(f.request(navigate(firstId)), new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
  await f.runtime.dispose()
  const seed = { markerEntryId: proof.targetMarkerEntryId, configuration: proof.configuration }
  const reopened = await f.make(restoreNativeSelectedSession(f.file, f.sessionDir, f.cwd, proof.targetHead), seed)
  expect(reopened.controls.inspect().configuration).toEqual(proof.configuration)
  expect(findNativeLineageOutcome(f.file, f.cwd, input)).toEqual({ outcome: { ...outcome, status: 'replayed' } })
  await reopened.control({ kind: 'set-queue-mode', queue: 'steering', mode: 'one-at-a-time' })
  const nextHead = reopened.lineage.inspect(); await reopened.runtime.dispose()
  const later = await f.make(restoreNativeSelectedSession(f.file, f.sessionDir, f.cwd, nextHead), seed)
  expect(later.controls.inspect().configuration.steeringMode).toBe('one-at-a-time')
  f.faux.setResponses([fauxAssistantMessage('a genuinely new branch answer')]); await later.runtime.session.prompt('new question on selected branch')
  expect(JSON.stringify(later.runtime.session.messages)).toContain('first native answer'); expect(JSON.stringify(later.runtime.session.messages)).not.toContain('second native answer')
})

it('keeps native user-parent navigation as a metadata-only transition without returning prepared editor text or inventing a question', async () => {
  const f = await setup(), { users } = await f.seed(), input = f.request({ ...navigate(users[1]!.id), label: 'chosen history point' } as NativeLineageAction)
  const count = f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'message').length
  const outcome = applied((await f.lineage.apply(input, new AbortController().signal)).outcome)
  if (outcome.proof.kind !== 'native-navigation-proof') throw new Error('Expected navigation')
  expect(outcome.proof.landingEntryId).toBe(users[1]!.parentId); expect(outcome.proof.summary).toBeNull()
  expect(f.runtime.session.sessionManager.getLabel(users[1]!.id)).toBe('chosen history point')
  expect(f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'message')).toHaveLength(count)
  expect(JSON.stringify(outcome)).not.toContain('genuine question'); expect(f.faux.state.callCount).toBe(2)
})

it('proves the actual auxiliary SDK branch summary while preserving source prefix and native labels', async () => {
  const f = await setup(), { firstId } = await f.seed(), action = { ...navigate(firstId), summarize: true, instructions: 'retain questions', label: 'summary branch' } as NativeLineageAction
  f.faux.setResponses([fauxAssistantMessage('genuine native summary')])
  const input = f.request(action), result = applied((await f.lineage.apply(input, new AbortController().signal)).outcome)
  if (result.proof.kind !== 'native-navigation-proof') throw new Error('Expected navigation')
  expect(result.proof.summary?.fromEntryId).toBe(result.proof.intentEntryId)
  expect(f.purposes).toEqual(['agent-answer', 'agent-answer', 'auxiliary'])
  expect(f.runtime.session.sessionManager.getLabel(result.proof.summary!.entryId)).toBe('summary branch')
  expect(JSON.stringify(result)).not.toContain('genuine native summary')
})

it.each(['navigate', 'fork'] as const)('joins a real %s veto hook and produces an exact durable non-application proof', async kind => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await setup([pi => {
    const hook = async () => { started.resolve(); await release.promise; return { cancel: true } }
    if (kind === 'navigate') pi.on('session_before_tree', hook); else pi.on('session_before_fork', hook)
  }]); cleanup.push(() => release.resolve())
  const { firstId } = await f.seed(), action = kind === 'navigate' ? navigate(firstId) : { kind: 'fork', targetEntryId: firstId, position: 'at' } as const
  const input = f.request(action), controller = new AbortController(), work = f.lineage.apply(input, controller.signal)
  await started.promise; controller.abort(); let joined = false; const stop = f.lineage.stop().then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false); release.resolve()
  const outcome = failed((await work).outcome); await stop
  expect(outcome.failureProof.reason).toBe('cancelled'); expect(outcome.failureProof.afterHead.contextHash).toBe(input.expectedHead.contextHash)
  expect(outcome.failureProof.afterHead.fileSeal.entryCount - input.expectedHead.fileSeal.entryCount).toBe(2)
  expect(findNativeLineageOutcome(f.file, f.cwd, input)).toEqual({ outcome })
  const changed = structuredClone(outcome.failureProof); changed.reason = 'sdk-rejected'
  expect(() => verifyNativeLineageFailureProof(f.file, f.cwd, input, changed)).toThrow()
  f.lineage.resume(); f.faux.setResponses([fauxAssistantMessage('new actual answer after veto')]); await f.runtime.session.prompt('continue after no navigation')
  expect(f.faux.state.callCount).toBe(3)
})

it('matches the actual fork basis when before-fork and shutdown hooks write different labels, and independently restores both configurations', async () => {
  let target = ''
  const f = await setup([pi => {
    pi.on('session_before_fork', () => { pi.setLabel(target, 'label at actual copy') })
    pi.on('session_shutdown', event => { if (event.reason === 'fork') pi.setLabel(target, 'label after actual copy') })
  }]); await f.seed()
  await f.control({ kind: 'set-model', provider: f.faux.models[0]!.provider, modelId: 'lineage-reason' }); await f.control({ kind: 'set-thinking', level: 'high' })
  await f.control({ kind: 'set-queue-mode', queue: 'steering', mode: 'all' })
  f.faux.setResponses([fauxAssistantMessage('reasoning fork answer')]); await f.runtime.session.prompt('reasoning fork question'); target = f.runtime.session.sessionManager.getLeafId()!
  const original = f.runtime.session, input = f.request({ kind: 'fork', targetEntryId: target, position: 'at' }), before = readFileSync(f.file)
  const result = await f.lineage.apply(input, new AbortController().signal), outcome = applied(result.outcome)
  if (outcome.proof.kind !== 'native-fork-proof') throw new Error('Expected fork')
  const proof = outcome.proof, childFile = join(f.sessionDir, result.forkFilename!)
  expect(f.runtime.session.sessionFile).toBe(childFile); expect(f.runtime.session.sessionId).not.toBe(original.sessionId)
  expect(proof.configuration).toMatchObject({ model: { id: 'lineage-reason' }, thinkingLevel: 'high', steeringMode: 'one-at-a-time' })
  expect(proof.sourceConfiguration.steeringMode).toBe('all')
  expect(original.sessionManager.getLabel(target)).toBe('label after actual copy'); expect(f.runtime.session.sessionManager.getLabel(target)).toBe('label at actual copy')
  expect(proof.forkBasisSeal.entryCount).toBeLessThan(proof.sourceAfterHead.fileSeal.entryCount - 1)
  expect(readFileSync(f.file).subarray(0, before.length).equals(before)).toBe(true)
  expect(verifyNativeLineageOutcome(f.file, f.cwd, input, outcome, childFile, f.faux.models)).toEqual(outcome)
  expect(findNativeLineageOutcome(f.file, f.cwd, input, filename => join(f.sessionDir, filename), f.faux.models)).toEqual({ outcome: { ...outcome, status: 'replayed' }, forkFilename: result.forkFilename })
  await f.runtime.dispose()
  const child = await f.make(restoreNativeSelectedSession(childFile, f.sessionDir, f.cwd, proof.targetHead), { markerEntryId: proof.targetMarkerEntryId, configuration: proof.configuration })
  expect(child.controls.inspect().configuration).toEqual(proof.configuration)
  const parent = await f.make(restoreNativeSelectedSession(f.file, f.sessionDir, f.cwd, proof.sourceAfterHead), { markerEntryId: proof.sourceMarkerEntryId, configuration: proof.sourceConfiguration })
  expect(parent.controls.inspect().configuration).toEqual(proof.sourceConfiguration)
  for (const mutate of [
    (value: typeof proof) => { value.inheritanceHash = '0'.repeat(64) },
    (value: typeof proof) => { value.inheritedEntryCount++ },
    (value: typeof proof) => { value.targetHead.contextHash = '0'.repeat(64) },
    (value: typeof proof) => { value.forkBasisSeal = value.sourceAfterHead.fileSeal },
  ]) { const changed = structuredClone(proof); mutate(changed); expect(() => verifyNativeLineageOutcome(f.file, f.cwd, input, { ...outcome, proof: changed }, childFile, f.faux.models)).toThrow() }
})

it('forks before a first actual user through native metadata-only bootstrap without introducing assistant messages', async () => {
  const f = await setup(), { users } = await f.seed(), input = f.request({ kind: 'fork', targetEntryId: users[0]!.id, position: 'before' })
  const result = await f.lineage.apply(input, new AbortController().signal), outcome = applied(result.outcome)
  expect(outcome.proof.kind).toBe('native-fork-proof'); expect(f.runtime.session.messages).toEqual([])
  expect(f.runtime.session.sessionManager.getEntries().every(entry => entry.type !== 'message')).toBe(true)
  expect(JSON.stringify(result)).not.toContain('PREPARED_NATIVE_SENTINEL'); expect(f.faux.state.callCount).toBe(2)
  expect(verifyNativeLineageOutcome(f.file, f.cwd, input, outcome, join(f.sessionDir, result.forkFilename!), f.faux.models)).toEqual(outcome)
})

it('keeps an extra native write followed by veto unknown and fences later worker actions', async () => {
  const f = await setup([pi => { pi.on('session_before_tree', () => { pi.appendEntry('actual-extra-native-state', { changed: true }); return { cancel: true } }) }]), { firstId } = await f.seed()
  const input = f.request(navigate(firstId))
  await expect(f.lineage.apply(input, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' })
  expect(f.lineage.blocked).toBe(true); expect(() => findNativeLineageOutcome(f.file, f.cwd, input)).toThrowError(expect.objectContaining({ code: 'failed' }))
  await expect(f.lineage.apply(f.request(navigate(firstId)), new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
})
