import { createHash } from 'node:crypto'
import { ClaimReviewApplication, DocumentAccessError, enrichmentHash, type ClaimReviewContext, type SourceScopeStore } from '@docatlas/core'
import { M4_PUBLISH_RULESET, productReviewIssues, type ProductBinding, type ProductReviewCommand, type ProductReviewWorkspace,
  type ProductReviewResult, type ProductReviewFocus, type ProductReviewValue, type M4RpcRequest, type M4RpcResult, type ClaimLedgerSnapshot,
  type ClaimUse, type ArtifactManifest, type DocumentLocator } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import type { ProductAnswers } from './answers.js'

type Scope = NonNullable<ReturnType<SourceScopeStore['getSourceScopeVersion']>>
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
const opaque = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const deny = (message: string): never => { throw new DocumentAccessError('permission-denied', message) }
const unique = (values: string[]) => [...new Set(values)].sort()
const uses = (artifact: ArtifactManifest): ClaimUse[] => artifact.content.kind === 'brief'
  ? artifact.content.sections.flatMap(section => section.claimUses) : artifact.content.cells.flatMap(cell => cell.claimUses)

/** Human research workbench. It reads canonical domain truth; it never becomes a native source-admission or model tool. */
export class ProductReviews {
  private readonly application: ClaimReviewApplication
  private closed = false
  constructor(private readonly domain: SourceScopeStore, private readonly control: ControlStore, private readonly actor: ProductActor, private readonly answers: ProductAnswers) {
    this.application = new ClaimReviewApplication(domain)
  }
  private binding(conversationId: string): ProductBinding {
    if (this.closed) throw new DocumentAccessError('unavailable', 'Review service is closed')
    return this.control.binding(this.actor, conversationId)
  }
  private investigation(binding: ProductBinding): string { return binding.investigationId ?? `investigation:${digest(binding.conversationId)}` }
  private assertBinding(binding: ProductBinding): void {
    const current = this.binding(binding.conversationId)
    if (current.bindingId !== binding.bindingId || current.generation !== binding.generation || current.runtimeSessionId !== binding.runtimeSessionId) throw new DocumentAccessError('stale', 'Review conversation changed')
  }
  private source(binding: ProductBinding, expected: Pick<DocumentLocator, 'documentId' | 'revisionId' | 'representationId' | 'representationContentHash'>): void {
    this.assertBinding(binding)
    const source = this.domain.getEligibleLibrarySource(binding.workspaceId, expected.documentId, expected.revisionId)
    if (!source || source.representationId !== expected.representationId || source.representationContentHash !== expected.representationContentHash
      || this.domain.get(binding.conversationId).scope?.excluded.some(item => item.documentId === expected.documentId && item.revisionId === expected.revisionId && item.reason !== 'user')) deny('Review source is no longer authorized')
  }
  private scope(binding: ProductBinding, scopeVersionId: string): Scope {
    if (!opaque(scopeVersionId)) throw new DocumentAccessError('invalid-request', 'Invalid review scope')
    this.assertBinding(binding)
    const frame = this.domain.getSourceScopeVersion(binding.workspaceId, scopeVersionId)
    if (!frame || frame.scope.investigationId !== this.investigation(binding) || frame.scope.createdBy.kind !== 'user'
      || frame.scope.createdBy.actorId !== binding.ownerActorId || !frame.scope.locked) return deny('Review scope is not owned by this authenticated Investigation')
    for (const source of frame.sources) this.source(binding, source)
    return frame
  }
  private evidence(binding: ProductBinding, scopeVersionId: string, evidenceId: string) {
    this.scope(binding, scopeVersionId)
    const value = this.domain.getCanonicalEvidence(binding.workspaceId, this.investigation(binding), scopeVersionId, evidenceId)
    if (!value) return deny('Canonical source evidence is unavailable')
    this.source(binding, value.locator)
    // Persisted-but-unpublished AnswerManifest rows are not product-authorized evidence.
    const authorized = value.origins.some(origin => {
      try {
        this.control.binding(this.actor, origin.sessionId)
        if (origin.kind === 'selection-action') return true
        const answer = this.answers.get(origin.sessionId, origin.messageId), citation = answer.manifest?.citations.find(item => item.citationId === origin.citationId)
        return answer.status === 'available' && answer.manifest?.manifestId === origin.manifestId && answer.manifest.sourceScopeVersionId === scopeVersionId
          && citation?.verificationStatus === 'read-verified' && citation.evidence !== undefined
          && enrichmentHash(citation.evidence) === enrichmentHash(value.evidence) && enrichmentHash(citation.locator) === enrichmentHash(value.locator)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['not-found', 'permission-denied', 'stale'].includes(String(error.code))) return false
        throw error
      }
    })
    if (!authorized) return deny('Evidence lacks an authorized original conversation and completed publication')
    return value
  }
  /** Trusted application port; never a browser-controlled generic Evidence/Locator resolver. */
  canonicalEvidence(conversationId: string, scopeVersionId: string, evidenceId: string) {
    return this.evidence(this.binding(conversationId), scopeVersionId, evidenceId)
  }
  private context(binding: ProductBinding, scopeVersionId: string): ClaimReviewContext {
    const frame = this.scope(binding, scopeVersionId), seal = enrichmentHash(frame)
    return { ...frame, conversationId: binding.conversationId, workspaceId: binding.workspaceId, investigationId: frame.scope.investigationId,
      actor: { kind: 'user', actorId: binding.ownerActorId }, signoffRequirement: 'required',
      assertCurrent: () => { this.assertBinding(binding); if (enrichmentHash(this.scope(binding, scopeVersionId)) !== seal) throw new DocumentAccessError('stale', 'Review snapshot changed') },
      authorize: () => { this.assertBinding(binding) }, authorizeHistoricalScope: id => this.scope(binding, id),
      getAuthorizedEvidence: (id, scope) => this.evidence(binding, scope, id) }
  }
  private base(binding: ProductBinding, scopeVersionId: string) {
    return { schemaVersion: 1 as const, sessionId: binding.conversationId, workspaceId: binding.workspaceId, investigationId: this.investigation(binding), scopeVersionId }
  }
  private call(binding: ProductBinding, scopeVersionId: string, fields: Omit<M4RpcRequest, keyof ReturnType<ProductReviews['base']>>): M4RpcResult {
    return this.application.handle({ ...this.base(binding, scopeVersionId), ...fields } as M4RpcRequest, this.context(binding, scopeVersionId))
  }
  private ledger(binding: ProductBinding, scopeVersionId: string): ClaimLedgerSnapshot {
    const value = this.call(binding, scopeVersionId, { requestType: 'm4-claim-ledger-get' })
    if (value.resultType !== 'm4-claim-ledger') throw new DocumentAccessError('invalid-output', 'Invalid Claim ledger')
    return value.ledger
  }
  private artifact(binding: ProductBinding, scopeVersionId: string, artifactManifestId: string): ArtifactManifest {
    const value = this.application.handle({ ...this.base(binding, scopeVersionId), requestType: 'm4-artifact-get', artifactManifestId }, this.context(binding, scopeVersionId))
    if (value.resultType !== 'm4-artifact') throw new DocumentAccessError('invalid-output', 'Invalid Artifact')
    return value.manifest
  }
  workspace(conversationId: string, selectedScope?: string): ProductReviewWorkspace {
    const binding = this.binding(conversationId), investigationId = this.investigation(binding)
    const frames = this.domain.listSourceScopeVersions(binding.workspaceId, investigationId).filter(frame => {
      try { this.scope(binding, frame.scope.scopeVersionId); return true }
      catch (error) { if (error instanceof DocumentAccessError && ['permission-denied', 'stale'].includes(error.code)) return false; throw error }
    })
    // Default only to a completed, published answer when one exists. Prepared scopes are not claimed as consumed.
    const published = this.domain.listAnswerManifests(binding.workspaceId, conversationId).filter(manifest => {
      if (!frames.some(frame => frame.scope.scopeVersionId === manifest.sourceScopeVersionId)) return false
      return this.answers.get(conversationId, manifest.messageId).status === 'available'
    }).sort((a, b) => a.turn - b.turn)
    const defaultScope = published.at(-1)?.sourceScopeVersionId ?? frames.at(-1)?.scope.scopeVersionId
    const scopeId = selectedScope ?? defaultScope
    const value: ProductReviewWorkspace = { schemaVersion: 1, kind: 'review-workspace', conversationId, bindingId: binding.bindingId, generation: binding.generation,
      scope: null, scopeOptions: [], claims: [], evidenceRelations: [], derivations: [], evidence: [], artifacts: [], reviews: [], decisions: [], truncated: false }
    if (!scopeId) return this.valid(value)
    const frame = this.scope(binding, scopeId), options = frames.slice(-128)
    if (!options.some(item => item.scope.scopeVersionId === scopeId)) { if (options.length >= 128) options.shift(); options.unshift(frame) }
    value.scope = frame.scope
    value.scopeOptions = options.map(item => ({ scopeVersionId: item.scope.scopeVersionId, version: item.scope.version, sourceCount: item.sources.length,
      current: item.scope.scopeVersionId === published.at(-1)?.sourceScopeVersionId,
      ...(item.sources.length <= 32 ? { sourceRefs: item.sources.map(source => ({ documentId: source.documentId, revisionId: source.revisionId })) } : {}) }))
    value.truncated = frames.length > options.length
    const ledger = this.ledger(binding, scopeId), allClaims = ledger.claims.filter(item => item.scope.sourceScopeVersionId === scopeId)
    value.claims = allClaims.slice(-128).map(item => structuredClone(item))
    const claimIds = new Set(value.claims.map(item => item.claimVersionId)), activityIds = new Set(value.claims.map(item => item.provenanceActivityId))
    const relations = ledger.evidenceRelations.filter(item => claimIds.has(item.claimVersionId))
    value.evidenceRelations = relations.slice(-1024).map(item => structuredClone(item))
    value.derivations = ledger.derivations.filter(item => activityIds.has(item.derivationActivityId)).map(item => structuredClone(item))
    const candidates = new Set<string>(value.evidenceRelations.map(item => item.evidenceId))
    for (const manifest of published.filter(item => item.sourceScopeVersionId === scopeId)) for (const citation of manifest.citations) {
      if (citation.verificationStatus === 'read-verified' && citation.evidence) candidates.add(citation.evidence.evidenceId)
    }
    for (const action of this.domain.listSelectionActions(binding.workspaceId, investigationId)) for (const atom of action.evidence) {
      if (this.domain.getCanonicalEvidence(binding.workspaceId, investigationId, scopeId, atom.evidenceId)) candidates.add(atom.evidenceId)
    }
    for (const id of candidates) {
      const item = this.evidence(binding, scopeId, id), name = this.domain.getLibraryDocument(binding.workspaceId, item.locator.documentId)?.displayName
      if (!item.locator.physicalPage || !name) throw new DocumentAccessError('invalid-output', 'Evidence has no original document page')
      if (value.evidence.length >= 128) { value.truncated = true; break }
      const text = [...(item.evidence.content.text ?? '')]
      value.evidence.push({ evidenceId: id, documentId: item.locator.documentId, revisionId: item.locator.revisionId, physicalPage: item.locator.physicalPage,
        sourceName: name, preview: text.length > 1500 ? `${text.slice(0, 1499).join('')}…` : text.join(''), contentHash: item.evidence.contentHash })
    }
    const saved = this.domain.getM4WorkspaceSnapshot(binding.workspaceId, investigationId), artifacts = saved.artifacts.filter(item => item.sourceScopeVersionId === scopeId)
    value.artifacts = artifacts.slice(-32).map(item => this.artifact(binding, scopeId, item.artifactManifestId))
    const artifactIds = new Set(value.artifacts.map(item => item.artifactManifestId))
    const reviews = saved.reviews.filter(item => item.sourceScopeVersionId === scopeId && item.subject.objectIds.some(id => artifactIds.has(id)))
    const pins = new Set(value.artifacts.flatMap(item => item.publication ? [item.publication.reviewResultId] : []))
    const selectedReviews = reviews.filter((item, index) => pins.has(item.reviewResultId) || index >= reviews.length - 64)
    while (selectedReviews.length > 64) { const index = selectedReviews.findIndex(item => !pins.has(item.reviewResultId)); if (index < 0) break; selectedReviews.splice(index, 1) }
    value.reviews = selectedReviews.map(item => {
      const result = this.application.handle({ ...this.base(binding, scopeId), requestType: 'm4-review-get', reviewResultId: item.reviewResultId }, this.context(binding, scopeId))
      if (result.resultType !== 'm4-review') throw new DocumentAccessError('invalid-output', 'Invalid Review')
      return result.review
    })
    const reviewIds = new Set(value.reviews.map(item => item.reviewResultId)), decisions = saved.decisions.filter(item => reviewIds.has(item.reviewResultId))
    value.decisions = decisions.slice(-128) // Preserve verified journal order, including equal timestamps.
    value.truncated ||= allClaims.length > value.claims.length || relations.length > value.evidenceRelations.length || artifacts.length > value.artifacts.length
      || reviews.length > value.reviews.length || decisions.length > value.decisions.length
    this.assertBinding(binding)
    return this.valid(value)
  }
  command(conversationId: string, candidate: unknown): ProductReviewResult {
    let parsed: ProductReviewValue
    try { parsed = parseContract('product-review', candidate) } catch { throw new DocumentAccessError('invalid-request', 'Invalid human review command') }
    if (parsed.kind !== 'review-command' || productReviewIssues(parsed).length) throw new DocumentAccessError('invalid-request', 'Invalid human review command')
    const command: ProductReviewCommand = structuredClone(parsed), binding = this.binding(conversationId), scopeId = command.scopeVersionId
    if (command.expectedGeneration !== binding.generation) throw new DocumentAccessError('stale', 'Review conversation generation changed')
    const ctx = { ...this.context(binding, scopeId), commandHash: enrichmentHash(command) }, base = this.base(binding, scopeId)
    const key = `review:${enrichmentHash([binding.ownerActorId, binding.workspaceId, conversationId, command.idempotencyKey])}`
    const id = (kind: string) => `${kind}:pi:${digest(key)}`
    const execute = (request: M4RpcRequest) => this.application.handle(request, ctx)
    let result: M4RpcResult
    if (command.action === 'claim-save') {
      const ledger = this.ledger(binding, scopeId), previous = command.expectedClaimVersionId === null ? undefined : ledger.claims.find(item => item.claimVersionId === command.expectedClaimVersionId)
      if (command.expectedClaimVersionId !== null && !previous) return deny('The previous ClaimVersion is unavailable')
      result = execute({ ...base, requestType: 'm4-claim-record', idempotencyKey: key, expectedCurrentClaimVersionId: command.expectedClaimVersionId,
        claim: { schemaVersion: 1, claimVersionId: id('claim'), claimChainId: previous?.claimChainId ?? id('claim-chain'), version: (previous?.version ?? 0) + 1,
          ...(previous ? { previousClaimVersionId: previous.claimVersionId } : {}), statement: command.statement, basis: command.basis,
          epistemicStatus: command.epistemicStatus, reviewStatus: command.reviewStatus, scope: command.claimScope ?? {}, ...(command.proposition ? { proposition: command.proposition } : {}) },
        provenance: { schemaVersion: 1, derivationActivityId: id('derivation'), operation: command.derivation.operation,
          inputEvidenceIds: unique(command.evidenceRelations.map(item => item.evidenceId)), inputClaimVersionIds: command.derivation.inputClaimVersionIds,
          ...(command.derivation.expression === undefined ? {} : { expression: command.derivation.expression }), ...(command.derivation.rounding === undefined ? {} : { rounding: command.derivation.rounding }) },
        evidenceRelations: command.evidenceRelations.map((relation, index) => ({ schemaVersion: 1, evidenceRelationId: `${id('relation')}:${index}`, ...relation })) })
    } else if (command.action === 'artifact-create') {
      const ledger = this.ledger(binding, scopeId)
      const sections = command.claims.map((selected, index) => {
        const claim = ledger.claims.find(item => item.claimVersionId === selected.claimVersionId)
        if (!claim || claim.scope.sourceScopeVersionId !== scopeId) return deny('Artifact Claims must belong to its explicit review scope')
        const citations = unique(ledger.evidenceRelations.filter(item => item.claimVersionId === claim.claimVersionId && item.reviewStatus !== 'human-rejected').map(item => item.evidenceId))
        return { sectionId: `section:${index + 1}`, heading: `结论 ${index + 1}`, markdown: claim.statement,
          claimUses: [{ claimUseId: `${id('claim-use')}:${index}`, claimVersionId: claim.claimVersionId, useKind: selected.useKind,
            span: { start: 0, end: [...claim.statement].length, unit: 'unicode-scalar' as const }, citationEvidenceIds: citations }] }
      })
      const manifestBase = { schemaVersion: 1 as const, artifactManifestId: id('manifest'), artifactId: id('artifact'), version: 1, title: command.title, personalizationUseIds: [] }
      result = execute({ ...base, requestType: 'm4-artifact-draft', idempotencyKey: key, expectedPreviousArtifactManifestId: null,
        manifest: command.artifactKind === 'brief' ? { ...manifestBase, kind: 'brief', content: { kind: 'brief', sections } }
          : { ...manifestBase, kind: 'matrix', content: { kind: 'matrix', rows: sections.map((section, index) => ({ rowId: `row:${index + 1}`, label: section.heading })),
            columns: [{ columnId: 'column:finding', label: '有证据链的结论' }], cells: sections.map((section, index) => ({ cellId: `cell:${index + 1}`, rowId: `row:${index + 1}`, columnId: 'column:finding', markdown: section.markdown, claimUses: section.claimUses })) } } })
    } else if (command.action === 'review-attest') {
      const artifact = this.artifact(binding, scopeId, command.artifactManifestId), ledger = this.ledger(binding, scopeId), claimVersionIds = unique(uses(artifact).map(item => item.claimVersionId))
      const evidenceIds = unique(ledger.evidenceRelations.filter(item => claimVersionIds.includes(item.claimVersionId) && item.reviewStatus !== 'human-rejected').map(item => item.evidenceId))
      result = execute({ ...base, requestType: 'm4-conflict-search-assure', idempotencyKey: key, claimVersionIds, evidenceIds })
    } else if (command.action === 'review-run') result = execute({ ...base, requestType: 'm4-review-run', idempotencyKey: key,
      artifactManifestId: command.artifactManifestId, reviewResultId: id('review'), ruleset: M4_PUBLISH_RULESET, signoffRequirement: 'required' })
    else if (command.action === 'review-decide') result = execute({ ...base, requestType: 'm4-human-decision', idempotencyKey: key,
      reviewResultId: command.reviewResultId, reviewDecisionId: id('signoff'), decision: command.decision, ...(command.rationale === undefined ? {} : { rationale: command.rationale }) })
    else {
      const saved = this.domain.getM4WorkspaceSnapshot(binding.workspaceId, base.investigationId), latest = saved.decisions.filter(item => item.reviewResultId === command.reviewResultId).at(-1)
      const published = saved.artifacts.find(item => item.artifactManifestId === command.artifactManifestId)?.publication
      const receiptOnly = published?.reviewResultId === command.reviewResultId && published.humanReviewDecisionId === command.humanReviewDecisionId
      // Product policy is stricter than legacy: a later rejection cannot be bypassed with an older approving ID.
      // An existing publication may reconcile its exact original receipt; a new key still fails the store's draft CAS.
      if (!receiptOnly && (!latest || latest.reviewDecisionId !== command.humanReviewDecisionId || latest.decision !== 'approved' || latest.decidedBy.actorId !== binding.ownerActorId)) return deny('Publication requires the latest authorized approving sign-off')
      result = execute({ ...base, requestType: 'm4-artifact-publish', idempotencyKey: key, artifactManifestId: command.artifactManifestId,
        expectedStatus: 'draft', reviewResultId: command.reviewResultId, humanReviewDecisionId: command.humanReviewDecisionId })
    }
    ctx.assertCurrent()
    return this.valid({ schemaVersion: 1, kind: 'review-result', conversationId, idempotencyKey: command.idempotencyKey, requestHash: enrichmentHash(command), result })
  }
  async focus(conversationId: string, scopeVersionId: string, evidenceId: string, authorize: () => void, signal: AbortSignal): Promise<ProductReviewFocus> {
    const binding = this.binding(conversationId), evidence = this.evidence(binding, scopeVersionId, evidenceId), seal = enrichmentHash(evidence)
    const result = await this.answers.focusLocator(conversationId, evidence.locator, authorize, signal)
    authorize(); signal.throwIfAborted(); this.assertBinding(binding)
    if (enrichmentHash(this.evidence(binding, scopeVersionId, evidenceId)) !== seal) throw new DocumentAccessError('stale', 'Review evidence changed during original resolution')
    return this.valid({ schemaVersion: 1, kind: 'review-focus', conversationId, scopeVersionId, evidenceId, ...result })
  }
  close(): void { this.closed = true }
  private valid<T extends ProductReviewValue>(value: T): T {
    parseContract('product-review', value)
    if (productReviewIssues(value).length || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new DocumentAccessError('invalid-output', 'Review result exceeds its validated display boundary')
    return value
  }
}
