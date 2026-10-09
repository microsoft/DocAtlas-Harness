import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { answerVerificationSummary, M4_PUBLISH_RULESET, type AnswerManifest, type M4ClaimRecordRequest, type SelectionActionRequest,
  type SelectionActionResult, type SelectionContext, type SourceScopeVersion } from '@docatlas/contracts'
import { SourceScopeStore } from '../src/storage/source-scope-store.js'
import { ClaimReviewApplication, type ClaimReviewContext } from '../src/research/claim-review-application.js'

const answerFixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/answer-manifest.json', import.meta.url), 'utf8')) as { manifest: AnswerManifest }
const selectionFixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/selection.json', import.meta.url), 'utf8')) as {
  context: SelectionContext, actionRequest: SelectionActionRequest, actionResult: SelectionActionResult,
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function setup(kind: 'answer' | 'selection' = 'answer') {
  const root = await mkdtemp(join(tmpdir(), 'docatlas-canonical-evidence-')), store = await SourceScopeStore.open(root)
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const answer = structuredClone(answerFixture.manifest), selection = structuredClone(selectionFixture)
  const captured = kind === 'answer' ? answer : selection.context
  const scopeId = kind === 'answer' ? answer.sourceScopeVersionId : selection.context.scopeVersionId
  const locator = kind === 'answer' ? answer.citations[0]!.locator : selection.actionResult.locators[0]!
  const evidence = kind === 'answer' ? answer.citations[0]!.evidence! : selection.actionResult.evidence[0]!
  const source = { documentId: locator.documentId, revisionId: locator.revisionId, representationId: locator.representationId, representationContentHash: locator.representationContentHash }
  const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: scopeId, workspaceId: captured.workspaceId, investigationId: captured.investigationId,
    version: 1, included: [{ documentId: source.documentId, revisionId: source.revisionId, role: evidence.sourceRole }], excluded: [], locked: true,
    createdBy: { kind: 'user', actorId: 'user:canonical' }, createdAt: '2026-08-30T00:00:00.000Z' }
  store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: captured.sessionId, idempotencyKey: 'scope:canonical:initial', scope, sources: [source] })
  if (kind === 'answer') store.recordAnswerManifest(answer)
  else store.recordSelectionAction(scope.workspaceId, selection.actionRequest, selection.context, selection.actionResult)
  const path = join(root, 'investigations', `${hash(scope.workspaceId)}.sqlite3`)
  const read = (id = evidence.evidenceId, target = scope) => store.getCanonicalEvidence(target.workspaceId, target.investigationId, target.scopeVersionId, id)
  const mutate = (action: (database: DatabaseSync) => void) => { const database = new DatabaseSync(path); try { action(database) } finally { database.close() } }
  const context = (target = scope): ClaimReviewContext => ({ scope: target, sources: [source], workspaceId: target.workspaceId, investigationId: target.investigationId,
    conversationId: captured.sessionId, actor: { kind: 'user', actorId: 'user:canonical' }, signoffRequirement: 'required', assertCurrent() {}, authorize() {},
    authorizeHistoricalScope(id) { const found = store.getSourceScopeVersion(target.workspaceId, id); if (!found) throw new Error('Scope missing'); return found },
    getAuthorizedEvidence(id, originalScope) { return store.getCanonicalEvidence(target.workspaceId, target.investigationId, originalScope, id) } })
  const claim = (target = scope, suffix = 'one'): M4ClaimRecordRequest => ({ schemaVersion: 1, requestType: 'm4-claim-record', sessionId: captured.sessionId,
    workspaceId: target.workspaceId, investigationId: target.investigationId, scopeVersionId: target.scopeVersionId, idempotencyKey: `command:${suffix}`, expectedCurrentClaimVersionId: null,
    claim: { schemaVersion: 1, claimVersionId: `claim:${suffix}`, claimChainId: `chain:${suffix}`, version: 1, statement: evidence.content.text!, basis: 'document-supported', scope: {}, epistemicStatus: 'supported', reviewStatus: 'accepted' },
    provenance: { schemaVersion: 1, derivationActivityId: `activity:${suffix}`, operation: 'verify', inputEvidenceIds: [evidence.evidenceId], inputClaimVersionIds: [] },
    evidenceRelations: [{ schemaVersion: 1, evidenceRelationId: `relation:${suffix}`, evidenceId: evidence.evidenceId, kind: 'supports', coverage: 'full' }] })
  return { root, path, store, answer, selection, scope, source, locator, evidence, read, mutate, context, claim }
}

describe('canonical Evidence reads over the original scoped Answer and selection records', () => {
  it('returns exact Read Evidence and Locator with original publication handles, detached and without a second store', async () => {
    const f = await setup(), before = await readdir(join(f.root, 'investigations')), value = f.read()!
    expect(value).toEqual({ kind: 'evidence-atom', workspaceId: f.scope.workspaceId, investigationId: f.scope.investigationId,
      sourceScopeVersionIds: [f.scope.scopeVersionId], evidence: f.evidence, locator: f.locator, integrity: 'valid',
      origins: [{ kind: 'answer-read', sessionId: f.answer.sessionId, manifestId: f.answer.manifestId, messageId: f.answer.messageId, citationId: f.answer.citations[0]!.citationId }] })
    value.evidence.content.text = 'caller mutation'; value.locator.physicalPage = 1
    expect(f.read()!.evidence).toEqual(f.evidence); expect(f.read()!.locator).toEqual(f.locator)
    expect(f.store.getCanonicalEvidence('workspace:absent', f.scope.investigationId, f.scope.scopeVersionId, f.evidence.evidenceId)).toBeUndefined()
    expect(f.store.getCanonicalEvidence(f.scope.workspaceId, 'investigation:other', f.scope.scopeVersionId, f.evidence.evidenceId)).toBeUndefined()
    expect(f.store.getCanonicalEvidence(f.scope.workspaceId, f.scope.investigationId, 'scope:other', f.evidence.evidenceId)).toBeUndefined()
    for (const id of ['memory:preference', 'record:note', 'recall:lead', f.locator.locatorId]) expect(f.read(id)).toBeUndefined()
    expect(await readdir(join(f.root, 'investigations'))).toEqual(before)
    f.mutate(database => {
      expect(database.prepare("SELECT count(*) AS count FROM journal_events").get()?.count).toBe(1)
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%evidence%'").all()).toEqual([])
    })
  })

  it('supports human Claim creation from an actual canonical Answer without manufacturing selection Evidence', async () => {
    const f = await setup(), app = new ClaimReviewApplication(f.store)
    expect(app.handle(f.claim(), f.context())).toMatchObject({ resultType: 'm4-claim-record', status: 'created' })
    expect(f.store.getM4ClaimLedger(f.scope.workspaceId, f.scope.investigationId).evidenceRelations).toMatchObject([{ evidenceId: f.evidence.evidenceId }])
    expect(f.store.listSelectionActions(f.scope.workspaceId, f.scope.investigationId)).toEqual([])
  })

  it('never lends an old capture to a new scope and keeps repeated Read provenance scoped across Investigations', async () => {
    const f = await setup(), app = new ClaimReviewApplication(f.store)
    app.handle(f.claim(), f.context())
    const next = { ...f.scope, scopeVersionId: 'scope:canonical:next', version: 2, previousScopeVersionId: f.scope.scopeVersionId }
    f.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: f.answer.sessionId, idempotencyKey: 'scope:next', expectedScopeVersionId: f.scope.scopeVersionId, scope: next, sources: [f.source] })
    expect(f.read(f.evidence.evidenceId, next)).toBeUndefined()
    expect(() => app.handle(f.claim(next, 'next'), f.context(next))).toThrow()
    const reread = structuredClone(f.answer)
    Object.assign(reread, { manifestId: 'answer:reread', messageId: 'message:reread', sourceScopeVersionId: next.scopeVersionId, turn: 2 })
    reread.citations[0]!.evidence!.provenanceActivityId = 'activity:read:next'
    f.store.recordAnswerManifest(reread)
    expect(f.read()!.evidence.provenanceActivityId).toBe(f.evidence.provenanceActivityId)
    expect(f.read(f.evidence.evidenceId, next)!.evidence.provenanceActivityId).toBe('activity:read:next')
    expect(app.handle(f.claim(next, 'next'), f.context(next))).toMatchObject({ status: 'created' })
    const other = { ...f.scope, scopeVersionId: 'scope:other-investigation', investigationId: 'investigation:other' }
    f.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: 'session:other', idempotencyKey: 'scope:other', scope: other, sources: [f.source] })
    const independent = structuredClone(f.answer)
    Object.assign(independent, { manifestId: 'answer:other', messageId: 'message:other', sessionId: 'session:other', sourceScopeVersionId: other.scopeVersionId, investigationId: other.investigationId })
    independent.citations[0]!.evidence!.provenanceActivityId = 'activity:read:other'
    f.store.recordAnswerManifest(independent)
    expect(f.read(f.evidence.evidenceId, other)!.origins).toMatchObject([{ sessionId: 'session:other' }])
    expect(f.read()!.sourceScopeVersionIds).toEqual([f.scope.scopeVersionId])
    expect(app.handle(f.claim(other, 'other'), { ...f.context(other), conversationId: f.answer.sessionId })).toMatchObject({ status: 'created' })
    expect(f.store.listSourceScopeVersions(f.scope.workspaceId, f.scope.investigationId).map(item => item.scope.scopeVersionId)).toEqual([f.scope.scopeVersionId, next.scopeVersionId])
    expect(f.store.listSourceScopeVersions(f.scope.workspaceId, other.investigationId).map(item => item.scope.scopeVersionId)).toEqual([other.scopeVersionId])
    expect(f.store.get(f.answer.sessionId).scope?.scopeVersionId).toBe(next.scopeVersionId)
  })

  it('preserves selection-action provenance, without treating its bookmark or Note identity as Evidence', async () => {
    const f = await setup('selection')
    expect(f.read()).toMatchObject({ evidence: f.evidence, locator: f.locator, sourceScopeVersionIds: [f.scope.scopeVersionId],
      origins: [{ kind: 'selection-action', sessionId: f.selection.context.sessionId, actionId: f.selection.actionResult.actionId, selectionContextId: f.selection.context.selectionContextId, action: 'save-evidence' }] })
    if (f.selection.actionResult.record.recordType !== 'evidence-bookmark') throw new Error('Expected bookmark fixture')
    expect(f.read(f.selection.actionResult.record.bookmarkId)).toBeUndefined()
    const request = { ...f.selection.actionRequest, action: 'create-note' as const, idempotencyKey: 'selection:note', noteKind: 'commentary' as const, body: 'Human interpretation is not document Evidence.' }
    const note = structuredClone(f.selection.actionResult)
    note.action = 'create-note'; note.actionId = 'selection-action:note'
    note.evidence = note.evidence.map(evidence => ({ ...evidence, evidenceId: 'evidence:note-anchor', provenanceActivityId: note.actionId }))
    note.record = { schemaVersion: 1, recordType: 'research-note', noteId: 'note:canonical', workspaceId: f.scope.workspaceId, investigationId: f.scope.investigationId,
      selectionContextId: note.selectionContextId, version: 1, noteKind: 'commentary', body: request.body, evidenceIds: ['evidence:note-anchor'], locatorIds: [f.locator.locatorId],
      status: 'active', createdBy: { kind: 'user', actorId: f.evidence.createdBy.actorId }, createdAt: f.evidence.createdAt }
    f.store.recordSelectionAction(f.scope.workspaceId, request, f.selection.context, note)
    expect(f.read('note:canonical')).toBeUndefined()
    expect(f.read('evidence:note-anchor')).toMatchObject({ evidence: { content: f.evidence.content }, origins: [{ action: 'create-note' }] })
  })

  it('coalesces identical scoped presentations but rejects conflicting atoms instead of choosing convenient provenance', async () => {
    const f = await setup(), duplicate = structuredClone(f.answer)
    Object.assign(duplicate, { manifestId: 'answer:duplicate', messageId: 'message:duplicate', turn: 2 })
    f.store.recordAnswerManifest(duplicate)
    expect(f.read()!.origins).toHaveLength(2)
    const conflicting = structuredClone(duplicate)
    Object.assign(conflicting, { manifestId: 'answer:conflict', messageId: 'message:conflict', turn: 3 })
    conflicting.citations[0]!.evidence!.provenanceActivityId = 'activity:conflicting'
    f.store.recordAnswerManifest(conflicting)
    expect(() => f.read()).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it('does not promote a locator-only answer or an uncommitted source-scope name to Evidence', async () => {
    const f = await setup(), locatorOnly = structuredClone(f.answer), id = f.evidence.evidenceId
    delete locatorOnly.citations[0]!.evidence
    locatorOnly.citations[0]!.verificationStatus = 'locator-only'
    locatorOnly.blocks[0]!.segments[0]!.status = 'unresolved'; locatorOnly.manifestStatus = 'partial'
    locatorOnly.verificationSummary = answerVerificationSummary(locatorOnly.blocks.flatMap(block => block.segments), locatorOnly.citations)
    f.mutate(database => { database.prepare('DELETE FROM answer_manifests').run() })
    f.store.recordAnswerManifest(locatorOnly)
    expect(f.read(id)).toBeUndefined()
    const orphan = structuredClone(f.answer)
    Object.assign(orphan, { manifestId: 'answer:no-scope', messageId: 'message:no-scope', sourceScopeVersionId: 'scope:not-committed' })
    f.store.recordAnswerManifest(orphan)
    expect(f.store.getCanonicalEvidence(f.scope.workspaceId, f.scope.investigationId, orphan.sourceScopeVersionId, id)).toBeUndefined()
  })

  it.each(['hash', 'identity', 'schema', 'text', 'investigation'] as const)('rejects same-open-handle Answer %s tampering before returning content', async (damage) => {
    const f = await setup()
    f.mutate(database => {
      if (damage === 'hash') { database.prepare('UPDATE answer_manifests SET manifest_hash = ?').run('0'.repeat(64)); return }
      if (damage === 'identity') { database.prepare('UPDATE answer_manifests SET manifest_id = ?').run('answer:forged'); return }
      const value = structuredClone(f.answer)
      if (damage === 'schema') Reflect.set(value, 'schemaVersion', 2)
      if (damage === 'investigation') value.investigationId = 'investigation:forged'
      if (damage === 'text') { value.citations[0]!.evidence!.contentHash = '0'.repeat(64); const quote = value.citations[0]!.locator.selectors.find(item => item.type === 'text-quote')!; if (quote.type === 'text-quote') quote.normalizedHash = '0'.repeat(64) }
      const json = JSON.stringify(value)
      database.prepare('UPDATE answer_manifests SET manifest_json = ?, manifest_hash = ?').run(json, hash(json))
    })
    expect(() => f.read()).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it.each(['projection', 'journal-hash', 'journal-workspace', 'scope-workspace', 'scope-aggregate', 'text', 'text-quote'] as const)('rejects same-open-handle selection %s tampering', async (damage) => {
    const f = await setup('selection')
    f.mutate(database => {
      if (damage === 'projection') database.prepare('UPDATE selection_actions SET result_hash = ?').run('0'.repeat(64))
      else if (damage === 'journal-hash') database.prepare("UPDATE journal_events SET payload_hash = ? WHERE event_type = 'selection-action.recorded'").run('0'.repeat(64))
      else if (damage === 'journal-workspace') database.prepare("UPDATE journal_events SET workspace_id = ? WHERE event_type = 'selection-action.recorded'").run('workspace:forged')
      else if (damage === 'scope-workspace') database.prepare("UPDATE journal_events SET workspace_id = ? WHERE event_type = 'source-scope.committed'").run('workspace:forged')
      else if (damage === 'scope-aggregate') database.prepare("UPDATE journal_events SET aggregate_id = ? WHERE event_type = 'source-scope.committed'").run('investigation:forged')
      else {
        const result = structuredClone(f.selection.actionResult); result.evidence[0]!.content.text = 'Not the captured document quote.'
        if (damage === 'text-quote') result.evidence[0]!.contentHash = hash(result.evidence[0]!.content.text)
        const json = JSON.stringify(result), payload = JSON.stringify({ schemaVersion: 1, result, context: f.selection.context })
        database.prepare('UPDATE selection_actions SET result_json = ?, result_hash = ?').run(json, hash(json))
        database.prepare("UPDATE journal_events SET payload_json = ?, payload_hash = ? WHERE event_type = 'selection-action.recorded'").run(payload, hash(payload))
      }
    })
    expect(() => f.read()).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it('rejects invalid IDs without interpreting paths or filters', async () => {
    const f = await setup()
    for (const id of ['', '../workspace', 'evidence:*', 'a'.repeat(129)]) expect(() => f.read(id)).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
  })

  it('enumerates only exact original scope and Answer captures and revalidates their hashes on the same handle', async () => {
    const f = await setup()
    expect(f.store.listSourceScopeVersions(f.scope.workspaceId, f.scope.investigationId)).toEqual([{ scope: f.scope, sources: [f.source] }])
    expect(f.store.listSourceScopeVersions(f.scope.workspaceId, 'investigation:absent')).toEqual([])
    expect(f.store.listSourceScopeVersions('workspace:absent', f.scope.investigationId)).toEqual([])
    expect(f.store.listAnswerManifests(f.scope.workspaceId, f.answer.sessionId, f.scope.scopeVersionId)).toEqual([f.answer])
    expect(f.store.listAnswerManifests(f.scope.workspaceId, f.answer.sessionId, 'scope:absent')).toEqual([])
    expect(f.store.listAnswerManifests(f.scope.workspaceId, 'session:absent', f.scope.scopeVersionId)).toEqual([])
    expect(f.store.listAnswerManifests('workspace:absent', f.answer.sessionId, f.scope.scopeVersionId)).toEqual([])
    expect(f.store.listAnswerManifests(f.scope.workspaceId, f.answer.sessionId)).toEqual([f.answer])
    f.mutate(database => {
      database.prepare('UPDATE answer_manifests SET manifest_hash = ?').run('0'.repeat(64))
      database.prepare("UPDATE journal_events SET workspace_id = ? WHERE event_type = 'source-scope.committed'").run('workspace:forged')
    })
    expect(() => f.store.listSourceScopeVersions(f.scope.workspaceId, f.scope.investigationId)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    expect(() => f.store.listAnswerManifests(f.scope.workspaceId, f.answer.sessionId, f.scope.scopeVersionId)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it('enumerates scoped verified M4 Artifacts, Reviews and human decisions without raw journals or another store', async () => {
    const f = await setup(), app = new ClaimReviewApplication(f.store, () => '2026-09-01T00:00:00.000Z'), context = f.context(), request = f.claim()
    app.handle(request, context)
    const base = { schemaVersion: 1 as const, sessionId: f.answer.sessionId, workspaceId: f.scope.workspaceId, investigationId: f.scope.investigationId, scopeVersionId: f.scope.scopeVersionId }
    const markdown = f.evidence.content.text!
    const createDraft = (suffix: string) => app.handle({ ...base, requestType: 'm4-artifact-draft', idempotencyKey: `draft:${suffix}`, expectedPreviousArtifactManifestId: null,
      manifest: { schemaVersion: 1, artifactManifestId: `manifest:${suffix}`, artifactId: `artifact:${suffix}`, version: 1, title: 'Human source review', kind: 'brief', personalizationUseIds: [],
        content: { kind: 'brief', sections: [{ sectionId: `section:${suffix}`, heading: 'Revenue', markdown, claimUses: [{ claimUseId: `use:${suffix}`, claimVersionId: request.claim.claimVersionId,
          useKind: 'assertion', span: { start: 0, end: [...markdown].length, unit: 'unicode-scalar' }, citationEvidenceIds: [f.evidence.evidenceId] }] }] } } }, context)
    createDraft('one'); createDraft('aaa')
    const runReview = (suffix: string) => app.handle({ ...base, requestType: 'm4-review-run', idempotencyKey: `review:${suffix}`, artifactManifestId: 'manifest:one', reviewResultId: `review:${suffix}`, ruleset: M4_PUBLISH_RULESET, signoffRequirement: 'required' }, context)
    runReview('one'); runReview('aaa')
    app.handle({ ...base, requestType: 'm4-human-decision', idempotencyKey: 'decision:one', reviewDecisionId: 'decision:one', reviewResultId: 'review:one', decision: 'rejected' }, context)
    app.handle({ ...base, requestType: 'm4-human-decision', idempotencyKey: 'decision:aaa', reviewDecisionId: 'decision:aaa', reviewResultId: 'review:one', decision: 'rejected' }, context)
    const value = f.store.getM4WorkspaceSnapshot(f.scope.workspaceId, f.scope.investigationId)
    expect(value).toMatchObject({ artifacts: [{ artifactManifestId: 'manifest:one', status: 'draft' }, { artifactManifestId: 'manifest:aaa', status: 'draft' }],
      reviews: [{ reviewResultId: 'review:one', decision: 'fail' }, { reviewResultId: 'review:aaa', decision: 'fail' }],
      decisions: [{ reviewDecisionId: 'decision:one', decision: 'rejected', decidedBy: context.actor }, { reviewDecisionId: 'decision:aaa', decision: 'rejected' }] })
    expect(new Set(value.artifacts.map(item => item.createdAt)).size).toBe(1)
    expect(new Set(value.reviews.map(item => item.createdAt)).size).toBe(1)
    expect(new Set(value.decisions.map(item => item.decidedAt)).size).toBe(1)
    expect(value.decisions.map(item => item.reviewDecisionId)).toEqual(['decision:one', 'decision:aaa'])
    expect(Object.keys(value).sort()).toEqual(['artifacts', 'decisions', 'reviews'])
    value.artifacts[0]!.title = 'caller mutation'
    expect(f.store.getM4WorkspaceSnapshot(f.scope.workspaceId, f.scope.investigationId).artifacts[0]!.title).toBe('Human source review')
    expect(f.store.getM4WorkspaceSnapshot(f.scope.workspaceId, 'investigation:absent')).toEqual({ artifacts: [], reviews: [], decisions: [] })
    expect(f.store.getM4WorkspaceSnapshot('workspace:absent', f.scope.investigationId)).toEqual({ artifacts: [], reviews: [], decisions: [] })
    app.handle({ ...base, requestType: 'm4-conflict-search-assure', idempotencyKey: 'assure:one', claimVersionIds: [request.claim.claimVersionId], evidenceIds: [f.evidence.evidenceId] }, context)
    expect(runReview('000')).toMatchObject({ review: { decision: 'needs-human' } })
    app.handle({ ...base, requestType: 'm4-human-decision', idempotencyKey: 'decision:000', reviewDecisionId: 'decision:000', reviewResultId: 'review:000', decision: 'approved' }, context)
    app.handle({ ...base, requestType: 'm4-artifact-publish', idempotencyKey: 'publish:one', artifactManifestId: 'manifest:one', expectedStatus: 'draft', reviewResultId: 'review:000', humanReviewDecisionId: 'decision:000' }, context)
    const published = f.store.getM4WorkspaceSnapshot(f.scope.workspaceId, f.scope.investigationId)
    expect(published.artifacts.map(item => [item.artifactManifestId, item.status])).toEqual([['manifest:one', 'published'], ['manifest:aaa', 'draft']])
    expect(published.reviews.map(item => item.reviewResultId)).toEqual(['review:one', 'review:aaa', 'review:000'])
    expect(published.decisions.map(item => item.reviewDecisionId)).toEqual(['decision:one', 'decision:aaa', 'decision:000'])
    expect(new Set([...published.artifacts.map(item => item.createdAt), ...published.reviews.map(item => item.createdAt), ...published.decisions.map(item => item.decidedAt)]).size).toBe(1)
    expect(f.store.getM4WorkspaceSnapshot(f.scope.workspaceId, f.scope.investigationId)).toEqual(published)
    f.store.close()
    const reopened = await SourceScopeStore.open(f.root)
    try {
      expect(reopened.getM4WorkspaceSnapshot(f.scope.workspaceId, f.scope.investigationId)).toEqual(published)
      expect(reopened.getM4WorkspaceSnapshot(f.scope.workspaceId, f.scope.investigationId)).toEqual(published)
      f.mutate(database => { database.exec('DROP TRIGGER investigation_m4_events_no_update'); database.prepare('UPDATE investigation_m4_events SET payload_hash = ? WHERE sequence = 1').run('0'.repeat(64)) })
      expect(() => reopened.getM4WorkspaceSnapshot(f.scope.workspaceId, f.scope.investigationId)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    } finally { reopened.close() }
  })
})
