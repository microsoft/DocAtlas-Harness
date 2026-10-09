import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore,
  type Api, type Model, type Context, type SimpleStreamOptions, type ApiStreamOptions, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { WorkerJson } from '@docatlas/contracts'
import { WorkerPeer, WorkerRpcError, workerJson, type WorkerHandler } from './peer.js'
import type { NativeModelPurpose } from './model-purpose.js'

/** Host-owned, ephemeral presentation policy. RPC identity is correlation, not authority. */
export interface ModelRequestPolicy {
  prepare(input: { callId: string, model: { provider: string, id: string }, context: Context, signal: AbortSignal }): PreparedModelRequestPolicy | Promise<PreparedModelRequestPolicy>
}
export interface PreparedModelRequestPolicy {
  context: Context
  signal?: AbortSignal
  /** Independent snapshots of genuine observations; awaited before corresponding completion. */
  onEvent?(event: AssistantMessageEvent): void | Promise<void>
  onResult?(result: AssistantMessage): void | Promise<void>
  /** Resource release after result joins, also on failure. Commit/authorization belongs in observers. */
  close?(): void | Promise<void>
}

/** Only public capabilities cross the boundary. The broker always resolves the original host model. */
export function brokerCatalog(models: readonly Model<Api>[]): Model<Api>[] {
  return models.map(model => ({ id: model.id, name: model.name, api: model.api, provider: model.provider,
    baseUrl: 'http://docatlas-model-broker.invalid', reasoning: model.reasoning, input: [...model.input],
    cost: structuredClone(model.cost), contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: structuredClone(model.thinkingLevelMap) } : {}) }))
}

export function modelBroker(runtime: ModelRuntime, models: readonly Model<Api>[], authorize: () => void,
  invoke?: (method: string, value: WorkerJson, signal: AbortSignal) => Promise<WorkerJson>, policy?: ModelRequestPolicy): WorkerHandler {
  const allowed = new Set(models.map(model => `${model.provider}\0${model.id}`))
  let active = 0
  return async (candidate, call) => {
    const request = record(candidate)
    if (Object.keys(request).some(key => !['provider', 'model', 'context', 'options', 'mode', 'hooks', 'purpose'].includes(key)) || typeof request.provider !== 'string' || typeof request.model !== 'string' || !['api', 'simple'].includes(String(request.mode))
      || (request.purpose !== undefined && request.purpose !== 'agent-answer' && request.purpose !== 'auxiliary')) throw new WorkerRpcError('invalid')
    authorize()
    if (!allowed.has(`${request.provider}\0${request.model}`)) throw new WorkerRpcError('denied')
    const model = runtime.getModel(request.provider, request.model)
    if (!model || active >= 4) throw new WorkerRpcError('limit')
    const context = record(request.context)
    if (!Array.isArray(context.messages) || Object.keys(context).some(key => !['systemPrompt', 'messages', 'tools'].includes(key))) throw new WorkerRpcError('invalid')
    const options = safeOptions(request.options, model.maxTokens)
    active++
    const controller = new AbortController()
    let stream: ReturnType<ModelRuntime['streamSimple']> | undefined
    let prepared: PreparedModelRequestPolicy | undefined
    try {
      let signal = AbortSignal.any([call.signal, controller.signal, AbortSignal.timeout(300000)])
      const check = () => { signal.throwIfAborted(); authorize(); signal.throwIfAborted() }
      const hooks = record(request.hooks ?? {})
      if (Object.keys(hooks).some(key => !['payload', 'response'].includes(key)) || Object.values(hooks).some(value => typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))) throw new WorkerRpcError('invalid')
      if (Object.keys(hooks).length && !invoke) throw new WorkerRpcError('denied')
      check()
      let hostContext = context as unknown as Context
      // Purpose correlates the native execution path; existing host authorization still governs every call.
      // Legacy/unknown-origin requests are auxiliary, never silently personalized.
      if (policy && request.purpose === 'agent-answer') {
        // Policy never receives the worker's context object or model routing/credentials.
        const original = structuredClone(hostContext)
        prepared = await policy.prepare({ callId: call.id, model: { provider: model.provider, id: model.id }, context: structuredClone(original), signal })
        if (prepared.signal) signal = AbortSignal.any([signal, prepared.signal])
        check()
        hostContext = presentationContext(original, prepared.context)
      }
      const forwarded: SimpleStreamOptions = { ...options, signal,
        ...(hooks.payload ? { onPayload: async (payload: unknown) => {
          check()
          const input = workerJson(payload), result = await invoke!('model.payload', { hook: hooks.payload!, value: input }, signal)
          check()
          if (typeof input === 'object' && input && !Array.isArray(input)) {
            if (typeof result !== 'object' || !result || Array.isArray(result)) throw new WorkerRpcError('denied')
            for (const key of ['model', 'apiKey', 'api_key', 'baseUrl', 'base_url', 'endpoint', 'headers']) if (JSON.stringify(input[key]) !== JSON.stringify(result[key])) throw new WorkerRpcError('denied')
          }
          return result
        } } : {}),
        ...(hooks.response ? { onResponse: async response => {
          check()
          // Response cookies/auth never cross into runtime code. Telemetry gets only safe transport metadata.
          const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => /^(content-type|request-id|x-request-id|x-ratelimit-[a-z-]+)$/i.test(key)))
          await invoke!('model.response', { hook: hooks.response!, value: { status: response.status, headers } }, signal)
          check()
        } } : {}),
      }
      check()
      stream = request.mode === 'api' ? runtime.stream(model, hostContext, forwarded as ApiStreamOptions<Api>) : runtime.streamSimple(model, hostContext, forwarded)
      let terminal: WorkerJson | undefined
      for await (const event of stream) {
        check()
        if (prepared?.onEvent) { await prepared.onEvent(structuredClone(event)); check() }
        // Pi settles on terminal progress, before RPC return. Hold it until policy observation joins.
        if (prepared && (event.type === 'done' || event.type === 'error')) {
          if (terminal !== undefined) throw new WorkerRpcError('invalid')
          terminal = workerJson(event)
        } else { await call.yield(workerJson(event)); check() }
      }
      check()
      const result = await stream.result()
      check()
      if (prepared?.onResult) { await prepared.onResult(structuredClone(result)); check() }
      if (terminal !== undefined) { await call.yield(terminal); check() }
      return workerJson(result)
    } finally {
      controller.abort()
      try { await stream?.result() }
      finally { try { await prepared?.close?.() } finally { active-- } }
    }
  }
}

function presentationContext(original: Context, candidate: Context): Context {
  const next = record(structuredClone(candidate) as unknown as WorkerJson)
  if (Object.keys(next).some(key => !['systemPrompt', 'messages', 'tools'].includes(key))) throw new WorkerRpcError('denied')
  for (const key of ['messages', 'tools'] as const) {
    if (Object.hasOwn(original, key) !== Object.hasOwn(next, key) || JSON.stringify(original[key]) !== JSON.stringify(next[key])) throw new WorkerRpcError('denied')
  }
  if ((original.systemPrompt !== undefined && typeof original.systemPrompt !== 'string') || (next.systemPrompt !== undefined && typeof next.systemPrompt !== 'string')) throw new WorkerRpcError('denied')
  const before = original.systemPrompt ?? '', after = (next.systemPrompt ?? '') as string
  if (!after.startsWith(before) || Buffer.byteLength(after.slice(before.length), 'utf8') > 8192) throw new WorkerRpcError('denied')
  return next as unknown as Context
}

export async function createBrokerModelRuntime(peer: WorkerPeer, catalog: readonly Model<Api>[], handlers: Map<string, WorkerHandler>, purposes?: NativeModelPurpose): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false })
  const callbacks = new Map<string, (value: WorkerJson) => Promise<WorkerJson>>()
  const callback: WorkerHandler = async candidate => {
    const value = record(candidate), fn = typeof value.hook === 'string' ? callbacks.get(value.hook) : undefined
    if (!fn || value.value === undefined) throw new WorkerRpcError('denied')
    return fn(value.value)
  }
  handlers.set('model.payload', callback); handlers.set('model.response', callback)
  const stream = (mode: 'api' | 'simple', model: Model<Api>, context: Context, options?: SimpleStreamOptions | ApiStreamOptions<Api>) => {
    const purpose = purposes?.consume(context, options?.signal) ?? 'auxiliary'
    const output = createAssistantMessageEventStream()
    const sent = transportOptions(options)
    const hooks: Record<string, string> = {}
    if (options?.onPayload) { const id = randomUUID(); hooks.payload = id; callbacks.set(id, async payload => { const result = await options.onPayload!(payload, model); return workerJson(result === undefined ? payload : result) }) }
    if (options?.onResponse) { const id = randomUUID(); hooks.response = id; callbacks.set(id, async value => { await options.onResponse!(value as never, model); return null }) }
    void peer.call('model.stream', workerJson({ mode, provider: model.provider, model: model.id, context, options: sent, hooks, purpose }), {
      ...(options?.signal ? { signal: options.signal } : {}), progress: value => { output.push(value as unknown as AssistantMessageEvent) },
    }).then(value => { output.end(value as unknown as AssistantMessage) }, () => {
      const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: 'Host model broker did not complete the request', timestamp: Date.now() }
      output.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message }); output.end(message)
    }).finally(() => { for (const id of Object.values(hooks)) callbacks.delete(id) })
    return output
  }
  for (const provider of new Set(catalog.map(model => model.provider))) runtime.registerNativeProvider({ id: provider, name: provider,
    auth: { apiKey: { name: 'Host-managed model broker', resolve: async () => ({ auth: {} }) } },
    getModels: () => catalog.filter(model => model.provider === provider), stream: (model, context, options) => stream('api', model, context, options), streamSimple: (model, context, options) => stream('simple', model, context, options) })
  await runtime.getAvailable()
  return runtime
}

const optionNames = new Set(['temperature', 'maxTokens', 'reasoning', 'thinkingBudgets', 'cacheRetention', 'sessionId', 'maxRetryDelayMs', 'samplingParams', 'toolChoice', 'transport', 'timeoutMs'])
const localOptions = new Set(['signal', 'model', 'onPayload', 'onResponse', 'toolExecution', 'beforeToolCall', 'afterToolCall', 'prepareNextTurn', 'convertToLlm', 'transformContext', 'getSteeringMessages', 'getFollowUpMessages'])
function transportOptions(options: SimpleStreamOptions | ApiStreamOptions<Api> | undefined): WorkerJson {
  const entries = Object.entries(options ?? {}).filter(([key, value]) => !localOptions.has(key) && value !== undefined && !(key === 'headers' && value && typeof value === 'object' && Object.keys(value).length === 0))
  if (entries.some(([key, value]) => !optionNames.has(key) || typeof value === 'function')) {
    throw new WorkerRpcError('denied')
  }
  return workerJson(Object.fromEntries(entries))
}
function safeOptions(value: WorkerJson | undefined, maximum: number): SimpleStreamOptions {
  const options = record(value ?? {})
  if (Object.keys(options).some(key => !optionNames.has(key))) throw new WorkerRpcError('denied')
  if (options.maxTokens !== undefined && (typeof options.maxTokens !== 'number' || !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > maximum)) throw new WorkerRpcError('limit')
  if (options.samplingParams !== undefined) {
    const sampling = record(options.samplingParams)
    for (const [key, item] of Object.entries(sampling)) if (!['top_p', 'top_k', 'min_p', 'repetition_penalty', 'frequency_penalty', 'presence_penalty', 'seed'].includes(key) || typeof item !== 'number' || !Number.isFinite(item)) throw new WorkerRpcError('denied')
  }
  return options as unknown as SimpleStreamOptions
}
export function record(value: WorkerJson | undefined): { [key: string]: WorkerJson } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkerRpcError('invalid')
  return value
}
