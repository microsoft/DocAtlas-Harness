import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ResearchScopeSnapshots, SourceScopeStore, enrichmentHash, type SelectionResolverPort } from '@docatlas/core'
import type { HumanResearchCommand, HumanResearchQuery, LibraryDocument, ProductBinding, ProductSelectionProposal,
  ReadResult, ResolveRequest, ResolveResult, SourceScopeGetResult } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'
import { ResearchJournal } from '../src/storage/research-journal.js'
import { SelectionTickets } from '../src/storage/selection-tickets.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ProductResearch } from '../src/documents/research.js'
import { ProductSelections } from '../src/documents/selections.js'
import { ProductAnswers } from '../src/documents/answers.js'
import { HumanResearch } from '../src/documents/human-research.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
const example = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/library.json', import.meta.url), 'utf8')) as { document: LibraryDocument }
const text = 'Gross margin is gross profit divided by revenue. Keep currency and period explicit.'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const allTypes: HumanResearchQuery['recordTypes'] = ['research-note', 'open-question', 'project-decision', 'research-policy']

/** Real Core/control/snapshot/ticket stores; deterministic typed cache-only resolver, no model.
 * This tests host authorization and persistence, not real-PDF parser quality or native SDK branching.
 */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-human-research-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const actor = { actorId: 'actor:human-research', workspaceId: 'workspace:human-research' }
  const control = ControlStore.open(join(root, 'control')); cleanups.push(() => control.close())
  const first = control.createManagedConversation(actor, 'human:conversation:first').binding, second = control.createManagedConversation(actor, 'human:conversation:second').binding
  const domain = await SourceScopeStore.open(join(root, 'domain')); cleanups.push(() => domain.close())
  const documents = ['first', 'second'].map((key, index) => {
    const document = structuredClone(example.document), suffix = `:${key}`
    document.workspaceId = actor.workspaceId
    const originalHash = (index ? 'b' : 'a').repeat(64)
    document.documentId = domain.resolveLibraryImport(actor.workspaceId, `human-source:${key}`, originalHash).documentId
    document.currentRevision.documentId = document.documentId; document.currentRevision.revisionId += suffix; document.currentRevision.contentHash = originalHash
    document.activeRepresentationId += suffix
    for (const rep of document.representations) {
      rep.documentId = document.documentId; rep.revisionId = document.currentRevision.revisionId; rep.representationId += suffix
      rep.derivedFromRepresentationIds = rep.derivedFromRepresentationIds.map(id => id + suffix)
      rep.contentHash = rep.kind === 'original-bytes' ? originalHash : (index ? 'd' : 'c').repeat(64)
    }
    domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: `human:library:${key}`, sourceKey: `human-source:${key}`, rootId: 'fixture', relativePath: `${key}.pdf`, document })
    return document
  })
  const sources = documents.map(document => domain.getEligibleLibrarySource(actor.workspaceId, document.documentId, document.currentRevision.revisionId)!)
  let onRead: (() => void | Promise<void>) | undefined, onClose: (() => void | Promise<void>) | undefined, resolverCalls = 0
  const call: SelectionResolverPort['call'] = (async (method: string, request: Record<string, unknown>) => {
    resolverCalls++
    if (method === 'read') {
      await onRead?.()
      const identity = request.source as ReadResult['source'], source = sources.find(item => item.documentId === identity.documentId)!
      return { schemaVersion: 1, resultType: 'read', mode: 'page', source: identity, textQuality: 'usable', items: [{ itemType: 'block', blockId: `block:${source.documentId}`,
        physicalPage: 1, kind: 'paragraph', text, locator: { schemaVersion: 1, locatorId: `loc:page:${source.documentId}`, ...source, physicalPage: 1,
          selectors: [{ type: 'text-position', start: 0, end: [...text].length, unit: 'unicode-scalar' }], createdAt: new Date().toISOString() } }],
        pageInfo: { schemaVersion: 1, limit: 200, returned: 1, total: 1, usedChars: [...text].length, truncated: false, completeness: 'complete' } } as ReadResult
    }
    const locator = (request as unknown as ResolveRequest).locator, position = locator.selectors.find(selector => selector.type === 'text-position')!
    if (position.type !== 'text-position') throw new Error('Expected an exact scalar anchor')
    const exactText = [...text].slice(position.start, position.end).join('')
    return { schemaVersion: 1, resultType: 'resolve', resolutionId: 'resolve:human', locatorId: locator.locatorId, documentId: locator.documentId,
      revisionId: locator.revisionId, representationId: locator.representationId, status: 'resolved', checkedRepresentationHash: locator.representationContentHash,
      exactText, resolvedLocator: { ...locator, selectors: [...locator.selectors.filter(selector => selector.type !== 'text-quote'), { type: 'text-quote', exact: exactText, normalizedHash: hash(exactText) }] },
      candidates: [], checkedAt: new Date().toISOString() } as ResolveResult
  }) as SelectionResolverPort['call']
  const reader = () => ({ call, close: async () => { await onClose?.() } })
  const tickets = new SelectionTickets(join(root, 'tickets')); cleanups.push(() => tickets.close())
  const selections = new ProductSelections(tickets, domain, id => control.binding(actor, id), reader); cleanups.push(() => selections.close())
  const receipts = new AnswerReceipts(join(root, 'answers')); cleanups.push(() => receipts.close())
  const answers = new ProductAnswers(receipts, domain, control, actor, reader); cleanups.push(() => answers.close())
  const research = new ProductResearch(domain, control, actor, new ResearchScopeSnapshots(join(root, 'snapshots')), new ResearchJournal(join(root, 'research-control')), selections, answers)
  cleanups.push(() => research.close())
  const human = new HumanResearch(domain, research, selections)
  const base = (key: string, binding = first) => ({ schemaVersion: 1 as const, kind: 'human-research-command' as const,
    expectedBindingId: binding.bindingId, expectedGeneration: binding.generation, idempotencyKey: `human:testing:${key}` })
  const create = (key: string, body = 'Keep the reporting period explicit.', binding = first): HumanResearchCommand => ({ ...base(key, binding), action: 'create',
    entry: { recordType: 'research-note', noteKind: 'commentary', body }, sourceRefs: [], selections: [] })
  const query = (binding = first, override: Partial<HumanResearchQuery> = {}) => human.query(binding.conversationId, { schemaVersion: 1, kind: 'human-research-query',
    expectedBindingId: binding.bindingId, expectedGeneration: binding.generation, view: 'workspace', recordTypes: allTypes,
    recordStatuses: ['active', 'open', 'resolved', 'archived'], maxItems: 20, maxChars: 8000, ...override })
  const command = (input: HumanResearchCommand, binding = first) => human.command(binding.conversationId, input, () => {}, new AbortController().signal)
  const proposal: ProductSelectionProposal = { documentId: sources[0]!.documentId, revisionId: sources[0]!.revisionId, physicalPage: 1, quote: 'gross profit divided by revenue' }
  return { root, actor, control, first, second, domain, documents, sources, tickets, selections, answers, research, human, base, create, query, command, proposal,
    get resolverCalls() { return resolverCalls }, set onRead(value: typeof onRead) { onRead = value }, set onClose(value: typeof onClose) { onClose = value } }
}

it('keeps inspections read-only, creates a full free human Note and returns metadata-only immutable receipts after editing/deletion', async () => {
  const f = await fixture(), capture = vi.spyOn(f.research.snapshots, 'record'), agent = vi.spyOn(f.domain, 'recordResearch'), selectionAction = vi.spyOn(f.domain, 'recordSelectionAction'), stage = vi.spyOn(f.tickets, 'stage')
  expect(f.query().result.pageInfo.total).toBe(0)
  expect(f.human.operation(f.first.conversationId, `human-op:${'f'.repeat(64)}`).receipt).toBeNull()
  expect(capture).not.toHaveBeenCalled()
  const body = 'The complete original human research sentence. '.repeat(60), request = f.create('free', body), saved = await f.command(request), id = saved.receipt!.recordId
  expect(saved.receipt).toMatchObject({ status: 'committed', action: 'create', actorId: f.actor.actorId, recordVersion: 1, requestHash: enrichmentHash(request) })
  expect(f.human.get(f.first.conversationId, id).entry).toMatchObject({ text: body, authoredBy: 'user', evidence: [], locators: [], version: 1 })
  expect(f.domain.getResearchNote(f.actor.workspaceId, id)).toMatchObject({ sourceIdentities: [], anchors: [] })
  expect(f.domain.get(f.first.conversationId).status).toBe('unbound')
  expect(f.resolverCalls).toBe(0); expect(agent).not.toHaveBeenCalled(); expect(selectionAction).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled()
  const captures = capture.mock.calls.length
  f.query(f.first, { maxChars: 80 }); f.human.get(f.first.conversationId, id); f.human.operation(f.first.conversationId, saved.operationId)
  expect(capture).toHaveBeenCalledTimes(captures)
  await f.command({ ...f.base('edit-free'), action: 'edit', recordId: id, expectedVersion: 1, text: 'Edited human text.' })
  await f.command({ ...f.base('delete-free'), action: 'delete', recordId: id, expectedVersion: 2 })
  expect(f.human.get(f.first.conversationId, id).entry).toMatchObject({ text: null, locators: [], evidence: [], status: 'deleted', version: 3 })
  expect(f.query().result.items).toHaveLength(0)
  expect(await f.command(request)).toEqual(saved)
  expect(JSON.stringify(f.human.operation(f.first.conversationId, saved.operationId))).not.toContain(body)
  await expect(f.command({ ...request, action: 'create', entry: { recordType: 'research-note', noteKind: 'commentary', body: 'Changed under old key' }, sourceRefs: [], selections: [] })).rejects.toThrow('different')
})

it('saves direct verified Question anchors without touching an existing Ask ticket, retains explicit extra sources, and focuses the original', async () => {
  const f = await fixture()
  const ticket = await f.selections.stage(f.first.conversationId, { schemaVersion: 1, kind: 'selection-stage', expectedGeneration: f.first.generation,
    idempotencyKey: 'human:test:independent-ask', proposals: [f.proposal] }, () => {}, new AbortController().signal)
  const stage = vi.spyOn(f.tickets, 'stage'), bind = vi.spyOn(f.tickets, 'bind'), consume = vi.spyOn(f.tickets, 'consume')
  const saved = await f.command({ ...f.base('anchored-question'), action: 'create', entry: { recordType: 'open-question', question: 'Does this definition use the same period?' },
    sourceRefs: [{ documentId: f.sources[1]!.documentId, revisionId: f.sources[1]!.revisionId }], selections: [f.proposal] })
  const record = f.domain.getResearchNote(f.actor.workspaceId, saved.receipt!.recordId)!
  expect(record).toMatchObject({ recordType: 'open-question', status: 'open', evidence: [], authoredBy: 'user', anchors: [{ text: f.proposal.quote }] })
  expect(record.sourceIdentities).toHaveLength(2)
  expect(f.tickets.get(f.first, ticket.selectionContextId)).toEqual(ticket)
  expect(stage).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled()
  const overlay = f.human.overlay(f.first.conversationId, { schemaVersion: 1, kind: 'human-research-overlay-query', expectedBindingId: f.first.bindingId,
    expectedGeneration: f.first.generation, source: { documentId: f.proposal.documentId, revisionId: f.proposal.revisionId }, physicalPage: 1,
    view: 'workspace', recordTypes: ['open-question'], maxItems: 10, maxChars: 1000 })
  expect(overlay.result.items).toMatchObject([{ recordId: record.recordId, verificationStatus: 'anchor-only', relation: 'research-record-anchor', locator: record.locators[0] }])
  expect(overlay.recordVersions).toEqual([{ recordId: record.recordId, version: 1, authoredBy: 'user' }])
  const focused = await f.human.focus(f.first.conversationId, record.recordId, record.locators[0]!.locatorId, () => {}, new AbortController().signal)
  expect(focused.focus).toMatchObject({ recordId: record.recordId, status: 'resolved', exactText: f.proposal.quote, physicalPage: 1,
    original: { documentId: f.proposal.documentId, revisionId: f.proposal.revisionId } })
  await expect(f.human.focus(f.first.conversationId, record.recordId, 'loc:invented', () => {}, new AbortController().signal)).rejects.toThrow('anchor')
  await f.command({ ...f.base('resolve-question', f.second), action: 'resolve', recordId: record.recordId, expectedVersion: 1 }, f.second)
  expect(f.domain.getResearchNote(f.actor.workspaceId, record.recordId)).toMatchObject({ sourceSessionId: f.first.conversationId,
    scopeVersionId: record.scopeVersionId, status: 'resolved', sourceIdentities: record.sourceIdentities })
  const reread = () => f.human.overlay(f.first.conversationId, { schemaVersion: 1, kind: 'human-research-overlay-query', expectedBindingId: f.first.bindingId,
    expectedGeneration: f.first.generation, source: { documentId: f.proposal.documentId, revisionId: f.proposal.revisionId },
    view: 'workspace', recordTypes: ['open-question'], maxItems: 10, maxChars: 1000 })
  expect(reread().recordVersions).toEqual([{ recordId: record.recordId, version: 2, authoredBy: 'user' }])
  await f.command({ ...f.base('delete-resolved'), action: 'delete', recordId: record.recordId, expectedVersion: 2 })
  expect(reread().recordVersions).toEqual([]); expect(reread().result.items).toEqual([])
  expect(f.domain.get(f.first.conversationId).status).toBe('unbound'); expect(f.domain.get(f.second.conversationId).status).toBe('unbound')
})

it('supports typed Decision/Policy lifecycle while retaining the original governed frame and leaving Agent consent independent', async () => {
  const f = await fixture()
  f.research.journal.setPolicy(f.first, { schemaVersion: 1, kind: 'research-policy-set', expectedGeneration: f.first.generation, idempotencyKey: 'human:test:agent-policy-off',
    expectedVersion: 0, recallPriorResearch: false, contributeResearchState: false })
  const created = await f.command({ ...f.base('decision'), action: 'create', entry: { recordType: 'project-decision', title: 'Period convention', decision: 'Keep the fiscal-year convention.', rationale: 'Comparability only, not evidence.' },
    sourceRefs: [{ documentId: f.sources[0]!.documentId, revisionId: f.sources[0]!.revisionId }], selections: [] })
  const id = created.receipt!.recordId, before = f.domain.getResearchGovernance(f.actor.workspaceId, id)!
  await f.command({ ...f.base('revise-decision', f.second), action: 'revise', recordId: id, expectedVersion: 1,
    entry: { recordType: 'project-decision', title: 'Period convention', decision: 'Show both periods explicitly.' } }, f.second)
  expect(f.domain.getResearchGovernance(f.actor.workspaceId, id)).toMatchObject({ version: 2, sourceSessionId: before.sourceSessionId,
    sourceScopeVersionId: before.sourceScopeVersionId, investigationId: before.investigationId, updatedBy: { kind: 'user', actorId: f.actor.actorId } })
  await expect(f.command({ ...f.base('wrong-type'), action: 'revise', recordId: id, expectedVersion: 2,
    entry: { recordType: 'research-policy', title: 'Changed type', directive: 'Cannot mutate types.', policyScope: 'workspace' } })).rejects.toThrow('type')
  await expect(f.command({ ...f.base('wrong-edit'), action: 'edit', recordId: id, expectedVersion: 2, text: 'Wrong edit protocol' })).rejects.toThrow('typed')
  const policy = await f.command({ ...f.base('policy'), action: 'create', entry: { recordType: 'research-policy', title: 'Approval', directive: 'Have a human approve the research conclusion.', policyScope: 'workspace' }, sourceRefs: [], selections: [] })
  expect(f.human.get(f.first.conversationId, policy.receipt!.recordId)).toMatchObject({ useStatus: 'user-governance' })
  expect(f.query(f.second, { recordTypes: ['project-decision', 'research-policy'] }).result.pageInfo.total).toBe(2)
  expect(f.query(f.second, { view: 'working' }).result.pageInfo.total).toBe(0)
  await f.command({ ...f.base('archive-policy'), action: 'archive', recordId: policy.receipt!.recordId, expectedVersion: 1 })
  await f.command({ ...f.base('delete-policy'), action: 'delete', recordId: policy.receipt!.recordId, expectedVersion: 2 })
  expect(f.human.get(f.first.conversationId, policy.receipt!.recordId).entry).toMatchObject({ status: 'deleted', version: 3 })
  expect(JSON.stringify(f.human.get(f.first.conversationId, policy.receipt!.recordId))).not.toContain('Have a human approve')
  expect(f.research.journal.policy(f.first)).toMatchObject({ contributeResearchState: false, recallPriorResearch: false })
  expect(f.resolverCalls).toBe(0)
})

it('authorizes every explicit source and the original conversation before detail, receipt, Notebook totals, overlays and focus', async () => {
  const f = await fixture(), created = await f.command({ ...f.base('all-source-authority'), action: 'create', entry: { recordType: 'research-note', noteKind: 'hypothesis', body: 'Associated with both originals.' },
    sourceRefs: [{ documentId: f.sources[1]!.documentId, revisionId: f.sources[1]!.revisionId }], selections: [f.proposal] })
  const id = created.receipt!.recordId, note = f.domain.getResearchNote(f.actor.workspaceId, id)!, originalGet = f.domain.get.bind(f.domain)
  const originalScope = f.research.snapshots.get(f.actor.workspaceId, note.scopeVersionId)!
  const deny = vi.spyOn(f.domain, 'get').mockImplementation(cid => cid === f.first.conversationId
    ? { schemaVersion: 1, resultType: 'source-scope', sessionId: cid, status: 'active', scope: { ...originalScope, included: [],
      excluded: [{ documentId: f.sources[1]!.documentId, revisionId: f.sources[1]!.revisionId, reason: 'permission' }] }, sources: [] } as SourceScopeGetResult : originalGet(cid))
  expect(() => f.human.get(f.second.conversationId, id)).toThrow('not available')
  expect(() => f.human.operation(f.first.conversationId, created.operationId)).toThrow('not available')
  expect(f.query(f.second).result.pageInfo.total).toBe(0)
  expect(f.human.overlay(f.second.conversationId, { schemaVersion: 1, kind: 'human-research-overlay-query', expectedBindingId: f.second.bindingId,
    expectedGeneration: f.second.generation, source: { documentId: f.proposal.documentId, revisionId: f.proposal.revisionId }, view: 'workspace', recordTypes: ['research-note'], maxItems: 10, maxChars: 1000 }).result.pageInfo.total).toBe(0)
  await expect(f.human.focus(f.second.conversationId, id, note.locators[0]!.locatorId, () => {}, new AbortController().signal)).rejects.toThrow('not available')
  deny.mockRestore()
  expect(f.query(f.second).result.pageInfo.total).toBe(1)
  const permitted = f.domain.getEligibleLibrarySource.bind(f.domain)
  vi.spyOn(f.domain, 'getEligibleLibrarySource').mockImplementation((workspaceId, documentId, revisionId) => {
    const source = permitted(workspaceId, documentId, revisionId)
    return source && documentId === f.sources[1]!.documentId ? { ...source, representationContentHash: 'e'.repeat(64) } : source
  })
  expect(f.query(f.second).result.pageInfo.total).toBe(0)
  expect(() => f.human.get(f.second.conversationId, id)).toThrow('not available')
})

it.each(['representationId', 'representationContentHash'] as const)('rejects same-revision Governance %s drift before detail, counts, receipt recovery or revision', async field => {
  const f = await fixture(), entry = field === 'representationId'
    ? { recordType: 'project-decision' as const, title: 'Original decision frame', decision: 'Keep both captured source representations.' }
    : { recordType: 'research-policy' as const, title: 'Original policy frame', directive: 'Use the captured source definitions.', policyScope: 'workspace' as const }
  const saved = await f.command({ ...f.base(`governance-drift-${field}`), action: 'create', entry,
    sourceRefs: f.sources.map(source => ({ documentId: source.documentId, revisionId: source.revisionId })), selections: [] })
  const recordId = saved.receipt!.recordId, original = f.domain.getResearchGovernance(f.actor.workspaceId, recordId)!
  const originalSources = f.domain.getResearchGovernanceSources(f.actor.workspaceId, recordId)!
  expect(originalSources).toHaveLength(2); expect(originalSources).toEqual(expect.arrayContaining(f.sources))
  expect(f.human.operation(f.first.conversationId, saved.operationId).receipt).toEqual(saved.receipt)
  expect(f.query(f.second).result.pageInfo.total).toBe(1)
  const capture = vi.spyOn(f.research.snapshots, 'record'), getSource = f.domain.getEligibleLibrarySource.bind(f.domain)
  const changed = vi.spyOn(f.domain, 'getEligibleLibrarySource').mockImplementation((workspaceId, documentId, revisionId) => {
    const source = getSource(workspaceId, documentId, revisionId)
    if (!source || documentId !== f.sources[1]!.documentId) return source
    return { ...source, ...(field === 'representationId' ? { representationId: `${source.representationId}:changed` } : { representationContentHash: 'e'.repeat(64) }) }
  })
  expect(() => f.human.get(f.second.conversationId, recordId)).toThrow('not available')
  expect(f.query(f.second).result).toMatchObject({ items: [], pageInfo: { total: 0, returned: 0 } })
  expect(() => f.human.operation(f.first.conversationId, saved.operationId)).toThrow('not available')
  const revise: HumanResearchCommand = { ...f.base(`governance-drift-revise-${field}`, f.second), action: 'revise', recordId, expectedVersion: 1,
    entry: { ...entry, title: 'Must not revise after representation drift' } }
  await expect(f.command(revise, f.second)).rejects.toThrow('not available')
  const operationId = `human-op:${enrichmentHash([f.actor.actorId, f.actor.workspaceId, f.second.conversationId, revise.idempotencyKey])}`
  expect(f.domain.getHumanResearchReceipt(f.actor.workspaceId, f.actor.actorId, f.second.conversationId, operationId)).toBeUndefined()
  expect(f.domain.getResearchGovernance(f.actor.workspaceId, recordId)).toEqual(original)
  expect(f.domain.getResearchGovernanceSources(f.actor.workspaceId, recordId)).toEqual(originalSources)
  expect(capture).not.toHaveBeenCalled()
  changed.mockRestore()
  expect(f.human.get(f.second.conversationId, recordId).entry).toEqual(original)
  expect(f.human.operation(f.first.conversationId, saved.operationId).receipt).toEqual(saved.receipt)
  expect(f.query(f.second).result.pageInfo.total).toBe(1)
})

it.each(['research-note', 'open-question'] as const)('prevents legacy ProductResearch.mutate from changing a new human %s without its command receipt', async recordType => {
  const f = await fixture(), entry = recordType === 'research-note'
    ? { recordType, noteKind: 'commentary' as const, body: 'Original human Note text.' }
    : { recordType, question: 'Original human Question text?' }
  const saved = await f.command({ ...f.base(`legacy-bypass-${recordType}`), action: 'create', entry, sourceRefs: [], selections: [] })
  const recordId = saved.receipt!.recordId, original = f.domain.getResearchNote(f.actor.workspaceId, recordId)!
  expect(() => f.research.mutate(f.first.conversationId, { schemaVersion: 1, kind: 'notebook-mutate', expectedGeneration: f.first.generation,
    idempotencyKey: `legacy:human-record:${recordType}`, recordId, expectedVersion: 1, action: 'edit', text: 'Must not bypass the human command protocol.' })).toThrow('require a human command')
  expect(f.domain.getResearchNote(f.actor.workspaceId, recordId)).toEqual(original)
  expect(f.human.operation(f.first.conversationId, saved.operationId).receipt).toEqual(saved.receipt)
  expect(f.query().result.items[0]).toMatchObject({ recordId, recordVersion: 1 })
  const updated = await f.command({ ...f.base(`proper-edit-${recordType}`), action: 'edit', recordId, expectedVersion: 1, text: 'Edited through the reviewed human command.' })
  expect(updated.receipt).toMatchObject({ recordId, recordType, recordVersion: 2, action: 'edit' })
  expect(f.human.get(f.first.conversationId, recordId).entry).toMatchObject({ text: 'Edited through the reviewed human command.', version: 2 })
})

it('verifies the whole selection group before capture, freezes the hashed command and rejects authority changes during actual reader join', async () => {
  const f = await fixture(), capture = vi.spyOn(f.research.snapshots, 'record')
  const invalidGroup: HumanResearchCommand = { ...f.base('missing-second'), action: 'create', entry: { recordType: 'research-note', noteKind: 'scratch', body: 'No partial save' },
    sourceRefs: [], selections: [f.proposal, { ...f.proposal, quote: 'This quotation is absent.' }] }
  await expect(f.command(invalidGroup)).rejects.toThrow('missing')
  expect(capture).not.toHaveBeenCalled(); expect(f.query().result.items).toHaveLength(0)
  const candidate: HumanResearchCommand = { ...f.base('frozen-body'), action: 'create', entry: { recordType: 'research-note', noteKind: 'commentary', body: 'Frozen original text' }, sourceRefs: [], selections: [f.proposal] }
  const requestHash = enrichmentHash(candidate)
  f.onRead = () => { candidate.entry = { recordType: 'research-note', noteKind: 'scratch', body: 'Changed during await' }; candidate.selections.length = 0 }
  const saved = await f.command(candidate)
  expect(saved.receipt!.requestHash).toBe(requestHash)
  expect(f.human.get(f.first.conversationId, saved.receipt!.recordId).entry).toMatchObject({ text: 'Frozen original text', locators: [expect.anything()] })
  f.onRead = undefined
  const priorCaptures = capture.mock.calls.length, changed = new AbortController()
  f.onClose = () => { changed.abort() }
  const cancelled: HumanResearchCommand = { ...f.base('cancel-on-join'), action: 'create', entry: { recordType: 'open-question', question: 'Do not save after cancellation.' }, sourceRefs: [], selections: [f.proposal] }
  await expect(f.human.command(f.first.conversationId, cancelled, () => {}, changed.signal)).rejects.toThrow()
  expect(capture).toHaveBeenCalledTimes(priorCaptures)
  const operationId = `human-op:${enrichmentHash([f.actor.actorId, f.actor.workspaceId, f.first.conversationId, cancelled.idempotencyKey])}`
  expect(f.human.operation(f.first.conversationId, operationId).receipt).toBeNull()
})

it('recovers only original committed metadata across a binding change and denies stale new effects and foreign ownership', async () => {
  const f = await fixture(), request = f.create('generation-recovery'), original = await f.command(request)
  // Exact ControlStore handoff CAS only; this fixture does not claim a native navigation journey.
  const next: ProductBinding = { ...f.first, bindingId: 'binding:human-research-next', generation: f.first.generation + 1,
    version: f.first.version + 1, updatedAt: new Date().toISOString() }
  f.control.commitNativeHandoff(f.actor, f.first, next)
  const recovered = f.human.operation(f.first.conversationId, original.operationId)
  expect(recovered.binding).toEqual(next); expect(recovered.receipt).toEqual(original.receipt)
  expect(await f.command(request)).toEqual(recovered)
  await expect(f.command(f.create('stale-new'))).rejects.toThrow('binding')
  expect(() => f.query()).toThrow('binding')
  expect(f.human.operation(f.second.conversationId, original.operationId).receipt).toBeNull()
  const otherActor = { ...f.actor, actorId: 'actor:another-human' }, other = f.control.createManagedConversation(otherActor, 'human:foreign-owner').binding
  const otherResearch = new ProductResearch(f.domain, f.control, otherActor, new ResearchScopeSnapshots(join(f.root, 'snapshots')),
    new ResearchJournal(join(f.root, 'research-control')), f.selections, f.answers); cleanups.push(() => otherResearch.close())
  const otherHuman = new HumanResearch(f.domain, otherResearch, f.selections)
  expect(() => otherHuman.get(other.conversationId, original.receipt!.recordId)).toThrow('not available')
  expect(otherHuman.operation(other.conversationId, original.operationId).receipt).toBeNull()
})

it('stops admission synchronously during shutdown and cannot publish a selection that joins after close', async () => {
  const f = await fixture(), capture = vi.spyOn(f.research.snapshots, 'record')
  const request: HumanResearchCommand = { ...f.base('close-during-join'), action: 'create', entry: { recordType: 'open-question', question: 'No post-close record.' }, sourceRefs: [], selections: [f.proposal] }
  f.onClose = () => { f.human.close() }
  await expect(f.command(request)).rejects.toThrow('closed')
  expect(capture).not.toHaveBeenCalled()
  const operationId = `human-op:${enrichmentHash([f.actor.actorId, f.actor.workspaceId, f.first.conversationId, request.idempotencyKey])}`
  expect(f.domain.getHumanResearchReceipt(f.actor.workspaceId, f.actor.actorId, f.first.conversationId, operationId)).toBeUndefined()
  expect(() => f.query()).toThrow('closed')
  await expect(f.command(f.create('after-close'))).rejects.toThrow('closed')
})
