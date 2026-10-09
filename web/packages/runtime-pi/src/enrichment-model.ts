import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Model, Api } from '@earendil-works/pi-ai'
import { EnrichmentError, type EnrichmentModelPort } from '@docatlas/core'

/** Explicit one-shot model transformation. No Agent Loop, tools, Python credentials or native transcript. */
export function createEnrichmentModel(runtime: ModelRuntime, model: Model<Api>, authorize: () => void): EnrichmentModelPort {
  return { identity: { provider: model.provider, model: model.id }, async complete(prompt, limits, signal) {
    authorize(); signal.throwIfAborted()
    if (limits.maxTokens > model.maxTokens || prompt.length > 1200000 || limits.maxChars > 100000) throw new EnrichmentError('budget-exceeded', 'Configured model cannot satisfy this request budget')
    const controller = new AbortController(), lifetime = AbortSignal.any([signal, controller.signal])
    const stream = runtime.streamSimple(model, { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }] }, { signal: lifetime, maxTokens: limits.maxTokens, reasoning: 'minimal', maxRetryDelayMs: 0, timeoutMs: 60000 })
    let output = 0
    try {
      for await (const event of stream) {
        lifetime.throwIfAborted(); authorize()
        if (event.type === 'text_delta') { output += [...event.delta].length; if (output > limits.maxChars) throw new EnrichmentError('budget-exceeded', 'Enrichment output text limit exceeded') }
      }
      const result = await stream.result(); lifetime.throwIfAborted(); authorize()
      if (result.stopReason !== 'stop' || result.content.some(part => part.type === 'toolCall')) throw new EnrichmentError('invalid-output', 'Model did not finish a text-only enrichment response')
      const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('')
      if ([...text].length > limits.maxChars) throw new EnrichmentError('budget-exceeded', 'Enrichment result text limit exceeded')
      return { text, inputTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite, outputTokens: result.usage.output }
    } finally { controller.abort(); await stream.result() }
  } }
}
