import { StringDecoder } from 'node:string_decoder'
import { treeIndexIssues, type TreeBuildRequest, type TreeGeneration, type TreePage, type TreeReadRequest } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { SidecarRpcError, SidecarSupervisorError } from '@docatlas/core'
import { launchUvDocumentProcess, type UvDocumentOptions } from './node-process.js'

export async function runTreeJob(options: UvDocumentOptions, request: TreeBuildRequest, signal?: AbortSignal): Promise<TreeGeneration>
export async function runTreeJob(options: UvDocumentOptions, request: TreeReadRequest, signal?: AbortSignal): Promise<TreePage>
export async function runTreeJob(options: UvDocumentOptions, input: TreeBuildRequest | TreeReadRequest, signal?: AbortSignal): Promise<TreeGeneration | TreePage> {
  const request = structuredClone(input)
  parseContract('tree-index', request)
  if (!['build-tree', 'read-tree'].includes(request.kind)) throw new SidecarSupervisorError('Invalid tree job request')
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180_000)])
  lifetime.throwIfAborted()
  const child = await launchUvDocumentProcess(options, 'docatlas-tree')
  const decoder = new StringDecoder('utf8')
  let output = '', size = 0, diagnostics = 0, failure: Error | undefined
  const stop = () => child.terminate()
  lifetime.addEventListener('abort', stop, { once: true })
  try {
    lifetime.throwIfAborted()
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 17 * 1024 * 1024) { failure = new SidecarSupervisorError('Tree result byte limit exceeded'); stop(); return }
      output += decoder.write(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => { diagnostics += chunk.byteLength; if (diagnostics > 65536) { failure = new SidecarSupervisorError('Tree diagnostic limit exceeded'); stop() } })
    child.stdin!.on('error', () => { failure ??= new SidecarSupervisorError('Tree input pipe failed'); stop() })
    child.stdin!.end(JSON.stringify(request))
    const outcome = await child.done
    lifetime.throwIfAborted()
    if (failure) throw failure
    output += decoder.end()
    let value: unknown
    try { value = JSON.parse(output) } catch { throw new SidecarSupervisorError('Tree process did not return JSON') }
    if (outcome.exitCode !== 0) throw new SidecarRpcError('Tree job failed', -32000, parseContract('protocol-error', value))
    const result = parseContract('tree-index', value)
    if (treeIndexIssues(result).length) throw new SidecarSupervisorError('Invalid tree job semantics')
    if (request.kind === 'build-tree') {
      if (result.kind !== 'tree-generation' || result.documentId !== request.documentId || result.revisionId !== request.revisionId || result.sourceHash !== request.sourceHash
        || result.config.mode !== request.config.mode || result.config.useEmbeddedToc !== request.config.useEmbeddedToc || result.config.workers !== 1) throw new SidecarSupervisorError('Tree result source/config mismatch')
      return result
    }
    if (result.kind !== 'tree-page' || result.generationId !== request.generationId || result.offset !== request.offset || result.nodes.length > request.limit) throw new SidecarSupervisorError('Tree page identity/budget mismatch')
    return result
  } finally {
    lifetime.removeEventListener('abort', stop)
    child.terminate()
    await child.waitForExit()
  }
}
