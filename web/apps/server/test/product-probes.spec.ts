import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalizationStore, SourceScopeStore, type DocumentInvocation } from '@docatlas/core'
import type { DocumentLocator, DocumentRevision, LibraryDocument, ProductPiCheckpoint, ProductPreparedSubmission, ProductProbeChoose,
  ProductProbePrepare, ProductProbeReview, ProductProbeView, ReadResult, ScopedSourceIdentity, SourceRepresentation, SourceScopeVersion } from '@docatlas/contracts'
import { ProductAnswers } from '../src/documents/answers.js'
import { ProductProbes } from '../src/personalization/probes.js'
import { workspaceProfileId } from '../src/personalization/service.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ControlStore } from '../src/storage/control-store.js'

const canonical = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as {
  documentRevision: DocumentRevision, originalRepresentation: SourceRepresentation, textRepresentation: SourceRepresentation,
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks() })

/** Actual Library/domain/control/profile journals, successful Read receipt, verified native-shaped
 * checkpoint projection and private completed publication. No fake available-answer port.
 * PDF bytes/model execution are outside this host test; this renderer recipe must not invoke either.
 */
async function setup(options: { complete?: boolean, leafRole?: 'assistant' | 'user' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-probes-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const domain = await SourceScopeStore.open(join(root, 'domain')); cleanup.push(() => domain.close())
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const actor = { actorId: 'actor:probes', workspaceId: 'workspace:probes' }
  const binding = control.createConversation(actor, { conversationId: 'conversation:probes', runtimeSessionId: randomUUID(), investigationId: 'investigation:probes' })
  const receipts = new AnswerReceipts(join(root, 'answers')); cleanup.push(() => receipts.close())
  const profile = await PersonalizationStore.open(join(root, 'profile-domain')); cleanup.push(() => profile.close())
  const profileId = workspaceProfileId(actor), sourceHash = 'a'.repeat(64), textHash = 'b'.repeat(64)
  const documentId = domain.resolveLibraryImport(actor.workspaceId, 'source:annual', sourceHash).documentId
  const source: ScopedSourceIdentity = { documentId, revisionId: 'revision:annual:1', representationId: 'representation:annual:text', representationContentHash: textHash }
  const originalId = 'representation:annual:pdf', createdAt = '2026-09-01T00:00:00.000Z'
  const document: LibraryDocument = { schemaVersion: 1, workspaceId: actor.workspaceId, documentId, displayName: 'Annual.pdf', mediaType: 'application/pdf', sourceRole: 'primary', status: 'ready', revisionCount: 1,
    currentRevision: { ...canonical.documentRevision, documentId, revisionId: source.revisionId, contentHash: sourceHash, displayName: 'Annual.pdf' },
    representations: [{ ...canonical.originalRepresentation, documentId, revisionId: source.revisionId, representationId: originalId, contentHash: sourceHash },
      { ...canonical.textRepresentation, documentId, revisionId: source.revisionId, representationId: source.representationId, contentHash: textHash, derivedFromRepresentationIds: [originalId] }],
    activeRepresentationId: source.representationId, capabilities: ['text', 'original'], createdAt, updatedAt: createdAt }
  domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: 'library:annual', sourceKey: 'source:annual', rootId: 'root:fixture', relativePath: 'Annual.pdf', document })
  const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: 'scope:probe:original', workspaceId: actor.workspaceId, investigationId: binding.investigationId!, version: 1,
    included: [{ documentId, revisionId: source.revisionId, role: 'primary' }], excluded: [], locked: true, createdBy: { kind: 'user', actorId: actor.actorId }, createdAt }
  domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: binding.conversationId, idempotencyKey: 'scope:original', scope, sources: [source] })
  let readers = 0
  const answers = new ProductAnswers(receipts, domain, control, actor, () => { readers++; throw new Error('A presentation recipe cannot start a PDF resolver') }); cleanup.push(() => answers.close())
  const sourceRefs = [{ documentId, revisionId: source.revisionId }], text = 'Revenue increased by 12%.', messageId = '44444444'
  const locator: DocumentLocator = { schemaVersion: 1, locatorId: 'locator:annual:17', ...source, physicalPage: 17,
    selectors: [{ type: 'text-quote', exact: text, normalizedHash: hash(text) }], createdAt }
  let receipt = control.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation,
    idempotencyKey: 'submission:original', mode: 'prompt', text: 'Summarize the annual report.', sourceRefs, selectionContextIds: [] }).receipt
  const lease = control.acquireWriter(actor, binding.conversationId, 'writer:probe-fixture')
  const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
    bindingGeneration: binding.generation, scopeVersionId: scope.scopeVersionId, sourceRefs, selectionContextIds: [] }
  for (const state of ['preparing', 'ready', 'dispatching', 'running'] as const) receipt = control.transition(lease, receipt.submissionId, receipt.version, state, state === 'ready' ? { prepared } : undefined)
  const read: ReadResult = { schemaVersion: 1, resultType: 'read', mode: 'page', source: { documentId, revisionId: source.revisionId, representationId: source.representationId }, textQuality: 'usable',
    items: [{ itemType: 'block', blockId: 'block:annual:17', physicalPage: 17, kind: 'paragraph', text, locator }],
    pageInfo: { schemaVersion: 1, limit: 20, returned: 1, total: 1, usedChars: text.length, truncated: false, completeness: 'complete' } }
  const invocation: DocumentInvocation = { submissionId: receipt.submissionId, scope: { scope, sources: [source] },
    assertCurrent() { if (domain.get(binding.conversationId).scope?.scopeVersionId !== scope.scopeVersionId) throw new Error('Read frame changed') },
    source(doc, revision) { if (doc !== documentId || revision !== source.revisionId) throw new Error('Read source changed'); return source }, originalHash: () => sourceHash }
  receipts.recordRead(binding, invocation, 'call:read', read)
  const timestamp = receipt.updatedAt, answerText = `[${text}](#docatlas.v1.support.${locator.locatorId})\nThe outlook remains uncertain.`
  const entries = [
    { type: 'message', id: '11111111', parentId: null, timestamp, message: { role: 'user', content: 'Summarize the annual report.' } },
    { type: 'message', id: '22222222', parentId: '11111111', timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call:read', name: 'docatlas_read', arguments: { documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 17 } }] } },
    { type: 'message', id: '33333333', parentId: '22222222', timestamp, message: { role: 'toolResult', toolCallId: 'call:read', toolName: 'docatlas_read', isError: false,
      content: [{ type: 'text', text: JSON.stringify(read) }], details: { schemaVersion: 1, schema: 'docatlas.tool-meta.v1', operation: 'read', scopeVersionId: scope.scopeVersionId, documentIds: [documentId], locators: [locator], assetIds: [], uiSummary: 'Original Read', truncated: false } } },
    { type: 'message', id: messageId, parentId: '33333333', timestamp, message: options.leafRole === 'user'
      ? { role: 'user', content: answerText } : { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: answerText }] } },
  ]
  const file = join(root, 'native.jsonl'), bytes = Buffer.from([{ type: 'session', version: 3, id: binding.runtimeSessionId, cwd: '/work' }, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  writeFileSync(file, bytes)
  const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: receipt.submissionId, requestHash: receipt.requestHash, runtimeSessionId: binding.runtimeSessionId,
    userEntryId: '11111111', leafEntryId: messageId, transcriptHash: hash(bytes), byteLength: bytes.length, entryCount: entries.length, settledAt: timestamp }
  const publish = () => answers.capture(binding.conversationId, file, checkpoint, prepared)
  if (options.leafRole === 'user') expect(publish).toThrow('Native answer did not finish')
  else publish()
  expect(answers.get(binding.conversationId, messageId).status).toBe('unavailable')
  const complete = () => { receipt = control.transition(lease, receipt.submissionId, receipt.version, 'completed', { checkpoint }); control.releaseWriter(lease) }
  if (options.complete !== false && options.leafRole !== 'user') complete()
  const changes: Array<{ actorId: string, workspaceId: string, conversationId: string }> = [], order = { calls: 0, evidenceLeft: true }
  const probes = new ProductProbes(profile, control, answers, workspaceProfileId, (who, conversationId) => changes.push({ ...who, conversationId }),
    () => new Date('2026-09-09T00:00:00.000Z'), () => { order.calls++; return order.evidenceLeft })
  const base = { schemaVersion: 1 as const, expectedGeneration: binding.generation, messageId }
  const inspect = () => probes.inspect(actor, binding.conversationId, { ...base, kind: 'probe-inspect' })
  const prepareInput = (): ProductProbePrepare => ({ ...base, kind: 'probe-prepare', expectedProfileEpoch: profile.peekProfile(profileId, binding.conversationId).profileEpoch,
    expectedPolicyVersion: profile.peekProfile(profileId, binding.conversationId).sessionPolicy?.version ?? 0 })
  const prepare = () => probes.prepare(actor, binding.conversationId, prepareInput())
  const policy = (enabled: boolean) => {
    const expectedVersion = profile.peekProfile(profileId, binding.conversationId).sessionPolicy?.version ?? 0
    return profile.command({ schemaVersion: 1, requestType: 'personalization-command', profileId, sessionId: binding.conversationId, actor: { kind: 'user', actorId: actor.actorId },
      action: 'set-session-policy', idempotencyKey: `policy:${expectedVersion}`, expectedVersion, policy: { useExisting: true, contributeToFuture: enabled } }, profile.peekProfile(profileId, binding.conversationId).profileEpoch)
  }
  const choiceInput = (view: ProductProbeView = inspect()): ProductProbeChoose => ({ ...base, kind: 'probe-choose', expectedProfileEpoch: view.profileEpoch,
    expectedPolicyVersion: view.policyVersion, probeId: view.probe!.probeId, idempotencyKey: 'product:choice:one', selected: 'variant:evidence-first', scopeIntent: 'workspace', reasonTags: ['easier-verification'] })
  const choose = (input = choiceInput()) => probes.choose(actor, binding.conversationId, input)
  const reviewInput = (): ProductProbeReview => { const view = inspect(); return { ...base, kind: 'probe-review', expectedProfileEpoch: view.profileEpoch,
    probeId: view.probe!.probeId, candidateId: view.candidate!.candidateId, expectedCandidateVersion: 1, decision: 'accept', idempotencyKey: 'product:review:one' } }
  const review = (input = reviewInput()) => probes.review(actor, binding.conversationId, input)
  const revokePublication = () => {
    const database = new DatabaseSync(join(root, 'answers', 'answers.sqlite3'))
    try { database.prepare("DELETE FROM records WHERE kind = 'answer-publication' AND id = ?").run(messageId) } finally { database.close() }
  }
  const revokeSource = () => {
    const next: ScopedSourceIdentity = { ...source, revisionId: 'revision:annual:2', representationId: 'representation:annual:2:text', representationContentHash: 'e'.repeat(64) }
    const originalId = 'representation:annual:2:pdf'
    domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: 'library:annual:2', sourceKey: 'source:annual', rootId: 'root:fixture', relativePath: 'Annual.pdf',
      document: { ...document, revisionCount: 2, currentRevision: { ...document.currentRevision, revisionId: next.revisionId, previousRevisionId: source.revisionId, contentHash: 'd'.repeat(64) },
        representations: [{ ...document.representations[0]!, revisionId: next.revisionId, representationId: originalId, contentHash: 'd'.repeat(64) },
          { ...document.representations[1]!, revisionId: next.revisionId, representationId: next.representationId, contentHash: next.representationContentHash, derivedFromRepresentationIds: [originalId] }],
        activeRepresentationId: next.representationId } })
    return domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: binding.conversationId, idempotencyKey: 'scope:revoked', expectedScopeVersionId: scope.scopeVersionId,
      scope: { ...scope, scopeVersionId: 'scope:revoked', previousScopeVersionId: scope.scopeVersionId, version: 2,
        included: [{ documentId, revisionId: next.revisionId, role: 'primary' }], excluded: [{ documentId, revisionId: source.revisionId, reason: 'policy' }] }, sources: [next] })
  }
  return { root, domain, control, profile, actor, binding, profileId, answers, probes, source, scope, locator, file, checkpoint, messageId, base,
    order, changes, inspect, prepare, prepareInput, policy, choiceInput, choose, reviewInput, review, revokePublication, revokeSource, publish, complete, readers: () => readers }
}

describe('ProductProbes over actual completed Answer publication and profile persistence', () => {
  it('inspects without creating a profile or changing history and requires contribution before preparing or choosing', async () => {
    const f = await setup(), native = readFileSync(f.file), manifest = f.domain.getAnswerManifest(f.actor.workspaceId, f.binding.conversationId, f.messageId)!
    expect(existsSync(f.profile.databasePath(f.profileId))).toBe(false)
    const view = f.inspect()
    expect(view).toMatchObject({ reason: 'ready', contributionAllowed: false, policyVersion: 0, profileEpoch: 0, probe: null, choiceReceipt: null, candidate: null,
      material: { manifest, nativeTextHash: expect.any(String) } })
    expect(existsSync(f.profile.databasePath(f.profileId))).toBe(false); expect(readFileSync(f.file)).toEqual(native)
    f.policy(false)
    expect(() => f.prepare()).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    f.policy(true); const prepared = f.prepare(), request = f.choiceInput(prepared); f.policy(false)
    expect(() => f.choose(request)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(f.inspect().choiceReceipt).toBeNull(); expect(f.profile.currentMemories(f.profileId)).toEqual([]); expect(f.readers()).toBe(0)
  })

  it('keeps one stable original presentation order and complete factual backbone without creating fake M4 Claims', async () => {
    const f = await setup(); f.policy(true); const first = f.prepare(), revision = f.profile.ledgerRevision(f.profileId)
    expect(first.probe).toMatchObject({ axis: 'answer-order', trigger: 'user-requested', presentationOrder: ['variant:evidence-first', 'variant:answer-first'],
      backbone: { claimVersionIds: [], evidenceAtomIds: [first.material!.manifest.citations[0]!.evidence!.evidenceId], uncertaintyIds: expect.any(Array) } })
    expect(first.probe!.backbone.uncertaintyIds.length).toBeGreaterThan(0)
    f.order.evidenceLeft = false
    expect(f.prepare()).toEqual(first); expect(f.order.calls).toBe(1); expect(f.profile.ledgerRevision(f.profileId)).toBe(revision)
    expect(f.profile.currentMemories(f.profileId)).toEqual([]); expect(f.readers()).toBe(0)
  })

  it('records only a pending proposal, requires independent confirmation, and replays original choice inputs after candidate v2 without extra notification', async () => {
    const f = await setup(); f.policy(true); const prepared = f.prepare(), request = f.choiceInput(prepared), chosen = f.choose(request)
    expect(chosen).toMatchObject({ status: 'created', candidateId: expect.any(String), choice: { selected: 'variant:evidence-first', scopeIntent: 'workspace' } })
    expect(f.inspect().candidate).toMatchObject({ version: 1, decision: 'pending', observationIds: [expect.any(String)] })
    expect(f.profile.currentMemories(f.profileId)).toEqual([]); expect(f.changes).toEqual([])
    // Contribution opt-out forbids new probes/choices, not a separate explicit
    // review of an already-recorded candidate or an authorized immutable replay.
    f.policy(false)
    const confirm = f.reviewInput(), result = f.review(confirm)
    expect(result).toMatchObject({ result: { candidate: { version: 2, decision: 'promote' }, memoryVersion: { status: 'active', effect: { key: 'answer-order', value: 'evidence-first' } } } })
    expect(f.profile.currentMemories(f.profileId)).toHaveLength(1); expect(f.changes).toEqual([{ ...f.actor, conversationId: f.binding.conversationId }])
    expect(f.choose(request)).toEqual({ ...chosen, status: 'replayed' })
    expect(f.inspect().candidate).toMatchObject({ version: 2, decision: 'promote' })
    expect(f.review(confirm).result.status).toBe('replayed'); expect(f.changes).toHaveLength(1); expect(f.readers()).toBe(0)
  })

  it('does not treat provisional/canonical-only or user-role checkpoint text as a published assistant Answer', async () => {
    const f = await setup({ complete: false }); f.policy(true)
    expect(f.domain.getAnswerManifest(f.actor.workspaceId, f.binding.conversationId, f.messageId)).toBeDefined()
    expect(f.inspect()).toMatchObject({ reason: 'answer-unavailable', material: null, probe: null })
    expect(() => f.prepare()).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    f.complete(); expect(f.inspect().reason).toBe('ready')
    const user = await setup({ leafRole: 'user' }); user.policy(true)
    expect(user.inspect()).toMatchObject({ reason: 'answer-unavailable', material: null })
    expect(() => user.prepare()).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(user.domain.getAnswerManifest(user.actor.workspaceId, user.binding.conversationId, user.messageId)).toBeUndefined()
  })

  it('enforces one vote across distinct keys and exact full-body replay without accepting caller-provided facts or another original', async () => {
    const f = await setup(); f.policy(true); f.prepare(); const input = f.choiceInput(), first = f.choose(input), revision = f.profile.ledgerRevision(f.profileId)
    expect(() => f.choose({ ...input, idempotencyKey: 'product:choice:other' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.choose({ ...input, reasonTags: ['faster-understanding'] })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.choose({ ...input, probeId: 'probe:foreign' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.choose({ ...input, messageId: '11111111' })).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.probes.prepare(f.actor, f.binding.conversationId, { ...f.prepareInput(), materialHash: 'a'.repeat(64) })).toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    expect(f.choose(input)).toEqual({ ...first, status: 'replayed' }); expect(f.profile.ledgerRevision(f.profileId)).toBe(revision)
  })

  it('rejects foreign actor/workspace, stale binding generations and old profile epochs without resurrecting forgotten choices', async () => {
    const f = await setup(); f.policy(true); const original = f.prepare(), choice = f.choiceInput(original); f.choose(choice)
    for (const actor of [{ ...f.actor, actorId: 'actor:foreign' }, { ...f.actor, workspaceId: 'workspace:foreign' }]) {
      expect(() => f.probes.inspect(actor, f.binding.conversationId, { ...f.base, kind: 'probe-inspect' })).toThrow()
      expect(existsSync(f.profile.databasePath(workspaceProfileId(actor)))).toBe(false)
    }
    expect(() => f.probes.inspect(f.actor, f.binding.conversationId, { ...f.base, kind: 'probe-inspect', expectedGeneration: 2 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    f.profile.command({ schemaVersion: 1, requestType: 'personalization-command', profileId: f.profileId, sessionId: f.binding.conversationId, actor: { kind: 'user', actorId: f.actor.actorId },
      action: 'forget', idempotencyKey: 'erase:profile', target: 'profile', expectedProfileRevision: f.profile.ledgerRevision(f.profileId), mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true }, 0)
    expect(f.inspect()).toMatchObject({ profileEpoch: 1, probe: null, choiceReceipt: null, candidate: null })
    expect(() => f.choose(choice)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.probes.prepare(f.actor, f.binding.conversationId, { ...f.prepareInput(), expectedProfileEpoch: 0 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    const before = f.control.binding(f.actor, f.binding.conversationId)
    f.control.rebind(f.actor, f.binding.conversationId, before.version, randomUUID(), null)
    expect(() => f.inspect()).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })

  it.each(['publication', 'source'] as const)('reauthorizes original %s before inspecting, choosing, replaying or confirming', async revocation => {
    const f = await setup(); f.policy(true); f.prepare(); const choice = f.choiceInput(); f.choose(choice); const review = f.reviewInput(), revision = f.profile.ledgerRevision(f.profileId)
    if (revocation === 'publication') f.revokePublication(); else f.revokeSource()
    if (revocation === 'publication') expect(f.inspect()).toMatchObject({ reason: 'answer-unavailable', material: null, choiceReceipt: null, candidate: null })
    else expect(() => f.inspect()).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.choose(choice)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(() => f.review(review)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(f.profile.ledgerRevision(f.profileId)).toBe(revision); expect(f.profile.currentMemories(f.profileId)).toEqual([]); expect(f.changes).toEqual([])
  })

  it('rolls back candidate acceptance and its receipt when the real private publication disappears at the final in-transaction authority check', async () => {
    const f = await setup(); f.policy(true); f.prepare(); f.choose(); const request = f.reviewInput(), candidate = f.inspect().candidate!, revision = f.profile.ledgerRevision(f.profileId)
    const original = f.answers.get.bind(f.answers); let reads = 0
    const gate = vi.spyOn(f.answers, 'get').mockImplementation((...args) => {
      if (++reads === 4) f.revokePublication()
      return original(...args)
    })
    expect(() => f.review(request)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    expect(reads).toBe(4); expect(f.profile.candidate(f.profileId, candidate.candidateId)).toEqual(candidate)
    expect(f.profile.currentMemories(f.profileId)).toEqual([]); expect(f.profile.ledgerRevision(f.profileId)).toBe(revision); expect(f.changes).toEqual([])
    gate.mockRestore(); f.publish()
    expect(f.review(request).result.status).toBe('updated'); expect(f.profile.currentMemories(f.profileId)).toHaveLength(1); expect(f.changes).toHaveLength(1)
  })

  it('fails closed when stored canonical Answer bytes no longer match the original private publication seal', async () => {
    const f = await setup(); f.policy(true); f.prepare(); const revision = f.profile.ledgerRevision(f.profileId)
    const database = new DatabaseSync(join(f.root, 'domain', 'investigations', `${hash(f.actor.workspaceId)}.sqlite3`))
    try {
      const answer = f.domain.getAnswerManifest(f.actor.workspaceId, f.binding.conversationId, f.messageId)!
      answer.createdAt = '2026-09-09T01:00:00.000Z'
      const json = JSON.stringify(answer)
      database.prepare('UPDATE answer_manifests SET manifest_json = ?, manifest_hash = ? WHERE message_id = ?').run(json, hash(json), f.messageId)
    } finally { database.close() }
    expect(() => f.inspect()).toThrowError(expect.objectContaining({ code: 'invalid-output' }))
    expect(() => f.prepare()).toThrowError(expect.objectContaining({ code: 'invalid-output' }))
    expect(f.profile.ledgerRevision(f.profileId)).toBe(revision)
  })
})
