import { DocumentSession, DocumentOperations, DocumentAccessError, LibraryService, SourceScopeStore, ResearchScopeSnapshots, type ResearchOperations, type LibraryDiscoveryPort, type SelectionResolverPort } from '@docatlas/core'
import { createDocumentBackend, createNodeUvSidecarSpawner, documentSupervisorOptions, LibraryDiscovery, SidecarSupervisor, type ManagedDocumentBackend, type UvDocumentOptions } from '@docatlas/runtime-document'
import { ControlStore, type ProductActor } from '../storage/control-store.js'
import type { PrepareSubmission } from '../runs/submission-coordinator.js'
import { ProductSelections } from './selections.js'
import { SelectionTickets } from '../storage/selection-tickets.js'
import { join } from 'node:path'
import { DocumentEnrichments } from './enrichments.js'
import { EnrichmentJobs } from '../storage/enrichment-jobs.js'
import type { EnrichmentModelPort } from '@docatlas/core'
import type { ProductPiCheckpoint, ProductPreparedSubmission } from '@docatlas/contracts'
import { ProductAnswers } from './answers.js'
import { AnswerReceipts } from '../storage/answer-receipts.js'
import { ProductResearch } from './research.js'
import { ResearchJournal } from '../storage/research-journal.js'
import { ProductReviews } from './reviews.js'
import { ProductContinuity } from './continuity.js'
import { HumanResearch } from './human-research.js'
import { ProductQuestionContexts } from './question-context.js'

interface ConversationDocuments {
  generation: number
  session: DocumentSession
  operations: DocumentOperations & Pick<ResearchOperations, 'record' | 'recall'>
  backend: ManagedDocumentBackend
  supervisor: SidecarSupervisor
  onCheckpoint(file: string, checkpoint: ProductPiCheckpoint, prepared: ProductPreparedSubmission): void
}
/** Internal composition. Mandatory owner binding; not a browser authentication endpoint. */
export class DocumentApplication {
  private readonly sessions = new Map<string, ConversationDocuments>()
  private readonly retired = new Set<Promise<void>>()
  readonly library: LibraryService
  readonly selections: ProductSelections
  readonly answers: ProductAnswers
  readonly questionContexts: ProductQuestionContexts
  readonly research: ProductResearch
  readonly humanResearch: HumanResearch
  readonly reviews: ProductReviews
  readonly continuity: ProductContinuity
  enrichments: DocumentEnrichments | undefined
  private searchModel: EnrichmentModelPort | undefined
  private closed = false
  private constructor(
    readonly store: SourceScopeStore, readonly supervisor: SidecarSupervisor,
    private readonly options: UvDocumentOptions, private readonly control: ControlStore,
    private readonly actor: ProductActor, discovery: LibraryDiscoveryPort,
  ) {
    const tickets = new SelectionTickets(join(control.storageRoot, 'selection-tickets'))
    this.selections = new ProductSelections(tickets, store, conversationId => { this.requireOpen(); return control.binding(actor, conversationId) }, () => this.createReader())
    this.answers = new ProductAnswers(new AnswerReceipts(join(control.storageRoot, 'answer-receipts')), store, control, actor, () => this.createReader())
    this.questionContexts = new ProductQuestionContexts(control, actor, tickets, this.answers)
    this.research = new ProductResearch(store, control, actor, new ResearchScopeSnapshots(join(control.storageRoot, 'research-scopes')),
      new ResearchJournal(join(control.storageRoot, 'research-control')), this.selections, this.answers)
    this.humanResearch = new HumanResearch(store, this.research, this.selections)
    this.reviews = new ProductReviews(store, control, actor, this.answers)
    this.continuity = new ProductContinuity(store, control, actor, this.research, this.answers, this.reviews)
    this.library = new LibraryService({
      assertBrowserSession: (conversationId, workspaceId) => {
        this.requireOpen()
        if (control.binding(actor, conversationId).workspaceId !== workspaceId) throw new Error('Library workspace denied')
      },
      registerEligibleSources: () => {},
      call: async (method, request, signal) => { signal?.throwIfAborted(); await supervisor.start(); return supervisor.call(method, request, signal) },
    }, store, discovery)
  }
  enableEnrichments(model: EnrichmentModelPort): DocumentEnrichments {
    this.requireOpen(); if (this.enrichments) throw new Error('Enrichment model is already configured')
    const jobs = new EnrichmentJobs(join(this.control.storageRoot, 'enrichment-jobs'))
    this.enrichments = new DocumentEnrichments(jobs, this.store, id => { this.requireOpen(); return this.control.binding(this.actor, id) }, () => {
      const options = { ...this.options, sourceRoots: {} }
      return createDocumentBackend(new SidecarSupervisor(documentSupervisorOptions(createNodeUvSidecarSpawner(options))), options)
    }, model)
    return this.enrichments
  }
  enableTreeSearch(model: EnrichmentModelPort): void {
    this.requireOpen()
    this.searchModel = model
    for (const entry of this.sessions.values()) entry.operations.enableTreeSearch(model, () => Boolean(this.enrichments))
  }
  static async create(options: UvDocumentOptions & { domainRoot: string, control: ControlStore, actor: ProductActor, discovery?: LibraryDiscoveryPort }): Promise<DocumentApplication> {
    const config: UvDocumentOptions = { projectRoot: options.projectRoot, cacheRoot: options.cacheRoot, sourceRoots: { ...options.sourceRoots },
      protectedRoots: [...(options.protectedRoots ?? []), options.domainRoot, options.control.storageRoot],
      ...(options.uvCommand ? { uvCommand: options.uvCommand } : {}), ...(options.graceMs ? { graceMs: options.graceMs } : {}) }
    const store = await SourceScopeStore.open(options.domainRoot)
    const supervisor = new SidecarSupervisor(documentSupervisorOptions(createNodeUvSidecarSpawner(config)))
    try {
      return new DocumentApplication(store, supervisor, config, options.control, { ...options.actor }, options.discovery ?? await LibraryDiscovery.create(options.sourceRoots))
    } catch (error) { await supervisor.dispose(); store.close(); throw error }
  }
  forConversation(conversationId: string): ConversationDocuments {
    this.requireOpen()
    const binding = this.control.binding(this.actor, conversationId)
    let active = this.sessions.get(conversationId)
    if (active?.generation !== binding.generation) {
      if (active) {
        active.session.invalidate()
        const stopped = active.backend.abortAll()
        this.retired.add(stopped)
        void stopped.finally(() => this.retired.delete(stopped)).catch(() => {})
      }
      const session = new DocumentSession(this.store, {
        conversationId, workspaceId: this.actor.workspaceId, actorId: this.actor.actorId,
        runtimeSessionId: binding.runtimeSessionId,
        ...(binding.investigationId ? { investigationId: binding.investigationId } : {}),
      }, () => {
        this.requireOpen()
        if (this.control.binding(this.actor, conversationId).generation !== binding.generation) throw new Error('Document binding is stale')
      }, this.selections)
      const supervisor = new SidecarSupervisor(documentSupervisorOptions(createNodeUvSidecarSpawner({ ...this.options, sourceRoots: {} })))
      const backend = createDocumentBackend(supervisor, this.options)
      const enrichments = () => { this.requireOpen(); if (!this.enrichments) throw new DocumentAccessError('unavailable', 'Enrichment navigation is not configured'); return this.enrichments }
      const research = this.research.forConversation(conversationId)
      const operations = new DocumentOperations(session, backend, {
        list: (invocation, source) => enrichments().listNavigation(conversationId, invocation, source),
        get: (invocation, source, jobId) => enrichments().readNavigation(conversationId, invocation, source, jobId),
      }, { record: (invocation, callId, result) => {
        this.requireOpen()
        const receipt = this.control.get(this.actor, invocation.submissionId)
        if (receipt.conversationId !== conversationId || receipt.generation !== binding.generation || !['dispatching', 'running'].includes(receipt.state)) throw new DocumentAccessError('stale', 'Read receipt is outside an executing submission')
        this.answers.receipts.recordRead(this.answers.binding(conversationId), invocation, callId, result)
      } })
      if (this.searchModel) operations.enableTreeSearch(this.searchModel, () => Boolean(this.enrichments))
      active = { generation: binding.generation, session, operations: Object.assign(operations, { record: research.record.bind(research), recall: research.recall.bind(research) }),
        backend, supervisor, onCheckpoint: (file, checkpoint, prepared) => this.answers.capture(conversationId, file, checkpoint, prepared) }
      this.sessions.set(conversationId, active)
    }
    return active
  }
  readonly prepare: PrepareSubmission = async ({ request, receipt, signal }) => {
    signal.throwIfAborted()
    const result = this.forConversation(request.conversationId).session.prepare(request, receipt)
    const consumeResearch = this.research.prepare(request, receipt, result.prepared)
    signal.throwIfAborted()
    return { ...result, onConsumed: () => { result.onConsumed(); consumeResearch() } }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.humanResearch.close()
    this.reviews.close()
    for (const entry of this.sessions.values()) entry.session.invalidate()
    await this.library.dispose()
    await Promise.all([this.supervisor.dispose(), this.selections.close(), this.answers.close(), this.continuity.close(), this.enrichments?.close(), ...[...this.sessions.values()].map(entry => entry.backend.abortAll()), ...this.retired])
    this.enrichments?.jobs.close(); this.selections.tickets.close(); this.answers.receipts.close(); this.research.close(); this.store.close()
  }
  private createReader(): SelectionResolverPort & { close(): Promise<void> } {
    const reader = new SidecarSupervisor(documentSupervisorOptions(createNodeUvSidecarSpawner({ ...this.options, sourceRoots: {} })))
    let closing: Promise<void> | undefined
    return { close: () => closing ??= reader.dispose(), call: async (method, request, signal) => {
      this.requireOpen(); signal?.throwIfAborted(); if (closing) throw new Error('Document reader is closing')
      await reader.start(); signal?.throwIfAborted(); if (closing) throw new Error('Document reader stopped during startup')
      return reader.call(method, request, signal)
    } }
  }
  private requireOpen(): void { if (this.closed) throw new Error('Document application is closed') }
}
