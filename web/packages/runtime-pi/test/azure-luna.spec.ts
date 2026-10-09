import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import { AZURE_LUNA_ENDPOINT, createAzureLunaModel, getAzureEntraToken } from '../src/azure-luna.js'
import { brokerCatalog } from '../src/worker/model-bridge.js'
import { createPiDocumentTools } from '../src/document-tools.js'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), writes: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: mocks.exec }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => { mocks.writes(args); return actual.writeFileSync(...args) } }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: (...args: Parameters<typeof actual.writeFile>) => { mocks.writes(args); return actual.writeFile(...args) } }
})
afterEach(() => { mocks.exec.mockReset(); mocks.writes.mockClear(); vi.useRealTimers() })
const TOKEN = 'offline-canary-token-not-a-real-credential'
const context: Context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }], timestamp: 0 }] }
function response() {
  const message = { type: 'message', id: 'msg_luna', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'resp_luna', status: 'completed', output: [message], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
function fakeAzureCli() {
  const children: Array<{ child: EventEmitter & { kill: ReturnType<typeof vi.fn> }, finish(value: unknown, error?: Error): void }> = []
  mocks.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
    children.push({ child, finish(value, error) { callback(error ?? null, JSON.stringify(value), error?.message ?? ''); child.emit('close', error ? 1 : 0) } })
    return child
  })
  return children
}
const credential = (accessToken = TOKEN) => ({ accessToken, expires_on: Math.floor(Date.now() / 1000) + 3600 })

it('advertises only the exact Luna model through the broker, with in-memory auth and side-effect-free availability', async () => {
  const token = vi.fn(async () => TOKEN), fetch = vi.fn(async () => response()), model = await createAzureLunaModel({ token, fetch })
  await model.modelRuntime.getAvailable(model.model.provider)
  expect(token).not.toHaveBeenCalled(); expect(mocks.exec).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  expect(model.models).toHaveLength(1)
  expect(model.model).toMatchObject({ id: 'gpt-5.6-luna', api: 'openai-responses', contextWindow: 1050000, maxTokens: 128000, input: ['text', 'image'],
    thinkingLevelMap: { off: 'none', minimal: 'low', max: 'max' }, cost: { input: 0.20, output: 1.20 } })
  expect(model.pricingSource).toBe('openai-reference-not-azure-billing')
  expect(JSON.stringify(brokerCatalog(model.models))).not.toContain('openai.azure.com')
  expect(JSON.stringify(brokerCatalog(model.models))).not.toContain(TOKEN)
  expect(await model.modelRuntime.listCredentials()).toEqual([])
  expect(mocks.writes).not.toHaveBeenCalled()
})

it.each([undefined, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)('sends stateless Responses with exact image/text/model and mapped reasoning %s', async reasoning => {
  const captured: { request: Request, body: Record<string, unknown> }[] = []
  const configured = await createAzureLunaModel({ token: async () => TOKEN, fetch: async input => {
    const request = input as Request; captured.push({ request, body: await request.json() as Record<string, unknown> }); return response()
  } })
  const result = await configured.modelRuntime.completeSimple(configured.model, context, { ...(reasoning ? { reasoning } : {}), maxTokens: 128, onPayload: payload => ({ ...payload as object, store: true }) })
  expect(result.stopReason).toBe('stop'); expect(result.content[0]).toMatchObject({ type: 'text', text: 'OK' })
  expect(captured[0]!.request.url).toBe(`${AZURE_LUNA_ENDPOINT}/responses`)
  expect(captured[0]!.request.redirect).toBe('error')
  expect(captured[0]!.request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
  expect(captured[0]!.body).toMatchObject({ model: 'gpt-5.6-luna', store: false, background: false, stream: true, max_output_tokens: 128, reasoning: { effort: reasoning === undefined ? 'none' : reasoning === 'minimal' ? 'low' : reasoning } })
  expect(JSON.stringify(captured[0]!.body)).toContain('input_image')
  expect(JSON.stringify(captured[0]!.body)).not.toContain(TOKEN)
  expect(await configured.modelRuntime.listCredentials()).toEqual([]); expect(mocks.writes).not.toHaveBeenCalled()
})

it.each(['http://libei-foundry-eastus2.openai.azure.com', 'https://foreign.openai.azure.com/openai/v1', 'https://user:password@libei-foundry-eastus2.openai.azure.com/openai/v1',
  `${AZURE_LUNA_ENDPOINT}?api-key=secret`, `${AZURE_LUNA_ENDPOINT}#fragment`, `${AZURE_LUNA_ENDPOINT}/responses`, 'https://libei-foundry-eastus2.openai.azure.com:444/openai/v1',
  'https://libei-foundry-eastus2.openai.azure.com/openai/x/../v1'])('rejects a non-allowlisted endpoint without token acquisition: %s', async endpoint => {
  const token = vi.fn(async () => TOKEN)
  await expect(createAzureLunaModel({ endpoint, token })).rejects.toThrow('approved HTTPS')
  expect(token).not.toHaveBeenCalled()
})

it('does not leak HTTP error bodies, auth failures, token values or private endpoints to model events', async () => {
  const configured = await createAzureLunaModel({ token: async () => TOKEN, fetch: async () => new Response(JSON.stringify({ error: { message: `${TOKEN} ${AZURE_LUNA_ENDPOINT}`, type: 'invalid_request_error' } }), { status: 401, headers: { 'content-type': 'application/json' } }) })
  const stream = configured.modelRuntime.streamSimple(configured.model, context), events: unknown[] = []
  for await (const event of stream) events.push(event)
  const result = await stream.result()
  expect(result.stopReason).toBe('error'); expect(JSON.stringify([events, result])).not.toContain(TOKEN); expect(JSON.stringify([events, result])).not.toContain(AZURE_LUNA_ENDPOINT)
  const auth = await createAzureLunaModel({ token: async () => { throw new Error(TOKEN) }, fetch: async () => { throw new Error('must not fetch') } })
  const failed = await auth.modelRuntime.completeSimple(auth.model, context)
  expect(failed.stopReason).toBe('error'); expect(JSON.stringify(failed)).not.toContain(TOKEN)
})

it('rejects model/transport substitution without using a different endpoint or model', async () => {
  const fetch = vi.fn(async () => response()), configured = await createAzureLunaModel({ token: async () => TOKEN, fetch })
  const substituted = await configured.modelRuntime.completeSimple(configured.model, context, { onPayload: payload => ({ ...payload as object, model: 'another-model' }) })
  const redirected = await configured.modelRuntime.completeSimple({ ...configured.model, baseUrl: 'https://foreign.invalid/v1' }, context)
  expect(substituted.stopReason).toBe('error'); expect(redirected.stopReason).toBe('error'); expect(fetch).not.toHaveBeenCalled()
})

it('does not expose a late SSE error by mutating an earlier queued partial message', async () => {
  const events = [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_partial', role: 'assistant', content: [] } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'provider-error', message: TOKEN } } }]
  const configured = await createAzureLunaModel({ token: async () => TOKEN, fetch: async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) })
  const stream = configured.modelRuntime.streamSimple(configured.model, context), received: unknown[] = []
  for await (const event of stream) received.push(event)
  expect((await stream.result()).stopReason).toBe('error')
  expect(JSON.stringify(received)).not.toContain(TOKEN)
})

it('uses argv-only Azure CLI, verifies expiry, refreshes per request and never persists its token', async () => {
  const children = fakeAzureCli(), first = getAzureEntraToken()
  expect(mocks.exec.mock.calls[0]!.slice(0, 2)).toEqual(['az', ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--only-show-errors', '--output', 'json']])
  children[0]!.finish(credential()); await expect(first).resolves.toBe(TOKEN)
  const expired = getAzureEntraToken(), rejected = expect(expired).rejects.toThrow('Azure Luna request unavailable')
  children[1]!.finish({ accessToken: TOKEN, expires_on: Math.floor(Date.now() / 1000) - 1 }); await rejected
  const refreshed = getAzureEntraToken(); children[2]!.finish(credential(`${TOKEN}-renewed`)); await expect(refreshed).resolves.toBe(`${TOKEN}-renewed`)
  expect(mocks.exec).toHaveBeenCalledTimes(3); expect(mocks.writes).not.toHaveBeenCalled()
  expect(JSON.stringify(mocks.exec.mock.calls.map(call => call.slice(0, 3)))).not.toContain(TOKEN)
})

it('fences Pi auth cancellation until the cancelled az process really closes, without cancelling another refresh', async () => {
  const children = fakeAzureCli(), fetch = vi.fn(async () => response()), configured = await createAzureLunaModel({ fetch })
  const cancelled = new AbortController(), other = new AbortController()
  const first = configured.modelRuntime.streamSimple(configured.model, context, { signal: cancelled.signal }), second = configured.modelRuntime.streamSimple(configured.model, context, { signal: other.signal })
  let firstDone = false; const firstResult = first.result().then(value => { firstDone = true; return value })
  await vi.waitFor(() => expect(children).toHaveLength(2))
  cancelled.abort(); await Promise.resolve(); await Promise.resolve()
  expect(children[0]!.child.kill).toHaveBeenCalledWith('SIGTERM'); expect(children[1]!.child.kill).not.toHaveBeenCalled(); expect(firstDone).toBe(false)
  children[1]!.finish(credential(`${TOKEN}-second`)); expect((await second.result()).stopReason).toBe('stop'); expect(firstDone).toBe(false)
  children[0]!.finish(credential()); expect((await firstResult).stopReason).toBe('aborted'); expect(fetch).toHaveBeenCalledOnce()
})

it('waits through forced CLI shutdown and emits only a safe failure for malformed or failed CLI output', async () => {
  vi.useFakeTimers()
  const children = fakeAzureCli(), controller = new AbortController(), pending = getAzureEntraToken(controller.signal)
  let settled = false; const result = pending.catch(error => { settled = true; return error })
  controller.abort(); await vi.advanceTimersByTimeAsync(1001)
  expect(children[0]!.child.kill).toHaveBeenCalledWith('SIGKILL'); expect(settled).toBe(false)
  children[0]!.finish(credential(), new Error(TOKEN)); expect((await result as Error).message).not.toContain(TOKEN)
  const malformed = getAzureEntraToken(), rejected = expect(malformed).rejects.toThrow('Azure Luna request unavailable')
  children[1]!.finish({ accessToken: TOKEN, expires_on: 'invalid' }); await rejected
})

it('caps the host composition at four outstanding requests before beginning another token acquisition', async () => {
  const released = Promise.withResolvers<string>(), token = vi.fn(() => released.promise)
  const configured = await createAzureLunaModel({ token, fetch: async () => response() })
  const streams = Array.from({ length: 4 }, () => configured.modelRuntime.streamSimple(configured.model, context))
  await vi.waitFor(() => expect(token).toHaveBeenCalledTimes(4))
  expect((await configured.modelRuntime.completeSimple(configured.model, context)).stopReason).toBe('error')
  expect(token).toHaveBeenCalledTimes(4)
  released.resolve(TOKEN)
  expect((await Promise.all(streams.map(stream => stream.result()))).every(result => result.stopReason === 'stop')).toBe(true)
})

it('sends explicit strict:false so Responses does not require unrelated DocAtlas read-mode fields', async () => {
  let sent: { tools: Array<{ type: string, name: string, strict?: boolean, parameters: { required: string[] } }> } | undefined
  const tools = createPiDocumentTools(() => { throw new Error('Schema inspection must not execute document operations') })
  const configured = await createAzureLunaModel({ token: async () => TOKEN, fetch: async input => { sent = await (input as Request).json() as typeof sent; return response() } })
  const result = await configured.modelRuntime.completeSimple(configured.model, { ...context, tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) })
  expect(result.stopReason).toBe('stop')
  expect(sent!.tools.every(tool => tool.type !== 'function' || tool.strict === false)).toBe(true)
  const read = sent!.tools.find(tool => tool.name === 'docatlas_read')!
  expect(read.strict).toBe(false); expect(read.parameters.required).toEqual(['documentId', 'mode'])
  expect(read.parameters.required).not.toContain('query'); expect(read.parameters.required).not.toContain('blockIds'); expect(read.parameters.required).not.toContain('cursor')
})
