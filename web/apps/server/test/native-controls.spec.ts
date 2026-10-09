import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeControlAction, NativeThinkingLevel, ProductNativeCommand, ProductNativeInspection } from '@docatlas/contracts'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { ControlStore, ResourceStore, RuntimeCatalog, RuntimeManager } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:native-controls', workspaceId: 'workspace:native-controls' }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-controls-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const work = join(root, 'work'), agent = join(root, 'reviewed-agent'), state = join(root, 'private')
  for (const path of [work, agent, state]) mkdirSync(path)
  const stores = () => ({ control: ControlStore.open(join(state, 'control')), catalog: new RuntimeCatalog(join(state, 'catalog')), resources: new ResourceStore(join(state, 'resources')) })
  const first = stores(), snapshot = first.resources.capture(agent), approval = first.resources.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
  const open = async (values: ReturnType<typeof stores>, answers = ['Native controls test answer']) => {
    const model = await createPiTestModel({ answers, models: [
      { id: 'docatlas-native-standard', name: 'Native standard test', reasoning: false },
      { id: 'docatlas-native-thinking', name: 'Native thinking test', reasoning: true },
    ] })
    const manager = new RuntimeManager({ ...values, ...model, actor, approvalId: approval.approvalId, workspaceRoot: work,
      stateRoot: join(root, 'runtimes'), rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()) })
    let closed = false
    const close = async () => { if (closed) return; closed = true; await manager.close(); values.catalog.close(); values.resources.close(); values.control.close() }
    cleanup.push(close)
    return { manager, model, close }
  }
  return { root, work, first, stores, open }
}
function command(view: ProductNativeInspection, key: string, action: NativeControlAction): ProductNativeCommand {
  if (!view.state) throw new Error('Native test runtime must be idle')
  return { schemaVersion: 1, kind: 'native-command', conversationId: view.binding.conversationId, expectedBindingId: view.binding.bindingId,
    expectedGeneration: view.binding.generation, runtimeSessionId: view.binding.runtimeSessionId, approvalId: view.resource.approvalId,
    expectedApprovalVersion: view.resource.version, expectedHead: structuredClone(view.state.head), idempotencyKey: key, action }
}
const queueAction = (view: ProductNativeInspection): NativeControlAction => ({ kind: 'set-queue-mode', queue: 'steering', mode: view.state!.configuration.steeringMode === 'all' ? 'one-at-a-time' : 'all' })
const question = (conversationId: string, key = 'question:native-controls:one') => ({ schemaVersion: 1 as const, kind: 'submission' as const, conversationId,
  expectedGeneration: 1, idempotencyKey: key, mode: 'prompt' as const, text: 'A real human question after native configuration', sourceRefs: [], selectionContextIds: [] })

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('product native controls with real isolated Pi and explicit faux ModelRuntime', () => {
  it('configures before the first prompt with verified native markers, no fake assistant answer and exact-key replay', async () => {
    const f = fixture(), current = await f.open(f.first), binding = current.manager.create(actor, 'create:native-controls:initial').binding
    const view = await current.manager.nativeInspect(actor, binding.conversationId), runtime = await current.manager.get(actor, binding.conversationId)
    expect(view.state).not.toBeNull(); expect(view.busy).toBe(false); expect(current.model.getCallCount()).toBe(0)
    expect(runtime.observations.snapshot(actor).history.messages).toEqual([])
    const request = command(view, 'native:initial:queue', queueAction(view)), before = readFileSync(runtime.worker.verifiedFile!)
    const applying = await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    expect(applying.state).toBe('accepted'); await runtime.coordinator.waitForIdle()
    const result = current.manager.nativeOperation(actor, binding.conversationId, applying.operationId)
    expect(result).toMatchObject({ state: 'succeeded', result: { action: request.action, beforeHead: request.expectedHead } })
    const file = runtime.worker.verifiedFile!, bytes = readFileSync(file)
    expect(bytes.subarray(0, before.length)).toEqual(before)
    expect(bytes.length).toBeGreaterThan(before.length)
    expect((await current.manager.nativeInspect(actor, binding.conversationId)).state!.configuration.steeringMode).toBe(request.action.kind === 'set-queue-mode' ? request.action.mode : '')
    expect(runtime.observations.snapshot(actor).history.messages).toEqual([])
    expect(current.model.getCallCount()).toBe(0)
    expect(await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})).toEqual(result)
    await expect(current.manager.nativeCommand(actor, binding.conversationId, { ...request, expectedApprovalVersion: request.expectedApprovalVersion + 1 }, () => {})).rejects.toThrow('different input')
    expect(readFileSync(file)).toEqual(bytes)
    expect(JSON.stringify(result)).not.toContain(f.root)
  }, 30000)

  it('fails stale heads and unsupported thinking before native dispatch, then accepts a fresh valid operation', async () => {
    const f = fixture(), current = await f.open(f.first), binding = current.manager.create(actor, 'create:native-controls:stale').binding
    const initial = await current.manager.nativeInspect(actor, binding.conversationId), runtime = await current.manager.get(actor, binding.conversationId)
    const first = await current.manager.nativeCommand(actor, binding.conversationId, command(initial, 'native:advance:head', queueAction(initial)), () => {})
    await runtime.coordinator.waitForIdle(); expect(current.manager.nativeOperation(actor, binding.conversationId, first.operationId).state).toBe('succeeded')
    const bytes = readFileSync(runtime.worker.verifiedFile!)
    const stale = await current.manager.nativeCommand(actor, binding.conversationId, command(initial, 'native:stale:head', queueAction(initial)), () => {})
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, stale.operationId)).toMatchObject({ state: 'failed', errorCode: 'stale-state', result: null })
    const fresh = await current.manager.nativeInspect(actor, binding.conversationId)
    const levels: NativeThinkingLevel[] = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off']
    const unsupported = levels.find(level => !fresh.state!.thinkingLevels.includes(level))
    expect(unsupported).toBeDefined()
    const denied = await current.manager.nativeCommand(actor, binding.conversationId, command(fresh, 'native:thinking:unsupported', { kind: 'set-thinking', level: unsupported! }), () => {})
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, denied.operationId)).toMatchObject({ state: 'failed', errorCode: 'invalid-action', result: null })
    expect(readFileSync(runtime.worker.verifiedFile!)).toEqual(bytes)
    const next = await current.manager.nativeCommand(actor, binding.conversationId, command(fresh, 'native:fresh:valid', queueAction(fresh)), () => {})
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, next.operationId).state).toBe('succeeded')
    expect(runtime.coordinator.nativeBlocked).toBe(false); expect(current.model.getCallCount()).toBe(0)
  }, 30000)

  it('switches between actually registered native models and their supported thinking levels without a model call', async () => {
    const f = fixture(), current = await f.open(f.first), binding = current.manager.create(actor, 'create:native-controls:model').binding
    const view = await current.manager.nativeInspect(actor, binding.conversationId), runtime = await current.manager.get(actor, binding.conversationId)
    expect(view.models).toHaveLength(2)
    const alternative = view.models.find(model => model.id === 'docatlas-native-thinking')!
    const changed = await current.manager.nativeCommand(actor, binding.conversationId, command(view, 'native:model:alternative', { kind: 'set-model', provider: alternative.provider, modelId: alternative.id }), () => {})
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, changed.operationId).state).toBe('succeeded')
    const next = await current.manager.nativeInspect(actor, binding.conversationId)
    expect(next.state!.configuration.model).toEqual({ provider: alternative.provider, id: alternative.id })
    const level = next.state!.thinkingLevels.at(-1)!
    expect(level).not.toBe('off')
    const thinking = await current.manager.nativeCommand(actor, binding.conversationId, command(next, 'native:thinking:supported', { kind: 'set-thinking', level }), () => {})
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, thinking.operationId)).toMatchObject({ state: 'succeeded', result: { configuration: { thinkingLevel: level } } })
    expect(current.model.getCallCount()).toBe(0)
    expect(runtime.observations.snapshot(actor).history.messages).toEqual([])
    runtime.coordinator.submit(question(binding.conversationId)); await runtime.coordinator.waitForIdle()
    expect(current.model.getCallCount()).toBe(1)
  }, 30000)

  it('queues a real question behind an accepted native operation without early preparation or model dispatch', async () => {
    const f = fixture(), current = await f.open(f.first), binding = current.manager.create(actor, 'create:native-controls:queue').binding
    const view = await current.manager.nativeInspect(actor, binding.conversationId), runtime = await current.manager.get(actor, binding.conversationId)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = runtime.worker.nativeApply.bind(runtime.worker)
    vi.spyOn(runtime.worker, 'nativeApply').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
    const accepted = await current.manager.nativeCommand(actor, binding.conversationId, command(view, 'native:queued:operation', queueAction(view)), () => {})
    try {
      await entered.promise
      const submitted = runtime.coordinator.submit(question(binding.conversationId)).receipt
      expect(f.first.control.get(actor, submitted.submissionId).state).toBe('accepted')
      expect(runtime.coordinator.queued).toBe(1); expect(current.model.getCallCount()).toBe(0)
      release.resolve(); await runtime.coordinator.waitForIdle()
      expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('succeeded')
      expect(f.first.control.get(actor, submitted.submissionId).state).toBe('completed')
      expect(current.model.getCallCount()).toBe(1)
      expect(runtime.observations.snapshot(actor).history.messages.map(message => message.text)).toContain('Native controls test answer')
    } finally { release.resolve() }
  }, 30000)

  it('repairs a lost applied IPC reply only by exact native commit proof, never by executing the setter again', async () => {
    const f = fixture(), current = await f.open(f.first), binding = current.manager.create(actor, 'create:native-controls:reply-loss').binding
    const view = await current.manager.nativeInspect(actor, binding.conversationId), runtime = await current.manager.get(actor, binding.conversationId), request = command(view, 'native:lost:reply', queueAction(view))
    const original = runtime.worker.nativeApply.bind(runtime.worker)
    const apply = vi.spyOn(runtime.worker, 'nativeApply').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('injected lost reply after actual native commit') })
    const accepted = await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    await runtime.coordinator.waitForIdle()
    const unknown = current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId), bytes = readFileSync(runtime.worker.verifiedFile!)
    expect(unknown).toMatchObject({ state: 'outcome-unknown', result: null, errorCode: 'execution-interrupted' })
    expect(runtime.coordinator.nativeBlocked).toBe(true)
    const observed = await current.manager.nativeInspect(actor, binding.conversationId)
    expect(observed.busy).toBe(true)
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId)).toEqual(unknown)
    await expect(current.manager.nativeCommand(actor, binding.conversationId, command(observed, 'native:new:while-unknown', queueAction(observed)), () => {})).rejects.toThrow('idle reconciled')
    await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    await runtime.coordinator.waitForIdle()
    const recovered = current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId)
    expect(recovered.state).toBe('succeeded'); expect(recovered.result?.beforeHead).toEqual(request.expectedHead)
    expect(apply).toHaveBeenCalledTimes(1); expect(current.model.getCallCount()).toBe(0)
    expect(readFileSync(runtime.worker.verifiedFile!)).toEqual(bytes)
    expect(runtime.coordinator.nativeBlocked).toBe(false)
  }, 30000)

  it('serves cold verified history and terminal operation receipts without opening a runtime or contacting a model', async () => {
    const f = fixture(), first = await f.open(f.first), binding = first.manager.create(actor, 'create:native-controls:cold').binding
    const empty = await first.manager.history(actor, binding.conversationId).page(actor)
    expect(empty).toMatchObject({ checkpoint: null, messages: [], nextCursor: null })
    expect(Reflect.get(first.manager, 'active').size).toBe(0)
    const view = await first.manager.nativeInspect(actor, binding.conversationId), runtime = await first.manager.get(actor, binding.conversationId), request = command(view, 'native:cold:original', queueAction(view))
    const accepted = await first.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    await runtime.coordinator.waitForIdle()
    const operation = first.manager.nativeOperation(actor, binding.conversationId, accepted.operationId)
    expect(operation.state).toBe('succeeded')
    runtime.coordinator.submit(question(binding.conversationId)); await runtime.coordinator.waitForIdle()
    const originalPage = await first.manager.history(actor, binding.conversationId).page(actor), bytes = readFileSync(runtime.worker.verifiedFile!)
    await first.close()
    const secondStores = f.stores(), second = await f.open(secondStores, ['Must remain unused']), get = vi.spyOn(second.manager, 'get')
    expect(await second.manager.history(actor, binding.conversationId).page(actor)).toEqual(originalPage)
    expect(await second.manager.nativeCommand(actor, binding.conversationId, request, () => {})).toEqual(operation)
    expect(second.manager.nativeOperation(actor, binding.conversationId, operation.operationId)).toEqual(operation)
    expect(get).not.toHaveBeenCalled(); expect(second.model.getCallCount()).toBe(0); expect(Reflect.get(second.manager, 'active').size).toBe(0)
    const catalog = secondStores.catalog.inspect(binding)!
    expect(catalog.active).toBe(false)
    expect(readFileSync(join(f.root, 'runtimes', binding.runtimeSessionId, 'sessions', catalog.filename!))).toEqual(bytes)
  }, 30000)
})
