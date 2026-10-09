import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WorkerJson } from '@docatlas/contracts'
import type { NativeExecutionBackend } from '../native-operations.js'
import { WorkerPeer, WorkerRpcError, WorkerCancelledResult, workerJson, type WorkerHandler } from './peer.js'
import { record } from './model-bridge.js'

export function nativeBroker(backend: NativeExecutionBackend, authorize: () => void): WorkerHandler {
  return async (candidate, call) => {
    authorize(); call.signal.throwIfAborted()
    const value = record(candidate)
    const path = () => string(value.path)
    const send = (channel: 'stdout' | 'stderr', bytes: Buffer) => call.yield({ channel, data: bytes.toString('base64') })
    let result: WorkerJson
    switch (value.operation) {
      case 'execFile': {
        if (!backend.execFile) throw new WorkerRpcError('unavailable')
        const options = record(value.options)
        const result = await backend.execFile(string(value.command), strings(value.args), string(value.cwd), { signal: call.signal,
          ...(options.timeout !== undefined ? { timeout: integer(options.timeout, 0, 1800000) } : {}) })
        if (!call.signal.aborted) authorize()
        return new WorkerCancelledResult(workerJson(result))
      }
      case 'readFile': result = (await backend.readFile(path())).toString('base64'); break
      case 'readPrefix': result = (await (backend.readPrefix?.(path(), integer(value.bytes, 1, 65536)) ?? backend.readFile(path()))).toString('base64'); break
      case 'access': await backend.access(path(), value.writable === true); result = null; break
      case 'exists': result = await backend.exists(path()); break
      case 'stat': result = await backend.stat(path()); break
      case 'readdir': result = await backend.readdir(path()); break
      case 'mkdir': await backend.mkdir(path()); result = null; break
      case 'writeFile': await backend.writeFile(path(), string(value.content)); result = null; break
      case 'glob': {
        const options = record(value.options)
        result = await backend.glob(string(value.pattern), string(value.cwd), { ignore: strings(options.ignore), limit: integer(options.limit, 1, 100000) }); break
      }
      case 'execute': {
        const options = record(value.options)
        let forwarding: Promise<void> = Promise.resolve()
        const output = await backend.execute(string(value.command), string(value.cwd), {
          signal: call.signal,
          onData: data => { forwarding = forwarding.then(() => send('stdout', data)); void forwarding.catch(() => {}) },
          ...(options.timeout !== undefined ? { timeout: integer(options.timeout, 1, 1800) } : {}),
          ...(options.env !== undefined ? { env: stringRecord(options.env) } : {}),
        }, value.shell === 'powershell' ? 'powershell' : 'bash')
        await forwarding; result = workerJson(output); break
      }
      case 'grep': {
        const child = backend.spawnGrep(string(value.command), strings(value.args))
        const stop = () => { child.kill('SIGTERM') }
        call.signal.addEventListener('abort', stop, { once: true })
        let forwarding: Promise<void> = Promise.resolve()
        child.stdout.on('data', (bytes: Buffer) => { child.stdout.pause(); forwarding = forwarding.then(() => send('stdout', bytes)).finally(() => child.stdout.resume()); void forwarding.catch(() => {}) })
        child.stderr.on('data', (bytes: Buffer) => { child.stderr.pause(); forwarding = forwarding.then(() => send('stderr', bytes)).finally(() => child.stderr.resume()); void forwarding.catch(() => {}) })
        try {
          const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
          await forwarding; result = { exitCode }
        } finally { call.signal.removeEventListener('abort', stop) }
        break
      }
      default: throw new WorkerRpcError('denied')
    }
    call.signal.throwIfAborted(); authorize(); return result
  }
}
export function remoteNativeBackend(peer: WorkerPeer): NativeExecutionBackend {
  const request = (operation: string, value: object) => peer.call('native.call', workerJson({ operation, ...value }))
  return {
    async execFile(command, args, cwd, options = {}) {
      if (options.signal?.aborted) return { stdout: '', stderr: '', code: 0, killed: true }
      return await peer.call('native.call', workerJson({ operation: 'execFile', command, args, cwd, options: { timeout: options.timeout } }), {
        ...(options.signal ? { signal: options.signal } : {}), awaitCancellation: true,
      }) as unknown as Awaited<ReturnType<NonNullable<NativeExecutionBackend['execFile']>>>
    },
    readFile: async path => Buffer.from(string(await request('readFile', { path })), 'base64'),
    readPrefix: async (path, bytes) => Buffer.from(string(await request('readPrefix', { path, bytes })), 'base64'),
    access: async (path, writable) => { await request('access', { path, writable: writable === true }) },
    exists: async path => (await request('exists', { path })) === true,
    stat: async path => ({ directory: record(await request('stat', { path })).directory === true }),
    readdir: async path => strings(await request('readdir', { path })),
    mkdir: async path => { await request('mkdir', { path }) },
    writeFile: async (path, content) => { await request('writeFile', { path, content }) },
    glob: async (pattern, cwd, options) => strings(await request('glob', { pattern, cwd, options })),
    async execute(command, cwd, options, shell) {
      const value = await peer.call('native.call', workerJson({ operation: 'execute', command, cwd, shell: shell ?? 'bash', options: { timeout: options.timeout, env: options.env } }), {
        ...(options.signal ? { signal: options.signal } : {}), progress: value => { options.onData(Buffer.from(string(record(value).data), 'base64')) },
      })
      const code = record(value).exitCode
      return { exitCode: code === null ? null : integer(code, -2147483648, 2147483647) }
    },
    spawnGrep(command, args) {
      const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough(), controller = new AbortController()
      Object.assign(child, { stdout, stderr, kill: () => { controller.abort(); return true } })
      void peer.call('native.call', workerJson({ operation: 'grep', command, args }), { signal: controller.signal, progress: value => {
        const event = record(value); (event.channel === 'stderr' ? stderr : stdout).write(Buffer.from(string(event.data), 'base64'))
      } }).then(value => { stdout.end(); stderr.end(); child.emit('close', record(value).exitCode) }, error => {
        stdout.end(); stderr.end()
        if (!controller.signal.aborted) child.emit('error', error)
        child.emit('close', null)
      })
      return child as ReturnType<NativeExecutionBackend['spawnGrep']>
    },
  }
}
export function string(value: WorkerJson | undefined): string { if (typeof value !== 'string') throw new WorkerRpcError('invalid'); return value }
function strings(value: WorkerJson | undefined): string[] { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new WorkerRpcError('invalid'); return value as string[] }
function integer(value: WorkerJson | undefined, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new WorkerRpcError('invalid'); return value }
function stringRecord(value: WorkerJson): Record<string, string> {
  const object = record(value)
  if (Object.values(object).some(item => typeof item !== 'string')) throw new WorkerRpcError('invalid')
  return object as Record<string, string>
}
