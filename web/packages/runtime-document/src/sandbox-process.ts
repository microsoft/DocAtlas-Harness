import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

export interface SandboxIdentity { pid: number, start: string }
export interface SandboxExit { exitCode: number | null, signal: string | null }
export function sandboxProcessStart(pid: number): string | undefined { return fields(pid)[19] }
function fields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
}

/** Owns a trusted bwrap monitor with --info-fd 3. Monitor exit alone is not quiescence. */
export class SandboxProcess {
  readonly done: Promise<SandboxExit>
  readonly identified: Promise<SandboxIdentity | undefined>
  failure: Error | undefined
  stopped = false
  private closed = false
  private metadataReady = false
  private identity: SandboxIdentity | undefined
  private bytes: Buffer[] = []
  private size = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly identify: (value: SandboxIdentity | undefined) => void
  private readonly originalKill: ChildProcess['kill']
  constructor(private readonly child: ChildProcess, private readonly onFailure: (error: Error) => void = () => {}, private readonly graceMs = 200) {
    const metadata = child.stdio[3]
    if (!(metadata instanceof Readable) || !Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 30000) throw new Error('Invalid sandbox process configuration')
    const identity = Promise.withResolvers<SandboxIdentity | undefined>()
    this.identified = identity.promise; this.identify = identity.resolve
    this.originalKill = child.kill.bind(child)
    this.done = new Promise(resolve => child.once('close', (exitCode, signal) => {
      this.closed = true; clearTimeout(this.timer); this.identify(this.identity)
      void this.joinNamespace().then(() => resolve({ exitCode, signal }))
    }))
    child.once('error', error => { this.fail(error); this.stop() })
    metadata.on('data', (chunk: Buffer) => {
      this.size += chunk.length
      if (this.size > 8192) { this.fail(new Error('Sandbox metadata exceeds limit')); metadata.destroy(); return }
      this.bytes.push(Buffer.from(chunk))
    })
    const ready = () => this.readIdentity()
    metadata.once('end', ready); metadata.once('close', ready)
    metadata.once('error', () => { this.fail(new Error('Sandbox metadata unavailable')); ready() })
  }
  stop(): boolean {
    this.stopped = true
    // Keep the monitor alive until it supplies the namespace PID. Early PDEATHSIG is not reliable.
    if (!this.metadataReady || this.closed) return !this.closed
    if (this.identity) {
      try {
        if (sandboxProcessStart(this.identity.pid) === this.identity.start) process.kill(this.identity.pid, 'SIGKILL')
      } catch (error) { if (!['ESRCH', 'ENOENT'].includes(String((error as NodeJS.ErrnoException).code))) this.fail(new Error('Could not stop sandbox namespace')) }
    }
    // Let bwrap reap its namespace init. Killing the monitor first can leave an orphan zombie.
    const result = this.identity ? true : this.killMonitor('SIGTERM')
    this.timer ??= setTimeout(() => this.finishStop(), this.graceMs)
    return result
  }
  private finishStop(): void {
    this.timer = undefined
    if (this.closed) return
    if (this.identity) {
      try {
        const stat = fields(this.identity.pid)
        if (stat[19] === this.identity.start) {
          // Under load, even a killed namespace init can await its parent's waitpid.
          // Keep that reaper alive; a timer is not proof that the namespace is gone.
          if (stat[0] !== 'Z' && stat[0] !== 'X') process.kill(this.identity.pid, 'SIGKILL')
          this.timer = setTimeout(() => this.finishStop(), this.graceMs)
          return
        }
      } catch (error) {
        if (!['ESRCH', 'ENOENT'].includes(String((error as NodeJS.ErrnoException).code))) {
          this.fail(new Error('Could not verify namespace termination'))
          this.timer = setTimeout(() => this.finishStop(), this.graceMs)
          return
        }
      }
    }
    this.killMonitor('SIGKILL')
  }
  private readIdentity(): void {
    if (this.metadataReady) return
    try {
      if (this.size > 8192) throw new Error('Oversized metadata')
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.bytes)))
      const pid = value && typeof value === 'object' ? Reflect.get(value, 'child-pid') : undefined
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Missing child identity')
      const stat = fields(pid)
      if (Number(stat[1]) !== this.child.pid || !stat[19] || !/^\d+$/.test(stat[19])) throw new Error('Foreign child identity')
      this.identity = { pid, start: stat[19] }
    } catch (error) {
      // A short-lived namespace may already be gone. Missing/invalid live metadata is a failure.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.fail(new Error('Invalid sandbox process identity'))
    }
    this.bytes = []; this.metadataReady = true; this.identify(this.identity)
    if (this.stopped || this.failure) this.stop()
  }
  private killMonitor(signal: NodeJS.Signals): boolean {
    if (this.closed || !this.child.pid) return false
    try { process.kill(-this.child.pid, signal); return true } catch { return this.originalKill(signal) }
  }
  private async joinNamespace(): Promise<void> {
    if (!this.identity) return
    while (true) {
      try {
        const stat = fields(this.identity.pid)
        if (stat[19] !== this.identity.start || stat[0] === 'Z' || stat[0] === 'X') return
        process.kill(this.identity.pid, 'SIGKILL')
      } catch (error) {
        if (['ESRCH', 'ENOENT'].includes(String((error as NodeJS.ErrnoException).code))) return
        this.fail(new Error('Sandbox namespace has not reached quiescence'))
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    try { this.onFailure(error) } catch { /* Observers cannot undo fencing. */ }
  }
}
