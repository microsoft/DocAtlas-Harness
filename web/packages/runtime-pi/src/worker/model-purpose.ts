import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { Context } from '@earendil-works/pi-ai'

export type NativeModelRequestPurpose = 'agent-answer' | 'auxiliary'
type NativeSession = Pick<AgentSession, 'agent' | 'isCompacting'>
interface RequestToken {
  binding: object
  context: Context
  signal: AbortSignal | undefined
  purpose: NativeModelRequestPurpose
  consumed: boolean
}
interface Binding {
  identity: object
  session: NativeSession
  original: AgentSession['agent']['streamFunction']
  wrapped: AgentSession['agent']['streamFunction']
}

/** Native call correlation only, never model/document/profile authority. No prompt-text heuristics. */
export class NativeModelPurpose {
  private readonly local = new AsyncLocalStorage<RequestToken>()
  private binding: Binding | undefined

  bind(session: NativeSession): void {
    this.invalidate()
    const identity = {}, original = session.agent.streamFunction
    const invoke = (receiver: unknown, model: Parameters<typeof original>[0], context: Context, options: Parameters<typeof original>[2]) => {
      const signal = options?.signal
      const purpose = this.binding?.identity === identity && signal !== undefined && !signal.aborted
        && signal === session.agent.signal && !session.isCompacting ? 'agent-answer' : 'auxiliary'
      // Retain native receiver, options, hooks, context and returned stream exactly.
      return this.local.run({ binding: identity, context, signal, purpose, consumed: false }, () => original.call(receiver, model, context, options))
    }
    const wrapped: typeof original = function (this: unknown, ...args) { return invoke(this, ...args) }
    this.binding = { identity, session, original, wrapped }
    session.agent.streamFunction = wrapped
  }

  /** Called once at the native provider boundary, before context/signal are serialized for IPC. */
  consume(context: Context, signal: AbortSignal | undefined): NativeModelRequestPurpose {
    const token = this.local.getStore(), binding = this.binding
    if (!token || !binding || token.binding !== binding.identity || token.consumed || token.context !== context || token.signal !== signal) return 'auxiliary'
    token.consumed = true
    if (token.purpose !== 'agent-answer' || !signal || signal.aborted || binding.session.isCompacting || signal !== binding.session.agent.signal) return 'auxiliary'
    return 'agent-answer'
  }

  invalidate(): void {
    const binding = this.binding
    this.binding = undefined
    // An operator extension may replace streamFunction; never overwrite that replacement.
    if (binding && binding.session.agent.streamFunction === binding.wrapped) binding.session.agent.streamFunction = binding.original
    this.local.disable()
  }
}
