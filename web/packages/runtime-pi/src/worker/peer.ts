import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import type { WorkerFrame, WorkerJson, WorkerErrorCode } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

export class WorkerRpcError extends Error {
  constructor(readonly code: WorkerErrorCode) { super(`Worker operation ${code}`) }
}
export interface WorkerCall { readonly id: string, signal: AbortSignal, yield(value: WorkerJson): Promise<void> }
/** Trusted handler acknowledgement after a cancelled process has actually exited. */
export class WorkerCancelledResult { constructor(readonly value: WorkerJson) {} }
export type WorkerHandler = (value: WorkerJson, call: WorkerCall) => Promise<WorkerJson | WorkerCancelledResult>
interface Pending { resolve(value: WorkerJson): void, reject(error: unknown): void, next: number, progress?: (value: WorkerJson) => void, cleanup(): void }

/** Only the installed handler map grants authority. JSON never assigns a peer's role. */
export class WorkerPeer {
  private readonly pending = new Map<string, Pending>()
  private readonly incoming = new Map<string, AbortController>()
  private readonly retired = new Map<string, 'cancelled' | 'completed'>()
  private readonly nonce = randomUUID()
  private counter = 0
  private remoteNonce: string | undefined
  private remoteCounter = 0
  private readonly chunks: Buffer[] = []
  private buffered = 0
  private incomingBytes = 0
  private readonly running = new Set<Promise<void>>()
  private outbound = 0
  private ended = false
  readonly done: Promise<void>
  private finish!: () => void
  constructor(private readonly input: Readable, private readonly output: Writable, private readonly handlers: ReadonlyMap<string, WorkerHandler>,
    private readonly failed: (error: Error) => void, private readonly maxBytes = 96 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 128 * 1024 * 1024) throw new Error('Invalid IPC byte limit')
    this.done = new Promise(resolve => { this.finish = resolve })
    input.on('data', this.data); input.once('end', this.lost); input.once('error', this.lost); output.once('error', this.lost)
  }
  get activeCount(): number { return this.pending.size + this.incoming.size }
  get closed(): boolean { return this.ended }
  async quiesce(): Promise<void> { await Promise.allSettled(this.running) }
  call(method: string, value: WorkerJson, options: { signal?: AbortSignal, progress?: (value: WorkerJson) => void, timeoutMs?: number, awaitCancellation?: boolean } = {}): Promise<WorkerJson> {
    if (this.ended) return Promise.reject(new WorkerRpcError('unavailable'))
    if (this.pending.size >= 64) return Promise.reject(new WorkerRpcError('limit'))
    if (options.signal?.aborted) return Promise.reject(new WorkerRpcError('cancelled'))
    const timeout = options.timeoutMs ?? 300000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 1800000) return Promise.reject(new WorkerRpcError('invalid'))
    const id = `${this.nonce}:${++this.counter}`
    return new Promise((resolve, reject) => {
      let cancelSent = false
      const cancel = () => {
        if (options.awaitCancellation && !cancelSent && this.pending.has(id)) {
          cancelSent = true; void this.send({ version: 1, kind: 'cancel', id }).catch(() => {}); return
        }
        if (options.awaitCancellation && cancelSent) return
        if (!this.pending.delete(id)) return
        item.cleanup(); this.retire(id, 'cancelled'); reject(new WorkerRpcError('cancelled'))
        void this.send({ version: 1, kind: 'cancel', id }).catch(() => {})
      }
      const timer = setTimeout(() => {
        if (options.awaitCancellation) { this.close(new WorkerRpcError('limit')); return }
        cancel()
      }, timeout)
      const item: Pending = { resolve, reject, next: 0, ...(options.progress ? { progress: options.progress } : {}),
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) } }
      this.pending.set(id, item); options.signal?.addEventListener('abort', cancel, { once: true })
      void this.send({ version: 1, kind: 'call', id, method, value }).catch(error => { this.close(error) })
    })
  }
  close(reason: unknown = new WorkerRpcError('unavailable')): void {
    if (this.ended) return
    this.ended = true
    this.input.removeListener('data', this.data)
    for (const item of this.pending.values()) { item.cleanup(); item.reject(reason) }
    this.pending.clear()
    for (const controller of this.incoming.values()) controller.abort(reason)
    this.chunks.length = 0; this.buffered = 0; this.finish()
    this.failed(reason instanceof Error ? reason : new WorkerRpcError('unavailable'))
  }
  private readonly lost = () => { this.close() }
  private readonly data = (chunk: Buffer | string) => {
    if (this.ended) return
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let offset = 0
      while (!this.ended && offset < bytes.length) {
        const end = bytes.indexOf(10, offset), part = bytes.subarray(offset, end < 0 ? bytes.length : end)
        this.buffered += part.length
        if (this.buffered > this.maxBytes) throw new WorkerRpcError('limit')
        this.chunks.push(part)
        if (end < 0) break
        const line = Buffer.concat(this.chunks, this.buffered)
        this.chunks.length = 0; this.buffered = 0
        const frame = parseContract('worker-frame', JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))
        this.receive(frame, line.length)
        offset = end + 1
      }
    } catch (error) { this.close(error) }
  }
  private receive(frame: WorkerFrame, size: number): void {
    if (frame.kind === 'call') {
      const [nonce, counter] = frame.id.split(':')
      if (!nonce || !counter || !/^[0-9]+$/.test(counter) || Number(counter) !== this.remoteCounter + 1 || (this.remoteNonce && nonce !== this.remoteNonce)) throw new WorkerRpcError('invalid')
      this.remoteNonce = nonce; this.remoteCounter++
      if (this.incoming.size >= 32 || this.incomingBytes + size > this.maxBytes * 2) throw new WorkerRpcError('limit')
      const handler = this.handlers.get(frame.method)
      if (!handler) { void this.send({ version: 1, kind: 'error', id: frame.id, code: 'denied' }).catch(() => {}); return }
      const controller = new AbortController(); this.incoming.set(frame.id, controller)
      this.incomingBytes += size
      let sequence = 0
      const task = (async () => {
        try {
          const result = await handler(frame.value, { id: frame.id, signal: controller.signal, yield: async value => {
            controller.signal.throwIfAborted()
            if (sequence > 1000000) throw new WorkerRpcError('limit')
            await this.send({ version: 1, kind: 'yield', id: frame.id, sequence: sequence++, value })
          } })
          if (controller.signal.aborted && !(result instanceof WorkerCancelledResult)) throw new WorkerRpcError('cancelled')
          await this.send({ version: 1, kind: 'return', id: frame.id, value: result instanceof WorkerCancelledResult ? result.value : result })
        } catch (error) {
          await this.send({ version: 1, kind: 'error', id: frame.id, code: controller.signal.aborted ? 'cancelled' : error instanceof WorkerRpcError ? error.code : 'failed' }).catch(() => {})
        } finally { this.incoming.delete(frame.id); this.incomingBytes -= size }
      })()
      this.running.add(task)
      void task.finally(() => this.running.delete(task))
    } else if (frame.kind === 'cancel') {
      const [nonce, counter] = frame.id.split(':')
      if (nonce !== this.remoteNonce || !counter || !/^[0-9]+$/.test(counter) || Number(counter) < 1 || Number(counter) > this.remoteCounter) throw new WorkerRpcError('invalid')
      this.incoming.get(frame.id)?.abort(new WorkerRpcError('cancelled'))
    } else {
      const pending = this.pending.get(frame.id)
      if (!pending) { if (this.retired.get(frame.id) === 'cancelled') return; throw new WorkerRpcError('invalid') }
      if (frame.kind === 'yield') {
        if (frame.sequence !== pending.next++) throw new WorkerRpcError('invalid')
        pending.progress?.(frame.value)
      } else {
        this.pending.delete(frame.id); pending.cleanup(); this.retire(frame.id, 'completed')
        if (frame.kind === 'error') pending.reject(new WorkerRpcError(frame.code)); else pending.resolve(frame.value)
      }
    }
  }
  private retire(id: string, status: 'cancelled' | 'completed'): void {
    this.retired.set(id, status)
    if (this.retired.size > 512) this.retired.delete(this.retired.keys().next().value!)
  }
  private async send(frame: WorkerFrame): Promise<void> {
    if (this.ended) throw new WorkerRpcError('unavailable')
    parseContract('worker-frame', frame)
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`)
    if (bytes.length > this.maxBytes || this.outbound + bytes.length > this.maxBytes * 2) { this.close(new WorkerRpcError('limit')); throw new WorkerRpcError('limit') }
    this.outbound += bytes.length
    try { await new Promise<void>((resolve, reject) => { this.output.write(bytes, error => error ? reject(error) : resolve()) }) }
    catch (error) { this.close(error); throw error }
    finally { this.outbound -= bytes.length }
  }
}
export function workerJson(value: unknown): WorkerJson { return JSON.parse(JSON.stringify(value)) as WorkerJson }
