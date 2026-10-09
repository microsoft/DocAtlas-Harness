import type { DocumentToolOperations } from '../document-tools.js'
import { WorkerPeer, WorkerRpcError, workerJson, type WorkerHandler } from './peer.js'
import { record } from './model-bridge.js'
import { string } from './native-bridge.js'

export function documentBroker(operations: DocumentToolOperations, authorize: () => void): WorkerHandler {
  return async (candidate, call) => {
    authorize(); call.signal.throwIfAborted()
    const value = record(candidate)
    await operations.assertRuntime(string(value.sessionId))
    let result: unknown
    switch (value.operation) {
      case 'assertRuntime': result = null; break
      case 'sources': result = await operations.sources(); break
      case 'search': result = await operations.search(record(value.fields), call.signal); break
      case 'read': {
        const output = await operations.read(string(value.documentId), value.revisionId === null ? undefined : string(value.revisionId), record(value.fields), call.signal, string(value.toolCallId))
        result = { ...output, images: output.images.map(image => ({ mediaType: image.mediaType, bytes: Buffer.from(image.bytes).toString('base64') })) }; break
      }
      case 'tree': {
        if (value.mode !== 'raw' && value.mode !== 'merge' || typeof value.offset !== 'number' || typeof value.limit !== 'number') throw new WorkerRpcError('invalid')
        result = await operations.tree(string(value.documentId), value.revisionId === null ? undefined : string(value.revisionId), value.mode, value.offset, value.limit, call.signal); break
      }
      case 'enrichment': {
        if (typeof value.offset !== 'number' || typeof value.limit !== 'number' || typeof value.maxChars !== 'number') throw new WorkerRpcError('invalid')
        result = await operations.enrichment(string(value.documentId), value.revisionId === null ? undefined : string(value.revisionId), value.jobId === null ? undefined : string(value.jobId), value.offset, value.limit, value.maxChars, call.signal); break
      }
      case 'record': {
        if (!operations.record) throw new WorkerRpcError('unavailable')
        result = await operations.record(string(value.toolCallId), record(value.fields), call.signal); break
      }
      case 'recall': {
        if (!operations.recall) throw new WorkerRpcError('unavailable')
        result = await operations.recall(record(value.fields), call.signal); break
      }
      default: throw new WorkerRpcError('denied')
    }
    authorize(); call.signal.throwIfAborted(); return workerJson(result)
  }
}
export function remoteDocuments(peer: WorkerPeer, sessionId: string): DocumentToolOperations {
  const call = (operation: string, value: object, signal?: AbortSignal) => peer.call('document.call', workerJson({ operation, sessionId, ...value }), signal ? { signal } : {})
  return {
    assertRuntime: async id => { if (id !== sessionId) throw new WorkerRpcError('denied'); await call('assertRuntime', {}) },
    sources: async () => await call('sources', {}) as unknown as Awaited<ReturnType<DocumentToolOperations['sources']>>,
    search: async (fields, signal) => await call('search', { fields }, signal) as unknown as Awaited<ReturnType<DocumentToolOperations['search']>>,
    read: async (documentId, revisionId, fields, signal, toolCallId) => {
      if (!toolCallId) throw new WorkerRpcError('invalid')
      const value = await call('read', { documentId, revisionId: revisionId ?? null, fields, toolCallId }, signal) as unknown as { scopeVersionId: string, result: Awaited<ReturnType<DocumentToolOperations['read']>>['result'], images: Array<{ mediaType: 'image/png' | 'image/jpeg', bytes: string }> }
      return { ...value, images: value.images.map(image => ({ ...image, bytes: Buffer.from(image.bytes, 'base64') })) }
    },
    tree: async (documentId, revisionId, mode, offset, limit, signal) => await call('tree', { documentId, revisionId: revisionId ?? null, mode, offset, limit }, signal) as unknown as Awaited<ReturnType<DocumentToolOperations['tree']>>,
    enrichment: async (documentId, revisionId, jobId, offset, limit, maxChars, signal) => await call('enrichment', { documentId, revisionId: revisionId ?? null, jobId: jobId ?? null, offset, limit, maxChars }, signal) as unknown as Awaited<ReturnType<DocumentToolOperations['enrichment']>>,
    record: async (toolCallId, fields, signal) => await call('record', { toolCallId, fields }, signal) as unknown as Awaited<ReturnType<NonNullable<DocumentToolOperations['record']>>>,
    recall: async (fields, signal) => await call('recall', { fields }, signal) as unknown as Awaited<ReturnType<NonNullable<DocumentToolOperations['recall']>>>,
  }
}
