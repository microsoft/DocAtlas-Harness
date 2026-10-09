import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeControlAction, NativeControlApply } from '@docatlas/contracts'
import { findNativeControlOutcome, inspectNativeSession } from '@docatlas/runtime-pi/worker'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { ControlStore, IsolatedPiWorker, LinuxExecutor, ResourceStore, SubmissionCoordinator, prepareDocumentFree } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const actor = { actorId: 'actor:native-controls', workspaceId: 'workspace:native-controls' }, conversationId = 'conversation:native-controls'

async function fixture(hook = false) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-controls-worker-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const work = join(root, 'work'), resourceSource = join(root, 'reviewed-agent'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions'), outputDir = join(root, 'output'), privateRoot = join(root, 'private')
  for (const path of [work, resourceSource, privateRoot]) mkdirSync(path)
  const secret = join(privateRoot, 'host-secret'), ready = join(work, 'control-hook-ready.json')
  writeFileSync(secret, 'PRIVATE_NATIVE_CONTROL_SENTINEL')
  if (hook) {
    mkdirSync(join(resourceSource, 'extensions'))
    const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({privateVisible:fs.existsSync(${JSON.stringify(secret)}),sessionVisible:fs.existsSync(${JSON.stringify(sessionDir)}),pid:process.pid}));setInterval(()=>{},1000)`
    writeFileSync(join(resourceSource, 'extensions', 'model-control.ts'), `export default function(pi){pi.on('model_select',async()=>{await pi.exec(process.execPath,['-e',${JSON.stringify(program)}],{cwd:${JSON.stringify(work)}})})}`)
  }
  const control = ControlStore.open(join(privateRoot, 'control')); cleanup.push(() => control.close())
  const binding = control.createConversation(actor, { conversationId, runtimeSessionId: randomUUID() })
  const resources = new ResourceStore(join(privateRoot, 'resources')); cleanup.push(() => resources.close())
  const captured = resources.capture(resourceSource), approval = resources.approve(actor, captured.snapshotId, captured.manifestHash)
  const model = await createPiTestModel({ models: [{ id: 'plain', reasoning: false }, { id: 'reason', reasoning: true }], answers: ['The first actual native answer.'] })
  const backend = async () => {
    const native = new LinuxExecutor({ workspaceRoot: work, scratchRoot: join(root, 'scratch'), outputRoot: outputDir, protectedRoots: [privateRoot, agentDir, sessionDir],
      rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()) })
    cleanup.push(() => native.abortAll()); await native.preflight(); return native
  }
  const base = { workspaceRoot: work, agentDir, sessionDir, outputDir, sessionId: binding.runtimeSessionId,
    resources: { store: resources, actor, approvalId: approval.approvalId }, protectedRoots: [privateRoot], ...model,
    authorize() { if (control.binding(actor, conversationId).bindingId !== binding.bindingId) throw new Error('Native binding changed') } }
  const open = async (resume?: Parameters<typeof IsolatedPiWorker.create>[0]['resume']) => {
    const native = await backend(), worker = await IsolatedPiWorker.create({ ...base, native, ...(resume ? { resume } : {}) })
    cleanup.push(() => worker.dispose()); return { native, worker }
  }
  let sequence = 0
  const input = async (worker: IsolatedPiWorker, action: NativeControlAction): Promise<NativeControlApply> => ({ operationId: `native-operation:${++sequence}`,
    requestHash: hash(`complete product command ${sequence}`), expectedHead: (await worker.nativeInspect()).head, action })
  return { root, work, ready, control, binding, resources, approval, model, base, open, input }
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('real isolated native configuration controls', () => {
  it('persists model, thinking and queue modes before any provider call, remains readable after Stop, and resumes the original native file', async () => {
    const f = await fixture(), first = await f.open(), original = await first.worker.nativeInspect()
    expect(f.model.getCallCount()).toBe(0); expect(first.worker.verifiedFile).toBeDefined()
    expect(original.configuration).toMatchObject({ model: { id: 'plain' }, thinkingLevel: 'off' })
    const modelInput = await f.input(first.worker, { kind: 'set-model', provider: f.model.models[0]!.provider, modelId: 'reason' })
    const changed = await first.worker.nativeApply(modelInput)
    await first.worker.nativeApply(await f.input(first.worker, { kind: 'set-thinking', level: 'high' }))
    await first.worker.nativeApply(await f.input(first.worker, { kind: 'set-queue-mode', queue: 'steering', mode: 'all' }))
    await first.worker.nativeApply(await f.input(first.worker, { kind: 'set-queue-mode', queue: 'follow-up', mode: 'all' }))
    const state = await first.worker.nativeInspect(), file = first.worker.verifiedFile!, bytes = readFileSync(file)
    expect(state.configuration).toMatchObject({ model: { id: 'reason' }, thinkingLevel: 'high', steeringMode: 'all', followUpMode: 'all' })
    expect(f.model.getCallCount()).toBe(0)
    expect((await first.worker.snapshot() as { entries: Array<{ type: string }> }).entries.some(entry => entry.type === 'message')).toBe(false)
    await first.worker.stop()
    expect(await first.worker.nativeInspect()).toMatchObject({ head: state.head, configuration: state.configuration, busy: false })
    expect(readFileSync(file)).toEqual(bytes)
    await expect(first.worker.nativeApply(modelInput)).rejects.toMatchObject({ code: 'denied' })
    await first.worker.dispose(); expect(first.native.activeCount).toBe(0)
    const seal = inspectNativeSession(file, f.binding.runtimeSessionId, f.work, true).seal, second = await f.open({ file, seal })
    expect((await second.worker.nativeInspect()).configuration).toEqual(state.configuration)
    expect(second.worker.verifiedFile).toBe(file); expect(readFileSync(file).subarray(0, bytes.length)).toEqual(bytes)
    expect(findNativeControlOutcome(file, modelInput, f.model.models)).toEqual({ ...changed, status: 'replayed' })
    expect(await second.worker.nativeApply(modelInput)).toEqual({ ...changed, status: 'replayed' }); expect(f.model.getCallCount()).toBe(0)
    const coordinator = new SubmissionCoordinator(f.control, actor, conversationId, second.worker, prepareDocumentFree); cleanup.push(() => coordinator.close())
    const receipt = coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: 1, idempotencyKey: 'question:first-native', mode: 'prompt', text: 'First real question.', sourceRefs: [], selectionContextIds: [] }).receipt
    await coordinator.waitForIdle()
    expect(f.control.get(actor, receipt.submissionId).state).toBe('completed'); expect(f.model.getCallCount()).toBe(1)
    expect(readFileSync(file, 'utf8').split('\n').filter(line => line && JSON.parse(line).type === 'session')).toHaveLength(1)
  }, 30000)

  it.each(['stop', 'resource-revocation'] as const)('joins a real model-select native process on %s and never manufactures a committed configuration receipt', async reason => {
    const f = await fixture(true), run = await f.open(), input = await f.input(run.worker, { kind: 'set-model', provider: f.model.models[0]!.provider, modelId: 'reason' })
    const file = run.worker.verifiedFile!, work = run.worker.nativeApply(input), rejected = expect(work).rejects.toThrow()
    await vi.waitFor(() => expect(existsSync(f.ready)).toBe(true), { timeout: 10000 })
    expect(JSON.parse(readFileSync(f.ready, 'utf8'))).toMatchObject({ privateVisible: false, sessionVisible: false })
    expect(run.native.activeCount).toBeGreaterThan(0); expect(run.worker.busy).toBe(true); expect(f.model.getCallCount()).toBe(0)
    if (reason === 'resource-revocation') f.resources.revoke(actor, f.approval.approvalId)
    await run.worker.stop(); await rejected
    expect(run.native.activeCount).toBe(0)
    expect(() => findNativeControlOutcome(file, input, f.model.models)).toThrowError(expect.objectContaining({ code: 'failed' }))
    if (reason === 'stop') expect(await run.worker.nativeInspect()).toMatchObject({ busy: false })
    else await expect(run.worker.nativeInspect()).rejects.toThrow()
  }, 30000)
})
