import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DocumentSession, ResearchScopeSnapshots, SourceScopeStore, enrichmentHash, type SelectionResolverPort } from '@docatlas/core'
import type { LibraryDocument, NoteSave, NotebookMutation, ProductBinding, ProductPreparedSubmission, ProductSubmission, ReadResult, ResolveRequest, ResolveResult, SelectionActionRequest } from '@docatlas/contracts'
import { ControlStore, type WriterLease } from '../src/storage/control-store.js'
import { ResearchJournal } from '../src/storage/research-journal.js'
import { SelectionTickets } from '../src/storage/selection-tickets.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ProductResearch } from '../src/documents/research.js'
import { ProductSelections } from '../src/documents/selections.js'
import { ProductAnswers } from '../src/documents/answers.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const library = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/library.json', import.meta.url), 'utf8')) as { document: LibraryDocument }
const pageText = 'Margin definition is gross profit divided by revenue.'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Real domain/control/journal stores with a typed deterministic cache-only text/quote resolver.
 * Actual PDF parsing and the isolated Pi app are covered separately, not simulated by this fixture.
 */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-research-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const actor = { actorId: 'actor:product-research', workspaceId: 'workspace:product-research' }, control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const first = control.createManagedConversation(actor, 'research:first-conversation').binding, second = control.createManagedConversation(actor, 'research:second-conversation').binding
  const domain = await SourceScopeStore.open(join(root, 'domain')); cleanup.push(() => domain.close())
  const document = { ...structuredClone(library.document), workspaceId: actor.workspaceId }
  document.documentId = domain.resolveLibraryImport(actor.workspaceId, 'research-source-one', document.currentRevision.contentHash).documentId
  document.currentRevision.documentId = document.documentId
  for (const representation of document.representations) representation.documentId = document.documentId
  domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: 'research:library:one', sourceKey: 'research-source-one', rootId: 'fixture', relativePath: 'report.pdf', document })
  const other = structuredClone(document)
  other.documentId = domain.resolveLibraryImport(actor.workspaceId, 'research-source-two', 'c'.repeat(64)).documentId
  other.currentRevision.documentId = other.documentId; other.currentRevision.revisionId += ':other'; other.currentRevision.contentHash = 'c'.repeat(64)
  other.activeRepresentationId += ':other'
  for (const representation of other.representations) {
    representation.documentId = other.documentId; representation.revisionId = other.currentRevision.revisionId; representation.representationId += ':other'
    representation.derivedFromRepresentationIds = representation.derivedFromRepresentationIds.map(id => `${id}:other`)
    representation.contentHash = representation.kind === 'original-bytes' ? 'c'.repeat(64) : 'd'.repeat(64)
  }
  domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: 'research:library:two', sourceKey: 'research-source-two', rootId: 'fixture', relativePath: 'other.pdf', document: other })
  const source = domain.getEligibleLibrarySource(actor.workspaceId, document.documentId, document.currentRevision.revisionId)!
  const resolver: SelectionResolverPort['call'] = (async (method: string, request: Record<string, unknown>) => {
    if (method === 'read') {
      const identity = request.source as ReadResult['source']
      return { schemaVersion: 1, resultType: 'read', mode: 'page', source: identity, textQuality: 'usable', items: [{ itemType: 'block', blockId: 'block:research', physicalPage: 1,
        kind: 'paragraph', text: pageText, locator: { schemaVersion: 1, locatorId: 'loc:research-page', ...source, physicalPage: 1,
          selectors: [{ type: 'text-position', start: 0, end: [...pageText].length, unit: 'unicode-scalar' }], createdAt: new Date().toISOString() } }],
        pageInfo: { schemaVersion: 1, limit: 200, returned: 1, total: 1, usedChars: [...pageText].length, truncated: false, completeness: 'complete' } } as ReadResult
    }
    const locator = (request as unknown as ResolveRequest).locator, position = locator.selectors.find(item => item.type === 'text-position')!
    if (position.type !== 'text-position') throw new Error('Expected exact scalar positions')
    const exactText = [...pageText].slice(position.start, position.end).join('')
    return { schemaVersion: 1, resultType: 'resolve', documentId: locator.documentId, revisionId: locator.revisionId, representationId: locator.representationId,
      resolutionId: 'resolve:research', locatorId: locator.locatorId, status: 'resolved', checkedRepresentationHash: locator.representationContentHash, checkedAt: new Date().toISOString(), exactText,
      resolvedLocator: { ...locator, selectors: [...locator.selectors.filter(item => item.type !== 'text-quote'), { type: 'text-quote', exact: exactText, normalizedHash: sha(exactText) }] }, candidates: [] } as ResolveResult
  }) as SelectionResolverPort['call']
  const reader = () => ({ call: resolver, close: async () => {} })
  const tickets = new SelectionTickets(join(root, 'tickets')); cleanup.push(() => tickets.close())
  const selections = new ProductSelections(tickets, domain, id => control.binding(actor, id), reader); cleanup.push(() => selections.close())
  const answerReceipts = new AnswerReceipts(join(root, 'answer-receipts')); cleanup.push(() => answerReceipts.close())
  const answers = new ProductAnswers(answerReceipts, domain, control, actor, reader); cleanup.push(() => answers.close())
  let research = new ProductResearch(domain, control, actor, new ResearchScopeSnapshots(join(root, 'snapshots')), new ResearchJournal(join(root, 'journal')), selections, answers)
  cleanup.push(() => research.close())
  const leases = new Map<string, WriterLease>(), sessions = new Map<string, DocumentSession>()
  const prepare = (binding: ProductBinding, key: string, refs: ProductSubmission['sourceRefs'] = []) => {
    let session = sessions.get(binding.conversationId)
    if (!session) { session = new DocumentSession(domain, { conversationId: binding.conversationId, workspaceId: actor.workspaceId, actorId: actor.actorId, runtimeSessionId: binding.runtimeSessionId }, () => { control.binding(actor, binding.conversationId) }); sessions.set(binding.conversationId, session) }
    const request: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation, idempotencyKey: `research:submission:${key}`, mode: 'prompt', text: key, sourceRefs: refs, selectionContextIds: [] }
    const receipt = control.accept(actor, request).receipt, prepared = session.prepare(request, receipt), consumeResearch = research.prepare(request, receipt, prepared.prepared)
    const lease = leases.get(binding.conversationId) ?? control.acquireWriter(actor, binding.conversationId, `worker:${key}`); leases.set(binding.conversationId, lease)
    return { request, receipt, prepared, session, consume: () => { prepared.onConsumed(); consumeResearch() }, dispatch: () => {
      let current = control.get(actor, receipt.submissionId)
      current = control.transition(lease, current.submissionId, current.version, 'preparing')
      current = control.transition(lease, current.submissionId, current.version, 'ready', { prepared: prepared.prepared })
      current = control.transition(lease, current.submissionId, current.version, 'dispatching')
      return control.transition(lease, current.submissionId, current.version, 'running')
    } }
  }
  const query = (binding = first) => research.query(binding.conversationId, { schemaVersion: 1, kind: 'notebook-query', expectedGeneration: binding.generation, view: 'workspace', maxItems: 20, maxChars: 4000 })
  const stage = async (binding = first) => selections.stage(binding.conversationId, { schemaVersion: 1, kind: 'selection-stage', expectedGeneration: binding.generation,
    idempotencyKey: `research:selection:${binding.conversationId}`, proposals: [{ documentId: source.documentId, revisionId: source.revisionId, physicalPage: 1, quote: 'gross profit divided by revenue' }] }, () => {}, new AbortController().signal)
  return { root, actor, control, domain, first, second, source, document, other, selections, answers, prepare, query, stage,
    get research() { return research }, reopen: () => { research.close(); research = new ProductResearch(domain, control, actor, new ResearchScopeSnapshots(join(root, 'snapshots')), new ResearchJournal(join(root, 'journal')), selections, answers) } }
}

it('records in a consumed no-document frame, preserves raw native provenance on retry and recalls across conversations/reopen', async () => {
  const f = await fixture(), run = f.prepare(f.first, 'first'), operations = f.research.forConversation(f.first.conversationId)
  await expect(operations.record('call:premature', { kind: 'checkpoint', body: 'premature' })).rejects.toThrow('No consumed')
  run.dispatch(); run.consume()
  expect(run.prepared.prepared.scopeVersionId).toBeNull(); expect(() => run.session.invocation()).toThrow('No document')
  const args = { kind: 'checkpoint', body: 'Margin assumptions remain unverified across sessions.' }, nativeId = 'call_actual|fc_actual'
  const first = await operations.record(nativeId, args), retried = await operations.record(nativeId, args)
  expect(retried).toEqual({ ...first, status: 'replayed' })
  const proof = f.research.journal.forRecord(f.actor, first.record.recordId)!
  expect(proof).toMatchObject({ nativeToolCallId: nativeId, wireCallId: first.record.provenanceCallId, submissionId: run.receipt.submissionId, recordId: first.record.recordId })
  expect(f.research.snapshots.get(f.actor.workspaceId, proof.scopeVersionId)?.included).toEqual([])
  expect(f.domain.get(f.first.conversationId).status).toBe('unbound')
  f.reopen()
  const next = f.prepare(f.second, 'second'); next.dispatch(); next.consume()
  const recall = await f.research.forConversation(f.second.conversationId).recall({ query: 'margin' })
  expect(recall.leads).toHaveLength(1); expect(recall.leads[0]).toMatchObject({ recordId: first.record.recordId, sourceSessionId: f.first.conversationId, verificationStatus: 'unverified-lead', sourceState: 'none' })
  expect(f.research.get(f.second.conversationId, first.record.recordId).text).toBe(args.body)
  expect(JSON.stringify(f.query(f.second))).not.toContain(nativeId)
})

it('does not activate queued frames, accepts a new exact-consumption frame and rejects cancelled execution', async () => {
  const f = await fixture(), first = f.prepare(f.first, 'active'); first.dispatch(); first.consume()
  const next = f.prepare(f.first, 'queued'), operations = f.research.forConversation(f.first.conversationId)
  const before = await operations.record('call:before', { kind: 'checkpoint', body: 'Active frame note' })
  expect(f.research.journal.forRecord(f.actor, before.record.recordId)!.submissionId).toBe(first.receipt.submissionId)
  next.dispatch(); next.consume()
  const after = await operations.record('call:after', { kind: 'checkpoint', body: 'New frame note' })
  expect(f.research.journal.forRecord(f.actor, after.record.recordId)!.submissionId).toBe(next.receipt.submissionId)
  const current = f.control.get(f.actor, next.receipt.submissionId); f.control.requestCancel(f.actor, current.submissionId, current.version)
  await expect(operations.record('call:cancelled', { kind: 'checkpoint', body: 'Must not save' })).rejects.toThrow('executing submission')
})

it('exposes a lazy fact-trace frame only for the exactly consumed, currently executing submission', async () => {
  const f = await fixture(), persist = vi.spyOn(f.research.snapshots, 'record'), first = f.prepare(f.first, 'preference-context')
  expect(f.research.consumedFrame(f.first.conversationId)).toBeUndefined()
  first.dispatch()
  expect(f.research.consumedFrame(f.first.conversationId)).toBeUndefined()
  first.consume()
  const frame = f.research.consumedFrame(f.first.conversationId)!
  expect(frame.submissionId).toBe(first.receipt.submissionId)
  expect(frame.binding).toEqual(f.first)
  expect(persist).not.toHaveBeenCalled()
  expect(f.domain.get(f.first.conversationId).status).toBe('unbound')
  frame.ensureSnapshot(); frame.ensureSnapshot()
  expect(persist.mock.results.map(result => result.value.status)).toEqual(['created', 'replayed'])
  expect(f.research.snapshots.get(f.actor.workspaceId, frame.scopeVersionId)?.included).toEqual([])
  const queued = f.prepare(f.first, 'preference-next')
  expect(f.research.consumedFrame(f.first.conversationId)?.submissionId).toBe(first.receipt.submissionId)
  queued.dispatch(); queued.consume()
  expect(() => frame.assertCurrent()).toThrow('changed')
  const next = f.research.consumedFrame(f.first.conversationId)!
  expect(next.submissionId).toBe(queued.receipt.submissionId)
  const current = f.control.get(f.actor, next.submissionId)
  f.control.requestCancel(f.actor, current.submissionId, current.version)
  expect(f.research.consumedFrame(f.first.conversationId)).toBeUndefined()
  expect(() => next.assertCurrent()).toThrow('executing')
})

it('keeps consent switches independent and checks them before any snapshot or research operation', async () => {
  const f = await fixture(), persisted = vi.spyOn(f.research.snapshots, 'record'), run = f.prepare(f.first, 'ordinary-native')
  run.dispatch(); run.consume(); expect(persisted).not.toHaveBeenCalled()
  const operations = f.research.forConversation(f.first.conversationId)
  f.research.journal.setPolicy(f.first, { schemaVersion: 1, kind: 'research-policy-set', expectedGeneration: f.first.generation, idempotencyKey: 'research:consent:off', expectedVersion: 0, recallPriorResearch: false, contributeResearchState: false })
  await expect(operations.record('call:no-consent', { kind: 'checkpoint', body: 'No' })).rejects.toThrow('disabled')
  await expect(operations.recall({ query: 'margin' })).rejects.toThrow('disabled'); expect(persisted).not.toHaveBeenCalled()
  f.research.journal.setPolicy(f.first, { schemaVersion: 1, kind: 'research-policy-set', expectedGeneration: f.first.generation, idempotencyKey: 'research:consent:record', expectedVersion: 1, recallPriorResearch: false, contributeResearchState: true })
  await expect(operations.record('call:yes', { kind: 'checkpoint', body: 'Margin note' })).resolves.toMatchObject({ status: 'created' })
  await expect(operations.recall({ query: 'margin' })).rejects.toThrow('disabled')
  f.research.journal.setPolicy(f.first, { schemaVersion: 1, kind: 'research-policy-set', expectedGeneration: f.first.generation, idempotencyKey: 'research:consent:recall', expectedVersion: 2, recallPriorResearch: true, contributeResearchState: false })
  expect((await operations.recall({ query: 'margin' })).leads).toHaveLength(1)
  await expect(operations.record('call:off', { kind: 'checkpoint', body: 'No' })).rejects.toThrow('disabled')
})

it('leaves ordinary tasks usable when research retention is full and links committed effects even if delivery is cancelled', async () => {
  const f = await fixture(), persist = vi.spyOn(f.research.snapshots, 'record').mockImplementation(() => { throw new Error('research retention full') })
  const run = f.prepare(f.first, 'native-at-capacity'); run.dispatch(); expect(run.consume).not.toThrow(); expect(persist).not.toHaveBeenCalled()
  persist.mockRestore()
  const controller = new AbortController(), record = f.domain.recordResearch.bind(f.domain)
  const saved = vi.spyOn(f.domain, 'recordResearch').mockImplementation(request => { const result = record(request); controller.abort(new Error('delivery cancelled')); return result })
  const operation = f.research.forConversation(f.first.conversationId)
  await expect(operation.record('call:committed-before-cancel', { kind: 'checkpoint', body: 'Committed margin note' }, controller.signal)).rejects.toThrow('delivery cancelled')
  saved.mockRestore()
  const replay = await operation.record('call:committed-before-cancel', { kind: 'checkpoint', body: 'Committed margin note' })
  expect(replay.status).toBe('replayed'); expect(f.research.journal.forRecord(f.actor, replay.record.recordId)?.recordId).toBe(replay.record.recordId)
})

it('filters revoked captured sources and orphan agent records before recall counts/previews, without admitting source candidates', async () => {
  const f = await fixture(), first = f.prepare(f.first, 'source-bound', [{ documentId: f.source.documentId, revisionId: f.source.revisionId }]); first.dispatch(); first.consume()
  const note = await f.research.forConversation(f.first.conversationId).record('call:source-note', { kind: 'checkpoint', body: 'Margin source assumptions' })
  const second = f.prepare(f.second, 'source-recall'); second.dispatch(); second.consume()
  const operations = f.research.forConversation(f.second.conversationId), available = await operations.recall({ query: 'margin' })
  expect(available.leads[0]).toMatchObject({ sourceState: 'outside-current-scope', sourceIdentities: [f.source], verificationStatus: 'unverified-lead' })
  expect(() => second.session.invocation()).toThrow('No document')
  const scope = f.domain.get(f.first.conversationId).scope!, other = f.domain.getEligibleLibrarySource(f.actor.workspaceId, f.other.documentId, f.other.currentRevision.revisionId)!
  f.domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: f.first.conversationId, idempotencyKey: 'research:policy:revoke', expectedScopeVersionId: scope.scopeVersionId,
    scope: { ...scope, scopeVersionId: 'scope:research:revoked', version: scope.version + 1, previousScopeVersionId: scope.scopeVersionId, included: [{ documentId: other.documentId, revisionId: other.revisionId, role: 'primary' }], excluded: [{ documentId: f.source.documentId, revisionId: f.source.revisionId, reason: 'policy' }] }, sources: [other] })
  const denied = await operations.recall({ query: 'margin' })
  expect(denied.leads).toEqual([]); expect(denied.pageInfo.total).toBe(0)
  expect(f.query(f.second).result).toMatchObject({ items: [], pageInfo: { total: 0 } })
  expect(() => f.research.get(f.second.conversationId, note.record.recordId)).toThrow('not available')
  const frame = f.research.snapshots.get(f.actor.workspaceId, `scope:research-empty:${enrichmentHash([second.receipt.submissionId, second.receipt.requestHash]).slice(0, 32)}`)!
  const orphan = f.domain.recordResearch({ schemaVersion: 1, requestType: 'research-record', sessionId: f.second.conversationId, workspaceId: f.actor.workspaceId,
    investigationId: frame.investigationId, scopeVersionId: frame.scopeVersionId, callId: 'call:orphan', idempotencyKey: 'research:orphan:domain-only', kind: 'checkpoint', body: 'Orphan margin content' })
  expect((await operations.recall({ query: 'orphan' })).pageInfo.total).toBe(0)
  expect(f.query(f.second).result).toMatchObject({ items: [], pageInfo: { total: 0 } })
  expect(() => f.research.get(f.second.conversationId, orphan.record.recordId)).toThrow('provenance')
})

it('saves a verified manual Note outside current sources, exposes full text and original anchor, and applies CAS lifecycle/idempotency', async () => {
  const f = await fixture(), ticket = await f.stage(), before = f.domain.get(f.first.conversationId)
  const input: NoteSave = { schemaVersion: 1, kind: 'note-save', expectedGeneration: f.first.generation, idempotencyKey: 'research:human:save', selectionContextId: ticket.selectionContextId,
    noteKind: 'hypothesis', body: 'Margin comparability needs investigation. '.repeat(40) }
  const replayLookup = vi.spyOn(f.domain, 'replaySelectionAction')
  const saved = f.research.save(f.first.conversationId, input)
  const legacyRequest = replayLookup.mock.calls[0]![1] as SelectionActionRequest
  expect(legacyRequest.nonce).toMatch(/^seln_[A-Za-z0-9_-]{32}$/u)
  expect(JSON.stringify(saved)).not.toContain(legacyRequest.nonce)
  if (saved.result.record.recordType !== 'research-note') throw new Error('Expected saved Note')
  const recordId = saved.result.record.noteId, entry = f.research.get(f.first.conversationId, recordId)
  expect(entry).toMatchObject({ text: input.body, authoredBy: 'user', verificationStatus: 'unverified-lead', version: 1 })
  expect(entry.locators).toHaveLength(1); expect(entry.evidence[0]!.content.text).toBe('gross profit divided by revenue')
  expect(f.research.save(f.first.conversationId, input).result.status).toBe('replayed')
  expect(f.domain.get(f.first.conversationId)).toEqual(before)
  const focus = await f.research.focus(f.first.conversationId, recordId, entry.locators[0]!.locatorId, () => {}, new AbortController().signal)
  expect(focus).toMatchObject({ status: 'resolved', physicalPage: 1, exactText: 'gross profit divided by revenue', original: { contentHash: f.document.currentRevision.contentHash, documentId: f.source.documentId, revisionId: f.source.revisionId } })
  await expect(f.research.focus(f.first.conversationId, recordId, 'loc:forged', () => {}, new AbortController().signal)).rejects.toThrow('anchor')
  const edit: NotebookMutation = { schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: f.first.generation, idempotencyKey: 'research:human:edit', recordId, expectedVersion: 1, action: 'edit', text: 'Edited margin hypothesis.' }
  const edited = f.research.mutate(f.first.conversationId, edit)
  expect(f.research.mutate(f.first.conversationId, edit)).toEqual({ ...edited, result: { ...edited.result, status: 'replayed' } })
  expect(f.research.get(f.first.conversationId, recordId)).toMatchObject({ text: edit.text, version: 2 })
  expect(() => f.research.mutate(f.first.conversationId, { ...edit, idempotencyKey: 'research:human:stale' })).toThrow('compare-and-set')
  expect(() => f.research.save(f.first.conversationId, input)).toThrow('since changed')
  f.research.mutate(f.first.conversationId, { schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: f.first.generation, idempotencyKey: 'research:human:archive', recordId, expectedVersion: 2, action: 'archive' })
  expect(f.research.get(f.first.conversationId, recordId)).toMatchObject({ status: 'archived', version: 3 })
  f.research.mutate(f.first.conversationId, { schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: f.first.generation, idempotencyKey: 'research:human:delete', expectedVersion: 3, action: 'delete', recordId })
  expect(f.research.get(f.first.conversationId, recordId)).toMatchObject({ status: 'deleted', version: 4, text: null, locators: [], evidence: [] })
  expect(f.query().result.items).toEqual([])
})

it('rejects 4001-character and whitespace-only first-save text before invoking the legacy action port', async () => {
  const f = await fixture(), ticket = await f.stage(), legacy = vi.spyOn(f.domain, 'replaySelectionAction'), write = vi.spyOn(f.domain, 'recordSelectionAction')
  const input: NoteSave = { schemaVersion: 1, kind: 'note-save', expectedGeneration: f.first.generation, idempotencyKey: 'research:human:body-limit', selectionContextId: ticket.selectionContextId,
    noteKind: 'commentary', body: 'x'.repeat(4001) }
  expect(() => f.research.save(f.first.conversationId, input)).toThrow()
  expect(() => f.research.save(f.first.conversationId, { ...input, body: '  \n\t' })).toThrow()
  expect(legacy).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  const exact = f.research.save(f.first.conversationId, { ...input, body: 'x'.repeat(4000) }).result.record
  if (exact.recordType !== 'research-note') throw new Error('Expected exact-limit saved Note')
  expect(exact.body).toHaveLength(4000)
})

it('does not expose another owner’s records in a shared workspace through either recall or Notebook counts', async () => {
  const f = await fixture(), run = f.prepare(f.first, 'private-owner'); run.dispatch(); run.consume()
  const note = await f.research.forConversation(f.first.conversationId).record('call:private', { kind: 'checkpoint', body: 'Margin owner-private note' })
  const actor = { ...f.actor, actorId: 'actor:other-owner' }, binding = f.control.createManagedConversation(actor, 'research:other-owner').binding
  const research = new ProductResearch(f.domain, f.control, actor, new ResearchScopeSnapshots(join(f.root, 'snapshots')), new ResearchJournal(join(f.root, 'journal')), f.selections, f.answers)
  cleanup.push(() => research.close())
  const input: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation, idempotencyKey: 'research:other-owner:recall', mode: 'prompt', text: 'Recall margin', sourceRefs: [], selectionContextIds: [] }
  let receipt = f.control.accept(actor, input).receipt
  const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId, requestHash: receipt.requestHash, bindingGeneration: binding.generation, scopeVersionId: null, sourceRefs: [], selectionContextIds: [] }
  const consume = research.prepare(input, receipt, prepared), lease = f.control.acquireWriter(actor, binding.conversationId, 'worker:other-owner')
  receipt = f.control.transition(lease, receipt.submissionId, receipt.version, 'preparing')
  receipt = f.control.transition(lease, receipt.submissionId, receipt.version, 'ready', { prepared })
  receipt = f.control.transition(lease, receipt.submissionId, receipt.version, 'dispatching')
  f.control.transition(lease, receipt.submissionId, receipt.version, 'running'); consume()
  expect((await research.forConversation(binding.conversationId).recall({ query: 'margin' })).pageInfo.total).toBe(0)
  expect(research.query(binding.conversationId, { schemaVersion: 1, kind: 'notebook-query', expectedGeneration: binding.generation, view: 'workspace', maxItems: 10, maxChars: 1000 }).result).toMatchObject({ items: [], pageInfo: { total: 0 } })
  expect(() => research.get(binding.conversationId, note.record.recordId)).toThrow('not available')
})

it('rejects foreign conversations and ambiguous research/document scope authorities', async () => {
  const f = await fixture(), foreign = f.control.createManagedConversation({ ...f.actor, actorId: 'actor:foreign' }, 'research:foreign:conversation').binding
  expect(() => f.research.forConversation(foreign.conversationId)).toThrow('accessible')
  const run = f.prepare(f.first, 'partition-collision', [{ documentId: f.source.documentId, revisionId: f.source.revisionId }]); run.dispatch(); run.consume()
  const note = await f.research.forConversation(f.first.conversationId).record('call:collision', { kind: 'checkpoint', body: 'Margin capture' })
  const scope = f.domain.getSourceScopeVersion(f.actor.workspaceId, note.record.sourceScopeVersionId)!.scope
  f.research.snapshots.record(scope)
  expect(() => f.research.get(f.first.conversationId, note.record.recordId)).toThrow('authorities')
})
