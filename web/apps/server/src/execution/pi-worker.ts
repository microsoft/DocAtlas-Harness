import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, realpathSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { SandboxProcess } from '@docatlas/runtime-document/sandbox-process'
import { parseContract } from '@docatlas/contracts/node'
import type { RuntimeProgress, NativeConversationHistory, ProductPiCheckpoint, ProductPreparedSubmission, NativeRuntimeState, NativeControlApply, NativeControlOutcome, NativeSelectedHead, NativeLineageApply, NativeLineageOutcome } from '@docatlas/contracts'
import type { ProductActor } from '../storage/control-store.js'
import type { ResourceStore } from '../storage/resource-store.js'
import type { ProductRuntimeDriver, RuntimeSubmission, RuntimeOutcome, RuntimeExecutionBoundary, NativeExecutionBackend } from '@docatlas/runtime-pi'
import { WorkerPeer, WorkerRpcError, brokerCatalog, modelBroker, nativeBroker, documentBroker, workerJson, checkpointConversation, inspectNativeSession,
  verifyNativeRuntimeState, verifyNativeControlProof, verifyNativeSelectedHead, verifyNativeLineageOutcome,
  type NativeLineageWorkerResult, type NativeLineageConfigurationSeed, type NativeSessionSeal, type WorkerHandler } from '@docatlas/runtime-pi/worker'

interface PiWorkerOptions {
  workspaceRoot: string
  agentDir: string
  sessionDir: string
  outputDir: string
  sessionId: string
  resources: { store: ResourceStore, actor: ProductActor, approvalId: string }
  protectedRoots: readonly string[]
  native: NativeExecutionBackend & RuntimeExecutionBoundary
  modelRuntime: Parameters<typeof modelBroker>[0]
  models: Parameters<typeof modelBroker>[1]
  modelPolicy?: Parameters<typeof modelBroker>[4]
  authorize(): void
  resume?: { file: string, seal: NativeSessionSeal, checkpoint?: ProductPiCheckpoint, selectedHead?: NativeSelectedHead, lineageConfiguration?: NativeLineageConfigurationSeed }
  onSessionFile?(file: string): void
  onDiagnostic?(text: string): void
  documents?: { operations: Parameters<typeof documentBroker>[0], boundary: RuntimeExecutionBoundary, invalidate(): void, onCheckpoint?(file: string, checkpoint: ProductPiCheckpoint, prepared: ProductPreparedSubmission): void }
}
const require = createRequire(import.meta.url)
function inside(root: string, path: string): boolean { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) }

/** Private internal worker host. No browser-supplied grants, provider objects or authority callbacks. */
export class IsolatedPiWorker implements ProductRuntimeDriver {
  private readonly peer: WorkerPeer
  private active = 0
  private nativeControlActive = false
  private effectsFenced = false
  private stopped = false
  private terminated = false
  private readonly exited: Promise<void>
  private readonly sandbox: SandboxProcess
  private sessionFile: string | undefined
  private lineageTarget: { file: string, sessionId: string } | undefined
  private unsubscribeResources: (() => void) | undefined
  private releaseResources: (() => void) | undefined
  private history: NativeConversationHistory = { checkpoint: null, messages: [], hasEarlier: false }
  private readonly observers = new Set<(submissionId: string, progress: RuntimeProgress) => void>()
  private constructor(private readonly options: PiWorkerOptions, private readonly child: ChildProcessWithoutNullStreams) {
    this.sandbox = new SandboxProcess(child, () => { this.stopped = true; this.peer.close() })
    this.exited = this.sandbox.done.then(() => { this.terminated = true; this.peer.close() })
    let diagnostics = 0
    child.stderr.on('data', (bytes: Buffer) => { diagnostics += bytes.length; if (diagnostics > 65536) this.kill(); else try { options.onDiagnostic?.(bytes.toString('utf8')) } catch { /* Diagnostics are non-authoritative. */ } })
    const authorize = () => { if (this.stopped || this.terminated) throw new WorkerRpcError('denied'); options.authorize() }
    // Only new effect admission is fenced: handlers already admitted must still
    // finish their original authorization checks and actual supervisor joins.
    const admit = (handler: WorkerHandler): WorkerHandler => async (value, call) => {
      if (this.effectsFenced) throw new WorkerRpcError('denied')
      return handler(value, call)
    }
    const handlers = new Map<string, WorkerHandler>([
      ['model.stream', admit(modelBroker(options.modelRuntime, options.models, authorize, (method, value, signal) => this.peer.call(method, value, { signal }), options.modelPolicy))],
      ['native.call', admit(nativeBroker(options.native, authorize))],
      ['native.stop', async () => { await this.abortEffects(); return null }],
    ])
    if (options.documents) handlers.set('document.call', admit(documentBroker(options.documents.operations, authorize)))
    this.peer = new WorkerPeer(child.stdout, child.stdin, handlers, () => { this.kill(); void this.abortEffects() })
    child.once('error', () => { this.peer.close() })
  }
  static async create(options: PiWorkerOptions): Promise<IsolatedPiWorker> {
    options.authorize()
    const lease = options.resources.store.lease(options.resources.actor, options.resources.approvalId)
    if (!options.native.bindResourceSnapshot) throw new Error('Native backend cannot grant approved resource bytes')
    if (process.platform !== 'linux' || !existsSync('/usr/bin/bwrap')) throw new Error('Pi worker isolation unavailable')
    const entry = require.resolve('@docatlas/runtime-pi/worker/entry')
    const piRoot = dirname(dirname(dirname(entry))), repo = dirname(dirname(piRoot))
    const code = [piRoot, resolve(repo, 'packages/contracts'), resolve(repo, 'packages/core'), resolve(repo, 'node_modules')]
    const data = [options.workspaceRoot, options.agentDir, options.sessionDir, options.outputDir]
    for (const path of [...data, ...options.protectedRoots, ...code]) {
      if (!isAbsolute(path) || path !== resolve(path) || path === '/' || path === homedir()) throw new Error('Use dedicated worker directories')
      let ancestor = path
      while (!existsSync(ancestor)) ancestor = dirname(ancestor)
      if (realpathSync(ancestor) !== ancestor) throw new Error('Worker grants cannot traverse symlinks')
    }
    for (const path of [options.workspaceRoot, ...code]) realpathSync(path)
    const osIdentity = ['/etc/passwd', '/etc/group'].filter(path => existsSync(path))
    const grants = [...data, ...code, ...osIdentity, '/usr', '/bin', '/lib', '/lib64', process.execPath]
    for (const denied of [...options.protectedRoots, options.resources.store.root]) for (const grant of grants) if (inside(denied, grant) || inside(grant, denied)) throw new Error('Worker grant overlaps private product state')
    for (const privateRuntime of [options.agentDir, options.sessionDir]) if (inside(options.workspaceRoot, privateRuntime) || inside(privateRuntime, options.workspaceRoot)) throw new Error('Native workspace must not contain private Pi state')
    if (inside(options.agentDir, options.sessionDir) || inside(options.sessionDir, options.agentDir) || inside(options.agentDir, options.outputDir) || inside(options.outputDir, options.agentDir)) throw new Error('Resource code and writable runtime state must be separate')
    for (const runtime of code) if (data.some(path => inside(path, runtime) || inside(runtime, path))) throw new Error('Worker code must be immutable and separate from data')
    for (const path of [options.agentDir, options.sessionDir, options.outputDir]) mkdirSync(path, { recursive: true, mode: 0o700 })
    let restored: NativeConversationHistory | undefined
    if (options.resume) {
      if (!inside(options.sessionDir, options.resume.file) || options.resume.seal.sessionId !== options.sessionId || options.resume.seal.cwd !== options.workspaceRoot) throw new Error('Resume identity mismatch')
      const inspected = inspectNativeSession(options.resume.file, options.sessionId, options.workspaceRoot)
      if (JSON.stringify(inspected.seal) !== JSON.stringify(options.resume.seal)) throw new Error('Closed native file changed')
      if (options.resume.selectedHead) verifyNativeSelectedHead(options.resume.file, options.workspaceRoot, options.resume.selectedHead, { exactFile: true })
      if (options.resume.checkpoint) {
        const byId = new Map(inspected.entries.map(entry => [entry.id, entry]))
        let entry = byId.get(options.resume.selectedHead?.selectedLeafEntryId ?? inspected.seal.leafEntryId)
        while (entry && entry.id !== options.resume.checkpoint.leafEntryId) entry = byId.get(entry.parentId)
        if (!entry) throw new Error('Checkpoint is not on the restored branch')
        restored = checkpointConversation(options.resume.file, options.resume.checkpoint)
      }
    }
    const releaseResources = options.native.bindResourceSnapshot(lease.treeRoot, options.agentDir)
    const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--die-with-parent', '--new-session', '--tmpfs', '/tmp']
    for (const path of ['/usr', '/bin', '/lib', '/lib64', process.execPath, ...osIdentity, ...code]) args.push('--ro-bind', path, path)
    for (const path of data.filter(path => path !== options.agentDir)) args.push('--bind', path, path)
    args.push('--ro-bind', lease.treeRoot, options.agentDir)
    args.push('--proc', '/proc', '--dev', '/dev', '--chdir', options.workspaceRoot, '--', process.execPath, '--max-old-space-size=1024', entry)
    const child = spawn('/usr/bin/bwrap', ['--info-fd', '3', ...args], { cwd: options.workspaceRoot, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: options.agentDir }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true }) as ChildProcessWithoutNullStreams
    const worker = new IsolatedPiWorker({ ...options, authorize: () => { options.authorize(); lease.assertCurrent() } }, child)
    worker.releaseResources = releaseResources
    try {
      worker.unsubscribeResources = lease.subscribe(() => { worker.kill(); void worker.abortEffects() })
      const initialized = await worker.peer.call('runtime.init', workerJson({ cwd: options.workspaceRoot, agentDir: options.agentDir, sessionDir: options.sessionDir,
        outputDir: options.outputDir, sessionId: options.sessionId, models: brokerCatalog(options.models), documents: options.documents !== undefined,
        ...(options.resume ? { resumeFile: options.resume.file, seal: options.resume.seal,
          ...(options.resume.selectedHead ? { selectedHead: options.resume.selectedHead } : {}),
          ...(options.resume.lineageConfiguration ? { lineageConfiguration: options.resume.lineageConfiguration } : {}) } : {}) }), { timeoutMs: 15000 })
      if (typeof initialized !== 'object' || initialized === null || Array.isArray(initialized) || initialized.sessionId !== options.sessionId) throw new Error('Worker identity mismatch')
      if (typeof initialized.sessionFile !== 'string') throw new Error('Missing native session filename')
      worker.adoptFile(initialized.sessionFile)
      if (options.resume && initialized.sessionFile !== options.resume.file) throw new Error('Worker replaced restored native file')
      if (restored) worker.history = restored
      options.onSessionFile?.(initialized.sessionFile)
      return worker
    } catch (error) { await worker.dispose(); throw error }
  }
  get sessionId(): string { return this.options.sessionId }
  get busy(): boolean { return this.active > 0 }
  /** Trusted host access only; never part of the browser state or a lazy runtime launcher. */
  get verifiedFile(): string | undefined { this.options.authorize(); return this.sessionFile }
  async nativeInspect(): Promise<NativeRuntimeState> {
    this.options.authorize()
    if (this.terminated || !this.sessionFile) throw new WorkerRpcError('unavailable')
    const result = await this.peer.call('runtime.nativeInspect', null, { timeoutMs: 15000 }) as unknown as NativeRuntimeState
    this.options.authorize()
    const verified = verifyNativeRuntimeState(this.sessionFile, result, this.options.models)
    this.options.authorize(); return verified
  }
  async lineageInspect(): Promise<NativeSelectedHead> {
    this.options.authorize()
    if (this.terminated || !this.sessionFile) throw new WorkerRpcError('unavailable')
    const head = await this.peer.call('runtime.lineageInspect', null, { timeoutMs: 15000 }) as unknown as NativeSelectedHead
    this.options.authorize()
    const file = head.fileSeal?.sessionId === this.options.sessionId ? this.sessionFile
      : this.lineageTarget && head.fileSeal?.sessionId === this.lineageTarget.sessionId ? this.lineageTarget.file : undefined
    if (!file) throw new WorkerRpcError('denied')
    verifyNativeSelectedHead(file, this.options.workspaceRoot, head, { exactFile: true })
    this.options.authorize(); return structuredClone(head)
  }
  async lineageApply(candidate: NativeLineageApply, signal?: AbortSignal): Promise<NativeLineageWorkerResult> {
    this.options.authorize()
    if (this.stopped || this.terminated || this.active || this.nativeControlActive || !this.sessionFile) throw new WorkerRpcError('denied')
    const input = structuredClone(candidate)
    if (input.expectedHead.fileSeal.sessionId !== this.options.sessionId) throw new WorkerRpcError('denied')
    this.options.documents?.invalidate()
    this.effectsFenced = false; this.nativeControlActive = true; this.active++
    let timedOut = false
    const budget = setTimeout(() => { timedOut = true; this.effectsFenced = true; this.peer.close(new WorkerRpcError('limit')) }, 300000)
    let result: NativeLineageWorkerResult
    try {
      const raw = await this.peer.call('runtime.lineageApply', workerJson(input), { ...(signal ? { signal } : {}), awaitCancellation: true, timeoutMs: 300000 }) as unknown as NativeLineageWorkerResult
      this.effectsFenced = true; this.options.authorize()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['outcome', 'forkFilename'].includes(key))) throw new WorkerRpcError('invalid')
      const parsed = parseContract('native-lineage', raw.outcome)
      if (!('status' in parsed)) throw new WorkerRpcError('invalid')
      let file: string | undefined
      if (raw.forkFilename !== undefined) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\.jsonl$/u.test(raw.forkFilename) || input.action.kind !== 'fork') throw new WorkerRpcError('invalid')
        file = join(this.options.sessionDir, raw.forkFilename)
      }
      const outcome = verifyNativeLineageOutcome(this.sessionFile, this.options.workspaceRoot, input, parsed as NativeLineageOutcome, file, this.options.models)
      if (outcome.status !== 'not-applied' && outcome.proof.kind === 'native-fork-proof') {
        if (!file) throw new WorkerRpcError('invalid')
        this.lineageTarget = { file, sessionId: outcome.proof.targetHead.fileSeal.sessionId }
      }
      result = { outcome, ...(raw.forkFilename === undefined ? {} : { forkFilename: raw.forkFilename }) }
    } finally {
      try {
        this.effectsFenced = true
        await this.peer.quiesce()
        if (this.peer.closed) await this.exited
      } finally { clearTimeout(budget); this.active--; this.nativeControlActive = false }
    }
    if (timedOut) throw new WorkerRpcError('limit')
    this.options.authorize(); return result
  }
  async nativeApply(candidate: NativeControlApply, signal?: AbortSignal): Promise<NativeControlOutcome> {
    this.options.authorize()
    if (this.stopped || this.terminated || this.active || this.nativeControlActive || !this.sessionFile) throw new WorkerRpcError('denied')
    const input = structuredClone(candidate)
    // Compaction reads native context, not a newly consumed document request. Old
    // Read grants must not survive into SDK/extension callbacks or auxiliary work.
    if (input.action.kind === 'compact') this.options.documents?.invalidate()
    this.effectsFenced = false; this.nativeControlActive = true; this.active++
    let timedOut = false
    const budget = input.action.kind === 'compact' ? setTimeout(() => {
      timedOut = true; this.effectsFenced = true; this.peer.close(new WorkerRpcError('limit'))
    }, 300000) : undefined
    let verified: NativeControlOutcome
    try {
      const result = await this.peer.call('runtime.nativeApply', workerJson(input), { ...(signal ? { signal } : {}), awaitCancellation: true, timeoutMs: 300000 }) as unknown as NativeControlOutcome
      if (input.action.kind === 'compact') this.effectsFenced = true
      this.options.authorize()
      verified = verifyNativeControlProof(this.sessionFile, input, result, this.options.models)
      this.options.authorize()
    } finally {
      try {
        if (input.action.kind === 'compact') {
          // SDK hooks can start brokered effects without awaiting them. Even an
          // unknown/lost IPC outcome must drain actual supervisor joins before
          // original-key proof recovery could release the product barrier.
          // Fence new effects first; only a later explicit operation reopens it.
          this.effectsFenced = true
          await this.peer.quiesce()
          if (this.peer.closed) await this.exited
        }
      } finally {
        if (budget) clearTimeout(budget)
        this.active--; this.nativeControlActive = false
      }
    }
    if (timedOut) throw new WorkerRpcError('limit')
    this.options.authorize()
    return verified
  }
  publicHistory(): NativeConversationHistory { this.options.authorize(); return structuredClone(this.history) }
  observe(listener: (submissionId: string, progress: RuntimeProgress) => void): () => void {
    if (this.observers.size >= 32) throw new Error('Runtime observer limit reached')
    this.observers.add(listener); return () => { this.observers.delete(listener) }
  }
  async submit(input: RuntimeSubmission, consumed: () => void): Promise<RuntimeOutcome> {
    if (this.stopped || this.terminated || this.nativeControlActive) return { kind: 'failed', errorCode: 'runtime-rejected' }
    this.options.authorize(); this.effectsFenced = false; this.active++
    let admitted = false
    try {
      const result = await this.peer.call('runtime.submit', workerJson(input), { progress: value => {
        if (typeof value !== 'object' || value === null || Array.isArray(value) || value.submissionId !== input.receipt.submissionId) throw new WorkerRpcError('invalid')
        if (value.kind === 'runtime-progress' && admitted) {
          const progress = parseContract('runtime-progress', value.progress)
          for (const listener of this.observers) try { listener(input.receipt.submissionId, progress) } catch { /* Observers cannot affect native execution. */ }
          return
        }
        if (value.kind !== 'consumed' || admitted) throw new WorkerRpcError('invalid')
        admitted = true; consumed()
      } }) as unknown as RuntimeOutcome
      if (result.kind === 'completed') {
        if (!admitted || !this.sessionFile) throw new Error('No native checkpoint file')
        const projection = checkpointConversation(this.sessionFile, result.checkpoint), verified = projection.checkpoint!
        if (verified.submissionId !== input.receipt.submissionId || verified.requestHash !== input.receipt.requestHash || verified.runtimeSessionId !== this.sessionId) throw new Error('Checkpoint submission mismatch')
        try { this.options.authorize(); this.options.documents?.onCheckpoint?.(this.sessionFile, verified, input.prepared) }
        catch { /* The native answer remains valid; failed citation publication is explicitly unavailable in the product. */ }
        if (!this.history.checkpoint || verified.byteLength >= this.history.checkpoint.byteLength) this.history = projection
        return { kind: 'completed', checkpoint: verified }
      }
      if (!['cancelled', 'failed', 'unknown'].includes(result.kind)) throw new Error('Invalid worker outcome')
      return result
    } catch { return { kind: 'unknown', errorCode: 'execution-interrupted' } }
    finally { this.active-- }
  }
  async stop(): Promise<void> {
    this.stopped = true
    const native = this.abortEffects()
    try { if (!this.terminated) await this.peer.call('runtime.stop', null, { timeoutMs: 10000 }) }
    catch { this.kill(); await this.exited }
    await native; await this.peer.quiesce()
  }
  resume(): void {
    if (this.terminated || this.active) throw new Error('Worker cannot resume yet')
    this.options.native.resume(); this.options.documents?.boundary.resume(); this.stopped = false
    void this.peer.call('runtime.resume', null).catch(() => { this.peer.close() })
  }
  async snapshot() { return this.peer.call('runtime.snapshot', null) }
  async setActiveTools(names: string[]): Promise<void> { this.options.authorize(); if (this.busy) throw new Error('Runtime is busy'); await this.peer.call('runtime.tools', names) }
  async dispose(): Promise<void> { try { await this.stop() } finally { this.kill(); await this.exited; this.peer.close(); this.unsubscribeResources?.(); this.releaseResources?.(); this.releaseResources = undefined } }
  private adoptFile(file: string): void {
    if (!isAbsolute(file) || !inside(this.options.sessionDir, file) || !file.endsWith('.jsonl')) throw new Error('Worker session file is outside its private grant')
    this.sessionFile = file
  }
  private async abortEffects(): Promise<void> { await Promise.all([this.options.native.abortAll(), this.options.documents?.boundary.abortAll()]) }
  private kill(): void {
    this.stopped = true
    this.sandbox.stop()
  }
}
