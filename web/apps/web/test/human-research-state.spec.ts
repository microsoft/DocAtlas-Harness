import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { HumanResearchCommand, HumanResearchEntry } from '@docatlas/contracts'
import { HumanResearchForm } from '../src/live/HumanResearch'
import { acknowledgeHumanResearch, emptyHumanResearchEditor, humanResearchBinding, humanResearchEditorCommand, humanResearchEntryEditor, humanResearchOwnerKey, humanResearchReceiptMatches,
  humanResearchStorageKey, humanResearchTextLimit, mergeHumanResearchPages, parseHumanResearchPending, readHumanResearchOutbox, saveHumanResearchPending } from '../src/live/human-research-state'
import { humanResearchFixture } from './human-research-fixture'

it('stores one exact independent research outbox and retains old generation commands without re-epoching', async () => {
  const f = await humanResearchFixture(), raw = JSON.stringify(f.pending), key = humanResearchStorageKey(f.owner)
  f.storage.setItem('question:independent', 'unchanged Ask body/key/sourceRefs/tickets')
  saveHumanResearchPending(f.storage, f.pending)
  expect(f.storage.getItem(key)).toBe(raw); expect(parseHumanResearchPending(raw, f.owner)).toEqual(f.pending)
  expect(key).toContain(':@human-research:')
  expect(readHumanResearchOutbox(f.storage, { ...f.owner, generation: 2, bindingId: 'binding:two' })).toMatchObject({ state: 'pending', current: false, value: f.pending })
  expect(() => saveHumanResearchPending(f.storage, f.pending)).toThrow('uncertain')
  expect(f.storage.getItem('question:independent')).toBe('unchanged Ask body/key/sourceRefs/tickets')
})
it('rejects foreign, malformed and private-source envelopes without repairing or replacing them', async () => {
  const f = await humanResearchFixture()
  for (const raw of ['{', '文'.repeat(70000), JSON.stringify({ ...f.pending, path: '/private' }), JSON.stringify({ ...f.pending, owner: { ...f.owner, actorId: 'actor:other' } }),
    JSON.stringify({ ...f.pending, request: { ...f.command, expectedGeneration: 2 } }), JSON.stringify({ ...f.pending, request: { ...f.command, actorId: 'actor:spoof' } })]) {
    f.storage.setItem(humanResearchStorageKey(f.owner), raw)
    expect(() => parseHumanResearchPending(raw, f.owner)).toThrow(); expect(readHumanResearchOutbox(f.storage, f.owner)).toEqual({ state: 'invalid', raw })
    expect(f.storage.getItem(humanResearchStorageKey(f.owner))).toBe(raw)
  }
})
it('requires durable tab retention before writing and rejects a silently failing storage setter', async () => {
  const f = await humanResearchFixture()
  expect(() => saveHumanResearchPending({ ...f.storage, setItem() { throw new Error('quota') } }, f.pending)).toThrow('quota')
  expect(() => saveHumanResearchPending({ ...f.storage, setItem() {} }, f.pending)).toThrow('not retained')
})
it('acknowledges only the whole original metadata receipt; null and mismatched results cannot clear it', async () => {
  const f = await humanResearchFixture(), operation = await f.operation()
  saveHumanResearchPending(f.storage, f.pending)
  expect(await humanResearchReceiptMatches(f.pending, operation)).toBe(true)
  for (const candidate of [{ ...operation, receipt: null }, { ...operation, operationId: 'human-op:other' }, ...['requestHash', 'idempotencyKey', 'bindingId', 'recordType', 'recordVersion', 'actorId', 'action'].map(key => {
    const value = structuredClone(operation); Reflect.set(value.receipt!, key, key === 'recordVersion' ? 2 : key === 'requestHash' ? '0'.repeat(64) : 'other:value'); return value
  })]) {
    expect(await humanResearchReceiptMatches(f.pending, candidate)).toBe(false)
    expect(await acknowledgeHumanResearch(f.storage, f.pending, candidate, () => true)).toBe(false)
  }
  expect(await acknowledgeHumanResearch(f.storage, f.pending, operation, () => false)).toBe(false)
  expect(await acknowledgeHumanResearch(f.storage, f.pending, operation, () => true)).toBe(true)
  expect(readHumanResearchOutbox(f.storage, f.owner)).toEqual({ state: 'empty' })
})
it('can reconcile old metadata in a new authorized binding without replaying or restoring deleted prose', async () => {
  const f = await humanResearchFixture(), next = { ...f.binding, bindingId: 'binding:two', generation: 2, version: 2 }
  saveHumanResearchPending(f.storage, f.pending)
  const operation = await f.operation(f.command, next)
  expect(humanResearchBinding({ ...f.owner, bindingId: next.bindingId, generation: 2 }, operation.binding)).toBe(true)
  expect(await acknowledgeHumanResearch(f.storage, f.pending, operation, () => true)).toBe(true)
  expect(JSON.stringify(operation.receipt)).not.toContain('body')
  const injected = { ...operation, receipt: { ...operation.receipt!, body: 'Deleted old prose' } }
  expect(await humanResearchReceiptMatches(f.pending, injected)).toBe(false)
})
it('does not delete a new pending body written during asynchronous receipt verification', async () => {
  const f = await humanResearchFixture(), result = await f.operation()
  saveHumanResearchPending(f.storage, f.pending)
  const done = acknowledgeHumanResearch(f.storage, f.pending, result, () => true)
  f.storage.setItem(humanResearchStorageKey(f.owner), 'new independent body')
  expect(await done).toBe(false); expect(f.storage.getItem(humanResearchStorageKey(f.owner))).toBe('new independent body')
})
it('free drafts explicitly start without sources or anchors and selection authoring never creates an Ask ticket', async () => {
  const f = await humanResearchFixture(), free = { ...emptyHumanResearchEditor(), text: 'A free human note' }
  const command = humanResearchEditorCommand(f.owner, free, 'human:free:command:one')!
  expect(command).toMatchObject({ action: 'create', sourceRefs: [], selections: [], entry: { recordType: 'research-note', body: free.text } })
  const selected = { ...free, selections: [f.proposal] }, before = structuredClone(selected)
  expect(humanResearchEditorCommand(f.owner, selected, 'human:selected:command:one')).toMatchObject({ action: 'create', sourceRefs: [], selections: [f.proposal] })
  expect(selected).toEqual(before); expect(JSON.stringify(command)).not.toMatch(/selectionContextId|submissionId|createdBy|evidence/)
  expect(humanResearchEditorCommand(f.owner, { ...selected, recordType: 'research-policy', title: 'Rule' }, 'human:invalid:command:one')).toBeNull()
})
it('validates all four typed create forms and complete governance content rather than list previews', async () => {
  const f = await humanResearchFixture()
  for (const recordType of ['research-note', 'open-question', 'project-decision', 'research-policy'] as const) {
    const draft = { ...emptyHumanResearchEditor(), recordType, text: 'Full body', title: 'Explicit governance', rationale: 'Reason', policyScope: 'workspace' as const }
    const command = humanResearchEditorCommand(f.owner, draft, `human:${recordType}`)
    expect(command).toMatchObject({ action: 'create', entry: { recordType }, sourceRefs: [], selections: [] })
  }
  const draft = humanResearchEntryEditor(f.governanceEntry), changed = { ...draft, title: '修订标题', text: '完整修订的决策', rationale: '完整理由' }
  expect(humanResearchEditorCommand(f.owner, changed, 'human:revise:command:one', f.governanceEntry)).toMatchObject({ action: 'revise', recordId: f.governanceEntry.entry.recordId, expectedVersion: 1,
    entry: { recordType: 'project-decision', title: changed.title, decision: changed.text, rationale: changed.rationale } })
  expect(humanResearchEditorCommand(f.owner, { ...changed, recordType: 'research-policy' }, 'human:wrong-type:command:one', f.governanceEntry)).toBeNull()
})
it('edits existing Agent Questions and legacy notes by the full current version and rejects deleted targets', async () => {
  const f = await humanResearchFixture(), entry: HumanResearchEntry = structuredClone(f.entry)
  if (!('kind' in entry.entry)) throw new Error('Fixture note expected')
  Object.assign(entry.entry, { authoredBy: 'agent', recordType: 'open-question', status: 'open', version: 3, text: '完整版待解决问题。'.repeat(80) })
  const draft = humanResearchEntryEditor(entry)
  expect(draft.text).toBe(entry.entry.text)
  expect(humanResearchEditorCommand(f.owner, { ...draft, text: `${draft.text}\n补充` }, 'human:edit:command:one', entry)).toMatchObject({ action: 'edit', expectedVersion: 3, text: `${draft.text}\n补充` })
  entry.entry.status = 'deleted'; entry.entry.text = null
  expect(humanResearchEditorCommand(f.owner, draft, 'human:deleted:command:one', entry)).toBeNull()
})
it('keeps input limits distinct and makes governance limitations visible in the real form markup', async () => {
  const f = await humanResearchFixture(), free = { ...emptyHumanResearchEditor(), text: '文'.repeat(4000) }
  expect(humanResearchEditorCommand(f.owner, free, 'human:limit:command:one')).not.toBeNull()
  expect(humanResearchEditorCommand(f.owner, { ...free, text: `${free.text}多` }, 'human:limit:command:one')).toBeNull()
  const draft = { ...emptyHumanResearchEditor(), recordType: 'research-policy' as const, title: '<img onerror=alert(1)>', text: '规则正文', policyScope: 'workspace' as const }
  const html = renderToStaticMarkup(createElement(HumanResearchForm, { draft, editing: false, disabled: false, availableSources: [f.sourceRef], onChange() {} }))
  expect(html).toContain('规则不会自动继承或执行'); expect(html).toContain('自由记录默认无来源'); expect(html).not.toContain('<img onerror')
  expect(html).toContain('研究规则声明范围'); expect(html).not.toMatch(/type="checkbox"[^>]*checked/)
})
it('fences page merging by current binding, query/filter hash, exact cursor, duplicate IDs and display bound', async () => {
  const f = await humanResearchFixture(), page = structuredClone(f.workspace)
  page.result.pageInfo.nextCursor = 'cursor:one'
  const first = mergeHumanResearchPages(null, page, f.query, f.owner)
  expect(first.latest).toEqual(page); expect(first.items).toEqual([])
  expect(() => mergeHumanResearchPages(first, { ...page, binding: { ...page.binding, generation: 2 } }, f.query, f.owner)).toThrow()
  expect(() => mergeHumanResearchPages(first, { ...page, result: { ...page.result, queryHash: '0'.repeat(64) } }, { ...f.query, cursor: 'cursor:one' }, f.owner)).toThrow()
  expect(() => mergeHumanResearchPages(first, page, { ...f.query, cursor: 'cursor:wrong' }, f.owner)).toThrow()
  expect(humanResearchOwnerKey(f.owner)).not.toBe(humanResearchOwnerKey({ ...f.owner, generation: 2 }))
})
it('keeps Question create/edit at 4000 scalars while Note edits permit exactly 8000, including astral text', async () => {
  const f = await humanResearchFixture(), question = structuredClone(f.entry)
  if (!('kind' in question.entry)) throw new Error('Fixture note expected')
  question.entry.recordType = 'open-question'; question.entry.status = 'open'
  for (const editing of [false, true]) {
    const draft = { ...humanResearchEntryEditor(question), text: '🧪'.repeat(4000) }
    expect(humanResearchTextLimit('open-question', editing)).toBe(4000)
    expect(humanResearchEditorCommand(f.owner, draft, 'human:question:boundary', editing ? question : null)).not.toBeNull()
    expect(humanResearchEditorCommand(f.owner, { ...draft, text: `${draft.text}多` }, 'human:question:boundary', editing ? question : null)).toBeNull()
  }
  const note = { ...humanResearchEntryEditor(f.entry), text: '🧪'.repeat(8000) }
  expect(humanResearchTextLimit('research-note', false)).toBe(4000); expect(humanResearchTextLimit('research-note', true)).toBe(8000)
  expect(humanResearchEditorCommand(f.owner, note, 'human:note:boundary', f.entry)).not.toBeNull()
  expect(humanResearchEditorCommand(f.owner, { ...note, text: `${note.text}多` }, 'human:note:boundary', f.entry)).toBeNull()
  expect(humanResearchEditorCommand(f.owner, { ...note, text: '文'.repeat(4000) }, 'human:note:boundary')).not.toBeNull()
  expect(humanResearchEditorCommand(f.owner, { ...note, text: '文'.repeat(4001) }, 'human:note:boundary')).toBeNull()
})
it('renders the matching typed textarea limits for free/edit Note, Question and governance', () => {
  for (const [recordType, editing, limit] of [
    ['research-note', false, 4000], ['research-note', true, 8000], ['open-question', false, 4000], ['open-question', true, 4000],
    ['project-decision', false, 8000], ['project-decision', true, 8000], ['research-policy', false, 8000], ['research-policy', true, 8000],
  ] as const) {
    const html = renderToStaticMarkup(createElement(HumanResearchForm, { draft: { ...emptyHumanResearchEditor(), recordType }, editing, disabled: false, availableSources: [], onChange() {} }))
    const body = html.match(/<textarea[^>]*aria-label="人类研究完整正文"[^>]*>/u)?.[0]
    expect(body).toContain(`maxLength="${limit}"`)
  }
})
it('matches CAS metadata for edits and typed revisions, not just matching new record text', async () => {
  const f = await humanResearchFixture(), request: HumanResearchCommand = { ...f.command, action: 'edit', recordId: 'note:existing', expectedVersion: 4, text: 'Full revised text' }
  // Rebuild the union branch rather than sending create-only fields to the parser.
  const clean: HumanResearchCommand = { schemaVersion: 1, kind: 'human-research-command', expectedBindingId: request.expectedBindingId, expectedGeneration: request.expectedGeneration,
    idempotencyKey: request.idempotencyKey, action: 'edit', recordId: request.recordId, expectedVersion: 4, text: request.text }
  const pending = { ...f.pending, request: clean }, operation = await f.operation(clean)
  expect(await humanResearchReceiptMatches(pending, operation)).toBe(true)
  expect(await humanResearchReceiptMatches(pending, { ...operation, receipt: { ...operation.receipt!, recordVersion: 6 } })).toBe(false)
})
