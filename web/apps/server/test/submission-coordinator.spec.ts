import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiProductDriver, type RuntimeProgress } from '@docatlas/runtime-pi'
import { createPiTestRuntime } from '@docatlas/runtime-pi/testing'
import type { ProductRunReceipt, ProductSubmission } from '@docatlas/contracts'
import { ControlStore, SubmissionCoordinator, prepareDocumentFree, type PrepareSubmission } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'user:scheduler', workspaceId: 'workspace:scheduler' }
function request(key: string, mode: ProductSubmission['mode'] = 'prompt', text = 'Identical question'): ProductSubmission {
  return { schemaVersion: 1, kind: 'submission', conversationId: 'conversation:scheduler', expectedGeneration: 1,
    idempotencyKey: `idempotency:${key}`, mode, text, sourceRefs: [], selectionContextIds: [] }
}

async function setup(options: {
  answers?: string[], beforeResponse?: (signal: AbortSignal | undefined) => Promise<void>,
  prepare?: PrepareSubmission, ttlMs?: number, clock?: () => number,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-coordinator-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'project'), agentDir = join(root, 'agent')
  mkdirSync(cwd); mkdirSync(agentDir)
  const store = ControlStore.open(join(root, 'control'), options.clock)
  cleanup.push(() => store.close())
  const { runtime, getCallCount } = await createPiTestRuntime({ cwd, agentDir, sessionDir: join(root, 'sessions'),
    answers: options.answers ?? ['first answer', 'second answer', 'third answer'], ...(options.beforeResponse ? { beforeResponse: options.beforeResponse } : {}) })
  cleanup.push(() => runtime.dispose())
  // No native tool calls in these message-only fixtures. Real OS routing is tested independently.
  const progress: RuntimeProgress[] = []
  const driver = new PiProductDriver(runtime.session, { activeCount: 0, abortAll: async () => {}, resume: () => {} }, event => progress.push(event), options.clock ? () => new Date(options.clock!()) : undefined)
  cleanup.push(() => driver.dispose())
  store.createConversation(actor, { conversationId: 'conversation:scheduler', runtimeSessionId: runtime.session.sessionId })
  const receipts: ProductRunReceipt[] = []
  const coordinator = new SubmissionCoordinator(store, actor, 'conversation:scheduler', driver, options.prepare ?? prepareDocumentFree,
    receipt => { receipts.push(receipt) }, options.ttlMs)
  cleanup.push(() => coordinator.close())
  return { store, coordinator, runtime, driver, receipts, progress, getCallCount }
}

describe('durable submission coordinator with real Pi', () => {
  it('executes accepted work, emits committed progress, queues ordinary messages and deduplicates retries', async () => {
    const { coordinator, store, getCallCount, progress, receipts } = await setup()
    const one = coordinator.submit(request('ordinary:one'))
    const duplicate = coordinator.submit(request('ordinary:one'))
    const two = coordinator.submit(request('ordinary:two'))
    expect(one.receipt.state).toBe('accepted')
    expect(duplicate.replayed).toBe(true)
    await coordinator.waitForIdle()
    expect(getCallCount()).toBe(2)
    expect(store.get(actor, one.receipt.submissionId).state).toBe('completed')
    expect(store.get(actor, two.receipt.submissionId).state).toBe('completed')
    expect(receipts.filter(item => item.submissionId === one.receipt.submissionId).map(item => item.state))
      .toEqual(['accepted', 'accepted', 'preparing', 'ready', 'dispatching', 'running', 'completed'])
    expect(progress.some(event => event.type === 'text')).toBe(true)
    expect(coordinator.submit(request('ordinary:one')).receipt.state).toBe('completed')
    expect(getCallCount()).toBe(2)
  })

  it('preserves native steer/follow-up priority and binds identical texts to distinct user entries', async () => {
    let started!: () => void, release!: () => void, calls = 0
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const { coordinator, store, runtime, getCallCount } = await setup({ beforeResponse: async () => { if (++calls === 1) { started(); await gate } } })
    const first = coordinator.submit(request('message:first'))
    await ready
    const follow = coordinator.submit(request('message:follow', 'follow-up'))
    const steer = coordinator.submit(request('message:steer', 'steer'))
    await expect.poll(() => store.get(actor, steer.receipt.submissionId).state).toBe('dispatching')
    release()
    await coordinator.waitForIdle()
    const completed = [first, follow, steer].map(item => store.get(actor, item.receipt.submissionId))
    expect(completed.every(item => item.state === 'completed')).toBe(true)
    expect(new Set(completed.map(item => item.checkpoint?.userEntryId)).size).toBe(3)
    const branch = runtime.session.sessionManager.getBranch()
    expect(branch.findIndex(entry => entry.id === completed[2]!.checkpoint!.userEntryId))
      .toBeLessThan(branch.findIndex(entry => entry.id === completed[1]!.checkpoint!.userEntryId))
    expect(getCallCount()).toBe(3)
  }, 10_000)

  it('heartbeats a slow turn beyond its initial lease and only finishes after native settlement', async () => {
    let started!: () => void, release!: () => void, now = Date.now()
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const { coordinator, store } = await setup({ ttlMs: 300, clock: () => now, beforeResponse: async () => { started(); await gate } })
    const run = coordinator.submit(request('heartbeat:turn'))
    await ready
    const first = store.writerInfo(actor, 'conversation:scheduler')!
    try {
      // Advance the lease clock only after each real timer renewal, independent of machine load.
      for (let renewal = 0; renewal < 2; renewal++) {
        now += 200
        await expect.poll(() => store.writerInfo(actor, 'conversation:scheduler')!.expiresAt, { timeout: 2000 }).toBeGreaterThanOrEqual(now + 300)
      }
      expect(now).toBeGreaterThan(first.expiresAt)
      expect(store.get(actor, run.receipt.submissionId).state).toBe('running')
    } finally { release() }
    await coordinator.waitForIdle()
    const receipt = store.get(actor, run.receipt.submissionId)
    expect(receipt.state, JSON.stringify(receipt)).toBe('completed')
  })

  it('cancels active and queued work, awaits actual stop, then permits a new explicit submission', async () => {
    let started!: () => void, calls = 0
    const ready = new Promise<void>(resolve => { started = resolve })
    const { coordinator, store, getCallCount, driver } = await setup({ beforeResponse: async signal => {
      if (++calls !== 1) return
      started()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error('cancelled'))
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
      })
    } })
    const active = coordinator.submit(request('cancel:active'))
    await ready
    const queued = coordinator.submit(request('cancel:queued'))
    await coordinator.cancel()
    expect(driver.busy).toBe(false)
    expect(store.get(actor, active.receipt.submissionId).state).toBe('cancelled')
    expect(store.get(actor, queued.receipt.submissionId).state).toBe('cancelled')
    expect(store.recoveryInput(actor, active.receipt.submissionId)).not.toBeNull()
    const next = coordinator.submit(request('cancel:next'))
    await coordinator.waitForIdle()
    expect(store.get(actor, next.receipt.submissionId).state).toBe('completed')
    expect(getCallCount()).toBe(2)
  })

  it('does not admit late preparation after cancellation and rejects unimplemented document admission', async () => {
    let started!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const { coordinator, store, getCallCount } = await setup({ prepare: async input => { started(); await gate; return prepareDocumentFree(input) } })
    const run = coordinator.submit(request('prepare:late'))
    await ready
    const stopping = coordinator.cancel()
    release()
    await stopping
    expect(store.get(actor, run.receipt.submissionId).state).toBe('cancelled')
    expect(getCallCount()).toBe(0)
    const invalid = coordinator.submit({ ...request('prepare:document'), sourceRefs: [{ documentId: 'doc:one', revisionId: 'rev:one' }] })
    await coordinator.waitForIdle()
    expect(store.get(actor, invalid.receipt.submissionId).state).toBe('failed')
    expect(getCallCount()).toBe(0)
  })

  it('stops on writer loss and records an unknown outcome instead of committing stale success', async () => {
    let now = Date.now(), started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const { coordinator, store, driver } = await setup({ ttlMs: 300, clock: () => now, beforeResponse: async signal => {
      started()
      await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('fenced')), { once: true }) })
    } })
    const run = coordinator.submit(request('fence:turn'))
    await ready
    now += 1000
    await expect.poll(() => store.get(actor, run.receipt.submissionId).state).toBe('outcome-unknown')
    expect(driver.busy).toBe(false)
    expect(store.writerInfo(actor, 'conversation:scheduler')).toBeNull()
    await expect(coordinator.waitForIdle()).rejects.toThrow()
  })

  it('does not hang or replay when SDK acceptance never reaches a native user entry', async () => {
    const { runtime, coordinator, store, getCallCount } = await setup()
    const prompt = vi.spyOn(runtime.session, 'prompt').mockImplementation(async (text, options) => {
      options?.onUserMessage?.({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
      options?.preflightResult?.(true)
    })
    cleanup.push(() => { prompt.mockRestore() })
    const accepted = coordinator.submit(request('fault:unconsumed'))
    await coordinator.waitForIdle()
    expect(store.get(actor, accepted.receipt.submissionId).state).toBe('outcome-unknown')
    expect(store.recoveryInput(actor, accepted.receipt.submissionId)).not.toBeNull()
    expect(getCallCount()).toBe(0)
  })
})
