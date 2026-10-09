import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceScopeStore, ResearchScopeSnapshots, type DocumentInvocation, type SelectionResolverPort } from '@docatlas/core'
import type { AnswerManifest, DocumentLocator, DocumentRevision, LibraryDocument, ProductContinuityAssess, ProductPiCheckpoint, ProductPreparedSubmission,
  ReadResult, ResolveRequest, ResolveResult, ScopedSourceIdentity, SelectionActionResult, SelectionContext, SourceRepresentation, SourceScopeVersion } from '@docatlas/contracts'
import { ProductContinuity } from '../src/documents/continuity.js'
import { ProductReviews } from '../src/documents/reviews.js'
import { ProductResearch } from '../src/documents/research.js'
import type { ProductSelections } from '../src/documents/selections.js'
import { ProductAnswers } from '../src/documents/answers.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ControlStore } from '../src/storage/control-store.js'
import { ResearchJournal } from '../src/storage/research-journal.js'

const canonical = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as {
  documentRevision: DocumentRevision, originalRepresentation: SourceRepresentation, textRepresentation: SourceRepresentation,
}
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

/** Real domain/control/journal/Read-receipt/verified JSONL publication ports.
 * PDF resolution alone is a deterministic cache fixture, not ingestion/actual-Pi/model-quality acceptance.
 * The unused selection-mutation port is never invoked; Notebook reads use their real snapshot and journal gates.
 */
async function setup(readPriorInComparison = true) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-continuity-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const domain = await SourceScopeStore.open(join(root, 'domain')); cleanup.push(() => domain.close())
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const actor = { actorId: 'actor:continuity', workspaceId: 'workspace:continuity' }
  const binding = control.createConversation(actor, { conversationId: 'conversation:continuity', runtimeSessionId: randomUUID(), investigationId: 'investigation:continuity' })
  const receipts = new AnswerReceipts(join(root, 'answers')); cleanup.push(() => receipts.close())
  const snapshots = new ResearchScopeSnapshots(join(root, 'research-scopes')), journal = new ResearchJournal(join(root, 'research-journal'))
  const sources: ScopedSourceIdentity[] = [], locators = new Map<string, DocumentLocator>(), texts = new Map<string, string>(), originalHashes = new Map<string, string>()
  const documentId = domain.resolveLibraryImport(actor.workspaceId, 'source:annual', 'a'.repeat(64)).documentId
  const addRevision = (version: 1 | 2 | 3): ScopedSourceIdentity => {
    const revisionId = `revision:annual:${version}`, originalId = `representation:annual:${version}:pdf`, representationId = `representation:annual:${version}:text`
    const contentHash = ({ 1: 'a', 2: 'd', 3: '7' }[version]).repeat(64), representationContentHash = ({ 1: 'b', 2: 'e', 3: '8' }[version]).repeat(64), text = `Revenue increased by ${{ 1: 12, 2: 18, 3: 21 }[version]}%.`
    const source = { documentId, revisionId, representationId, representationContentHash }
    const document: LibraryDocument = { schemaVersion: 1, workspaceId: actor.workspaceId, documentId, displayName: 'Annual.pdf', mediaType: 'application/pdf', sourceRole: 'primary', status: 'ready', revisionCount: version,
      currentRevision: { ...canonical.documentRevision, documentId, revisionId, contentHash, displayName: 'Annual.pdf', ...(version > 1 ? { previousRevisionId: `revision:annual:${version - 1}` } : {}) },
      representations: [{ ...canonical.originalRepresentation, documentId, revisionId, representationId: originalId, contentHash },
        { ...canonical.textRepresentation, documentId, revisionId, representationId, contentHash: representationContentHash, derivedFromRepresentationIds: [originalId] }], activeRepresentationId: representationId,
      capabilities: ['text', 'original'], createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z' }
    domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: `library:${version}`, sourceKey: 'source:annual', rootId: 'root:fixture', relativePath: 'Annual.pdf', document })
    texts.set(revisionId, text); originalHashes.set(revisionId, contentHash)
    locators.set(revisionId, { schemaVersion: 1, locatorId: `locator:${revisionId}`, ...source, physicalPage: 17,
      selectors: [{ type: 'text-quote', exact: text, normalizedHash: hash(text) }], createdAt: '2026-08-31T00:00:00.000Z' })
    return source
  }
  sources.push(addRevision(1), addRevision(2))
  const scope = (name: string, admitted: ScopedSourceIdentity[], previous?: SourceScopeVersion): SourceScopeVersion => {
    const value: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: `scope:${name}`, workspaceId: actor.workspaceId, investigationId: binding.investigationId!, version: (previous?.version ?? 0) + 1,
      ...(previous ? { previousScopeVersionId: previous.scopeVersionId } : {}), included: admitted.map(source => ({ documentId, revisionId: source.revisionId, role: 'primary' })), excluded: [], locked: true,
      createdBy: { kind: 'user', actorId: actor.actorId }, createdAt: '2026-08-31T00:00:00.000Z' }
    domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: binding.conversationId, idempotencyKey: `commit:${name}`,
      ...(previous ? { expectedScopeVersionId: previous.scopeVersionId } : {}), scope: value, sources: admitted })
    return value
  }
  const exact = (request: ResolveRequest): ResolveResult => ({ schemaVersion: 1, resultType: 'resolve', documentId, revisionId: request.locator.revisionId, representationId: request.locator.representationId,
    locatorId: request.locator.locatorId, resolutionId: `resolve:${request.locator.revisionId}`, status: 'resolved', checkedAt: '2026-09-01T00:00:00.000Z', checkedRepresentationHash: request.locator.representationContentHash,
    exactText: texts.get(request.locator.revisionId)!, resolvedLocator: structuredClone(request.locator), candidates: [] })
  const resolver = { calls: 0, closes: 0, resolve: async (request: ResolveRequest, _signal?: AbortSignal): Promise<ResolveResult> => exact(request) }
  const answers = new ProductAnswers(receipts, domain, control, actor, () => ({ call: (async (_method: string, request: ResolveRequest, signal?: AbortSignal) => {
    resolver.calls++; return resolver.resolve(request, signal)
  }) as SelectionResolverPort['call'], async close() { resolver.closes++ } })); cleanup.push(() => answers.close())
  const research = new ProductResearch(domain, control, actor, snapshots, journal, {} as ProductSelections, answers); cleanup.push(() => research.close())
  const reviews = new ProductReviews(domain, control, actor, answers); cleanup.push(() => reviews.close())
  let serial = 0, last: string | null = null, turn = 0
  const entries: object[] = [], id = () => (++serial).toString(16).padStart(8, '0'), file = join(root, 'native.jsonl')
  const finish = (frame: SourceScopeVersion, readSources: ScopedSourceIdentity[], label: string): AnswerManifest => {
    const sourceRefs = frame.included.map(({ documentId, revisionId }) => ({ documentId, revisionId }))
    let receipt = control.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation,
      idempotencyKey: `submission:${label}`, mode: 'prompt', text: `Read ${label}.`, sourceRefs, selectionContextIds: [] }).receipt
    const lease = control.acquireWriter(actor, binding.conversationId, `writer:${label}`)
    const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
      bindingGeneration: binding.generation, scopeVersionId: frame.scopeVersionId, sourceRefs, selectionContextIds: [] }
    receipt = control.transition(lease, receipt.submissionId, receipt.version, 'preparing')
    receipt = control.transition(lease, receipt.submissionId, receipt.version, 'ready', { prepared })
    receipt = control.transition(lease, receipt.submissionId, receipt.version, 'dispatching')
    receipt = control.transition(lease, receipt.submissionId, receipt.version, 'running')
    const timestamp = receipt.updatedAt, userEntryId = id()
    entries.push({ type: 'message', id: userEntryId, parentId: last, timestamp, message: { role: 'user', content: `Read ${label}.` } }); last = userEntryId
    for (const source of readSources) {
      const callId = `call:${label}:${source.revisionId}`, callEntry = id(), locator = locators.get(source.revisionId)!, text = texts.get(source.revisionId)!
      const result: ReadResult = { schemaVersion: 1, resultType: 'read', mode: 'page', source: { documentId, revisionId: source.revisionId, representationId: source.representationId }, textQuality: 'usable',
        items: [{ itemType: 'block', blockId: `block:${source.revisionId}`, physicalPage: 17, kind: 'paragraph', text, locator }],
        pageInfo: { schemaVersion: 1, limit: 20, returned: 1, total: 1, usedChars: text.length, truncated: false, completeness: 'complete' } }
      const active: DocumentInvocation = { submissionId: receipt.submissionId, scope: { scope: frame, sources: domain.getSourceScopeVersion(actor.workspaceId, frame.scopeVersionId)!.sources },
        assertCurrent() { expect(domain.get(binding.conversationId).scope?.scopeVersionId).toBe(frame.scopeVersionId) },
        source(doc, revision) { if (doc !== documentId || revision !== source.revisionId) throw new Error('Wrong Read source'); return source }, originalHash: () => originalHashes.get(source.revisionId)! }
      receipts.recordRead(binding, active, callId, result)
      entries.push({ type: 'message', id: callEntry, parentId: last, timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name: 'docatlas_read', arguments: { documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 17 } }] } }); last = callEntry
      const resultEntry = id(); entries.push({ type: 'message', id: resultEntry, parentId: last, timestamp, message: { role: 'toolResult', toolCallId: callId, toolName: 'docatlas_read', isError: false,
        content: [{ type: 'text', text: JSON.stringify(result) }], details: { schemaVersion: 1, schema: 'docatlas.tool-meta.v1', operation: 'read', scopeVersionId: frame.scopeVersionId,
          documentIds: [documentId], locators: [locator], assetIds: [], uiSummary: 'Fixture Read', truncated: false } } }); last = resultEntry
    }
    const messageId = id(); entries.push({ type: 'message', id: messageId, parentId: last, timestamp, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text',
      text: readSources.map(source => `[${texts.get(source.revisionId)}](#docatlas.v1.support.${locators.get(source.revisionId)!.locatorId})`).join('\n') }] } }); last = messageId
    const bytes = Buffer.from([{ type: 'session', version: 3, id: binding.runtimeSessionId, cwd: '/work' }, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n'); writeFileSync(file, bytes)
    const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: receipt.submissionId, requestHash: receipt.requestHash, runtimeSessionId: binding.runtimeSessionId,
      userEntryId, leafEntryId: messageId, transcriptHash: hash(bytes), byteLength: bytes.length, entryCount: entries.length, settledAt: timestamp }
    answers.capture(binding.conversationId, file, checkpoint, prepared)
    expect(answers.get(binding.conversationId, messageId).status).toBe('unavailable')
    control.transition(lease, receipt.submissionId, receipt.version, 'completed', { checkpoint }); control.releaseWriter(lease); turn++
    const answer = answers.get(binding.conversationId, messageId)
    if (answer.status !== 'available' || !answer.manifest) throw new Error('Expected real completed publication')
    expect(answer.manifest.turn).toBe(turn); return answer.manifest
  }
  const originalScope = scope('original', [sources[0]!]), original = finish(originalScope, [sources[0]!], 'original')
  const saved = reviews.command(binding.conversationId, { schemaVersion: 1, kind: 'review-command', expectedGeneration: binding.generation, scopeVersionId: originalScope.scopeVersionId,
    idempotencyKey: 'claim:original', action: 'claim-save', expectedClaimVersionId: null, statement: texts.get(sources[0]!.revisionId)!, basis: 'document-supported', epistemicStatus: 'supported', reviewStatus: 'accepted',
    evidenceRelations: [{ evidenceId: original.citations[0]!.evidence!.evidenceId, kind: 'supports', coverage: 'full' }], derivation: { operation: 'extract', inputClaimVersionIds: [] } })
  if (saved.result.resultType !== 'm4-claim-record') throw new Error('Expected canonical original Claim')
  const claimVersionId = saved.result.claim.claimVersionId
  const comparisonScope = scope('comparison', sources, originalScope), comparison = finish(comparisonScope, readPriorInComparison ? sources : [sources[1]!], 'comparison')
  const noteScope = { ...originalScope, scopeVersionId: 'scope:note:private' }; snapshots.record(noteScope)
  const locator = locators.get(sources[0]!.revisionId)!, text = texts.get(sources[0]!.revisionId)!, createdBy = { kind: 'user' as const, actorId: actor.actorId }, createdAt = noteScope.createdAt
  const selectionContext: SelectionContext = { schemaVersion: 1, selectionContextId: 'selection:prior-note', sessionId: binding.conversationId, workspaceId: actor.workspaceId, investigationId: binding.investigationId!,
    scopeVersionId: noteScope.scopeVersionId, intent: 'ask', sourcePolicy: 'focus', retention: 'investigation-focus', createdBy, createdAt,
    selections: [{ selectionId: 'selection-item:prior-note', kind: 'text', ...sources[0]!, locators: [locator],
      content: { mediaType: 'text/plain', text, contentHash: hash(text), actualLength: [...text].length, lengthUnit: 'unicode-scalar', completeness: 'complete', truncated: false }, createdAt }] }
  const action: SelectionActionResult = { schemaVersion: 1, resultType: 'selection-action-recorded', sessionId: binding.conversationId, selectionContextId: selectionContext.selectionContextId,
    actionId: 'action:prior-note', action: 'create-note', status: 'created', locators: [locator],
    evidence: [{ schemaVersion: 1, evidenceId: 'evidence:prior-note', documentId, revisionId: sources[0]!.revisionId, representationId: sources[0]!.representationId, locatorId: locator.locatorId,
      kind: 'quote', content: { mediaType: 'text/plain', text }, contentHash: hash(text), sourceRole: 'primary', resolutionStatus: 'resolved', status: 'current', createdBy, createdAt, provenanceActivityId: 'action:prior-note' }],
    record: { schemaVersion: 1, recordType: 'research-note', noteId: 'note:prior', workspaceId: actor.workspaceId, investigationId: binding.investigationId!, selectionContextId: selectionContext.selectionContextId,
      evidenceIds: ['evidence:prior-note'], locatorIds: [locator.locatorId], version: 1, noteKind: 'commentary', body: 'PRIVATE_NOTE_INTERPRETATION_IS_NOT_EVIDENCE', status: 'active', createdBy, createdAt } }
  domain.recordSelectionAction(actor.workspaceId, { schemaVersion: 1, requestType: 'selection-action', sessionId: binding.conversationId, selectionContextId: selectionContext.selectionContextId,
    idempotencyKey: 'note:prior', nonce: `seln_${'A'.repeat(32)}`, action: 'create-note', noteKind: 'commentary', body: 'PRIVATE_NOTE_INTERPRETATION_IS_NOT_EVIDENCE' }, selectionContext, action)
  const service = new ProductContinuity(domain, control, actor, research, answers, reviews); cleanup.push(() => service.close())
  const inspect = (recordId = claimVersionId, selectedScope = comparisonScope.scopeVersionId) => service.inspect(binding.conversationId,
    { schemaVersion: 1, kind: 'continuity-inspect', expectedGeneration: binding.generation, recordId, scopeVersionId: selectedScope })
  const assess = (recordId = claimVersionId): ProductContinuityAssess => ({ schemaVersion: 1, kind: 'continuity-assess', expectedGeneration: binding.generation,
    scopeVersionId: comparisonScope.scopeVersionId, priorRecordId: recordId, expectedPriorVersion: 1, currentSources: [{ documentId, revisionId: sources[1]!.revisionId }],
    priorEvidenceIds: [original.citations[0]!.evidence!.evidenceId], currentEvidenceIds: [comparison.citations.find(item => item.locator.revisionId === sources[1]!.revisionId)!.evidence!.evidenceId],
    proposedState: 'changed', rationale: 'The two freshly checked revision figures differ.', idempotencyKey: `continuity:${recordId}` })
  return { root, domain, control, actor, binding, answers, reviews, research, service, sources, originalScope, comparisonScope, original, comparison, scope, finish, addRevision, resolver, exact, inspect, assess,
    run: (input = assess(), authorize = () => {}) => service.assess(binding.conversationId, input, authorize, new AbortController().signal) }
}

describe('authenticated product continuity of one explicit prior result', () => {
  it('filters an unrelated revoked historical scope without blocking a complete selected comparison, and rejects explicit revoked selection', async () => {
    const f = await setup(), third = f.addRevision(3), revoked = f.scope('later-revocable', [third], f.comparisonScope)
    f.finish(revoked, [third], 'later-revocable')
    f.domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: f.binding.conversationId, idempotencyKey: 'scope:exclude-third', expectedScopeVersionId: revoked.scopeVersionId,
      scope: { ...revoked, scopeVersionId: 'scope:exclude-third', previousScopeVersionId: revoked.scopeVersionId, version: revoked.version + 1,
        included: f.sources.map(source => ({ documentId: source.documentId, revisionId: source.revisionId, role: 'primary' })),
        excluded: [{ documentId: third.documentId, revisionId: third.revisionId, reason: 'policy' }] }, sources: f.sources })
    const view = f.inspect()
    expect(view).toMatchObject({ scopeVersionId: f.comparisonScope.scopeVersionId, truncated: false, scopeOptionsTruncated: false })
    expect(view.scopeOptions.map(item => item.scopeVersionId)).not.toContain(revoked.scopeVersionId)
    expect(() => f.inspect(f.assess().priorRecordId, revoked.scopeVersionId)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(await f.run()).toMatchObject({ result: { status: 'created', link: { verificationStatus: 'reverified' } } })
    expect(f.resolver.calls).toBe(2)
  })

  it('bounds historical enumeration without marking complete explicitly selected Evidence truncated or using unpublished scopes', async () => {
    const f = await setup(), later = f.scope('many-unpublished', f.sources, f.comparisonScope), answer = f.finish(later, [f.sources[1]!], 'many-unpublished')
    // Real domain candidates deliberately lack private completed publication receipts.
    // They may bound the history window but must not authorize any scope or Evidence.
    for (let index = 0; index < 129; index++) {
      const candidate = { ...structuredClone(answer), manifestId: `manifest:unpublished:${index}`, messageId: `message:unpublished:${index}`, turn: 1000 + index }
      f.domain.recordAnswerManifest(candidate)
    }
    const view = f.inspect()
    expect(view).toMatchObject({ scopeVersionId: f.comparisonScope.scopeVersionId, truncated: false, scopeOptionsTruncated: true })
    expect(view.evidence).toHaveLength(2)
    expect(view.scopeOptions.map(item => item.scopeVersionId)).toEqual([f.comparisonScope.scopeVersionId])
    expect(await f.run()).toMatchObject({ result: { status: 'created', link: { verificationStatus: 'reverified' } } })
  })

  it('does not hide a corrupt unrelated candidate as merely unavailable history', async () => {
    const f = await setup(), later = f.scope('corrupt-history', f.sources, f.comparisonScope), answer = f.finish(later, [f.sources[1]!], 'corrupt-history')
    const database = new DatabaseSync(join(f.root, 'domain', 'investigations', `${hash(f.actor.workspaceId)}.sqlite3`))
    try { database.prepare('UPDATE answer_manifests SET manifest_hash = ? WHERE manifest_id = ?').run('0'.repeat(64), answer.manifestId) } finally { database.close() }
    expect(() => f.inspect()).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it('inspects actual completed scopes, classifies dependencies, resolves both originals and records a version-pinned human determination', async () => {
    const f = await setup(), view = f.inspect(), request = f.assess()
    expect(view).toMatchObject({ kind: 'continuity-inspection', bindingId: f.binding.bindingId, generation: f.binding.generation, record: { version: 1, sourceReferencesComplete: true }, evidence: [{ physicalPage: 17 }, { physicalPage: 17 }] })
    expect(f.service.impact(f.binding.conversationId, { schemaVersion: 1, kind: 'continuity-impact', expectedGeneration: 1, recordId: request.priorRecordId,
      previousSource: { documentId: f.sources[0]!.documentId, revisionId: f.sources[0]!.revisionId }, currentSource: request.currentSources[0] })).toMatchObject({ dependencyOnly: true, status: 'needs-reverify', recordVersion: 1 })
    const result = await f.run(request)
    expect(result).toMatchObject({ kind: 'continuity-assessment', result: { status: 'created', link: { state: 'changed', verificationStatus: 'reverified', priorRecordVersion: 1, createdBy: { kind: 'user', actorId: f.actor.actorId } } } })
    expect(f.resolver.calls).toBe(2); expect(f.resolver.closes).toBe(2)
    expect(await f.run(request)).toMatchObject({ requestHash: result.requestHash, result: { status: 'replayed', link: result.result.link } })
    expect(f.resolver.calls).toBe(2)
    await expect(f.run({ ...request, rationale: 'Different product body with the same key' })).rejects.toMatchObject({ code: 'conflict' })
    expect(f.domain.listContinuityLinks(f.actor.workspaceId, f.binding.investigationId!)).toEqual([result.result.link])
  })

  it('authorizes an old Note through its real ResearchSnapshot, pins its actual version and reconciles an old receipt after later edits', async () => {
    const f = await setup(), view = f.inspect('note:prior'), request = f.assess('note:prior')
    expect(view.record).toMatchObject({ recordType: 'research-note', version: 1, sourceReferencesComplete: true })
    expect(JSON.stringify(view)).not.toContain('PRIVATE_NOTE_INTERPRETATION')
    const first = await f.run(request)
    f.research.mutate(f.binding.conversationId, { schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: 1, idempotencyKey: 'note:edit', recordId: 'note:prior', expectedVersion: 1, action: 'edit', text: 'Changed human interpretation.' })
    expect(f.inspect('note:prior').record.version).toBe(2)
    const calls = f.resolver.calls
    expect(await f.run(request)).toMatchObject({ result: { status: 'replayed', link: first.result.link } })
    expect(f.resolver.calls).toBe(calls)
    await expect(f.run({ ...request, idempotencyKey: 'continuity:stale-note-version' })).rejects.toMatchObject({ code: 'stale' })
    const next = await f.run({ ...request, expectedPriorVersion: 2, idempotencyKey: 'continuity:note:v2' })
    expect(next.result.link.priorRecordVersion).toBe(2)
    expect(f.domain.get(f.binding.conversationId).scope?.scopeVersionId).toBe(f.comparisonScope.scopeVersionId)
  })

  it('keeps a completed historical comparison frame usable after a later question without rebinding native sources', async () => {
    const f = await setup(), later = f.scope('later', [f.sources[1]!], f.comparisonScope); f.finish(later, [f.sources[1]!], 'later')
    expect(f.inspect().scopeOptions.find(item => item.scopeVersionId === f.comparisonScope.scopeVersionId)?.current).toBe(false)
    expect((await f.run()).result.link.scopeVersionId).toBe(f.comparisonScope.scopeVersionId)
    expect(f.domain.get(f.binding.conversationId).scope?.scopeVersionId).toBe(later.scopeVersionId)
  })

  it('does not borrow the old Answer capture when the new comparison scope has not re-read that source', async () => {
    const f = await setup(false)
    expect(f.inspect().evidence).toHaveLength(1)
    await expect(f.run()).rejects.toMatchObject({ code: 'permission-denied' })
    expect(f.resolver.calls).toBe(0)
    expect(f.domain.listContinuityLinks(f.actor.workspaceId, f.binding.investigationId!)).toEqual([])
  })

  it('rejects malformed authority, stale generation, foreign records/scopes, incomplete source-side coverage and Note IDs used as Evidence', async () => {
    const f = await setup(), request = f.assess()
    const foreign = new ProductContinuity(f.domain, f.control, { ...f.actor, actorId: 'actor:foreign' }, f.research, f.answers, f.reviews)
    expect(() => foreign.inspect(f.binding.conversationId, { schemaVersion: 1, kind: 'continuity-inspect', expectedGeneration: 1, recordId: request.priorRecordId })).toThrowError(expect.objectContaining({ code: 'not-found' }))
    expect(() => f.service.inspect(f.binding.conversationId, { schemaVersion: 1, kind: 'continuity-inspect', recordId: request.priorRecordId, expectedGeneration: 1, actorId: 'actor:forged' })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    await expect(f.run({ ...request, expectedGeneration: 2 })).rejects.toMatchObject({ code: 'stale' })
    for (const changed of [{ priorRecordId: 'claim:foreign' }, { scopeVersionId: 'scope:foreign' }, { priorEvidenceIds: ['note:prior'] }, { priorEvidenceIds: request.currentEvidenceIds }]) {
      await expect(f.run({ ...request, ...changed })).rejects.toMatchObject({ code: 'permission-denied' })
    }
    expect(f.resolver.calls).toBe(0)
    expect(f.domain.listContinuityLinks(f.actor.workspaceId, f.binding.investigationId!)).toEqual([])
  })

  it('does not disclose prior M4 results whose original Answer lacks its private completed publication', async () => {
    const f = await setup(), db = new DatabaseSync(join(f.root, 'answers', 'answers.sqlite3'))
    try { db.prepare("DELETE FROM records WHERE kind='answer-publication' AND id=?").run(f.original.messageId) } finally { db.close() }
    expect(() => f.inspect()).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    await expect(f.run()).rejects.toMatchObject({ code: 'permission-denied' })
    expect(f.resolver.calls).toBe(0)
  })

  it('requires actual exact resolution and rechecks concurrent Note changes before committing', async () => {
    const f = await setup(), request = f.assess('note:prior')
    f.resolver.resolve = async candidate => { const value = f.exact(candidate); value.status = 'missing'; delete value.exactText; delete value.resolvedLocator; return value }
    await expect(f.run(request)).rejects.toMatchObject({ code: 'permission-denied' })
    f.resolver.resolve = async candidate => {
      f.research.mutate(f.binding.conversationId, { schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: 1, idempotencyKey: 'note:concurrent', recordId: 'note:prior', expectedVersion: 1, action: 'edit', text: 'Edited during source resolution.' })
      return f.exact(candidate)
    }
    await expect(f.run(request)).rejects.toMatchObject({ code: 'stale' })
    expect(f.resolver.closes).toBe(f.resolver.calls)
    expect(f.domain.listContinuityLinks(f.actor.workspaceId, f.binding.investigationId!)).toEqual([])
  })

  it('reauthorizes an existing receipt after the final authorization callback before disclosing it', async () => {
    const f = await setup(), request = f.assess(), original = await f.run(request)
    let checks = 0
    await expect(f.run(request, () => {
      if (++checks !== 2) return
      f.domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: f.binding.conversationId, idempotencyKey: 'scope:policy-revocation', expectedScopeVersionId: f.comparisonScope.scopeVersionId,
        scope: { ...f.comparisonScope, scopeVersionId: 'scope:policy-revocation', previousScopeVersionId: f.comparisonScope.scopeVersionId, version: f.comparisonScope.version + 1,
          included: [{ documentId: f.sources[1]!.documentId, revisionId: f.sources[1]!.revisionId, role: 'primary' }],
          excluded: [{ documentId: f.sources[0]!.documentId, revisionId: f.sources[0]!.revisionId, reason: 'policy' }] }, sources: [f.sources[1]!] })
    })).rejects.toMatchObject({ code: 'permission-denied' })
    expect(f.resolver.calls).toBe(2)
    expect(f.domain.listContinuityLinks(f.actor.workspaceId, f.binding.investigationId!)).toEqual([original.result.link])
  })

  it('aborts and joins pending original resolution when the continuity service closes', async () => {
    const f = await setup(), started = Promise.withResolvers<void>()
    f.resolver.resolve = async (_request, signal) => {
      started.resolve()
      return new Promise((_resolve, reject) => {
        const stop = () => reject(new Error('cache resolution aborted'))
        signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
      })
    }
    const work = f.run(), rejected = expect(work).rejects.toThrow()
    await started.promise; await f.service.close(); await rejected
    expect(f.resolver.closes).toBeGreaterThanOrEqual(f.resolver.calls)
    expect(f.domain.listContinuityLinks(f.actor.workspaceId, f.binding.investigationId!)).toEqual([])
  })
})
