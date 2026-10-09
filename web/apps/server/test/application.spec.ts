import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { createAzureLunaModel } from '@docatlas/runtime-pi'
import { parseContract } from '@docatlas/contracts/node'
import { startDocAtlasApplication, type DocAtlasApplicationOptions } from '../src/application.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const projectRoot = realpathSync(resolve('.')), webRoot = join(projectRoot, 'apps/web/dist')
type Application = Awaited<ReturnType<typeof startDocAtlasApplication>>

async function configuration(answers: Parameters<typeof createPiTestModel>[0]['answers'] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'docatlas-product-application-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const model = await createPiTestModel({ answers })
  const options: DocAtlasApplicationOptions = { root: join(directory, 'app'), projectRoot, webRoot, port: 0,
    modelRuntime: model.modelRuntime, models: model.models }
  return { directory, model, options }
}

async function start(options: DocAtlasApplicationOptions): Promise<Application> {
  const application = await startDocAtlasApplication(options)
  cleanup.push(() => application.close())
  return application
}

async function pair(application: Application) {
  const response = await fetch(`${application.origin}/api/auth/exchange`, { method: 'POST',
    headers: { origin: application.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code: application.pairingCode }) })
  expect(response.status).toBe(200)
  const value = parseContract('product-http', await response.json())
  if (value.kind !== 'bootstrap') throw new Error('Expected paired application bootstrap')
  expect(value.actor).toEqual(application.actor)
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  return { cookie, headers: { cookie, origin: application.origin, 'content-type': 'application/json', 'x-docatlas-csrf': value.csrfToken } }
}

async function conversations(application: Application, cookie: string) {
  const response = await fetch(`${application.origin}/api/conversations`, { headers: { cookie } })
  expect(response.status).toBe(200)
  const value = parseContract('product-http', await response.json())
  if (value.kind !== 'conversation-list') throw new Error('Expected application conversation list')
  return value
}

async function snapshot(application: Application, cookie: string, conversationId: string) {
  const response = await fetch(`${application.origin}/api/conversations/${encodeURIComponent(conversationId)}/snapshot`, { headers: { cookie } })
  expect(response.status).toBe(200)
  const value = parseContract('conversation-observation', await response.json())
  if (value.kind !== 'conversation-snapshot') throw new Error('Expected native history projection')
  return value
}

/** Preserve traversal spellings: fetch/URL would normalize dot segments before transmission. */
function rawGet(origin: string, path: string): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin, { path, method: 'GET' }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.setTimeout(10000, () => request.destroy(new Error('Application static response timed out')))
    request.on('error', reject); request.end()
  })
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('actual single-user DocAtlas application composition', () => {
  it('opens the same local workspace without login, rejects cross-site and forged writes, and survives restart without a code', async () => {
    const fixture = await configuration(), options = { ...fixture.options, localAccess: true }, app = await start(options)
    expect(app.pairingCode).toBe('')
    const response = await fetch(`${app.origin}/api/bootstrap`)
    expect(response.status).toBe(200); expect(response.headers.get('x-docatlas-access')).toBe('local'); expect(response.headers.has('set-cookie')).toBe(false)
    const bootstrap = parseContract('product-http', await response.json())
    if (bootstrap.kind !== 'bootstrap') throw new Error('Expected local bootstrap')
    expect(bootstrap.actor).toEqual(app.actor)
    for (const headers of [{ origin: 'https://evil.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
      const denied = await fetch(`${app.origin}/api/bootstrap`, { headers })
      expect(denied.status).toBe(403); await denied.body?.cancel()
    }
    const request = { schemaVersion: 1, kind: 'conversation-create', idempotencyKey: 'local:explicit:create' }
    const headers = { origin: app.origin, 'content-type': 'application/json' }
    for (const extra of [{}, { 'x-docatlas-csrf': 'x'.repeat(43) }]) {
      const denied = await fetch(`${app.origin}/api/conversations`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(request) })
      expect(denied.status).toBe(403); await denied.body?.cancel()
    }
    for (const path of ['/api/auth/exchange', '/api/auth/logout']) {
      const gone = await fetch(`${app.origin}${path}`, { method: 'POST', headers, body: '{}' })
      expect(gone.status).toBe(404); await gone.body?.cancel()
    }
    const created = await fetch(`${app.origin}/api/conversations`, { method: 'POST', headers: { ...headers, 'x-docatlas-csrf': bootstrap.csrfToken }, body: JSON.stringify(request) })
    expect(created.status).toBe(201); await created.body?.cancel()
    const count = (await conversations(app, '')).items.length
    expect(fixture.model.getCallCount()).toBe(0)
    await app.close()
    const reopened = await start(options), next = parseContract('product-http', await (await fetch(`${reopened.origin}/api/bootstrap`)).json())
    if (next.kind !== 'bootstrap') throw new Error('Expected fresh local bootstrap')
    expect(reopened.pairingCode).toBe(''); expect(next.actor).toEqual(bootstrap.actor); expect(next.csrfToken).not.toBe(bootstrap.csrfToken)
    expect((await conversations(reopened, '')).items).toHaveLength(count)
    const stale = await fetch(`${reopened.origin}/api/conversations`, { method: 'POST', headers: { ...headers, origin: reopened.origin, 'x-docatlas-csrf': bootstrap.csrfToken }, body: JSON.stringify(request) })
    expect(stale.status).toBe(403); await stale.body?.cancel()
    expect(fixture.model.getCallCount()).toBe(0)
  }, 30000)
  it('runs the actual Responses adapter through paired HTTP, the runtime manager and isolated Pi using an offline transport', async () => {
    const fixture = await configuration(), token = vi.fn(async () => 'offline-luna-token-not-a-real-secret'), transport = vi.fn(async () => {
      const item = { type: 'message', id: 'msg_offline', role: 'assistant', content: [{ type: 'output_text', text: 'RESPONSES_BRIDGE_OK', annotations: [] }], status: 'completed' }
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'RESPONSES_BRIDGE_OK' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_offline', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    const provider = await createAzureLunaModel({ token, fetch: transport }), app = await start({ ...fixture.options, ...provider })
    const login = await pair(app), binding = (await conversations(app, login.cookie)).items[0]!
    await app.manager.get(app.actor, binding.conversationId)
    expect(token).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled()
    const accepted = await fetch(`${app.origin}/api/submissions`, { method: 'POST', headers: login.headers, body: JSON.stringify({ schemaVersion: 1, kind: 'submission',
      conversationId: binding.conversationId, expectedGeneration: binding.generation, idempotencyKey: 'application:responses:offline', mode: 'prompt', text: 'Say the test response.', sourceRefs: [], selectionContextIds: [] }) })
    expect(accepted.status).toBe(202)
    const receipt = parseContract('product-control', await accepted.json())
    if (receipt.kind !== 'run-receipt') throw new Error('Expected run receipt')
    const runtime = await app.manager.get(app.actor, binding.conversationId)
    await runtime.coordinator.waitForIdle()
    expect(app.control.get(app.actor, receipt.submissionId), JSON.stringify(await runtime.worker.snapshot())).toMatchObject({ state: 'completed' })
    expect(token).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce()
    expect((await snapshot(app, login.cookie, binding.conversationId)).history.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'RESPONSES_BRIDGE_OK' })]))
  }, 30000)
  it('starts without a model call and serves only the live entry and fixed built assets', async () => {
    const fixture = await configuration(), app = await start(fixture.options)
    expect(new URL(app.origin).hostname).toBe('127.0.0.1')
    expect(fixture.model.getCallCount()).toBe(0)
    const response = await fetch(`${app.origin}/`), html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toBe(readFileSync(join(webRoot, 'live.html'), 'utf8'))
    expect(html).not.toContain(app.pairingCode)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await (await fetch(`${app.origin}/live.html`)).text()).toBe(html)
    const scriptSource = /src="((?:\.\/|\/)assets\/[^"?#]+\.js)"/u.exec(html)?.[1]
    expect(scriptSource).toBeTruthy()
    const script = new URL(scriptSource!, `${app.origin}/`).pathname
    const asset = await fetch(`${app.origin}${script}`)
    expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toContain('javascript')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(readFileSync(join(webRoot, script.slice(1))))
    const sentinel = join(app.workspaceRoot, 'private-sentinel.txt')
    writeFileSync(sentinel, 'This native workspace file is not a static website asset.')
    for (const path of ['/index.html', '/AGENTS.md', '/workspace/private-sentinel.txt', '/workspace/../private/control',
      '/assets/../../AGENTS.md', '/assets/%2e%2e/%2e%2e/AGENTS.md', '/documents/sample-report.pdf', '/.sources/', '/live.html?path=/private']) {
      const result = await rawGet(app.origin, path)
      expect(result.status, path).toBe(404)
      expect(result.body).not.toContain('native workspace file')
    }
    expect((await fetch(`${app.origin}/api/bootstrap`)).status).toBe(401)
    expect((await fetch(`${app.origin}/api/conversations`)).status).toBe(401)
    expect(fixture.model.getCallCount()).toBe(0)
    await Promise.all([app.close(), app.close()])
    expect(readFileSync(sentinel, 'utf8')).toContain('native workspace file')
    expect(existsSync(join(fixture.options.root, 'private/control'))).toBe(true)
  }, 30000)

  it('pairs, commits a real isolated Pi checkpoint, and cleanly reopens the same native history without replay', async () => {
    const fixture = await configuration(['APPLICATION_NATIVE_CHECKPOINT_SENTINEL'])
    const first = await start(fixture.options), login = await pair(first), listing = await conversations(first, login.cookie)
    expect(listing.items).toHaveLength(1); expect(listing.nextCursor).toBeNull()
    expect(fixture.model.getCallCount()).toBe(0)
    const binding = listing.items[0]!, conversationId = binding.conversationId
    const request = { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: binding.generation,
      idempotencyKey: 'application:checkpoint:request', mode: 'prompt', text: 'Run the explicit test model once.', sourceRefs: [], selectionContextIds: [] }
    const accepted = await fetch(`${first.origin}/api/submissions`, { method: 'POST', headers: login.headers, body: JSON.stringify(request) })
    expect(accepted.status).toBe(202)
    const receipt = parseContract('product-control', await accepted.json())
    if (receipt.kind !== 'run-receipt') throw new Error('Expected durable application receipt')
    const readReceipt = async () => {
      const response = await fetch(`${first.origin}/api/submissions/${encodeURIComponent(receipt.submissionId)}`, { headers: { cookie: login.cookie } })
      expect(response.status).toBe(200)
      const value = parseContract('product-control', await response.json())
      if (value.kind !== 'run-receipt') throw new Error('Expected run receipt')
      return value
    }
    await expect.poll(async () => (await readReceipt()).state, { timeout: 30000 }).toBe('completed')
    const completed = await readReceipt()
    expect(completed.checkpoint?.runtimeSessionId).toBe(binding.runtimeSessionId)
    const before = await snapshot(first, login.cookie, conversationId)
    expect(before.history.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'APPLICATION_NATIVE_CHECKPOINT_SENTINEL', truncated: false })]))
    expect(fixture.model.getCallCount()).toBe(1)
    const sessions = join(fixture.options.root, 'runtime', binding.runtimeSessionId, 'sessions')
    await first.close()
    const filenames = readdirSync(sessions).filter(name => name.endsWith('.jsonl'))
    expect(filenames).toHaveLength(1)
    const nativeBefore = readFileSync(join(sessions, filenames[0]!))
    expect(nativeBefore.toString('utf8')).toContain('APPLICATION_NATIVE_CHECKPOINT_SENTINEL')
    const reopened = await start(fixture.options)
    expect(reopened.actor).toEqual(first.actor)
    expect((await fetch(`${reopened.origin}/api/bootstrap`, { headers: { cookie: login.cookie } })).status).toBe(401)
    const fresh = await pair(reopened), retained = await conversations(reopened, fresh.cookie)
    expect(retained.items).toHaveLength(1)
    expect(retained.items[0]).toMatchObject({ conversationId, bindingId: binding.bindingId, runtimeSessionId: binding.runtimeSessionId })
    const after = await snapshot(reopened, fresh.cookie, conversationId)
    expect(after.history.messages).toEqual(before.history.messages)
    expect(after.runs.find(run => run.receipt.submissionId === receipt.submissionId)?.receipt.checkpoint).toEqual(completed.checkpoint)
    expect(fixture.model.getCallCount()).toBe(1)
    await reopened.close()
    expect(readdirSync(sessions).filter(name => name.endsWith('.jsonl'))).toEqual(filenames)
    expect(readFileSync(join(sessions, filenames[0]!))).toEqual(nativeBefore)
  }, 60000)

  it('requires an exact operator-reviewed hash for nonempty trusted resources and never executes them at startup', async () => {
    const fixture = await configuration(), trusted = join(fixture.options.root, 'trusted-resources'), extensions = join(trusted, 'extensions')
    mkdirSync(extensions, { recursive: true })
    writeFileSync(join(trusted, 'AGENTS.md'), 'UNREVIEWED_PRODUCT_RESOURCE_SENTINEL')
    writeFileSync(join(extensions, 'must-not-run.ts'), 'throw new Error("Unreviewed extension must never execute during startup")\n')
    let reason: unknown
    try { await start(fixture.options) } catch (error) { reason = error }
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).message).toContain('Trusted resources require explicit review')
    const reviewed = /SHA-256 ([a-f0-9]{64})/u.exec((reason as Error).message)?.[1]
    expect(reviewed).toBeTruthy()
    await expect(start({ ...fixture.options, trustedResourceHash: '0'.repeat(64) })).rejects.toThrow('Trusted resources require explicit review')
    expect(fixture.model.getCallCount()).toBe(0)
    expect(readdirSync(join(fixture.options.root, 'runtime'))).toEqual([])
    const authorized = await start({ ...fixture.options, trustedResourceHash: reviewed! })
    expect(fixture.model.getCallCount()).toBe(0)
    expect(readdirSync(join(fixture.options.root, 'runtime'))).toEqual([])
    await authorized.close()
    expect(readFileSync(join(trusted, 'AGENTS.md'), 'utf8')).toBe('UNREVIEWED_PRODUCT_RESOURCE_SENTINEL')
    writeFileSync(join(trusted, 'AGENTS.md'), 'CHANGED_AFTER_OPERATOR_REVIEW')
    await expect(start({ ...fixture.options, trustedResourceHash: reviewed! })).rejects.toThrow('Trusted resources require explicit review')
    expect(fixture.model.getCallCount()).toBe(0)
  }, 30000)

  it('rejects invalid ports, unsafe state roots and symlink traversal without invoking a model', async () => {
    const fixture = await configuration()
    for (const port of [-1, 65536, 1.5, Number.NaN]) await expect(start({ ...fixture.options, port })).rejects.toThrow('Invalid DocAtlas application configuration')
    expect(existsSync(fixture.options.root)).toBe(false)
    await expect(start({ ...fixture.options, root: 'relative-application-state' })).rejects.toThrow('Invalid DocAtlas application configuration')
    const containing = join(fixture.directory, 'contains-code'), code = join(containing, 'code')
    mkdirSync(code, { recursive: true })
    await expect(start({ ...fixture.options, root: containing, projectRoot: code })).rejects.toThrow('Application state cannot contain product code')
    const actual = join(fixture.directory, 'actual-root'), alias = join(fixture.directory, 'aliased-root')
    mkdirSync(actual); symlinkSync(actual, alias, 'dir')
    await expect(start({ ...fixture.options, root: alias })).rejects.toThrow('symlink')
    await expect(start({ ...fixture.options, root: join(alias, 'not-created') })).rejects.toThrow('symlink')
    const rootWithAlias = join(fixture.directory, 'state-with-alias')
    mkdirSync(rootWithAlias); symlinkSync(actual, join(rootWithAlias, 'workspace'), 'dir')
    await expect(start({ ...fixture.options, root: rootWithAlias })).rejects.toThrow('symlink')
    expect(readdirSync(actual)).toEqual([])
    expect(fixture.model.getCallCount()).toBe(0)
  }, 30000)
})
