import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LibraryRpcResult, UploadStart } from '@docatlas/contracts'
import { humanResearchIssues, type HumanResearchValue } from '@docatlas/contracts'
import { productLearningIssues, type ProductLearningOperation, type ProductLearningView } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { DocAtlasAssetStore } from '@docatlas/runtime-document'
import { ApiError } from '../http/auth.js'
import type { ProductActor } from '../storage/control-store.js'
import type { DocumentApplication } from './application.js'
import type { UploadStore } from './uploads.js'
import type { PersonalizationService } from '../personalization/service.js'
import { workspaceProfileId } from '../personalization/service.js'
import type { ProductLearning } from '../personalization/learning.js'
import { ProductLibrary } from './versions.js'
import type { ProductProbes } from '../personalization/probes.js'
import { enrichmentHash } from '@docatlas/core'

export interface DocumentRequestContext { actor: ProductActor, conversationId: string, authorize(): void, signal: AbortSignal, json(): Promise<unknown>, send(status: number, value: unknown): void }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Explicit product routes only; no arbitrary sidecar RPC or path parameters. */
export class DocumentHttp {
  private reads = 0
  private readonly assets: DocAtlasAssetStore
  readonly versions: ProductLibrary
  readonly probes: ProductProbes | undefined
  readonly learning: ProductLearning | undefined
  constructor(readonly application: DocumentApplication, readonly uploads: UploadStore, cacheRoot: string, private readonly personalization?: PersonalizationService) {
    this.assets = new DocAtlasAssetStore(cacheRoot)
    this.versions = new ProductLibrary(application.store, application.library, uploads, id => application.research.binding(id), application.answers)
    this.probes = personalization?.probes(application.answers)
    this.learning = personalization?.learning(application.answers, application.store)
  }
  async handle(request: IncomingMessage, response: ServerResponse, parts: string[], url: URL, context: DocumentRequestContext): Promise<void> {
    const { actor, conversationId, authorize, signal } = context
    if (actor.actorId !== this.uploads.actor.actorId || actor.workspaceId !== this.uploads.actor.workspaceId) throw new ApiError('not-found')
    authorize()
    const base = { schemaVersion: 1 as const, sessionId: conversationId, workspaceId: actor.workspaceId }
    const reply = (result: LibraryRpcResult, status = 200) => { authorize(); context.send(status, { schemaVersion: 1, kind: 'library-response', conversationId, result }) }
    if (parts[0] === 'question-context') {
      if (parts[1] !== 'messages' && parts[1] !== 'submissions' || !parts[2]) throw new ApiError('not-found')
      const target = { kind: parts[1] === 'messages' ? 'message' as const : 'submission' as const, id: parts[2] }
      if (parts.length === 3 && request.method === 'GET') {
        const value = this.application.questionContexts.get(conversationId, target)
        authorize(); context.send(200, value); return
      }
      if (parts.length === 6 && parts[3] === 'selections' && request.method === 'POST') {
        const body = await context.json()
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError('invalid-request')
        const value = await this.application.questionContexts.focus(conversationId, target, parts[4]!, parts[5]!, authorize, signal)
        authorize(); context.send(200, value); return
      }
      throw new ApiError('not-found')
    }
    if (parts[0] === 'learning') {
      const service = this.learning
      if (!service || !this.personalization) throw new ApiError('unavailable')
      const send = (value: ProductLearningView | ProductLearningOperation) => {
        authorize(); parseContract('product-learning', value)
        if (productLearningIssues(value).length || value.binding.ownerActorId !== actor.actorId || value.binding.workspaceId !== actor.workspaceId
          || value.binding.conversationId !== conversationId || enrichmentHash(value.binding) !== enrichmentHash(this.application.research.binding(conversationId))
          || value.profileId !== workspaceProfileId(actor) || value.profileEpoch !== this.personalization!.profileEpoch(actor, conversationId)
          || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new ApiError('unavailable')
        context.send(200, value)
      }
      if (parts.length === 3 && parts[1] === 'operations' && request.method === 'GET') {
        const value = service.operation(actor, conversationId, parts[2]!)
        if (value.kind !== 'learning-operation' || value.operationId !== parts[2]) throw new ApiError('unavailable')
        send(value); return
      }
      if (request.method !== 'POST') throw new ApiError('not-found')
      const body = await context.json(); authorize()
      let input
      try { input = parseContract('product-learning', body) } catch { throw new ApiError('invalid-request') }
      if (productLearningIssues(input).length) throw new ApiError('invalid-request')
      if (parts.length === 2 && parts[1] === 'query' && input.kind === 'learning-query') {
        const value = service.query(actor, conversationId, input)
        if (value.kind !== 'learning-view' || value.messageId !== (input.messageId ?? null)) throw new ApiError('unavailable')
        send(value); return
      }
      if (parts.length === 1 && input.kind === 'learning-command') {
        const value = service.command(actor, conversationId, input, authorize), r = value.receipt
        if (value.kind !== 'learning-operation' || !r || value.operationId !== `learning-op:${enrichmentHash([actor.actorId, actor.workspaceId, conversationId, input.idempotencyKey])}`
          || r.idempotencyKey !== input.idempotencyKey || r.requestHash !== enrichmentHash(input) || r.action !== input.action
          || r.bindingId !== input.expectedBindingId || r.generation !== input.expectedGeneration || r.profileEpoch !== input.expectedProfileEpoch
          || input.action === 'configure' && r.targetVersion !== input.expectedSettingsVersion + 1
          || input.action === 'dismiss' && (r.targetId !== input.offerId || r.targetVersion !== input.expectedOfferVersion + 1)
          || input.action === 'review' && (r.targetId !== input.candidateId || r.groupId !== input.groupId || r.targetVersion !== input.expectedCandidateVersion + 1)) throw new ApiError('unavailable')
        send(value); return
      }
      throw new ApiError('invalid-request')
    }
    if (parts[0] === 'research-workbench') {
      const service = this.application.humanResearch
      if (!service) throw new ApiError('unavailable')
      const send = (value: HumanResearchValue) => {
        authorize(); parseContract('human-research', value)
        if (humanResearchIssues(value).length || !('binding' in value) || value.binding.ownerActorId !== actor.actorId
          || value.binding.workspaceId !== actor.workspaceId || value.binding.conversationId !== conversationId
          || enrichmentHash(value.binding) !== enrichmentHash(this.application.research.binding(conversationId))
          || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new ApiError('unavailable')
        context.send(200, value)
      }
      if (request.method === 'GET') {
        if (parts.length === 3 && parts[1] === 'entries') {
          const result = service.get(conversationId, parts[2]!)
          if (result.kind !== 'human-research-entry' || result.entry.recordId !== parts[2]) throw new ApiError('unavailable')
          send(result); return
        }
        if (parts.length === 3 && parts[1] === 'operations') {
          const result = service.operation(conversationId, parts[2]!)
          if (result.kind !== 'human-research-operation' || result.operationId !== parts[2]) throw new ApiError('unavailable')
          send(result); return
        }
        throw new ApiError('not-found')
      }
      if (request.method !== 'POST') throw new ApiError('not-found')
      const body = await context.json(); authorize()
      if (parts.length === 5 && parts[1] === 'entries' && parts[3] === 'focus') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError('invalid-request')
        const result = await service.focus(conversationId, parts[2]!, parts[4]!, authorize, signal)
        if (result.kind !== 'human-research-focus' || result.focus.recordId !== parts[2] || result.focus.locator.locatorId !== parts[4]) throw new ApiError('unavailable')
        send(result); return
      }
      let value: HumanResearchValue
      try { value = parseContract('human-research', body) } catch { throw new ApiError('invalid-request') }
      if (!('kind' in value) || humanResearchIssues(value).length) throw new ApiError('invalid-request')
      if (parts.length === 1 && value.kind === 'human-research-command') {
        const result = await service.command(conversationId, value, authorize, signal)
        const receipt = result.receipt
        if (result.kind !== 'human-research-operation' || !receipt || result.operationId !== `human-op:${enrichmentHash([actor.actorId, actor.workspaceId, conversationId, value.idempotencyKey])}`
          || receipt.requestHash !== enrichmentHash(value) || receipt.idempotencyKey !== value.idempotencyKey || receipt.bindingId !== value.expectedBindingId
          || receipt.generation !== value.expectedGeneration || receipt.action !== value.action
          || (value.action === 'create' ? receipt.recordType !== value.entry.recordType || receipt.recordVersion !== 1
            : receipt.recordId !== value.recordId || receipt.recordVersion !== value.expectedVersion + 1)) throw new ApiError('unavailable')
        send(result); return
      }
      if (parts.length === 2 && parts[1] === 'query' && value.kind === 'human-research-query') {
        const result = service.query(conversationId, value)
        if (result.kind !== 'human-research-workspace' || result.result.view !== value.view || result.result.items.some(item => !value.recordTypes.some(type => type === item.recordType)
          || !value.recordStatuses.some(status => status === item.recordStatus) || value.view === 'working' && item.layer !== 'working')
          || result.result.pageInfo.returned > value.maxItems || result.result.pageInfo.usedChars === undefined || result.result.pageInfo.usedChars > value.maxChars) throw new ApiError('unavailable')
        send(result); return
      }
      if (parts.length === 2 && parts[1] === 'overlay' && value.kind === 'human-research-overlay-query') {
        const result = service.overlay(conversationId, value)
        if (result.kind !== 'human-research-overlay' || result.result.source.documentId !== value.source.documentId || result.result.source.revisionId !== value.source.revisionId
          || result.result.physicalPage !== value.physicalPage || result.result.items.some(item => !value.recordTypes.some(type => type === item.recordType)
            || value.view === 'working' && item.layer !== 'working') || result.result.pageInfo.returned > value.maxItems || result.result.pageInfo.usedChars === undefined || result.result.pageInfo.usedChars > value.maxChars) throw new ApiError('unavailable')
        send(result); return
      }
      throw new ApiError('invalid-request')
    }
    if (parts[0] === 'continuity') {
      if (parts.length !== 2 || request.method !== 'POST') throw new ApiError('not-found')
      const body = await context.json(); authorize()
      const service = this.application.continuity
      if (parts[1] === 'inspect') { const result = service.inspect(conversationId, body); authorize(); context.send(200, result); return }
      if (parts[1] === 'impact') { const result = service.impact(conversationId, body); authorize(); context.send(200, result); return }
      if (parts[1] === 'assess') { const result = await service.assess(conversationId, body, authorize, signal); authorize(); context.send(200, result); return }
      throw new ApiError('not-found')
    }
    if (parts[0] === 'reviews') {
      const reviews = this.application.reviews
      if (parts.length === 1 && request.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'scopeVersionId') || url.searchParams.getAll('scopeVersionId').length > 1) throw new ApiError('invalid-request')
        context.send(200, reviews.workspace(conversationId, url.searchParams.get('scopeVersionId') ?? undefined)); return
      }
      if (parts.length === 1 && request.method === 'POST') { const body = await context.json(); authorize(); context.send(200, reviews.command(conversationId, body)); return }
      if (parts.length === 4 && parts[1] === 'evidence' && parts[3] === 'focus' && request.method === 'POST') {
        const body = await context.json()
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'scopeVersionId' || !('scopeVersionId' in body) || typeof body.scopeVersionId !== 'string') throw new ApiError('invalid-request')
        const result = await reviews.focus(conversationId, body.scopeVersionId, parts[2]!, authorize, signal)
        authorize(); context.send(200, result); return
      }
      throw new ApiError('not-found')
    }
    if (parts[0] === 'research') {
      const service = this.application.research, binding = service.binding(conversationId)
      if (parts.length === 2 && parts[1] === 'policy' && request.method === 'GET') { context.send(200, service.journal.policy(binding)); return }
      if (parts[1] === 'notes' && parts.length === 3 && request.method === 'GET') { context.send(200, service.get(conversationId, parts[2]!)); return }
      if (request.method === 'POST') {
        const body = await context.json(); authorize()
        if (parts[1] === 'notes' && parts.length === 5 && parts[3] === 'focus') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError('invalid-request')
          const result = await service.focus(conversationId, parts[2]!, parts[4]!, authorize, signal); authorize(); context.send(200, result); return
        }
        const { parseContract } = await import('@docatlas/contracts/node')
        let value
        try { value = parseContract('product-research', body) } catch { throw new ApiError('invalid-request') }
        if (parts.length === 2 && parts[1] === 'query' && value.kind === 'notebook-query') { context.send(200, service.query(conversationId, value)); return }
        if (parts.length === 2 && parts[1] === 'notes' && value.kind === 'note-save') { context.send(200, service.save(conversationId, value)); return }
        if (parts.length === 3 && parts[1] === 'notes' && value.kind === 'notebook-mutate' && value.recordId === parts[2]) { context.send(200, service.mutate(conversationId, value)); return }
        if (parts.length === 2 && parts[1] === 'policy' && value.kind === 'research-policy-set') { context.send(200, service.journal.setPolicy(binding, value)); return }
      }
      throw new ApiError('invalid-request')
    }
    if (parts[0] === 'preferences') {
      if (!this.personalization) throw new ApiError('unavailable')
      if (parts.length === 3 && parts[1] === 'probes' && request.method === 'POST') {
        if (!this.probes) throw new ApiError('unavailable')
        const body = await context.json(); authorize()
        const operation = parts[2]
        if (operation !== 'inspect' && operation !== 'prepare' && operation !== 'choose' && operation !== 'review') throw new ApiError('not-found')
        const result = this.probes[operation](actor, conversationId, body)
        authorize(); context.send(200, result); return
      }
      if (parts.length === 2 && parts[1] === 'state' && request.method === 'GET') { context.send(200, { schemaVersion: 2, kind: 'preference-inspection', conversationId,
        profileEpoch: this.personalization.profileEpoch(actor, conversationId), modelApplication: this.personalization.modelApplication, useSemantics: 'observed-answer-generation', result: this.personalization.inspect(actor, conversationId, 50) }); return }
      if (parts.length === 1 && request.method === 'GET') {
        // v1 promises no model application. A connected host must require the truthful v2 inspection.
        if (this.personalization.modelApplication !== 'not-connected') throw new ApiError('conflict')
        context.send(200, { schemaVersion: 1, kind: 'preference-inspection', conversationId, modelApplication: 'not-connected', result: this.personalization.inspect(actor, conversationId, 50) }); return
      }
      if (parts.length === 1 && request.method === 'POST') {
        const { parseContract } = await import('@docatlas/contracts/node')
        let value
        try {
          const body = await context.json()
          value = body && typeof body === 'object' && 'schemaVersion' in body && body.schemaVersion === 2
            ? parseContract('product-personalization-v2', body) : parseContract('product-personalization', body)
        } catch { throw new ApiError('invalid-request') }
        authorize()
        if (value.kind !== 'preference-command') throw new ApiError('invalid-request')
        if (value.expectedGeneration !== this.application.research.binding(conversationId).generation) throw new ApiError('conflict')
        context.send(200, { schemaVersion: value.schemaVersion, kind: 'preference-result', conversationId,
          result: this.personalization.command(actor, conversationId, value.command, value.schemaVersion === 2 ? value.expectedProfileEpoch : 0) }); return
      }
      if (parts.length === 3 && parts[1] === 'exports' && request.method === 'GET') {
        const asset = this.personalization.exportAsset(actor, conversationId, parts[2]!); authorize()
        if (asset.bytes.length > 8388608) throw new ApiError('limit-exceeded')
        response.writeHead(200, { 'Content-Type': asset.mediaType, 'Content-Length': asset.bytes.length,
          'Content-Disposition': `attachment; filename="docatlas-preferences.${asset.descriptor.format === 'json' ? 'json' : 'md'}"` })
        response.end(asset.bytes); return
      }
      throw new ApiError('not-found')
    }
    if (parts[0] === 'answers') {
      if (parts.length === 2 && request.method === 'GET') { context.send(200, this.application.answers.get(conversationId, parts[1]!)); return }
      if (parts.length === 4 && parts[2] === 'citations' && request.method === 'POST') {
        const body = await context.json(); if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError('invalid-request')
        const result = await this.application.answers.focus(conversationId, parts[1]!, parts[3]!, authorize, signal)
        authorize(); context.send(200, result); return
      }
      throw new ApiError('not-found')
    }
    if (parts[0] === 'enrichments') {
      const service = this.application.enrichments
      if (!service) throw new ApiError('unavailable')
      if (parts.length === 1 && request.method === 'POST') {
        const { parseContract } = await import('@docatlas/contracts/node')
        let value
        try { value = parseContract('enrichment', await context.json()) } catch { throw new ApiError('invalid-request') }
        if (value.kind !== 'enrichment-start') throw new ApiError('invalid-request')
        authorize(); context.send(202, service.accept(conversationId, value)); return
      }
      if (parts.length === 2 && request.method === 'GET') { context.send(200, service.get(conversationId, parts[1]!)); return }
      if (parts.length === 3 && request.method === 'POST' && ['run', 'cancel'].includes(parts[2]!)) {
        const body = await context.json(); if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError('invalid-request')
        authorize()
        if (parts[2] === 'run') { void service.start(conversationId, parts[1]!).catch(() => {}); context.send(202, service.get(conversationId, parts[1]!)); return }
        const result = await service.cancel(conversationId, parts[1]!); authorize(); context.send(200, result); return
      }
      throw new ApiError('not-found')
    }
    if (parts[0] === 'documents' && parts.length === 4 && parts[3] === 'tree' && request.method === 'POST') {
      if (!this.application.enrichments) throw new ApiError('unavailable')
      const value = await context.json() as { mode?: unknown, offset?: number }
      if (!value || !['mode', 'mode,offset'].includes(Object.keys(value).sort().join(',')) || value.mode !== 'raw' && value.mode !== 'merge' || value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 20000)) throw new ApiError('invalid-request')
      const result = await this.application.enrichments.tree(conversationId, parts[1]!, parts[2]!, value.mode, signal, value.offset)
      authorize(); context.send(200, { schemaVersion: 1, kind: 'enrichment-tree', conversationId, ...result }); return
    }
    if (parts[0] === 'selections') {
      if (parts.length === 1 && request.method === 'POST') {
        const { parseContract } = await import('@docatlas/contracts/node')
        let value
        try { value = parseContract('document-http', await context.json()) } catch { throw new ApiError('invalid-request') }
        if (value.kind !== 'selection-stage') throw new ApiError('invalid-request')
        const result = await this.application.selections.stage(conversationId, value, authorize, signal)
        authorize(); context.send(200, result); return
      }
      if (parts.length === 2 && request.method === 'GET') { context.send(200, this.application.selections.get(conversationId, parts[1]!)); return }
      if (parts.length === 3 && parts[2] === 'cancel' && request.method === 'POST') {
        const body = await context.json(); if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError('invalid-request')
        authorize(); context.send(200, this.application.selections.cancel(conversationId, parts[1]!)); return
      }
      throw new ApiError('not-found')
    }
    if (parts[0] === 'uploads') {
      if (parts.length === 1 && request.method === 'POST') {
        const { parseContract } = await import('@docatlas/contracts/node')
        let input: UploadStart
        try { const value = parseContract('document-http', await context.json()); if (value.kind !== 'upload-start') throw new Error(); input = value } catch { throw new ApiError('invalid-request') }
        authorize(); context.send(200, this.uploads.reserve(conversationId, input)); return
      }
      const uploadId = parts[1]
      if (!uploadId || parts.length > 3) throw new ApiError('not-found')
      const upload = this.uploads.get(conversationId, uploadId)
      if (parts.length === 2 && request.method === 'GET') { context.send(200, upload); return }
      if (parts.length === 2 && request.method === 'PUT') {
        if (request.headers['content-type'] !== 'application/pdf' || request.headers['content-encoding']) throw new ApiError('invalid-request')
        const length = request.headers['content-length']
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== upload.byteLength)) throw new ApiError('invalid-request')
        const receipt = await this.uploads.put(conversationId, uploadId, request, authorize, signal)
        authorize(); context.send(200, receipt); return
      }
      if (parts.length === 3 && ['revision-import', 'revision-status'].includes(parts[2]!) && request.method === 'POST') {
        const { parseContract } = await import('@docatlas/contracts/node')
        let value
        try { value = parseContract('product-library', await context.json()) } catch { throw new ApiError('invalid-request') }
        if (value.kind !== 'revision-import' || value.uploadId !== uploadId) throw new ApiError('invalid-request')
        authorize()
        const result = parts[2] === 'revision-import' ? this.versions.import(conversationId, value) : this.versions.status(conversationId, value)
        authorize(); context.send(parts[2] === 'revision-import' ? 202 : 200, result); return
      }
      const key = `${uploadId}:import`, jobId = `job:${hash(`${actor.workspaceId}\0${key}`).slice(0, 32)}`
      if (parts[2] === 'import' && request.method === 'POST') {
        const body = await context.json(); if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError('invalid-request')
        authorize(); if (upload.status !== 'stored') throw new ApiError('conflict')
        reply(this.application.library.acceptImport({ ...base, requestType: 'library-import', candidateId: uploadId, idempotencyKey: key, sourceRole: 'primary' }), 202); return
      }
      if (parts[2] === 'job' && request.method === 'GET') { reply(this.application.library.getJob({ ...base, requestType: 'library-job-get', jobId })); return }
    }
    if (parts[0] === 'documents' && request.method === 'GET') {
      if (parts.length === 1) { reply(this.application.library.list({ ...base, requestType: 'library-list', limit: 30, sort: 'updated-desc', ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}) })); return }
      if (parts.length === 3 && parts[2] === 'revisions') {
        if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) throw new ApiError('invalid-request')
        const result = this.versions.history(conversationId, parts[1]!, url.searchParams.get('cursor') ?? undefined)
        authorize(); context.send(200, result); return
      }
      const document = this.application.library.get({ ...base, requestType: 'library-get', documentId: parts[1]! })
      if (parts.length === 2) { reply(document); return }
      if (parts.length === 4 && parts[3] === 'original') {
        const documentId = parts[1]!, revisionId = parts[2]!
        signal.throwIfAborted(); authorize()
        const initial = this.application.answers.originalDocument(conversationId, documentId, revisionId), seal = hash(JSON.stringify(initial))
        const check = () => {
          signal.throwIfAborted(); authorize()
          const value = this.application.answers.originalDocument(conversationId, documentId, revisionId)
          if (hash(JSON.stringify(value)) !== seal) throw new ApiError('conflict')
          return value
        }
        const original = check().representation
        if (original.byteLength > 26214400 || this.reads >= 2) throw new ApiError('limit-exceeded')
        this.reads++
        try {
          const opened = await this.assets.openAuthorized(original.representationId, undefined, descriptor => {
            check(); return descriptor.kind === 'original-bytes' && descriptor.documentId === documentId && descriptor.revisionId === revisionId
              && descriptor.assetId === original.representationId && descriptor.representationId === original.representationId
              && descriptor.representationContentHash === original.contentHash && descriptor.contentHash === original.contentHash
              && descriptor.byteLength === original.byteLength && descriptor.mediaType === original.mediaType
          })
          if (!opened) throw new ApiError('not-found')
          let bytes: Buffer
          try {
            check()
            bytes = Buffer.alloc(original.byteLength)
            let offset = 0
            while (offset < bytes.length) { check(); const part = await opened.handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset); check(); if (!part.bytesRead) throw new ApiError('unavailable'); offset += part.bytesRead }
            if ((await opened.handle.stat()).size !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== original.contentHash) throw new ApiError('unavailable')
          } finally { await opened.handle.close() }
          check(); response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, ETag: `"${original.contentHash}"`, 'Content-Disposition': 'inline; filename="document.pdf"' })
          for (let offset = 0; offset < bytes.length; offset += 65536) {
            check()
            if (!response.write(bytes.subarray(offset, offset + 65536))) await drain(response, signal)
          }
          check(); response.end(); return
        } finally { this.reads-- }
      }
    }
    throw new ApiError('not-found')
  }
}
function drain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); response.off('drain', ready); response.off('close', failed); signal.removeEventListener('abort', failed) }
    const ready = () => { cleanup(); resolve() }, failed = () => { cleanup(); reject(new ApiError('unavailable')) }
    const timer = setTimeout(failed, 5000)
    response.once('drain', ready); response.once('close', failed); signal.addEventListener('abort', failed, { once: true })
    if (signal.aborted || response.destroyed) failed()
  })
}
