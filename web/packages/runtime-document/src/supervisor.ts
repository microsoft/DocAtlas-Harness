import { Buffer } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'

import type { DocumentProcess as SubprocessHandle } from './process.js'
import { SidecarRpcError, SidecarSupervisorError } from '@docatlas/core'
export { SidecarRpcError, SidecarSupervisorError } from '@docatlas/core'
import {
  capabilitiesRequest,
  healthRequest,
  isCapabilitiesSuccess,
  isHealthSuccess,
  type SidecarCapabilitiesResult,
  type SidecarMethodMap,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

export type SidecarSupervisorState =
  | 'stopped'
  | 'starting'
  | 'negotiating'
  | 'ready'
  | 'backoff'
  | 'stopping'
  | 'failed'

export type SidecarSpawner = () => SubprocessHandle | Promise<SubprocessHandle>

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SidecarSupervisorOptions {
  spawn: SidecarSpawner
  startupTimeoutMs: number
  requestTimeoutMs: number
  shutdownGraceMs: number
  maxLineBytes: number
  maxStderrBytes: number
  maxRetiredRequestIds: number
  maxQueuedRequests: number
  autoRestart: boolean
  restartInitialDelayMs: number
  restartMaxDelayMs: number
  restartMaxAttempts: number
  stableResetMs: number
}

type RequestLane = 'ingest' | 'read'

interface QueuedRequest {
  readonly dispatch: () => void
  readonly reject: (reason: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal: AbortSignal | undefined
  readonly onAbort: (() => void) | undefined
}

interface PendingRequest {
  readonly method: keyof SidecarMethodMap
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal: AbortSignal | undefined
  readonly onAbort: (() => void) | undefined
}

export class SidecarSupervisor {
  private currentState: SidecarSupervisorState = 'stopped'
  private generation = 0
  private sequence = 0
  private handle: SubprocessHandle | undefined
  private capabilitiesValue: SidecarCapabilitiesResult | undefined
  private startPromise: Promise<SidecarCapabilitiesResult> | undefined
  private pending = new Map<string, PendingRequest>()
  private retired = new Set<string>()
  private stdoutBuffer = ''
  private stdoutDecoder = new StringDecoder('utf8')
  private stderrDecoder = new StringDecoder('utf8')
  private stderrValue = ''
  private priorQuiescence: Promise<void> = Promise.resolve()
  private readonly queues: Record<RequestLane, QueuedRequest[]> = { ingest: [], read: [] }
  private readonly active: Record<RequestLane, number> = { ingest: 0, read: 0 }
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private stableTimer: ReturnType<typeof setTimeout> | undefined
  private recovery: ReturnType<typeof Promise.withResolvers<SidecarCapabilitiesResult>> | undefined

  constructor(private readonly options: SidecarSupervisorOptions) {
    const numericOptions = {
      startupTimeoutMs: options.startupTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      shutdownGraceMs: options.shutdownGraceMs,
      maxLineBytes: options.maxLineBytes,
      maxStderrBytes: options.maxStderrBytes,
      maxRetiredRequestIds: options.maxRetiredRequestIds,
      maxQueuedRequests: options.maxQueuedRequests,
      restartInitialDelayMs: options.restartInitialDelayMs,
      restartMaxDelayMs: options.restartMaxDelayMs,
      restartMaxAttempts: options.restartMaxAttempts,
      stableResetMs: options.stableResetMs,
    }
    for (const [name, value] of Object.entries(numericOptions)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`)
      }
    }
    if (options.restartInitialDelayMs > options.restartMaxDelayMs) {
      throw new RangeError('restartInitialDelayMs must not exceed restartMaxDelayMs')
    }
    const timerOptions = {
      startupTimeoutMs: options.startupTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      shutdownGraceMs: options.shutdownGraceMs,
      restartInitialDelayMs: options.restartInitialDelayMs,
      restartMaxDelayMs: options.restartMaxDelayMs,
      stableResetMs: options.stableResetMs,
    }
    for (const [name, value] of Object.entries(timerOptions)) {
      if (value > MAX_TIMER_DELAY_MS) {
        throw new RangeError(`${name} must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
      }
    }
  }

  get state(): SidecarSupervisorState { return this.currentState }
  get processGeneration(): number { return this.generation }
  get restartAttemptCount(): number { return this.restartAttempts }
  get negotiatedCapabilities(): SidecarCapabilitiesResult | undefined {
    return this.capabilitiesValue
  }
  get stderrTail(): string { return this.stderrValue }
  get queuedRequestCount(): number { return this.queues.ingest.length + this.queues.read.length }

  start(): Promise<SidecarCapabilitiesResult> {
    if (this.currentState === 'ready' && this.capabilitiesValue !== undefined) {
      return Promise.resolve(this.capabilitiesValue)
    }
    if (this.startPromise !== undefined) return this.startPromise
    if (this.currentState === 'backoff' && this.recovery !== undefined) {
      return this.recovery.promise
    }
    if (this.currentState === 'stopping') {
      return Promise.reject(new SidecarSupervisorError('sidecar is stopping'))
    }
    this.startPromise = this.startGeneration().finally(() => { this.startPromise = undefined })
    return this.startPromise
  }

  private async startGeneration(): Promise<SidecarCapabilitiesResult> {
    const generation = ++this.generation
    this.currentState = 'starting'
    await this.priorQuiescence
    if (generation !== this.generation) throw new SidecarSupervisorError('sidecar startup was cancelled')
    this.active.ingest = 0
    this.active.read = 0
    this.currentState = 'starting'
    this.capabilitiesValue = undefined
    this.retired.clear()
    this.stdoutBuffer = ''
    this.stdoutDecoder = new StringDecoder('utf8')
    this.stderrDecoder = new StringDecoder('utf8')
    this.stderrValue = ''
    this.handle = undefined
    let handle: SubprocessHandle
    try {
      handle = await this.options.spawn()
    } catch (error) {
      const failure = new SidecarSupervisorError(`sidecar spawn failed: ${errorMessage(error)}`)
      this.failGeneration(generation, failure)
      throw failure
    }
    if (generation !== this.generation) {
      void handle.done.catch(() => {})
      handle.terminate()
      await handle.waitForExit()
      throw new SidecarSupervisorError('sidecar startup was cancelled')
    }
    this.handle = handle
    if (handle.stdin === undefined || handle.stdout === undefined || handle.stderr === undefined) {
      handle.terminate()
      const failure = new SidecarSupervisorError('sidecar requires piped stdin, stdout, and stderr')
      this.failGeneration(generation, failure)
      throw failure
    }
    handle.stdout.on('data', chunk => { this.onStdout(generation, chunk as Buffer | string) })
    handle.stderr.on('data', chunk => { this.onStderr(generation, chunk as Buffer | string) })
    void handle.done.then(
      outcome => { this.onProcessEnd(generation, `exit=${String(outcome.exitCode)} signal=${String(outcome.signal)}`) },
      error => { this.onProcessEnd(generation, `spawn failure: ${errorMessage(error)}`) },
    )

    this.currentState = 'negotiating'
    try {
      const health = await this.sendRequest(
        'health', healthRequest('placeholder').params, undefined, this.options.startupTimeoutMs, true,
      )
      if (!isHealthSuccess({ jsonrpc: '2.0', id: 'health', result: health })) {
        throw new SidecarSupervisorError('sidecar health negotiation failed')
      }
      const capabilities = await this.sendRequest(
        'capabilities', capabilitiesRequest('placeholder').params, undefined,
        this.options.startupTimeoutMs, true,
      )
      const envelope = { jsonrpc: '2.0', id: 'capabilities', result: capabilities }
      if (!isCapabilitiesSuccess(envelope)) {
        throw new SidecarSupervisorError('sidecar capabilities negotiation failed')
      }
      this.capabilitiesValue = capabilities
      this.currentState = 'ready'
      this.onGenerationReady(capabilities)
      return capabilities
    } catch (error) {
      this.failGeneration(generation, error)
      throw error
    }
  }

  async call<K extends keyof SidecarMethodMap>(
    method: K,
    params: SidecarMethodMap[K]['params'],
    signal?: AbortSignal,
  ): Promise<SidecarMethodMap[K]['result']> {
    if (this.currentState !== 'ready' || this.capabilitiesValue === undefined) {
      throw new SidecarSupervisorError('sidecar is not ready')
    }
    if (!this.capabilitiesValue.methods.includes(method)) {
      throw new SidecarSupervisorError(`sidecar method is not advertised: ${method}`)
    }
    const lane = requestLane(method)
    if (lane === undefined) {
      return await this.sendRequest(method, params, signal, this.options.requestTimeoutMs, false)
    }
    return await this.scheduleRequest(lane, method, params, signal)
  }

  private scheduleRequest<K extends keyof SidecarMethodMap>(
    lane: RequestLane,
    method: K,
    params: SidecarMethodMap[K]['params'],
    signal: AbortSignal | undefined,
  ): Promise<SidecarMethodMap[K]['result']> {
    signal?.throwIfAborted()
    if (this.queuedRequestCount >= this.options.maxQueuedRequests && !this.hasLaneCapacity(lane)) {
      return Promise.reject(new SidecarSupervisorError('sidecar request queue is full'))
    }
    const deferred = Promise.withResolvers<SidecarMethodMap[K]['result']>()
    const deadline = Date.now() + this.options.requestTimeoutMs
    let queued: QueuedRequest
    const removeFromQueue = (): boolean => {
      const index = this.queues[lane].indexOf(queued)
      if (index < 0) return false
      this.queues[lane].splice(index, 1)
      clearTimeout(queued.timer)
      if (queued.onAbort !== undefined) queued.signal?.removeEventListener('abort', queued.onAbort)
      return true
    }
    const rejectQueued = (reason: unknown): void => {
      if (removeFromQueue()) deferred.reject(reason)
    }
    const dispatch = (): void => {
      removeFromQueue()
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        deferred.reject(new SidecarSupervisorError(`sidecar ${method} request timed out in queue`))
        return
      }
      this.active[lane]++
      let request: Promise<SidecarMethodMap[K]['result']>
      try {
        request = this.sendRequest(method, params, signal, remaining, false)
      } catch (error) {
        this.active[lane]--
        deferred.reject(error)
        this.drainLane(lane)
        return
      }
      void request.then(
        deferred.resolve,
        deferred.reject,
      ).finally(() => {
        this.active[lane]--
        this.drainLane(lane)
      })
    }
    const onAbort = signal === undefined
      ? undefined
      : (): void => { rejectQueued(signal.reason) }
    queued = {
      dispatch,
      reject: deferred.reject,
      timer: setTimeout(() => {
        rejectQueued(new SidecarSupervisorError(`sidecar ${method} request timed out in queue`))
      }, this.options.requestTimeoutMs),
      signal,
      onAbort,
    }
    this.queues[lane].push(queued)
    signal?.addEventListener('abort', onAbort!, { once: true })
    this.drainLane(lane)
    return deferred.promise
  }

  private laneLimit(lane: RequestLane): number {
    const limits = this.capabilitiesValue?.limits
    if (limits === undefined) return 0
    return lane === 'ingest' ? limits.maxConcurrentIngest : limits.maxConcurrentRead
  }

  private hasLaneCapacity(lane: RequestLane): boolean {
    return this.active[lane] < this.laneLimit(lane)
  }

  private drainLane(lane: RequestLane): void {
    if (this.currentState !== 'ready') return
    while (this.hasLaneCapacity(lane)) {
      const next = this.queues[lane][0]
      if (next === undefined) return
      next.dispatch()
    }
  }

  private rejectQueued(reason: unknown): void {
    for (const lane of ['ingest', 'read'] as const) {
      const queued = this.queues[lane].splice(0)
      for (const request of queued) {
        clearTimeout(request.timer)
        if (request.onAbort !== undefined) {
          request.signal?.removeEventListener('abort', request.onAbort)
        }
        request.reject(reason)
      }
    }
  }

  private sendRequest<K extends keyof SidecarMethodMap>(
    method: K,
    params: SidecarMethodMap[K]['params'],
    signal: AbortSignal | undefined,
    timeoutMs: number,
    allowNegotiating: boolean,
  ): Promise<SidecarMethodMap[K]['result']> {
    if ((!allowNegotiating && this.currentState !== 'ready')
      || (allowNegotiating && this.currentState !== 'negotiating')) {
      return Promise.reject(new SidecarSupervisorError('sidecar generation is not writable'))
    }
    signal?.throwIfAborted()
    const handle = this.handle
    if (handle?.stdin === undefined) {
      return Promise.reject(new SidecarSupervisorError('sidecar stdin is unavailable'))
    }
    const id = `${this.generation}:${++this.sequence}`
    const envelope = { jsonrpc: '2.0' as const, id, method, params }
    parseContract('sidecar-envelope', envelope)
    const line = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(line) > this.options.maxLineBytes) {
      return Promise.reject(new SidecarSupervisorError('sidecar request exceeds maxLineBytes'))
    }

    const deferred = Promise.withResolvers<SidecarMethodMap[K]['result']>()
    const retire = (reason: unknown): void => {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.clearPending(id, pending)
      this.retireRequest(id)
      deferred.reject(reason)
    }
    const timer = setTimeout(() => {
      retire(new SidecarSupervisorError(`sidecar ${method} request timed out`))
    }, timeoutMs)
    const onAbort = signal === undefined
      ? undefined
      : (): void => { retire(signal.reason) }
    const pending: PendingRequest = {
      method,
      resolve: deferred.resolve as (value: unknown) => void,
      reject: deferred.reject,
      timer,
      signal,
      onAbort,
    }
    this.pending.set(id, pending)
    signal?.addEventListener('abort', onAbort!, { once: true })
    handle.stdin.write(line, (error) => {
      if (error !== null && error !== undefined) {
        retire(new SidecarSupervisorError(`sidecar stdin write failed: ${error.message}`))
      }
    })
    return deferred.promise
  }

  private onStdout(generation: number, chunk: Buffer | string): void {
    if (generation !== this.generation) return
    this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk)
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (Buffer.byteLength(line) > this.options.maxLineBytes) {
        this.failGeneration(generation, new SidecarSupervisorError('sidecar stdout line exceeds limit'))
        return
      }
      if (line.length > 0) this.onResponseLine(generation, line)
      if (this.currentState === 'failed') return
      newline = this.stdoutBuffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.stdoutBuffer) > this.options.maxLineBytes) {
      this.failGeneration(generation, new SidecarSupervisorError('sidecar stdout line exceeds limit'))
    }
  }

  private onResponseLine(generation: number, line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
      parseContract('sidecar-envelope', value)
    } catch (error) {
      this.failGeneration(generation, new SidecarSupervisorError(
        `invalid sidecar response: ${errorMessage(error)}`,
      ))
      return
    }
    const response = value as Record<string, unknown>
    const id = response.id
    if (typeof id !== 'string') {
      this.failGeneration(generation, new SidecarSupervisorError('sidecar response has no request id'))
      return
    }
    if (this.retired.delete(id)) return
    const pending = this.pending.get(id)
    if (pending === undefined) {
      this.failGeneration(generation, new SidecarSupervisorError(`unknown sidecar response id: ${id}`))
      return
    }
    this.clearPending(id, pending)
    if ('error' in response) {
      const error = response.error as { code: number, message: string, data: unknown }
      pending.reject(new SidecarRpcError(error.message, error.code, error.data))
      return
    }
    const result = response.result
    if (!resultMatchesMethod(pending.method, result)) {
      const error = new SidecarSupervisorError(`sidecar response type does not match ${pending.method}`)
      pending.reject(error)
      this.failGeneration(generation, error)
      return
    }
    pending.resolve(result)
  }

  private clearPending(id: string, pending: PendingRequest): void {
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
    }
  }

  private retireRequest(id: string): void {
    this.retired.add(id)
    if (this.retired.size > this.options.maxRetiredRequestIds) {
      this.failGeneration(this.generation, new SidecarSupervisorError('too many retired sidecar requests'))
    }
  }

  private onStderr(generation: number, chunk: Buffer | string): void {
    if (generation !== this.generation) return
    this.stderrValue += typeof chunk === 'string' ? chunk : this.stderrDecoder.write(chunk)
    while (Buffer.byteLength(this.stderrValue) > this.options.maxStderrBytes) {
      this.stderrValue = this.stderrValue.slice(Math.max(1, Math.floor(this.stderrValue.length / 8)))
    }
  }

  private onProcessEnd(generation: number, facts: string): void {
    if (generation !== this.generation || this.currentState === 'stopping' || this.currentState === 'stopped') return
    this.failGeneration(generation, new SidecarSupervisorError(`sidecar process ended: ${facts}`))
  }

  private failGeneration(generation: number, reason: unknown): void {
    if (generation !== this.generation
      || this.currentState === 'failed'
      || this.currentState === 'backoff'
      || this.currentState === 'stopping'
      || this.currentState === 'stopped') return
    this.currentState = 'failed'
    this.capabilitiesValue = undefined
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.stableTimer = undefined
    this.rejectQueued(reason)
    for (const [id, pending] of this.pending) {
      this.clearPending(id, pending)
      pending.reject(reason)
    }
    const handle = this.handle
    handle?.terminate()
    if (handle !== undefined) {
      this.priorQuiescence = handle.waitForExit().then(() => {})
    }
    if (this.options.autoRestart) this.scheduleRestart()
  }

  private onGenerationReady(capabilities: SidecarCapabilitiesResult): void {
    if (this.recovery !== undefined) {
      this.recovery.resolve(capabilities)
      this.recovery = undefined
    }
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => {
      if (this.currentState === 'ready') this.restartAttempts = 0
      this.stableTimer = undefined
    }, this.options.stableResetMs)
  }

  private scheduleRestart(): void {
    if (this.restartAttempts >= this.options.restartMaxAttempts) {
      this.recovery?.reject(new SidecarSupervisorError('sidecar restart attempts exhausted'))
      this.recovery = undefined
      this.currentState = 'failed'
      return
    }
    this.currentState = 'backoff'
    this.restartAttempts++
    if (this.recovery === undefined) {
      this.recovery = Promise.withResolvers<SidecarCapabilitiesResult>()
      void this.recovery.promise.catch(() => {})
    }
    const exponent = Math.min(this.restartAttempts - 1, 30)
    const delay = Math.min(
      this.options.restartInitialDelayMs * 2 ** exponent,
      this.options.restartMaxDelayMs,
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.startPromise = this.startGeneration().finally(() => { this.startPromise = undefined })
      void this.startPromise.catch(() => {})
    }, delay)
  }

  async dispose(): Promise<void> {
    if (this.currentState === 'stopped') return
    const startup = this.startPromise
    this.generation++
    this.currentState = 'stopping'
    const reason = new SidecarSupervisorError('sidecar supervisor disposed')
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.restartTimer = undefined
    this.stableTimer = undefined
    this.recovery?.reject(reason)
    this.recovery = undefined
    this.rejectQueued(reason)
    for (const [id, pending] of this.pending) {
      this.clearPending(id, pending)
      pending.reject(reason)
    }
    const handle = this.handle
    this.handle = undefined
    this.capabilitiesValue = undefined
    if (handle !== undefined) {
      handle.stdin?.end()
      const exited = await handle.waitForExit(AbortSignal.timeout(this.options.shutdownGraceMs))
      if (!exited) {
        handle.terminate()
        await handle.waitForExit()
      }
    }
    await startup?.catch(() => {})
    await this.priorQuiescence
    this.currentState = 'stopped'
  }
}

function resultMatchesMethod(method: keyof SidecarMethodMap, value: unknown): boolean {
  if (method === 'health') return isHealthSuccess({ jsonrpc: '2.0', id: 'result', result: value })
  if (method === 'capabilities') {
    return isCapabilitiesSuccess({ jsonrpc: '2.0', id: 'result', result: value })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return (value as Record<string, unknown>).resultType === method
}

function requestLane(method: keyof SidecarMethodMap): RequestLane | undefined {
  if (method === 'ingest') return 'ingest'
  if (method === 'search' || method === 'read' || method === 'resolve') return 'read'
  return undefined
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
