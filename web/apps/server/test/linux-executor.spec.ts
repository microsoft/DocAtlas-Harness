import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeToolOptions, PiProductDriver } from '@docatlas/runtime-pi'
import { createPiTestRuntime } from '@docatlas/runtime-pi/testing'
import { LinuxExecutor } from '../src/execution/linux-executor.js'
import { ControlStore, SubmissionCoordinator, prepareDocumentFree } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const available = process.platform === 'linux' && existsSync('/usr/bin/bwrap')

async function setup(overrides: Partial<ConstructorParameters<typeof LinuxExecutor>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-exec-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'work'), scratchRoot = join(root, 'scratch'), outputRoot = join(root, 'outputs'), privateRoot = join(root, 'private'), sources = join(root, 'sources')
  for (const dir of [workspaceRoot, privateRoot, sources]) mkdirSync(dir)
  const secret = join(privateRoot, 'secret.txt')
  writeFileSync(secret, 'PRIVATE_NATIVE_CANARY')
  writeFileSync(join(sources, 'original.txt'), 'authorized source')
  writeFileSync(join(workspaceRoot, 'input.txt'), 'alpha\ncontext line\n')
  symlinkSync(secret, join(workspaceRoot, 'secret-link'))
  const options = { workspaceRoot, scratchRoot, outputRoot, protectedRoots: [privateRoot], readOnlyPaths: [sources], rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()), ...overrides }
  const backend = new LinuxExecutor(options)
  cleanup.push(() => backend.abortAll())
  await backend.preflight()
  return { backend, root, options, privateRoot, secret, sources, workspaceRoot, outputRoot }
}

describe.skipIf(!available)('Linux native execution boundary', () => {
  it('keeps extension argv/output/exit semantics and waits for actual cancellation', async () => {
    const { backend, workspaceRoot, privateRoot } = await setup()
    const value = await backend.execFile(process.execPath, ['-e', `process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write('e'.repeat(10000));process.exitCode=9`, 'a b', '; not shell', '$HOME'], workspaceRoot)
    expect(value).toEqual({ stdout: '["a b","; not shell","$HOME"]', stderr: 'e'.repeat(10000), code: 9, killed: false })
    const marker = join(workspaceRoot, 'extension-started'), controller = new AbortController()
    const pending = backend.execFile(process.execPath, ['-e', `require('node:fs').writeSync(1,'partial');require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},60000)`], workspaceRoot, { signal: controller.signal })
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 }) // Startup readiness is separate from the cancellation deadlines below.
    controller.abort()
    expect(await pending).toMatchObject({ stdout: 'partial', killed: true })
    expect(backend.activeCount).toBe(0)
    const timeout = await backend.execFile(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], workspaceRoot, { timeout: 100 })
    expect(timeout.killed).toBe(true)
    for (const milliseconds of [1, 10, 100]) {
      expect((await backend.execFile(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], workspaceRoot, { timeout: milliseconds })).killed).toBe(true)
      expect(backend.activeCount).toBe(0)
    }
    expect(backend.activeCount).toBe(0)
    const hidden = await backend.execFile('/bin/sh', ['-c', 'test -d "$1"', '--', privateRoot], workspaceRoot)
    expect(hidden.code).not.toBe(0)
  }, 15000)
  it('reads workspace input through the actual namespace', async () => {
    const { backend, workspaceRoot } = await setup()
    expect((await backend.readFile(join(workspaceRoot, 'input.txt'))).toString()).toContain('alpha')
    expect(backend.activeCount).toBe(0)
  }, 15000)

  it('denies private reads including workspace symlinks through actual mounts', async () => {
    const { backend, workspaceRoot, secret } = await setup()
    await expect(backend.readFile(secret)).rejects.toThrow()
    await expect(backend.readFile(join(workspaceRoot, 'secret-link'))).rejects.toThrow()
    expect(backend.activeCount).toBe(0)
  }, 15000)

  it('denies private and immutable-source writes without modifying either original', async () => {
    const { backend, workspaceRoot, sources, secret } = await setup()
    await expect(backend.writeFile(join(workspaceRoot, 'secret-link'), 'tamper')).rejects.toThrow()
    await expect(backend.writeFile(join(sources, 'original.txt'), 'tamper')).rejects.toThrow()
    expect(readFileSync(secret, 'utf8')).toBe('PRIVATE_NATIVE_CANARY')
    expect(readFileSync(join(sources, 'original.txt'), 'utf8')).toBe('authorized source')
    expect(backend.activeCount).toBe(0)
  }, 15000)

  it('retains private scratch and authorized immutable sources across actual namespaces', async () => {
    const { backend, sources } = await setup()
    await backend.writeFile('/tmp/retained.txt', 'scratch works across native calls')
    expect((await backend.readFile('/tmp/retained.txt')).toString()).toBe('scratch works across native calls')
    expect((await backend.readFile(join(sources, 'original.txt'))).toString()).toBe('authorized source')
  }, 15000) // Multiple real process/namespace launches; this is an isolation assertion, not a 5s latency benchmark.

  // bwrap 0.4 rereads the host mount table for every bind. A 6k-mount development
  // host costs ~1.6s per launch even for /bin/sh; Node itself is ~35ms. Exercise
  // each complete capability family within the original 25s bound instead of
  // conflating dozens of independent namespace launches into a latency gate.
  // All original native calls, denial assertions and actual join checks remain.
  it.each(['mutations', 'discovery', 'denials'] as const)('retains native metadata and real SDK %s capability', async family => {
    const { backend, workspaceRoot, privateRoot, secret, sources } = await setup()
    const agentDir = join(privateRoot, 'agent'); mkdirSync(agentDir)
    const options = createNativeToolOptions(backend, backend.outputDirectory)
    const answers: NonNullable<Parameters<typeof createPiTestRuntime>[0]['answers']> = family === 'mutations' ? [
        { calls: [{ name: 'write', args: { path: 'result.txt', content: 'before\n' } }] },
        { calls: [{ name: 'edit', args: { path: 'result.txt', oldText: 'before', newText: 'after' } }] },
        { calls: [{ name: 'read', args: { path: 'result.txt' } }] }, 'done',
      ] : family === 'discovery' ? [
        { calls: [{ name: 'grep', args: { pattern: 'alpha', path: workspaceRoot, context: 1 } }, { name: 'find', args: { pattern: '*.txt', path: workspaceRoot } }, { name: 'ls', args: { path: workspaceRoot } }] }, 'done',
      ] : [
        { calls: [{ name: 'read', args: { path: secret } }, { name: 'grep', args: { pattern: 'PRIVATE_NATIVE_CANARY', path: join(workspaceRoot, 'secret-link') } }, { name: 'write', args: { path: join(sources, 'original.txt'), content: 'tamper' } }] },
        { calls: [{ name: 'bash', args: { command: 'printf "native-bash-ok\\n"; env' } }] }, 'done',
      ]
    const { runtime } = await createPiTestRuntime({ cwd: workspaceRoot, agentDir, sessionDir: join(privateRoot, 'sessions'), toolOptions: options,
      tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'], answers })
    cleanup.push(() => runtime.dispose())
    expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']))
    for (const name of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']) {
      const tool = runtime.session.getAllTools().find(item => item.name === name)!
      expect(tool.sourceInfo.source).toBe('builtin')
      expect(runtime.session.getToolDefinition(name)?.promptSnippet).toBeTruthy()
    }
    await runtime.session.prompt('Execute the fixed native conformance script.')
    const results = runtime.session.messages.filter(message => message.role === 'toolResult')
    expect(results).toHaveLength(family === 'denials' ? 4 : 3)
    if (family === 'denials') {
      expect(results.slice(0, 3).every(result => result.isError)).toBe(true)
      expect(results[3]!.isError).toBeFalsy()
      expect(JSON.stringify(results)).toContain('native-bash-ok')
    } else expect(results.every(result => !result.isError)).toBe(true)
    expect(JSON.stringify(results)).not.toContain('PRIVATE_NATIVE_CANARY')
    if (family === 'mutations') expect(readFileSync(join(workspaceRoot, 'result.txt'), 'utf8')).toBe('after\n')
    expect(readFileSync(join(sources, 'original.txt'), 'utf8')).toBe('authorized source')
    expect(backend.activeCount).toBe(0)
  }, 25_000)

  it('keeps explicit user Bash and large-output recovery inside the same boundary', async () => {
    const { backend, workspaceRoot, privateRoot, secret, outputRoot } = await setup()
    const agentDir = join(privateRoot, 'agent'); mkdirSync(agentDir)
    const { runtime } = await createPiTestRuntime({ cwd: workspaceRoot, agentDir, sessionDir: join(privateRoot, 'sessions'),
      toolOptions: createNativeToolOptions(backend, outputRoot), answers: [{ calls: [{ name: 'bash', args: { command: 'head -c 60000 /dev/zero | tr "\\0" x' } }] }, 'done'] })
    cleanup.push(() => runtime.dispose())
    let envOutput = ''
    await backend.execute('env', workspaceRoot, { onData: data => { envOutput += data.toString() }, env: { MODEL_SECRET: 'HIDDEN_PROVIDER_VALUE', PI_SESSION_FILE: secret, PI_MODEL: 'faux-model' } })
    expect(envOutput).not.toMatch(/HIDDEN_PROVIDER_VALUE|PI_SESSION_FILE|MODEL_SECRET/)
    expect(envOutput).toContain('PI_MODEL=faux-model')
    const explicit = await runtime.session.executeBash(`test ! -e ${JSON.stringify(secret)} && printf explicit-safe`)
    expect(explicit.output).toBe('explicit-safe')
    await runtime.session.prompt('Produce long native output.')
    const result = runtime.session.messages.find(message => message.role === 'toolResult')!
    const path = (result.details as { fullOutputPath: string }).fullOutputPath
    expect(path.startsWith(outputRoot)).toBe(true)
    expect((await backend.readFile(path)).length).toBe(60000)
    await expect(backend.writeFile(path, 'tamper')).rejects.toThrow()
  }, 15_000)

  it('enforces the short duration budget and joins the timed-out namespace', async () => {
    // Probe the actual grants before starting the short-duration assertion; a loaded Node bootstrap
    // is not the operation whose success this test is meant to assert.
    const { options, workspaceRoot } = await setup()
    const backend = new LinuxExecutor({ ...options, maxProcessMs: 800 })
    cleanup.push(() => backend.abortAll())
    await expect(backend.execute('exec tail -f /dev/null', workspaceRoot, { onData: () => {} })).rejects.toThrow(/duration/)
    expect(backend.activeCount).toBe(0)
  }, 10_000)

  it('enforces the output budget, joins manual cancellation and requires explicit resume', async () => {
    const { backend, workspaceRoot } = await setup({ maxOutputBytes: 128 * 1024 })
    await expect(backend.execute('head -c 200000 /dev/zero', workspaceRoot, { onData: () => {} })).rejects.toThrow(/output limit/)
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const controller = new AbortController()
    const running = backend.execute('printf ready; exec tail -f /dev/null', workspaceRoot, { onData: () => started(), signal: controller.signal })
    await Promise.race([ready, running.then(() => { throw new Error('Native process ended before readiness') })])
    controller.abort()
    await expect(running).rejects.toThrow(/aborted/)
    await backend.abortAll()
    expect(backend.activeCount).toBe(0)
    await expect(backend.readFile(join(workspaceRoot, 'input.txt'))).rejects.toThrow(/stopped/)
    backend.resume()
    expect((await backend.readFile(join(workspaceRoot, 'input.txt'))).length).toBeGreaterThan(0)
  }, 10_000)

  it('fails closed when grants overlap protected state or the isolation executable is missing', async () => {
    const { options, privateRoot } = await setup()
    expect(() => new LinuxExecutor({ ...options, readOnlyPaths: [privateRoot] })).toThrow(/overlaps/)
    expect(() => new LinuxExecutor({ ...options, bubblewrapExecutable: '/does-not-exist/bwrap' })).toThrow()
  })

  it('blocks a real host listener and keeps host credentials out of the namespace', async () => {
    const { backend, workspaceRoot } = await setup()
    const server = createServer(socket => socket.end('host-only'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing host listener')
    const code = `const s=require('node:net').connect(${address.port},'127.0.0.1');s.setTimeout(1000);s.on('connect',()=>{console.log('UNEXPECTED_HOST_ACCESS');s.destroy()});s.on('error',()=>console.log('NETWORK_BLOCKED'));s.on('timeout',()=>{console.log('NETWORK_BLOCKED');s.destroy()});`
    let output = ''
    await backend.execute(`node -e ${JSON.stringify(code)}`, workspaceRoot, { onData: data => { output += data.toString() } })
    expect(output).toContain('NETWORK_BLOCKED')
    expect(output).not.toContain('UNEXPECTED_HOST_ACCESS')
  })

  it('joins durable scheduling, a real native process, cancellation and saved success', async () => {
    const { backend, workspaceRoot, privateRoot } = await setup()
    const agentDir = join(privateRoot, 'agent'); mkdirSync(agentDir)
    const store = ControlStore.open(join(privateRoot, 'control')); cleanup.push(() => store.close())
    const readyMarker = 'DOCATLAS_NATIVE_SCHEDULING_READY', ready = Promise.withResolvers<void>()
    const { runtime } = await createPiTestRuntime({ cwd: workspaceRoot, agentDir, sessionDir: join(privateRoot, 'sessions'),
      toolOptions: createNativeToolOptions(backend, backend.outputDirectory), answers: [
        { calls: [{ name: 'bash', args: { command: `printf started > native-started.flag; printf '${readyMarker}\\n'; exec tail -f /dev/null` } }] },
        { calls: [{ name: 'bash', args: { command: 'printf saved > native-result.txt' } }] }, 'File saved.',
      ] })
    cleanup.push(() => runtime.dispose())
    // Wait for actual native stdout, not tool-start intent or a short polling window.
    // The existing 15s whole-test deadline still bounds startup, cancellation and saved success.
    cleanup.push(runtime.session.subscribe(event => {
      if (event.type !== 'tool_execution_update' || event.toolName !== 'bash') return
      const content: unknown = event.partialResult?.content
      if (Array.isArray(content) && content.some(part => part && typeof part === 'object' && part.type === 'text'
        && typeof part.text === 'string' && part.text.includes(readyMarker))) ready.resolve()
    }))
    const driver = new PiProductDriver(runtime.session, backend); cleanup.push(() => driver.dispose())
    const actor = { actorId: 'user:native', workspaceId: 'workspace:native' }
    store.createConversation(actor, { conversationId: 'conversation:native', runtimeSessionId: runtime.session.sessionId })
    const coordinator = new SubmissionCoordinator(store, actor, 'conversation:native', driver, prepareDocumentFree)
    cleanup.push(() => coordinator.close())
    const first = coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId: 'conversation:native', expectedGeneration: 1,
      mode: 'prompt', idempotencyKey: 'idempotency:native:stop', text: 'Run the long operation.', sourceRefs: [], selectionContextIds: [] })
    await Promise.race([ready.promise, coordinator.waitForIdle().then(() => { throw new Error('Native submission settled before emitting its readiness marker') })])
    expect(existsSync(join(workspaceRoot, 'native-started.flag'))).toBe(true)
    expect(readFileSync(join(workspaceRoot, 'native-started.flag'), 'utf8')).toBe('started')
    expect(backend.activeCount).toBeGreaterThan(0)
    await coordinator.cancel()
    expect(backend.activeCount).toBe(0)
    expect(store.get(actor, first.receipt.submissionId).state).toBe('cancelled')
    const second = coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId: 'conversation:native', expectedGeneration: 1,
      mode: 'prompt', idempotencyKey: 'idempotency:native:save', text: 'Save the native file.', sourceRefs: [], selectionContextIds: [] })
    await coordinator.waitForIdle()
    expect(store.get(actor, second.receipt.submissionId).state).toBe('completed')
    expect(readFileSync(join(workspaceRoot, 'native-result.txt'), 'utf8')).toBe('saved')
  }, 15_000)
})
