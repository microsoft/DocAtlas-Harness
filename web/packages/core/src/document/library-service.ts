import { createHash } from 'node:crypto'

import {
  libraryRpcIssues,
  type LibraryCapability,
  type LibraryDiscoverRequest,
  type LibraryDiscoverResult,
  type LibraryDocument,
  type LibraryDocumentSummary,
  type LibraryGetRequest,
  type LibraryGetResult,
  type LibraryImportRequest,
  type LibraryImportResult,
  type LibraryJobRequest,
  type LibraryJobResult,
  type LibraryListRequest,
  type LibraryListResult,
  type ProtocolError,
  type SourceRepresentation,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

import {
  type LibraryRuntimePort,
  type LibraryDiscoveryPort,
  LibraryDiscoveryError,
  type MaterializedLibraryCandidate,
  SidecarRpcError,
} from './ports.js'
import { SourceScopeStore, SourceScopeStoreError } from '../storage/source-scope-store.js'

const MAX_ACTIVE_IMPORTS = 32
const LIST_CURSOR_TTL_MS = 5 * 60 * 1000
const MAX_LIST_CURSORS = 1_000

function assertImportAuthority(authority: LibraryImportAuthority | undefined): void {
  if (!authority) return
  if (authority.commandHash !== undefined && (typeof authority.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(authority.commandHash))) {
    throw new LibraryServiceError('invalid-request', 'Library product command hash must be canonical SHA-256')
  }
  const result: unknown = authority.assertCurrent()
  if (result !== null && typeof result === 'object' && 'then' in result) {
    void Promise.resolve(result).catch(() => undefined)
    throw new LibraryServiceError('unavailable', 'Library import authority must be synchronous')
  }
}

interface ListCursor {
  sessionId: string
  workspaceId: string
  query?: string
  status?: LibraryListRequest['status']
  sort: LibraryListRequest['sort']
  documents: LibraryDocumentSummary[]
  offset: number
  expiresAt: number
}

/** Synchronous host authority, captured independently of the durable wire request/hash. */
export interface LibraryImportAuthority { readonly commandHash?: string, assertCurrent(): void }

export class LibraryServiceError extends Error {
  constructor(
    readonly code: ProtocolError['code'],
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'LibraryServiceError'
  }
}

export class LibraryService {
  private readonly active = new Map<string, AbortController>()
  private readonly listCursors = new Map<string, ListCursor>()
  private importTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly runtime: LibraryRuntimePort,
    private readonly store: SourceScopeStore,
    private readonly discovery: LibraryDiscoveryPort,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    for (const workspaceId of store.libraryWorkspaceIds()) {
      runtime.registerEligibleSources(workspaceId, store.eligibleLibrarySources(workspaceId))
    }
  }

  discover(request: LibraryDiscoverRequest, signal?: AbortSignal): Promise<LibraryDiscoverResult> {
    this.requireLive()
    this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false)
    return this.discovery.discover(request, this.now(), signal)
  }

  acceptImport(candidate: LibraryImportRequest, authority?: LibraryImportAuthority): LibraryImportResult {
    this.requireLive()
    const request = parseContract('library-rpc', structuredClone(candidate))
    if (!('requestType' in request) || request.requestType !== 'library-import') throw new LibraryServiceError('invalid-request', 'Expected a Library import request')
    const capturedAuthority = authority === undefined ? undefined : { assertCurrent: authority.assertCurrent.bind(authority), ...(authority.commandHash === undefined ? {} : { commandHash: authority.commandHash }) }
    assertImportAuthority(capturedAuthority)
    this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false)
    const issues = libraryRpcIssues(request)
    if (issues.length > 0) throw new LibraryServiceError('invalid-request', issues[0]!.message)
    const jobId = `job:${digest(`${request.workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`
    const accepted = this.store.acceptLibraryJob(request, jobId, timestamp(this.now()), capturedAuthority?.commandHash)
    if (accepted.status === 'replayed' && !this.active.has(jobId)) this.reconcileImport(request, capturedAuthority)
    if (accepted.status === 'replayed' && (!['queued', 'running'].includes(this.requireJob(request.workspaceId, jobId).status) || this.active.has(jobId))) return accepted
    if (this.active.size >= MAX_ACTIVE_IMPORTS) {
      const createdAt = this.requireJob(request.workspaceId, jobId).createdAt
      this.store.updateLibraryJob({
        schemaVersion: 1,
        resultType: 'library-job',
        workspaceId: request.workspaceId,
        jobId,
        status: 'failed',
        phase: 'complete',
        error: {
          schemaVersion: 1,
          code: 'limit-exceeded',
          message: 'too many Library imports are pending',
          retryable: true,
          nextActions: ['retry'],
        },
        createdAt,
        updatedAt: timestamp(this.now()),
      })
      return accepted
    }
    const controller = new AbortController()
    this.active.set(jobId, controller)
    this.importTail = this.importTail
      .catch(() => undefined)
      .then(() => this.runImport(request, jobId, controller.signal, capturedAuthority))
      .finally(() => { this.active.delete(jobId) })
    void this.importTail.catch(() => undefined)
    return accepted
  }

  /** Strictly read-only original command lookup; no repair, acceptance or resumed work. */
  lookupImport(candidate: LibraryImportRequest, authority?: LibraryImportAuthority): LibraryJobResult | undefined {
    this.requireLive()
    const request = parseContract('library-rpc', structuredClone(candidate))
    if (!('requestType' in request) || request.requestType !== 'library-import') throw new LibraryServiceError('invalid-request', 'Expected a Library import request')
    if (libraryRpcIssues(request).length) throw new LibraryServiceError('invalid-request', 'Invalid Library import lookup')
    assertImportAuthority(authority); this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false)
    const result = this.store.getLibraryImport(request, authority?.commandHash)
    assertImportAuthority(authority); this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false)
    return result
  }

  /** Explicit retry may repair only an existing canonical domain receipt, never rerun ingestion. */
  reconcileImport(candidate: LibraryImportRequest, authority?: LibraryImportAuthority): LibraryJobResult | undefined {
    this.requireLive()
    const request = parseContract('library-rpc', structuredClone(candidate))
    if (!('requestType' in request) || request.requestType !== 'library-import' || libraryRpcIssues(request).length) throw new LibraryServiceError('invalid-request', 'Invalid Library reconciliation request')
    const captured = authority === undefined ? undefined : { assertCurrent: authority.assertCurrent.bind(authority), ...(authority.commandHash === undefined ? {} : { commandHash: authority.commandHash }) }
    const check = () => { this.requireLive(); assertImportAuthority(captured); this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false) }
    check()
    const existing = this.store.getLibraryImport(request, captured?.commandHash)
    if (!existing || this.active.has(existing.jobId)) return existing
    const result = this.store.reconcileLibraryImport({ request, jobId: existing.jobId, completedAt: timestamp(this.now()), assertCurrent: check,
      ...(captured?.commandHash === undefined ? {} : { productCommandHash: captured.commandHash }) })
    check()
    if (result?.status === 'succeeded') this.refreshEligibility(request.workspaceId)
    return result
  }

  getJob(request: LibraryJobRequest): LibraryJobResult {
    this.requireLive()
    this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false)
    const job = this.store.getLibraryJob(request.workspaceId, request.jobId)
    if (job === undefined) throw new LibraryServiceError('not-found', 'Library import job is not available')
    return job
  }

  list(request: LibraryListRequest): LibraryListResult {
    this.requireLive()
    this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false)
    this.collectCursors()
    if (request.cursor !== undefined) return this.continueList(request)
    const query = request.query?.toLowerCase()
    const statuses = request.status === undefined ? undefined : new Set(request.status)
    const documents = this.store.listLibraryDocuments(request.workspaceId)
      .filter(document => query === undefined || document.displayName.toLowerCase().includes(query))
      .filter(document => statuses === undefined || statuses.has(document.status))
      .map(summaryOf)
      .sort(request.sort === 'name-asc'
        ? (left, right) => left.displayName.localeCompare(right.displayName)
          || left.documentId.localeCompare(right.documentId)
        : (left, right) => right.updatedAt.localeCompare(left.updatedAt)
          || left.documentId.localeCompare(right.documentId))
    return this.listPage(request, documents, 0)
  }

  get(request: LibraryGetRequest): LibraryGetResult {
    this.requireLive()
    this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false)
    const document = this.store.getLibraryDocument(request.workspaceId, request.documentId)
    if (document === undefined) throw new LibraryServiceError('not-found', 'Library document is not available')
    return {
      schemaVersion: 1,
      resultType: 'library-document',
      workspaceId: request.workspaceId,
      document,
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.active.values()) controller.abort(new Error('Library service disposed'))
    await this.importTail.catch(() => undefined)
    this.active.clear()
    this.listCursors.clear()
  }

  whenIdle(): Promise<void> {
    return this.importTail
  }

  private async runImport(
    request: LibraryImportRequest,
    jobId: string,
    signal: AbortSignal,
    authority?: LibraryImportAuthority,
  ): Promise<void> {
    const createdAt = this.requireJob(request.workspaceId, jobId).createdAt
    const check = () => { signal.throwIfAborted(); this.requireLive(); this.runtime.assertBrowserSession(request.sessionId, request.workspaceId, false); assertImportAuthority(authority) }
    try {
      check()
      this.writeJob(request.workspaceId, jobId, createdAt, 'running', 'hashing')
      const materialized = await this.discovery.materialize(
        request.candidateId,
        request.sessionId,
        request.workspaceId,
        this.now(),
      )
      check()
      const sourceKey = digest(`${materialized.rootId}\0${materialized.relativePath}`)
      const identity = this.store.resolveLibraryImport(
        request.workspaceId,
        sourceKey,
        materialized.contentHash,
        request.revisionTarget,
      )
      let document: LibraryDocument
      if (identity.exact !== undefined) {
        document = await this.ensureCurrentIndex(
          request,
          materialized,
          identity.exact,
          jobId,
          signal,
          check,
        )
      } else {
        this.writeJob(request.workspaceId, jobId, createdAt, 'running', 'ingesting')
        document = await this.ingest(request, materialized, identity, jobId, signal, check)
      }
      check()
      const currentIdentity = this.store.resolveLibraryImport(request.workspaceId, sourceKey, materialized.contentHash, request.revisionTarget)
      if (JSON.stringify(currentIdentity) !== JSON.stringify(identity)) throw new LibraryServiceError('conflict', 'Library identity changed while ingestion was running')
      this.writeJob(request.workspaceId, jobId, createdAt, 'running', 'committing')
      check()
      this.store.recordLibraryDocument({
        workspaceId: request.workspaceId,
        idempotencyKey: `${jobId}:record`,
        sourceKey,
        rootId: materialized.rootId,
        relativePath: materialized.relativePath,
        document,
        ...(request.revisionTarget === undefined ? {} : { revisionTarget: request.revisionTarget }),
      }, {
        request, jobId, completedAt: timestamp(this.now()), assertCurrent: check,
        ...(authority?.commandHash === undefined ? {} : { productCommandHash: authority.commandHash }),
      })
      this.refreshEligibility(request.workspaceId)
    } catch (error) {
      if (!signal.aborted) this.onError(error)
      if (this.store.getLibraryJob(request.workspaceId, jobId)?.status === 'succeeded') return
      this.store.updateLibraryJob({
        schemaVersion: 1,
        resultType: 'library-job',
        workspaceId: request.workspaceId,
        jobId,
        status: signal.aborted ? 'cancelled' : 'failed',
        phase: 'complete',
        ...(signal.aborted ? {} : { error: importError(error) }),
        createdAt,
        updatedAt: timestamp(this.now()),
      })
    }
  }

  private refreshEligibility(workspaceId: string): void {
    try { this.runtime.registerEligibleSources(workspaceId, this.store.eligibleLibrarySources(workspaceId)) }
    catch {
      // This is a recoverable runtime condition, not a failed domain import or native activation.
      this.onError(new LibraryServiceError('unavailable', 'Library commit succeeded, but runtime eligibility refresh failed; retry the original import or restart before source preparation', true))
    }
  }

  private async ingest(
    request: LibraryImportRequest,
    source: MaterializedLibraryCandidate,
    identity: ReturnType<SourceScopeStore['resolveLibraryImport']>,
    jobId: string,
    signal: AbortSignal,
    check: () => void,
  ): Promise<LibraryDocument> {
    const now = this.requireJob(request.workspaceId, jobId).createdAt
    const revisionId = `rev:${digest(`${identity.documentId}\0${source.contentHash}`).slice(0, 32)}`
    const revision = {
      schemaVersion: 1 as const,
      documentId: identity.documentId,
      revisionId,
      ...(identity.previous === undefined
        ? {} : { previousRevisionId: identity.previous.currentRevision.revisionId }),
      contentHash: source.contentHash,
      byteLength: source.byteLength,
      mediaType: source.mediaType,
      displayName: source.displayName,
      origin: { kind: 'local-file' as const },
      ingestedAt: now,
      status: 'active' as const,
    }
    check()
    const ingested = await this.runtime.call('ingest', {
      schemaVersion: 1,
      requestType: 'ingest',
      idempotencyKey: jobId,
      revision,
      sourceBinding: {
        schemaVersion: 1,
        bindingId: `binding:${digest(`${jobId}\0${source.candidateId}`).slice(0, 32)}`,
        rootId: source.rootId,
        relativePath: source.relativePath,
        expectedContentHash: source.contentHash,
        byteLength: source.byteLength,
        mediaType: source.mediaType,
      },
      requestedRepresentationKinds: source.mediaType === 'application/pdf'
        ? ['embedded-text']
        : ['derived-markdown'],
      options: { forceRebuild: false, allowOcr: false },
    }, signal)
    check()
    const currentRevision = { ...revision, pageCount: ingested.index.totalPages }
    const active = chooseActiveRepresentation(ingested.representations)
    const createdAt = identity.previous?.createdAt ?? now
    return {
      schemaVersion: 1,
      workspaceId: request.workspaceId,
      documentId: identity.documentId,
      displayName: source.displayName,
      mediaType: source.mediaType,
      sourceRole: request.sourceRole,
      status: ingested.index.status === 'ready' ? 'ready' : 'partial',
      revisionCount: (identity.previous?.revisionCount ?? 0) + 1,
      currentRevision,
      representations: ingested.representations,
      activeRepresentationId: active.representationId,
      capabilities: capabilitiesOf(ingested.representations),
      createdAt,
      updatedAt: timestamp(this.now()),
    }
  }

  private async ensureCurrentIndex(
    request: LibraryImportRequest,
    source: MaterializedLibraryCandidate,
    document: LibraryDocument,
    jobId: string,
    signal: AbortSignal,
    check: () => void,
  ): Promise<LibraryDocument> {
    check()
    if (document.currentRevision.contentHash !== source.contentHash) throw new LibraryServiceError('conflict', 'Current index cannot be refreshed from historical revision bytes')
    this.writeJob(request.workspaceId, jobId, this.requireJob(request.workspaceId, jobId).createdAt,
      'running', 'ingesting')
    const indexed = await this.runtime.call('ingest', {
      schemaVersion: 1,
      requestType: 'ingest',
      idempotencyKey: `${jobId}:index`,
      revision: { ...document.currentRevision, status: 'active' },
      sourceBinding: {
        schemaVersion: 1,
        bindingId: `binding:${digest(`${jobId}\0${source.candidateId}\0index`).slice(0, 32)}`,
        rootId: source.rootId,
        relativePath: source.relativePath,
        expectedContentHash: source.contentHash,
        byteLength: source.byteLength,
        mediaType: source.mediaType,
      },
      requestedRepresentationKinds: source.mediaType === 'application/pdf'
        ? ['embedded-text']
        : ['derived-markdown'],
      options: { forceRebuild: false, allowOcr: false },
    }, signal)
    check()
    const active = indexed.representations.find(representation =>
      representation.representationId === document.activeRepresentationId)
    const expected = document.representations.find(representation =>
      representation.representationId === document.activeRepresentationId)
    if (active === undefined || expected === undefined || active.contentHash !== expected.contentHash) {
      throw new LibraryServiceError(
        'integrity-error',
        'refreshed document index changed the active representation identity',
      )
    }
    return document
  }

  private requireJob(workspaceId: string, jobId: string): LibraryJobResult {
    const job = this.store.getLibraryJob(workspaceId, jobId)
    if (job === undefined) throw new LibraryServiceError('not-found', 'Library import job disappeared')
    return job
  }

  private writeJob(
    workspaceId: string,
    jobId: string,
    createdAt: string,
    status: 'running',
    phase: 'hashing' | 'ingesting' | 'committing',
  ): void {
    this.store.updateLibraryJob({
      schemaVersion: 1,
      resultType: 'library-job',
      workspaceId,
      jobId,
      status,
      phase,
      createdAt,
      updatedAt: timestamp(this.now()),
    })
  }

  private continueList(request: LibraryListRequest): LibraryListResult {
    const cursor = this.listCursors.get(request.cursor!)
    if (cursor === undefined
      || cursor.expiresAt <= this.now()
      || cursor.sessionId !== request.sessionId
      || cursor.workspaceId !== request.workspaceId
      || cursor.query !== request.query
      || cursor.sort !== request.sort
      || JSON.stringify(cursor.status) !== JSON.stringify(request.status)) {
      throw new LibraryServiceError('stale', 'Library list cursor is invalid or expired')
    }
    return this.listPage(request, cursor.documents, cursor.offset)
  }

  private listPage(
    request: LibraryListRequest,
    documents: LibraryDocumentSummary[],
    offset: number,
  ): LibraryListResult {
    const page = documents.slice(offset, offset + request.limit)
    const nextOffset = offset + page.length
    let nextCursor: string | undefined
    if (nextOffset < documents.length) {
      nextCursor = `library-list:${digest(`${request.sessionId}\0${request.workspaceId}\0${nextOffset}\0${this.now()}`).slice(0, 32)}`
      this.listCursors.set(nextCursor, {
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.status === undefined ? {} : { status: [...request.status] }),
        sort: request.sort,
        documents,
        offset: nextOffset,
        expiresAt: this.now() + LIST_CURSOR_TTL_MS,
      })
      while (this.listCursors.size > MAX_LIST_CURSORS) {
        const oldest = this.listCursors.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.listCursors.delete(oldest)
      }
    }
    return {
      schemaVersion: 1,
      resultType: 'library-documents',
      workspaceId: request.workspaceId,
      documents: page,
      pageInfo: {
        schemaVersion: 1,
        limit: request.limit,
        returned: page.length,
        total: documents.length,
        usedChars: 0,
        truncated: nextCursor !== undefined,
        completeness: nextCursor === undefined ? 'complete' : 'partial',
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    }
  }

  private collectCursors(): void {
    const now = this.now()
    for (const [id, cursor] of this.listCursors) {
      if (cursor.expiresAt <= now) this.listCursors.delete(id)
    }
  }

  private requireLive(): void {
    if (this.disposed) throw new LibraryServiceError('unavailable', 'Library service is disposed', true)
  }
}

function chooseActiveRepresentation(representations: readonly SourceRepresentation[]): SourceRepresentation {
  const preferred = representations.find(representation =>
    ['embedded-text', 'ocr-text', 'derived-markdown'].includes(representation.kind)
    && representation.status === 'current')
  const original = representations.find(representation => representation.kind === 'original-bytes')
  const active = preferred ?? original
  if (active === undefined) throw new LibraryServiceError('integrity-error', 'ingest produced no usable representation')
  return active
}

function capabilitiesOf(representations: readonly SourceRepresentation[]): LibraryCapability[] {
  const values = new Set<LibraryCapability>()
  for (const representation of representations) {
    switch (representation.kind) {
      case 'original-bytes': values.add('original'); break
      case 'embedded-text':
      case 'derived-markdown': values.add('text'); break
      case 'ocr-text': values.add('text'); values.add('ocr'); break
      case 'table-extraction': values.add('table'); break
      case 'figure-crop': values.add('figure'); break
      case 'page-image': values.add('page-image'); break
      case 'model-description': break
    }
  }
  return [...values]
}

function summaryOf(document: LibraryDocument): LibraryDocumentSummary {
  return {
    documentId: document.documentId,
    displayName: document.displayName,
    mediaType: document.mediaType,
    sourceRole: document.sourceRole,
    status: document.status,
    revisionCount: document.revisionCount,
    currentRevisionId: document.currentRevision.revisionId,
    capabilities: [...document.capabilities],
    updatedAt: document.updatedAt,
  }
}

function importError(error: unknown): ProtocolError {
  if (error instanceof LibraryDiscoveryError) {
    return {
      schemaVersion: 1,
      code: error.code,
      message: error.message,
      retryable: error.code === 'stale',
      nextActions: error.code === 'stale' ? ['retry'] : ['reduce-scope'],
    }
  }
  if (error instanceof SidecarRpcError) {
    try {
      return parseContract('protocol-error', error.data)
    } catch {
      // Fall through to the bounded, non-sensitive internal failure below.
    }
  }
  if (error instanceof SourceScopeStoreError) {
    return {
      schemaVersion: 1,
      code: error.code === 'integrity-error' ? 'internal' : error.code,
      message: error.code === 'integrity-error' ? 'Library store is unavailable' : error.message,
      retryable: error.code === 'integrity-error',
      ...(error.code === 'integrity-error' ? { nextActions: ['retry'] } : {}),
    }
  }
  return {
    schemaVersion: 1,
    code: 'internal',
    message: 'Library import failed',
    retryable: true,
    nextActions: ['retry'],
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function timestamp(value: number): string {
  return new Date(value).toISOString()
}
