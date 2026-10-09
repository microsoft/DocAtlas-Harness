import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRuntime, SessionManager, SettingsManager, type AgentSessionEvent, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, Type } from '@earendil-works/pi-ai'
import { createPiRuntime } from '../src/index.js'

const cleanup: Array<() => void | Promise<void>> = []
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network disabled in Pi lifecycle tests') }) })
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks() })

async function setup(extensionFactories: ExtensionFactory[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-pi-lifecycle-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'project'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions')
  mkdirSync(cwd); mkdirSync(agentDir)
  writeFileSync(join(cwd, 'AGENTS.md'), 'Use the DOCATLAS_NATIVE_CONTEXT_SENTINEL in this test project.')
  const skill = join(agentDir, 'skills', 'fixture-skill')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Inspect local fixture files.\n---\nUse native read.\n')
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  })
  const faux = fauxProvider()
  modelRuntime.registerNativeProvider(faux.provider)
  const events: AgentSessionEvent[] = []
  const boundIds: string[] = []
  let invalidations = 0
  let detach: (() => void) | undefined
  const runtime = await createPiRuntime({
    cwd, agentDir, sessionManager: SessionManager.create(cwd, sessionDir), modelRuntime,
    services: () => ({
      settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'always', compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { extensionFactories },
    }),
    session: { model: faux.getModel() },
    onBound: session => { boundIds.push(session.sessionId); detach = session.subscribe(event => events.push(event)) },
    onInvalidate: () => { invalidations++; detach?.() },
  })
  cleanup.push(async () => { detach?.(); await runtime.dispose() })
  return { root, cwd, agentDir, runtime, faux, events, boundIds, invalidations: () => invalidations }
}

describe('published Pi SDK: native behavior and lifecycle evidence', () => {
  it('retains default native tools, trusted AGENTS, skills and incremental extension tools', async () => {
    const { runtime, faux, events } = await setup([pi => {
      pi.registerTool({ name: 'docatlas_probe', label: 'Probe', description: 'Test-only incremental tool', parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'PROBE_OK' }], details: {} }) })
    }])
    expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write', 'docatlas_probe']))
    expect(runtime.session.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['grep', 'find', 'ls']))
    expect(runtime.session.resourceLoader.getSkills().skills.some(skill => skill.name === 'fixture-skill')).toBe(true)
    expect(runtime.session.agent.state.systemPrompt).toContain('DOCATLAS_NATIVE_CONTEXT_SENTINEL')
    faux.setResponses([fauxAssistantMessage(fauxToolCall('docatlas_probe', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('done')])
    await runtime.session.prompt('Run the probe without any PDF scope.')
    expect(events.some(event => event.type === 'tool_execution_end' && event.toolName === 'docatlas_probe')).toBe(true)
    expect(events.at(-1)?.type).toBe('agent_settled')
    expect(runtime.session.isIdle).toBe(true)
  })

  it('executes native write/read/edit/bash with real files and original result handling', async () => {
    const { cwd, runtime, faux } = await setup()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'note.txt', content: 'alpha\n' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('edit', { path: 'note.txt', oldText: 'alpha', newText: 'beta' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' }), fauxToolCall('bash', { command: 'printf NATIVE_BASH_OK' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('native task completed'),
    ])
    await runtime.session.prompt('Perform the local file task.')
    expect(readFileSync(join(cwd, 'note.txt'), 'utf8')).toBe('beta\n')
    const results = runtime.session.messages.filter(message => message.role === 'toolResult')
    expect(results.length).toBe(4)
    expect(results.every(message => !message.isError)).toBe(true)
    expect(JSON.stringify(results)).toContain('NATIVE_BASH_OK')
    expect(JSON.stringify(results)).toContain('beta')
  })

  it('proves listener observation precedes append and a settled first answer reaches native JSONL', async () => {
    const { runtime, faux } = await setup()
    const manager = runtime.session.sessionManager
    const observations: Array<{ role: string, file: boolean, entries: number }> = []
    runtime.session.subscribe(event => {
      if (event.type === 'message_end') observations.push({ role: event.message.role, file: existsSync(manager.getSessionFile()!), entries: manager.getEntries().length })
    })
    faux.setResponses([fauxAssistantMessage('first answer')])
    await runtime.session.prompt('first question')
    expect(observations.find(item => item.role === 'user')?.file).toBe(false)
    expect(observations.find(item => item.role === 'assistant')?.file).toBe(false)
    const file = manager.getSessionFile()!
    expect(existsSync(file)).toBe(true)
    const restored = SessionManager.open(file)
    expect(restored.getSessionId()).toBe(manager.getSessionId())
    expect(restored.getLeafId()).toBe(manager.getLeafId())
    expect(restored.buildSessionContext().messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(readFileSync(file, 'utf8')).toContain('first question')
    // This is file persistence evidence, deliberately not an fsync/power-loss guarantee.
  })

  it('rebinds a new session and resumes the old native transcript without reusing stale subscriptions', async () => {
    const { runtime, faux, boundIds, invalidations } = await setup()
    faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second'), fauxAssistantMessage('continued')])
    await runtime.session.prompt('one')
    const first = runtime.session, file = first.sessionFile!
    await runtime.newSession()
    expect(runtime.session).not.toBe(first)
    expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']))
    await runtime.session.prompt('two')
    await runtime.switchSession(file)
    await runtime.session.prompt('three')
    expect(boundIds).toHaveLength(3)
    expect(boundIds[0]).toBe(boundIds[2])
    expect(boundIds[1]).not.toBe(boundIds[0])
    expect(invalidations()).toBe(2)
    const history = JSON.stringify(runtime.session.messages)
    expect(history).toContain('one'); expect(history).toContain('three'); expect(history).not.toContain('second')
  })

  it('propagates native tool errors without false success', async () => {
    const { runtime, faux } = await setup()
    faux.setResponses([fauxAssistantMessage(fauxToolCall('read', { path: 'missing.txt' }), { stopReason: 'toolUse' }), fauxAssistantMessage('The file is missing.')])
    await runtime.session.prompt('Read the missing file.')
    expect(runtime.session.messages.find(message => message.role === 'toolResult')?.isError).toBe(true)
  })

  it('cancels explicit user Bash through abortBash rather than assuming model abort covers it', async () => {
    const { runtime } = await setup()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let cancelled = false
    const run = runtime.session.executeBash('test-only-operation', () => {}, { operations: {
      exec: async (_command, _cwd, options) => {
        started()
        return new Promise((resolve, reject) => {
          const abort = () => { cancelled = true; reject(new Error('aborted')) }
          if (options.signal?.aborted) abort()
          else options.signal?.addEventListener('abort', abort, { once: true })
        })
      },
    } })
    await ready
    runtime.session.abortBash()
    await run
    expect(cancelled).toBe(true)
  })

  it('stops a real native Bash process, rather than just changing a UI state', async () => {
    const { runtime } = await setup()
    let started!: (pid: number) => void
    const ready = new Promise<number>(resolve => { started = resolve })
    let output = ''
    const run = runtime.session.executeBash('printf "NATIVE_PID:%s\\n" "$$"; exec tail -f /dev/null', chunk => {
      output += chunk
      const match = /NATIVE_PID:(\d+)/.exec(output)
      if (match) started(Number(match[1]))
    })
    const pid = await ready
    runtime.session.abortBash()
    await run
    await expect.poll(() => { try { process.kill(pid, 0); return false } catch { return true } }).toBe(true)
  })

  it('preserves native steering rather than discarding a queued message', async () => {
    const { runtime, faux } = await setup()
    let started!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    faux.setResponses([async () => { started(); await gate; return fauxAssistantMessage('first response') }, fauxAssistantMessage('steered response')])
    const run = runtime.session.prompt('initial question')
    await ready
    await runtime.session.steer('include this extra requirement')
    release()
    await run
    expect(faux.state.callCount).toBe(2)
    expect(JSON.stringify(runtime.session.messages)).toContain('include this extra requirement')
    expect(JSON.stringify(runtime.session.messages)).toContain('steered response')
    expect(runtime.session.isIdle).toBe(true)
  })

  it('observes exact transformed user objects and rejects preflight before creating a ghost queue item', async () => {
    const { runtime, faux } = await setup([pi => { pi.on('input', event => ({ action: 'transform', text: `transformed: ${event.text}` })) }])
    let started!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    faux.setResponses([async () => { started(); await gate; return fauxAssistantMessage('first') }, fauxAssistantMessage('second')])
    const messages: unknown[] = []
    const run = runtime.session.prompt('same', { onUserMessage: message => messages.push(message) })
    await ready
    await expect(runtime.session.prompt('rejected', { streamingBehavior: 'steer', onUserMessage: () => { throw new Error('admission stopped') } })).rejects.toThrow('admission stopped')
    expect(runtime.session.getSteeringMessages()).toEqual([])
    await runtime.session.prompt('same', { streamingBehavior: 'followUp', onUserMessage: message => messages.push(message) })
    release(); await run
    expect(messages).toHaveLength(2)
    expect(messages[0]).not.toBe(messages[1])
    expect(JSON.stringify(messages)).toContain('transformed: same')
    const users = runtime.session.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user')
    expect(users.every(entry => entry.type === 'message' && messages.includes(entry.message))).toBe(true)
    expect(faux.state.callCount).toBe(2)
  })

  it('reproduces the first-prompt crash gap in an actual child process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docatlas-pi-crash-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const child = fork(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/first-prompt-crash.mjs'), [root], {
      execPath: process.execPath, execArgv: [], env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr?.on('data', data => { stderr += String(data) })
    const exited = once(child, 'exit')
    try {
      const receipt = await new Promise<{ stage: string, sessionFile: string, entries: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child readiness timeout: ${stderr}`)), 12_000)
        child.once('message', value => { clearTimeout(timer); resolve(value as { stage: string, sessionFile: string, entries: number }) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`child exited early: ${stderr}`)) })
      })
      expect(receipt.stage).toBe('model-started')
      expect(receipt.entries).toBeGreaterThan(0)
      expect(existsSync(receipt.sessionFile)).toBe(false)
      child.kill('SIGKILL')
      await exited
      expect(existsSync(receipt.sessionFile)).toBe(false)
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
  }, 15_000)
})
