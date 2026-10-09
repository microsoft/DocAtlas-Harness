import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkpointPiSubmission } from '@docatlas/runtime-pi'
import { createPiTestRuntime } from '@docatlas/runtime-pi/testing'
import type { ProductRunReceipt, ProductSubmission } from '@docatlas/contracts'
import { ControlStore, type WriterLease } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'user:crash', workspaceId: 'workspace:crash' }
function folder() { const root = mkdtempSync(join(tmpdir(), 'docatlas-inbox-pi-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root }
function open(root: string) { const store = ControlStore.open(join(root, 'control')); cleanup.push(() => store.close()); return store }
function admit(store: ControlStore, lease: WriterLease, receipt: ProductRunReceipt): ProductRunReceipt {
  let next = receipt
  if (next.state === 'accepted') next = store.transition(lease, next.submissionId, next.version, 'preparing')
  next = store.transition(lease, next.submissionId, next.version, 'ready', { prepared: { schemaVersion: 1, kind: 'prepared',
    submissionId: receipt.submissionId, requestHash: receipt.requestHash, bindingGeneration: receipt.generation,
    scopeVersionId: null, sourceRefs: [], selectionContextIds: [] } })
  return store.transition(lease, next.submissionId, next.version, 'dispatching')
}

describe('control inbox with actual published Pi execution', () => {
  it.each(['accepted', 'running'] as const)('keeps the first user question through SIGKILL at %s, without blind replay', async stage => {
    const root = folder()
    const child = fork(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/inbox-crash.mjs'), [root, stage], {
      execPath: process.execPath, execArgv: ['--experimental-transform-types'],
      env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr?.on('data', data => { stderr += String(data) })
    let message: { stage: string, submissionId: string, epoch: number, file: string }
    try {
      message = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Child readiness timeout: ${stderr}`)), 15_000)
        child.once('message', value => { clearTimeout(timer); resolve(value as typeof message) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`Child exited before crash boundary: ${stderr}`)) })
      })
      expect(message.stage).toBe(stage)
      expect(existsSync(message.file)).toBe(false)
      child.kill('SIGKILL')
      await exited // Actual termination, not expiry or an assumed dead worker.
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
    const store = open(root)
    const binding = store.binding(actor, 'conversation:crash')
    const writer = store.writerInfo(actor, binding.conversationId)!
    expect(writer.epoch).toBe(message.epoch)
    store.recoverAfterExecutionStopped(actor, binding.conversationId, writer.epoch)
    const receipt = store.get(actor, message.submissionId)
    const input = store.recoveryInput(actor, receipt.submissionId)!
    expect(input.text).toBe('A first question that must survive the process.')
    expect(receipt.state).toBe(stage === 'accepted' ? 'accepted' : 'outcome-unknown')
    expect(store.accept(actor, input).replayed).toBe(true)
    if (stage === 'running') {
      const lease = store.acquireWriter(actor, binding.conversationId, 'worker:replacement')
      expect(() => store.transition(lease, receipt.submissionId, receipt.version, 'ready')).toThrow()
      return
    }
    // The accepted-only request had no dispatch intent; restore the original native identity safely.
    const { runtime, getCallCount } = await createPiTestRuntime({ cwd: join(root, 'project'), agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'), sessionId: binding.runtimeSessionId, answers: ['Recovered first answer.'] })
    cleanup.push(() => runtime.dispose())
    expect(runtime.session.sessionId).toBe(binding.runtimeSessionId)
    const lease = store.acquireWriter(actor, binding.conversationId, 'worker:replacement')
    let run = admit(store, lease, receipt)
    run = store.transition(lease, run.submissionId, run.version, 'running')
    await runtime.session.prompt(input.text)
    const userEntry = runtime.session.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user')!
    const checkpoint = checkpointPiSubmission(runtime.session, { submissionId: run.submissionId, requestHash: run.requestHash, userEntryId: userEntry.id, expectedText: input.text })
    const completed = store.transition(lease, run.submissionId, run.version, 'completed', { checkpoint })
    expect(completed.state).toBe('completed')
    expect(getCallCount()).toBe(1)
    store.purgeRecoveryPayload(actor, run.submissionId)
    expect(readFileSync(runtime.session.sessionFile!, 'utf8')).toContain(input.text)
    expect(store.recoveryInput(actor, run.submissionId)).toBeNull()
  }, 25_000)

  it('requires native file/content/branch integrity for saved completion', async () => {
    const root = folder(), cwd = join(root, 'project'), agentDir = join(root, 'agent')
    mkdirSync(cwd); mkdirSync(agentDir)
    const { runtime } = await createPiTestRuntime({ cwd, agentDir, sessionDir: join(root, 'sessions'), answers: ['Verified answer.'] })
    cleanup.push(() => runtime.dispose())
    const store = open(root)
    store.createConversation(actor, { conversationId: 'conversation:crash', runtimeSessionId: runtime.session.sessionId })
    const request: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: 'conversation:crash', expectedGeneration: 1,
      idempotencyKey: 'idempotency:checkpoint:one', mode: 'prompt', text: 'First request.', sourceRefs: [], selectionContextIds: [] }
    const receipt = store.accept(actor, request).receipt
    await runtime.session.prompt(request.text)
    const entry = runtime.session.sessionManager.getBranch().find(item => item.type === 'message' && item.message.role === 'user')!
    const input = { submissionId: receipt.submissionId, requestHash: receipt.requestHash, userEntryId: entry.id, expectedText: request.text }
    const checkpoint = checkpointPiSubmission(runtime.session, input)
    const file = runtime.session.sessionFile!, original = readFileSync(file)
    expect(checkpoint.transcriptHash).toBe(createHash('sha256').update(original).digest('hex'))
    expect(() => checkpointPiSubmission(runtime.session, { ...input, expectedText: 'different' })).toThrow(/model input/)
    expect(() => checkpointPiSubmission(runtime.session, { ...input, maxBytes: 1 })).toThrow(/resource limit/)
    appendFileSync(file, '{broken\n')
    expect(() => checkpointPiSubmission(runtime.session, input)).toThrow()
    writeFileSync(file, original.toString().replace('First request.', 'Forged request.'))
    expect(() => checkpointPiSubmission(runtime.session, input)).toThrow(/contents changed/)
    writeFileSync(file, original)
  })
})
