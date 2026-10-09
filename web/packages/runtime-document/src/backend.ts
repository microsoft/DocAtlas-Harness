import { createHash } from 'node:crypto'
import type { DocumentOperationsPort } from '@docatlas/core'
import { DocAtlasAssetStore, AssetIntegrityError } from './assets.js'
import type { SidecarSupervisor } from './supervisor.js'
import { runTreeJob } from './tree-job.js'
import type { UvDocumentOptions } from './node-process.js'

export interface ManagedDocumentBackend extends DocumentOperationsPort { readonly activeCount: number, abortAll(): Promise<void>, resume(): void }
export function createDocumentBackend(supervisor: SidecarSupervisor, options: UvDocumentOptions): ManagedDocumentBackend {
  const assets = new DocAtlasAssetStore(options.cacheRoot)
  let controller = new AbortController(), stopping: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const track = async <T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const lifetime = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]); lifetime.throwIfAborted()
    const result = work(lifetime); pending.add(result)
    try { return await result } finally { pending.delete(result) }
  }
  return {
    get activeCount() { return pending.size },
    abortAll() {
      if (!stopping) {
        controller.abort()
        stopping = (async () => { await supervisor.dispose(); await Promise.allSettled(pending) })()
      }
      return stopping
    },
    resume() { if (pending.size || supervisor.state === 'stopping') throw new Error('Document execution is still stopping'); controller = new AbortController(); stopping = undefined },
    call: (method, request, signal) => track(signal, async lifetime => { await supervisor.start(); lifetime.throwIfAborted(); return supervisor.call(method, request, lifetime) }),
    buildTree: (request, signal) => track(signal, lifetime => runTreeJob(options, request, lifetime)),
    readTree: (request, signal) => track(signal, lifetime => runTreeJob(options, request, lifetime)),
    async visualAsset(id, invocation, signal) {
      return track(signal, async signal => {
      signal?.throwIfAborted(); invocation.assertCurrent()
      const opened = await assets.openAuthorized(id, undefined, descriptor => descriptor.kind !== 'original-bytes' && descriptor.byteLength <= 32 * 1024 * 1024
        && invocation.scope.sources.some(source => source.documentId === descriptor.documentId && source.revisionId === descriptor.revisionId
          && source.representationId === descriptor.representationId && source.representationContentHash === descriptor.representationContentHash))
      if (!opened) throw new AssetIntegrityError()
      try {
        const bytes = Buffer.alloc(opened.descriptor.byteLength)
        let offset = 0
        while (offset < bytes.byteLength) {
          signal?.throwIfAborted(); invocation.assertCurrent()
          const { bytesRead } = await opened.handle.read(bytes, offset, Math.min(65536, bytes.byteLength - offset), offset)
          if (!bytesRead) throw new AssetIntegrityError()
          offset += bytesRead
        }
        if ((await opened.handle.stat()).size !== bytes.byteLength || createHash('sha256').update(bytes).digest('hex') !== opened.descriptor.contentHash) throw new AssetIntegrityError()
        return { descriptor: opened.descriptor, bytes }
      } finally { await opened.handle.close() }
      })
    },
  }
}
