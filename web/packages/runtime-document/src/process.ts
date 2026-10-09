import type { Readable, Writable } from 'node:stream'
export interface DocumentProcess {
  readonly stdin?: Writable | undefined
  readonly stdout?: Readable | undefined
  readonly stderr?: Readable | undefined
  readonly done: Promise<{ exitCode: number | null, signal: string | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
