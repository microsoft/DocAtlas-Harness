import type {
  IngestRequest,
  IngestResult,
  ReadRequest,
  ReadResult,
  ResolveRequest,
  ResolveResult,
  SearchRequest,
  SearchResult,
} from './document-rpc.js'
import type { ProtocolError } from './m0-contracts.js'

/** Current Host ↔ sidecar envelope protocol version. */
export const SIDECAR_PROTOCOL_VERSION = '1.2.0' as const

/** First document-method contract family; availability is capability-gated. */
export const DOCUMENT_RPC_VERSION = '1.1.0' as const

/** Sidecar service identity returned during negotiation. */
export const SIDECAR_SERVICE = 'docatlas-sidecar' as const

/** JSON-RPC request identity chosen by the Host. */
export type SidecarRequestId = string

export type SidecarMethod =
  | 'health'
  | 'capabilities'
  | 'ingest'
  | 'search'
  | 'read'
  | 'resolve'
  | 'cancel'

export type ProgressiveReadMode =
  | 'locate'
  | 'blocks'
  | 'expand'
  | 'sequential'
  | 'visual'
  /** Internal Reader primitive. It is intentionally absent from the Agent tool schema. */
  | 'page'

export interface SidecarHealthResult {
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION
  service: typeof SIDECAR_SERVICE
  status: 'ok'
}

export interface SidecarCapabilitiesResult {
  schemaVersion: 1
  resultType: 'capabilities'
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION
  documentRpcVersion: typeof DOCUMENT_RPC_VERSION
  service: typeof SIDECAR_SERVICE
  status: 'ok'
  methods: SidecarMethod[]
  readModes: ProgressiveReadMode[]
  providerCapabilities: Array<'pdf' | 'markdown' | 'page-image' | 'figure' | 'table' | 'ocr'>
  limits: {
    maxConcurrentRead: number
    maxConcurrentIngest: number
    maxRequestBytes: number
    maxDocumentBytes: number
    maxTextResultChars: number
    maxImagePixels: number
  }
  runtime: {
    implementation: 'cpython'
    pythonVersion: string
    packageVersion: string
  }
}

/** Implemented negotiation methods; later document methods extend this map. */
export interface SidecarMethodMap {
  health: {
    params: Record<string, never>
    result: SidecarHealthResult
  }
  capabilities: {
    params: Record<string, never>
    result: SidecarCapabilitiesResult
  }
  ingest: { params: IngestRequest, result: IngestResult }
  search: { params: SearchRequest, result: SearchResult }
  read: { params: ReadRequest, result: ReadResult }
  resolve: { params: ResolveRequest, result: ResolveResult }
}

/** One versioned JSON-RPC request sent as a single JSONL record. */
export type SidecarRequest<K extends keyof SidecarMethodMap = keyof SidecarMethodMap> = {
  jsonrpc: '2.0'
  id: SidecarRequestId
  method: K
  params: SidecarMethodMap[K]['params']
}

/** One successful JSON-RPC response. */
export interface SidecarSuccess<T> {
  jsonrpc: '2.0'
  id: SidecarRequestId
  result: T
}

/** One JSON-RPC failure. */
export interface SidecarFailure {
  jsonrpc: '2.0'
  id: SidecarRequestId | null
  error: {
    code: number
    message: string
    data: ProtocolError
  }
}

export type SidecarEnvelope =
  | SidecarRequest
  | SidecarSuccess<SidecarHealthResult>
  | SidecarSuccess<SidecarCapabilitiesResult>
  | SidecarSuccess<IngestResult>
  | SidecarSuccess<SearchResult>
  | SidecarSuccess<ReadResult>
  | SidecarSuccess<ResolveResult>
  | SidecarFailure

function negotiationRequest<K extends 'health' | 'capabilities'>(
  method: K,
  id: SidecarRequestId,
): SidecarRequest<K> {
  if (id.length === 0) throw new Error('sidecar request id must not be empty')
  return { jsonrpc: '2.0', id, method, params: {} }
}

export function healthRequest(id: SidecarRequestId): SidecarRequest<'health'> {
  return negotiationRequest('health', id)
}

export function capabilitiesRequest(id: SidecarRequestId): SidecarRequest<'capabilities'> {
  return negotiationRequest('capabilities', id)
}

function responseResult(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const response = value as Record<string, unknown>
  if (response.jsonrpc !== '2.0' || typeof response.id !== 'string') return undefined
  const result = response.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined
  return result as Record<string, unknown>
}

/** Minimal bootstrap guard; production Host parsing additionally uses strict generated JSON Schema. */
export function isHealthSuccess(value: unknown): value is SidecarSuccess<SidecarHealthResult> {
  const result = responseResult(value)
  return result?.protocolVersion === SIDECAR_PROTOCOL_VERSION
    && result.service === SIDECAR_SERVICE
    && result.status === 'ok'
    && result.resultType === undefined
}

/** Minimal capabilities guard used before document-method negotiation is trusted. */
export function isCapabilitiesSuccess(
  value: unknown,
): value is SidecarSuccess<SidecarCapabilitiesResult> {
  const result = responseResult(value)
  return result?.schemaVersion === 1
    && result.resultType === 'capabilities'
    && result.protocolVersion === SIDECAR_PROTOCOL_VERSION
    && result.documentRpcVersion === DOCUMENT_RPC_VERSION
    && result.service === SIDECAR_SERVICE
    && result.status === 'ok'
    && Array.isArray(result.methods)
    && result.methods.includes('health')
    && result.methods.includes('capabilities')
}
