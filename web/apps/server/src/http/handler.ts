import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { TLSSocket } from 'node:tls'
import { parseContract } from '@docatlas/contracts/node'
import { canonical, ControlStore, ControlStoreError, type ProductActor } from '../storage/control-store.js'
import type { SubmissionCoordinator } from '../runs/submission-coordinator.js'
import { nativeControlIssues, nativeLineageIssues, type ProductBinding, type ProductNativeCommand, type ProductNativeInspection, type ProductNativeOperation,
  type ProductLineageCommand, type ProductLineageInspection, type ProductLineageOperation, type ProductNativeTreePage, type ProductNativeTreeRequest } from '@docatlas/contracts'
import type { ConversationHistory } from '../runs/history.js'
import type { DocumentHttp } from '../documents/http.js'
import { EnrichmentError, DocumentAccessError, LibraryDiscoveryError, LibraryServiceError, SourceScopeStoreError, PersonalizationStoreError, ResearchScopeSnapshotError, InvestigationM4StoreError } from '@docatlas/core'
import { ApiError, ProductAuth, type ApiErrorCode } from './auth.js'
import { ConversationObservations, parseObservationId } from '../runs/observations.js'
import { streamObservations } from './observations.js'

export interface ProductHttpOptions {
  auth: ProductAuth
  control: ControlStore
  coordinator(actor: ProductActor, conversationId: string): SubmissionCoordinator | Promise<SubmissionCoordinator>
  /** Cancels an already-owned native/lineage task without starting a cold worker. */
  stop?(actor: ProductActor, conversationId: string): Promise<void>
  observations?(actor: ProductActor, conversationId: string): ConversationObservations | Promise<ConversationObservations>
  createConversation?(actor: ProductActor, key: string): { binding: ProductBinding, replayed: boolean } | Promise<{ binding: ProductBinding, replayed: boolean }>
  documents?(actor: ProductActor, conversationId: string): DocumentHttp | Promise<DocumentHttp>
  native?: {
    inspect(actor: ProductActor, conversationId: string): Promise<ProductNativeInspection>
    command(actor: ProductActor, conversationId: string, request: ProductNativeCommand, authorize: () => void): Promise<ProductNativeOperation>
    operation(actor: ProductActor, conversationId: string, operationId: string): ProductNativeOperation | Promise<ProductNativeOperation>
  }
  lineage?: {
    inspect(actor: ProductActor, conversationId: string): Promise<ProductLineageInspection>
    command(actor: ProductActor, conversationId: string, request: ProductLineageCommand, authorize: () => void): Promise<ProductLineageOperation>
    operation(actor: ProductActor, conversationId: string, operationId: string): ProductLineageOperation | Promise<ProductLineageOperation>
    tree(actor: ProductActor, conversationId: string, request: ProductNativeTreeRequest): Promise<ProductNativeTreePage>
  }
  history?(actor: ProductActor, conversationId: string): ConversationHistory | Promise<ConversationHistory>
}
const statuses: Record<ApiErrorCode, number> = { unauthenticated: 401, forbidden: 403, 'invalid-request': 400, 'not-found': 404, conflict: 409, 'limit-exceeded': 413, unavailable: 503 }
const id = (value: string): string => {
  let result: string
  try { result = decodeURIComponent(value) } catch { throw new ApiError('invalid-request') }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(result)) throw new ApiError('invalid-request')
  return result
}

/** Does not listen or create workspaces. Composition supplies only already-authorized runtime lookups. */
export function createProductHttpHandler(options: ProductHttpOptions): (request: IncomingMessage, response: ServerResponse) => void {
  let active = 0, streams = 0
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (options.auth.localAccess) response.setHeader('X-DocAtlas-Access', 'local')
    response.on('error', () => {}) // Disconnects do not cancel durably accepted submissions.
    const send = (status: number, value: unknown) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }
    if (active >= 64) { response.setHeader('Connection', 'close'); send(413, { schemaVersion: 1, kind: 'api-error', code: 'limit-exceeded' }); return }
    active++
    let released = false
    const release = () => { if (!released) { released = true; active-- } }
    response.once('finish', release); response.once('close', release)
    const authenticate = () => {
      const mutation = request.method !== 'GET'
      const csrf = request.headers['x-docatlas-csrf']
      if (mutation && (typeof csrf !== 'string' || csrf.length !== 43)) throw new ApiError('forbidden')
      return options.auth.authenticate(request.headers.cookie, mutation ? csrf as string : undefined)
    }
    void (async () => {
      validateTransport(request, options.auth)
      const url = new URL(request.url ?? '/', options.auth.origin)
      if (options.auth.localAccess && url.pathname.startsWith('/api/auth/')) throw new ApiError('not-found')
      const snapshot = /^\/api\/conversations\/([^/]+)\/snapshot$/.exec(url.pathname)
      const listing = url.pathname === '/api/conversations'
      const documents = /^\/api\/conversations\/([^/]+)\/((?:uploads|documents|selections|enrichments|answers|question-context|research|research-workbench|preferences|learning|reviews|continuity)(?:\/[^/]+)*)$/.exec(url.pathname)
      if (url.origin !== options.auth.origin || url.hash || url.search && !(request.method === 'GET' && url.searchParams.size === 1 && (snapshot && url.searchParams.has('before') || listing && url.searchParams.has('after') || documents && /^(?:documents|documents\/[^/]+\/revisions)$/.test(documents[2]!) && url.searchParams.has('cursor') || documents?.[2] === 'reviews' && url.searchParams.has('scopeVersionId')))) throw new ApiError('invalid-request')
      if (request.method === 'POST' && url.pathname === '/api/auth/exchange') {
        const value = parse('product-http', await body(request))
        if (value.kind !== 'auth-exchange') throw new ApiError('invalid-request')
        const result = options.auth.exchange(value.code)
        response.setHeader('Set-Cookie', result.cookie)
        send(200, { schemaVersion: 1, kind: 'bootstrap', actor: result.actor, csrfToken: result.csrfToken }); return
      }
      const session = authenticate()
      const lineage = /^\/api\/conversations\/([^/]+)\/lineage(?:\/(tree)|\/operations\/([^/]+))?$/.exec(url.pathname)
      if (lineage && (request.method === 'GET' && !lineage[2] || request.method === 'POST' && !lineage[3])) {
        const conversationId = id(lineage[1]!), binding = options.control.binding(session.actor, conversationId)
        if (!options.lineage) throw new ApiError('unavailable')
        // Commands and original-operation reads may finish after a legitimate
        // generation handoff. RuntimeManager validates fresh versus original-key
        // recovery; this callback retains authentication, not the obsolete binding.
        const authorize = () => {
          const currentSession = authenticate()
          if (currentSession.actor.actorId !== session.actor.actorId || currentSession.actor.workspaceId !== session.actor.workspaceId) throw new ApiError('forbidden')
          return options.control.binding(session.actor, conversationId)
        }
        let result: ProductLineageInspection | ProductLineageOperation | ProductNativeTreePage
        let command: ProductLineageCommand | undefined
        if (request.method === 'POST') {
          const value = parse('native-lineage', await body(request))
          if (!('kind' in value) || nativeLineageIssues(value).length) throw new ApiError('invalid-request')
          authorize()
          if (lineage[2]) {
            if (value.kind !== 'native-tree-request') throw new ApiError('invalid-request')
            if (value.expectedGeneration !== binding.generation) throw new ApiError('conflict')
            result = await options.lineage.tree(session.actor, conversationId, value)
          } else {
            if (value.kind !== 'lineage-command' || value.conversationId !== conversationId) throw new ApiError('invalid-request')
            command = structuredClone(value)
            result = await options.lineage.command(session.actor, conversationId, command, authorize)
          }
        } else result = lineage[3] ? await options.lineage.operation(session.actor, conversationId, id(lineage[3])) : await options.lineage.inspect(session.actor, conversationId)
        const current = authorize()
        parseContract('native-lineage', result)
        if (nativeLineageIssues(result).length) throw new ApiError('unavailable')
        if (lineage[2] ? result.kind !== 'native-tree-page' : request.method === 'POST' || lineage[3]
          ? result.kind !== 'lineage-operation' : result.kind !== 'lineage-inspection') throw new ApiError('unavailable')
        if (result.kind === 'lineage-operation') {
          const source = result.sourceBinding
          if (source.conversationId !== conversationId || source.ownerActorId !== session.actor.actorId || source.workspaceId !== session.actor.workspaceId
            || source.generation > current.generation || result.requestHash !== createHash('sha256').update(canonical(result.request)).digest('hex')
            || lineage[3] && result.operationId !== id(lineage[3])
            || command && canonical(result.request) !== canonical(command)) throw new ApiError('unavailable')
        } else {
          if (command || lineage[3] || (lineage[2] ? result.kind !== 'native-tree-page' : result.kind !== 'lineage-inspection')) throw new ApiError('unavailable')
          if (canonical(current) !== canonical(binding) || canonical(result.binding) !== canonical(binding)) throw new ApiError('conflict')
        }
        send(request.method === 'POST' && result.kind === 'lineage-operation' && ['accepted', 'applying', 'handoff'].includes(result.state) ? 202 : 200, result); return
      }
      const native = /^\/api\/conversations\/([^/]+)\/native(?:\/operations\/([^/]+))?$/.exec(url.pathname)
      if (native && (request.method === 'GET' || request.method === 'POST' && !native[2])) {
        const conversationId = id(native[1]!), binding = options.control.binding(session.actor, conversationId)
        if (!options.native) throw new ApiError('unavailable')
        const authorize = () => { authenticate(); const current = options.control.binding(session.actor, conversationId)
          if (current.bindingId !== binding.bindingId || current.generation !== binding.generation || current.runtimeSessionId !== binding.runtimeSessionId) throw new ApiError('conflict') }
        let result: ProductNativeInspection | ProductNativeOperation
        if (request.method === 'POST') {
          const value = parse('native-control', await body(request))
          if (!('kind' in value) || value.kind !== 'native-command' || nativeControlIssues(value).length || value.conversationId !== conversationId) throw new ApiError('invalid-request')
          authorize()
          result = await options.native.command(session.actor, conversationId, value, authorize)
        } else result = native[2] ? await options.native.operation(session.actor, conversationId, id(native[2])) : await options.native.inspect(session.actor, conversationId)
        authorize(); parseContract('native-control', result)
        if (nativeControlIssues(result).length) throw new ApiError('unavailable')
        send(request.method === 'POST' && result.kind === 'native-operation' && ['accepted', 'applying'].includes(result.state) ? 202 : 200, result); return
      }
      const history = /^\/api\/conversations\/([^/]+)\/history$/.exec(url.pathname)
      if (history && request.method === 'POST') {
        const conversationId = id(history[1]!), binding = options.control.binding(session.actor, conversationId)
        const value = parse('product-history', await body(request))
        if (value.kind !== 'history-page-request') throw new ApiError('invalid-request')
        if (value.expectedGeneration !== binding.generation) throw new ApiError('conflict')
        authenticate()
        if (!options.history) throw new ApiError('unavailable')
        const pages = await options.history(session.actor, conversationId)
        authenticate()
        if (options.control.binding(session.actor, conversationId).bindingId !== binding.bindingId) throw new ApiError('conflict')
        const result = await pages.page(session.actor, value.cursor ?? undefined)
        authenticate()
        if (options.control.binding(session.actor, conversationId).bindingId !== binding.bindingId) throw new ApiError('conflict')
        send(200, result); return
      }
      if (documents) {
        const conversationId = id(documents[1]!), binding = options.control.binding(session.actor, conversationId)
        if (!options.documents) throw new ApiError('unavailable')
        const application = await options.documents(session.actor, conversationId), controller = new AbortController()
        const authorize = () => { authenticate(); if (options.control.binding(session.actor, conversationId).bindingId !== binding.bindingId) throw new ApiError('conflict') }
        authorize()
        const abort = () => controller.abort(), unwatch = options.auth.watch(request.headers.cookie, abort)
        response.once('close', abort)
        const timeout = setTimeout(() => { controller.abort(); request.destroy() }, 60000)
        try { await application.handle(request, response, documents[2]!.split('/').map(id), url, { actor: session.actor, conversationId, authorize, signal: controller.signal, json: () => body(request), send }) }
        finally { clearTimeout(timeout); response.off('close', abort); unwatch() }
        return
      }
      if (request.method === 'POST' && listing) {
        const value = parse('product-http', await body(request))
        if (value.kind !== 'conversation-create') throw new ApiError('invalid-request')
        authenticate()
        if (!options.createConversation) throw new ApiError('unavailable')
        const result = await options.createConversation(session.actor, value.idempotencyKey)
        authenticate()
        const binding = options.control.binding(session.actor, result.binding.conversationId)
        send(result.replayed ? 200 : 201, binding); return
      }
      if (request.method === 'GET' && listing) {
        const result = options.control.conversations(session.actor, url.searchParams.has('after') ? id(url.searchParams.get('after')!) : undefined)
        send(200, { schemaVersion: 1, kind: 'conversation-list', ...result }); return
      }
      const events = /^\/api\/conversations\/([^/]+)\/events$/.exec(url.pathname)
      if (request.method === 'GET' && (snapshot || events)) {
        const conversationId = id((snapshot ?? events)![1]!)
        options.control.binding(session.actor, conversationId)
        if (!options.observations) throw new ApiError('unavailable')
        const hub = await options.observations(session.actor, conversationId)
        authenticate(); options.control.binding(session.actor, conversationId); hub.authorize(session.actor, conversationId)
        if (snapshot) { send(200, hub.snapshot(session.actor, url.searchParams.has('before') ? id(url.searchParams.get('before')!) : undefined)); return }
        const supplied = request.headers['last-event-id']
        if (supplied !== undefined && typeof supplied !== 'string') throw new ApiError('invalid-request')
        const cursor = parseObservationId(supplied)
        if (streams >= 32) throw new ApiError('limit-exceeded')
        streams++
        let streamReleased = false
        const releaseStream = () => { if (!streamReleased) { streamReleased = true; streams-- } }
        try { streamObservations(request, response, options.auth, hub, cursor, releaseStream) } catch (error) { releaseStream(); throw error }
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        send(200, { schemaVersion: 1, kind: 'bootstrap', ...session }); return
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        empty(await body(request)); authenticate()
        response.setHeader('Set-Cookie', options.auth.logout(request.headers.cookie))
        response.writeHead(204); response.end(); return
      }
      if (request.method === 'POST' && url.pathname === '/api/submissions') {
        const value = parse('product-control', await body(request))
        if (value.kind !== 'submission') throw new ApiError('invalid-request')
        authenticate(); options.control.binding(session.actor, value.conversationId)
        const coordinator = await options.coordinator(session.actor, value.conversationId)
        authenticate(); options.control.binding(session.actor, value.conversationId)
        const result = coordinator.submit(value)
        send(result.replayed ? 200 : 202, result.receipt); return
      }
      const receipt = /^\/api\/submissions\/([^/]+)$/.exec(url.pathname)
      if (request.method === 'GET' && receipt) { send(200, options.control.get(session.actor, id(receipt[1]!))); return }
      const stopping = /^\/api\/conversations\/([^/]+)\/stop$/.exec(url.pathname)
      if (request.method === 'POST' && stopping) {
        empty(await body(request)); authenticate()
        const conversationId = id(stopping[1]!), binding = options.control.binding(session.actor, conversationId)
        // New product clients pin the exact binding before sending. A delayed
        // Stop from an old branch must not cancel a newly admitted generation.
        // Legacy callers without If-Match retain their conversation-current API.
        const expected = request.headers['if-match']
        if (expected !== undefined) {
          if (typeof expected !== 'string' || !/^"[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}"$/u.test(expected)) throw new ApiError('invalid-request')
          if (expected !== JSON.stringify(binding.bindingId)) throw new ApiError('conflict')
        }
        if (options.stop) await options.stop(session.actor, conversationId)
        else {
          const coordinator = await options.coordinator(session.actor, conversationId)
          authenticate(); options.control.binding(session.actor, conversationId)
          await coordinator.cancel()
        }
        authenticate()
        if (options.control.binding(session.actor, conversationId).generation !== binding.generation) throw new ApiError('conflict')
        send(200, { schemaVersion: 1, kind: 'runtime-stopped', conversationId, generation: binding.generation }); return
      }
      throw new ApiError('not-found')
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return }
      const code = publicCode(error)
      response.setHeader('Connection', 'close')
      send(statuses[code], { schemaVersion: 1, kind: 'api-error', code })
    })
  }
}
function validateTransport(request: IncomingMessage, auth: ProductAuth): void {
  const secure = auth.origin.startsWith('https:')
  if (secure ? !(request.socket instanceof TLSSocket && request.socket.encrypted) : !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) throw new ApiError('forbidden')
  if ((request.url?.length ?? 0) > 2048 || request.headers.host !== auth.host) throw new ApiError('invalid-request')
  const seen = new Set<string>()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase()
    if (!['host', 'cookie', 'origin', 'sec-fetch-site', 'x-docatlas-csrf', 'last-event-id', 'if-match'].includes(name)) continue
    if (seen.has(name)) throw new ApiError('invalid-request')
    seen.add(name)
  }
  if (request.headers.origin !== undefined && request.headers.origin !== auth.origin || request.method !== 'GET' && request.headers.origin !== auth.origin) throw new ApiError('forbidden')
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('forbidden')
  if (auth.localAccess && request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new ApiError('forbidden')
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] ?? '')) || request.headers['content-encoding']) throw new ApiError('invalid-request')
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 65536)) throw new ApiError('limit-exceeded')
  const chunks: Buffer[] = []; let size = 0
  const timer = setTimeout(() => request.destroy(new ApiError('limit-exceeded')), 10000)
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); size += bytes.length
      if (size > 65536) throw new ApiError('limit-exceeded')
      chunks.push(bytes)
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new ApiError('invalid-request') }
  } finally { clearTimeout(timer) }
}
function empty(value: unknown): void { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new ApiError('invalid-request') }
function parse<K extends 'product-control' | 'product-http' | 'native-control' | 'product-history' | 'native-lineage'>(contract: K, value: unknown) { try { return parseContract(contract, value) } catch { throw new ApiError('invalid-request') } }
function publicCode(error: unknown): ApiErrorCode {
  if (error instanceof ApiError) return error.code
  if (error instanceof EnrichmentError) return error.code === 'budget-exceeded' ? 'limit-exceeded' : error.code === 'source-changed' ? 'conflict' : 'unavailable'
  if (error instanceof DocumentAccessError || error instanceof LibraryDiscoveryError || error instanceof LibraryServiceError || error instanceof SourceScopeStoreError || error instanceof PersonalizationStoreError || error instanceof ResearchScopeSnapshotError || error instanceof InvestigationM4StoreError) {
    if (error.code === 'stale') return 'conflict'
    if (error.code === 'publish-blocked') return 'conflict'
    if (error.code === 'permission-denied') return 'forbidden'
    return ['not-found', 'invalid-request', 'limit-exceeded', 'conflict'].includes(error.code) ? error.code as ApiErrorCode : 'unavailable'
  }
  if (error instanceof ControlStoreError) {
    if (error.code === 'permission-denied') return 'forbidden'
    if (error.code === 'stale-writer' || error.code === 'recovery-required') return 'conflict'
    if (error.code === 'integrity-error') return 'unavailable'
    return error.code
  }
  return 'unavailable'
}
