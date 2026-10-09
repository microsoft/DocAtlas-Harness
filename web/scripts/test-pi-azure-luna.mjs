// Explicit opt-in network smoke. No document uploads, token output, or credential files.
import { createAzureLunaModel } from '../packages/runtime-pi/lib/index.js'

if (process.argv.slice(2).join(' ') !== '--live') {
  process.stderr.write('Opt-in only: bash scripts/pnpmw exec node scripts/test-pi-azure-luna.mjs --live\n')
  process.exitCode = 2
} else {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90000)
  let stream
  try {
    const { modelRuntime, model } = await createAzureLunaModel()
    stream = modelRuntime.streamSimple(model, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly PI_AZURE_LUNA_OK and nothing else.' }], timestamp: Date.now() }] },
      { maxTokens: 256, timeoutMs: 60000, maxRetryDelayMs: 0, cacheRetention: 'none', signal: controller.signal })
    for await (const _event of stream) { controller.signal.throwIfAborted() }
    const result = await stream.result(), text = result.content.filter(part => part.type === 'text').map(part => part.text).join('').trim()
    if (result.stopReason !== 'stop' || text !== 'PI_AZURE_LUNA_OK') throw new Error('invalid-smoke-result')
    process.stdout.write('PI_AZURE_LUNA_OK\nAzure GPT-5.6 Luna Responses transport verified through host Pi ModelRuntime.\n')
  } catch { process.stderr.write('Azure Pi smoke did not pass. Check az login and deployment access; no provider response or credentials were printed.\n'); process.exitCode = 1 }
  finally { clearTimeout(timer); controller.abort(); await stream?.result() }
}
