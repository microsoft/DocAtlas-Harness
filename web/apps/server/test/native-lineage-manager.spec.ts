import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeLineageAction, ProductBinding, ProductLineageCommand, ProductLineageInspection } from '@docatlas/contracts'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { ControlStore, ResourceStore, RuntimeCatalog, RuntimeManager } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:lineage-manager', workspaceId: 'workspace:lineage-manager' }
function fixture(extension?: (work: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-lineage-manager-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const work = join(root, 'work'), agent = join(root, 'agent')
  mkdirSync(work); mkdirSync(agent)
  if (extension) { mkdirSync(join(agent, 'extensions')); writeFileSync(join(agent, 'extensions', 'lineage.ts'), extension(work)) }
  const stores = () => ({ control: ControlStore.open(join(root, 'control')), catalog: new RuntimeCatalog(join(root, 'catalog')), resources: new ResourceStore(join(root, 'resources')) })
  const first = stores(), snapshot = first.resources.capture(agent), approval = first.resources.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
  const open = async (values: ReturnType<typeof stores>) => {
    const contexts: string[] = [], model = await createPiTestModel({ answers: ['First verified answer about revenue', 'Second verified answer about obligations',
      'Fresh branch answer', 'Fourth genuine answer'], inspectMessages: messages => { contexts.push(JSON.stringify(messages)) } })
    const manager = new RuntimeManager({ ...values, ...model, actor, approvalId: approval.approvalId, workspaceRoot: work, stateRoot: join(root, 'runtimes'),
      rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()) })
    let closed = false
    const close = async () => { if (closed) return; closed = true; await manager.close(); values.catalog.close(); values.resources.close(); values.control.close() }
    cleanup.push(close)
    return { manager, model, contexts, close }
  }
  const inspect = (run: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(root, 'catalog', 'runtime-catalog.sqlite3')); try { run(db) } finally { db.close() } }
  return { root, work, first, stores, open, inspect }
}
function command(view: ProductLineageInspection, action: NativeLineageAction, key = 'lineage:manager:original'): ProductLineageCommand {
  if (!view.head) throw new Error('Expected an idle selected native head')
  return { schemaVersion: 1, kind: 'lineage-command', conversationId: view.binding.conversationId, expectedBindingId: view.binding.bindingId,
    expectedGeneration: view.binding.generation, runtimeSessionId: view.binding.runtimeSessionId, approvalId: view.resource.approvalId,
    expectedApprovalVersion: view.resource.version, expectedHead: view.head, action, idempotencyKey: key }
}
const question = (conversationId: string, key: string, generation = 1) => ({ schemaVersion: 1 as const, kind: 'submission' as const, conversationId,
  expectedGeneration: generation, idempotencyKey: key, mode: 'prompt' as const, text: `Original human question ${key}`, sourceRefs: [], selectionContextIds: [] })
type Current = Awaited<ReturnType<ReturnType<typeof fixture>['open']>>
async function seed(current: Current, key: string, before?: (binding: ProductBinding, runtime: Awaited<ReturnType<RuntimeManager['get']>>) => Promise<void>) {
  const binding = current.manager.create(actor, key).binding, runtime = await current.manager.get(actor, binding.conversationId)
  await before?.(binding, runtime)
  for (const key of ['question:lineage:first', 'question:lineage:second']) {
    runtime.coordinator.submit(question(binding.conversationId, key)); await runtime.coordinator.waitForIdle()
  }
  expect(current.model.getCallCount()).toBe(2)
  const file = runtime.worker.verifiedFile!, snapshot = await runtime.worker.snapshot() as { entries: Array<{ id: string, message?: { role: string } }> }
  const users = snapshot.entries.filter(entry => entry.message?.role === 'user'), assistants = snapshot.entries.filter(entry => entry.message?.role === 'assistant')
  expect(users).toHaveLength(2); expect(assistants).toHaveLength(2)
  return { binding, runtime, file, users, assistants, view: await current.manager.lineageInspect(actor, binding.conversationId) }
}
async function settled(current: Current, conversationId: string, operationId: string) {
  await (Reflect.get(current.manager, 'lineageTasks') as Map<string, Promise<void>>).get(conversationId)
  return current.manager.lineageOperation(actor, conversationId, operationId)
}
const navigate = (targetEntryId: string): NativeLineageAction => ({ kind: 'navigate', targetEntryId, summarize: false, instructions: '', replaceInstructions: false, label: null })

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('native lineage through actual isolated Pi and product lifecycle', () => {
  it('navigates on the same native file, joins and replaces the writer/generation, preserves all original bytes, and continues only the selected native context', async () => {
    const f = fixture(), current = await f.open(f.first), seeded = await seed(current, 'create:lineage:navigate'), { binding, runtime, file, view, assistants } = seeded
    const bytes = readFileSync(file), originalCheckpoint = f.first.control.latestCheckpoint(actor, binding.conversationId)!, oldEpoch = f.first.control.writerInfo(actor, binding.conversationId)!.epoch
    const request = command(view, navigate(assistants[0]!.id)), accepted = await current.manager.lineageCommand(actor, binding.conversationId, request, () => {})
    expect(accepted.state).toBe('accepted')
    expect(() => runtime.coordinator.submit(question(binding.conversationId, 'question:must-not-enter-old-generation'))).toThrow()
    const completed = await settled(current, binding.conversationId, accepted.operationId)
    expect(completed, JSON.stringify(completed)).toMatchObject({ state: 'succeeded', result: { proof: { kind: 'native-navigation-proof' } } })
    const target = completed.result!.targetBinding
    expect(target).toMatchObject({ conversationId: binding.conversationId, runtimeSessionId: binding.runtimeSessionId, generation: 2, version: 2 })
    expect(readFileSync(file).subarray(0, bytes.length)).toEqual(bytes)
    expect(f.first.control.get(actor, originalCheckpoint.submissionId).checkpoint).toEqual(originalCheckpoint)
    expect(() => runtime.observations.snapshot(actor)).toThrow()
    expect(f.first.control.writerInfo(actor, binding.conversationId)).toBeNull()
    expect(current.model.getCallCount()).toBe(2)
    expect(await current.manager.lineageCommand(actor, binding.conversationId, request, () => {})).toEqual(completed)
    const next = await current.manager.get(actor, binding.conversationId)
    expect(next).not.toBe(runtime); expect(f.first.control.writerInfo(actor, binding.conversationId)!.epoch).toBeGreaterThan(oldEpoch)
    expect(next.worker.verifiedFile).toBe(file)
    const submitted = next.coordinator.submit(question(binding.conversationId, 'question:lineage:new-branch', target.generation)).receipt
    await next.coordinator.waitForIdle()
    expect(f.first.control.get(actor, submitted.submissionId).state).toBe('completed')
    expect(current.contexts[2]).toContain('First verified answer about revenue')
    expect(current.contexts[2]).not.toContain('Second verified answer about obligations')
    expect(current.model.getCallCount()).toBe(3)
  }, 30000)

  it('forks a real SDK child into an exclusive new runtime, preserves the parent binding/file/queue, and restores the child’s native default queue without foreign markers', async () => {
    const f = fixture(), current = await f.open(f.first), { binding, file, users } = await seed(current, 'create:lineage:fork', async (binding, runtime) => {
      const native = await current.manager.nativeInspect(actor, binding.conversationId)
      await current.manager.nativeCommand(actor, binding.conversationId, { schemaVersion: 1, kind: 'native-command', conversationId: binding.conversationId,
        expectedBindingId: binding.bindingId, expectedGeneration: binding.generation, runtimeSessionId: binding.runtimeSessionId, approvalId: native.resource.approvalId,
        expectedApprovalVersion: native.resource.version, expectedHead: native.state!.head, idempotencyKey: 'native:queue:before-fork', action: { kind: 'set-queue-mode', queue: 'steering', mode: 'all' } }, () => {})
      await runtime.coordinator.waitForIdle()
    })
    const bytes = readFileSync(file), view = await current.manager.lineageInspect(actor, binding.conversationId)
    const accepted = await current.manager.lineageCommand(actor, binding.conversationId, command(view, { kind: 'fork', targetEntryId: users[1]!.id, position: 'before' }), () => {})
    const completed = await settled(current, binding.conversationId, accepted.operationId)
    expect(completed, JSON.stringify(completed)).toMatchObject({ state: 'succeeded', result: { proof: { kind: 'native-fork-proof' } } })
    const { targetBinding: child, proof } = completed.result!
    expect(child.conversationId).not.toBe(binding.conversationId); expect(child.runtimeSessionId).not.toBe(binding.runtimeSessionId)
    expect(child.generation).toBe(1); expect(f.first.control.binding(actor, binding.conversationId)).toEqual(binding)
    expect(readFileSync(file).subarray(0, bytes.length)).toEqual(bytes)
    expect(proof.sourceConfiguration.steeringMode).toBe('all'); expect(proof.configuration.steeringMode).toBe('one-at-a-time')
    const childFile = current.manager.lineageFile(actor, child.conversationId, child.bindingId)
    expect(JSON.parse(readFileSync(childFile, 'utf8').split('\n')[0]!).parentSession).toBe(file)
    expect(current.manager.lineageFile(actor, child.conversationId, binding.bindingId)).toBe(file)
    const childRuntime = await current.manager.get(actor, child.conversationId)
    expect((await current.manager.nativeInspect(actor, child.conversationId)).state!.configuration.steeringMode).toBe('one-at-a-time')
    const next = childRuntime.coordinator.submit(question(child.conversationId, 'question:lineage:child')).receipt
    await childRuntime.coordinator.waitForIdle()
    expect(f.first.control.get(actor, next.submissionId).state).toBe('completed')
    expect(current.contexts[2]).toContain('First verified answer about revenue'); expect(current.contexts[2]).not.toContain('Second verified answer about obligations')
    expect((await current.manager.nativeInspect(actor, binding.conversationId)).state!.configuration.steeringMode).toBe('all')
    expect(current.model.getCallCount()).toBe(3)
  }, 30000)

  it('leaves a lost fork reply joined and unknown, then reconciles the original key cold without another SDK/factory/model execution', async () => {
    const f = fixture(work => {
      const script = `const fs=require('node:fs');const p='factory-count.txt';let n=0;try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));`
      return `export default async function(pi){await pi.exec(process.execPath,['-e',${JSON.stringify(script)}],{cwd:${JSON.stringify(work)}})}`
    })
    const first = await f.open(f.first), { binding, runtime, users, view } = await seed(first, 'create:lineage:lost-fork')
    const original = runtime.worker.lineageApply.bind(runtime.worker)
    const apply = vi.spyOn(runtime.worker, 'lineageApply').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Injected lost real SDK fork reply') })
    const request = command(view, { kind: 'fork', targetEntryId: users[1]!.id, position: 'before' })
    const accepted = await first.manager.lineageCommand(actor, binding.conversationId, request, () => {})
    const unknown = await settled(first, binding.conversationId, accepted.operationId)
    expect(unknown).toMatchObject({ state: 'outcome-unknown', result: null })
    expect(apply).toHaveBeenCalledTimes(1); expect(f.first.control.writerInfo(actor, binding.conversationId)).toBeNull()
    const factories = readFileSync(join(f.work, 'factory-count.txt'), 'utf8')
    await first.close()
    const secondStores = f.stores(), second = await f.open(secondStores)
    expect(await second.manager.lineageInspect(actor, binding.conversationId)).toMatchObject({ head: null, busy: true })
    await expect(second.manager.get(actor, binding.conversationId)).rejects.toMatchObject({ code: 'recovery-required' })
    expect(second.manager.lineageOperation(actor, binding.conversationId, accepted.operationId)).toEqual(unknown)
    await second.manager.stop(actor, binding.conversationId)
    expect(second.manager.lineageOperation(actor, binding.conversationId, accepted.operationId)).toEqual(unknown)
    const recovered = await second.manager.lineageCommand(actor, binding.conversationId, request, () => {})
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ state: 'succeeded', result: { proof: { kind: 'native-fork-proof' } } })
    expect(Reflect.get(second.manager, 'active').size).toBe(0); expect(second.model.getCallCount()).toBe(0)
    expect(readFileSync(join(f.work, 'factory-count.txt'), 'utf8')).toBe(factories)
    expect(await second.manager.lineageCommand(actor, binding.conversationId, request, () => {})).toEqual(recovered)
  }, 30000)

  it('rolls navigation forward after an actual binding commit but failed Catalog acknowledgement, without changing the chosen generation twice', async () => {
    const f = fixture(), current = await f.open(f.first), { binding, assistants, view } = await seed(current, 'create:lineage:commit-window')
    f.inspect(db => db.exec("CREATE TRIGGER injected_lineage_commit BEFORE UPDATE ON lineage_handoffs WHEN NEW.phase='binding-committed' BEGIN SELECT RAISE(ABORT,'injected after-binding failure'); END"))
    const request = command(view, navigate(assistants[0]!.id)), accepted = await current.manager.lineageCommand(actor, binding.conversationId, request, () => {})
    const pending = await settled(current, binding.conversationId, accepted.operationId), target = f.first.control.binding(actor, binding.conversationId)
    expect(pending).toMatchObject({ state: 'handoff', result: null }); expect(target.generation).toBe(2)
    await expect(current.manager.get(actor, binding.conversationId)).rejects.toMatchObject({ code: 'recovery-required' })
    f.inspect(db => db.exec('DROP TRIGGER injected_lineage_commit'))
    const completed = await current.manager.lineageCommand(actor, binding.conversationId, request, () => {})
    expect(completed, JSON.stringify(completed)).toMatchObject({ state: 'succeeded', result: { targetBinding: target } })
    expect(f.first.control.binding(actor, binding.conversationId)).toEqual(target)
    expect(current.model.getCallCount()).toBe(2)
  }, 30000)

  it('waits for the real before-navigation hook on Stop, proves non-application, and admits a fresh question without rebinding', async () => {
    const f = fixture(work => `export default function(pi){pi.on('session_before_tree',async()=>{const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(join(work, 'hook-started'))},'yes');while(!fs.existsSync(${JSON.stringify(join(work, 'hook-release'))}))await new Promise(resolve=>setTimeout(resolve,20));return {cancel:true}})}`)
    const current = await f.open(f.first), { binding, runtime, assistants, view } = await seed(current, 'create:lineage:cancel')
    const accepted = await current.manager.lineageCommand(actor, binding.conversationId, command(view, navigate(assistants[0]!.id)), () => {})
    let stopped = false, stopping: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(existsSync(join(f.work, 'hook-started'))).toBe(true))
      stopping = current.manager.stop(actor, binding.conversationId).then(() => { stopped = true })
      await Promise.resolve()
      expect(stopped).toBe(false)
      expect(() => runtime.coordinator.submit(question(binding.conversationId, 'question:lineage:during-stop'))).toThrow()
    } finally { writeFileSync(join(f.work, 'hook-release'), 'yes'); await stopping }
    const result = await settled(current, binding.conversationId, accepted.operationId)
    expect(result, JSON.stringify(result)).toMatchObject({ state: 'failed', failureProof: { reason: 'cancelled' } })
    expect(f.first.control.binding(actor, binding.conversationId)).toEqual(binding)
    expect(current.model.getCallCount()).toBe(2)
    const receipt = runtime.coordinator.submit(question(binding.conversationId, 'question:lineage:after-stop')).receipt
    await runtime.coordinator.waitForIdle()
    expect(f.first.control.get(actor, receipt.submissionId).state).toBe('completed'); expect(current.model.getCallCount()).toBe(3)
  }, 30000)

  it('rejects missing targets and unsupported fork-before positions before dispatch, without freezing or closing the native runtime', async () => {
    const f = fixture(), current = await f.open(f.first), { binding, runtime, assistants, view, file } = await seed(current, 'create:lineage:invalid')
    const bytes = readFileSync(file), dispatch = vi.spyOn(runtime.worker, 'lineageApply')
    for (const [index, action] of [navigate('entry:not-in-native-file'), { kind: 'fork' as const, targetEntryId: assistants[0]!.id, position: 'before' as const }].entries()) {
      const accepted = await current.manager.lineageCommand(actor, binding.conversationId, command(view, action, `lineage:invalid:target:${index}`), () => {})
      expect(await settled(current, binding.conversationId, accepted.operationId)).toMatchObject({ state: 'failed', errorCode: 'invalid-action', result: null })
    }
    expect(dispatch).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(bytes)
    expect(await current.manager.get(actor, binding.conversationId)).toBe(runtime)
  }, 30000)

  it('does not start a cold worker for Stop and never clears an unowned claim as a termination guess', async () => {
    const f = fixture(), current = await f.open(f.first), binding = current.manager.create(actor, 'create:lineage:cold-stop').binding
    await current.manager.stop(actor, binding.conversationId)
    expect(Reflect.get(current.manager, 'active').size).toBe(0); expect(current.model.getCallCount()).toBe(0)
    expect(f.first.catalog.inspect(binding)).toBeUndefined()
    const claim = f.first.catalog.claim(binding)
    await expect(current.manager.stop(actor, binding.conversationId)).rejects.toMatchObject({ code: 'recovery-required' })
    f.first.catalog.assertClaim(claim)
    f.first.catalog.release(claim, null)
    await current.manager.stop(actor, binding.conversationId)
    expect(Reflect.get(current.manager, 'active').size).toBe(0)
  })
})
