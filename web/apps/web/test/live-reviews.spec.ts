import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ArtifactManifest, M4ArtifactDraftRequest, M4ArtifactDraftResult, M4ArtifactPublishRequest, M4ArtifactPublishResult, M4ClaimRecordRequest, M4ClaimRecordResult,
  M4ConflictSearchAssureResult, M4HumanDecisionRequest, M4HumanDecisionResult, M4ClaimLedgerResult, M4ReviewRunResult, ProductReviewCommand, ProductReviewResult, ProductReviewWorkspace } from '@docatlas/contracts'
import { ReviewArtifactPreview, ReviewClaimList, ReviewEvidenceList, ReviewGates } from '../src/live/Reviews'
import { acknowledgeReview, artifactClaimUses, artifactReview, claimRevisionDraft, parseReviewPending, publishApproval, readReviewOutbox, reviewIdentity,
  reviewIdentityKey, reviewOwnerKey, reviewReceiptMatches, reviewStorageKey, saveReviewPending, type ReviewOwner, type ReviewPending, type ReviewStorage } from '../src/live/review-state'
import { canonicalHash } from '../src/live/state'
import type { LiveState } from '../src/live/client'

const m4 = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m4/m4-rpc.json', import.meta.url), 'utf8')) as {
  claimRecordRequest: M4ClaimRecordRequest, claimRecordResult: M4ClaimRecordResult, ledgerGetResult: M4ClaimLedgerResult,
  artifactDraftRequest: M4ArtifactDraftRequest, artifactDraftResult: M4ArtifactDraftResult, conflictAssureResult: M4ConflictSearchAssureResult,
  reviewRunResult: M4ReviewRunResult, humanDecisionRequest: M4HumanDecisionRequest, humanDecisionResult: M4HumanDecisionResult,
  publishRequest: M4ArtifactPublishRequest, publishResult: M4ArtifactPublishResult,
}
const artifacts = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m4/artifacts.json', import.meta.url), 'utf8')) as { brief: ArtifactManifest, matrix: ArtifactManifest }
function setup() {
  const legacy = structuredClone(m4.claimRecordRequest), result = structuredClone(m4.claimRecordResult)
  const owner: ReviewOwner = { actorId: result.claim.createdBy.actorId, workspaceId: legacy.workspaceId, conversationId: legacy.sessionId, bindingId: 'binding:review', generation: 1, scopeVersionId: legacy.scopeVersionId }
  const request: ProductReviewCommand = { schemaVersion: 1, kind: 'review-command', expectedGeneration: 1, scopeVersionId: owner.scopeVersionId, idempotencyKey: legacy.idempotencyKey,
    action: 'claim-save', expectedClaimVersionId: null, statement: legacy.claim.statement, basis: legacy.claim.basis, epistemicStatus: legacy.claim.epistemicStatus, reviewStatus: legacy.claim.reviewStatus, claimScope: structuredClone(legacy.claim.scope),
    evidenceRelations: legacy.evidenceRelations.map(value => ({ evidenceId: value.evidenceId, kind: value.kind, coverage: value.coverage, ...(value.rationale ? { rationale: value.rationale } : {}) })),
    derivation: { operation: legacy.provenance.operation, inputClaimVersionIds: legacy.provenance.inputClaimVersionIds } }
  const pending: ReviewPending = { schemaVersion: 1, owner, request }, values = new Map<string, string>(), changes: string[] = []
  const storage: ReviewStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); changes.push(`set:${key}`) }, removeItem: key => { values.delete(key); changes.push(`remove:${key}`) }, key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
  const workspace: ProductReviewWorkspace = { schemaVersion: 1, kind: 'review-workspace', conversationId: owner.conversationId, bindingId: owner.bindingId, generation: owner.generation,
    scope: { schemaVersion: 1, scopeVersionId: owner.scopeVersionId, workspaceId: owner.workspaceId, investigationId: legacy.investigationId, version: 1, included: [{ documentId: 'doc:review', revisionId: 'rev:review:1', role: 'primary' }], excluded: [], locked: true, createdBy: { kind: 'user', actorId: owner.actorId }, createdAt: result.claim.createdAt },
    scopeOptions: [{ scopeVersionId: owner.scopeVersionId, version: 1, sourceCount: 1, current: true }], claims: structuredClone(m4.ledgerGetResult.ledger.claims) as ProductReviewWorkspace['claims'],
    evidenceRelations: structuredClone(m4.ledgerGetResult.ledger.evidenceRelations) as ProductReviewWorkspace['evidenceRelations'], derivations: structuredClone(m4.ledgerGetResult.ledger.derivations) as ProductReviewWorkspace['derivations'],
    evidence: [{ evidenceId: legacy.evidenceRelations[0]!.evidenceId, documentId: 'doc:review', revisionId: 'rev:review:1', physicalPage: 1, sourceName: 'Agreement.pdf', preview: 'Original supported clause.', contentHash: 'a'.repeat(64) }],
    artifacts: [structuredClone(m4.artifactDraftResult.manifest)], reviews: [structuredClone(m4.reviewRunResult.review)], decisions: [structuredClone(m4.humanDecisionResult.reviewDecision)], truncated: false }
  return { owner, pending, values, changes, storage, workspace, result }
}
async function receipt(pending: ReviewPending, result: ProductReviewResult['result']): Promise<ProductReviewResult> {
  return { schemaVersion: 1, kind: 'review-result', conversationId: pending.owner.conversationId, idempotencyKey: pending.request.idempotencyKey, requestHash: await canonicalHash(pending.request), result }
}

describe('scope-bound review outbox', () => {
  it('binds actor/workspace/conversation/generation/scope independently without changing the native source selection', () => {
    const { owner } = setup()
    const state = { phase: 'ready', actor: { actorId: owner.actorId, workspaceId: owner.workspaceId }, selected: owner.conversationId,
      snapshot: { binding: { conversationId: owner.conversationId, ownerActorId: owner.actorId, workspaceId: owner.workspaceId, bindingId: owner.bindingId, generation: owner.generation } } } as LiveState
    const { scopeVersionId: _scope, ...identity } = owner
    expect(reviewIdentity(state)).toEqual(identity)
    expect(reviewIdentity({ ...state, selected: 'conversation:other' })).toBeNull()
    expect(reviewIdentity({ ...state, phase: 'pairing' })).toBeNull()
    for (const key of ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'scopeVersionId'] as const) expect(reviewStorageKey({ ...owner, [key]: 'other:identity' })).not.toBe(reviewStorageKey(owner))
    expect(reviewStorageKey({ ...owner, generation: 2 })).not.toBe(reviewStorageKey(owner))
    expect(reviewOwnerKey(owner)).not.toBe(reviewOwnerKey({ ...owner, scopeVersionId: 'scope:history' }))
    const historicalOwner = { ...owner, scopeVersionId: 'scope:history' }
    expect(reviewIdentityKey(owner)).toBe(reviewIdentityKey(historicalOwner))
  })
  it('restores exact original bodies and keys without mutation, replay, repair, or hidden scope migration', () => {
    const test = setup(); saveReviewPending(test.storage, test.pending)
    const before = [...test.changes], raw = test.values.get(reviewStorageKey(test.owner))!
    expect(parseReviewPending(raw, test.owner)).toEqual(test.pending)
    expect(readReviewOutbox(test.storage, test.owner, test.owner.scopeVersionId)).toMatchObject({ state: 'pending', current: true, value: test.pending })
    expect(readReviewOutbox(test.storage, test.owner, 'scope:history')).toMatchObject({ state: 'pending', current: false, value: test.pending })
    expect(readReviewOutbox(test.storage, { ...test.owner, bindingId: 'binding:new', generation: 2 }, test.owner.scopeVersionId)).toMatchObject({ state: 'pending', current: false })
    expect(test.changes).toEqual(before); expect(test.values.get(reviewStorageKey(test.owner))).toBe(raw)
    expect(() => saveReviewPending(test.storage, { ...test.pending, owner: { ...test.owner, scopeVersionId: 'scope:history' }, request: { ...test.pending.request, scopeVersionId: 'scope:history' } })).toThrow('uncertain')
    expect(readReviewOutbox(test.storage, { ...test.owner, actorId: 'user:other' }, test.owner.scopeVersionId)).toEqual({ state: 'empty' })
  })
  it('rejects forged identities, generation/scope changes, extra envelope fields and malformed input without overwriting them', () => {
    const test = setup()
    for (const mutate of [(value: ReviewPending) => { value.owner.actorId = 'user:other' }, (value: ReviewPending) => { value.request.expectedGeneration++ },
      (value: ReviewPending) => { value.request.scopeVersionId = 'scope:other' }, (value: ReviewPending) => { Reflect.set(value.request, 'actorId', 'user:forged') },
      (value: ReviewPending) => { Reflect.set(value, 'endpoint', '/private') }]) {
      const value = structuredClone(test.pending); mutate(value)
      expect(() => parseReviewPending(JSON.stringify(value), test.owner)).toThrow()
    }
    expect(() => parseReviewPending('x'.repeat(131073), test.owner)).toThrow()
    test.values.set(reviewStorageKey(test.owner), '{bad')
    expect(readReviewOutbox(test.storage, test.owner, test.owner.scopeVersionId)).toEqual({ state: 'invalid', key: reviewStorageKey(test.owner) })
    expect(test.values.get(reviewStorageKey(test.owner))).toBe('{bad'); expect(test.changes).toEqual([])
  })
  it('requires durable local retention before sending and refuses competing uncertain drafts', () => {
    const test = setup()
    expect(() => saveReviewPending({ ...test.storage, setItem() { throw new Error('quota') } }, test.pending)).toThrow('quota')
    expect(() => saveReviewPending({ ...test.storage, setItem() {} }, test.pending)).toThrow('not retained')
    saveReviewPending(test.storage, test.pending)
    expect(() => saveReviewPending(test.storage, test.pending)).toThrow('uncertain')
  })
  it('clears only matching owner, frozen command hash, original key and verified action effects', async () => {
    const test = setup(), answer = await receipt(test.pending, test.result)
    saveReviewPending(test.storage, test.pending)
    for (const invalid of [{ ...answer, conversationId: 'conversation:other' }, { ...answer, idempotencyKey: 'other:key' }, { ...answer, requestHash: 'f'.repeat(64) },
      { ...answer, result: { ...answer.result, scopeVersionId: 'scope:other' } }, { ...answer, result: { ...answer.result, workspaceId: 'workspace:other' } },
      { ...answer, result: { ...test.result, claim: { ...test.result.claim, statement: 'Forged effect' } } }]) {
      expect(await reviewReceiptMatches(test.pending, invalid)).toBe(false)
      expect(await acknowledgeReview(test.storage, test.pending, invalid)).toBe(false)
    }
    expect(test.values.size).toBe(1)
    expect(await acknowledgeReview(test.storage, test.pending, answer)).toBe(true)
    expect(test.values.size).toBe(0)
  })
  it('does not clear a newer local body and accepts an exact replay of the original operation', async () => {
    const test = setup(), answer = await receipt(test.pending, { ...test.result, status: 'replayed' })
    saveReviewPending(test.storage, test.pending)
    const newer = structuredClone(test.pending); newer.request.idempotencyKey = 'newer:key'
    test.values.set(reviewStorageKey(test.owner), JSON.stringify(newer))
    expect(await acknowledgeReview(test.storage, test.pending, answer)).toBe(false)
    expect(JSON.parse(test.values.get(reviewStorageKey(test.owner))!)).toEqual(newer)
    test.values.set(reviewStorageKey(test.owner), JSON.stringify(test.pending))
    expect(await acknowledgeReview(test.storage, test.pending, answer)).toBe(true)
  })
  it('requires a CAS revision receipt to point to the exact prior immutable claim', async () => {
    const test = setup(), prior = test.result.claim.claimVersionId
    if (test.pending.request.action !== 'claim-save') throw new Error('fixture')
    test.pending.request.expectedClaimVersionId = prior
    const result: M4ClaimRecordResult = { ...test.result, claim: { ...test.result.claim, claimVersionId: 'claim:termination:v2', version: 2, previousClaimVersionId: prior } }
    const answer = await receipt(test.pending, result)
    expect(await reviewReceiptMatches(test.pending, answer)).toBe(true)
    expect(await reviewReceiptMatches(test.pending, { ...answer, result: { ...result, claim: { ...result.claim, previousClaimVersionId: 'claim:foreign' } } })).toBe(false)
  })
  it('matches exact Unicode text without silently normalizing a frozen request and rejects dropped advanced scope', async () => {
    const test = setup()
    if (test.pending.request.action !== 'claim-save') throw new Error('fixture')
    test.pending.request.statement = 'Cafe\u0301 statement.'; test.result.claim.statement = test.pending.request.statement
    const answer = await receipt(test.pending, test.result)
    expect(await reviewReceiptMatches(test.pending, answer)).toBe(true)
    expect(await reviewReceiptMatches(test.pending, { ...answer, result: { ...test.result, claim: { ...test.result.claim, statement: test.result.claim.statement.normalize('NFC') } } })).toBe(false)
    expect(await reviewReceiptMatches(test.pending, { ...answer, result: { ...test.result, claim: { ...test.result.claim, scope: { sourceScopeVersionId: test.owner.scopeVersionId } } } })).toBe(false)
  })
})

describe('review receipts, immutable inputs and honest presentation', () => {
  it('matches each high-level artifact/review action only to the corresponding real result and exact targets', async () => {
    const test = setup(), common = { schemaVersion: 1 as const, kind: 'review-command' as const, expectedGeneration: 1, scopeVersionId: test.owner.scopeVersionId, idempotencyKey: 'review:operation' }
    const cases: Array<{ command: ProductReviewCommand, result: ProductReviewResult['result'] }> = [
      { command: { ...common, action: 'artifact-create', artifactKind: m4.artifactDraftResult.manifest.kind, title: m4.artifactDraftResult.manifest.title, claims: artifactClaimUses(m4.artifactDraftResult.manifest).map(use => ({ claimVersionId: use.claimVersionId, useKind: use.useKind })) }, result: m4.artifactDraftResult },
      { command: { ...common, action: 'review-attest', artifactManifestId: m4.artifactDraftResult.manifest.artifactManifestId, attestation: 'listed-evidence-reviewed' }, result: m4.conflictAssureResult },
      { command: { ...common, action: 'review-run', artifactManifestId: m4.reviewRunResult.review.subject.objectIds[0]! }, result: m4.reviewRunResult },
      { command: { ...common, action: 'review-decide', reviewResultId: m4.humanDecisionRequest.reviewResultId, decision: m4.humanDecisionRequest.decision, ...(m4.humanDecisionRequest.rationale ? { rationale: m4.humanDecisionRequest.rationale } : {}) }, result: m4.humanDecisionResult },
      { command: { ...common, action: 'artifact-publish', artifactManifestId: m4.publishRequest.artifactManifestId, reviewResultId: m4.publishRequest.reviewResultId, humanReviewDecisionId: m4.publishRequest.humanReviewDecisionId! }, result: m4.publishResult },
    ]
    for (const item of cases) {
      const pending = { ...test.pending, request: item.command }, answer = await receipt(pending, structuredClone(item.result))
      expect(await reviewReceiptMatches(pending, answer), item.command.action).toBe(true)
      expect(await reviewReceiptMatches(pending, { ...answer, result: test.result }), item.command.action).toBe(false)
    }
  })
  it('preserves the full claim CAS basis, advanced scope/proposition and derivation instead of editing a preview', () => {
    const { workspace } = setup(), claim = workspace.claims[0]!
    claim.proposition = { subject: 'Agreement', modality: 'possible' }
    claim.scope.validTime = { from: '2026-01-01T00:00:00Z' }
    const before = structuredClone(workspace), draft = claimRevisionDraft(workspace, claim)
    expect(draft).toMatchObject({ statement: claim.statement, expectedClaimVersionId: claim.claimVersionId, proposition: claim.proposition,
      claimScope: { jurisdiction: 'New York', section: 'Termination', validTime: claim.scope.validTime }, evidenceRelations: [{ kind: 'supports', coverage: 'full' }] })
    expect(workspace).toEqual(before)
    if (!draft) throw new Error('Missing draft')
    draft.proposition!.subject = 'Changed draft'; expect(claim.proposition.subject).toBe('Agreement')
    workspace.derivations = []; expect(claimRevisionDraft(workspace, claim)).toBeNull()
  })
  it('does not construct a partial revision when evidence is omitted from a bounded workspace', () => {
    const { workspace } = setup(), claim = workspace.claims[0]!
    workspace.evidence = []; workspace.truncated = true
    expect(claimRevisionDraft(workspace, claim)).toBeNull()
  })
  it('uses append order for the latest human sign-off; same-time later rejection blocks an old approval', () => {
    const { workspace } = setup(), artifact = workspace.artifacts[0]!, approved = workspace.decisions[0]!
    expect(publishApproval(workspace, artifact)?.decision.reviewDecisionId).toBe(approved.reviewDecisionId)
    workspace.decisions.push({ ...approved, reviewDecisionId: 'aaa:later:reject', decision: 'rejected', decidedAt: approved.decidedAt })
    expect(publishApproval(workspace, artifact)).toBeNull()
    workspace.decisions.push({ ...approved, reviewDecisionId: '000:latest:approve', decidedAt: approved.decidedAt })
    expect(publishApproval(workspace, artifact)?.decision.reviewDecisionId).toBe('000:latest:approve')
    workspace.reviews[0]!.gates[0].status = 'fail'
    expect(publishApproval(workspace, artifact)).toBeNull()
    expect(publishApproval(workspace, m4.publishResult.manifest)).toBeNull()
  })
  it('selects the last appended review for the exact artifact, never the highest ID or an earlier approving decision', () => {
    const { workspace } = setup(), artifact = workspace.artifacts[0]!, older = workspace.reviews[0]!
    older.reviewResultId = 'review:zzz:older'
    workspace.decisions[0]!.reviewResultId = older.reviewResultId
    const latest = structuredClone(older)
    latest.reviewResultId = 'review:aaa:latest'; latest.decision = 'fail'; latest.gates[0].status = 'fail'
    const unrelated = structuredClone(older)
    unrelated.reviewResultId = 'review:zzz:unrelated'; unrelated.subject.objectIds = ['manifest:unrelated']
    workspace.reviews = [older, latest, unrelated]
    const before = structuredClone(workspace)
    expect(artifactReview(workspace, artifact)).toEqual(latest)
    expect(publishApproval(workspace, artifact)).toBeNull()
    expect(workspace).toEqual(before)
  })
  it('renders escaped original evidence and explicit PDF actions without inventing evidence for an empty scope', () => {
    const { workspace } = setup()
    workspace.evidence[0]!.preview = '<script>not executable</script>'
    const html = renderToStaticMarkup(createElement(ReviewEvidenceList, { evidence: workspace.evidence, selected: [], disabled: false, onSelect() {}, onFocus() {} }))
    expect(html).toContain('核对原始 PDF'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>')
    expect(html).toContain('选择证据')
    expect(renderToStaticMarkup(createElement(ReviewEvidenceList, { evidence: [], disabled: false, onFocus() {} }))).toContain('还没有已保存的证据')
  })
  it('keeps human acceptance separate from factual support and retains historical claim versions', () => {
    const { workspace } = setup()
    const html = renderToStaticMarkup(createElement(ReviewClaimList, { claims: [...workspace.claims, { ...workspace.claims[0]!, claimVersionId: 'claim:old', lifecycleStatus: 'superseded' }], disabled: false, onEdit() {} }))
    expect(html).toContain('人工接受'); expect(html).toContain('已有支持'); expect(html).toContain('历史版本'); expect(html).toContain('复制为新结论草稿')
  })
  it('renders immutable brief/matrix content and original-PDF citation controls, without Markdown or native PDF objects as targets', () => {
    const { workspace } = setup()
    for (const artifact of [artifacts.brief, artifacts.matrix]) {
      const html = renderToStaticMarkup(createElement(ReviewArtifactPreview, { artifact, evidence: workspace.evidence, onFocus() {} }))
      expect(html).toContain(artifact.title); expect(html).toContain('核对成果引用'); expect(html).toContain('引用当前无法核对')
      expect(html).not.toContain('<object'); expect(html).not.toContain('href=')
      if (artifact.kind === 'matrix') expect(html).toContain('<table>')
      else expect(html).toContain('不能原地回滚')
    }
  })
  it('shows each deterministic gate and limits its meaning rather than calling it semantic or arithmetic proof', () => {
    const { workspace } = setup()
    const html = renderToStaticMarkup(createElement(ReviewGates, { review: workspace.reviews[0]! }))
    for (const gate of ['G0 完整性', 'G1 证据支持', 'G2 适用范围', 'G3 冲突与反向材料', 'G4 发布条件']) expect(html).toContain(gate)
    expect(html).toContain('检查通过不保证语义或算术正确'); expect(html).toContain('人工批准不会更改检查结果')
  })
})
