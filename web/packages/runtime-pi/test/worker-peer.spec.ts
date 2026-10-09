import { PassThrough, Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerPeer, WorkerCancelledResult, type WorkerHandler } from '../src/worker/peer.js'
import { brokerCatalog, modelBroker } from '../src/worker/model-bridge.js'
import { createPiTestModel } from '../src/testing.js'
import { verifyWorkerCheckpoint } from '../src/worker/checkpoint.js'

const peers: WorkerPeer[] = []
afterEach(() => { for (const peer of peers.splice(0)) peer.close() })
function pair(handlers: ReadonlyMap<string, WorkerHandler>, bytes = 8192) {
  const a = new PassThrough(), b = new PassThrough(), failures: Error[] = []
  const host = new WorkerPeer(a, b, handlers, error => failures.push(error), bytes)
  const worker = new WorkerPeer(b, a, new Map(), error => failures.push(error), bytes)
  peers.push(host, worker); return { host, worker, a, b, failures }
}
it('has directional method authority and ordered streaming responses', async () => {
  const handler = vi.fn<WorkerHandler>(async (value, call) => { await call.yield('first'); await call.yield('second'); return value })
  const { host, worker } = pair(new Map([['native.echo', handler]]))
  const events: unknown[] = []
  await expect(worker.call('native.echo', { text: '测试🙂' }, { progress: value => events.push(value) })).resolves.toEqual({ text: '测试🙂' })
  expect(events).toEqual(['first', 'second'])
  await expect(worker.call('runtime.submit', { actorId: 'user:forged' })).rejects.toMatchObject({ code: 'denied' })
  await expect(host.call('native.echo', null)).rejects.toMatchObject({ code: 'denied' })
  expect(handler).toHaveBeenCalledOnce()
})
it('signals cancellation without confusing early rejection with handler quiescence', async () => {
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  let cancelled = false
  const { host, worker } = pair(new Map([['native.wait', async (_value, call) => { started.resolve(); call.signal.addEventListener('abort', () => { cancelled = true }); await finish.promise; return null }]]))
  const controller = new AbortController(), work = worker.call('native.wait', null, { signal: controller.signal })
  const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' })
  await started.promise; controller.abort(); await rejected
  expect(cancelled).toBe(true); expect(host.activeCount).toBe(1)
  finish.resolve(); await vi.waitFor(() => expect(host.activeCount).toBe(0))
  expect(host.closed).toBe(false)
})
it('can retain native partial output while waiting for a cancellation acknowledgement', async () => {
  const entered = Promise.withResolvers<void>(), exited = Promise.withResolvers<void>()
  const { worker } = pair(new Map([['native.exec', async (_value, call) => { entered.resolve(); await exited.promise; expect(call.signal.aborted).toBe(true); return new WorkerCancelledResult({ stdout: 'partial', killed: true }) }]]))
  const controller = new AbortController()
  let settled = false
  const pending = worker.call('native.exec', null, { signal: controller.signal, awaitCancellation: true }).then(value => { settled = true; return value })
  await entered.promise; controller.abort(); await Promise.resolve()
  expect(settled).toBe(false)
  exited.resolve()
  await expect(pending).resolves.toEqual({ stdout: 'partial', killed: true })
})
it('bounds frames and fails closed on malformed UTF-8', async () => {
  const first = pair(new Map(), 1024)
  await expect(first.worker.call('native.echo', 'x'.repeat(2048))).rejects.toBeDefined()
  expect(first.worker.closed).toBe(true)
  const second = pair(new Map())
  second.a.write(Buffer.from([255, 10]))
  expect(second.host.closed).toBe(true)
})
it('handles fragmented UTF-8 and several frames without quadratic line buffering', async () => {
  const a = new PassThrough(), fragment = new Transform({ transform(chunk: Buffer, _encoding, done) {
    for (let i = 0; i < chunk.length; i += 3) this.push(chunk.subarray(i, i + 3)); done()
  } })
  const host = new WorkerPeer(a, fragment, new Map([['native.echo', async value => value]]), () => {}, 65536)
  const worker = new WorkerPeer(fragment, a, new Map(), () => {}, 65536)
  peers.push(host, worker)
  const value = '字🙂'.repeat(4000)
  await expect(worker.call('native.echo', value)).resolves.toBe(value)
})
it('rejects duplicate or non-monotonic call IDs instead of repeating effects', async () => {
  const effect = vi.fn<WorkerHandler>(async () => null)
  const { a, host } = pair(new Map([['native.echo', effect]]))
  const frame = JSON.stringify({ version: 1, kind: 'call', id: '00000000-0000-4000-8000-000000000000:1', method: 'native.echo', value: null }) + '\n'
  a.write(frame); a.write(frame)
  expect(host.closed).toBe(true); expect(effect).toHaveBeenCalledOnce()
})
it('redacts model credentials/endpoints and rejects model/header/body routing overrides', async () => {
  const model = await createPiTestModel({ answers: ['authorized response'] })
  const descriptor = { ...model.models[0]!, baseUrl: 'https://private.invalid?key=CANARY', headers: { Authorization: 'CANARY' } }
  const catalog = brokerCatalog([descriptor])
  expect(JSON.stringify(catalog)).not.toContain('CANARY')
  expect(catalog[0]!.id).toBe(descriptor.id)
  const { worker } = pair(new Map([['model.stream', modelBroker(model.modelRuntime, model.models, () => {})]]))
  const request = { mode: 'simple', provider: descriptor.provider, model: descriptor.id, context: { messages: [] }, options: {} }
  for (const options of [{ apiKey: 'forged' }, { headers: { Authorization: 'forged' } }, { samplingParams: { model: 'unapproved' } }]) {
    await expect(worker.call('model.stream', { ...request, options })).rejects.toMatchObject({ code: 'denied' })
  }
  await expect(worker.call('model.stream', { ...request, model: 'unapproved' })).rejects.toMatchObject({ code: 'denied' })
  expect(model.getCallCount()).toBe(0)
})
it('verifies a real committed native prefix and rejects tampering or a different user branch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'docatlas-worker-checkpoint-')), file = join(directory, 'native.jsonl')
  try {
    const id = '00000000-0000-4000-8000-000000000000'
    const bytes = Buffer.from([
      { type: 'session', version: 3, id, cwd: '/work' },
      { type: 'message', id: '11111111', parentId: null, message: { role: 'user', content: 'question' } },
      { type: 'message', id: '22222222', parentId: '11111111', message: { role: 'assistant', stopReason: 'stop', content: [] } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    writeFileSync(file, bytes)
    const checkpoint = { schemaVersion: 1, kind: 'pi-checkpoint', runtimeSessionId: id, submissionId: 'submission:checkpoint', requestHash: 'a'.repeat(64),
      userEntryId: '11111111', leafEntryId: '22222222', byteLength: bytes.length, entryCount: 2, transcriptHash: createHash('sha256').update(bytes).digest('hex'), settledAt: '2026-09-08T00:00:00Z' }
    expect(verifyWorkerCheckpoint(file, checkpoint)).toEqual(checkpoint)
    appendFileSync(file, JSON.stringify({ type: 'message', id: '33333333', parentId: '22222222', message: { role: 'user', content: 'next' } }) + '\n')
    expect(verifyWorkerCheckpoint(file, checkpoint)).toEqual(checkpoint)
    expect(() => verifyWorkerCheckpoint(file, { ...checkpoint, userEntryId: '44444444' })).toThrow()
    writeFileSync(file, bytes.toString().replace('question', 'tampered'))
    expect(() => verifyWorkerCheckpoint(file, checkpoint)).toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
