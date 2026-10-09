import { isAbsolute } from 'node:path'
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  type AgentSession, type AgentSessionRuntime, type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionServicesOptions, type ModelRuntime, type SessionManager, type SessionStartEvent,
} from '@earendil-works/pi-coding-agent'

export interface PiRuntimeOptions {
  cwd: string
  agentDir: string
  sessionManager: SessionManager
  /** Caller owns auth/routing. Never implicitly open the user's default credential file. */
  modelRuntime: ModelRuntime
  /** Called for each new cwd/session; native resource discovery is not disabled. */
  services?: (cwd: string) => Pick<CreateAgentSessionServicesOptions,
    'settingsManager' | 'resourceLoaderOptions' | 'resourceLoaderReloadOptions'>
  /** Model/thinking seed only the initial manager; replacement sessions restore their own native branch. */
  session?: Pick<CreateAgentSessionFromServicesOptions,
    'model' | 'thinkingLevel' | 'scopedModels' | 'customTools' | 'tools' | 'excludeTools' | 'toolOptions'>
  bindings?: (session: AgentSession) => Parameters<AgentSession['bindExtensions']>[0] | Promise<Parameters<AgentSession['bindExtensions']>[0]>
  onBound?: (session: AgentSession) => void
  onInvalidate?: () => void
  /** Private product boundary/observation, before replacement services or extension factories execute. */
  onBeforeSessionCreate?: (manager: SessionManager, event?: SessionStartEvent) => void
}

/**
 * Internal SDK composition, not a browser entry or a sandbox. The product must
 * supply an authorized execution boundary before exposing native operations.
 * Returns the full runtime, not a reduced prompt/abort replacement loop.
 */
export async function createPiRuntime(options: PiRuntimeOptions): Promise<AgentSessionRuntime> {
  if (!isAbsolute(options.cwd) || !isAbsolute(options.agentDir)) {
    throw new Error('Pi runtime requires absolute application-owned directories')
  }
  const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    options.onBeforeSessionCreate?.(sessionManager, sessionStartEvent)
    const services = await createAgentSessionServices({
      ...options.services?.(cwd), cwd, agentDir, modelRuntime: options.modelRuntime,
    })
    const sessionOptions = { ...options.session }
    if (sessionManager !== options.sessionManager) {
      // A fork/switch owns a different native selection. Reusing the initial caller's
      // model would silently override its inherited model while leaving JSONL unchanged.
      delete sessionOptions.model; delete sessionOptions.thinkingLevel
      const recorded = sessionManager.buildSessionContext()
      if (recorded.model) {
        const model = options.modelRuntime.getModel(recorded.model.provider, recorded.model.modelId)
        if (model) sessionOptions.model = model // Otherwise preserve the SDK's normal authorized model fallback.
      } else if (options.session?.model) sessionOptions.model = options.session.model // Empty /new sessions retain the caller's approved fallback.
      if (sessionManager.getBranch().some(entry => entry.type === 'thinking_level_change')) {
        sessionOptions.thinkingLevel = recorded.thinkingLevel as NonNullable<CreateAgentSessionFromServicesOptions['thinkingLevel']>
      } else if (options.session?.thinkingLevel !== undefined) sessionOptions.thinkingLevel = options.session.thinkingLevel
    }
    const result = await createAgentSessionFromServices({
      ...sessionOptions, services, sessionManager,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
    })
    return { ...result, services, diagnostics: services.diagnostics }
  }, { cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager })
  const bind = async (session: AgentSession) => {
    await session.bindExtensions(await options.bindings?.(session) ?? {})
    options.onBound?.(session)
  }
  runtime.setRebindSession(bind)
  runtime.setBeforeSessionInvalidate(options.onInvalidate)
  try { await bind(runtime.session); return runtime }
  catch (error) { await runtime.dispose(); throw error }
}
