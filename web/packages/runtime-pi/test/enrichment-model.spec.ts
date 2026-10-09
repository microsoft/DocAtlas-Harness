import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from '@earendil-works/pi-ai'
import { createEnrichmentModel } from '../src/enrichment-model.js'
import { createPiTestModel } from '../src/testing.js'

const limits = { maxTokens: 256, maxChars: 1024 }
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network disabled in enrichment adapter tests') }) })
afterEach(() => { vi.restoreAllMocks() })

async function controlled() {
  const fixture = await createPiTestModel({ answers: [] }), stream = createAssistantMessageEventStream()
  const call = vi.spyOn(fixture.modelRuntime, 'streamSimple').mockReturnValue(stream), authorize = vi.fn()
  const port = createEnrichmentModel(fixture.modelRuntime, fixture.models[0]!, authorize)
  return { ...fixture, stream, call, authorize, port }
}

describe('Pi one-shot enrichment model adapter (transport, not answer quality)', () => {
  it('makes one native model request with one user message, no tools or system prompt, and bounded options', async () => {
    const fixture = await createPiTestModel({ answers: ['{"summary":"导航，不是证据。"}'] })
    const call = vi.spyOn(fixture.modelRuntime, 'streamSimple'), authorize = vi.fn(), model = fixture.models[0]!
    const port = createEnrichmentModel(fixture.modelRuntime, model, authorize)
    const result = await port.complete('Summarize this quoted source.', limits, new AbortController().signal)
    expect(port.identity).toEqual({ provider: model.provider, model: model.id })
    expect(result.text).toBe('{"summary":"导航，不是证据。"}')
    expect(result.inputTokens).toBeGreaterThan(0); expect(result.outputTokens).toBeGreaterThan(0)
    expect(call).toHaveBeenCalledTimes(1); expect(fixture.getCallCount()).toBe(1)
    const [selected, context, options] = call.mock.calls[0]!
    expect(selected).toBe(model)
    expect(context).toEqual({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this quoted source.' }], timestamp: expect.any(Number) }] })
    expect(options).toMatchObject({ maxTokens: 256, reasoning: 'minimal', maxRetryDelayMs: 0, timeoutMs: 60000 })
    expect(options?.signal?.aborted).toBe(true)
    expect(authorize.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not release a cancelled call until the provider result has joined', async () => {
    const fixture = await controlled(), controller = new AbortController(), started = Promise.withResolvers<void>()
    const joining = Promise.withResolvers<void>(), joined = Promise.withResolvers<AssistantMessage>()
    fixture.authorize.mockImplementation(() => { if (fixture.authorize.mock.calls.length > 1) started.resolve() })
    const resultRead = vi.spyOn(fixture.stream, 'result').mockImplementation(() => { joining.resolve(); return joined.promise })
    let settled = false
    const outcome = fixture.port.complete('source', limits, controller.signal).then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
    fixture.stream.push({ type: 'start', partial: fauxAssistantMessage('') })
    await started.promise
    controller.abort()
    fixture.stream.push({ type: 'text_delta', contentIndex: 0, delta: 'late', partial: fauxAssistantMessage('late') })
    await joining.promise
    expect(settled).toBe(false)
    expect(fixture.call.mock.calls[0]![2]?.signal?.aborted).toBe(true)
    const final = fauxAssistantMessage('', { stopReason: 'aborted' })
    fixture.stream.end(final); joined.resolve(final)
    expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
    expect(resultRead).toHaveBeenCalledTimes(1); expect(fixture.call).toHaveBeenCalledTimes(1)
  })

  it('rejects unfinished/error stops and tool calls even when the provider labels them stop', async () => {
    const invalid = [
      ...(['length', 'toolUse', 'error', 'aborted', 'pending', 'deferred'] as const).map(stopReason => fauxAssistantMessage('not a completed summary', { stopReason })),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'must never run' }), { stopReason: 'stop' }),
    ]
    for (const result of invalid) {
      const fixture = await controlled()
      fixture.stream.end(result)
      await expect(fixture.port.complete('source', limits, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-output' })
      expect(fixture.call).toHaveBeenCalledTimes(1)
      expect(fixture.getCallCount()).toBe(0)
    }
  })

  it('checks cumulative streamed and authoritative final Unicode output budgets, joining on overflow', async () => {
    const fixture = await controlled(), joining = Promise.withResolvers<void>(), joined = Promise.withResolvers<AssistantMessage>()
    vi.spyOn(fixture.stream, 'result').mockImplementation(() => { joining.resolve(); return joined.promise })
    let settled = false
    const outcome = fixture.port.complete('source', { ...limits, maxChars: 2 }, new AbortController().signal)
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
    fixture.stream.push({ type: 'start', partial: fauxAssistantMessage('') })
    fixture.stream.push({ type: 'text_delta', contentIndex: 0, delta: '🙂', partial: fauxAssistantMessage('🙂') })
    fixture.stream.push({ type: 'text_delta', contentIndex: 0, delta: '中文', partial: fauxAssistantMessage('🙂中文') })
    await joining.promise
    expect(settled).toBe(false); expect(fixture.call.mock.calls[0]![2]?.signal?.aborted).toBe(true)
    const final = fauxAssistantMessage('🙂中文'); fixture.stream.end(final); joined.resolve(final)
    expect(await outcome).toMatchObject({ error: { code: 'budget-exceeded' } })

    const finalOnly = await controlled(); finalOnly.stream.end(final)
    await expect(finalOnly.port.complete('source', { ...limits, maxChars: 2 }, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
    const exact = await controlled(); exact.stream.end(final)
    await expect(exact.port.complete('source', { ...limits, maxChars: 3 }, new AbortController().signal)).resolves.toMatchObject({ text: '🙂中文' })
  })

  it('rechecks authority on events and after the final async result instead of publishing a revoked result', async () => {
    const event = await controlled(), denied = new Error('scope revoked')
    event.authorize.mockImplementationOnce(() => {}).mockImplementation(() => { throw denied })
    const final = fauxAssistantMessage('must not publish')
    event.stream.push({ type: 'start', partial: final }); event.stream.end(final)
    await expect(event.port.complete('source', limits, new AbortController().signal)).rejects.toBe(denied)
    expect(event.call.mock.calls[0]![2]?.signal?.aborted).toBe(true)

    const completed = await controlled(), originalResult = completed.stream.result.bind(completed.stream)
    completed.stream.end(final)
    vi.spyOn(completed.stream, 'result').mockImplementation(async () => {
      const result = await originalResult(); completed.authorize.mockImplementation(() => { throw denied }); return result
    })
    await expect(completed.port.complete('source', limits, new AbortController().signal)).rejects.toBe(denied)
    expect(completed.call).toHaveBeenCalledTimes(1)
    expect(completed.call.mock.calls[0]![2]?.signal?.aborted).toBe(true)
  })

  it('does not contact a provider for denied, cancelled, or over-budget requests', async () => {
    const fixture = await controlled(), denied = new Error('not authorized')
    fixture.authorize.mockImplementationOnce(() => { throw denied })
    await expect(fixture.port.complete('source', limits, new AbortController().signal)).rejects.toBe(denied)
    await expect(fixture.port.complete('source', limits, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    for (const [prompt, budget] of [
      ['source', { ...limits, maxTokens: fixture.models[0]!.maxTokens + 1 }],
      ['source', { ...limits, maxChars: 100001 }],
      ['x'.repeat(1200001), limits],
    ] as const) await expect(fixture.port.complete(prompt, budget, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
    expect(fixture.call).not.toHaveBeenCalled(); expect(fixture.getCallCount()).toBe(0)
  })

  it('keeps two independent native model streams owned until each actual result promise joins', async () => {
    const fixture = await createPiTestModel({ answers: [] }), streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()] as const
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const, joined = [Promise.withResolvers<AssistantMessage>(), Promise.withResolvers<AssistantMessage>()] as const
    for (const index of [0, 1] as const) vi.spyOn(streams[index], 'result').mockImplementation(() => { entered[index].resolve(); return joined[index].promise })
    const calls = vi.spyOn(fixture.modelRuntime, 'streamSimple').mockReturnValueOnce(streams[0]).mockReturnValueOnce(streams[1])
    const port = createEnrichmentModel(fixture.modelRuntime, fixture.models[0]!, () => {}), cancelled = new AbortController(), healthy = new AbortController()
    const settled = [false, false]
    const first = port.complete('independent source A', { maxTokens: 128, maxChars: 512 }, cancelled.signal)
      .then(value => ({ value }), error => ({ error })).finally(() => { settled[0] = true })
    const second = port.complete('independent source B', limits, healthy.signal)
      .then(value => ({ value }), error => ({ error })).finally(() => { settled[1] = true })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls.mock.calls.map(call => call[1].messages[0]?.content)).toEqual([[{ type: 'text', text: 'independent source A' }], [{ type: 'text', text: 'independent source B' }]])
    expect(calls.mock.calls.map(call => call[2]?.maxTokens)).toEqual([128, 256])
    streams[0].push({ type: 'start', partial: fauxAssistantMessage('') }); streams[1].push({ type: 'start', partial: fauxAssistantMessage('') })
    cancelled.abort(); streams[0].push({ type: 'text_delta', contentIndex: 0, delta: 'late', partial: fauxAssistantMessage('late') })
    const successful = fauxAssistantMessage('{"summary":"B navigation"}'); streams[1].end(successful)
    await Promise.all(entered.map(value => value.promise))
    expect(settled).toEqual([false, false]); expect(calls.mock.calls[0]![2]?.signal?.aborted).toBe(true); expect(calls.mock.calls[1]![2]?.signal?.aborted).toBe(false)
    joined[1].resolve(successful)
    expect(await second).toMatchObject({ value: { text: '{"summary":"B navigation"}' } })
    expect(settled).toEqual([false, true]); expect(calls.mock.calls[1]![2]?.signal?.aborted).toBe(true)
    const aborted = fauxAssistantMessage('', { stopReason: 'aborted' }); streams[0].end(aborted); joined[0].resolve(aborted)
    expect(await first).toMatchObject({ error: { name: 'AbortError' } }); expect(settled).toEqual([true, true])
    expect(calls).toHaveBeenCalledTimes(2); expect(fixture.getCallCount()).toBe(0)
  })
})
