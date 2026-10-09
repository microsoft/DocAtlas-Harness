import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { DocumentProcess } from './process.js'
import type { SidecarSpawner, SidecarSupervisorOptions } from './supervisor.js'
import { documentLaunch } from './linux-launch.js'
import { SandboxProcess } from './sandbox-process.js'

export interface UvDocumentOptions {
  projectRoot: string
  cacheRoot: string
  sourceRoots: Readonly<Record<string, string>>
  uvCommand?: string
  graceMs?: number
  protectedRoots?: readonly string[]
}

/** Trusted application configuration only; untrusted document processing is namespaced. */
export async function launchUvDocumentProcess(options: UvDocumentOptions, command: 'docatlas-sidecar' | 'docatlas-tree' = 'docatlas-sidecar'): Promise<DocumentProcess> {
  if (!isAbsolute(options.projectRoot) || !isAbsolute(options.cacheRoot)
    || Object.entries(options.sourceRoots).some(([id, path]) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || !isAbsolute(path))) throw new Error('Document process requires approved absolute paths')
  const graceMs = options.graceMs ?? 1000
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 30_000) throw new Error('Invalid process termination grace')
  const launch = await documentLaunch(options, command)
  const child = spawn(launch.command, ['--info-fd', '3', ...launch.args], { cwd: options.projectRoot, env: launch.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true })
  const sandbox = new SandboxProcess(child, () => {}, graceMs)
  const completed = sandbox.done.then(value => { if (sandbox.failure) throw sandbox.failure; return value })
  let closed = false
  void sandbox.done.then(() => { closed = true })
  void completed.catch(() => {})
  return {
    stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, done: completed,
    terminate() { sandbox.stop() },
    async waitForExit(signal) {
      if (closed) return true
      if (signal?.aborted) return false
      if (!signal) { await sandbox.done; return true }
      let abort!: () => void
      try {
        return await Promise.race([sandbox.done.then(() => true), new Promise<boolean>(resolve => {
          abort = () => resolve(false); signal.addEventListener('abort', abort, { once: true })
        })])
      } finally { signal.removeEventListener('abort', abort) }
    },
  }
}
export const createNodeUvSidecarSpawner = (options: UvDocumentOptions): SidecarSpawner => () => launchUvDocumentProcess(options)
export function documentSupervisorOptions(spawn: SidecarSpawner): SidecarSupervisorOptions {
  return { spawn, startupTimeoutMs: 15_000, requestTimeoutMs: 90_000, shutdownGraceMs: 1000, maxLineBytes: 1024 * 1024,
    maxStderrBytes: 65536, maxRetiredRequestIds: 256, maxQueuedRequests: 128, autoRestart: true,
    restartInitialDelayMs: 250, restartMaxDelayMs: 10_000, restartMaxAttempts: 5, stableResetMs: 30_000 }
}
