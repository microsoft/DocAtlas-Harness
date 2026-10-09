/** Explicit test entry only. Never a production provider fallback. */
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, type FauxModelDefinition } from '@earendil-works/pi-ai'
import { createPiRuntime, type PiRuntimeOptions } from './create-runtime.js'

export type PiTestAnswer = string | { calls: Array<{ name: string, args: Record<string, unknown> }> }
export type PiTestResponse = PiTestAnswer | ((messages: readonly unknown[]) => PiTestAnswer | Promise<PiTestAnswer>)
export interface PiTestContextSnapshot { readonly systemPrompt?: string, readonly messages: readonly unknown[], readonly tools?: readonly unknown[] }
function readonlySnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(readonlySnapshot); Object.freeze(value) }
  return value
}

export async function createPiTestModel(options: {
  answers: PiTestResponse[], beforeResponse?: (signal: AbortSignal | undefined) => Promise<void>,
  inspectMessages?: (messages: readonly unknown[]) => void,
  /** Test-only deep copy, never a hook that can modify the actual provider request. */
  inspectContext?: (context: PiTestContextSnapshot) => void,
  /** Explicit bounded test catalog/chunk sizes for exercising actual native auto-compaction. */
  modelLimits?: { contextWindow: number, maxTokens: number },
  /** Test-only approved catalog. Models are really registered with the local faux provider. */
  models?: FauxModelDefinition[],
  tokenSize?: number,
}) {
  if (options.models !== undefined) {
    if (options.modelLimits !== undefined || !Array.isArray(options.models) || options.models.length < 1 || options.models.length > 8
      || new Set(options.models.map(model => model?.id)).size !== options.models.length) throw new Error('Invalid explicit test model catalog')
    for (const model of options.models) {
      if (!model || typeof model !== 'object' || Object.keys(model).some(key => !['id', 'name', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens'].includes(key))
        || typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(model.id)
        || model.name !== undefined && (typeof model.name !== 'string' || !model.name.trim() || model.name.length > 256 || [...model.name].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127))
        || model.reasoning !== undefined && typeof model.reasoning !== 'boolean'
        || model.input !== undefined && (!Array.isArray(model.input) || !model.input.length || model.input.length > 2 || new Set(model.input).size !== model.input.length || model.input.some(value => !['text', 'image'].includes(value)))
        || model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 1000000)
        || model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > 1000000)
        || model.contextWindow !== undefined && model.maxTokens !== undefined && model.maxTokens > model.contextWindow
        || model.cost !== undefined && (!model.cost || typeof model.cost !== 'object' || Object.keys(model.cost).sort().join(',') !== 'cacheRead,cacheWrite,input,output'
          || Object.values(model.cost).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000))) throw new Error('Invalid explicit test model definition')
    }
  }
  if (options.modelLimits && (!Number.isSafeInteger(options.modelLimits.contextWindow) || options.modelLimits.contextWindow < 1024 || options.modelLimits.contextWindow > 1000000
    || !Number.isSafeInteger(options.modelLimits.maxTokens) || options.modelLimits.maxTokens < 1 || options.modelLimits.maxTokens > options.modelLimits.contextWindow)) throw new Error('Invalid explicit test model limits')
  if (options.tokenSize !== undefined && (!Number.isSafeInteger(options.tokenSize) || options.tokenSize < 1 || options.tokenSize > 8192)) throw new Error('Invalid explicit test token size')
  const catalog = options.models ? structuredClone(options.models) : undefined
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  const faux = fauxProvider({ ...(catalog ? { models: catalog } : options.modelLimits ? { models: [{ id: 'docatlas-bounded-context-test', ...options.modelLimits }] } : {}),
    ...(options.tokenSize === undefined ? {} : { tokenSize: { min: options.tokenSize, max: options.tokenSize } }) })
  if (faux.models.some(model => !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 1000000
    || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow)) throw new Error('Invalid effective test model limits')
  modelRuntime.registerNativeProvider(faux.provider)
  faux.setResponses(options.answers.map(answer => async (_context, streamOptions) => {
    options.inspectMessages?.(_context.messages)
    if (options.inspectContext) options.inspectContext(readonlySnapshot(structuredClone(_context)))
    await options.beforeResponse?.(streamOptions?.signal)
    const resolved = typeof answer === 'function' ? await answer(_context.messages) : answer
    return typeof resolved === 'string' ? fauxAssistantMessage(resolved) : fauxAssistantMessage(resolved.calls.map(call => fauxToolCall(call.name, call.args)), { stopReason: 'toolUse' })
  }))
  return { modelRuntime, models: faux.models, getCallCount: () => faux.state.callCount }
}

export async function createPiTestRuntime(options: {
  cwd: string, agentDir: string, sessionDir: string,
  sessionId?: string,
  answers: Array<string | { calls: Array<{ name: string, args: Record<string, unknown> }> }>, beforeResponse?: (signal: AbortSignal | undefined) => Promise<void>,
  toolOptions?: NonNullable<PiRuntimeOptions['session']>['toolOptions'],
  tools?: string[],
  customTools?: NonNullable<PiRuntimeOptions['session']>['customTools'],
}) {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  const faux = fauxProvider()
  modelRuntime.registerNativeProvider(faux.provider)
  faux.setResponses(options.answers.map(answer => async (_context, streamOptions) => {
    await options.beforeResponse?.(streamOptions?.signal)
    return typeof answer === 'string' ? fauxAssistantMessage(answer) : fauxAssistantMessage(answer.calls.map(call => fauxToolCall(call.name, call.args)), { stopReason: 'toolUse' })
  }))
  const runtime = await createPiRuntime({ cwd: options.cwd, agentDir: options.agentDir, modelRuntime,
    sessionManager: SessionManager.create(options.cwd, options.sessionDir, options.sessionId ? { id: options.sessionId } : undefined),
    session: { model: faux.getModel(), ...(options.toolOptions ? { toolOptions: options.toolOptions } : {}), ...(options.tools ? { tools: options.tools } : {}), ...(options.customTools ? { customTools: options.customTools } : {}) },
    services: () => ({ settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'never', compaction: { enabled: false }, retry: { enabled: false } }) }),
  })
  return { runtime, getCallCount: () => faux.state.callCount }
}
