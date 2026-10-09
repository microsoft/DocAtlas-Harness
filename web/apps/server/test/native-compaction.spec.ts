import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductNativeCommand, ProductNativeInspection } from '@docatlas/contracts'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import type { WorkerPeer } from '@docatlas/runtime-pi/worker'
import { ControlStore, ResourceStore, RuntimeCatalog, RuntimeManager, prepareDocumentFree } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:manual-compact', workspaceId: 'workspace:manual-compact' }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture(extension?: (work: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-compact-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const work = join(root, 'work'), agent = join(root, 'agent')
  mkdirSync(work); mkdirSync(agent)
  if (extension) { mkdirSync(join(agent, 'extensions')); writeFileSync(join(agent, 'extensions', 'compact.ts'), extension(work)) }
  const stores = () => ({ control: ControlStore.open(join(root, 'control')), catalog: new RuntimeCatalog(join(root, 'catalog')), resources: new ResourceStore(join(root, 'resources')) })
  const first = stores(), captured = first.resources.capture(agent), approval = first.resources.approve(actor, captured.snapshotId, captured.manifestHash)
  const open = async (values: ReturnType<typeof stores>) => {
    const policy = vi.fn((input: { context: unknown }) => ({ context: input.context }))
    const model = await createPiTestModel({ modelLimits: { contextWindow: 1000000, maxTokens: 32768 }, tokenSize: 8192,
      answers: ['First actual answer: ' + 'A'.repeat(90000), 'Second actual answer: ' + 'B'.repeat(90000), ...Array.from({ length: 12 }, () => 'Native summary or next genuine answer')] })
    const manager = new RuntimeManager({ ...values, ...model, actor, approvalId: approval.approvalId, workspaceRoot: work, stateRoot: join(root, 'runtimes'),
      rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()),
      services: () => ({ prepare: prepareDocumentFree, modelPolicy: { prepare(input) { policy(input); return { context: input.context } } } }) })
    let closed = false
    const close = async () => { if (closed) return; closed = true; await manager.close(); values.catalog.close(); values.resources.close(); values.control.close() }
    cleanup.push(close)
    return { manager, model, policy, close }
  }
  return { root, work, first, stores, open }
}
function command(view: ProductNativeInspection, key = 'native:manual-compact:original'): ProductNativeCommand {
  if (!view.state) throw new Error('An idle verified head is required')
  return { schemaVersion: 1, kind: 'native-command', conversationId: view.binding.conversationId, expectedBindingId: view.binding.bindingId,
    expectedGeneration: view.binding.generation, runtimeSessionId: view.binding.runtimeSessionId, approvalId: view.resource.approvalId,
    expectedApprovalVersion: view.resource.version, expectedHead: view.state.head, idempotencyKey: key,
    action: { kind: 'compact', instructions: 'Preserve source references and unresolved decisions' } }
}
const question = (conversationId: string, key: string) => ({ schemaVersion: 1 as const, kind: 'submission' as const, conversationId,
  expectedGeneration: 1, idempotencyKey: key, mode: 'prompt' as const, text: 'An explicit human document research question', sourceRefs: [], selectionContextIds: [] })
async function seed(current: Awaited<ReturnType<ReturnType<typeof fixture>['open']>>, conversationId: string) {
  const runtime = await current.manager.get(actor, conversationId)
  for (const key of ['question:compact:seed-one', 'question:compact:seed-two']) {
    runtime.coordinator.submit(question(conversationId, key)); await runtime.coordinator.waitForIdle()
    expect(runtime.observations.snapshot(actor).history.checkpoint).not.toBeNull()
  }
  expect(current.model.getCallCount()).toBe(2)
  const view = await current.manager.nativeInspect(actor, conversationId)
  expect(view.state?.compaction?.canCompact).toBe(true)
  return { runtime, view }
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('manual compact through real isolated Pi and product receipts', () => {
  it('fails empty preflight without a native intent and compacts genuine history without republishing an Answer or invoking presentation policy', async () => {
    const f = fixture(), current = await f.open(f.first), binding = current.manager.create(actor, 'create:compact:actual').binding
    const initial = await current.manager.nativeInspect(actor, binding.conversationId), runtime = await current.manager.get(actor, binding.conversationId)
    expect(initial.state?.compaction).toEqual({ canCompact: false })
    const emptyBytes = readFileSync(runtime.worker.verifiedFile!), apply = vi.spyOn(runtime.worker, 'nativeApply')
    const denied = await current.manager.nativeCommand(actor, binding.conversationId, command(initial, 'native:compact:empty'), () => {})
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, denied.operationId)).toMatchObject({ state: 'failed', errorCode: 'invalid-action' })
    expect(apply).not.toHaveBeenCalled(); expect(readFileSync(runtime.worker.verifiedFile!)).toEqual(emptyBytes)
    const { view } = await seed(current, binding.conversationId), before = readFileSync(runtime.worker.verifiedFile!), history = runtime.observations.snapshot(actor).history
    const request = command(view), accepted = await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    await runtime.coordinator.waitForIdle()
    const completed = current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId), proof = completed.result?.compaction
    expect(completed).toMatchObject({ state: 'succeeded', generation: binding.generation, runtimeSessionId: binding.runtimeSessionId })
    expect(proof).toBeDefined(); expect(current.model.getCallCount()).toBeGreaterThan(2); expect(current.policy).toHaveBeenCalledTimes(2)
    const bytes = readFileSync(runtime.worker.verifiedFile!), entries = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    const compact = entries.find(entry => entry.id === proof!.entryId)
    expect(compact.type).toBe('compaction'); expect(hash(compact.summary)).toBe(proof!.summaryHash)
    expect(bytes.subarray(0, before.length)).toEqual(before)
    expect(runtime.observations.snapshot(actor).history).toEqual(history)
    expect(f.first.control.binding(actor, binding.conversationId)).toEqual(binding)
    expect(await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})).toEqual(completed)
    expect(readFileSync(runtime.worker.verifiedFile!)).toEqual(bytes)
    const calls = current.model.getCallCount(), next = runtime.coordinator.submit(question(binding.conversationId, 'question:compact:next')).receipt
    await runtime.coordinator.waitForIdle()
    expect(f.first.control.get(actor, next.submissionId).state).toBe('completed')
    expect(current.model.getCallCount()).toBe(calls + 1); expect(current.policy).toHaveBeenCalledTimes(3)
    expect(runtime.coordinator.nativeBlocked).toBe(false)
  }, 30000)

  it('keeps cancelled compaction behind actual native process join, proves non-application, and permits the next explicit question', async () => {
    const f = fixture(work => `export default function(pi){pi.on('session_before_compact',async()=>{await pi.exec(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:${JSON.stringify(work)}});return {cancel:true}})}`)
    const current = await f.open(f.first), binding = current.manager.create(actor, 'create:compact:cancel').binding, { runtime, view } = await seed(current, binding.conversationId)
    const join = Promise.withResolvers<void>(), originalAbort = runtime.native.abortAll.bind(runtime.native)
    const abort = vi.spyOn(runtime.native, 'abortAll').mockImplementation(async () => { await join.promise; await originalAbort() })
    const accepted = await current.manager.nativeCommand(actor, binding.conversationId, command(view), () => {})
    let stopped = false
    let stopping: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(runtime.native.activeCount).toBeGreaterThan(0))
      stopping = runtime.coordinator.cancel().then(() => { stopped = true })
      await vi.waitFor(() => expect(abort).toHaveBeenCalled())
      expect(stopped).toBe(false); expect(runtime.native.activeCount).toBeGreaterThan(0)
      expect(() => runtime.coordinator.submit(question(binding.conversationId, 'question:compact:during-stop'))).toThrow()
      await expect(current.manager.nativeCommand(actor, binding.conversationId, command(view, 'native:compact:during-stop'), () => {})).rejects.toThrow()
      join.resolve(); await stopping; await runtime.coordinator.waitForIdle()
    } finally { join.resolve(); await stopping }
    const failed = current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId)
    expect(failed).toMatchObject({ state: 'failed', result: null, failureProof: { reason: 'cancelled' }, errorCode: 'execution-interrupted' })
    expect(runtime.native.activeCount).toBe(0); expect(runtime.coordinator.nativeBlocked).toBe(false)
    expect(current.model.getCallCount()).toBe(2)
    const next = runtime.coordinator.submit(question(binding.conversationId, 'question:compact:after-stop')).receipt
    await runtime.coordinator.waitForIdle()
    expect(f.first.control.get(actor, next.submissionId).state).toBe('completed')
    expect(current.model.getCallCount()).toBe(3)
  }, 30000)

  it('does not settle a rejected compact until an unawaited approved hook native effect actually joins', async () => {
    const f = fixture(work => `export default function(pi){pi.on('session_before_compact',()=>{void pi.exec(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync('joined.txt','yes'),300)`)}],{cwd:${JSON.stringify(work)}}).then(()=>pi.exec(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync('late-effect.txt','must not execute')`)}],{cwd:${JSON.stringify(work)}})).catch(async()=>{(await import('node:fs')).writeFileSync(${JSON.stringify(join(work, 'late-denied.txt'))},'denied')});return {cancel:true}})}`)
    const current = await f.open(f.first), binding = current.manager.create(actor, 'create:compact:hook-join').binding, { runtime, view } = await seed(current, binding.conversationId)
    const accepted = await current.manager.nativeCommand(actor, binding.conversationId, command(view), () => {})
    await vi.waitFor(() => expect(runtime.native.activeCount).toBeGreaterThan(0))
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('applying')
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId)).toMatchObject({ state: 'failed', failureProof: { reason: 'sdk-rejected' } })
    expect(runtime.native.activeCount).toBe(0); expect(readFileSync(join(f.work, 'joined.txt'), 'utf8')).toBe('yes')
    await vi.waitFor(() => expect(existsSync(join(f.work, 'late-denied.txt'))).toBe(true))
    expect(existsSync(join(f.work, 'late-effect.txt'))).toBe(false)
    expect(current.model.getCallCount()).toBe(2)
  }, 30000)

  it('recovers a lost non-application reply cold using metadata only, without another worker factory, model or compact execution', async () => {
    const f = fixture(work => {
      const script = `const fs=require('node:fs');const p='factory.txt';let n=0;try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));`
      return `export default async function(pi){await pi.exec(process.execPath,['-e',${JSON.stringify(script)}],{cwd:${JSON.stringify(work)}});pi.on('session_before_compact',()=>({cancel:true}))}`
    })
    const first = await f.open(f.first), binding = first.manager.create(actor, 'create:compact:cold-failure').binding, { runtime, view } = await seed(first, binding.conversationId)
    const original = runtime.worker.nativeApply.bind(runtime.worker)
    const apply = vi.spyOn(runtime.worker, 'nativeApply').mockImplementationOnce(async (...args) => {
      const result = await original(...args); expect(result.status).toBe('not-applied'); throw new Error('Injected reply loss after joined non-application')
    })
    const request = command(view), accepted = await first.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    await runtime.coordinator.waitForIdle()
    expect(first.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('outcome-unknown')
    expect(apply).toHaveBeenCalledTimes(1)
    const file = runtime.worker.verifiedFile!, bytes = readFileSync(file), history = runtime.observations.snapshot(actor).history
    await first.close()
    const stores = f.stores(), second = await f.open(stores)
    expect(await second.manager.nativeInspect(actor, binding.conversationId)).toMatchObject({ state: null, busy: true })
    await expect(second.manager.get(actor, binding.conversationId)).rejects.toMatchObject({ code: 'recovery-required' })
    expect((await second.manager.observations(actor, binding.conversationId)).snapshot(actor).history).toEqual(history)
    const recovered = await second.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    expect(recovered).toMatchObject({ state: 'failed', result: null, failureProof: { reason: 'sdk-rejected' } })
    expect(Reflect.get(second.manager, 'active').size).toBe(0); expect(second.model.getCallCount()).toBe(0)
    expect(stores.control.writerInfo(actor, binding.conversationId)).toBeNull(); expect(stores.catalog.inspect(binding)?.active).toBe(false)
    expect(readFileSync(file)).toEqual(bytes); expect(readFileSync(join(f.work, 'factory.txt'), 'utf8')).toBe('1')
    expect(await second.manager.nativeCommand(actor, binding.conversationId, request, () => {})).toEqual(recovered)
    const running = await second.manager.get(actor, binding.conversationId), next = running.coordinator.submit(question(binding.conversationId, 'question:compact:after-cold-recovery')).receipt
    await running.coordinator.waitForIdle()
    expect(stores.control.get(actor, next.submissionId).state).toBe('completed')
    expect(readFileSync(join(f.work, 'factory.txt'), 'utf8')).toBe('2'); expect(second.model.getCallCount()).toBe(1)
  }, 30000)

  it('does not publish a lost compact IPC outcome or permit proof recovery before its already-admitted native effect joins', async () => {
    const f = fixture(work => `export default function(pi){pi.on('session_before_compact',()=>{void pi.exec(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync('lost-reply-joined.txt','yes'),500)`)}],{cwd:${JSON.stringify(work)}}).catch(()=>{});return {cancel:true}})}`)
    const current = await f.open(f.first), binding = current.manager.create(actor, 'create:compact:lost-in-flight').binding, { runtime, view } = await seed(current, binding.conversationId)
    const peer = Reflect.get(runtime.worker, 'peer') as WorkerPeer, original = peer.call.bind(peer), lost = Promise.withResolvers<void>()
    let dispatches = 0
    vi.spyOn(peer, 'call').mockImplementation(async (method, value, options) => {
      const result = await original(method, value, options)
      if (method === 'runtime.nativeApply') { dispatches++; lost.resolve(); throw new Error('Injected post-terminal IPC loss with native effect still alive') }
      return result
    })
    const request = command(view), accepted = await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    await lost.promise
    expect(runtime.native.activeCount).toBeGreaterThan(0)
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('applying')
    expect((await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})).state).toBe('applying')
    await runtime.coordinator.waitForIdle()
    expect(runtime.native.activeCount).toBe(0); expect(readFileSync(join(f.work, 'lost-reply-joined.txt'), 'utf8')).toBe('yes')
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('outcome-unknown')
    await current.manager.nativeCommand(actor, binding.conversationId, request, () => {}); await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId)).toMatchObject({ state: 'failed', failureProof: { reason: 'sdk-rejected' } })
    expect(dispatches).toBe(1); expect(runtime.coordinator.nativeBlocked).toBe(false)
    const next = runtime.coordinator.submit(question(binding.conversationId, 'question:compact:after-lost-in-flight')).receipt
    await runtime.coordinator.waitForIdle(); expect(f.first.control.get(actor, next.submissionId).state).toBe('completed')
    expect(current.model.getCallCount()).toBe(3)
  }, 30000)

  it('keeps a closed-IPC compact applying until the actual worker namespace join acknowledgement, before allowing original-key proof recovery', async () => {
    const f = fixture(() => `export default function(pi){pi.on('session_before_compact',()=>({cancel:true}))}`)
    const current = await f.open(f.first), binding = current.manager.create(actor, 'create:compact:closed-pipe').binding, { runtime, view } = await seed(current, binding.conversationId)
    const peer = Reflect.get(runtime.worker, 'peer') as WorkerPeer, original = peer.call.bind(peer), lost = Promise.withResolvers<void>()
    const actualExited = Reflect.get(runtime.worker, 'exited') as Promise<void>, acknowledge = Promise.withResolvers<void>()
    // Retain the real SandboxProcess join; hold only its acknowledgement so the
    // regression cannot pass due to scheduler timing or a quick monitor exit.
    Reflect.set(runtime.worker, 'exited', actualExited.then(() => acknowledge.promise))
    vi.spyOn(peer, 'call').mockImplementation(async (method, value, options) => {
      const result = await original(method, value, options)
      if (method === 'runtime.nativeApply') {
        peer.close(new Error('Injected closed pipe after actual compact rejection'))
        lost.resolve(); throw new Error('Closed IPC result unavailable')
      }
      return result
    })
    const request = command(view), accepted = await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})
    try {
      await lost.promise; await actualExited
      expect(peer.closed).toBe(true)
      expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('applying')
      expect((await current.manager.nativeCommand(actor, binding.conversationId, request, () => {})).state).toBe('applying')
    } finally { acknowledge.resolve() }
    await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId).state).toBe('outcome-unknown')
    await current.manager.nativeCommand(actor, binding.conversationId, request, () => {}); await runtime.coordinator.waitForIdle()
    expect(current.manager.nativeOperation(actor, binding.conversationId, accepted.operationId)).toMatchObject({ state: 'failed', failureProof: { reason: 'sdk-rejected' } })
    expect(current.model.getCallCount()).toBe(2)
  }, 30000)
})
