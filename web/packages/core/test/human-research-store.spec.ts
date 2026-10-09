import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { HumanResearchCommand, HumanResearchReceipt, ResearchGovernanceRequest, ResearchLifecycleRequest, ResearchNotebookRequest, ResearchSourceIdentity, TreeOverlayRequest, VerifiedSelectionItem } from '@docatlas/contracts'
import { SourceScopeStore, type HumanResearchCommitContext, type HumanResearchCreateInput } from '../src/storage/source-scope-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, JSON.parse(canonical(item))])) : value)
const workspaceId = 'workspace:human-store', actorId = 'actor:human-store', conversationId = 'conversation:human-store', investigationId = 'investigation:human-store', scopeVersionId = 'scope:human-store'
const source: ResearchSourceIdentity = { documentId: 'doc:human-store', revisionId: 'rev:human-store', representationId: 'rep:human-store', representationContentHash: 'a'.repeat(64) }
const text = 'The margin increased.'
const anchor: VerifiedSelectionItem = { text, locator: { schemaVersion: 1, locatorId: 'locator:human-store', ...source, physicalPage: 1,
  selectors: [{ type: 'text-position', start: 0, end: [...text].length, unit: 'unicode-scalar' }, { type: 'text-quote', exact: text, normalizedHash: hash(text) }], createdAt: '2026-09-09T00:00:00.000Z' } }
const sourceRef = { documentId: source.documentId, revisionId: source.revisionId }

const frame = (key: string) => ({ schemaVersion: 1 as const, kind: 'human-research-command' as const, expectedBindingId: 'binding:human-store', expectedGeneration: 1, idempotencyKey: `human-test-key:${key}` })
function command(key: string, intent: Omit<Extract<HumanResearchCommand, { action: 'create' }>, 'schemaVersion' | 'kind' | 'expectedBindingId' | 'expectedGeneration' | 'idempotencyKey'> = {
  action: 'create', entry: { recordType: 'research-note', noteKind: 'commentary', body: 'Margin assumptions need checking.' }, sourceRefs: [], selections: [],
}): HumanResearchCommand {
  return { ...frame(key), ...intent }
}
function authority(request: HumanResearchCommand, assertCurrent: () => void = () => {}): HumanResearchCommitContext {
  return { actor: { kind: 'user', actorId }, command: { operationId: `human-op:${hash(canonical([actorId, workspaceId, conversationId, request.idempotencyKey]))}`,
    idempotencyKey: request.idempotencyKey, requestHash: hash(canonical(request)), actorId, workspaceId, conversationId,
    bindingId: request.expectedBindingId, generation: request.expectedGeneration, action: request.action }, governanceSources: [], assertCurrent }
}
function input(request: HumanResearchCommand, anchors: VerifiedSelectionItem[] = [], sourceIdentities: ResearchSourceIdentity[] = []): HumanResearchCreateInput {
  if (request.action !== 'create' || request.entry.recordType !== 'research-note' && request.entry.recordType !== 'open-question') throw new Error('Expected human draft')
  return { workspaceId, investigationId, sourceSessionId: conversationId, sourceScopeVersionId: scopeVersionId, entry: request.entry, anchors, sourceIdentities }
}
const notebook = (overrides: Partial<ResearchNotebookRequest> = {}): ResearchNotebookRequest => ({ schemaVersion: 1, requestType: 'research-notebook', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
  view: 'workspace', recordTypes: ['research-note', 'open-question', 'project-decision', 'research-policy'], recordStatuses: ['active', 'open', 'resolved', 'archived'], limits: { maxItems: 20, maxChars: 8000 }, ...overrides })
const overlay = (overrides: Partial<TreeOverlayRequest> = {}): TreeOverlayRequest => ({ schemaVersion: 1, requestType: 'tree-overlay-get', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
  source, recordTypes: ['research-note', 'open-question'], limits: { maxItems: 20, maxChars: 8000 }, ...overrides })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-human-research-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let store = await SourceScopeStore.open(root)
  cleanup.push(() => store.close())
  const path = join(root, 'investigations', `${hash(workspaceId)}.sqlite3`)
  return { root, path, get store() { return store }, reopen: async () => { store.close(); store = await SourceScopeStore.open(root) } }
}
function lifecycle(receipt: HumanResearchReceipt, request: HumanResearchCommand): ResearchLifecycleRequest {
  if (request.action === 'create' || request.action === 'revise') throw new Error('Expected lifecycle')
  return { schemaVersion: 1, requestType: 'research-record-lifecycle', workspaceId, investigationId, scopeVersionId, sessionId: conversationId,
    idempotencyKey: authority(request).command.operationId, recordId: receipt.recordId, expectedVersion: request.expectedVersion, action: request.action,
    ...(request.action === 'edit' ? { text: request.text } : {}) }
}

it('creates a human free Note with immutable metadata, no native call, no Evidence and no document admission', async () => {
  const f = await fixture(), request = command('free'), context = authority(request)
  const receipt = f.store.recordHumanResearch(input(request), context)
  expect(receipt).toMatchObject({ ...context.command, recordVersion: 1, recordType: 'research-note', status: 'committed' })
  expect(f.store.getResearchNote(workspaceId, receipt.recordId)).toMatchObject({ text: 'Margin assumptions need checking.', authoredBy: 'user', anchors: [], evidence: [], locators: [], sourceIdentities: [] })
  expect(f.store.get(conversationId).status).toBe('unbound')
  expect(f.store.replayHumanResearchCommand(context)).toEqual(receipt)
  expect(f.store.recordHumanResearch(input(request), context)).toEqual(receipt)
  expect(f.store.getHumanResearchReceipt(workspaceId, 'actor:other', conversationId, receipt.operationId)).toBeUndefined()
  const db = new DatabaseSync(f.path, { readOnly: true })
  try {
    const record = JSON.parse(db.prepare('SELECT record_json FROM human_research_records').get()!.record_json as string)
    expect(record).toMatchObject({ origin: 'human-command', createdBy: context.actor, provenanceCommandId: receipt.operationId, commandHash: receipt.requestHash })
    expect(record).not.toHaveProperty('provenanceCallId'); expect(record).not.toHaveProperty('evidence')
    expect(db.prepare('SELECT count(*) AS n FROM research_records').get()!.n).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM selection_actions').get()!.n).toBe(0)
    expect(db.prepare('SELECT receipt_json FROM human_research_commands').get()!.receipt_json).not.toContain('Margin assumptions')
  } finally { db.close() }
  await f.reopen()
  expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, receipt.operationId)).toEqual(receipt)
  expect(f.store.queryResearchNotebook(notebook(), []).items[0]).toMatchObject({ recordId: receipt.recordId, useStatus: 'unverified-lead', sourceState: 'none' })
})

it('keeps direct verified selection anchors independent of tickets/Evidence and projects exact anchor-only overlays', async () => {
  const f = await fixture(), request = command('anchor', { action: 'create', entry: { recordType: 'open-question', question: 'Why did margin increase?' }, sourceRefs: [], selections: [{ ...sourceRef, physicalPage: 1, quote: text }] })
  const receipt = f.store.recordHumanResearch(input(request, [anchor], [source]), authority(request))
  expect(f.store.getResearchNote(workspaceId, receipt.recordId)).toMatchObject({ anchors: [anchor], locators: [anchor.locator], evidence: [], sourceIdentities: [source] })
  expect(f.store.treeOverlay(overlay()).items[0]).toMatchObject({ recordId: receipt.recordId, relation: 'research-record-anchor', verificationStatus: 'anchor-only', layer: 'working' })
  expect(f.store.getContinuityRecord(workspaceId, receipt.recordId)).toMatchObject({ sourceReferencesComplete: false, sourceAvailability: 'missing', evidenceRefs: [], sources: [source] })
  expect(f.store.treeOverlay(overlay({ source: { ...source, revisionId: 'rev:wrong' } })).items).toEqual([])
  expect(f.store.treeOverlay(overlay({ physicalPage: 2 })).items).toEqual([])
  await f.reopen()
  expect(f.store.treeOverlay(overlay()).items).toHaveLength(1)
})

it('rejects forged anchor identity, duplicates and over-budget quote groups before committing any record', async () => {
  const f = await fixture(), request = command('invalid-anchor'), context = authority(request)
  expect(() => f.store.recordHumanResearch(input(request, [anchor], []), context)).toThrow('canonical record')
  expect(() => f.store.recordHumanResearch(input(request, [anchor, anchor], [source]), context)).toThrow('canonical record')
  expect(() => f.store.recordHumanResearch(input(request, [{ ...anchor, text: 'different' }], [source]), context)).toThrow('canonical record')
  expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, context.command.operationId)).toBeUndefined()
  expect(existsSync(f.path)).toBe(false)
})

it('binds replay to the complete public command and original owner, not matching note text', async () => {
  const f = await fixture(), request = command('hash'), context = authority(request)
  f.store.recordHumanResearch(input(request), context)
  const changed = authority({ ...request, expectedGeneration: 2 })
  expect(() => f.store.replayHumanResearchCommand(changed)).toThrow('different complete command')
  expect(() => f.store.recordHumanResearch(input(request), { ...context, actor: { kind: 'user', actorId: 'actor:forged' } })).toThrow('actor')
  expect(() => f.store.replayHumanResearchCommand({ ...context, command: { ...context.command, operationId: 'human-op:forged' } })).toThrow('identity')
})

it('freezes the complete trusted creation input before any re-entrant authority check', async () => {
  const f = await fixture(), request = command('frozen'), mutable = input(request)
  const context = authority(request, () => { mutable.sourceSessionId = 'conversation:changed'; mutable.sourceScopeVersionId = 'scope:changed'; if (mutable.entry.recordType === 'research-note') mutable.entry.body = 'Replaced input' })
  const receipt = f.store.recordHumanResearch(mutable, context)
  expect(f.store.getResearchNote(workspaceId, receipt.recordId)).toMatchObject({ sourceSessionId: conversationId, scopeVersionId, text: 'Margin assumptions need checking.' })
  await f.reopen()
  expect(f.store.getResearchNote(workspaceId, receipt.recordId)?.sourceSessionId).toBe(conversationId)
})

it('rejects asynchronous, zero-generation or re-entrantly mutated authority before writes', async () => {
  const f = await fixture(), request = command('authority')
  expect(() => f.store.recordHumanResearch(input(request), authority(request, async () => {}))).toThrow('synchronous')
  expect(() => f.store.recordHumanResearch(input(request), authority({ ...request, expectedGeneration: 0 }))).toThrow('identity')
  const context = authority(request)
  context.assertCurrent = () => { context.command.requestHash = 'b'.repeat(64) }
  expect(() => f.store.recordHumanResearch(input(request), context)).toThrow('authority changed')
  expect(existsSync(f.path)).toBe(false)
})

it('rolls back the creation, journal and receipt if current authority changes just before commit', async () => {
  const f = await fixture(), request = command('rollback')
  let checks = 0
  const context = authority(request, () => { if (++checks === 6) throw new Error('source revoked before commit') })
  expect(() => f.store.recordHumanResearch(input(request), context)).toThrow('source revoked')
  expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, context.command.operationId)).toBeUndefined()
  expect(f.store.queryResearchNotebook(notebook(), []).items).toEqual([])
  const db = new DatabaseSync(f.path, { readOnly: true })
  try { expect(db.prepare('SELECT count(*) AS n FROM journal_events').get()!.n).toBe(0) } finally { db.close() }
})

it('versions full Note text, preserves original scope and returns content-free receipts after deletion', async () => {
  const f = await fixture(), request = command('note-life'), first = f.store.recordHumanResearch(input(request, [anchor], [source]), authority(request))
  const edit: HumanResearchCommand = { ...frame('note-edit'), action: 'edit', recordId: first.recordId, expectedVersion: 1, text: 'Updated exact Note text.' }
  const edited = f.store.transitionResearchRecord(lifecycle(first, edit), authority(edit).actor, authority(edit))
  expect(edited.state).toMatchObject({ version: 2, updatedBy: { kind: 'user', actorId }, text: 'Updated exact Note text.' })
  expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, authority(edit).command.operationId)?.recordVersion).toBe(2)
  expect(() => f.store.transitionResearchRecord(lifecycle(first, { ...edit, idempotencyKey: 'human-test-key:stale' }), authority(edit).actor, authority({ ...edit, idempotencyKey: 'human-test-key:stale' }))).toThrow('compare-and-set')
  const remove: HumanResearchCommand = { ...frame('note-delete'), action: 'delete', recordId: first.recordId, expectedVersion: 2 }
  f.store.transitionResearchRecord(lifecycle(first, remove), authority(remove).actor, authority(remove))
  expect(f.store.getResearchNote(workspaceId, first.recordId)).toMatchObject({ status: 'deleted', version: 3, text: null, anchors: [], locators: [], evidence: [] })
  expect(f.store.treeOverlay(overlay()).items).toEqual([]); expect(f.store.queryResearchNotebook(notebook(), []).items).toEqual([])
  expect(f.store.replayHumanResearchCommand(authority(request))).toEqual(first)
  expect(JSON.stringify(f.store.replayHumanResearchCommand(authority(edit)))).not.toContain('Updated exact')
  await f.reopen()
  expect(f.store.getResearchNote(workspaceId, first.recordId)?.text).toBeNull()
  expect(f.store.replayHumanResearchCommand(authority(request))).toEqual(first)
})

it('supports the complete Question lifecycle while refusing Note resolve', async () => {
  const f = await fixture(), request = command('question-life', { action: 'create', entry: { recordType: 'open-question', question: 'What remains unknown?' }, sourceRefs: [], selections: [] })
  const first = f.store.recordHumanResearch(input(request), authority(request))
  for (const [offset, action] of (['resolve', 'archive', 'delete'] as const).entries()) {
    const next: HumanResearchCommand = { ...frame(`question-${action}`), action, recordId: first.recordId, expectedVersion: offset + 1 }
    f.store.transitionResearchRecord(lifecycle(first, next), authority(next).actor, authority(next))
    expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, authority(next).command.operationId)?.recordVersion).toBe(offset + 2)
  }
  const noteRequest = command('cannot-resolve-note'), note = f.store.recordHumanResearch(input(noteRequest), authority(noteRequest))
  const resolve: HumanResearchCommand = { ...frame('note-resolve'), action: 'resolve', recordId: note.recordId, expectedVersion: 1 }
  expect(() => f.store.transitionResearchRecord(lifecycle(note, resolve), authority(resolve).actor, authority(resolve))).toThrow('only an Open Question')
})

it('rolls back a lifecycle effect and receipt together when authority is revoked after their transactional writes', async () => {
  const f = await fixture(), request = command('lifecycle-rollback'), first = f.store.recordHumanResearch(input(request), authority(request))
  const edit: HumanResearchCommand = { ...frame('lifecycle-rollback-edit'), action: 'edit', recordId: first.recordId, expectedVersion: 1, text: 'Must not commit.' }
  const context = authority(edit)
  context.assertCurrent = () => { if (f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, context.command.operationId)) throw new Error('revoked after transactional write') }
  expect(() => f.store.transitionResearchRecord(lifecycle(first, edit), context.actor, context)).toThrow('revoked after transactional write')
  expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, context.command.operationId)).toBeUndefined()
  expect(f.store.getResearchNote(workspaceId, first.recordId)).toMatchObject({ version: 1, text: 'Margin assumptions need checking.' })
  await f.reopen()
  expect(f.store.getResearchNote(workspaceId, first.recordId)?.version).toBe(1)
})

it('rolls back governance and its receipt together without publishing a newer governance version', async () => {
  const f = await fixture(), entry = { recordType: 'project-decision' as const, title: 'Original decision', decision: 'Keep original source context.' }
  const request = command('governance-rollback', { action: 'create', entry, sourceRefs: [], selections: [] }), context = authority(request)
  context.assertCurrent = () => { if (f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, context.command.operationId)) throw new Error('governance commit denied') }
  const domain: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
    idempotencyKey: context.command.operationId, action: 'create', entry }
  expect(() => f.store.mutateResearchGovernance(domain, context)).toThrow('governance commit denied')
  expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, context.command.operationId)).toBeUndefined()
  expect(f.store.queryResearchNotebook(notebook(), []).items).toEqual([])
  expect(f.store.mutateResearchGovernance(domain, authority(request)).record.version).toBe(1)
})

it.each(['project-decision', 'research-policy'] as const)('attributes and receipts the complete %s lifecycle without changing original capture', async recordType => {
  const f = await fixture(), entry = recordType === 'project-decision'
    ? { recordType, title: 'Decision title', decision: 'Use source verification.' }
    : { recordType, title: 'Policy title', directive: 'Check the original.', policyScope: 'workspace' as const }
  const create = command(recordType, { action: 'create', entry, sourceRefs: [], selections: [] }), context = authority(create)
  const request: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
    idempotencyKey: context.command.operationId, action: 'create', entry }
  const first = f.store.mutateResearchGovernance(request, context)
  expect(first.record.createdBy).toEqual(context.actor)
  for (const [offset, action] of (['revise', 'archive', 'delete'] as const).entries()) {
    const publicRequest: HumanResearchCommand = { ...frame(`${recordType}-${action}`), action, recordId: first.record.recordId, expectedVersion: offset + 1,
      ...(action === 'revise' ? { entry: { ...entry, title: 'Revised title' } } : {}) } as HumanResearchCommand
    const guard = authority(publicRequest)
    const mutation: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
      action, idempotencyKey: guard.command.operationId, recordId: first.record.recordId, expectedVersion: offset + 1,
      ...(action === 'revise' ? { entry: { ...entry, title: 'Revised title' } } : {}) } as ResearchGovernanceRequest
    const changed = f.store.mutateResearchGovernance(mutation, guard)
    expect(changed.record).toMatchObject({ sourceSessionId: conversationId, sourceScopeVersionId: scopeVersionId, updatedBy: guard.actor, version: offset + 2 })
    expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, guard.command.operationId)?.recordVersion).toBe(offset + 2)
  }
  expect(f.store.getResearchGovernance(workspaceId, first.record.recordId)).toMatchObject({ status: 'deleted', version: 4 })
  expect(f.store.getResearchGovernance(workspaceId, first.record.recordId)).not.toHaveProperty('title')
  await f.reopen()
  expect(f.store.replayHumanResearchCommand(context)?.recordVersion).toBe(1)
  expect(f.store.queryResearchNotebook(notebook(), []).items).toEqual([])
})

it('filters hidden anchored records before Notebook/overlay totals and cursor fingerprints', async () => {
  const f = await fixture(), visibleIds = new Set<string>()
  for (const key of ['visible', 'hidden']) {
    const request = command(key), receipt = f.store.recordHumanResearch(input(request, [anchor], [source]), authority(request))
    if (key === 'visible') visibleIds.add(receipt.recordId)
  }
  const visible = vi.fn((reference: { recordId: string }) => visibleIds.has(reference.recordId))
  expect(f.store.queryResearchNotebook(notebook(), [source], visible).pageInfo.total).toBe(1)
  const before = f.store.treeOverlay(overlay(), visible)
  expect(before.pageInfo.total).toBe(1); expect(before.items).toHaveLength(1)
  const request = command('hidden-new'); f.store.recordHumanResearch(input(request, [anchor], [source]), authority(request))
  expect(f.store.treeOverlay(overlay(), visible).queryHash).toBe(before.queryHash)
  expect(f.store.treeOverlay(overlay(), () => false).pageInfo.total).toBe(0)
})

it('keeps empty read surfaces and operation lookups free of domain-file creation', async () => {
  const f = await fixture(), context = authority(command('unseen'))
  expect(f.store.queryResearchNotebook(notebook(), []).items).toEqual([])
  expect(f.store.treeOverlay(overlay()).items).toEqual([])
  expect(f.store.getHumanResearchReceipt(workspaceId, actorId, conversationId, context.command.operationId)).toBeUndefined()
  expect(f.store.getResearchNote(workspaceId, 'note:unseen')).toBeUndefined()
  expect(f.store.getResearchGovernance(workspaceId, 'policy:unseen')).toBeUndefined()
  expect(existsSync(f.path)).toBe(false)
})

it('backs up a temporary v5 database before additive v6 migration and preserves legacy record bytes', async () => {
  const f = await fixture()
  const legacy = f.store.recordResearch({ schemaVersion: 1, requestType: 'research-record', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
    idempotencyKey: 'legacy:record', callId: 'legacy:call', kind: 'checkpoint', body: 'Legacy bytes remain unchanged.' })
  f.store.close()
  const old = new DatabaseSync(f.path)
  let bytes: unknown
  try { bytes = old.prepare('SELECT record_json,record_hash FROM research_records').get(); old.exec("DROP TABLE human_research_commands; DROP TABLE human_research_records; UPDATE metadata SET value='5' WHERE key='schema_version'") } finally { old.close() }
  await f.reopen()
  expect(f.store.getResearchNote(workspaceId, legacy.record.recordId)?.text).toBe('Legacy bytes remain unchanged.')
  const db = new DatabaseSync(f.path, { readOnly: true })
  try { expect(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()!.value).toBe('6'); expect(db.prepare('SELECT record_json,record_hash FROM research_records').get()).toEqual(bytes) } finally { db.close() }
  const directory = join(f.root, 'backups', 'migrations', hash(workspaceId)), backup = readdirSync(directory).find(name => name.startsWith('schema-v5-'))!
  const saved = new DatabaseSync(join(directory, backup), { readOnly: true })
  try { expect(saved.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()!.value).toBe('5'); expect(saved.prepare('SELECT record_json,record_hash FROM research_records').get()).toEqual(bytes) } finally { saved.close() }
})

it('rolls back a failed v5 migration atomically and keeps both legacy rows and its recovery backup', async () => {
  const f = await fixture(), legacy = f.store.recordResearch({ schemaVersion: 1, requestType: 'research-record', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
    idempotencyKey: 'legacy:migration-rollback', callId: 'legacy:rollback-call', kind: 'checkpoint', body: 'Legacy rollback payload.' })
  f.store.close()
  const old = new DatabaseSync(f.path)
  try { old.exec("DROP TABLE human_research_commands; DROP TABLE human_research_records; UPDATE metadata SET value='5' WHERE key='schema_version'; CREATE TRIGGER reject_human_migration BEFORE UPDATE ON metadata WHEN NEW.key='schema_version' AND NEW.value='6' BEGIN SELECT RAISE(ABORT,'test migration failure'); END;") } finally { old.close() }
  await f.reopen()
  expect(() => f.store.getResearchNote(workspaceId, legacy.record.recordId)).toThrow('test migration failure')
  const check = new DatabaseSync(f.path)
  try {
    expect(check.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()!.value).toBe('5')
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('human_research_records','human_research_commands')").all()).toEqual([])
    expect(check.prepare('SELECT record_json FROM research_records').get()!.record_json).toContain('Legacy rollback payload.')
    check.exec('DROP TRIGGER reject_human_migration')
  } finally { check.close() }
  expect(readdirSync(join(f.root, 'backups', 'migrations', hash(workspaceId))).some(name => name.startsWith('schema-v5-'))).toBe(true)
  expect(f.store.getResearchNote(workspaceId, legacy.record.recordId)?.text).toBe('Legacy rollback payload.')
})

it('fails closed when canonical human record/receipt rows are missing or metadata claims an unsupported downgrade', async () => {
  const f = await fixture(), request = command('tamper'), context = authority(request)
  f.store.recordHumanResearch(input(request), context); f.store.close()
  const damaged = new DatabaseSync(f.path)
  try { damaged.exec('DELETE FROM human_research_commands') } finally { damaged.close() }
  await f.reopen()
  expect(() => f.store.getResearchNote(workspaceId, 'note:any')).toThrow('provenance')
})

it('never resurrects deleted human prose when its current lifecycle projection is removed', async () => {
  const f = await fixture(), request = command('deleted-projection'), receipt = f.store.recordHumanResearch(input(request), authority(request))
  const remove: HumanResearchCommand = { ...frame('deleted-projection-remove'), action: 'delete', recordId: receipt.recordId, expectedVersion: 1 }
  f.store.transitionResearchRecord(lifecycle(receipt, remove), authority(remove).actor, authority(remove)); f.store.close()
  const damaged = new DatabaseSync(f.path)
  try { damaged.exec('DELETE FROM research_record_states') } finally { damaged.close() }
  await f.reopen()
  expect(() => f.store.getResearchNote(workspaceId, receipt.recordId)).toThrow('behind its journal')
})

it('rejects a v6 human-content database relabeled as v5 instead of downgrading it', async () => {
  const f = await fixture(), request = command('downgrade'), receipt = f.store.recordHumanResearch(input(request), authority(request)); f.store.close()
  const damaged = new DatabaseSync(f.path)
  try { damaged.exec("UPDATE metadata SET value='5' WHERE key='schema_version'") } finally { damaged.close() }
  await f.reopen()
  expect(() => f.store.getResearchNote(workspaceId, receipt.recordId)).toThrow('cannot be downgraded')
})

it('blocks legacy lifecycle calls for human-created Notes while preserving legacy Agent edits', async () => {
  const f = await fixture(), request = command('legacy-bypass'), note = f.store.recordHumanResearch(input(request), authority(request))
  const edit: HumanResearchCommand = { ...frame('legacy-bypass-edit'), action: 'edit', recordId: note.recordId, expectedVersion: 1, text: 'Must keep a command receipt.' }
  expect(() => f.store.transitionResearchRecord({ ...lifecycle(note, edit), idempotencyKey: 'legacy:human-note-edit' }, { kind: 'user', actorId })).toThrow('require a human command')
  expect(f.store.getResearchNote(workspaceId, note.recordId)?.version).toBe(1)
  const legacy = f.store.recordResearch({ schemaVersion: 1, requestType: 'research-record', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
    idempotencyKey: 'legacy:compatible-agent', callId: 'call:legacy-agent', kind: 'checkpoint', body: 'Legacy Agent record.' })
  expect(f.store.transitionResearchRecord({ ...lifecycle(note, edit), recordId: legacy.record.recordId, idempotencyKey: 'legacy:compatible-edit' }, { kind: 'user', actorId }).state.version).toBe(2)
})

function governanceCreate(key: string, sources: ResearchSourceIdentity[] = [source]) {
  const entry = { recordType: 'project-decision' as const, title: 'Exact source frame', decision: 'Use the captured original interpretation.' }
  const request = command(key, { action: 'create', entry, sourceRefs: sources.map(item => ({ documentId: item.documentId, revisionId: item.revisionId })), selections: [] })
  const context = { ...authority(request), governanceSources: structuredClone(sources) }
  const domain: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
    idempotencyKey: context.command.operationId, action: 'create', entry }
  return { request, context, domain, entry }
}

it('pins human Governance source hashes through revisions, Notebook and restart while rejecting legacy or rebound writes', async () => {
  const f = await fixture(), create = governanceCreate('governance-pinned'), record = f.store.mutateResearchGovernance(create.domain, create.context).record
  expect(f.store.getResearchGovernanceSources(workspaceId, record.recordId)).toEqual([source])
  expect(f.store.queryResearchNotebook(notebook(), [source]).items[0]).toMatchObject({ sourceIdentities: [source], sourceState: 'current-scope' })
  const request: HumanResearchCommand = { ...frame('governance-pinned-revise'), action: 'revise', recordId: record.recordId, expectedVersion: 1, entry: { ...create.entry, title: 'Revised title' } }
  const context = { ...authority(request), governanceSources: [source] }
  const domain: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', sessionId: conversationId, workspaceId, investigationId, scopeVersionId,
    idempotencyKey: context.command.operationId, action: 'revise', recordId: record.recordId, expectedVersion: 1, entry: request.entry }
  expect(() => f.store.mutateResearchGovernance({ ...domain, idempotencyKey: 'legacy:governance-bypass' })).toThrow('requires a human command')
  expect(() => f.store.mutateResearchGovernance(domain, { actor: context.actor, command: context.command, assertCurrent: context.assertCurrent })).toThrow('complete original source')
  expect(() => f.store.mutateResearchGovernance(domain, { ...context, governanceSources: [{ ...source, representationContentHash: 'b'.repeat(64) }] })).toThrow('cannot change its original source')
  expect(() => f.store.mutateResearchGovernance({ ...domain, sessionId: 'conversation:rebound' }, context)).toThrow('cannot rebind')
  f.store.mutateResearchGovernance(domain, context)
  expect(f.store.getResearchGovernanceSources(workspaceId, record.recordId)).toEqual([source])
  expect(f.store.getContinuityRecord(workspaceId, record.recordId)).toMatchObject({ sources: [source], sourceReferencesComplete: false, evidenceRefs: [] })
  await f.reopen()
  expect(f.store.queryResearchNotebook(notebook(), [source]).items[0]).toMatchObject({ sourceIdentities: [source], recordVersion: 2 })
  expect(f.store.getResearchGovernanceSources(workspaceId, record.recordId)).toEqual([source])
})

it('requires explicit human Governance sources while keeping legacy Governance getter and mutation semantics', async () => {
  const f = await fixture(), create = governanceCreate('governance-required')
  expect(() => f.store.mutateResearchGovernance(create.domain, { actor: create.context.actor, command: create.context.command, assertCurrent: create.context.assertCurrent })).toThrow('complete original source')
  const legacy = f.store.mutateResearchGovernance({ ...create.domain, idempotencyKey: 'legacy:governance-create' }).record
  expect(f.store.getResearchGovernanceSources(workspaceId, legacy.recordId)).toBeUndefined()
  const archive: ResearchGovernanceRequest = { schemaVersion: 1, requestType: 'research-governance', workspaceId, investigationId, scopeVersionId, sessionId: conversationId,
    idempotencyKey: 'legacy:governance-archive', action: 'archive', recordId: legacy.recordId, expectedVersion: 1 }
  expect(f.store.mutateResearchGovernance(archive).record.status).toBe('archived')
})

it.each(['missing-receipt', 'removed-marker', 'source-drift'] as const)('fails closed on human Governance journal %s without falling back to legacy', async mode => {
  const f = await fixture(), create = governanceCreate(`governance-tamper-${mode}`), record = f.store.mutateResearchGovernance(create.domain, create.context).record
  let operationId = create.context.command.operationId
  if (mode === 'source-drift') {
    const publicRequest: HumanResearchCommand = { ...frame('governance-tamper-revise'), action: 'revise', recordId: record.recordId, expectedVersion: 1, entry: create.entry }
    const context = { ...authority(publicRequest), governanceSources: [source] }; operationId = context.command.operationId
    f.store.mutateResearchGovernance({ schemaVersion: 1, requestType: 'research-governance', workspaceId, investigationId, scopeVersionId, sessionId: conversationId,
      idempotencyKey: operationId, action: 'revise', recordId: record.recordId, expectedVersion: 1, entry: create.entry }, context)
  }
  f.store.close()
  const damaged = new DatabaseSync(f.path)
  try {
    if (mode === 'missing-receipt') damaged.prepare('DELETE FROM human_research_commands WHERE operation_id=?').run(operationId)
    else {
      const journal = damaged.prepare('SELECT payload_json FROM journal_events WHERE idempotency_key=?').get(operationId)!
      const payload = JSON.parse(journal.payload_json as string)
      if (mode === 'removed-marker') delete payload.humanCommand
      else payload.humanCommand.sourceIdentities[0].representationContentHash = 'e'.repeat(64)
      const json = canonical(payload), digest = hash(json)
      damaged.prepare('UPDATE journal_events SET payload_json=?,payload_hash=? WHERE idempotency_key=?').run(json, digest, operationId)
      // Recompute the disposable receipt link too: verification must compare the original canonical frame.
      damaged.prepare('UPDATE human_research_commands SET event_hash=? WHERE operation_id=?').run(digest, operationId)
    }
  } finally { damaged.close() }
  await f.reopen()
  expect(() => f.store.getResearchGovernanceSources(workspaceId, record.recordId)).toThrow(mode === 'source-drift' ? 'immutable original source' : mode === 'missing-receipt' ? 'receipt' : 'command marker')
})
