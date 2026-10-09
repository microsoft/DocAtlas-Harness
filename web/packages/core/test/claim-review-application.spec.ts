import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { M4_PUBLISH_RULESET, type M4ArtifactDraftRequest, type M4ClaimRecordRequest, type M4RpcRequest, type SelectionActionRequest,
  type SelectionActionResult, type SelectionContext, type SourceScopeVersion } from '@docatlas/contracts'
import { SourceScopeStore } from '../src/storage/source-scope-store.js'
import { ClaimReviewApplication, type AuthorizedClaimEvidence, type ClaimReviewContext, type ClaimReviewScope } from '../src/research/claim-review-application.js'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/selection.json', import.meta.url), 'utf8')) as { context: SelectionContext, actionRequest: SelectionActionRequest, actionResult: SelectionActionResult }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'docatlas-core-claim-review-')), store = await SourceScopeStore.open(root)
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const first = structuredClone(fixture), second = JSON.parse(JSON.stringify(fixture).replaceAll('northstar', 'amendment')
    .replaceAll('USD 15.2 million', 'USD 14.0 million').replaceAll(hash('USD 15.2 million'), hash('USD 14.0 million')).replaceAll('a'.repeat(64), 'b'.repeat(64))) as typeof fixture
  second.context.workspaceId = first.context.workspaceId; second.context.investigationId = first.context.investigationId; second.context.sessionId = first.context.sessionId; second.context.scopeVersionId = first.context.scopeVersionId
  second.actionRequest.sessionId = first.context.sessionId; second.actionResult.sessionId = first.context.sessionId
  second.actionResult.record.workspaceId = first.context.workspaceId; second.actionResult.record.investigationId = first.context.investigationId
  const sources = [first, second].map(item => { const source = item.context.selections[0]!; return { documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId, representationContentHash: source.representationContentHash } })
  const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: first.context.scopeVersionId, workspaceId: first.context.workspaceId, investigationId: first.context.investigationId, version: 1,
    included: sources.map(source => ({ documentId: source.documentId, revisionId: source.revisionId, role: 'primary' })), excluded: [], locked: true,
    createdBy: { kind: 'user', actorId: 'user:reviewer' }, createdAt: '2026-08-30T15:59:00.000Z' }
  store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: first.context.sessionId, idempotencyKey: 'scope:initial', scope, sources })
  for (const item of [first, second]) store.recordSelectionAction(scope.workspaceId, item.actionRequest, item.context, item.actionResult)
  const scopes = new Map<string, ClaimReviewScope>([[scope.scopeVersionId, { scope, sources }]]), blockedScopes = new Set<string>(), blockedEvidence = new Set<string>()
  let active = scope.scopeVersionId, tick = 0, transform = (value: AuthorizedClaimEvidence) => value
  const app = new ClaimReviewApplication(store, () => new Date(Date.parse('2026-08-31T10:00:00.000Z') + tick++ * 1000).toISOString())
  const context = (actorId = 'user:reviewer'): ClaimReviewContext => {
    const frame = scopes.get(active)!
    return { ...frame, conversationId: first.context.sessionId, workspaceId: scope.workspaceId, investigationId: scope.investigationId, actor: { kind: 'user', actorId }, signoffRequirement: 'required',
      assertCurrent() { if (active !== frame.scope.scopeVersionId) throw new Error('Current frame changed') }, authorize() {},
      authorizeHistoricalScope(id) { if (blockedScopes.has(id) || !scopes.has(id)) throw new Error('Historical scope denied'); return scopes.get(id)! },
      getAuthorizedEvidence(id, scopeVersionId) {
        if (blockedEvidence.has(id)) return undefined
        const saved = store.getCanonicalEvidence(scope.workspaceId, scope.investigationId, scopeVersionId, id)
        return saved ? transform(saved) : undefined
      } }
  }
  const base = () => ({ schemaVersion: 1 as const, sessionId: first.context.sessionId, workspaceId: scope.workspaceId, investigationId: scope.investigationId, scopeVersionId: active })
  const evidenceIds = [first.actionResult.evidence[0]!.evidenceId, second.actionResult.evidence[0]!.evidenceId]
  function claim(): M4ClaimRecordRequest {
    return { ...base(), requestType: 'm4-claim-record', idempotencyKey: 'claim:record:one', expectedCurrentClaimVersionId: null,
      claim: { schemaVersion: 1, claimVersionId: 'claim:revenue:v1', claimChainId: 'claim-chain:revenue', version: 1, statement: 'The source materials conflict on reported revenue.', basis: 'document-supported', scope: {}, epistemicStatus: 'contested', reviewStatus: 'accepted' },
      provenance: { schemaVersion: 1, derivationActivityId: 'derivation:revenue:v1', operation: 'verify', inputEvidenceIds: evidenceIds, inputClaimVersionIds: [] },
      evidenceRelations: evidenceIds.map((id, index) => ({ schemaVersion: 1, evidenceRelationId: `relation:revenue:${index}:v1`, evidenceId: id, kind: index ? 'refutes' : 'supports', coverage: 'full' })) }
  }
  function artifact(kind: 'brief' | 'matrix', claimId = 'claim:revenue:v1'): M4ArtifactDraftRequest {
    const markdown = 'Both reported revenue figures remain in conflict.', uses = [{ claimUseId: `use:${kind}`, claimVersionId: claimId, useKind: 'conflict-disclosure' as const,
      span: { start: 0, end: [...markdown].length, unit: 'unicode-scalar' as const }, citationEvidenceIds: evidenceIds }]
    const shared = { schemaVersion: 1 as const, artifactManifestId: `manifest:${kind}:v1`, artifactId: `artifact:${kind}`, version: 1, title: 'Evidence-grounded revenue comparison', personalizationUseIds: [] }
    return { ...base(), requestType: 'm4-artifact-draft', idempotencyKey: `artifact:draft:${kind}`, expectedPreviousArtifactManifestId: null,
      manifest: kind === 'brief' ? { ...shared, kind, content: { kind, sections: [{ sectionId: 'section:revenue', heading: 'Revenue', markdown, claimUses: uses }] } }
        : { ...shared, kind, content: { kind, rows: [{ rowId: 'row:revenue', label: 'Reported revenue', source: { documentId: sources[0]!.documentId, revisionId: sources[0]!.revisionId } }],
          columns: [{ columnId: 'column:finding', label: 'Finding' }], cells: [{ cellId: 'cell:revenue', rowId: 'row:revenue', columnId: 'column:finding', markdown, claimUses: uses }] } } }
  }
  return { app, store, root, scope, sources, evidenceIds, claim, artifact, base, context, blockedScopes, blockedEvidence,
    transform(value: typeof transform) { transform = value },
    advanceScope() { const next = { ...scope, scopeVersionId: 'scope:research:next', previousScopeVersionId: scope.scopeVersionId, version: 2 }; store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: first.context.sessionId,
      idempotencyKey: 'scope:next', expectedScopeVersionId: scope.scopeVersionId, scope: next, sources }); scopes.set(next.scopeVersionId, { scope: next, sources }); active = next.scopeVersionId } }
}

type Fixture = Awaited<ReturnType<typeof setup>>
function atomicClaim(f: Fixture, source: 0 | 1, reviewStatus: M4ClaimRecordRequest['claim']['reviewStatus'] = 'accepted'): M4ClaimRecordRequest {
  const request = f.claim(), name = `source-${source}`, evidenceId = f.evidenceIds[source]!
  return { ...request, idempotencyKey: `claim:${name}:v1`,
    claim: { ...request.claim, claimVersionId: `claim:${name}:v1`, claimChainId: `chain:${name}`, statement: `Source ${source} reports USD ${source ? '14.0' : '15.2'} million.`,
      epistemicStatus: 'supported', reviewStatus, proposition: { subject: `source:${source}`, predicate: 'reported-revenue', numericValue: source ? 14 : 15.2, unit: 'USD million' } },
    provenance: { ...request.provenance, derivationActivityId: `derivation:${name}:v1`, operation: 'extract', inputEvidenceIds: [evidenceId] },
    evidenceRelations: [{ schemaVersion: 1, evidenceRelationId: `relation:${name}:v1`, evidenceId, kind: 'supports', coverage: 'full' }] }
}
function derivedClaim(f: Fixture, operation: 'calculate' | 'compare'): M4ClaimRecordRequest {
  const request = f.claim()
  return { ...request, idempotencyKey: `claim:${operation}:v1`, claim: { ...request.claim, claimVersionId: `claim:${operation}:v1`, claimChainId: `chain:${operation}`,
    statement: operation === 'calculate' ? 'The reported revenue difference is USD 1.2 million.' : 'Source 0 reports higher revenue than source 1.',
    basis: 'derived-from-claims', epistemicStatus: 'supported', proposition: { numericValue: 1.2, unit: 'USD million' } },
    provenance: { ...request.provenance, derivationActivityId: `derivation:${operation}:v1`, operation,
      inputClaimVersionIds: ['claim:source-0:v1', 'claim:source-1:v1'], ...(operation === 'calculate' ? { expression: '15.2 - 14.0', rounding: { mode: 'half-even', decimalPlaces: 1 } as const } : {}) },
    evidenceRelations: f.evidenceIds.map((evidenceId, index) => ({ schemaVersion: 1, evidenceRelationId: `relation:${operation}:${index}`, evidenceId, kind: 'derived-input', coverage: 'full' })) }
}
function assertionArtifact(f: Fixture, claim: M4ClaimRecordRequest, kind: 'brief' | 'matrix' = 'brief'): M4ArtifactDraftRequest {
  const request = f.artifact(kind, claim.claim.claimVersionId), units = request.manifest.content.kind === 'brief' ? request.manifest.content.sections : request.manifest.content.cells
  for (const unit of units) { unit.markdown = claim.claim.statement; unit.claimUses = [{ claimUseId: `use:${kind}`, claimVersionId: claim.claim.claimVersionId,
    useKind: 'assertion', span: { start: 0, end: [...unit.markdown].length, unit: 'unicode-scalar' }, citationEvidenceIds: claim.evidenceRelations.map(relation => relation.evidenceId) }] }
  return request
}
function reviewDraft(f: Fixture, draft: M4ArtifactDraftRequest, suffix = 'ready'): M4RpcRequest {
  return { ...f.base(), requestType: 'm4-review-run', idempotencyKey: `review:${draft.manifest.kind}:${suffix}`, artifactManifestId: draft.manifest.artifactManifestId,
    reviewResultId: `review:${draft.manifest.kind}:${suffix}`, ruleset: M4_PUBLISH_RULESET, signoffRequirement: 'required' }
}

describe('Core trusted Claim/Review application over the real SourceScopeStore', () => {
  it('binds optional product-command hashes before M4 projection while preserving legacy replay', async () => {
    const f = await setup(), request = f.claim(), context = { ...f.context(), commandHash: 'a'.repeat(64) }
    expect(f.app.handle(request, context)).toMatchObject({ status: 'created' })
    expect(f.app.handle(request, context)).toMatchObject({ status: 'replayed' })
    expect(() => f.app.handle(request, { ...context, commandHash: 'b'.repeat(64) })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.app.handle(request, f.context())).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const legacy = atomicClaim(f, 0)
    expect(f.app.handle(legacy, f.context())).toMatchObject({ status: 'created' })
    expect(f.app.handle(legacy, f.context())).toMatchObject({ status: 'replayed' })
    for (const commandHash of ['', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64)]) {
      expect(() => f.app.handle(request, { ...context, commandHash })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    }
    const changing = { ...f.context(), commandHash: 'c'.repeat(64), authorize: () => { changing.commandHash = 'd'.repeat(64) } }
    expect(() => f.app.handle(atomicClaim(f, 1), changing)).toThrowError(expect.objectContaining({ code: 'stale' }))
    expect(f.store.getM4ClaimLedger(f.scope.workspaceId, f.scope.investigationId).claims).toHaveLength(2)
  })

  it.each(['calculate', 'compare'] as const)('records human atomic inputs and a %s Claim, requiring exact visible citations, deterministic gates and sign-off for a frozen artifact', async operation => {
    const f = await setup(), ctx = f.context(), inputs = [atomicClaim(f, 0), atomicClaim(f, 1)], derived = derivedClaim(f, operation)
    for (const input of inputs) f.app.handle(input, ctx)
    if (operation === 'calculate') {
      const missing = structuredClone(derived); delete missing.provenance.rounding
      expect(() => f.app.handle(missing, ctx)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    }
    expect(f.app.handle(derived, ctx)).toMatchObject({ claim: { basis: 'derived-from-claims', createdBy: ctx.actor } })
    const draft = assertionArtifact(f, derived, operation === 'calculate' ? 'brief' : 'matrix'), original = structuredClone(draft.manifest.content)
    expect(f.app.handle(draft, ctx)).toMatchObject({ manifest: { content: original } })
    const changed = structuredClone(draft), units = changed.manifest.content.kind === 'brief' ? changed.manifest.content.sections : changed.manifest.content.cells
    units[0]!.markdown = 'A different sentence cannot overwrite the frozen artifact.'
    expect(() => f.app.handle(changed, ctx)).toThrow()
    f.app.handle({ ...f.base(), requestType: 'm4-conflict-search-assure', idempotencyKey: 'assure:derived', claimVersionIds: [derived.claim.claimVersionId], evidenceIds: [...f.evidenceIds].sort() }, ctx)
    const request = reviewDraft(f, draft), checked = f.app.handle(request, ctx)
    expect(checked).toMatchObject({ review: { decision: 'needs-human', issues: [], checkedObjectIds: expect.arrayContaining(inputs.map(input => input.claim.claimVersionId)) } })
    if (request.requestType !== 'm4-review-run') throw new Error('Expected Review request')
    const rejected = { ...f.base(), requestType: 'm4-human-decision' as const, idempotencyKey: 'human:rejected', reviewDecisionId: 'human:rejected', reviewResultId: request.reviewResultId, decision: 'rejected' as const }
    expect(f.app.handle(rejected, ctx)).toMatchObject({ reviewDecision: { decision: 'rejected' } })
    const publish = { ...f.base(), requestType: 'm4-artifact-publish' as const, idempotencyKey: 'publish:derived', artifactManifestId: draft.manifest.artifactManifestId,
      expectedStatus: 'draft' as const, reviewResultId: request.reviewResultId, humanReviewDecisionId: rejected.reviewDecisionId }
    expect(() => f.app.handle(publish, ctx)).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))
    f.app.handle({ ...rejected, idempotencyKey: 'human:approved', reviewDecisionId: 'human:approved', decision: 'approved' }, ctx)
    const result = f.app.handle({ ...publish, humanReviewDecisionId: 'human:approved' }, ctx)
    expect(result).toMatchObject({ manifest: { status: 'published', content: original } })
    expect(f.app.handle({ ...f.base(), requestType: 'm4-artifact-get', artifactManifestId: draft.manifest.artifactManifestId }, ctx)).toMatchObject({ manifest: { content: original } })
    const ledger = f.store.getM4ClaimLedger(f.scope.workspaceId, f.scope.investigationId)
    expect(ledger.derivations.find(activity => activity.operation === operation)).toMatchObject({ inputClaimVersionIds: inputs.map(input => input.claim.claimVersionId), actor: ctx.actor })
  })

  it.each(['rejected', 'unreviewed', 'needs-changes'] as const)('does not let an accepted derived Claim launder %s inputs through deterministic Review', async reviewStatus => {
    const f = await setup(), ctx = f.context(), rejected = atomicClaim(f, 0, reviewStatus), valid = atomicClaim(f, 1), derived = derivedClaim(f, 'calculate')
    for (const claim of [rejected, valid, derived]) f.app.handle(claim, ctx)
    const draft = assertionArtifact(f, derived); f.app.handle(draft, ctx)
    f.app.handle({ ...f.base(), requestType: 'm4-conflict-search-assure', idempotencyKey: 'assure:invalid-input', claimVersionIds: [derived.claim.claimVersionId], evidenceIds: [...f.evidenceIds].sort() }, ctx)
    const review = reviewDraft(f, draft), reviewed = f.app.handle(review, ctx)
    expect(reviewed).toMatchObject({ review: { decision: 'fail', issues: expect.arrayContaining([expect.objectContaining({ code: 'derived-claim-input-invalid' })]) } })
    if (review.requestType !== 'm4-review-run') throw new Error('Expected Review request')
    const decision = { ...f.base(), requestType: 'm4-human-decision' as const, idempotencyKey: 'human:invalid-derived', reviewDecisionId: 'human:invalid-derived', reviewResultId: review.reviewResultId, decision: 'approved' as const }
    expect(() => f.app.handle(decision, ctx)).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))
    expect(f.app.handle({ ...decision, decision: 'rejected' }, ctx)).toMatchObject({ reviewDecision: { decision: 'rejected' } })
    expect(() => f.app.handle({ ...f.base(), requestType: 'm4-artifact-publish', idempotencyKey: 'publish:invalid-derived', artifactManifestId: draft.manifest.artifactManifestId,
      expectedStatus: 'draft', reviewResultId: review.reviewResultId, humanReviewDecisionId: decision.reviewDecisionId }, ctx)).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))
  })

  it('requires a fresh derived Claim after an input version changes between Review and publication', async () => {
    const f = await setup(), ctx = f.context(), first = atomicClaim(f, 0), second = atomicClaim(f, 1), derived = derivedClaim(f, 'calculate')
    for (const claim of [first, second, derived]) f.app.handle(claim, ctx)
    const draft = assertionArtifact(f, derived); f.app.handle(draft, ctx)
    f.app.handle({ ...f.base(), requestType: 'm4-conflict-search-assure', idempotencyKey: 'assure:before-input-change', claimVersionIds: [derived.claim.claimVersionId], evidenceIds: [...f.evidenceIds].sort() }, ctx)
    const review = reviewDraft(f, draft)
    expect(f.app.handle(review, ctx)).toMatchObject({ review: { decision: 'needs-human' } })
    if (review.requestType !== 'm4-review-run') throw new Error('Expected Review request')
    f.app.handle({ ...f.base(), requestType: 'm4-human-decision', idempotencyKey: 'human:before-input-change', reviewDecisionId: 'human:before-input-change', reviewResultId: review.reviewResultId, decision: 'approved' }, ctx)
    const next = structuredClone(first); next.idempotencyKey = 'claim:input:next'; next.expectedCurrentClaimVersionId = first.claim.claimVersionId
    Object.assign(next.claim, { claimVersionId: 'claim:source-0:v2', version: 2, previousClaimVersionId: first.claim.claimVersionId })
    Object.assign(next.provenance, { derivationActivityId: 'derivation:source-0:v2', operation: 'human-edit', inputClaimVersionIds: [first.claim.claimVersionId] })
    next.evidenceRelations[0]!.evidenceRelationId = 'relation:source-0:v2'
    f.app.handle(next, ctx)
    expect(() => f.app.handle({ ...f.base(), requestType: 'm4-artifact-publish', idempotencyKey: 'publish:after-input-change', artifactManifestId: draft.manifest.artifactManifestId,
      expectedStatus: 'draft', reviewResultId: review.reviewResultId, humanReviewDecisionId: 'human:before-input-change' }, ctx)).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))
    expect(f.store.getM4ArtifactManifest(f.scope.workspaceId, draft.manifest.artifactManifestId).status).toBe('draft')
    expect(f.app.handle(reviewDraft(f, draft, 'after-input-change'), ctx)).toMatchObject({ review: { decision: 'fail', issues: expect.arrayContaining([expect.objectContaining({ code: 'derived-claim-input-invalid' })]) } })
    expect(f.app.handle({ ...f.base(), requestType: 'm4-review-get', reviewResultId: review.reviewResultId }, ctx)).toMatchObject({ review: { decision: 'needs-human' } }) // Old Review is a frozen record, not current permission to publish.
  })

  it('authorizes successors consumed by deterministic Review before revealing their Claim or Evidence identity', async () => {
    const f = await setup(), ctx = f.context(), first = atomicClaim(f, 0)
    f.app.handle(first, ctx); const draft = assertionArtifact(f, first); f.app.handle(draft, ctx)
    const next = atomicClaim(f, 1); next.idempotencyKey = 'claim:successor'; next.expectedCurrentClaimVersionId = first.claim.claimVersionId
    Object.assign(next.claim, { claimVersionId: 'claim:source-0:v2', claimChainId: first.claim.claimChainId, version: 2, previousClaimVersionId: first.claim.claimVersionId })
    f.app.handle(next, ctx)
    f.blockedEvidence.add(f.evidenceIds[1]!)
    expect(() => f.app.handle(reviewDraft(f, draft), ctx)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    f.blockedEvidence.clear()
    const request = reviewDraft(f, draft), reviewed = f.app.handle(request, ctx)
    expect(reviewed).toMatchObject({ review: { checkedObjectIds: expect.arrayContaining([next.claim.claimVersionId, f.evidenceIds[1]]) } })
    if (request.requestType !== 'm4-review-run') throw new Error('Expected Review request')
    f.blockedEvidence.add(f.evidenceIds[1]!)
    expect(() => f.app.handle({ ...f.base(), requestType: 'm4-review-get', reviewResultId: request.reviewResultId }, ctx)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    // Frozen Artifact reading needs its own original sources, not unrelated successor Evidence.
    expect(f.app.handle({ ...f.base(), requestType: 'm4-artifact-get', artifactManifestId: draft.manifest.artifactManifestId }, ctx)).toMatchObject({ manifest: { content: draft.manifest.content } })
  })

  it('keeps canonical support/refutation atomic and runs Brief and Matrix through failure, assurance, human sign-off and idempotent publication', async () => {
    const f = await setup(), request = f.claim(), original = structuredClone(request), ctx = f.context()
    expect(f.app.handle(request, ctx)).toMatchObject({ resultType: 'm4-claim-record', status: 'created', claim: { createdBy: ctx.actor, epistemicStatus: 'contested' } })
    expect(f.app.handle(request, ctx)).toMatchObject({ status: 'replayed' }); expect(request).toEqual(original)
    const ledger = f.app.handle({ ...f.base(), requestType: 'm4-claim-ledger-get' }, ctx)
    expect(ledger).toMatchObject({ ledger: { claims: [{ claimVersionId: request.claim.claimVersionId }], evidenceRelations: [{ reviewStatus: 'human-confirmed' }, { reviewStatus: 'human-confirmed' }], derivations: [{ actor: ctx.actor }] } })
    if (ledger.resultType === 'm4-claim-ledger') expect(ledger.ledger.derivations[0]).not.toHaveProperty('dsh')
    for (const kind of ['brief', 'matrix'] as const) {
      const draft = f.artifact(kind); f.app.handle(draft, ctx)
      const review = { ...f.base(), requestType: 'm4-review-run' as const, idempotencyKey: `review:${kind}:initial`, artifactManifestId: draft.manifest.artifactManifestId,
        reviewResultId: `review:${kind}:initial`, ruleset: M4_PUBLISH_RULESET, signoffRequirement: 'required' as const }
      if (kind === 'brief') {
        expect(f.app.handle(review, ctx)).toMatchObject({ review: { decision: 'fail', issues: expect.arrayContaining([expect.objectContaining({ code: 'conflict-search-incomplete' })]) } })
        expect(() => f.app.handle({ ...f.base(), requestType: 'm4-human-decision', idempotencyKey: 'human:cannot-override', reviewDecisionId: 'human:cannot-override', reviewResultId: review.reviewResultId, decision: 'approved' }, ctx)).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))
        f.app.handle({ ...f.base(), requestType: 'm4-conflict-search-assure', idempotencyKey: 'assurance:complete', claimVersionIds: [request.claim.claimVersionId], evidenceIds: [...f.evidenceIds].sort() }, ctx)
      }
      const ready = { ...review, idempotencyKey: `review:${kind}:ready`, reviewResultId: `review:${kind}:ready` }
      const checked = f.app.handle(ready, ctx)
      expect(checked).toMatchObject({ review: { decision: 'needs-human', gates: [
        { gateId: 'G0-integrity', status: 'pass' }, { gateId: 'G1-grounding', status: 'pass' }, { gateId: 'G2-scope', status: 'pass' }, { gateId: 'G3-conflict', status: 'pass' }, { gateId: 'G4-publication', status: 'pass' },
      ] } })
      const publication = { ...f.base(), requestType: 'm4-artifact-publish' as const, idempotencyKey: `publish:${kind}`, artifactManifestId: draft.manifest.artifactManifestId, expectedStatus: 'draft' as const, reviewResultId: ready.reviewResultId }
      expect(() => f.app.handle(publication, ctx)).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))
      f.app.handle({ ...f.base(), requestType: 'm4-human-decision', idempotencyKey: `decision:${kind}`, reviewDecisionId: `decision:${kind}`, reviewResultId: ready.reviewResultId, decision: 'approved', rationale: 'Both source figures are visible; the conflict is not hidden.' }, ctx)
      const signed = { ...publication, humanReviewDecisionId: `decision:${kind}` }
      expect(f.app.handle(signed, ctx)).toMatchObject({ status: 'created', manifest: { status: 'published', publication: { publishedBy: ctx.actor, humanReviewDecisionId: `decision:${kind}` } } })
      expect(f.app.handle(signed, ctx)).toMatchObject({ status: 'replayed' })
    }
  })

  it('preserves Claim CAS, prior versions and owner-bound replay without accepting forged model/human authority', async () => {
    const f = await setup(), first = f.claim(); f.app.handle(first, f.context())
    const second = structuredClone(first)
    second.idempotencyKey = 'claim:record:v2'; second.expectedCurrentClaimVersionId = first.claim.claimVersionId
    Object.assign(second.claim, { claimVersionId: 'claim:revenue:v2', version: 2, previousClaimVersionId: first.claim.claimVersionId })
    Object.assign(second.provenance, { derivationActivityId: 'derivation:revenue:v2', operation: 'human-edit', inputClaimVersionIds: [first.claim.claimVersionId] })
    second.evidenceRelations.forEach((relation, index) => { relation.evidenceRelationId = `relation:revenue:${index}:v2` })
    expect(f.app.handle(second, f.context())).toMatchObject({ status: 'created' })
    const race = structuredClone(second); race.idempotencyKey = 'claim:record:race'; race.claim.claimVersionId = 'claim:revenue:race'; race.provenance.derivationActivityId = 'derivation:race'
    race.evidenceRelations.forEach((relation, index) => { relation.evidenceRelationId = `relation:race:${index}` })
    expect(() => f.app.handle(race, f.context())).toThrow()
    expect(f.store.getM4ClaimLedger(f.scope.workspaceId, f.scope.investigationId).claims).toMatchObject([{ lifecycleStatus: 'superseded', claimVersionId: first.claim.claimVersionId }, { lifecycleStatus: 'current', claimVersionId: second.claim.claimVersionId }])
    expect(() => f.app.handle(first, f.context('user:other'))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const agent = { ...f.context(), actor: { kind: 'agent', actorId: 'model:agent' } } as unknown as ClaimReviewContext
    expect(() => f.app.handle(first, agent)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.app.handle({ ...first, claim: { ...first.claim, createdBy: f.context().actor } } as M4RpcRequest, f.context())).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
  })

  it('keeps authorized historical ledger scopes readable after a new same-source submission, without relabeling old Evidence for new claims or artifacts', async () => {
    const f = await setup(), first = f.claim(); f.app.handle(first, f.context()); const oldDraft = f.artifact('brief'); f.app.handle(oldDraft, f.context()); f.advanceScope()
    const ledger = f.app.handle({ ...f.base(), requestType: 'm4-claim-ledger-get' }, f.context())
    expect(ledger).toMatchObject({ scopeVersionId: 'scope:research:next', ledger: { claims: [{ scope: { sourceScopeVersionId: f.scope.scopeVersionId } }] } })
    expect(f.app.handle({ ...f.base(), scopeVersionId: f.scope.scopeVersionId, requestType: 'm4-artifact-get', artifactManifestId: oldDraft.manifest.artifactManifestId }, f.context()))
      .toMatchObject({ scopeVersionId: f.scope.scopeVersionId, manifest: { sourceScopeVersionId: f.scope.scopeVersionId } })
    const borrowed = f.claim(); borrowed.idempotencyKey = 'claim:borrowed'; borrowed.claim.claimVersionId = 'claim:borrowed'; borrowed.claim.claimChainId = 'chain:borrowed'
    expect(() => f.app.handle(borrowed, f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.app.handle(f.artifact('brief'), f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    f.blockedScopes.add(f.scope.scopeVersionId)
    expect(() => f.app.handle({ ...f.base(), requestType: 'm4-claim-ledger-get' }, f.context())).toThrow('Historical scope denied')
  })

  it('can Review and publish an explicitly selected authorized historical research frame without rebinding the current native document scope', async () => {
    const f = await setup(), first = f.claim(), oldBase = f.base()
    f.app.handle(first, f.context()); const draft = f.artifact('brief'); f.app.handle(draft, f.context()); f.advanceScope()
    const request = { ...reviewDraft(f, draft), scopeVersionId: f.scope.scopeVersionId }
    expect(() => f.app.handle(request, f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    // The trusted host owns this selected workbench frame and reauthorizes all sources;
    // it is deliberately independent of the latest native submission's source scope.
    const current = f.context(), selected = current.authorizeHistoricalScope(f.scope.scopeVersionId)
    const historical: ClaimReviewContext = { ...current, ...selected,
      assertCurrent() { if (f.blockedScopes.has(selected.scope.scopeVersionId)) throw new Error('Historical workbench frame revoked') } }
    f.app.handle({ ...oldBase, requestType: 'm4-conflict-search-assure', idempotencyKey: 'assure:historical', claimVersionIds: [first.claim.claimVersionId], evidenceIds: [...f.evidenceIds].sort() }, historical)
    expect(f.app.handle(request, historical)).toMatchObject({ scopeVersionId: f.scope.scopeVersionId, review: { decision: 'needs-human' } })
    if (request.requestType !== 'm4-review-run') throw new Error('Expected Review request')
    f.app.handle({ ...oldBase, requestType: 'm4-human-decision', idempotencyKey: 'human:historical', reviewDecisionId: 'human:historical', reviewResultId: request.reviewResultId, decision: 'approved' }, historical)
    expect(f.app.handle({ ...oldBase, requestType: 'm4-artifact-publish', idempotencyKey: 'publish:historical', artifactManifestId: draft.manifest.artifactManifestId,
      expectedStatus: 'draft', reviewResultId: request.reviewResultId, humanReviewDecisionId: 'human:historical' }, historical)).toMatchObject({ manifest: { status: 'published', sourceScopeVersionId: f.scope.scopeVersionId } })
    expect(f.context().scope.scopeVersionId).toBe('scope:research:next')
    f.blockedScopes.add(f.scope.scopeVersionId)
    expect(() => f.app.handle({ ...oldBase, requestType: 'm4-review-get', reviewResultId: request.reviewResultId }, historical)).toThrow('Historical workbench frame revoked')
  })

  it('rejects asynchronous or changing authorization ports before recording a human Claim', async () => {
    const f = await setup(), command = f.claim()
    for (const field of ['authorize', 'assertCurrent'] as const) {
      const context = { ...f.context(), [field]: async () => { throw new Error('Async authorization is unsupported') } }
      expect(() => f.app.handle(command, context)).toThrowError(expect.objectContaining({ code: 'unavailable' }))
    }
    const context = f.context()
    f.transform(value => { context.actor.actorId = 'user:changed'; return value })
    expect(() => f.app.handle(command, context)).toThrowError(expect.objectContaining({ code: 'stale' }))
    expect(f.store.getM4ClaimLedger(f.scope.workspaceId, f.scope.investigationId).claims).toHaveLength(0)
  })

  it('rejects foreign scopes, non-Evidence IDs, source/hash tampering, policy downgrades and a damaged domain journal', async () => {
    const f = await setup(), claim = f.claim()
    expect(() => f.app.handle({ ...claim, workspaceId: 'workspace:foreign' }, f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.app.handle({ ...claim, scopeVersionId: 'scope:foreign' }, f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    for (const id of ['note:prior', 'recall:lead', 'profile:user']) {
      const forged = structuredClone(claim); forged.provenance.inputEvidenceIds[0] = id; forged.evidenceRelations[0]!.evidenceId = id
      expect(() => f.app.handle(forged, f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    }
    f.transform(value => ({ ...value, locator: { ...value.locator, representationContentHash: 'f'.repeat(64) } }))
    expect(() => f.app.handle(claim, f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    f.transform(value => ({ ...value, evidence: { ...value.evidence, content: { ...value.evidence.content, text: 'Tampered source text' } } }))
    expect(() => f.app.handle(claim, f.context())).toThrowError(expect.objectContaining({ code: 'invalid-output' }))
    f.transform(value => value); f.app.handle(claim, f.context()); const draft = f.artifact('brief'); f.app.handle(draft, f.context())
    const review = { ...f.base(), requestType: 'm4-review-run' as const, idempotencyKey: 'review:policy', artifactManifestId: draft.manifest.artifactManifestId,
      reviewResultId: 'review:policy', ruleset: M4_PUBLISH_RULESET, signoffRequirement: 'not-required' as const }
    expect(() => f.app.handle(review, f.context())).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.app.handle({ ...review, signoffRequirement: 'required', ruleset: { ...M4_PUBLISH_RULESET, configHash: 'f'.repeat(64) } }, f.context())).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const database = new DatabaseSync(join(f.root, 'investigations', `${hash(f.scope.workspaceId)}.sqlite3`))
    try { database.exec('DROP TRIGGER investigation_m4_events_no_update'); database.prepare('UPDATE investigation_m4_events SET result_json = ? WHERE sequence = 1').run('{}') } finally { database.close() }
    expect(() => f.app.handle({ ...f.base(), requestType: 'm4-claim-ledger-get' }, f.context())).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })
})
