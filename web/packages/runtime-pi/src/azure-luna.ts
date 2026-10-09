import { execFile } from 'node:child_process'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type StreamOptions } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

export const AZURE_LUNA_ENDPOINT = 'https://libei-foundry-eastus2.openai.azure.com/openai/v1'
const PROVIDER = 'docatlas-azure-luna', MODEL = 'gpt-5.6-luna'
const safeError = () => new Error('Azure Luna request unavailable; check host authentication and deployment configuration')
export interface AzureLunaOptions {
  endpoint?: string
  /** Host-only injection. Never send this callback, its output, or a real endpoint to the worker. */
  token?: (signal?: AbortSignal) => Promise<string>
  /** Host-only transport injection for offline tests; not browser or worker configuration. */
  fetch?: typeof globalThis.fetch
}

/** Each request asks Azure CLI for a fresh/renewed Entra token. No shared cancellation or disk token cache here. */
export function getAzureEntraToken(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(safeError())
  return new Promise((resolve, reject) => {
    let text: string | undefined, failed = false, timedOut = false, force: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof execFile>
    try {
      child = execFile('az', ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--only-show-errors', '--output', 'json'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 65536 }, (error, stdout) => { failed ||= error !== null; text = stdout })
    } catch { reject(safeError()); return }
    const stop = () => { child.kill('SIGTERM'); force ??= setTimeout(() => { child.kill('SIGKILL') }, 1000) }
    const timeout = setTimeout(() => { timedOut = true; stop() }, 30000)
    signal?.addEventListener('abort', stop, { once: true })
    child.once('error', () => { failed = true })
    // execFile's callback can report cancellation before process shutdown. Only close proves stdio/PID exit.
    child.once('close', () => {
      clearTimeout(timeout); clearTimeout(force); signal?.removeEventListener('abort', stop)
      if (failed || timedOut || signal?.aborted || text === undefined) { text = undefined; reject(safeError()); return }
      try {
        const value = JSON.parse(text) as { accessToken?: unknown, expires_on?: unknown }; text = undefined
        const expires = typeof value.expires_on === 'number' ? value.expires_on : typeof value.expires_on === 'string' && /^\d+$/u.test(value.expires_on) ? Number(value.expires_on) : NaN
        if (!Number.isSafeInteger(expires) || expires * 1000 <= Date.now() + 30000 || !validToken(value.accessToken)) throw safeError()
        resolve(value.accessToken)
      } catch { text = undefined; reject(safeError()) }
    })
    if (signal?.aborted) stop()
  })
}

/** A host-broker model composition, not an AgentSession or an alternative Agent Loop. */
export async function createAzureLunaModel(options: AzureLunaOptions = {}) {
  const endpoint = validateEndpoint(options.endpoint ?? AZURE_LUNA_ENDPOINT), getToken = options.token ?? getAzureEntraToken
  const model: Model<'openai-responses'> = { id: MODEL, name: 'Azure GPT-5.6 Luna', api: 'openai-responses', provider: PROVIDER, baseUrl: endpoint,
    reasoning: true, input: ['text', 'image'], contextWindow: 1050000, maxTokens: 128000,
    // Responses defaults an omitted strict flag to schema normalization, making optional fields
    // mandatory. Advertise support so Pi sends its intended explicit strict:false for ordinary tools.
    compat: { supportsStrictMode: true },
    thinkingLevelMap: { off: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    // Official OpenAI reference rates, NOT this Azure subscription's contracted billing rates.
    cost: { input: 0.20, cacheRead: 0.02, cacheWrite: 0.25, output: 1.20, tiers: [{ inputTokensAbove: 272000, input: 0.40, cacheRead: 0.04, cacheWrite: 0.50, output: 1.80 }] } }
  const credentials = new InMemoryCredentialStore(), tokens = new Map<AbortSignal, Set<Promise<string>>>()
  const join = async (signal: AbortSignal) => { while (tokens.get(signal)?.size) await Promise.allSettled(tokens.get(signal)!) }
  const modelRuntime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  const api = openAIResponsesApi()
  const transport = (request: StreamOptions = {}): StreamOptions => ({ ...request, transport: 'sse', maxRetries: 0,
    fetch: async (input, init) => {
      const value = new Request(input, { ...init, redirect: 'error' })
      if (value.url !== `${endpoint}/responses` || value.method !== 'POST') throw safeError()
      return (options.fetch ?? globalThis.fetch)(value)
    },
    onPayload: async (payload, currentModel) => {
      const changed = await request.onPayload?.(payload, currentModel), value = changed === undefined ? payload : changed
      if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.get(value, 'model') !== MODEL) throw safeError()
      // Trusted Pi hooks remain supported, but cannot opt the product into server-side response storage.
      return { ...value, model: MODEL, stream: true, store: false, background: false }
    },
  })
  modelRuntime.registerNativeProvider({ id: PROVIDER, name: 'Azure Entra GPT-5.6 Luna',
    auth: { apiKey: { name: 'Host Azure Entra session', check: async () => ({ type: 'api_key', source: 'Host Azure Entra session' }), resolve: async ({ signal }) => {
      signal.throwIfAborted()
      const pending = Promise.resolve().then(() => getToken(signal)).then(value => { if (!validToken(value)) throw safeError(); return value })
      const owned = tokens.get(signal) ?? new Set<Promise<string>>(); owned.add(pending); tokens.set(signal, owned)
      try { const token = await pending; signal.throwIfAborted(); return { auth: { apiKey: token }, source: 'Host Azure Entra session' } }
      catch { throw safeError() }
      finally { owned.delete(pending); if (!owned.size) tokens.delete(signal) }
    } } }, getModels: () => [model],
    stream: (current, context, request) => api.stream(current, context, transport(request)),
    streamSimple: (current, context, request) => api.streamSimple(current, context, { ...transport(request), reasoning: request?.reasoning } as SimpleStreamOptions),
  })
  // Pi auth resolution races AbortSignal. This host-only public-method fence prevents that race from
  // releasing broker capacity or persisting an error while its Azure CLI process still owns execution.
  const nativeStream = modelRuntime.stream.bind(modelRuntime), nativeSimple = modelRuntime.streamSimple.bind(modelRuntime)
  let activeRequests = 0
  const fenced = (start: (signal: AbortSignal) => AssistantMessageEventStream, current: Model<Api>, signal?: AbortSignal) => {
    const output = createAssistantMessageEventStream(), controller = new AbortController(), lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    if (activeRequests >= 4) { const error = failure(current, lifetime); output.push({ type: 'error', reason: error.stopReason as 'error' | 'aborted', error }); output.end(error); return output }
    activeRequests++
    void (async () => {
      let stream: AssistantMessageEventStream | undefined
      try {
        stream = start(lifetime)
        for await (const event of stream) {
          if (event.type === 'error') { await join(lifetime); const error = failure(current, lifetime); output.push({ type: 'error', reason: error.stopReason as 'error' | 'aborted', error }) }
          else if (event.type === 'done') { await join(lifetime); output.push(structuredClone(event)) }
          else {
            // Pi partial events share a mutable message. Snapshot them before a later provider failure
            // can attach an HTTP/SSE error body to an already queued event.
            const safe = structuredClone(event)
            if ('partial' in safe) { delete safe.partial.errorMessage; delete safe.partial.diagnostics }
            output.push(safe)
          }
        }
        await join(lifetime)
        const result = await stream.result(); output.end(result.stopReason === 'error' || result.stopReason === 'aborted' ? failure(current, lifetime) : result)
      } catch { await join(lifetime); const error = failure(current, lifetime); output.push({ type: 'error', reason: error.stopReason as 'error' | 'aborted', error }); output.end(error) }
      finally { controller.abort(); try { await join(lifetime); await stream?.result() } finally { activeRequests-- } }
    })()
    return output
  }
  modelRuntime.stream = ((current: Model<Api>, context: Context, request?: StreamOptions) => current.provider === PROVIDER
    ? fenced(signal => nativeStream(current, context, { ...request, signal }), current, request?.signal) : nativeStream(current, context, request)) as typeof modelRuntime.stream
  modelRuntime.streamSimple = (current, context, request) => current.provider === PROVIDER
    ? fenced(signal => nativeSimple(current, context, { ...request, signal }), current, request?.signal) : nativeSimple(current, context, request)
  await modelRuntime.getAvailable(PROVIDER)
  return { modelRuntime, model, models: [model], pricingSource: 'openai-reference-not-azure-billing' as const }
}

function validateEndpoint(value: string): string {
  if (!/^https:\/\/libei-foundry-eastus2\.openai\.azure\.com(?::443)?(?:\/|\/openai\/v1\/?)?$/u.test(value)) throw new Error('Azure Luna endpoint is not an approved HTTPS resource')
  return AZURE_LUNA_ENDPOINT
}
function validToken(value: unknown): value is string { return typeof value === 'string' && value.length >= 16 && value.length <= 16384 && !/\s/u.test(value) }
function failure(model: Model<Api>, signal: AbortSignal): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: safeError().message,
    timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
