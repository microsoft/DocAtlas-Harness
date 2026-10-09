import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeControlApply, NativeControlOutcome, NativeRuntimeState, ProductNativeCommand } from '@docatlas/contracts'
import type { ProductRuntimeDriver } from '@docatlas/runtime-pi'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import type { IsolatedPiWorker } from '../src/execution/pi-worker.js'
import { ConversationNativeControls } from '../src/runs/native-controls.js'
import { prepareDocumentFree, SubmissionCoordinator } from '../src/runs/submission-coordinator.js'
import { ControlStore } from '../src/storage/control-store.js'
import { NativeOperationStore } from '../src/storage/native-operation-store.js'
import { ResourceStore } from '../src/storage/resource-store.js'
import { RuntimeCatalog } from '../src/storage/runtime-catalog.js'
import { RuntimeManager } from '../src/runs/runtime-manager.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:native-review', workspaceId: 'workspace:native-review' }, conversationId = 'conversation:native-review'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-review-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let now = Date.parse('2026-09-10T00:00:00.000Z')
  const control = ControlStore.open(join(root, 'control'), () => now); cleanup.push(() => control.close())
  const binding = control.createConversation(actor, { conversationId, runtimeSessionId: 'session:native-review' })
  const operations = NativeOperationStore.open(control, () => now); cleanup.push(() => operations.close())
  const resources = new ResourceStore(join(root, 'resources')); cleanup.push(() => resources.close())
  const agent = join(root, 'agent'); mkdirSync(agent)
  const snapshot = resources.capture(agent), approval = resources.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
  const state: NativeRuntimeState = { head: { version: 1, sessionId: binding.runtimeSessionId, transcriptHash: hash('original native prefix'), byteLength: 100, entryCount: 1, leafEntryId: 'entry:initial' },
    configuration: { model: { provider: 'faux', id: 'not-executed' }, thinkingLevel: 'off', steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' },
    models: [], thinkingLevels: ['off'], busy: false, nativeQueue: { steering: 0, followUp: 0 }, compaction: { canCompact: true } }
  const stop = vi.fn(async () => {}), resume = vi.fn(), submit = vi.fn(async () => { throw new Error('A model must not execute in this lifecycle test') })
  const nativeApply = vi.fn(async (input: NativeControlApply): Promise<NativeControlOutcome> => ({ status: 'applied', proof: { operationId: input.operationId, requestHash: input.requestHash, action: input.action,
    beforeHead: input.expectedHead, afterHead: { ...input.expectedHead, byteLength: 300, entryCount: 3, transcriptHash: hash('committed prefix'), leafEntryId: 'entry:committed' },
    intentEntryId: 'entry:intent', markerEntryId: 'entry:committed', configuration: { ...state.configuration, steeringMode: 'all' } } }))
  const worker = { sessionId: binding.runtimeSessionId, busy: false, stop, resume, submit, nativeApply, nativeInspect: vi.fn(async () => structuredClone(state)) }
  const coordinator = new SubmissionCoordinator(control, actor, conversationId, worker as unknown as ProductRuntimeDriver, prepareDocumentFree)
  cleanup.push(async () => { await coordinator.close().catch(() => {}) })
  const controls = new ConversationNativeControls({ control, operations, resources, approvalId: approval.approvalId, actor, binding, coordinator, worker: worker as unknown as IsolatedPiWorker, models: [] })
  const request = (key: string): ProductNativeCommand => ({ schemaVersion: 1, kind: 'native-command', conversationId, expectedBindingId: binding.bindingId, expectedGeneration: binding.generation,
    runtimeSessionId: binding.runtimeSessionId, approvalId: approval.approvalId, expectedApprovalVersion: approval.version, expectedHead: state.head,
    idempotencyKey: key, action: { kind: 'set-queue-mode', queue: 'steering', mode: 'all' } })
  return { control, operations, coordinator, controls, request, worker, advance: (ms: number) => { now += ms } }
}

describe('review regressions at the native acceptance, dispatch and actual join boundary', () => {
  it('settles a known pre-dispatch compact Stop after applying COMMIT without fabricating a native failure proof or unknown barrier', async () => {
    const f = fixture(), original = f.operations.transition.bind(f.operations)
    let stopping: Promise<void> | undefined
    vi.spyOn(f.operations, 'transition').mockImplementation((...args) => {
      const receipt = original(...args)
      if (args[4] === 'applying' && !stopping) stopping = f.coordinator.cancel()
      return receipt
    })
    const request = { ...f.request('native:review:compact-stop-after-commit'), action: { kind: 'compact' as const, instructions: '' } }
    const accepted = f.controls.command(actor, request)
    await f.coordinator.waitForIdle(); await stopping
    expect(f.operations.get(actor, conversationId, accepted.operationId)).toMatchObject({ state: 'failed', errorCode: 'execution-interrupted', result: null })
    expect(f.operations.get(actor, conversationId, accepted.operationId)).not.toHaveProperty('failureProof')
    expect(f.worker.nativeApply).not.toHaveBeenCalled(); expect(f.coordinator.nativeBlocked).toBe(false)
    const next = f.controls.command(actor, f.request('native:review:after-predispatch-stop'))
    await f.coordinator.waitForIdle()
    expect(f.operations.get(actor, conversationId, next.operationId).state).toBe('succeeded')
  })

  it('cannot resume or accept another operation while cancellation still awaits the real stop join', async () => {
    const f = fixture(), joined = Promise.withResolvers<void>()
    f.worker.stop.mockImplementationOnce(async () => joined.promise)
    const accepted = f.controls.command(actor, f.request('native:review:cancel-before-dispatch'))
    const stopping = f.coordinator.cancel()
    try {
      await vi.waitFor(() => expect(f.operations.get(actor, conversationId, accepted.operationId).state).toBe('failed'))
      await Promise.resolve()
      expect(() => f.controls.command(actor, f.request('native:review:must-wait-for-join'))).toThrow()
      expect(() => f.coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: 1, idempotencyKey: 'question:during-native-stop', mode: 'prompt',
        text: 'Must not revive stopped effects before join', sourceRefs: [], selectionContextIds: [] })).toThrow()
      expect(f.worker.resume).not.toHaveBeenCalled(); expect(f.worker.nativeApply).not.toHaveBeenCalled(); expect(f.worker.submit).not.toHaveBeenCalled()
    } finally { joined.resolve(); await stopping }
  })

  it('revalidates writer after an applying COMMIT that outlasted the lease, before native setter dispatch', async () => {
    const f = fixture(), original = f.operations.transition.bind(f.operations)
    vi.spyOn(f.operations, 'transition').mockImplementation((...args) => {
      const receipt = original(...args)
      // Deterministic fault injection for a synchronous FULL COMMIT that blocks heartbeat
      // until after the previously checked writer expires. The applying row really committed.
      if (args[4] === 'applying') f.advance(30001)
      return receipt
    })
    const accepted = f.controls.command(actor, f.request('native:review:lease-expires-at-commit'))
    await f.coordinator.waitForIdle().catch(() => {})
    expect(f.operations.get(actor, conversationId, accepted.operationId).state).toBe('applying')
    expect(f.worker.nativeApply).not.toHaveBeenCalled()
    expect(f.worker.stop).toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('does not run approved extension startup effects before a cold unknown native barrier is established', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docatlas-native-startup-review-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const work = join(root, 'work'), agent = join(root, 'agent'), counter = join(work, 'factory-count.txt')
    mkdirSync(work); mkdirSync(join(agent, 'extensions'), { recursive: true })
    const script = `const fs=require('node:fs');const p=${JSON.stringify(counter)};let n=0;try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));`
    writeFileSync(join(agent, 'extensions', 'startup.ts'), `export default async function(pi){const result=await pi.exec(process.execPath,['-e',${JSON.stringify(script)}],{cwd:${JSON.stringify(work)}});if(result.code!==0)throw new Error('Factory counter failed')}`)
    const stores = () => ({ control: ControlStore.open(join(root, 'control')), catalog: new RuntimeCatalog(join(root, 'catalog')), resources: new ResourceStore(join(root, 'resources')) })
    const firstStores = stores(), captured = firstStores.resources.capture(agent), approval = firstStores.resources.approve(actor, captured.snapshotId, captured.manifestHash)
    const open = async (values: ReturnType<typeof stores>) => {
      const model = await createPiTestModel({ answers: ['Historical verified native answer'] })
      const manager = new RuntimeManager({ ...values, ...model, actor, approvalId: approval.approvalId, workspaceRoot: work, stateRoot: join(root, 'runtimes'),
        rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()) })
      let closed = false
      const close = async () => { if (closed) return; closed = true; await manager.close(); values.catalog.close(); values.resources.close(); values.control.close() }
      cleanup.push(close)
      return { manager, model, close }
    }
    const first = await open(firstStores), binding = first.manager.create(actor, 'create:unknown:factory-review').binding
    await first.manager.nativeInspect(actor, binding.conversationId)
    const runtime = await first.manager.get(actor, binding.conversationId)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    runtime.coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation,
      idempotencyKey: 'question:native-startup-review', mode: 'prompt', text: 'Historical human question', sourceRefs: [], selectionContextIds: [] })
    await runtime.coordinator.waitForIdle()
    const view = await first.manager.nativeInspect(actor, binding.conversationId)
    const original = runtime.worker.nativeApply.bind(runtime.worker)
    vi.spyOn(runtime.worker, 'nativeApply').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('lost post-commit reply') })
    const request: ProductNativeCommand = { schemaVersion: 1, kind: 'native-command', conversationId: binding.conversationId, expectedBindingId: binding.bindingId,
      expectedGeneration: binding.generation, runtimeSessionId: binding.runtimeSessionId, approvalId: approval.approvalId, expectedApprovalVersion: approval.version,
      expectedHead: view.state!.head, idempotencyKey: 'native:unknown:factory-review', action: { kind: 'set-queue-mode', queue: 'steering', mode: 'all' } }
    const accepted = await first.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    await runtime.coordinator.waitForIdle()
    expect(first.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('outcome-unknown')
    await first.close()
    const secondStores = stores(), second = await open(secondStores)
    const blocked = await second.manager.nativeInspect(actor, binding.conversationId)
    expect(blocked).toMatchObject({ state: null, busy: true })
    await expect(second.manager.get(actor, binding.conversationId)).rejects.toMatchObject({ code: 'recovery-required' })
    const observations = await second.manager.observations(actor, binding.conversationId), closed = vi.fn()
    observations.subscribe(actor, undefined, () => {}, closed)
    const historical = observations.snapshot(actor).history
    expect(historical.checkpoint).not.toBeNull()
    expect(historical.messages.map(message => message.text)).toEqual(['Historical human question', 'Historical verified native answer'])
    expect(second.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('outcome-unknown')
    expect(second.model.getCallCount()).toBe(0)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    const nativeBytes = readFileSync(join(root, 'runtimes', binding.runtimeSessionId, 'sessions', secondStores.catalog.inspect(binding)!.filename!))
    const recovered = await second.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    expect(recovered.state).toBe('succeeded')
    expect(Reflect.get(second.manager, 'active').size).toBe(0)
    expect(secondStores.control.writerInfo(actor, binding.conversationId)).toBeNull()
    expect(secondStores.catalog.inspect(binding)!.active).toBe(false)
    expect(await second.manager.observations(actor, binding.conversationId)).toBe(observations)
    expect(observations.snapshot(actor).history).toEqual(historical)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    expect(readFileSync(join(root, 'runtimes', binding.runtimeSessionId, 'sessions', secondStores.catalog.inspect(binding)!.filename!))).toEqual(nativeBytes)
    // A later explicit inspection may start the now-reconciled SDK. Pin its actual
    // fresh head: startup metadata need not equal the older immutable proof prefix.
    const fresh = await second.manager.nativeInspect(actor, binding.conversationId)
    const nextRequest = { ...request, idempotencyKey: 'native:after:cold-recovery', expectedHead: fresh.state!.head,
      action: { kind: 'set-queue-mode' as const, queue: 'steering' as const, mode: 'one-at-a-time' as const } }
    const next = await second.manager.nativeCommand(actor, binding.conversationId, nextRequest, () => {})
    const running = await second.manager.get(actor, binding.conversationId); await running.coordinator.waitForIdle()
    expect(second.manager.nativeOperation(actor, binding.conversationId, next.operationId).state).toBe('succeeded')
    expect(readFileSync(counter, 'utf8')).toBe('2')
    expect(closed).toHaveBeenCalledOnce()
    expect(() => observations.snapshot(actor)).toThrow('unavailable')
    expect(second.model.getCallCount()).toBe(0)
  }, 30000)
})
