import type { RuntimeProgress } from '@docatlas/contracts'

/** Lossy observation buffer: never await a consumer from the native model/tool callback. */
export class ProgressRelay {
  private readonly queue: RuntimeProgress[] = []
  private sending = false
  private closed = false
  constructor(private readonly send: (event: RuntimeProgress) => Promise<void>) {}
  push(event: RuntimeProgress): void {
    if (this.closed) return
    const last = this.queue.at(-1)
    if (event.type === 'text' && last?.type === 'text' && last.messageId === event.messageId && last.delta.length + event.delta.length <= 8192) last.delta += event.delta
    else if (this.queue.length < 8) this.queue.push({ ...event })
    else { this.queue.length = 0; this.queue.push({ type: 'resync' }) }
    if (!this.sending) void this.flush()
  }
  close(): void {
    this.closed = true
    if (this.queue.length) { this.queue.length = 0; void this.send({ type: 'resync' }).catch(() => {}) }
  }
  private async flush(): Promise<void> {
    this.sending = true
    try { while (!this.closed && this.queue.length) await this.send(this.queue.shift()!) }
    catch { this.closed = true; this.queue.length = 0 }
    finally { this.sending = false }
  }
}
