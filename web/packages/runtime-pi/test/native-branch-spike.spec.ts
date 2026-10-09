import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { createPiRuntime } from '../src/create-runtime.js'
import { flushInitialNativeSession } from '../src/worker/native-state.js'
import { inspectNativeSession } from '../src/worker/session-file.js'
import { NativeModelPurpose, type NativeModelRequestPurpose } from '../src/worker/model-purpose.js'
import { NativeControls, NATIVE_CONTROL_MARKER } from '../src/worker/native-controls.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sameJson = (value: unknown) => hash(JSON.stringify(value))

async function setup(extensions: ExtensionFactory[] = [], fixedInitialModel = false) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-branch-spike-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions'); mkdirSync(cwd); mkdirSync(agentDir)
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })
  const faux = fauxProvider({ models: [{ id: 'branch-plain', reasoning: false }, { id: 'branch-reason', reasoning: true }], tokenSize: { min: 8192, max: 8192 } }); modelRuntime.registerNativeProvider(faux.provider)
  const bound: AgentSession[] = [], invalidated: string[] = [], purposes: NativeModelRequestPurpose[] = [], purpose = new NativeModelPurpose()
  const runtime = await createPiRuntime({ cwd, agentDir, modelRuntime, sessionManager: SessionManager.create(cwd, sessionDir),
    ...(fixedInitialModel ? { session: { model: faux.getModel('branch-plain')! } } : {}),
    services: () => ({ settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'always', defaultProvider: faux.models[0]!.provider, defaultModel: 'branch-plain',
      compaction: { enabled: false }, branchSummary: { reserveTokens: 512 }, retry: { enabled: false } }), resourceLoaderOptions: { extensionFactories: extensions } }),
    onBound: session => {
      bound.push(session); const original = session.agent.streamFunction
      session.agent.streamFunction = (model, context, options) => { purposes.push(purpose.consume(context, options?.signal)); return original(model, context, options) }
      purpose.bind(session)
    }, onInvalidate: () => { invalidated.push(bound.at(-1)!.sessionId); purpose.invalidate() },
  })
  cleanup.push(async () => { purpose.invalidate(); await runtime.dispose() })
  flushInitialNativeSession(runtime.session.sessionManager)
  const seed = async () => {
    faux.setResponses([fauxAssistantMessage('first actual answer'), fauxAssistantMessage('second actual answer')])
    await runtime.session.prompt('first actual human question')
    const first = runtime.session.sessionManager.getLeafId()!
    await runtime.session.prompt('second actual human question')
    const second = runtime.session.sessionManager.getLeafId()!
    return { first, second, users: runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user') }
  }
  return { root, cwd, agentDir, sessionDir, runtime, faux, seed, bound, invalidated, purposes }
}

it('distinguishes full append-only bytes from the selected SDK leaf, including a selection explicitly restored before factory creation', async () => {
  const f = await setup(), { first, second } = await f.seed(), manager = f.runtime.session.sessionManager, file = f.runtime.session.sessionFile!, before = readFileSync(file)
  expect(await f.runtime.session.navigateTree(first)).toEqual({ editorText: undefined, cancelled: false, summaryEntry: undefined })
  expect(manager.getLeafId()).toBe(first); expect(readFileSync(file).equals(before)).toBe(true)
  expect(SessionManager.open(file, f.sessionDir).getLeafId()).toBe(second)
  const entriesBeforeWitness = manager.getEntries(), selectedMessages = f.runtime.session.messages
  const witness = manager.appendCustomEntry('docatlas.branch-spike.v1', { selectedLeafEntryId: first, filePrefixHash: hash(before) })
  manager.branch(first) // A complete file can end in a durable witness while the native selection remains elsewhere.
  const full = inspectNativeSession(file, manager.getSessionId(), f.cwd, true)
  expect(full.seal.leafEntryId).toBe(witness); expect(manager.getLeafId()).toBe(first)
  expect(full.entries).toHaveLength(entriesBeforeWitness.length + 1)
  const reopened = SessionManager.open(file, f.sessionDir); expect(reopened.getLeafId()).toBe(witness)
  reopened.branch(first)
  expect(sameJson(reopened.buildSessionContext().messages)).toBe(sameJson(selectedMessages))
  expect(reopened.getEntries().some(entry => entry.id === second)).toBe(true)
  reopened.resetLeaf(); expect(reopened.getLeafId()).toBeNull(); expect(reopened.buildSessionContext().messages).toEqual([])
  expect(readFileSync(file).subarray(0, before.length).equals(before)).toBe(true)
})

it('uses native user-parent landing and native editorText, never silently submits it, and keeps the live model across navigation', async () => {
  const f = await setup(); f.faux.setResponses([fauxAssistantMessage('plain branch'), fauxAssistantMessage('reasoning branch')])
  await f.runtime.session.prompt('first user including PREPARED_NATIVE_CONTEXT_SENTINEL'); const first = f.runtime.session.sessionManager.getLeafId()!
  await f.runtime.session.setModel(f.faux.getModel('branch-reason')!); f.runtime.session.setThinkingLevel('high')
  await f.runtime.session.prompt('second original user'); const manager = f.runtime.session.sessionManager
  const user = manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user').at(-1)!
  const calls = f.faux.state.callCount, bytes = readFileSync(f.runtime.session.sessionFile!)
  const returned = await f.runtime.session.navigateTree(user.id)
  expect(returned).toMatchObject({ editorText: 'second original user', cancelled: false }); expect(manager.getLeafId()).toBe(user.parentId)
  expect(f.faux.state.callCount).toBe(calls); expect(readFileSync(f.runtime.session.sessionFile!).equals(bytes)).toBe(true)
  await f.runtime.session.navigateTree(first)
  expect(f.runtime.session.model?.id).toBe('branch-reason'); expect(f.runtime.session.thinkingLevel).toBe('high')
  expect(manager.buildSessionContext()).toMatchObject({ model: { modelId: 'branch-plain' }, thinkingLevel: 'off' })
  const selectedMessages = sameJson(f.runtime.session.messages)
  // Public native metadata can explicitly preserve the unchanged live configuration on the selected branch.
  manager.appendModelChange(f.runtime.session.model!.provider, f.runtime.session.model!.id); manager.appendThinkingLevelChange(f.runtime.session.thinkingLevel)
  const marker = manager.appendCustomEntry('docatlas.branch-spike.v1', { sdkLandingEntryId: first, configurationRecorded: true })
  inspectNativeSession(f.runtime.session.sessionFile!, manager.getSessionId(), f.cwd, true)
  const reopened = SessionManager.open(f.runtime.session.sessionFile!, f.sessionDir)
  expect(reopened.getLeafId()).toBe(marker)
  expect(reopened.buildSessionContext()).toMatchObject({ model: { modelId: 'branch-reason' }, thinkingLevel: 'high' })
  expect(sameJson(reopened.buildSessionContext().messages)).toBe(selectedMessages)
  expect(readFileSync(f.runtime.session.sessionFile!).subarray(0, bytes.length).equals(bytes)).toBe(true)
})

it('creates an actual auxiliary branch summary with native fromId/landing/label links and retains the abandoned branch', async () => {
  const f = await setup(), { first, second } = await f.seed(), manager = f.runtime.session.sessionManager, before = readFileSync(f.runtime.session.sessionFile!), calls = f.faux.state.callCount
  f.faux.setResponses([fauxAssistantMessage('native branch summary sentinel')])
  const result = await f.runtime.session.navigateTree(first, { summarize: true, customInstructions: 'retain unresolved questions', replaceInstructions: false, label: 'reviewed branch' })
  expect(result.cancelled).toBe(false); expect(result.summaryEntry).toMatchObject({ type: 'branch_summary', parentId: first, fromId: second })
  expect(result.summaryEntry!.summary).toContain('native branch summary sentinel')
  expect(f.purposes.slice(calls)).toEqual(['auxiliary']); expect(f.faux.state.callCount).toBe(calls + 1)
  expect(manager.getLabel(result.summaryEntry!.id)).toBe('reviewed branch')
  expect(manager.getLeafEntry()).toMatchObject({ type: 'label', parentId: result.summaryEntry!.id, targetId: result.summaryEntry!.id, label: 'reviewed branch' })
  expect(manager.getEntries().some(entry => entry.id === second)).toBe(true)
  expect(readFileSync(f.runtime.session.sessionFile!).subarray(0, before.length).equals(before)).toBe(true)
})

it('joins a real asynchronous tree hook and observes that native abort does not undo a custom-summary navigation', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await setup([pi => { pi.on('session_before_tree', async event => { started.resolve(); await release.promise
    expect(event.signal.aborted).toBe(true); return { summary: { summary: 'actual hook navigation despite abort' }, label: 'hook label' }
  }) }]); cleanup.push(() => release.resolve()); const { first, second } = await f.seed(), manager = f.runtime.session.sessionManager
  const work = f.runtime.session.navigateTree(first, { summarize: true }); await started.promise
  let joined = false; const abort = f.runtime.session.abort().then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false); expect(manager.getLeafId()).toBe(second)
  release.resolve(); const result = await work; await abort
  expect(result.cancelled).toBe(false); expect(result.summaryEntry).toMatchObject({ parentId: first, fromId: second, fromHook: true })
  expect(f.faux.state.callCount).toBe(2); expect(manager.getLabel(result.summaryEntry!.id)).toBe('hook label')
})

it('accepts a native tree-hook veto without changing selected state or bytes', async () => {
  const f = await setup([pi => { pi.on('session_before_tree', () => ({ cancel: true })) }]), { first, second } = await f.seed()
  const before = readFileSync(f.runtime.session.sessionFile!)
  expect(await f.runtime.session.navigateTree(first, { summarize: true })).toEqual({ cancelled: true })
  expect(f.runtime.session.sessionManager.getLeafId()).toBe(second); expect(readFileSync(f.runtime.session.sessionFile!).equals(before)).toBe(true); expect(f.faux.state.callCount).toBe(2)
})

it('forks through the full native runtime, rebinds services, preserves non-label IDs and rechains recreated labels without modifying the original file', async () => {
  const f = await setup(), { first } = await f.seed(), parentSession = f.runtime.session, parentFile = parentSession.sessionFile!, manager = parentSession.sessionManager
  manager.appendLabelChange(first, 'retained research anchor')
  f.faux.setResponses([fauxAssistantMessage('third actual answer')]); await parentSession.prompt('third user after label')
  const target = manager.getLeafId()!, parentEntries = manager.getEntries(), parentBytes = readFileSync(parentFile), selected = manager.getBranch(target)
  const withSessionIds: string[] = []
  expect(await f.runtime.fork(target, { position: 'at', withSession: async context => { withSessionIds.push(context.sessionManager.getSessionId()) } })).toEqual({ cancelled: false, selectedText: undefined })
  const child = f.runtime.session, childManager = child.sessionManager
  expect(child).not.toBe(parentSession); expect(child.sessionId).not.toBe(parentSession.sessionId); expect(child.sessionFile).not.toBe(parentFile)
  expect(dirname(child.sessionFile!)).toBe(f.sessionDir); expect(childManager.getHeader()?.parentSession).toBe(parentFile)
  expect(f.bound).toEqual([parentSession, child]); expect(f.invalidated).toEqual([parentSession.sessionId]); expect(withSessionIds).toEqual([child.sessionId])
  expect(readFileSync(parentFile).equals(parentBytes)).toBe(true)
  const originalLabels = new Set(parentEntries.filter(entry => entry.type === 'label').map(entry => entry.id)), childEntries = childManager.getEntries()
  expect(childEntries.filter(entry => entry.type !== 'label').map(entry => entry.id)).toEqual(selected.filter(entry => entry.type !== 'label').map(entry => entry.id))
  expect(childEntries.filter(entry => entry.type === 'label').every(entry => !originalLabels.has(entry.id))).toBe(true)
  expect(childManager.getLabel(first)).toBe('retained research anchor')
  const known = new Set<string>(); for (const entry of childEntries) { expect(entry.parentId === null || known.has(entry.parentId)).toBe(true); known.add(entry.id) }
  expect(child.getActiveToolNames()).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']))
})

it('forks before a real first user as metadata-only native state and bootstraps it without fake assistant messages', async () => {
  const f = await setup(), { users } = await f.seed(), parentFile = f.runtime.session.sessionFile!, before = readFileSync(parentFile), target = users[0]!
  expect(await f.runtime.fork(target.id, { position: 'before' })).toEqual({ cancelled: false, selectedText: 'first actual human question' })
  const child = f.runtime.session, manager = child.sessionManager
  expect(manager.getHeader()?.parentSession).toBe(parentFile); expect(child.messages).toEqual([])
  expect(manager.getEntries().every(entry => entry.type !== 'message')).toBe(true); expect(existsSync(child.sessionFile!)).toBe(false)
  expect(flushInitialNativeSession(manager)).toEqual({ created: true }); expect(existsSync(child.sessionFile!)).toBe(true)
  expect(readFileSync(parentFile).equals(before)).toBe(true)
  expect(SessionManager.open(child.sessionFile!, f.sessionDir).getSessionId()).toBe(child.sessionId)
})

it('does not let initial-model composition override the inherited native fork model or thinking level', async () => {
  const f = await setup([], true); await f.seed()
  await f.runtime.session.setModel(f.faux.getModel('branch-reason')!); f.runtime.session.setThinkingLevel('high')
  f.faux.setResponses([fauxAssistantMessage('reasoning fork target')]); await f.runtime.session.prompt('question under reasoning model')
  const target = f.runtime.session.sessionManager.getLeafId()!
  await f.runtime.fork(target, { position: 'at' })
  expect(f.runtime.session.sessionManager.buildSessionContext()).toMatchObject({ model: { modelId: 'branch-reason' }, thinkingLevel: 'high' })
  expect(f.runtime.session.model?.id).toBe('branch-reason'); expect(f.runtime.session.thinkingLevel).toBe('high')
})

it('retains parent operation markers in a fork as historical bytes, not independently verifiable child operation proofs', async () => {
  const f = await setup(); await f.seed()
  const controls = new NativeControls(f.runtime.session, f.faux.models, () => false); controls.initialize()
  await controls.apply({ operationId: 'parent:queue', requestHash: hash('parent queue request'), expectedHead: controls.inspect().head,
    action: { kind: 'set-queue-mode', queue: 'steering', mode: 'all' } }, new AbortController().signal)
  const oldSessionId = f.runtime.session.sessionId, oldFile = f.runtime.session.sessionFile!, before = readFileSync(oldFile)
  const originalMarkers = f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === NATIVE_CONTROL_MARKER)
  await f.runtime.fork(f.runtime.session.sessionManager.getLeafId()!, { position: 'at' })
  const child = f.runtime.session
  expect(child.sessionId).not.toBe(oldSessionId); expect(child.steeringMode).toBe('one-at-a-time')
  expect(sameJson(child.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === NATIVE_CONTROL_MARKER))).toBe(sameJson(originalMarkers))
  const childControls = new NativeControls(child, f.faux.models, () => false)
  expect(() => childControls.initialize()).not.toThrow(); expect(childControls.inspect().configuration.steeringMode).toBe('one-at-a-time')
  expect(readFileSync(oldFile).equals(before)).toBe(true)
})

it('honors an actual before-fork veto without changing native identity, bytes, factories or rebinds', async () => {
  const seen: string[] = []
  const f = await setup([pi => { pi.on('session_before_fork', event => { seen.push(event.position); return { cancel: true } }) }]), { first } = await f.seed()
  const original = f.runtime.session, bytes = readFileSync(original.sessionFile!)
  expect(await f.runtime.fork(first, { position: 'at' })).toEqual({ cancelled: true })
  expect(seen).toEqual(['at']); expect(f.runtime.session).toBe(original); expect(f.bound).toHaveLength(1); expect(f.invalidated).toEqual([])
  expect(readFileSync(original.sessionFile!).equals(bytes)).toBe(true)
})

it.each(['metadata', 'label'] as const)('navigates an actual older %s node without a synthetic answer or a target-type approximation', async kind => {
  const f = await setup(), { first } = await f.seed(), manager = f.runtime.session.sessionManager
  const target = kind === 'metadata' ? manager.appendCustomEntry('docatlas.actual-tree-capability.v1', { annotation: 'native metadata' }) : manager.appendLabelChange(first, 'actual native label')
  f.faux.setResponses([fauxAssistantMessage('later answer beyond selected metadata')]); await f.runtime.session.prompt('genuine later question after the tree node')
  const file = f.runtime.session.sessionFile!, before = readFileSync(file), later = manager.getLeafId(), calls = f.faux.state.callCount
  expect(later).not.toBe(target)
  expect(await f.runtime.session.navigateTree(target)).toEqual({ editorText: undefined, cancelled: false, summaryEntry: undefined })
  expect(manager.getLeafId()).toBe(target); expect(f.faux.state.callCount).toBe(calls)
  expect(JSON.stringify(f.runtime.session.messages)).toContain('second actual answer')
  expect(JSON.stringify(f.runtime.session.messages)).not.toContain('later answer beyond selected metadata')
  expect(readFileSync(file).equals(before)).toBe(true)
})

it.each(['metadata', 'label'] as const)('forks at an actual older %s node while rejecting native fork-before for this non-user node', async kind => {
  const f = await setup(), { first } = await f.seed(), original = f.runtime.session, manager = original.sessionManager
  const target = kind === 'metadata' ? manager.appendCustomEntry('docatlas.actual-tree-capability.v1', { annotation: 'native metadata' }) : manager.appendLabelChange(first, 'actual native label')
  f.faux.setResponses([fauxAssistantMessage('later answer excluded from this fork')]); await original.prompt('genuine later question after the fork node')
  const before = readFileSync(original.sessionFile!), calls = f.faux.state.callCount
  await expect(f.runtime.fork(target, { position: 'before' })).rejects.toThrow('Invalid entry ID for forking')
  expect(f.runtime.session).toBe(original); expect(readFileSync(original.sessionFile!).equals(before)).toBe(true)
  expect(await f.runtime.fork(target, { position: 'at' })).toEqual({ cancelled: false, selectedText: undefined })
  expect(f.runtime.session.sessionId).not.toBe(original.sessionId); expect(f.faux.state.callCount).toBe(calls)
  expect(JSON.stringify(f.runtime.session.messages)).toContain('second actual answer')
  expect(JSON.stringify(f.runtime.session.messages)).not.toContain('later answer excluded from this fork')
  if (kind === 'metadata') expect(f.runtime.session.sessionManager.getEntry(target)).toMatchObject({ type: 'custom', customType: 'docatlas.actual-tree-capability.v1' })
  else expect(f.runtime.session.sessionManager.getLabel(first)).toBe('actual native label')
  expect(readFileSync(original.sessionFile!).equals(before)).toBe(true)
})
