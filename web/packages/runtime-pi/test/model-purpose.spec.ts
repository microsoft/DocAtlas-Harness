import { PassThrough } from 'node:stream'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeModelPurpose, type NativeModelRequestPurpose } from '../src/worker/model-purpose.js'
import { createBrokerModelRuntime, modelBroker } from '../src/worker/model-bridge.js'
import { WorkerPeer, type WorkerHandler } from '../src/worker/peer.js'
import { createPiTestModel } from '../src/testing.js'

type Stream = AgentSession['agent']['streamFunction']
const model = fauxProvider().getModel(), cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
const context = (): Context => ({ systemPrompt: 'Native instruction', messages: [] })
function completed() {
  const output = createAssistantMessageEventStream(), message = fauxAssistantMessage('Actual test answer')
  output.push({ type: 'done', reason: 'stop', message }); return output
}
function fixture(original: Stream) {
  const tracker = new NativeModelPurpose(), controller = new AbortController()
  let signal: AbortSignal | undefined = controller.signal
  const flags = { auto: false, manual: false, branch: false }
  const agent = { streamFunction: original, get signal() { return signal } }
  const session = { agent, get isCompacting() { return flags.auto || flags.manual || flags.branch } } as unknown as Pick<AgentSession, 'agent' | 'isCompacting'>
  tracker.bind(session); cleanups.push(() => tracker.invalidate())
  return { tracker, controller, flags, agent, session, signal(value: AbortSignal | undefined) { signal = value } }
}

it('marks exactly the native answer call without changing context, options, hooks, receiver or return value', () => {
  const result = completed(), value = context(), onPayload = vi.fn(), onResponse = vi.fn(), seen: unknown[] = []
  const original: Stream = function (this: unknown, receivedModel, receivedContext, receivedOptions) {
    seen.push(this, receivedModel, receivedContext, receivedOptions, test.tracker.consume(receivedContext, receivedOptions?.signal))
    return result
  }
  const test = fixture(original), options: SimpleStreamOptions = { signal: test.controller.signal, onPayload, onResponse, temperature: 0.8, maxTokens: 16 }
  expect(test.agent.streamFunction(model, value, options)).toBe(result)
  expect(seen).toEqual([test.agent, model, value, options, 'agent-answer'])
  expect(seen[2]).toBe(value); expect(seen[3]).toBe(options)
  expect(options).toEqual({ signal: test.controller.signal, onPayload, onResponse, temperature: 0.8, maxTokens: 16 })
  expect(test.tracker.consume(value, options.signal)).toBe('auxiliary')
})

it.each(['auto', 'manual', 'branch'] as const)('keeps %s compaction auxiliary even while a main run signal remains active', async kind => {
  const observed: NativeModelRequestPurpose[] = []
  const test = fixture(async (_model, value, options) => { await Promise.resolve(); observed.push(test.tracker.consume(value, options?.signal)); return completed() })
  test.flags[kind] = true
  await test.agent.streamFunction(model, context(), { signal: test.controller.signal })
  await test.agent.streamFunction(model, context(), { signal: new AbortController().signal })
  expect(observed).toEqual(['auxiliary', 'auxiliary'])
  test.flags[kind] = false
  await test.agent.streamFunction(model, context(), { signal: test.controller.signal })
  expect(observed.at(-1)).toBe('agent-answer')
})

it.each(['missing', 'different', 'aborted', 'no-active-run'] as const)('does not classify %s signals as answer generation', async state => {
  const seen: NativeModelRequestPurpose[] = [], test = fixture((_model, value, options) => { seen.push(test.tracker.consume(value, options?.signal)); return completed() })
  if (state === 'aborted') test.controller.abort()
  if (state === 'no-active-run') test.signal(undefined)
  await test.agent.streamFunction(model, context(), state === 'missing' ? {} : { signal: state === 'different' ? new AbortController().signal : test.controller.signal })
  expect(seen).toEqual(['auxiliary'])
})

it('requires exact context and signal identities, and consumes a matching token only once', async () => {
  const seen: NativeModelRequestPurpose[] = []
  const test = fixture(async (_model, value, options) => {
    await Promise.resolve()
    seen.push(test.tracker.consume(structuredClone(value), options?.signal))
    seen.push(test.tracker.consume(value, new AbortController().signal))
    seen.push(test.tracker.consume(value, options?.signal))
    await Promise.resolve()
    seen.push(test.tracker.consume(value, options?.signal))
    return completed()
  })
  await test.agent.streamFunction(model, context(), { signal: test.controller.signal })
  expect(seen).toEqual(['auxiliary', 'auxiliary', 'agent-answer', 'auxiliary'])
})

it('keeps direct and nested auxiliary calls from stealing or inheriting an outer answer token', async () => {
  const observed: NativeModelRequestPurpose[] = []
  const direct = async (value: Context, signal: AbortSignal) => { await Promise.resolve(); observed.push(test.tracker.consume(value, signal)); return completed() }
  const outer = context()
  const test = fixture(async (_model, value, options) => {
    if (value !== outer) return direct(value, options!.signal!)
    await direct(context(), options!.signal!) // Native provider hook may issue an independent request.
    await test.agent.streamFunction(model, context(), { signal: new AbortController().signal })
    observed.push(test.tracker.consume(value, options?.signal))
    await direct(value, options!.signal!) // Reusing the original object after consumption grants nothing.
    return completed()
  })
  await direct(context(), test.controller.signal)
  await test.agent.streamFunction(model, outer, { signal: test.controller.signal })
  expect(observed).toEqual(['auxiliary', 'auxiliary', 'auxiliary', 'agent-answer', 'auxiliary'])
})

it.each(['invalidate', 'compaction', 'signal-change', 'abort'] as const)('rechecks %s after native asynchronous setup before provider consumption', async change => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), observed: NativeModelRequestPurpose[] = []
  const original: Stream = async (_model, value, options) => { entered.resolve(); await release.promise; observed.push(test.tracker.consume(value, options?.signal)); return completed() }
  const test = fixture(original), pending = test.agent.streamFunction(model, context(), { signal: test.controller.signal })
  await entered.promise
  if (change === 'invalidate') test.tracker.invalidate()
  if (change === 'compaction') test.flags.auto = true
  if (change === 'signal-change') test.signal(new AbortController().signal)
  if (change === 'abort') test.controller.abort()
  release.resolve(); await pending
  expect(observed).toEqual(['auxiliary'])
})

it('restores the old stream on invalidate and brands only the rebound session, including captured old wrappers', async () => {
  const seen: NativeModelRequestPurpose[] = [], original: Stream = (_model, value, options) => { seen.push(test.tracker.consume(value, options?.signal)); return completed() }
  const test = fixture(original), oldWrapped = test.agent.streamFunction
  test.tracker.invalidate(); expect(test.agent.streamFunction).toBe(original)
  test.tracker.bind(test.session)
  await oldWrapped(model, context(), { signal: test.controller.signal })
  await test.agent.streamFunction(model, context(), { signal: test.controller.signal })
  expect(seen).toEqual(['auxiliary', 'agent-answer'])
})

it('does not overwrite an operator extension replacement when invalidated or rebound', async () => {
  const original = vi.fn<Stream>(() => completed()), replacement = vi.fn<Stream>(() => completed()), test = fixture(original)
  test.agent.streamFunction = replacement
  test.tracker.invalidate(); expect(test.agent.streamFunction).toBe(replacement)
  test.tracker.bind(test.session)
  await test.agent.streamFunction(model, context(), { signal: test.controller.signal })
  expect(original).not.toHaveBeenCalled(); expect(replacement).toHaveBeenCalledOnce()
  test.tracker.invalidate(); expect(test.agent.streamFunction).toBe(replacement)
})

it('isolates simultaneous async calls and does not grant tags to calls after an earlier setup failure', async () => {
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>()), entered = Promise.withResolvers<void>(), seen: NativeModelRequestPurpose[] = []
  let count = 0
  const test = fixture(async (_model, value, options) => {
    const index = count++
    if (count === 3) entered.resolve()
    await gates[index]!.promise
    if (index === 0) throw new Error('native setup failed')
    seen[index] = test.tracker.consume(value, options?.signal)
    return completed()
  })
  const first = test.agent.streamFunction(model, context(), { signal: test.controller.signal }), rejected = expect(first).rejects.toThrow('native setup failed')
  const second = test.agent.streamFunction(model, context(), { signal: new AbortController().signal })
  const third = test.agent.streamFunction(model, context(), { signal: test.controller.signal })
  await entered.promise
  gates[0]!.resolve(); await rejected; gates[2]!.resolve(); await third; gates[1]!.resolve(); await second
  expect(seen[1]).toBe('auxiliary'); expect(seen[2]).toBe('agent-answer')
  expect(test.tracker.consume(context(), test.controller.signal)).toBe('auxiliary')
})

it('propagates the one-shot purpose through real ModelRuntime async setup and IPC, not direct model calls', async () => {
  const actual = await createPiTestModel({ answers: ['answer', 'maintenance', 'direct'] })
  const a = new PassThrough(), b = new PassThrough(), handlers = new Map<string, WorkerHandler>(), hostHandlers = new Map<string, WorkerHandler>(), purposes: unknown[] = [], calls: Context[] = []
  const prepare = vi.fn(({ context: value }: { context: Context }) => ({ context: { ...value, systemPrompt: `${value.systemPrompt}\nPresentation guidance` } }))
  const host = new WorkerPeer(a, b, hostHandlers, () => {})
  const worker = new WorkerPeer(b, a, handlers, () => {})
  cleanups.push(() => { host.close(); worker.close() })
  const test = fixture((_model, value, options) => broker.streamSimple(actual.models[0]!, value, options))
  const broker = await createBrokerModelRuntime(worker, actual.models, handlers, test.tracker)
  const brokerHandler = modelBroker(actual.modelRuntime, actual.models, () => {}, undefined, { prepare })
  // Installing handlers before any request uses the same directional pipe authority as the worker entry.
  hostHandlers.set('model.stream', async (request, call) => {
    const value = request as unknown as { purpose: string, context: Context }; purposes.push(value.purpose); calls.push(value.context)
    return brokerHandler(request, call)
  })
  await (await test.agent.streamFunction(actual.models[0]!, context(), { signal: test.controller.signal })).result()
  test.flags.auto = true
  await (await test.agent.streamFunction(actual.models[0]!, context(), { signal: new AbortController().signal })).result()
  await broker.streamSimple(actual.models[0]!, context(), { signal: test.controller.signal }).result()
  await host.quiesce()
  expect(purposes).toEqual(['agent-answer', 'auxiliary', 'auxiliary'])
  expect(prepare).toHaveBeenCalledOnce(); expect(actual.getCallCount()).toBe(3)
  expect(calls.every(value => value.systemPrompt === 'Native instruction')).toBe(true)
})
