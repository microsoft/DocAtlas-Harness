import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { detectSupportedImageMimeType, type CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'

/** Implemented by the application execution boundary; never browser-supplied functions. */
export interface NativeExecutionBackend {
  /** Host-only grant of reviewed resource bytes; never exposed through worker IPC. */
  bindResourceSnapshot?(sourceRoot: string, targetRoot: string): () => void
  execFile?(command: string, args: string[], cwd: string, options?: { signal?: AbortSignal, timeout?: number }): Promise<{ stdout: string, stderr: string, code: number, killed: boolean }>
  readFile(path: string): Promise<Buffer>
  readPrefix?(path: string, bytes: number): Promise<Buffer>
  access(path: string, writable?: boolean): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ directory: boolean }>
  readdir(path: string): Promise<string[]>
  mkdir(path: string): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  glob(pattern: string, cwd: string, options: { ignore: string[], limit: number }): Promise<string[]>
  spawnGrep(command: string, args: string[]): ChildProcessByStdio<null, Readable, Readable>
  execute(command: string, cwd: string, options: { onData: (data: Buffer) => void, signal?: AbortSignal, timeout?: number, env?: NodeJS.ProcessEnv }, shell?: 'bash' | 'powershell'): Promise<{ exitCode: number | null }>
}

/** Original Pi definitions/metadata/renderers remain intact; only native I/O is routed. */
export function createNativeToolOptions(backend: NativeExecutionBackend, outputDirectory: string): NonNullable<CreateAgentSessionOptions['toolOptions']> {
  return {
    read: { operations: {
      readFile: path => backend.readFile(path), access: path => backend.access(path),
      detectImageMimeType: async path => detectSupportedImageMimeType(await (backend.readPrefix?.(path, 4100) ?? backend.readFile(path))),
    } },
    edit: { operations: { access: path => backend.access(path, true), readFile: path => backend.readFile(path), writeFile: (path, text) => backend.writeFile(path, text) } },
    write: { operations: { mkdir: path => backend.mkdir(path), writeFile: (path, text) => backend.writeFile(path, text) } },
    ls: { operations: { exists: path => backend.exists(path), readdir: path => backend.readdir(path), stat: async path => { const result = await backend.stat(path); return { isDirectory: () => result.directory } } } },
    find: { operations: { exists: path => backend.exists(path), glob: (pattern, cwd, options) => backend.glob(pattern, cwd, options) } },
    grep: { operations: { isDirectory: async path => (await backend.stat(path)).directory, readFile: async path => (await backend.readFile(path)).toString('utf8'), spawn: (command, args) => backend.spawnGrep(command, args) } },
    bash: { operations: { exec: (command, cwd, options) => backend.execute(command, cwd, options) }, tempFileDirectory: outputDirectory },
    powershell: { operations: { exec: (command, cwd, options) => backend.execute(command, cwd, options, 'powershell') }, tempFileDirectory: outputDirectory },
  }
}
