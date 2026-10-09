import { PassThrough } from 'node:stream'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider,
  type AssistantMessageEvent, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { modelBroker, type ModelRequestPolicy, type PreparedModelRequestPolicy } from '../src/worker/model-bridge.js'
import { WorkerPeer, workerJson, type WorkerHandler } from '../src/worker/peer.js'
import { createPiTestModel } from '../src/testing.js'

const peers: WorkerPeer[] = []
afterEach(() => { for (const peer of peers.splice(0)) peer.close() })
function pair(handler: WorkerHandler) {
  const a = new PassThrough(), b = new PassThrough()
  const host = new WorkerPeer(a, b, new Map([['model.stream', handler]]), () => {})
  const worker = new WorkerPeer(b, a, new Map(), () => {})
  peers.push(host, worker)
  return { host, worker }
}
const context: Context = { systemPrompt: 'Native system prompt.', messages: [{ role: 'user', content: 'Question', timestamp: 0 }],
  tools: [{ name: 'read', description: 'Native file reading', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }
const guidance = '\nPresentation: concise.'
const message = () => fauxAssistantMessage('Real answer', { timestamp: 1 })
function events(): AssistantMessageEvent[] {
  return [{ type: 'start', partial: message() }, { type: 'text_delta', contentIndex: 0, delta: 'Real answer', partial: message() },
    { type: 'done', reason: 'stop', message: message() }]
}
function completed() {
  const stream = createAssistantMessageEventStream()
  for (const event of events()) stream.push(event)
  return stream
}
function fixture(policy?: ModelRequestPolicy, options: {
  authorize?: () => void, invoke?: Parameters<typeof modelBroker>[3],
  stream?: (context: Context, options: SimpleStreamOptions) => ReturnType<ModelRuntime['streamSimple']>,
} = {}) {
  const model = fauxProvider().getModel()
  const run = vi.fn((_model: unknown, requestContext: Context, forwarded: SimpleStreamOptions) => options.stream?.(requestContext, forwarded) ?? completed())
  const runtime = { getModel: vi.fn(() => model), stream: vi.fn(run), streamSimple: vi.fn(run) }
  const handler = modelBroker(runtime as unknown as ModelRuntime, [model], options.authorize ?? (() => {}), options.invoke, policy)
  const request = { mode: 'simple', provider: model.provider, model: model.id, context: workerJson(context), options: { maxTokens: 10, temperature: 0.4, reasoning: 'minimal', toolChoice: 'auto' }, purpose: 'agent-answer' }
  return { ...pair(handler), handler, runtime, model, run, request }
}
const append: ModelRequestPolicy = { prepare: input => ({ context: { ...input.context, systemPrompt: input.context.systemPrompt + guidance } }) }

it.each([undefined, 'auxiliary'] as const)('does not personalize a request with purpose %s, even with an authorized policy installed', async purpose => {
  const prepare = vi.fn(append.prepare), test = fixture({ prepare }), progress: unknown[] = []
  await expect(test.worker.call('model.stream', workerJson({ ...test.request, purpose }), { progress: event => progress.push(event) })).resolves.toEqual(message())
  expect(prepare).not.toHaveBeenCalled(); expect(test.run.mock.calls[0]![1]).toEqual(context); expect(progress).toEqual(events())
})

it('rejects unknown purpose values and never treats purpose as host authorization', async () => {
  const prepare = vi.fn(append.prepare), test = fixture({ prepare })
  for (const purpose of ['compaction', 'answer', true, null, {}]) {
    await expect(test.worker.call('model.stream', workerJson({ ...test.request, purpose }))).rejects.toMatchObject({ code: 'invalid' })
  }
  expect(prepare).not.toHaveBeenCalled(); expect(test.run).not.toHaveBeenCalled()
  const denied = fixture({ prepare }, { authorize: () => { throw new Error('denied binding') } })
  await expect(denied.worker.call('model.stream', denied.request)).rejects.toBeDefined()
  expect(prepare).not.toHaveBeenCalled(); expect(denied.run).not.toHaveBeenCalled()
})

it.each(['api', 'simple'] as const)('preserves the native %s path, context, model and options without a policy', async mode => {
  const test = fixture()
  await expect(test.worker.call('model.stream', { ...test.request, mode })).resolves.toEqual(message())
  const selected = mode === 'api' ? test.runtime.stream : test.runtime.streamSimple
  expect(selected).toHaveBeenCalledOnce()
  expect(selected.mock.calls[0]![0]).toBe(test.model)
  expect(selected.mock.calls[0]![1]).toEqual(context)
  expect(selected.mock.calls[0]![2]).toMatchObject(test.request.options)
})

it.each(['api', 'simple'] as const)('appends only ephemeral presentation for %s and gives policy the validated call identity', async mode => {
  let preparedInput: Parameters<ModelRequestPolicy['prepare']>[0] | undefined
  const test = fixture({ prepare: input => {
    preparedInput = input
    return { context: { ...input.context, systemPrompt: input.context.systemPrompt + guidance } }
  } })
  const original = structuredClone(test.request)
  const result = await test.worker.call('model.stream', { ...test.request, mode })
  expect(result).toEqual(message())
  expect(preparedInput?.callId).toMatch(/^[a-f0-9-]{36}:1$/)
  expect(preparedInput?.model).toEqual({ provider: test.model.provider, id: test.model.id })
  expect(Object.keys(preparedInput!)).toEqual(['callId', 'model', 'context', 'signal'])
  expect(test.run.mock.calls[0]![1]).toEqual({ ...context, systemPrompt: context.systemPrompt + guidance })
  expect(test.run.mock.calls[0]![2]).toMatchObject(test.request.options)
  expect(test.request).toEqual(original)
  expect(preparedInput?.context).toEqual(context)
})

it.each([
  ['changing messages', (value: Context) => { value.messages[0] = { role: 'user', content: 'forged', timestamp: 0 } }],
  ['changing tools', (value: Context) => { value.tools![0]!.name = 'forged' }],
  ['removing tools', (value: Context) => { delete value.tools }],
  ['removing messages', (value: Context) => { Reflect.deleteProperty(value, 'messages') }],
  ['dropping prompt', (value: Context) => { delete value.systemPrompt }],
  ['replacing prompt', (value: Context) => { value.systemPrompt = 'forged' }],
  ['adding routing', (value: Context) => { Object.assign(value, { model: 'forged' }) }],
  ['invalid prompt', (value: Context) => { Object.assign(value, { systemPrompt: 123 }) }],
  ['oversized UTF8 append', (value: Context) => { value.systemPrompt += '字'.repeat(2731) }],
] as const)('rejects policy %s before any model call and still closes it', async (_name, mutate) => {
  const close = vi.fn(), test = fixture({ prepare: input => { mutate(input.context); return { context: input.context, close } } })
  await expect(test.worker.call('model.stream', test.request)).rejects.toMatchObject({ code: 'denied' })
  expect(test.run).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
  expect(test.request.context).toEqual(context)
})

it('accepts an exactly 8192-byte append and an originally absent prompt, but rejects adding absent tools', async () => {
  const test = fixture({ prepare: input => ({ context: { ...input.context, systemPrompt: (input.context.systemPrompt ?? '') + 'x'.repeat(8192) } }) })
  await expect(test.worker.call('model.stream', { ...test.request, context: { messages: [] } })).resolves.toEqual(message())
  expect(test.run.mock.calls[0]![1]).toEqual({ messages: [], systemPrompt: 'x'.repeat(8192) })
  const addedTools = fixture({ prepare: input => ({ context: { ...input.context, tools: [] } }) })
  await expect(addedTools.worker.call('model.stream', { ...addedTools.request, context: { messages: [] } })).rejects.toMatchObject({ code: 'denied' })
})

it('does not accept a worker-supplied policy or call identity', async () => {
  const prepare = vi.fn(append.prepare), test = fixture({ prepare })
  for (const extra of [{ policy: {} }, { callId: 'forged' }, { presentation: {} }]) {
    await expect(test.worker.call('model.stream', { ...test.request, ...extra })).rejects.toMatchObject({ code: 'invalid' })
  }
  expect(prepare).not.toHaveBeenCalled(); expect(test.run).not.toHaveBeenCalled()
})

it('takes independent context/event/result snapshots and observes only real events before forwarding', async () => {
  const order: string[] = [], output: unknown[] = []
  let policyContext: Context | undefined
  const close = vi.fn(() => { order.push('close') })
  const test = fixture({ prepare: input => {
    policyContext = { ...input.context, systemPrompt: input.context.systemPrompt + guidance }
    return { context: policyContext, close,
      onEvent: event => { order.push(`observe:${event.type}`); if (event.type === 'text_delta') event.delta = 'forged'; if (event.type === 'done') event.message.content = [] },
      onResult: result => { order.push('result'); result.content = [] },
    }
  } }, { stream: received => { policyContext!.systemPrompt = 'late mutation'; expect(received.systemPrompt).toBe(context.systemPrompt + guidance); return completed() } })
  await expect(test.worker.call('model.stream', test.request, { progress: value => {
    output.push(value); order.push(`forward:${(value as { type: string }).type}`)
  } })).resolves.toEqual(message())
  expect(output).toEqual(events())
  expect(order).toEqual(['observe:start', 'forward:start', 'observe:text_delta', 'forward:text_delta', 'observe:done', 'result', 'forward:done', 'close'])
  expect(close).toHaveBeenCalledOnce()
})

it.each(['cancel', 'revoke', 'authorization'] as const)('checks %s after awaited prepare without fallback or a model request', async operation => {
  const entered = Promise.withResolvers<void>(), prepared = Promise.withResolvers<PreparedModelRequestPolicy>(), close = vi.fn()
  const caller = new AbortController(), policySignal = new AbortController()
  let authorized = true
  const test = fixture({ prepare: () => { entered.resolve(); return prepared.promise } }, { authorize: () => { if (!authorized) throw new Error('revoked') } })
  const work = test.worker.call('model.stream', test.request, { signal: caller.signal, awaitCancellation: true })
  const rejected = expect(work).rejects.toBeDefined()
  await entered.promise
  if (operation === 'cancel') caller.abort()
  else if (operation === 'revoke') policySignal.abort()
  else authorized = false
  prepared.resolve({ context: structuredClone(context), signal: policySignal.signal, close })
  await rejected
  expect(test.run).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
})

it('never retries unpersonalized when preparation fails, and releases its capacity', async () => {
  let fail = true
  const prepare = vi.fn(async (input: Parameters<ModelRequestPolicy['prepare']>[0]) => {
    if (fail) throw new Error('policy failed')
    return { context: input.context }
  })
  const test = fixture({ prepare })
  for (let count = 0; count < 5; count++) await expect(test.worker.call('model.stream', test.request)).rejects.toMatchObject({ code: 'failed' })
  expect(test.run).not.toHaveBeenCalled(); expect(prepare).toHaveBeenCalledTimes(5)
  fail = false
  await expect(test.worker.call('model.stream', test.request)).resolves.toEqual(message())
  expect(test.run).toHaveBeenCalledOnce()
})

it('joins actual model result before closing after an observer failure', async () => {
  const result = Promise.withResolvers<ReturnType<typeof message>>(), observed = Promise.withResolvers<void>(), close = vi.fn()
  const stream = completed(); vi.spyOn(stream, 'result').mockReturnValue(result.promise)
  let modelSignal: AbortSignal | undefined
  const test = fixture({ prepare: input => ({ context: input.context, close, onEvent: () => { observed.resolve(); throw new Error('observer rejected') } }) },
    { stream: (_context, options) => { modelSignal = options.signal; return stream } })
  const pending = test.worker.call('model.stream', test.request), rejected = expect(pending).rejects.toBeDefined()
  await observed.promise
  await vi.waitFor(() => expect(modelSignal?.aborted).toBe(true))
  expect(close).not.toHaveBeenCalled(); expect(test.host.activeCount).toBe(1)
  result.resolve(message()); await rejected
  expect(close).toHaveBeenCalledOnce()
})

it('holds terminal progress until actual result and asynchronous result observation join', async () => {
  const joined = Promise.withResolvers<ReturnType<typeof message>>(), observed = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const stream = completed(); vi.spyOn(stream, 'result').mockReturnValue(joined.promise)
  const progress: unknown[] = [], close = vi.fn()
  const test = fixture({ prepare: input => ({ context: input.context, close, onResult: async () => { observed.resolve(); await finish.promise } }) }, { stream: () => stream })
  const work = test.worker.call('model.stream', test.request, { progress: value => progress.push(value) })
  await vi.waitFor(() => expect(progress).toHaveLength(2))
  expect(close).not.toHaveBeenCalled()
  joined.resolve(message()); await observed.promise
  expect(progress).toHaveLength(2); expect(close).not.toHaveBeenCalled()
  finish.resolve(); await expect(work).resolves.toEqual(message())
  expect(progress).toEqual(events()); expect(close).toHaveBeenCalledOnce()
})

it('rechecks policy revocation after actual result join without running result observation or exposing done', async () => {
  const joined = Promise.withResolvers<ReturnType<typeof message>>(), entered = Promise.withResolvers<void>(), revoked = new AbortController()
  const stream = completed(); vi.spyOn(stream, 'result').mockImplementation(() => { entered.resolve(); return joined.promise })
  const progress: unknown[] = [], onResult = vi.fn(), close = vi.fn()
  const test = fixture({ prepare: input => ({ context: input.context, signal: revoked.signal, onResult, close }) }, { stream: () => stream })
  const work = test.worker.call('model.stream', test.request, { progress: value => progress.push(value) }), rejected = expect(work).rejects.toBeDefined()
  await entered.promise; revoked.abort()
  expect(close).not.toHaveBeenCalled()
  joined.resolve(message()); await rejected
  expect(progress).toHaveLength(2); expect(onResult).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
})

it('observes real error results without inventing answer text or successful completion', async () => {
  const error = fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'test provider failed' }), seen: AssistantMessageEvent[] = []
  const onResult = vi.fn(), test = fixture({ prepare: input => ({ context: input.context, onEvent: event => { seen.push(event) }, onResult }) },
    { stream: () => { const stream = createAssistantMessageEventStream(); stream.push({ type: 'error', reason: 'error', error }); return stream } })
  await expect(test.worker.call('model.stream', test.request)).resolves.toEqual(error)
  expect(seen).toEqual([{ type: 'error', reason: 'error', error }]); expect(onResult).toHaveBeenCalledWith(error)
})

it.each(['event', 'result'] as const)('rechecks policy revocation after awaited %s observation and never forwards terminal completion', async phase => {
  const observed = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), revoked = new AbortController(), close = vi.fn(), progress: unknown[] = []
  const observe = async () => { observed.resolve(); await finish.promise }
  const test = fixture({ prepare: input => ({ context: input.context, signal: revoked.signal, close,
    ...(phase === 'event' ? { onEvent: observe } : { onResult: observe }) }) })
  const work = test.worker.call('model.stream', test.request, { progress: value => progress.push(value) }), rejected = expect(work).rejects.toBeDefined()
  await observed.promise; revoked.abort(); finish.resolve(); await rejected
  expect(progress).toHaveLength(phase === 'event' ? 0 : 2)
  expect(test.run).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
})

it('rechecks authority after asynchronous yield before observing further events', async () => {
  const controller = new AbortController(), observed: string[] = []
  const test = fixture({ prepare: input => ({ context: input.context, signal: controller.signal, onEvent: event => { observed.push(event.type) } }) })
  await expect(test.handler(workerJson(test.request), { id: '00000000-0000-4000-8000-000000000000:1', signal: new AbortController().signal,
    yield: async () => { await Promise.resolve(); controller.abort() } })).rejects.toBeDefined()
  expect(observed).toEqual(['start'])
})

it('preserves payload and response hooks, including real guidance and only safe response metadata', async () => {
  const seen: unknown[] = [], hook = '00000000-0000-4000-8000-000000000000'
  const invoke = vi.fn<NonNullable<Parameters<typeof modelBroker>[3]>>(async (method, value) => {
    seen.push({ method, value }); return (value as { value: ReturnType<typeof workerJson> }).value
  })
  const test = fixture(append, { invoke, stream: (received, options) => {
    const stream = createAssistantMessageEventStream()
    void (async () => {
      const payload = { model: 'approved', system: received.systemPrompt, messages: received.messages }
      expect(await options.onPayload!(payload, test.model)).toEqual(payload)
      await options.onResponse!({ status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'safe', authorization: 'private', 'set-cookie': 'private' } }, test.model)
      for (const event of events()) stream.push(event)
    })().catch(error => { const failed = fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }); stream.push({ type: 'error', reason: 'error', error: failed }) })
    return stream
  } })
  await expect(test.worker.call('model.stream', { ...test.request, hooks: { payload: hook, response: hook } })).resolves.toEqual(message())
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(seen).toEqual([
    { method: 'model.payload', value: { hook, value: { model: 'approved', system: context.systemPrompt + guidance, messages: context.messages } } },
    { method: 'model.response', value: { hook, value: { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'safe' } } } },
  ])
})

it.each(['payload', 'response'] as const)('rechecks revocation after the asynchronous %s hook', async hookName => {
  const invoked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), revoked = new AbortController(), close = vi.fn()
  const hook = '00000000-0000-4000-8000-000000000000', progress: unknown[] = []
  const invoke = vi.fn<NonNullable<Parameters<typeof modelBroker>[3]>>(async (_method, value) => { invoked.resolve(); await release.promise; return (value as { value: ReturnType<typeof workerJson> }).value })
  const afterHook = vi.fn()
  const test = fixture({ prepare: input => ({ context: input.context, signal: revoked.signal, close }) }, { invoke, stream: (_context, options) => {
    const stream = createAssistantMessageEventStream()
    void (async () => {
      if (hookName === 'payload') await options.onPayload!({ model: test.model.id }, test.model)
      else await options.onResponse!({ status: 200, headers: {} }, test.model)
      afterHook()
      for (const event of events()) stream.push(event)
    })().catch(() => { const error = fauxAssistantMessage('', { stopReason: 'aborted' }); stream.push({ type: 'error', reason: 'aborted', error }) })
    return stream
  } })
  const work = test.worker.call('model.stream', { ...test.request, hooks: { [hookName]: hook } }, { progress: value => progress.push(value) }), rejected = expect(work).rejects.toBeDefined()
  await invoked.promise; revoked.abort(); release.resolve(); await rejected
  expect(progress).toEqual([]); expect(afterHook).not.toHaveBeenCalled(); expect(test.run).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
})

it.each(['prepare', 'join', 'close'] as const)('retains the four-request capacity during %s and recovers only after release', async phase => {
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let count = 0
  const mark = () => { if (++count === 4) entered.resolve() }
  const test = fixture({ prepare: async input => {
    if (phase === 'prepare') { mark(); await release.promise }
    return { context: input.context, close: async () => { if (phase === 'close') { mark(); await release.promise } } }
  } }, { stream: () => {
    const stream = completed()
    if (phase === 'join') vi.spyOn(stream, 'result').mockImplementation(async () => { mark(); await release.promise; return message() })
    return stream
  } })
  const work = Array.from({ length: 4 }, () => test.worker.call('model.stream', test.request))
  await entered.promise
  await expect(test.worker.call('model.stream', test.request)).rejects.toMatchObject({ code: 'limit' })
  expect(test.run).toHaveBeenCalledTimes(phase === 'prepare' ? 0 : 4)
  release.resolve(); await Promise.all(work)
  await expect(test.worker.call('model.stream', test.request)).resolves.toEqual(message())
})

it('cancels only the selected call, joins its real result, then closes its policy', async () => {
  const joined = Promise.withResolvers<ReturnType<typeof message>>(), called = Promise.withResolvers<void>(), close = vi.fn(), caller = new AbortController()
  const waiting = createAssistantMessageEventStream(); vi.spyOn(waiting, 'result').mockReturnValue(joined.promise)
  let first = true, signal: AbortSignal | undefined
  const test = fixture({ prepare: input => ({ context: input.context, close }) }, { stream: (_context, options) => {
    if (!first) return completed()
    first = false; signal = options.signal; called.resolve()
    signal?.addEventListener('abort', () => { waiting.end(message()) }, { once: true })
    return waiting
  } })
  const work = test.worker.call('model.stream', test.request, { signal: caller.signal, awaitCancellation: true }), rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' })
  await called.promise; caller.abort()
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  expect(close).not.toHaveBeenCalled()
  await expect(test.worker.call('model.stream', test.request)).resolves.toEqual(message())
  expect(close).toHaveBeenCalledOnce()
  joined.resolve(message()); await rejected
  expect(close).toHaveBeenCalledTimes(2)
})

it.each(['api', 'simple'] as const)('runs the policy through a real in-memory Pi ModelRuntime %s provider', async mode => {
  const actual = await createPiTestModel({ answers: ['Real native response'], inspectMessages: messages => expect(messages).toEqual(context.messages) })
  const observed: string[] = [], closed = vi.fn()
  const handler = modelBroker(actual.modelRuntime, actual.models, () => {}, undefined, { prepare: input => ({ context: { ...input.context, systemPrompt: input.context.systemPrompt + guidance },
    onEvent: event => { observed.push(event.type) }, onResult: result => { expect(result.content[0]).toMatchObject({ type: 'text', text: 'Real native response' }) }, close: closed }) })
  const { worker } = pair(handler), model = actual.models[0]!
  await expect(worker.call('model.stream', workerJson({ provider: model.provider, model: model.id, mode, context, options: {}, purpose: 'agent-answer' }))).resolves.toMatchObject({ stopReason: 'stop' })
  expect(actual.getCallCount()).toBe(1); expect(observed).toContain('text_delta'); expect(observed.at(-1)).toBe('done'); expect(closed).toHaveBeenCalledOnce()
})
