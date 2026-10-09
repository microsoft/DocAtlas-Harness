import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { M4_PUBLISH_RULESET, type AnswerManifest, type ContinuityAssessRequest, type DocumentLocator, type DocumentRevision, type LibraryDocument,
  type M4ClaimRecordRequest, type M4ArtifactDraftRequest, type RevisionImpactRequest, type ScopedSourceIdentity, type SourceRepresentation, type SourceScopeVersion,
  type SelectionActionRequest, type SelectionActionResult, type SelectionContext } from '@docatlas/contracts'
import { compileSourceAnswerManifest } from '../src/evidence/answer-manifest.js'
import { ClaimReviewApplication, type ClaimReviewContext } from '../src/research/claim-review-application.js'
import { SourceScopeStore } from '../src/storage/source-scope-store.js'
import { ContinuityService, type ContinuityServiceBackend } from '../src/storage/continuity-service.js'

const canonical = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as {
  documentRevision: DocumentRevision, originalRepresentation: SourceRepresentation, textRepresentation: SourceRepresentation,
}
const selection = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/selection.json', import.meta.url), 'utf8')) as {
  context: SelectionContext, actionRequest: SelectionActionRequest, actionResult: SelectionActionResult,
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex'), workspaceId = 'workspace:continuity-answer', investigationId = 'investigation:continuity-answer', sessionId = 'session:continuity-answer'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'docatlas-continuity-answer-')), store = await SourceScopeStore.open(root)
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const documentId = store.resolveLibraryImport(workspaceId, 'source:annual-report', 'a'.repeat(64)).documentId
  const sources: ScopedSourceIdentity[] = []
  for (const version of [1, 2]) {
    const revisionId = `revision:report:${version}`, originalId = `representation:report:${version}:pdf`, representationId = `representation:report:${version}:text`
    const contentHash = (version === 1 ? 'a' : 'd').repeat(64), representationContentHash = (version === 1 ? 'b' : 'e').repeat(64)
    const document: LibraryDocument = { schemaVersion: 1, workspaceId, documentId, displayName: 'Annual Report.pdf', mediaType: 'application/pdf', sourceRole: 'primary', status: 'ready', revisionCount: version,
      currentRevision: { ...canonical.documentRevision, documentId, revisionId, contentHash, displayName: 'Annual Report.pdf', ...(version === 2 ? { previousRevisionId: 'revision:report:1' } : {}) },
      representations: [{ ...canonical.originalRepresentation, documentId, revisionId, representationId: originalId, contentHash },
        { ...canonical.textRepresentation, documentId, revisionId, representationId, contentHash: representationContentHash, derivedFromRepresentationIds: [originalId] }],
      activeRepresentationId: representationId, capabilities: ['text', 'original'], createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z' }
    store.recordLibraryDocument({ workspaceId, idempotencyKey: `library:report:${version}`, sourceKey: 'source:annual-report', rootId: 'root:fixture', relativePath: 'Annual Report.pdf', document })
    sources.push({ documentId, revisionId, representationId, representationContentHash })
  }
  const original: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: 'scope:continuity:original', workspaceId, investigationId, version: 1,
    included: [{ documentId, revisionId: sources[0]!.revisionId, role: 'primary' }], excluded: [], locked: true, createdBy: { kind: 'user', actorId: 'user:continuity' }, createdAt: '2026-08-31T00:00:00.000Z' }
  store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId, idempotencyKey: 'scope:original', scope: original, sources: [sources[0]!] })
  let tick = 0
  const app = new ClaimReviewApplication(store, () => new Date(Date.parse('2026-09-01T00:00:00Z') + tick++ * 1000).toISOString())
  const context = (scope = original): ClaimReviewContext => ({ ...store.getSourceScopeVersion(workspaceId, scope.scopeVersionId)!, conversationId: sessionId, workspaceId, investigationId,
    actor: { kind: 'user', actorId: 'user:continuity' }, signoffRequirement: 'not-required', assertCurrent() {}, authorize() {},
    authorizeHistoricalScope(id) { const value = store.getSourceScopeVersion(workspaceId, id); if (!value) throw new Error('Missing source frame'); return value },
    getAuthorizedEvidence(id, scopeId) { return store.getCanonicalEvidence(workspaceId, investigationId, scopeId, id) } })
  const base = (scope = original) => ({ schemaVersion: 1 as const, sessionId, workspaceId, investigationId, scopeVersionId: scope.scopeVersionId })
  const read = (source: ScopedSourceIdentity, scope = original, key = source.revisionId): AnswerManifest => {
    const text = source.revisionId === sources[0]!.revisionId ? 'Revenue increased by 12%.' : 'Revenue increased by 18%.'
    const locator: DocumentLocator = { schemaVersion: 1, locatorId: `locator:${source.revisionId}`, ...source, physicalPage: 17,
      selectors: [{ type: 'text-quote', exact: text, normalizedHash: hash(text) }], createdAt: '2026-08-31T00:00:00.000Z' }
    const answer = compileSourceAnswerManifest({ sessionId, turn: ++tick, scope, sources: store.getSourceScopeVersion(workspaceId, scope.scopeVersionId)!.sources,
      message: { id: `message:${key}`, createdAt: '2026-08-31T00:00:00.000Z', blocks: [{ index: 0, text: `[${text}](#docatlas.v1.support.${locator.locatorId})` }] },
      reads: [{ callId: `call:${key}`, scopeVersionId: scope.scopeVersionId, locators: [locator] }] })!
    store.recordAnswerManifest(answer); return answer
  }
  const record = (name: string, answer: AnswerManifest, scope = original, derivation?: { claims?: string[], evidence?: string[] }): M4ClaimRecordRequest => {
    const evidence = answer.citations[0]!.evidence!, derived = derivation !== undefined
    const request: M4ClaimRecordRequest = { ...base(scope), requestType: 'm4-claim-record', idempotencyKey: `record:${name}`, expectedCurrentClaimVersionId: null,
      claim: { schemaVersion: 1, claimVersionId: `claim:${name}:v1`, claimChainId: `chain:${name}`, version: 1, statement: evidence.content.text!, basis: derived ? 'derived-from-claims' : 'document-supported',
        scope: {}, epistemicStatus: 'supported', reviewStatus: 'accepted' },
      provenance: { schemaVersion: 1, derivationActivityId: `derivation:${name}`, operation: derived ? 'infer' : 'extract',
        inputEvidenceIds: [...new Set([evidence.evidenceId, ...(derivation?.evidence ?? [])])], inputClaimVersionIds: derivation?.claims ?? [] },
      evidenceRelations: [{ schemaVersion: 1, evidenceRelationId: `relation:${name}`, evidenceId: evidence.evidenceId, kind: derived ? 'derived-input' : 'supports', coverage: 'full' }] }
    app.handle(request, context(scope)); return request
  }
  const draft = (name: string, claim: M4ClaimRecordRequest, scope = original): M4ArtifactDraftRequest => {
    const request: M4ArtifactDraftRequest = { ...base(scope), requestType: 'm4-artifact-draft', idempotencyKey: `draft:${name}`, expectedPreviousArtifactManifestId: null,
      manifest: { schemaVersion: 1, artifactManifestId: `manifest:${name}:v1`, artifactId: `artifact:${name}`, version: 1, title: name, personalizationUseIds: [], kind: 'brief',
        content: { kind: 'brief', sections: [{ sectionId: 'section:finding', heading: 'Finding', markdown: claim.claim.statement,
          claimUses: [{ claimUseId: 'use:finding', claimVersionId: claim.claim.claimVersionId, useKind: 'assertion', span: { start: 0, end: [...claim.claim.statement].length, unit: 'unicode-scalar' }, citationEvidenceIds: claim.evidenceRelations.map(relation => relation.evidenceId) }] }] } } }
    app.handle(request, context(scope)); return request
  }
  const compareScope = (): SourceScopeVersion => {
    const next: SourceScopeVersion = { ...original, scopeVersionId: 'scope:continuity:compare', version: 2, previousScopeVersionId: original.scopeVersionId,
      included: sources.map(source => ({ documentId, revisionId: source.revisionId, role: 'primary' })) }
    store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId, idempotencyKey: 'scope:compare', expectedScopeVersionId: original.scopeVersionId, scope: next, sources })
    return next
  }
  const impact = (recordIds: string[], scope = original): RevisionImpactRequest => ({ ...base(scope), requestType: 'revision-impact', previousSource: sources[0]!, currentSource: sources[1]!, recordIds, limits: { maxItems: 100 } })
  const mutate = (action: (database: DatabaseSync) => void) => { const database = new DatabaseSync(join(root, 'investigations', `${hash(workspaceId)}.sqlite3`)); try { action(database) } finally { database.close() } }
  return { store, app, original, sources, context, base, read, record, draft, compareScope, impact, mutate }
}

describe('Continuity over canonical Answer Evidence and exact immutable research versions', () => {
  it('limits recent Answer validation in SQL and orders native turns by actual append order, preserving legacy and exact-scope queries', async () => {
    const f = await setup(), first = f.read(f.sources[0]!)
    const append = (name: string, turn: number, createdAt: string) => {
      const value = { ...structuredClone(first), manifestId: `manifest:${name}`, messageId: `message:${name}`, turn, createdAt }
      f.store.recordAnswerManifest(value); return value
    }
    const clockNewest = append('zzzz-clock-newest', 50, '2026-09-09T00:00:00.000Z')
    const appendedLater = append('aaaa-appended-later', 50, '2026-09-02T00:00:00.000Z')
    const highestTurn = append('mmmm-highest-turn', 51, '2026-08-29T00:00:00.000Z')
    const comparison = f.compareScope(), scoped = f.read(f.sources[1]!, comparison, 'other-scope')
    expect(f.store.listAnswerManifests(workspaceId, sessionId, undefined, { maxItems: 3 }).map(item => item.manifestId))
      .toEqual([highestTurn.manifestId, appendedLater.manifestId, clockNewest.manifestId])
    expect(f.store.listAnswerManifests(workspaceId, sessionId, comparison.scopeVersionId, { maxItems: 1 })).toEqual([scoped])
    expect(f.store.listAnswerManifests(workspaceId, sessionId).map(item => item.manifestId))
      .toEqual([highestTurn.manifestId, scoped.manifestId, first.manifestId, appendedLater.manifestId, clockNewest.manifestId])
    f.mutate(database => { database.prepare('UPDATE answer_manifests SET manifest_hash = ? WHERE manifest_id = ?').run('0'.repeat(64), first.manifestId) })
    // A corrupt older row outside the requested recent window is not parsed, while
    // the legacy all-history API and corruption inside the window still fail closed.
    expect(f.store.listAnswerManifests(workspaceId, sessionId, undefined, { maxItems: 3 })).toHaveLength(3)
    expect(() => f.store.listAnswerManifests(workspaceId, sessionId)).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    f.mutate(database => { database.prepare('UPDATE answer_manifests SET manifest_hash = ? WHERE manifest_id = ?').run('0'.repeat(64), highestTurn.manifestId) })
    expect(() => f.store.listAnswerManifests(workspaceId, sessionId, undefined, { maxItems: 1 })).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
    for (const maxItems of [0, -1, 257, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => f.store.listAnswerManifests(workspaceId, sessionId, undefined, { maxItems })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    }
  })

  it('pins prior Note versions and reconciles the exact host-command receipt after edits without reassessing the newer Note', async () => {
    const f = await setup(), note = f.store.recordResearch({ ...f.base(), requestType: 'research-record', kind: 'checkpoint', callId: 'call:version-pin', idempotencyKey: 'note:version-pin', body: 'An unverified prior observation.' }).record
    const request: ContinuityAssessRequest = { ...f.base(), requestType: 'continuity-assess', priorRecordId: note.recordId, priorRecordVersion: 1, priorSources: [], currentSources: [f.sources[0]!],
      proposedState: 'unknown', rationale: 'The prior observation has no source assertion.', idempotencyKey: 'continuity:note:version-pin' }
    const backend: ContinuityServiceBackend = { activeScope: () => ({ workspaceId, investigationId, scopeVersionId: f.original.scopeVersionId, sources: [f.sources[0]!] }),
      researchRecord: (workspace, id) => f.store.getContinuityRecord(workspace, id), resolveEvidence: () => undefined,
      commitLink: (key, requestHash, link) => f.store.commitContinuityLink(workspaceId, key, requestHash, link), impactRecords: () => [] }
    const service = new ContinuityService(backend), actor = { kind: 'user' as const, actorId: 'user:continuity' }, commandHash = 'a'.repeat(64)
    expect(() => service.assess(request, actor, 'invalid-hash')).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    const created = service.assess(request, actor, commandHash)
    expect(created.link.priorRecordVersion).toBe(1)
    expect(service.assess(request, actor, commandHash)).toMatchObject({ status: 'replayed', link: created.link })
    expect(() => service.assess(request, actor, 'b'.repeat(64))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    f.store.transitionResearchRecord({ ...f.base(), requestType: 'research-record-lifecycle', recordId: note.recordId, expectedVersion: 1, idempotencyKey: 'note:version-pin:edit', action: 'edit', text: 'A later edited observation.' })
    expect(() => service.assess(request, actor, commandHash)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.replayContinuityLink(workspaceId, request.idempotencyKey, commandHash)).toEqual({ status: 'replayed', link: created.link })
    expect(() => f.store.replayContinuityLink(workspaceId, request.idempotencyKey, 'b'.repeat(64))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.replayContinuityLink('workspace:absent', request.idempotencyKey, commandHash)).toBeUndefined()
    expect(f.store.getContinuityRecord(workspaceId, note.recordId)?.version).toBe(2)
  })

  it('distinguishes incomplete dependency metadata from a completely known unrelated record and seals completeness into pagination', async () => {
    const f = await setup(), ids = ['record:incomplete', 'record:unrelated', 'record:prior-missing'], request = f.impact(ids)
    const records = [
      { recordId: ids[0]!, sources: [], previousSourceAvailability: 'available' as const, sourceReferencesComplete: false },
      { recordId: ids[1]!, sources: [f.sources[1]!], previousSourceAvailability: 'missing' as const },
      { recordId: ids[2]!, sources: [f.sources[0]!], previousSourceAvailability: 'missing' as const },
    ]
    const backend: ContinuityServiceBackend = { activeScope: () => undefined, researchRecord: () => undefined, resolveEvidence: () => undefined,
      commitLink: (_key, _hash, link) => ({ status: 'created', link }), impactRecords: () => records }
    const service = new ContinuityService(backend)
    expect(service.revisionImpact(request).impacts.map(item => item.status)).toEqual(['missing-source', 'unaffected', 'missing-source'])
    const page = { ...request, limits: { maxItems: 1 } }, first = service.revisionImpact(page)
    expect(first.pageInfo.nextCursor).toBeDefined()
    records[0]!.sourceReferencesComplete = true
    expect(() => service.revisionImpact({ ...page, cursor: first.pageInfo.nextCursor! })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(() => service.revisionImpact({ ...request, recordIds: ['record:unknown'] })).toThrowError(expect.objectContaining({ code: 'not-found' }))
  })

  it('marks Answer-backed Claims and Artifacts as needing reverification, without requiring selection records', async () => {
    const f = await setup(), answer = f.read(f.sources[0]!), claim = f.record('original', answer), artifact = f.draft('original', claim), scope = f.compareScope()
    expect(f.store.listSelectionActions(workspaceId, investigationId)).toEqual([])
    expect(f.store.revisionImpact(f.impact([claim.claim.claimVersionId, artifact.manifest.artifactManifestId], scope)).impacts).toMatchObject([
      { recordId: claim.claim.claimVersionId, status: 'needs-reverify' }, { recordId: artifact.manifest.artifactManifestId, status: 'needs-reverify' },
    ])
  })

  it('returns detached exact-version metadata and complete original authorization handles without source text or aggregate aliases', async () => {
    const f = await setup(), answer = f.read(f.sources[0]!), claim = f.record('metadata', answer), artifact = f.draft('metadata', claim)
    const evidenceId = answer.citations[0]!.evidence!.evidenceId
    const metadata = f.store.getContinuityRecord(workspaceId, artifact.manifest.artifactManifestId)!
    expect(metadata).toMatchObject({ recordId: artifact.manifest.artifactManifestId, recordType: 'artifact-brief', version: 1, scopeVersionId: f.original.scopeVersionId,
      identity: { kind: 'artifact-manifest', artifactManifestId: artifact.manifest.artifactManifestId, artifactId: artifact.manifest.artifactId, version: 1 },
      sourceReferencesComplete: true, authorizationComplete: true, sources: [f.sources[0]], evidenceRefs: [{ investigationId, scopeVersionId: f.original.scopeVersionId, evidenceId }] })
    expect(metadata.authorizationRefs.filter(item => item.kind === 'm4-command')).toHaveLength(2)
    expect(metadata.authorizationRefs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'answer-read', sessionId, investigationId,
      scopeVersionId: f.original.scopeVersionId, referenceId: answer.manifestId, messageId: answer.messageId, citationId: answer.citations[0]!.citationId })]))
    expect(JSON.stringify(metadata)).not.toContain(answer.citations[0]!.evidence!.content.text!)
    metadata.authorizationRefs[0]!.sessionId = 'session:caller-change'; metadata.evidenceRefs[0]!.scopeVersionId = 'scope:caller-change'
    expect(f.store.getContinuityRecord(workspaceId, artifact.manifest.artifactManifestId)!.authorizationRefs.every(item => item.sessionId === sessionId)).toBe(true)
    expect(f.store.getContinuityRecord(workspaceId, claim.claim.claimChainId)).toBeUndefined()
    expect(f.store.getContinuityRecord(workspaceId, artifact.manifest.artifactId)).toBeUndefined()
    expect(f.store.getContinuityRecord('workspace:foreign', claim.claim.claimVersionId)).toBeUndefined()
  })

  it('marks a raw M4 record without verified original session provenance incomplete instead of guessing from its actor', async () => {
    const f = await setup(), answer = f.read(f.sources[0]!), first = f.record('known-origin', answer), ledger = f.store.getM4ClaimLedger(workspaceId, investigationId)
    const claim = { ...ledger.claims[0]!, claimVersionId: 'claim:no-session', claimChainId: 'chain:no-session', provenanceActivityId: 'derivation:no-session', createdBy: { kind: 'user' as const, actorId: sessionId } }
    f.store.recordM4ClaimVersion({ workspaceId, investigationId, idempotencyKey: 'raw:no-session', expectedCurrentClaimVersionId: null, claim,
      provenance: { ...ledger.derivations[0]!, derivationActivityId: claim.provenanceActivityId, outputClaimVersionIds: [claim.claimVersionId] },
      evidenceRelations: [{ ...ledger.evidenceRelations[0]!, evidenceRelationId: 'relation:no-session', claimVersionId: claim.claimVersionId }] })
    const value = f.store.getContinuityRecord(workspaceId, claim.claimVersionId)!
    expect(value).toMatchObject({ sourceReferencesComplete: true, authorizationComplete: false, evidenceRefs: [{ evidenceId: first.provenance.inputEvidenceIds[0] }] })
    expect(value.authorizationRefs.some(item => item.kind === 'm4-command')).toBe(false)
    expect(value.authorizationRefs.every(item => item.kind === 'answer-read')).toBe(true)
  })

  it('reads Note lifecycle version and original journal provenance without returning its body or guessing source dependencies', async () => {
    const f = await setup(), created = f.store.recordResearch({ ...f.base(), requestType: 'research-record', kind: 'checkpoint', callId: 'call:private-note', idempotencyKey: 'note:private', body: 'PRIVATE_UNVERIFIED_NOTE_BODY' })
    const recordId = created.record.recordId
    expect(f.store.getContinuityRecord(workspaceId, recordId)).toMatchObject({ recordType: 'research-note', version: 1, sourceReferencesComplete: false, authorizationComplete: true,
      authorizationRefs: [{ kind: 'research-record', sessionId, referenceId: recordId, provenanceCallId: 'call:private-note', scopeVersionId: f.original.scopeVersionId }] })
    f.store.transitionResearchRecord({ ...f.base(), requestType: 'research-record-lifecycle', recordId, expectedVersion: 1, idempotencyKey: 'note:private:edit', action: 'edit', text: 'PRIVATE_CHANGED_NOTE_BODY' })
    const updated = f.store.getContinuityRecord(workspaceId, recordId)!
    expect(updated).toMatchObject({ version: 2, identity: { kind: 'research-record', recordId, version: 2 } })
    expect(JSON.stringify(updated)).not.toMatch(/PRIVATE_|body|preview|text/)
    f.store.transitionResearchRecord({ ...f.base(), requestType: 'research-record-lifecycle', recordId, expectedVersion: 2, idempotencyKey: 'note:private:delete', action: 'delete' })
    expect(f.store.getContinuityRecord(workspaceId, recordId)).toMatchObject({ version: 3, status: 'deleted', sources: [], evidenceRefs: [], sourceReferencesComplete: false })
  })

  it('follows actual derived inputs and provenance-only Evidence, while independent current-source Claims remain unaffected', async () => {
    const f = await setup(), scope = f.compareScope(), previous = f.read(f.sources[0]!, scope, 'old-in-compare'), current = f.read(f.sources[1]!, scope, 'new-in-compare')
    const old = f.record('old-current-frame', previous, scope), independent = f.record('independent', current, scope)
    const derived = f.record('derived', current, scope, { claims: [old.claim.claimVersionId] }), artifact = f.draft('derived', derived, scope)
    const provenance = f.record('provenance-only', current, scope, { claims: [independent.claim.claimVersionId], evidence: [previous.citations[0]!.evidence!.evidenceId] })
    expect(f.store.revisionImpact(f.impact([derived.claim.claimVersionId, artifact.manifest.artifactManifestId, provenance.claim.claimVersionId, independent.claim.claimVersionId], scope)).impacts.map(item => item.status))
      .toEqual(['needs-reverify', 'needs-reverify', 'needs-reverify', 'unaffected'])
    const metadata = f.store.getContinuityRecord(workspaceId, artifact.manifest.artifactManifestId)!
    expect(metadata.authorizationComplete).toBe(true)
    expect(metadata.evidenceRefs).toEqual(expect.arrayContaining([
      { investigationId, scopeVersionId: scope.scopeVersionId, evidenceId: previous.citations[0]!.evidence!.evidenceId },
      { investigationId, scopeVersionId: scope.scopeVersionId, evidenceId: current.citations[0]!.evidence!.evidenceId },
    ]))
  })

  it('requires fresh exact-scope Read captures for both comparison sides and then journals a replayable human determination', async () => {
    const f = await setup(), oldAnswer = f.read(f.sources[0]!), old = f.record('prior', oldAnswer), scope = f.compareScope(), current = f.read(f.sources[1]!, scope, 'current')
    const request: ContinuityAssessRequest = { ...f.base(scope), requestType: 'continuity-assess', priorRecordId: old.claim.claimVersionId, priorSources: [f.sources[0]!], currentSources: [f.sources[1]!],
      proposedState: 'changed', priorEvidenceIds: [oldAnswer.citations[0]!.evidence!.evidenceId], currentEvidenceIds: [current.citations[0]!.evidence!.evidenceId], rationale: 'The reviewed source revenue figures differ.', idempotencyKey: 'continuity:compare' }
    const actor = { kind: 'user' as const, actorId: 'user:continuity' }
    expect(() => f.store.assessContinuity(request, actor)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    expect(f.store.listContinuityLinks(workspaceId, investigationId)).toEqual([])
    const fresh = f.read(f.sources[0]!, scope, 'prior-reread')
    expect(fresh.citations[0]!.evidence!.evidenceId).toBe(oldAnswer.citations[0]!.evidence!.evidenceId)
    const result = f.store.assessContinuity(request, actor)
    expect(result).toMatchObject({ status: 'created', link: { state: 'changed', verificationStatus: 'reverified', scopeVersionId: scope.scopeVersionId } })
    expect(f.store.assessContinuity(request, actor)).toMatchObject({ status: 'replayed', link: result.link })
    expect(f.store.getCanonicalEvidence(workspaceId, investigationId, f.original.scopeVersionId, request.priorEvidenceIds![0]!)?.origins).toHaveLength(1)
  })

  it('does not report unaffected when a required Answer capture is missing, even if the queried predecessor itself is available', async () => {
    const f = await setup(), scope = f.compareScope(), answer = f.read(f.sources[1]!, scope, 'missing-current'), claim = f.record('missing-current', answer, scope), artifact = f.draft('missing-current', claim, scope)
    f.mutate(database => { database.prepare('DELETE FROM answer_manifests WHERE manifest_id = ?').run(answer.manifestId) })
    expect(f.store.revisionImpact(f.impact([claim.claim.claimVersionId, artifact.manifest.artifactManifestId], scope)).impacts.map(item => item.status))
      .toEqual(['missing-source', 'missing-source'])
    expect(f.store.getContinuityRecord(workspaceId, artifact.manifest.artifactManifestId)).toMatchObject({ sourceReferencesComplete: false, authorizationComplete: false,
      evidenceRefs: [{ evidenceId: answer.citations[0]!.evidence!.evidenceId }] })
    expect(() => f.store.revisionImpact(f.impact(['record:absent'], scope))).toThrowError(expect.objectContaining({ code: 'not-found' }))
  })

  it('cannot reverify an incomplete prior record by providing fresh Evidence for only its remaining known sources', async () => {
    const f = await setup(), scope = f.compareScope(), missing = f.read(f.sources[0]!, scope, 'partial:missing'), known = f.read(f.sources[1]!, scope, 'partial:known')
    const input = f.record('partial:input', known, scope), partial = f.record('partial:derived', known, scope,
      { claims: [input.claim.claimVersionId], evidence: [missing.citations[0]!.evidence!.evidenceId] })
    f.mutate(database => { database.prepare('DELETE FROM answer_manifests WHERE manifest_id = ?').run(missing.manifestId) })
    const request: ContinuityAssessRequest = { ...f.base(scope), requestType: 'continuity-assess', priorRecordId: partial.claim.claimVersionId,
      priorSources: [f.sources[1]!], currentSources: [f.sources[1]!], priorEvidenceIds: [known.citations[0]!.evidence!.evidenceId], currentEvidenceIds: [known.citations[0]!.evidence!.evidenceId],
      idempotencyKey: 'continuity:partial-known', proposedState: 'unknown' }
    for (const proposedState of ['continuing', 'changed', 'conflicted'] as const) {
      expect(() => f.store.assessContinuity({ ...request, proposedState }, { kind: 'user', actorId: 'user:continuity' })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    }
    expect(f.store.listContinuityLinks(workspaceId, investigationId)).toEqual([])
    expect(f.store.assessContinuity(request, { kind: 'user', actorId: 'user:continuity' })).toMatchObject({ link: { state: 'unknown', verificationStatus: 'missing-source' } })
  })

  it('rejects oversized original authorization sets rather than truncating away required grants', async () => {
    const f = await setup(), answer = f.read(f.sources[0]!), claim = f.record('bounded-origins', answer)
    // The behavior under test is complete authorization resolution, not 1024 separate
    // FULL-synchronous fsyncs. Seed identical canonical Answer rows in one transaction;
    // every row still passes the real resolver's schema, hash and capture verification.
    f.mutate(database => {
      const seed = database.prepare('SELECT manifest_json FROM answer_manifests WHERE manifest_id = ?').get(answer.manifestId)
      if (typeof seed?.manifest_json !== 'string') throw new Error('Missing canonical Answer fixture')
      const template = JSON.parse(seed.manifest_json) as AnswerManifest
      const insert = database.prepare(`INSERT INTO answer_manifests
        (workspace_id, session_id, message_id, manifest_id, source_scope_version_id, manifest_json, manifest_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      database.exec('BEGIN IMMEDIATE')
      try {
        for (let index = 0; index < 1024; index++) {
          const repeated = structuredClone(template); repeated.manifestId = `manifest:repeat:${index}`; repeated.messageId = `message:repeat:${index}`
          // Replacing existing scalar values preserves the canonical key order of the
          // production-written template, including all nested immutable Evidence bytes.
          const json = JSON.stringify(repeated)
          insert.run(workspaceId, sessionId, repeated.messageId, repeated.manifestId, repeated.sourceScopeVersionId, json, hash(json), repeated.createdAt)
        }
        database.exec('COMMIT')
      } catch (error) { database.exec('ROLLBACK'); throw error }
    })
    const repeated = f.store.getAnswerManifest(workspaceId, sessionId, 'message:repeat:0')!
    expect(f.store.recordAnswerManifest(repeated)).toBe('replayed')
    const capture = f.store.getCanonicalEvidence(workspaceId, investigationId, f.original.scopeVersionId, answer.citations[0]!.evidence!.evidenceId)!
    expect(capture.origins).toHaveLength(1025)
    expect(new Set(capture.origins.map(origin => origin.kind === 'answer-read' ? `${origin.manifestId}/${origin.citationId}` : origin.actionId)).size).toBe(1025)
    expect(() => f.store.getContinuityRecord(workspaceId, claim.claim.claimVersionId)).toThrowError(expect.objectContaining({ code: 'limit-exceeded' }))
  }, 15000)

  it('rejects ambiguous chain/artifact aliases instead of choosing the first version and preserves exact frozen dependencies', async () => {
    const f = await setup(), answer = f.read(f.sources[0]!), first = f.record('versioned', answer), original = f.draft('versioned', first), context = f.context()
    f.app.handle({ ...f.base(), requestType: 'm4-conflict-search-assure', idempotencyKey: 'assure:versioned', claimVersionIds: [first.claim.claimVersionId], evidenceIds: first.provenance.inputEvidenceIds }, context)
    f.app.handle({ ...f.base(), requestType: 'm4-review-run', idempotencyKey: 'review:versioned', artifactManifestId: original.manifest.artifactManifestId, reviewResultId: 'review:versioned', ruleset: M4_PUBLISH_RULESET, signoffRequirement: 'not-required' }, context)
    f.app.handle({ ...f.base(), requestType: 'm4-artifact-publish', idempotencyKey: 'publish:versioned', artifactManifestId: original.manifest.artifactManifestId, reviewResultId: 'review:versioned', expectedStatus: 'draft' }, context)
    const second = structuredClone(first); second.idempotencyKey = 'record:versioned:v2'; second.expectedCurrentClaimVersionId = first.claim.claimVersionId
    Object.assign(second.claim, { claimVersionId: 'claim:versioned:v2', previousClaimVersionId: first.claim.claimVersionId, version: 2 })
    Object.assign(second.provenance, { derivationActivityId: 'derivation:versioned:v2', operation: 'human-edit', inputClaimVersionIds: [first.claim.claimVersionId] }); second.evidenceRelations[0]!.evidenceRelationId = 'relation:versioned:v2'
    f.app.handle(second, context)
    const next = structuredClone(original); next.idempotencyKey = 'draft:versioned:v2'; next.expectedPreviousArtifactManifestId = original.manifest.artifactManifestId
    Object.assign(next.manifest, { artifactManifestId: 'manifest:versioned:v2', previousArtifactManifestId: original.manifest.artifactManifestId, version: 2 })
    if (next.manifest.content.kind !== 'brief') throw new Error('Expected Brief')
    next.manifest.content.sections[0]!.claimUses[0]!.claimVersionId = second.claim.claimVersionId
    f.app.handle(next, context)
    for (const ambiguous of [first.claim.claimChainId, original.manifest.artifactId]) expect(() => f.store.revisionImpact(f.impact([ambiguous]))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.revisionImpact(f.impact([first.claim.claimVersionId, second.claim.claimVersionId, original.manifest.artifactManifestId, next.manifest.artifactManifestId])).impacts.every(item => item.status === 'needs-reverify')).toBe(true)
  })

  it('preserves the legacy Selection Evidence assessment contract without admitting Note/Recall identities as Evidence', async () => {
    const f = await setup(), item = selection.context.selections[0]!, source = { documentId: item.documentId, revisionId: item.revisionId, representationId: item.representationId, representationContentHash: item.representationContentHash }
    const scope: SourceScopeVersion = { ...f.original, workspaceId: selection.context.workspaceId, investigationId: selection.context.investigationId, scopeVersionId: selection.context.scopeVersionId,
      included: [{ documentId: source.documentId, revisionId: source.revisionId, role: 'primary' }] }
    f.store.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: selection.context.sessionId, idempotencyKey: 'scope:selection', scope, sources: [source] })
    f.store.recordSelectionAction(scope.workspaceId, selection.actionRequest, selection.context, selection.actionResult)
    if (selection.actionResult.record.recordType !== 'evidence-bookmark') throw new Error('Expected legacy bookmark')
    const request: ContinuityAssessRequest = { schemaVersion: 1, requestType: 'continuity-assess', sessionId: selection.context.sessionId, workspaceId: scope.workspaceId, investigationId: scope.investigationId,
      scopeVersionId: scope.scopeVersionId, priorRecordId: selection.actionResult.record.bookmarkId, priorSources: [source], currentSources: [source], proposedState: 'continuing',
      priorEvidenceIds: [selection.actionResult.evidence[0]!.evidenceId], currentEvidenceIds: [selection.actionResult.evidence[0]!.evidenceId], idempotencyKey: 'continuity:selection' }
    expect(f.store.assessContinuity(request, { kind: 'user', actorId: 'user:legacy' })).toMatchObject({ link: { verificationStatus: 'reverified' } })
    expect(f.store.getContinuityRecord(scope.workspaceId, request.priorRecordId)).toMatchObject({ recordType: 'evidence-bookmark', version: 1, authorizationComplete: true,
      authorizationRefs: [{ kind: 'selection-action', sessionId: selection.context.sessionId, referenceId: selection.actionResult.actionId, selectionContextId: selection.context.selectionContextId }] })
    expect(() => f.store.assessContinuity({ ...request, idempotencyKey: 'continuity:not-evidence', currentEvidenceIds: [request.priorRecordId] }, { kind: 'user', actorId: 'user:legacy' }))
      .toThrowError(expect.objectContaining({ code: 'not-found' }))
  })
})
