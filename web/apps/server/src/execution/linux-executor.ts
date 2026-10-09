import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { SandboxProcess } from '@docatlas/runtime-document/sandbox-process'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { NativeExecutionBackend } from '@docatlas/runtime-pi'
import { IO_WORKER_SOURCE } from './io-worker-source.js'

interface LinuxExecutorOptions {
  workspaceRoot: string
  scratchRoot: string
  outputRoot: string
  rgExecutable: string
  readOnlyPaths?: string[]
  protectedRoots: string[]
  bubblewrapExecutable?: string
  powershellExecutable?: string
  maxProcessMs?: number
  maxOutputBytes?: number
  maxFileBytes?: number
  maxActiveProcesses?: number
}
type Piped = ChildProcessByStdio<null, Readable, Readable>
type InputPiped = ChildProcessByStdio<Writable, Readable, Readable>
type Managed = { child: Piped | InputPiped, completion: Promise<void>, stop: () => void, failure?: Error, stopped?: boolean }

/** Native operation boundary only. Trusted Pi extensions/runtime and source authorization are separate gates. */
export class LinuxExecutor implements NativeExecutionBackend {
  private readonly options: Required<Omit<LinuxExecutorOptions, 'powershellExecutable'>> & Pick<LinuxExecutorOptions, 'powershellExecutable'>
  private readonly active = new Set<Managed>()
  private accepting = true
  private resourceMount: { source: string, target: string } | undefined

  constructor(options: LinuxExecutorOptions) {
    if (process.platform !== 'linux') throw new Error('Linux execution boundary is unavailable on this platform')
    const bubblewrapExecutable = options.bubblewrapExecutable ?? '/usr/bin/bwrap'
    for (const path of [options.workspaceRoot, options.scratchRoot, options.outputRoot, options.rgExecutable, bubblewrapExecutable, ...options.protectedRoots, ...(options.readOnlyPaths ?? []), ...(options.powershellExecutable ? [options.powershellExecutable] : [])]) {
      if (!isAbsolute(path) || path !== resolve(path) || path === '/' || path === homedir()) throw new Error('Execution grants require explicit, bounded absolute paths')
    }
    for (const path of [options.workspaceRoot, options.rgExecutable, bubblewrapExecutable, ...(options.readOnlyPaths ?? []), ...(options.powershellExecutable ? [options.powershellExecutable] : [])]) realPath(path)
    for (const path of [options.scratchRoot, options.outputRoot]) { mkdirSync(path, { recursive: true, mode: 0o700 }); realPath(path) }
    if (!lstatSync(options.workspaceRoot).isDirectory()) throw new Error('Workspace must be a directory')
    const grants = ['/usr', '/bin', '/lib', '/lib64', process.execPath, options.rgExecutable, options.workspaceRoot, options.scratchRoot, options.outputRoot, ...(options.readOnlyPaths ?? []), ...(options.powershellExecutable ? [options.powershellExecutable] : [])]
    for (const secret of options.protectedRoots) for (const grant of grants) {
      if (within(grant, secret) || within(secret, grant)) throw new Error('Native filesystem grant overlaps protected product state')
    }
    if (within(options.workspaceRoot, options.outputRoot) || within(options.workspaceRoot, options.scratchRoot)
      || within(options.outputRoot, options.workspaceRoot) || within(options.scratchRoot, options.workspaceRoot)) throw new Error('Native scratch/output directories must be separate from the workspace')
    this.options = { ...options, bubblewrapExecutable, readOnlyPaths: [...(options.readOnlyPaths ?? [])], protectedRoots: [...options.protectedRoots],
      maxProcessMs: options.maxProcessMs ?? 300_000, maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
      maxFileBytes: options.maxFileBytes ?? 64 * 1024 * 1024, maxActiveProcesses: options.maxActiveProcesses ?? 8 }
    for (const [name, value, max] of [['maxProcessMs', this.options.maxProcessMs, 1800_000], ['maxOutputBytes', this.options.maxOutputBytes, 256 * 1024 * 1024],
      ['maxFileBytes', this.options.maxFileBytes, 64 * 1024 * 1024], ['maxActiveProcesses', this.options.maxActiveProcesses, 64]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name} execution bound`)
    }
  }

  get activeCount(): number { return this.active.size }
  get outputDirectory(): string { return this.options.outputRoot }
  get workspaceRoot(): string { return this.options.workspaceRoot }
  bindResourceSnapshot(source: string, target: string): () => void {
    if (this.active.size || this.resourceMount) throw new Error('Resource binding requires a fresh execution boundary')
    for (const path of [source, target]) if (!isAbsolute(path) || path !== resolve(path) || path === '/' || path === homedir()) throw new Error('Invalid resource grant')
    realPath(source)
    if (!lstatSync(source).isDirectory()) throw new Error('Resource grant must be a directory')
    if (within(target, '/tmp')) throw new Error('Resource alias cannot replace native scratch')
    for (const path of ['/usr', '/bin', '/lib', '/lib64', '/runtime', this.options.workspaceRoot, this.options.outputRoot, this.options.scratchRoot, ...this.options.readOnlyPaths]) {
      if (within(target, path) || within(path, target)) throw new Error('Resource alias overlaps another native grant')
    }
    const mount = { source, target }; this.resourceMount = mount
    return () => { if (this.active.size) throw new Error('Resource grant still has running processes'); if (this.resourceMount === mount) this.resourceMount = undefined }
  }

  async preflight(): Promise<void> {
    const result = await this.collect(this.launch('/runtime/node', ['-e', 'process.stdout.write("boundary-ready")'], this.options.workspaceRoot, false), 128)
    if (result.code !== 0 || result.stdout !== 'boundary-ready') throw new Error(`Native isolation preflight failed; host execution is not a fallback: ${result.stderr}`)
  }

  async readFile(path: string): Promise<Buffer> { return Buffer.from(await this.io('read', path) as string, 'base64') }
  async readPrefix(path: string, bytes: number): Promise<Buffer> { return Buffer.from(await this.io('prefix', path, { prefixBytes: bytes }) as string, 'base64') }
  async access(path: string, writable = false): Promise<void> { await this.io('access', path, { writable }) }
  async exists(path: string): Promise<boolean> { return await this.io('exists', path) as boolean }
  async stat(path: string): Promise<{ directory: boolean }> { return await this.io('stat', path) as { directory: boolean } }
  async readdir(path: string): Promise<string[]> { return await this.io('readdir', path) as string[] }
  async mkdir(path: string): Promise<void> { await this.io('mkdir', path) }
  async writeFile(path: string, content: string): Promise<void> { await this.io('write', path, { content }) }

  async glob(pattern: string, cwd: string, options: { ignore: string[], limit: number }): Promise<string[]> {
    const args = ['--files', '--hidden', '--glob', pattern, ...options.ignore.flatMap(value => ['--glob', `!${value}`]), '--', cwd]
    const result = await this.collect(this.launch('/runtime/rg', args, cwd, false), this.options.maxOutputBytes)
    if (result.code !== 0 && result.code !== 1) throw new Error('File search failed in execution boundary')
    return result.stdout.split('\n').filter(Boolean).slice(0, options.limit)
  }

  spawnGrep(command: string, args: string[]): Piped {
    if (command !== 'rg') throw new Error('Unexpected native search executable')
    return this.launch('/runtime/rg', args, this.options.workspaceRoot, false).child as Piped
  }

  async execute(command: string, cwd: string, options: Parameters<NativeExecutionBackend['execute']>[2], shell: 'bash' | 'powershell' = 'bash'): Promise<{ exitCode: number | null }> {
    if (options.signal?.aborted) throw new Error('Operation aborted')
    const executable = shell === 'bash' ? '/bin/bash' : '/runtime/pwsh'
    if (shell === 'powershell' && !this.options.powershellExecutable) throw new Error('PowerShell is not configured in this execution boundary')
    const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', command] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    const managed = this.launch(executable, args, cwd, false, options.env)
    const { child } = managed
    const output = (data: Buffer) => { try { options.onData(Buffer.from(data)) } catch (error) { managed.failure = error instanceof Error ? error : new Error('Native output observer failed'); managed.stop() } }
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    const abort = () => managed.stop()
    options.signal?.addEventListener('abort', abort, { once: true })
    const timeout = options.timeout === undefined ? undefined : setTimeout(() => { managed.failure = new Error('Native command timed out'); managed.stop() }, Math.max(1, options.timeout * 1000))
    if (options.signal?.aborted) abort()
    try {
      await managed.completion
      if (options.signal?.aborted) throw new Error('Operation aborted')
      if (managed.failure) throw managed.failure
      return { exitCode: child.exitCode }
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
  }

  /** Original extension argv semantics, inside the same native execution boundary. */
  async execFile(command: string, args: string[], cwd: string, options: { signal?: AbortSignal, timeout?: number } = {}): Promise<{ stdout: string, stderr: string, code: number, killed: boolean }> {
    if (!command || command.includes('\0') || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || args.length > 4096
      || Buffer.byteLength(JSON.stringify([command, args])) > 1024 * 1024) throw new Error('Invalid extension command')
    if (options.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout < 0 || options.timeout > 1800000)) throw new Error('Invalid extension timeout')
    if (options.signal?.aborted) return { stdout: '', stderr: '', code: 0, killed: true }
    const managed = this.launch(command === process.execPath ? '/runtime/node' : command, args, cwd, false)
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let killed = false
    const stop = () => { killed = true; managed.stop() }
    managed.child.stdout.on('data', (bytes: Buffer) => { if (!managed.failure) stdout.push(Buffer.from(bytes)) })
    managed.child.stderr.on('data', (bytes: Buffer) => { if (!managed.failure) stderr.push(Buffer.from(bytes)) })
    options.signal?.addEventListener('abort', stop, { once: true })
    const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined
    if (options.signal?.aborted) stop()
    try {
      await managed.completion
      if (managed.failure) throw managed.failure
      return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: managed.child.exitCode ?? 0, killed: killed || managed.stopped === true }
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop) }
  }

  /** Latches closed to new operations until the next authorized execution explicitly resumes. */
  async abortAll(): Promise<void> { this.accepting = false; const jobs = [...this.active]; for (const job of jobs) job.stop(); await Promise.all(jobs.map(job => job.completion)) }
  resume(): void { if (this.active.size) throw new Error('Cannot resume while execution is still active'); this.accepting = true }

  private async io(operation: string, path: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('File operation needs an absolute path')
    const input = JSON.stringify({ operation, path, ...fields, maxFileBytes: this.options.maxFileBytes })
    if (Buffer.byteLength(input) > 96 * 1024 * 1024) throw new Error('File operation input exceeds limit')
    const managed = this.launch('/runtime/node', ['-e', IO_WORKER_SOURCE], this.options.workspaceRoot, true)
    const resultPromise = this.collect(managed, Math.ceil(this.options.maxFileBytes * 1.4) + 1024)
    const stdin = (managed.child as InputPiped).stdin
    stdin.on('error', () => {}) // Early rejection is reported by the child completion, not an unhandled EPIPE.
    stdin.end(input)
    const result = await resultPromise
    if (result.code !== 0) throw new Error('File operation failed inside execution boundary')
    const response = JSON.parse(result.stdout) as { ok: boolean, value?: unknown, code?: string, message?: string }
    if (!response.ok) throw Object.assign(new Error(response.message ?? 'File operation unavailable'), { code: response.code })
    return response.value
  }

  private launch(command: string, args: string[], cwd: string, withInput: boolean, requestedEnv?: NodeJS.ProcessEnv): Managed {
    if (!this.accepting) throw new Error('Execution boundary is stopped')
    if (this.active.size >= this.options.maxActiveProcesses) throw new Error('Execution process concurrency limit reached')
    if (!isAbsolute(cwd) || cwd.includes('\0')) throw new Error('Invalid execution cwd')
    const config = this.options
    for (const path of [config.workspaceRoot, config.scratchRoot, config.outputRoot, config.rgExecutable, ...config.readOnlyPaths]) realPath(path)
    if (this.resourceMount) realPath(this.resourceMount.source)
    const bwrapArgs = ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--new-session', '--info-fd', '3',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--dir', '/runtime', '--ro-bind', process.execPath, '/runtime/node',
      '--ro-bind', config.rgExecutable, '/runtime/rg', '--bind', config.scratchRoot, '/tmp',
      '--bind', config.workspaceRoot, config.workspaceRoot, '--ro-bind', config.outputRoot, config.outputRoot,
      ...config.readOnlyPaths.flatMap(path => ['--ro-bind', path, path]),
      ...(this.resourceMount ? ['--ro-bind', this.resourceMount.source, this.resourceMount.target] : []),
      ...(config.powershellExecutable ? ['--ro-bind', config.powershellExecutable, '/runtime/pwsh'] : []),
      '--chdir', cwd, '--', command, ...args]
    // Credential/process environment is never inherited from Pi or the server.
    const env: NodeJS.ProcessEnv = { PATH: '/runtime:/usr/bin:/bin', LANG: 'C.UTF-8' }
    for (const name of ['PI_SESSION_ID', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL']) {
      const value = requestedEnv?.[name]
      if (value !== undefined && value.length <= 1024 && !['\r', '\n', '\0'].some(character => value.includes(character))) env[name] = value
    }
    const child = spawn(config.bubblewrapExecutable, bwrapArgs, { env, detached: true, stdio: [withInput ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'] }) as Piped | InputPiped
    let outputBytes = 0, finished!: () => void
    const sandbox = new SandboxProcess(child, error => { managed.failure = error })
    const stop = () => { managed.stopped = true; return sandbox.stop() }
    child.kill = () => stop()
    const managed: Managed = { child, stop, completion: new Promise<void>(resolve => { finished = resolve }) }
    const fail = (error: Error) => { managed.failure = error; child.emit('error', error); stop() }
    const timer = setTimeout(() => fail(new Error('Native process duration limit exceeded')), config.maxProcessMs)
    const measure = (chunk: Buffer) => {
      outputBytes += chunk.length
      const max = withInput ? Math.ceil(config.maxFileBytes * 1.4) + 1024 : config.maxOutputBytes
      if (outputBytes > max && !managed.failure) fail(new Error('Native process output limit exceeded'))
    }
    child.stdout.on('data', measure); child.stderr.on('data', measure)
    child.on('error', error => { managed.failure = error })
    void sandbox.done.then(() => { clearTimeout(timer); this.active.delete(managed); finished() })
    this.active.add(managed)
    return managed
  }

  private async collect(managed: Managed, maxBytes: number): Promise<{ code: number | null, stdout: string, stderr: string }> {
    const chunks: Buffer[] = []
    let length = 0
    let stderr = ''
    managed.child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8192) })
    managed.child.stdout.on('data', data => {
      length += data.length
      if (length <= maxBytes) chunks.push(Buffer.from(data))
      else { managed.failure = new Error('Native response exceeds limit'); managed.stop() }
    })
    await managed.completion
    if (managed.failure) throw managed.failure
    return { code: managed.child.exitCode, stdout: Buffer.concat(chunks).toString('utf8'), stderr }
  }
}

function realPath(path: string): void { if (!existsSync(path) || realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) throw new Error('Execution grant must be an existing non-symlink path') }
function within(root: string, path: string): boolean { const child = relative(root, path); return !child || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child)) }
