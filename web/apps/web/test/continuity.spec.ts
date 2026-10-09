import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductContinuityAssess, ProductContinuityAssessment, ProductContinuityInspection } from '@docatlas/contracts'
import { ContinuityEvidenceGroup, ContinuitySaved } from '../src/live/Continuity'
import { acknowledgeContinuity, continuityOwner, continuityOwnerKey, continuityReadiness, continuityReadSources, continuityReceiptMatches, continuityStorageKey,
  mergeContinuitySources, parseContinuityPending, readContinuityOutbox, saveContinuityPending, type ContinuityOwner, type ContinuityPending } from '../src/live/continuity-state'
import { canonicalHash } from '../src/live/state'
import type { ReviewStorage } from '../src/live/review-state'
import type { LiveState } from '../src/live/client'

afterEach(() => vi.restoreAllMocks())
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-continuity.json', import.meta.url), 'utf8')) as { bases: { assess: ProductContinuityAssess, selected: ProductContinuityInspection, assessment: ProductContinuityAssessment } }
function setup() {
  const inspection = structuredClone(fixture.bases.selected), request = structuredClone(fixture.bases.assess)
  inspection.evidence.push({ ...inspection.evidence[0]!, evidenceId: request.priorEvidenceIds[0]!, revisionId: inspection.record.sources[0]!.revisionId, preview: 'Original reported figures.', physicalPage: 9 })
  const owner: ContinuityOwner = { actorId: 'actor:current', workspaceId: 'workspace:current', conversationId: inspection.conversationId, bindingId: inspection.bindingId, generation: inspection.generation, recordId: inspection.record.recordId }
  const pending: ContinuityPending = { schemaVersion: 1, owner, record: structuredClone(inspection.record), request }
  const values = new Map<string, string>(), mutations: string[] = []
  const storage: ReviewStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); mutations.push(`set:${key}`) }, removeItem: key => { values.delete(key); mutations.push(`remove:${key}`) }, key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
  return { inspection, owner, pending, values, mutations, storage }
}
async function receipt(pending: ContinuityPending): Promise<ProductContinuityAssessment> {
  const source = (value: { documentId: string, revisionId: string }) => ({ ...value, representationId: `representation:${value.revisionId}`, representationContentHash: 'a'.repeat(64) })
  return { ...structuredClone(fixture.bases.assessment), conversationId: pending.owner.conversationId, bindingId: pending.owner.bindingId, generation: pending.owner.generation,
    idempotencyKey: pending.request.idempotencyKey, requestHash: await canonicalHash(pending.request), result: { schemaVersion: 1, resultType: 'continuity-assessed', status: 'created', link: {
      ...structuredClone(fixture.bases.assessment.result.link), priorRecordId: pending.record.recordId, priorRecordVersion: pending.record.version, scopeVersionId: pending.request.scopeVersionId,
      priorSources: pending.record.sources.map(({ documentId, revisionId }) => source({ documentId, revisionId })), currentSources: pending.request.currentSources.map(source),
      priorEvidenceIds: [...pending.request.priorEvidenceIds], currentEvidenceIds: [...pending.request.currentEvidenceIds], state: pending.request.proposedState, verificationStatus: 'reverified', rationale: pending.request.rationale,
    } } }
}

describe('continuity frozen human decision outbox', () => {
  it('binds the exact authenticated actor, conversation, binding, generation and record', () => {
    const { owner } = setup(), binding = { conversationId: owner.conversationId, bindingId: owner.bindingId, generation: 1, ownerActorId: owner.actorId, workspaceId: owner.workspaceId }
    const state = { phase: 'ready', actor: { actorId: owner.actorId, workspaceId: owner.workspaceId }, selected: owner.conversationId, snapshot: { binding } } as LiveState
    expect(continuityOwner(state, owner.recordId)).toEqual(owner)
    expect(continuityOwner({ ...state, phase: 'pairing' }, owner.recordId)).toBeNull()
    expect(continuityOwner({ ...state, selected: 'conversation:other' }, owner.recordId)).toBeNull()
    expect(continuityOwner(state, '../private')).toBeNull()
    for (const key of ['actorId', 'workspaceId', 'conversationId', 'bindingId', 'recordId'] as const) expect(continuityOwnerKey({ ...owner, [key]: 'different:owner' })).not.toBe(continuityOwnerKey(owner))
    expect(continuityOwnerKey({ ...owner, generation: 2 })).not.toBe(continuityOwnerKey(owner))
  })
  it('restores the whole original version/scope/body/key without a mutation or current-scope retarget', () => {
    const test = setup(); saveContinuityPending(test.storage, test.pending)
    const before = [...test.mutations], raw = test.values.get(continuityStorageKey(test.pending))!
    expect(parseContinuityPending(raw, test.owner)).toEqual(test.pending)
    expect(readContinuityOutbox(test.storage, test.owner)).toEqual({ state: 'pending', key: continuityStorageKey(test.pending), value: test.pending, current: true })
    expect(readContinuityOutbox(test.storage, { ...test.owner, bindingId: 'binding:restart', generation: 2 })).toMatchObject({ state: 'pending', current: false, value: test.pending })
    expect(test.mutations).toEqual(before)
    for (const changed of [{ recordId: 'note:other' }, { actorId: 'actor:other' }, { workspaceId: 'workspace:other' }, { conversationId: 'conversation:other' }]) expect(readContinuityOutbox(test.storage, { ...test.owner, ...changed })).toEqual({ state: 'empty' })
    expect(continuityStorageKey({ ...test.pending, request: { ...test.pending.request, scopeVersionId: 'scope:newer' } })).not.toBe(continuityStorageKey(test.pending))
  })
  it('rejects owner injection, arbitrary endpoints, lost version pins and invalid source bodies', () => {
    const test = setup()
    const mutations = [
      (value: ContinuityPending) => { value.owner.actorId = 'actor:other' }, (value: ContinuityPending) => { value.request.expectedGeneration++ },
      (value: ContinuityPending) => { value.request.expectedPriorVersion++ }, (value: ContinuityPending) => { value.record.recordId = 'note:other' },
      (value: ContinuityPending) => { value.request.currentSources = [] }, (value: ContinuityPending) => { value.request.priorEvidenceIds = [] },
      (value: ContinuityPending) => { value.record.sourceReferencesComplete = false }, (value: ContinuityPending) => { Reflect.set(value, 'endpoint', '/private') },
      (value: ContinuityPending) => { Reflect.set(value.request, 'actorId', 'actor:admin') }, (value: ContinuityPending) => { value.request.rationale = '  ' },
    ]
    for (const mutate of mutations) { const value = structuredClone(test.pending); mutate(value); expect(() => parseContinuityPending(JSON.stringify(value), test.owner)).toThrow() }
    expect(() => parseContinuityPending('x'.repeat(131073), test.owner)).toThrow('bound')
  })
  it('fails closed on malformed, multiply-pending, missing and non-retained storage', () => {
    const test = setup(), key = continuityStorageKey(test.pending)
    expect(() => saveContinuityPending({ ...test.storage, setItem() { throw new Error('quota') } }, test.pending)).toThrow('quota')
    expect(() => saveContinuityPending({ ...test.storage, setItem() {} }, test.pending)).toThrow('not retained')
    test.values.set(key, '{broken')
    expect(readContinuityOutbox(test.storage, test.owner)).toEqual({ state: 'invalid', key })
    expect(() => saveContinuityPending(test.storage, test.pending)).toThrow('uncertain')
    test.values.set(key, JSON.stringify(test.pending)); test.values.set(`${key}:other`, JSON.stringify(test.pending))
    expect(readContinuityOutbox(test.storage, test.owner).state).toBe('invalid')
    expect(test.values.size).toBe(2)
  })
  it('accepts only a hash-bound matching user decision with the original record version and both source/evidence sets', async () => {
    const test = setup(), value = await receipt(test.pending)
    expect(await continuityReceiptMatches(test.pending, value)).toBe(true)
    expect(await continuityReceiptMatches(test.pending, { ...value, result: { ...value.result, status: 'replayed' } })).toBe(true)
    const bad = [
      { ...value, generation: 2 }, { ...value, bindingId: 'binding:other' }, { ...value, conversationId: 'conversation:other' }, { ...value, idempotencyKey: 'continuity:new-key' }, { ...value, requestHash: 'f'.repeat(64) },
      ...[{ priorRecordVersion: 2 }, { priorRecordId: 'note:other' }, { scopeVersionId: 'scope:other' }, { workspaceId: 'workspace:other' }, { rationale: 'Changed text.' },
        { createdBy: { kind: 'user' as const, actorId: 'actor:other' } }, { state: 'continuing' as const }, { currentEvidenceIds: ['evidence:different'] }, { priorEvidenceIds: ['evidence:different'] },
        { currentSources: [{ ...value.result.link.currentSources[0]!, revisionId: 'revision:newest' }] }, { priorSources: [{ ...value.result.link.priorSources[0]!, revisionId: 'revision:different' }] }]
        .map(changes => ({ ...value, result: { ...value.result, link: { ...value.result.link, ...changes } } })),
    ]
    saveContinuityPending(test.storage, test.pending)
    for (const candidate of bad) { expect(await continuityReceiptMatches(test.pending, candidate)).toBe(false); expect(await acknowledgeContinuity(test.storage, test.pending, candidate, () => true)).toBe(false) }
    expect(test.values.size).toBe(1)
    expect(await acknowledgeContinuity(test.storage, test.pending, value, () => true)).toBe(true); expect(test.values.size).toBe(0)
  })
  it('preserves exact Unicode rationale rather than normalizing the immutable request', async () => {
    const test = setup(); test.pending.request.rationale = ' cafe\u0301 — 仍待复核\n '
    const value = await receipt(test.pending)
    expect(await continuityReceiptMatches(test.pending, value)).toBe(true)
    expect(await continuityReceiptMatches(test.pending, { ...value, result: { ...value.result, link: { ...value.result.link, rationale: test.pending.request.rationale.normalize('NFC') } } })).toBe(false)
  })
  it('rechecks the owner after async hashing and never clears a newer pending body', async () => {
    const test = setup(), value = await receipt(test.pending); saveContinuityPending(test.storage, test.pending)
    let current = true
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
    const acknowledging = acknowledgeContinuity(test.storage, test.pending, value, () => current)
    await entered.promise; current = false; release.resolve()
    expect(await acknowledging).toBe(false); expect(test.values.size).toBe(1)
    test.values.set(continuityStorageKey(test.pending), JSON.stringify({ ...test.pending, request: { ...test.pending.request, idempotencyKey: 'continuity:newer' } }))
    expect(await acknowledgeContinuity(test.storage, test.pending, value, () => true)).toBe(false); expect(test.values.size).toBe(1)
  })
})

describe('explicit source/evidence comparison, never semantic inference', () => {
  it('requires explicit completed scope and current-source choices even when server offers a recent scope', () => {
    const { inspection, pending } = setup(), request = pending.request
    expect(continuityReadiness(inspection, '', request.currentSources, request.priorEvidenceIds, request.currentEvidenceIds)).toEqual({ unknown: false, comparative: false })
    expect(continuityReadiness(inspection, 'scope:prepared', request.currentSources, request.priorEvidenceIds, request.currentEvidenceIds).unknown).toBe(false)
    expect(continuityReadiness(inspection, request.scopeVersionId, [], request.priorEvidenceIds, request.currentEvidenceIds).unknown).toBe(false)
    expect(continuityReadiness(inspection, request.scopeVersionId, request.currentSources, request.priorEvidenceIds, request.currentEvidenceIds)).toEqual({ unknown: true, comparative: true })
  })
  it('offers current sources only from real read Evidence, preserving exact versions without inferring newest', () => {
    const { inspection } = setup()
    inspection.record.sources.push({ documentId: 'doc:unread', revisionId: 'revision:9999', name: 'Not read.pdf' })
    inspection.evidence.push({ ...inspection.evidence[0]!, evidenceId: 'evidence:another-block' })
    expect(continuityReadSources(inspection)).toEqual([
      { documentId: 'document:annual', revisionId: 'revision:annual:2', name: 'Annual.pdf' },
      { documentId: 'document:annual', revisionId: 'revision:annual:1', name: 'Annual.pdf' },
    ])
  })
  it('restricts partial/truncated material to unknown and requires evidence coverage on both complete source lists', () => {
    const { inspection, pending } = setup(), request = pending.request
    const ready = (value: ProductContinuityInspection, prior = request.priorEvidenceIds, current = request.currentEvidenceIds) => continuityReadiness(value, request.scopeVersionId, request.currentSources, prior, current)
    expect(ready({ ...inspection, truncated: true })).toEqual({ unknown: true, comparative: false })
    const historyWindow = { ...inspection, scopeOptionsTruncated: true }
    expect(ready(historyWindow)).toEqual({ unknown: true, comparative: true })
    expect(ready({ ...inspection, record: { ...inspection.record, sourceReferencesComplete: false } })).toEqual({ unknown: true, comparative: false })
    expect(ready(inspection, [])).toEqual({ unknown: true, comparative: false })
    expect(ready(inspection, request.priorEvidenceIds, [])).toEqual({ unknown: true, comparative: false })
    expect(ready({ ...inspection, record: { ...inspection.record, sources: [...inspection.record.sources, { documentId: 'doc:unread', revisionId: 'revision:unread', name: 'Unread.pdf' }] } })).toEqual({ unknown: true, comparative: false })
    expect(ready(inspection, request.currentEvidenceIds).unknown).toBe(false)
    expect(ready(inspection, request.priorEvidenceIds, request.priorEvidenceIds).unknown).toBe(false)
  })
  it('does not accept stale, fabricated, duplicate or unmatched selected evidence/sources', () => {
    const { inspection, pending } = setup(), request = pending.request
    for (const sources of [[...request.currentSources, ...request.currentSources], [{ documentId: 'document:annual', revisionId: 'revision:not-read' }]]) expect(continuityReadiness(inspection, request.scopeVersionId, sources, [], []).unknown).toBe(false)
    for (const ids of [['note:interpretation'], [...request.priorEvidenceIds, ...request.priorEvidenceIds]]) expect(continuityReadiness(inspection, request.scopeVersionId, request.currentSources, ids, []).unknown).toBe(false)
  })
  it('only merges exact old source pairs, retains other selections and does not mutate the question or submit', () => {
    const { inspection } = setup(), current = [{ documentId: 'document:annual', revisionId: 'revision:annual:2' }, { documentId: 'document:other', revisionId: 'revision:other' }]
    const original = structuredClone(current), merged = mergeContinuitySources(current, inspection.record.sources)
    expect(merged).toEqual([...current, { documentId: 'document:annual', revisionId: 'revision:annual:1' }])
    expect(current).toEqual(original); expect(mergeContinuitySources(merged, inspection.record.sources)).toEqual(merged)
    expect(() => mergeContinuitySources(Array.from({ length: 32 }, (_, index) => ({ documentId: `doc:${index}`, revisionId: 'revision:one' })), inspection.record.sources)).toThrow('limit')
    expect(() => mergeContinuitySources(current, [{ documentId: '../private', revisionId: 'revision:one' }])).toThrow()
  })
  it('renders independently selectable evidence sides with original-PDF actions, escaped text and exact version IDs', () => {
    const { inspection, pending } = setup(); inspection.evidence[0]!.preview = '<script>not executed</script>'
    const html = renderToStaticMarkup(createElement(ContinuityEvidenceGroup, { title: '旧侧证据', evidence: inspection.evidence, selected: pending.request.priorEvidenceIds, disabled: false, focusDisabled: false, onSelect() {}, onFocus() {} }))
    expect(html).toContain('旧侧证据'); expect(html.match(/核对原始 PDF/gu)).toHaveLength(2); expect(html.match(/checked=""/gu)).toHaveLength(1)
    expect(html).toContain('revision:annual:1'); expect(html).toContain('revision:annual:2'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('href=')
    const empty = renderToStaticMarkup(createElement(ContinuityEvidenceGroup, { title: '本次侧', evidence: [], selected: [], disabled: false, focusDisabled: false, onSelect() {}, onFocus() {} }))
    expect(empty).toContain('不以笔记正文填补')
  })
  it('displays the returned durable link, original version pin and human state without rewriting the old record', async () => {
    const { pending } = setup(), value = await receipt(pending)
    const html = renderToStaticMarkup(createElement(ContinuitySaved, { value }))
    expect(html).toContain('已有变化'); expect(html).toContain(value.result.link.continuityLinkId); expect(html).toContain('固定版本 v1'); expect(html).toContain('不是对旧研究记录的覆盖')
    expect(renderToStaticMarkup(createElement(ContinuitySaved, { value: { ...value, result: { ...value.result, status: 'replayed' } } }))).toContain('已核对原判断')
  })
})
