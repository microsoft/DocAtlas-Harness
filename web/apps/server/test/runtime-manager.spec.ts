import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { ControlStore, ResourceStore, RuntimeCatalog, RuntimeManager, prepareDocumentFree, type RuntimeManagerOptions } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:manager', workspaceId: 'workspace:manager' }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-managed-runtime-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const work = join(root, 'work'), agent = join(root, 'reviewed-agent'), state = join(root, 'private')
  for (const path of [work, agent, state]) mkdirSync(path)
  const resourceRoot = join(state, 'resources'), catalogRoot = join(state, 'catalog'), controlRoot = join(state, 'control')
  const stores = () => ({ control: ControlStore.open(controlRoot), catalog: new RuntimeCatalog(catalogRoot), resources: new ResourceStore(resourceRoot) })
  const first = stores(), snapshot = first.resources.capture(agent), approval = first.resources.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
  const open = async (values: ReturnType<typeof stores>, answer: string, beforeResponse?: (signal: AbortSignal | undefined) => Promise<void>, services?: RuntimeManagerOptions['services']) => {
    const contexts: string[] = []
    const model = await createPiTestModel({ answers: [answer], inspectMessages: messages => contexts.push(JSON.stringify(messages)), ...(beforeResponse ? { beforeResponse } : {}) })
    const manager = new RuntimeManager({ ...values, ...model, actor, approvalId: approval.approvalId, workspaceRoot: work,
      stateRoot: join(root, 'runtimes'), rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()), ...(services ? { services } : {}) })
    cleanup.push(async () => { await manager.close(); values.catalog.close(); values.resources.close(); values.control.close() })
    return { manager, model, contexts }
  }
  return { first, stores, open, root, work }
}
describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('managed native sessions', () => {
  it('attaches optional product observations before recovered queued work and detaches them on shutdown', async () => {
    const { first, open } = fixture(), states: string[] = [], detached = vi.fn()
    const one = await open(first, 'actual recovered answer', undefined, () => ({ prepare: prepareDocumentFree,
      onCoordinator: coordinator => { const remove = coordinator.subscribe(receipt => states.push(receipt.state)); return () => { remove(); detached() } } }))
    const binding = one.manager.create(actor, 'create:observed-queued').binding
    const accepted = first.control.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: 1,
      idempotencyKey: 'question:observed-queued', mode: 'prompt', text: 'A queued question exists before runtime startup.', sourceRefs: [], selectionContextIds: [] })
    const run = await one.manager.get(actor, binding.conversationId)
    await run.coordinator.waitForIdle()
    expect(first.control.get(actor, accepted.receipt.submissionId).state).toBe('completed')
    expect(states).toContain('running'); expect(states.at(-1)).toBe('completed'); expect(detached).not.toHaveBeenCalled()
    expect(one.model.getCallCount()).toBe(1)
    await one.manager.close(); await one.manager.close(); expect(detached).toHaveBeenCalledTimes(1)
  }, 30000)
  it.each(['setup', 'notification', 'detach'] as const)('does not let optional observation %s failures downgrade native results or prevent joining', async failure => {
    const { first, open } = fixture()
    const one = await open(first, 'optional-observer-independent answer', undefined, () => ({ prepare: prepareDocumentFree,
      onCoordinator: coordinator => {
        if (failure === 'setup') throw new Error('optional setup failure')
        const remove = coordinator.subscribe(() => { if (failure === 'notification') throw new Error('optional notification failure') })
        return () => { remove(); if (failure === 'detach') throw new Error('optional detach failure') }
      } }))
    const binding = one.manager.create(actor, `create:observation-${failure}`).binding, run = await one.manager.get(actor, binding.conversationId)
    const submitted = run.coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: 1,
      idempotencyKey: `question:observer-${failure}`, mode: 'prompt', text: 'Ordinary native execution.', sourceRefs: [], selectionContextIds: [] })
    await run.coordinator.waitForIdle()
    expect(first.control.get(actor, submitted.receipt.submissionId).state).toBe('completed')
    await expect(one.manager.close()).resolves.toBeUndefined()
    expect(first.control.writerInfo(actor, binding.conversationId)).toBeNull()
  }, 30000)
  it('retains stopped native context and does not replay a cancelled turn on reopen', async () => {
    const { first, stores, open } = fixture()
    const one = await open(first, 'not completed', signal => new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('cancelled'))
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    }))
    const binding = one.manager.create(actor, 'create:cancelled-context').binding, run = await one.manager.get(actor, binding.conversationId)
    const request = { schemaVersion: 1 as const, kind: 'submission' as const, conversationId: binding.conversationId, expectedGeneration: 1, idempotencyKey: 'question:cancelled-context', mode: 'prompt' as const, text: 'cancelled native question', sourceRefs: [], selectionContextIds: [] }
    const receipt = run.coordinator.submit(request).receipt
    await vi.waitFor(() => expect(one.model.getCallCount()).toBe(1), { timeout: 5000 })
    await run.coordinator.cancel(); expect(first.control.get(actor, receipt.submissionId).state).toBe('cancelled')
    await cleanup.pop()!()
    const second = stores(), two = await open(second, 'new completed answer'), resumed = await two.manager.get(actor, binding.conversationId)
    expect(two.model.getCallCount()).toBe(0)
    expect(resumed.coordinator.submit(request).replayed).toBe(true)
    resumed.coordinator.submit({ ...request, idempotencyKey: 'question:after-cancelled', text: 'continue safely' })
    await resumed.coordinator.waitForIdle()
    expect(two.model.getCallCount()).toBe(1)
    expect(two.contexts[0]).toContain('cancelled native question')
    expect(two.contexts[0]).toContain('continue safely')
  }, 30000)
  it('reopens the exact native history after close, preserves IDs, and continues without replay', async () => {
    const fixtureValue = fixture(), { first, stores, open } = fixtureValue
    const one = await open(first, 'first durable answer')
    const created = one.manager.create(actor, 'create:stable-conversation')
    expect(one.manager.create(actor, 'create:stable-conversation')).toEqual({ ...created, replayed: true })
    const conversationId = created.binding.conversationId
    const [run, duplicate] = await Promise.all([one.manager.get(actor, conversationId), one.manager.get(actor, conversationId)])
    expect(run.worker).toBe(duplicate.worker)
    const request = { schemaVersion: 1 as const, kind: 'submission' as const, conversationId, expectedGeneration: 1, idempotencyKey: 'question:first-message', mode: 'prompt' as const, text: 'Remember the first question', sourceRefs: [], selectionContextIds: [] }
    const receipt = run.coordinator.submit(request).receipt
    await run.coordinator.waitForIdle()
    const native = await run.worker.snapshot() as { sessionFile: string, entries: Array<{ id: string }> }
    const originalBytes = readFileSync(native.sessionFile)
    expect(first.control.get(actor, receipt.submissionId).state).toBe('completed')
    expect(one.model.getCallCount()).toBe(1)
    await cleanup.pop()!() // Close actual namespace/coordinator and ALL first store handles.
    const second = stores(), two = await open(second, 'second durable answer')
    const resumed = await two.manager.get(actor, conversationId)
    expect(two.model.getCallCount()).toBe(0)
    expect(resumed.observations.snapshot(actor).history.messages.map(message => message.text)).toEqual(['Remember the first question', 'first durable answer'])
    expect(resumed.coordinator.submit(request).replayed).toBe(true)
    await resumed.coordinator.waitForIdle(); expect(two.model.getCallCount()).toBe(0)
    resumed.coordinator.submit({ ...request, idempotencyKey: 'question:second-message', text: 'Continue that conversation' })
    await resumed.coordinator.waitForIdle()
    const current = await resumed.worker.snapshot() as { sessionFile: string, entries: Array<{ id: string }> }
    expect(current.sessionFile).toBe(native.sessionFile)
    expect(current.entries.slice(0, native.entries.length).map(entry => entry.id)).toEqual(native.entries.map(entry => entry.id))
    expect(readFileSync(current.sessionFile).subarray(0, originalBytes.length)).toEqual(originalBytes)
    expect(resumed.observations.snapshot(actor).history.messages.map(message => message.text)).toContain('second durable answer')
    expect(two.model.getCallCount()).toBe(1)
    expect(two.contexts[0]).toContain('Remember the first question')
    expect(two.contexts[0]).toContain('first durable answer')
    expect(two.contexts[0]).toContain('Continue that conversation')
  }, 30000)
  it('rejects altered closed native bytes without resealing or replacing them', async () => {
    const { first, stores, open } = fixture(), one = await open(first, 'sealed answer')
    const binding = one.manager.create(actor, 'create:tamper-conversation').binding, run = await one.manager.get(actor, binding.conversationId)
    run.coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: 1, idempotencyKey: 'question:tamper-case', mode: 'prompt', text: 'original', sourceRefs: [], selectionContextIds: [] })
    await run.coordinator.waitForIdle()
    const native = await run.worker.snapshot() as { sessionFile: string }
    await cleanup.pop()!()
    const changed = readFileSync(native.sessionFile, 'utf8').replace('sealed answer', 'tamper answer')
    writeFileSync(native.sessionFile, changed)
    const second = stores(), two = await open(second, 'must not execute')
    await expect(two.manager.get(actor, binding.conversationId)).rejects.toThrow('changed')
    expect(two.model.getCallCount()).toBe(0)
    await expect(two.manager.get(actor, binding.conversationId)).rejects.toThrow('not cleanly released')
    expect(readFileSync(native.sessionFile, 'utf8')).toBe(changed)
  }, 30000)
})
it('retains unclean ownership across connections and rejects stale release capabilities', () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-runtime-claim-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const binding = control.createManagedConversation(actor, 'create:unclean-claim').binding
  const first = new RuntimeCatalog(join(root, 'catalog')), claim = first.claim(binding)
  first.close()
  const next = new RuntimeCatalog(join(root, 'catalog')); cleanup.push(() => next.close())
  expect(() => next.claim(binding)).toThrow('not cleanly released')
  expect(() => next.release({ ...claim, token: 'forged' }, null)).toThrow('owner changed')
  next.release(claim, null) // No process was started; this test owns the actual claim.
  expect(next.claim(binding).token).not.toBe(claim.token)
})
