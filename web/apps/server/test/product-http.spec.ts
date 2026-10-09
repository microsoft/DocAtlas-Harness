import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { parseContract } from '@docatlas/contracts/node'
import type { ConversationObservation } from '@docatlas/contracts'
import { ControlStore, IsolatedPiWorker, LinuxExecutor, ProductAuth, ResourceStore, SubmissionCoordinator, ConversationObservations, createProductHttpHandler, prepareDocumentFree } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('real product HTTP boundary', () => {
  it('authenticates actual Pi submissions, retains durable receipts and awaits stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docatlas-http-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const work = join(root, 'work'), agent = join(root, 'agent'), state = join(root, 'private'), sessions = join(root, 'sessions'), output = join(root, 'output')
    for (const path of [work, agent, state]) mkdirSync(path)
    const actor = { actorId: 'actor:http', workspaceId: 'workspace:http' }, conversationId = 'conversation:http', sessionId = randomUUID()
    const control = ControlStore.open(join(state, 'control')); cleanup.push(() => control.close())
    control.createConversation(actor, { conversationId, runtimeSessionId: sessionId })
    control.createConversation({ actorId: 'actor:other', workspaceId: 'workspace:other' }, { conversationId: 'conversation:other', runtimeSessionId: randomUUID() })
    const resources = new ResourceStore(join(root, 'resources'), [state]); cleanup.push(() => resources.close())
    const resourceSnapshot = resources.capture(agent), approval = resources.approve(actor, resourceSnapshot.snapshotId, resourceSnapshot.manifestHash)
    const native = new LinuxExecutor({ workspaceRoot: work, scratchRoot: join(root, 'scratch'), outputRoot: output, protectedRoots: [state, agent, sessions, resources.root], rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()) })
    cleanup.push(() => native.abortAll()); await native.preflight()
    let calls = 0, aborted = false
    const entered = Promise.withResolvers<void>()
    const model = await createPiTestModel({ answers: ['actual HTTP answer', 'not completed'], beforeResponse: async signal => {
      if (++calls !== 2) return
      entered.resolve()
      await new Promise<void>((_resolve, reject) => { const stop = () => { aborted = true; reject(signal!.reason) }; if (signal!.aborted) stop(); else signal!.addEventListener('abort', stop, { once: true }) })
    } })
    const worker = await IsolatedPiWorker.create({ workspaceRoot: work, agentDir: agent, sessionDir: sessions, outputDir: output, sessionId, native, ...model,
      protectedRoots: [state], resources: { store: resources, actor, approvalId: approval.approvalId }, authorize: () => { control.binding(actor, conversationId) } })
    cleanup.push(() => worker.dispose())
    const coordinator = new SubmissionCoordinator(control, actor, conversationId, worker, prepareDocumentFree); cleanup.push(() => coordinator.close())
    const observations = new ConversationObservations(control, actor, conversationId, worker, coordinator); cleanup.push(() => observations.dispose())
    let handle: ReturnType<typeof createProductHttpHandler> | undefined
    const server = createServer((request, response) => handle!(request, response))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth = new ProductAuth(origin)
    let lookups = 0
    handle = createProductHttpHandler({ auth, control, coordinator: (value, id) => { expect(value).toEqual(actor); expect(id).toBe(conversationId); lookups++; return coordinator },
      observations: (value, id) => { expect(value).toEqual(actor); expect(id).toBe(conversationId); return observations } })
    const json = { 'content-type': 'application/json', origin }
    expect((await fetch(`${origin}/api/bootstrap`)).status).toBe(401)
    const code = auth.issueBootstrap(actor).code
    const exchanged = await fetch(`${origin}/api/auth/exchange`, { method: 'POST', headers: json, body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code }) })
    expect(exchanged.status).toBe(200)
    const bootstrap = parseContract('product-http', await exchanged.json())
    if (bootstrap.kind !== 'bootstrap') throw new Error('Expected authenticated bootstrap')
    const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!, headers = { ...json, cookie, 'x-docatlas-csrf': bootstrap.csrfToken }
    const eventsUrl = `${origin}/api/conversations/${conversationId}/events`, snapshotUrl = `${origin}/api/conversations/${conversationId}/snapshot`
    const open = async (last?: string) => {
      const controller = new AbortController(); cleanup.push(() => controller.abort())
      const response = await fetch(eventsUrl, { headers: { cookie, ...(last ? { 'last-event-id': last } : {}) }, signal: controller.signal })
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream')
      return { controller, stream: sse(response) }
    }
    expect((await fetch(eventsUrl)).status).toBe(401)
    expect((await fetch(eventsUrl, { headers: { cookie, 'last-event-id': 'malformed' } })).status).toBe(400)
    const initial = await open()
    const firstEvent = await initial.stream.next(value => value.update.type === 'resync')
    expect(firstEvent.update).toMatchObject({ reason: 'initial' })
    const request = { schemaVersion: 1, kind: 'submission', conversationId, expectedGeneration: 1, idempotencyKey: 'idempotency:http:first', mode: 'prompt', text: 'Real HTTP question', sourceRefs: [], selectionContextIds: [] }
    const post = (value: unknown, supplied = headers) => fetch(`${origin}/api/submissions`, { method: 'POST', headers: supplied, body: JSON.stringify(value) })
    expect((await post(request, { ...headers, origin: 'https://attacker.test' })).status).toBe(403)
    expect((await post(request, { ...headers, 'x-docatlas-csrf': 'x'.repeat(43) })).status).toBe(403)
    expect((await post({ ...request, actorId: 'actor:forged' })).status).toBe(400)
    expect((await post({ ...request, conversationId: 'conversation:other' })).status).toBe(404)
    expect((await post({ ...request, text: 'x'.repeat(65537) })).status).toBe(413)
    expect((await post(request, { ...headers, cookie: `${cookie}; ${cookie}` })).status).toBe(401)
    expect((await fetch(`${origin}/api/bootstrap?code=not-allowed-in-urls`, { headers: { cookie } })).status).toBe(400)
    expect((await fetch(`${origin}/api/submissions`, { method: 'POST', headers, body: new Uint8Array([255]) })).status).toBe(400)
    expect((await fetch(`${origin}/api/auth/exchange`, { method: 'POST', headers: json, body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code }) })).status).toBe(401)
    expect(lookups).toBe(0)
    const accepted = await post(request)
    expect(accepted.status).toBe(202)
    const receipt = parseContract('product-control', await accepted.json())
    if (receipt.kind !== 'run-receipt') throw new Error('Expected receipt')
    expect(control.recoveryInput(actor, receipt.submissionId)?.text).toBe(request.text)
    await coordinator.waitForIdle()
    await initial.stream.next(value => value.update.type === 'receipt' && value.update.receipt.state === 'completed')
    const streamed = initial.stream.seen.flatMap(value => value.update.type === 'progress' && value.update.progress.type === 'text' ? [value.update.progress.delta] : []).join('')
    expect(streamed.length).toBeGreaterThan(0)
    expect('actual HTTP answer'.startsWith(streamed)).toBe(true) // Chunk boundaries are not answer boundaries; the snapshot below proves the complete text.
    const fetched = await fetch(`${origin}/api/submissions/${encodeURIComponent(receipt.submissionId)}`, { headers: { cookie } })
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('cache-control')).toBe('no-store')
    expect(await fetched.json()).toMatchObject({ state: 'completed', checkpoint: { runtimeSessionId: sessionId } })
    expect((await post(request)).status).toBe(200)
    expect(model.getCallCount()).toBe(1)
    const snapshotResponse = await fetch(snapshotUrl, { headers: { cookie } })
    expect(snapshotResponse.status).toBe(200)
    const snapshot = parseContract('conversation-observation', await snapshotResponse.json())
    if (snapshot.kind !== 'conversation-snapshot') throw new Error('Expected snapshot')
    expect(snapshot.history.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'actual HTTP answer', truncated: false })]))
    expect(snapshot.live).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain(sessions)
    initial.controller.abort()
    const replay = await open(`${firstEvent.cursor.streamId}:${firstEvent.cursor.sequence}`)
    await replay.stream.next(value => value.update.type === 'receipt' && value.update.receipt.state === 'completed')
    expect(model.getCallCount()).toBe(1)
    await post({ ...request, idempotencyKey: 'idempotency:http:cancel', text: 'Cancel this actual model call' })
    await entered.promise
    replay.controller.abort()
    expect(aborted).toBe(false) // Disconnecting an observer is not a stop command.
    const watching = await open(`${snapshot.cursor.streamId}:${snapshot.cursor.sequence}`)
    const stopped = await fetch(`${origin}/api/conversations/${conversationId}/stop`, { method: 'POST', headers, body: '{}' })
    expect(stopped.status).toBe(200)
    expect(parseContract('product-http', await stopped.json())).toMatchObject({ kind: 'runtime-stopped', generation: 1 })
    expect(aborted).toBe(true); expect(native.activeCount).toBe(0)
    expect((await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers, body: '{}' })).status).toBe(204)
    await watching.stream.ended()
    expect((await fetch(`${origin}/api/bootstrap`, { headers: { cookie } })).status).toBe(401)
  }, 60000)
})

function sse(response: Response) {
  const reader = response.body!.getReader(), decoder = new TextDecoder(), seen: ConversationObservation[] = []
  let buffered = ''
  return { seen, async next(predicate: (event: ConversationObservation) => boolean) {
    while (true) {
      const boundary = buffered.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2)
        const data = frame.split('\n').find(line => line.startsWith('data: '))
        if (!data) continue
        const value = parseContract('conversation-observation', JSON.parse(data.slice(6)))
        if (value.kind !== 'conversation-observation') throw new Error('Unexpected SSE payload')
        seen.push(value); if (predicate(value)) return value
      } else {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('SSE ended before expected event')
        buffered += decoder.decode(chunk.value, { stream: true })
      }
    }
  }, async ended() { while (!(await reader.read()).done) { /* Drain committed updates before logout close. */ } } }
}
