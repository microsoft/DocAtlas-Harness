import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceScopeStore, type DocumentInvocation, type SelectionResolverPort } from '@docatlas/core'
import { projectCheckpointAnswer } from '@docatlas/runtime-pi'
import type { DocumentLocator, LibraryDocument, ProductPiCheckpoint, ProductPreparedSubmission, ProductReviewCommand, M4RpcResult,
  ReadResult, SourceRepresentation, DocumentRevision, ResolveRequest, ResolveResult, SourceScopeVersion, ScopedSourceIdentity } from '@docatlas/contracts'
import { ProductReviews } from '../src/documents/reviews.js'
import { ProductAnswers } from '../src/documents/answers.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ControlStore } from '../src/storage/control-store.js'

const canonical = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as {
  quoteLocator: DocumentLocator, sourceScope: SourceScopeVersion, documentRevision: DocumentRevision, originalRepresentation: SourceRepresentation, textRepresentation: SourceRepresentation,
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

/** Actual immutable Library/scope, Read receipts, native JSONL projection, Answer publication,
 * control transitions and M4 journals. Only PDF cache resolution is deterministic in this unit:
 * no real PDF parsing, SDK generation, model-quality or HTTP acceptance is claimed here.
 */
async function fixture(publication: 'completed' | 'orphan' | 'pending' = 'completed') {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-reviews-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const domain = await SourceScopeStore.open(join(root, 'domain')); cleanups.push(() => domain.close())
  const control = ControlStore.open(join(root, 'control')); cleanups.push(() => control.close())
  const actor = { actorId: 'actor:product-review', workspaceId: 'workspace:product-review' }
  const binding = control.createConversation(actor, { conversationId: 'conversation:product-review', runtimeSessionId: randomUUID(), investigationId: 'investigation:product-review' })
  const receipts = new AnswerReceipts(join(root, 'answers')); cleanups.push(() => receipts.close())
  const sourceKey = 'source:annual-report', documentId = domain.resolveLibraryImport(actor.workspaceId, sourceKey, canonical.documentRevision.contentHash).documentId
  const locator = { ...structuredClone(canonical.quoteLocator), documentId }, source: ScopedSourceIdentity = {
    documentId, revisionId: locator.revisionId, representationId: locator.representationId, representationContentHash: locator.representationContentHash,
  }
  const document: LibraryDocument = { schemaVersion: 1, workspaceId: actor.workspaceId, documentId, displayName: 'Annual Report.pdf', mediaType: 'application/pdf', sourceRole: 'primary',
    status: 'ready', revisionCount: 1, currentRevision: { ...structuredClone(canonical.documentRevision), documentId, displayName: 'Annual Report.pdf' },
    representations: [canonical.originalRepresentation, canonical.textRepresentation].map(item => ({ ...structuredClone(item), documentId })), activeRepresentationId: source.representationId,
    capabilities: ['text', 'original'], createdAt: canonical.documentRevision.ingestedAt, updatedAt: canonical.textRepresentation.createdAt }
  domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: 'library:annual-report', sourceKey, rootId: 'root:fixture', relativePath: 'Annual Report.pdf', document })
  const alternate = structuredClone(document), alternateHash = 'f'.repeat(64)
  alternate.documentId = domain.resolveLibraryImport(actor.workspaceId, 'source:alternate-report', alternateHash).documentId
  alternate.displayName = 'Other Report.pdf'
  Object.assign(alternate.currentRevision, { documentId: alternate.documentId, revisionId: 'revision:alternate', contentHash: alternateHash, displayName: alternate.displayName })
  alternate.representations = alternate.representations.map(item => ({ ...item, documentId: alternate.documentId, revisionId: 'revision:alternate',
    representationId: item.kind === 'original-bytes' ? 'representation:alternate:pdf' : 'representation:alternate:text',
    contentHash: item.kind === 'original-bytes' ? alternateHash : 'e'.repeat(64), derivedFromRepresentationIds: item.kind === 'original-bytes' ? [] : ['representation:alternate:pdf'] }))
  alternate.activeRepresentationId = 'representation:alternate:text'
  domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: 'library:alternate-report', sourceKey: 'source:alternate-report', rootId: 'root:fixture', relativePath: alternate.displayName, document: alternate })
  const alternateSource = domain.getEligibleLibrarySource(actor.workspaceId, alternate.documentId, alternate.currentRevision.revisionId)!
  const scope: SourceScopeVersion = { ...structuredClone(canonical.sourceScope), scopeVersionId: 'scope:product-review:1', workspaceId: actor.workspaceId, investigationId: binding.investigationId!,
    included: [{ documentId, revisionId: source.revisionId, role: 'primary' }], createdBy: { kind: 'user', actorId: actor.actorId } }
  domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: binding.conversationId, idempotencyKey: 'scope:initial', scope, sources: [source] })
  const accepted = control.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation,
    idempotencyKey: 'submission:read-answer', mode: 'prompt', text: 'What changed in revenue?', sourceRefs: [{ documentId, revisionId: source.revisionId }], selectionContextIds: [] }).receipt
  const lease = control.acquireWriter(actor, binding.conversationId, 'writer:unit-fixture')
  const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: accepted.submissionId, requestHash: accepted.requestHash, bindingGeneration: binding.generation,
    scopeVersionId: scope.scopeVersionId, sourceRefs: [{ documentId, revisionId: source.revisionId }], selectionContextIds: [] }
  let receipt = control.transition(lease, accepted.submissionId, accepted.version, 'preparing')
  receipt = control.transition(lease, receipt.submissionId, receipt.version, 'ready', { prepared })
  receipt = control.transition(lease, receipt.submissionId, receipt.version, 'dispatching')
  receipt = control.transition(lease, receipt.submissionId, receipt.version, 'running')
  const quote = 'Revenue increased by 12%.', nativeCallId = 'call:actual-read-receipt'
  const read: ReadResult = { schemaVersion: 1, resultType: 'read', mode: 'page', source: { documentId, revisionId: source.revisionId, representationId: source.representationId }, textQuality: 'usable',
    items: [{ itemType: 'block', blockId: 'p00017.b00004.text.abc123', physicalPage: 17, kind: 'paragraph', text: quote, locator }],
    pageInfo: { schemaVersion: 1, limit: 20, returned: 1, total: 1, usedChars: quote.length, truncated: false, completeness: 'complete' } }
  const invocation: DocumentInvocation = { submissionId: receipt.submissionId, scope: { scope, sources: [source] },
    assertCurrent: () => { expect(domain.get(binding.conversationId).scope?.scopeVersionId).toBe(scope.scopeVersionId) },
    source: (id, revision) => { if (id !== documentId || revision !== source.revisionId) throw new Error('Source is outside the captured native frame'); return source }, originalHash: () => document.currentRevision.contentHash }
  receipts.recordRead(binding, invocation, nativeCallId, read)
  const timestamp = receipt.updatedAt, nativeText = `[${quote}](#docatlas.v1.support.${locator.locatorId})`
  const entries = [
    { type: 'message', id: '11111111', parentId: null, timestamp, message: { role: 'user', content: 'What changed in revenue?' } },
    { type: 'message', id: '22222222', parentId: '11111111', timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: nativeCallId, name: 'docatlas_read', arguments: { documentId, mode: 'page', physicalPage: 17 } }] } },
    { type: 'message', id: '33333333', parentId: '22222222', timestamp, message: { role: 'toolResult', toolCallId: nativeCallId, toolName: 'docatlas_read', isError: false,
      content: [{ type: 'text', text: JSON.stringify(read) }], details: { schemaVersion: 1, schema: 'docatlas.tool-meta.v1', operation: 'read', scopeVersionId: scope.scopeVersionId,
        documentIds: [documentId], locators: [locator], assetIds: [], uiSummary: 'One verified source item', truncated: false } } },
    { type: 'message', id: '44444444', parentId: '33333333', timestamp, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'Private context is never evidence.' }, { type: 'text', text: nativeText }] } },
  ]
  const bytes = Buffer.from([{ type: 'session', version: 3, id: binding.runtimeSessionId, cwd: '/work' }, ...entries].map(item => JSON.stringify(item)).join('\n') + '\n')
  const file = join(root, 'native-session.jsonl'); writeFileSync(file, bytes)
  const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
    runtimeSessionId: binding.runtimeSessionId, userEntryId: '11111111', leafEntryId: '44444444', transcriptHash: hash(bytes), byteLength: bytes.length, entryCount: entries.length, settledAt: timestamp }
  const exact = (): ResolveResult => ({ schemaVersion: 1, resultType: 'resolve', documentId, revisionId: source.revisionId, representationId: source.representationId,
    resolutionId: 'resolve:deterministic-cache-fixture', locatorId: locator.locatorId, status: 'resolved', checkedAt: timestamp, checkedRepresentationHash: source.representationContentHash,
    exactText: quote, resolvedLocator: structuredClone(locator), candidates: [] })
  const resolution = { calls: 0, closes: 0, async resolve(_request: ResolveRequest, _signal?: AbortSignal): Promise<ResolveResult> { return exact() } }
  const createReader = (): SelectionResolverPort & { close(): Promise<void> } => ({ call: (async (method: string, request: ResolveRequest, signal?: AbortSignal) => {
    expect(method).toBe('resolve'); expect(request.allowCandidates).toBe(false); resolution.calls++; return resolution.resolve(request, signal)
  }) as SelectionResolverPort['call'], async close() { resolution.closes++ } })
  const answers = new ProductAnswers(receipts, domain, control, actor, createReader); cleanups.push(() => answers.close())
  if (publication === 'orphan') {
    const manifest = projectCheckpointAnswer(file, checkpoint, { sessionId: binding.conversationId, turn: 1, scope, sources: [source], reads: receipts.reads(binding, receipt.submissionId, scope.scopeVersionId) })
    if (!manifest) throw new Error('Expected verified native Answer projection')
    domain.recordAnswerManifest(manifest) // Deliberately omit only the host publication pointer.
  } else answers.capture(binding.conversationId, file, checkpoint, prepared)
  expect(answers.get(binding.conversationId, '44444444').status).toBe('unavailable')
  if (publication !== 'pending') { receipt = control.transition(lease, receipt.submissionId, receipt.version, 'completed', { checkpoint }); control.releaseWriter(lease) }
  const manifest = domain.getAnswerManifest(actor.workspaceId, binding.conversationId, '44444444')!
  if (!manifest?.citations[0]?.evidence) throw new Error('Expected canonical Read Evidence, not a selection fixture')
  const evidenceId = manifest.citations[0].evidence.evidenceId
  const reviews = new ProductReviews(domain, control, actor, answers); cleanups.push(() => reviews.close())
  let ordinal = 0
  const command = (fields: Record<string, unknown>, scopeVersionId = scope.scopeVersionId): ProductReviewCommand => ({ schemaVersion: 1, kind: 'review-command',
    expectedGeneration: binding.generation, scopeVersionId, idempotencyKey: `review-command:${++ordinal}`, ...fields }) as ProductReviewCommand
  const send = (input: ProductReviewCommand) => reviews.command(binding.conversationId, input)
  const claim = (extra: Record<string, unknown> = {}) => command({ action: 'claim-save', expectedClaimVersionId: null, statement: quote, basis: 'document-supported', epistemicStatus: 'supported', reviewStatus: 'accepted',
    evidenceRelations: [{ evidenceId, kind: 'supports', coverage: 'full' }], derivation: { operation: 'extract', inputClaimVersionIds: [] }, ...extra })
  const advanceScope = (reason?: 'user' | 'policy') => {
    const previous = domain.get(binding.conversationId).scope!, next: SourceScopeVersion = { ...previous, scopeVersionId: `scope:product-review:${previous.version + 1}`,
      previousScopeVersionId: previous.scopeVersionId, version: previous.version + 1,
      included: reason ? [{ documentId: alternateSource.documentId, revisionId: alternateSource.revisionId, role: 'primary' }] : previous.included,
      excluded: reason ? [{ documentId, revisionId: source.revisionId, reason }] : [] }
    domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: binding.conversationId, idempotencyKey: `scope:advance:${next.version}`, expectedScopeVersionId: previous.scopeVersionId,
      scope: next, sources: reason ? [alternateSource] : [source] })
    return next
  }
  return { root, actor, binding, domain, control, receipts, answers, reviews, scope, source, document, locator, manifest, evidenceId, quote, resolution, exact, file, checkpoint,
    command, send, claim, advanceScope }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function asResult<T extends M4RpcResult['resultType']>(value: ReturnType<Fixture['send']>, kind: T): Extract<M4RpcResult, { resultType: T }> {
  expect(value.result.resultType).toBe(kind)
  if (value.result.resultType !== kind) throw new Error(`Expected ${kind}`)
  return value.result as Extract<M4RpcResult, { resultType: T }>
}
function draft(f: Fixture, claimVersionId: string, kind: 'brief' | 'matrix' = 'brief') {
  return asResult(f.send(f.command({ action: 'artifact-create', artifactKind: kind, title: 'Revenue finding', claims: [{ claimVersionId, useKind: 'assertion' }] })), 'm4-artifact-draft').manifest
}
function ready(f: Fixture) {
  const claim = asResult(f.send(f.claim()), 'm4-claim-record').claim, artifact = draft(f, claim.claimVersionId)
  f.send(f.command({ action: 'review-attest', artifactManifestId: artifact.artifactManifestId, attestation: 'listed-evidence-reviewed' }))
  const review = asResult(f.send(f.command({ action: 'review-run', artifactManifestId: artifact.artifactManifestId })), 'm4-review-run').review
  expect(review.decision).toBe('needs-human')
  const decision = asResult(f.send(f.command({ action: 'review-decide', reviewResultId: review.reviewResultId, decision: 'approved' })), 'm4-human-decision').reviewDecision
  return { claim, artifact, review, decision }
}

describe('product human Review over actual native projection and durable domain/control journals', () => {
  it.each(['brief', 'matrix'] as const)('takes a completed canonical Answer citation through Claim, frozen %s, deterministic failure, explicit assurance, human approval and publication', async kind => {
    const f = await fixture()
    expect(f.answers.get(f.binding.conversationId, f.manifest.messageId).status).toBe('available')
    expect(f.domain.listSelectionActions(f.actor.workspaceId, f.scope.investigationId)).toEqual([])
    expect(f.reviews.workspace(f.binding.conversationId)).toMatchObject({ evidence: [{ evidenceId: f.evidenceId, preview: f.quote, physicalPage: 17 }] })
    const request = f.claim(), claim = asResult(f.send(request), 'm4-claim-record').claim
    expect(asResult(f.send(request), 'm4-claim-record').status).toBe('replayed')
    const artifact = draft(f, claim.claimVersionId, kind), frozen = structuredClone(artifact.content)
    const failure = asResult(f.send(f.command({ action: 'review-run', artifactManifestId: artifact.artifactManifestId })), 'm4-review-run').review
    expect(failure).toMatchObject({ decision: 'fail', issues: expect.arrayContaining([expect.objectContaining({ code: 'conflict-search-incomplete' })]) })
    expect(() => f.send(f.command({ action: 'review-decide', reviewResultId: failure.reviewResultId, decision: 'approved' }))).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))
    f.send(f.command({ action: 'review-attest', artifactManifestId: artifact.artifactManifestId, attestation: 'listed-evidence-reviewed' }))
    const review = asResult(f.send(f.command({ action: 'review-run', artifactManifestId: artifact.artifactManifestId })), 'm4-review-run').review
    expect(review).toMatchObject({ decision: 'needs-human', issues: [], signoffRequirement: 'required' })
    const approval = asResult(f.send(f.command({ action: 'review-decide', reviewResultId: review.reviewResultId, decision: 'approved' })), 'm4-human-decision').reviewDecision
    const publish = f.command({ action: 'artifact-publish', artifactManifestId: artifact.artifactManifestId, reviewResultId: review.reviewResultId, humanReviewDecisionId: approval.reviewDecisionId })
    expect(asResult(f.send(publish), 'm4-artifact-publish').manifest).toMatchObject({ status: 'published', content: frozen })
    expect(asResult(f.send(publish), 'm4-artifact-publish').status).toBe('replayed')
    expect(f.reviews.workspace(f.binding.conversationId)).toMatchObject({ artifacts: [{ status: 'published', content: frozen }], claims: [{ claimVersionId: claim.claimVersionId }] })
    const focus = await f.reviews.focus(f.binding.conversationId, f.scope.scopeVersionId, f.evidenceId, () => {}, new AbortController().signal)
    expect(focus).toMatchObject({ kind: 'review-focus', status: 'resolved', physicalPage: 17, exactText: f.quote, original: { name: 'Annual Report.pdf', documentId: f.source.documentId } })
    expect(focus.locator.selectors).toEqual(f.locator.selectors); expect(f.resolution.calls).toBe(1); expect(f.resolution.closes).toBe(1)
    expect(JSON.stringify(f.reviews.workspace(f.binding.conversationId))).not.toContain('Private context')
  })

  it('uses Claim CAS and the complete original product body for idempotency even when two attestations project to identical M4 inputs', async () => {
    const f = await fixture(), firstRequest = f.claim(), first = asResult(f.send(firstRequest), 'm4-claim-record').claim
    expect(() => f.send({ ...firstRequest, statement: 'Different claim body' } as ProductReviewCommand)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const left = draft(f, first.claimVersionId), right = draft(f, first.claimVersionId, 'matrix')
    const attest = f.command({ action: 'review-attest', artifactManifestId: left.artifactManifestId, attestation: 'listed-evidence-reviewed' })
    expect(asResult(f.send(attest), 'm4-conflict-search-assurance').status).toBe('created')
    expect(asResult(f.send(attest), 'm4-conflict-search-assurance').status).toBe('replayed')
    expect(() => f.send({ ...attest, artifactManifestId: right.artifactManifestId } as ProductReviewCommand)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const revision = f.claim({ expectedClaimVersionId: first.claimVersionId, statement: 'Reported revenue increased by 12%.', derivation: { operation: 'human-edit', inputClaimVersionIds: [first.claimVersionId] } })
    const next = asResult(f.send(revision), 'm4-claim-record').claim
    expect(next).toMatchObject({ previousClaimVersionId: first.claimVersionId, version: 2 })
    expect(asResult(f.send(revision), 'm4-claim-record').status).toBe('replayed')
    expect(() => f.send({ ...revision, idempotencyKey: 'claim:cas-race' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const workspace = f.reviews.workspace(f.binding.conversationId)
    expect(workspace.claims.find(item => item.claimVersionId === first.claimVersionId)?.lifecycleStatus).toBe('superseded')
    expect(workspace.artifacts.find(item => item.artifactManifestId === left.artifactManifestId)?.content).toEqual(left.content)
  })

  it('keeps the explicitly selected old Review scope usable after source selection changes, without relabeling Evidence or changing native admission', async () => {
    const f = await fixture(), next = f.advanceScope('user')
    const current = f.reviews.workspace(f.binding.conversationId, next.scopeVersionId)
    expect(current.evidence).toEqual([])
    expect(() => f.send({ ...f.claim(), scopeVersionId: next.scopeVersionId })).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(f.reviews.workspace(f.binding.conversationId, f.scope.scopeVersionId).evidence).toHaveLength(1)
    const complete = ready(f)
    expect(asResult(f.send(f.command({ action: 'artifact-publish', artifactManifestId: complete.artifact.artifactManifestId, reviewResultId: complete.review.reviewResultId,
      humanReviewDecisionId: complete.decision.reviewDecisionId })), 'm4-artifact-publish').manifest.sourceScopeVersionId).toBe(f.scope.scopeVersionId)
    expect(f.domain.get(f.binding.conversationId).scope?.scopeVersionId).toBe(next.scopeVersionId)
  })

  it.each(['orphan', 'pending'] as const)('does not authorize %s Answer Evidence merely because its canonical manifest or native Read receipt exists', async state => {
    const f = await fixture(state)
    expect(f.domain.getCanonicalEvidence(f.actor.workspaceId, f.scope.investigationId, f.scope.scopeVersionId, f.evidenceId)).toBeDefined()
    expect(f.reviews.workspace(f.binding.conversationId).evidence).toEqual([])
    expect(() => f.send(f.claim())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    await expect(f.reviews.focus(f.binding.conversationId, f.scope.scopeVersionId, f.evidenceId, () => {}, new AbortController().signal)).rejects.toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(f.resolution.calls).toBe(0)
  })

  it('refuses foreign owner/scope, missing Evidence, stale generation and newly policy-excluded source without disclosing saved work', async () => {
    const f = await fixture(), foreign = new ProductReviews(f.domain, f.control, { ...f.actor, actorId: 'actor:foreign' }, f.answers)
    expect(() => foreign.workspace(f.binding.conversationId)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    f.domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: 'conversation:foreign', idempotencyKey: 'scope:foreign',
      scope: { ...f.scope, scopeVersionId: 'scope:foreign', investigationId: 'investigation:foreign' }, sources: [f.source] })
    expect(() => f.reviews.workspace(f.binding.conversationId, 'scope:foreign')).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.send({ ...f.claim(), expectedGeneration: f.binding.generation + 1 })).toThrowError(expect.objectContaining({ code: 'stale' }))
    for (const evidenceId of ['evidence:missing', 'note:prior', 'memory:style']) expect(() => f.send(f.claim({ evidenceRelations: [{ evidenceId, kind: 'supports', coverage: 'full' }] }))).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    f.send(f.claim()); f.advanceScope('policy')
    expect(() => f.reviews.workspace(f.binding.conversationId, f.scope.scopeVersionId)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.send(f.claim())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    await expect(f.reviews.focus(f.binding.conversationId, f.scope.scopeVersionId, f.evidenceId, () => {}, new AbortController().signal)).rejects.toThrow()
    expect(f.resolution.calls).toBe(0)
  })

  it('cannot bypass a later human rejection with an older approving sign-off', async () => {
    const f = await fixture(), complete = ready(f)
    const publish = f.command({ action: 'artifact-publish', artifactManifestId: complete.artifact.artifactManifestId, reviewResultId: complete.review.reviewResultId, humanReviewDecisionId: complete.decision.reviewDecisionId })
    const rejection = asResult(f.send(f.command({ action: 'review-decide', reviewResultId: complete.review.reviewResultId, decision: 'rejected', rationale: 'Recheck the source before release.' })), 'm4-human-decision').reviewDecision
    expect(() => f.send(publish)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(f.domain.getM4ArtifactManifest(f.actor.workspaceId, complete.artifact.artifactManifestId).status).toBe('draft')
    expect(f.reviews.workspace(f.binding.conversationId).decisions.at(-1)?.reviewDecisionId).toBe(rejection.reviewDecisionId)
    const approved = asResult(f.send(f.command({ action: 'review-decide', reviewResultId: complete.review.reviewResultId, decision: 'approved', rationale: 'Original source was rechecked.' })), 'm4-human-decision').reviewDecision
    expect(asResult(f.send({ ...publish, humanReviewDecisionId: approved.reviewDecisionId } as ProductReviewCommand), 'm4-artifact-publish').manifest.status).toBe('published')
  })

  it('reconciles an already completed publication by its original key after a later rejection, without authorizing another publication', async () => {
    const f = await fixture(), complete = ready(f)
    const publish = f.command({ action: 'artifact-publish', artifactManifestId: complete.artifact.artifactManifestId, reviewResultId: complete.review.reviewResultId, humanReviewDecisionId: complete.decision.reviewDecisionId })
    const original = asResult(f.send(publish), 'm4-artifact-publish')
    expect(original.status).toBe('created')
    f.send(f.command({ action: 'review-decide', reviewResultId: complete.review.reviewResultId, decision: 'rejected', rationale: 'Reject further publication; retain the original historical receipt.' }))
    expect(asResult(f.send(publish), 'm4-artifact-publish')).toEqual({ ...original, status: 'replayed' })
    expect(() => f.send({ ...publish, idempotencyKey: 'publish:another-after-rejection' })).toThrow()
    expect(f.reviews.workspace(f.binding.conversationId)).toMatchObject({ artifacts: [{ status: 'published', publication: { humanReviewDecisionId: complete.decision.reviewDecisionId } }] })
  })

  it('rechecks Evidence/source authorization after asynchronous cache resolution and joins the reader before returning', async () => {
    const f = await fixture()
    f.resolution.resolve = async () => { const result = f.exact(); f.advanceScope('policy'); return result }
    await expect(f.reviews.focus(f.binding.conversationId, f.scope.scopeVersionId, f.evidenceId, () => {}, new AbortController().signal)).rejects.toThrow()
    expect(f.resolution.closes).toBe(1)
  })
})
