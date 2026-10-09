import { afterEach, expect, it, vi } from 'vitest'
import type { ProductLearningView } from '@docatlas/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiveLearning } from '../src/live/Learning'
import { acknowledgeLearning, activeLearningOffer, checkedLearningView, learningOwnerKey, learningReceiptMatches, learningStorageKey,
  parseLearningPending, readLearningPending, saveLearningPending } from '../src/live/learning-state'
import { learningFixture } from './learning-fixture'

afterEach(() => vi.restoreAllMocks())
it('independently verifies the complete learning-tagged material, recipes and original ownership', async () => {
  const f = await learningFixture()
  expect(await checkedLearningView(f.owner, f.view)).toEqual(f.view)
  for (const change of [(view: ProductLearningView) => { view.comparison!.material!.nativeTextHash = 'f'.repeat(64) },
    (view: ProductLearningView) => { view.comparison!.probe!.probeId = 'learning-probe:forged' },
    (view: ProductLearningView) => { view.comparison!.probe!.backbone.evidenceAtomIds = [] },
    (view: ProductLearningView) => { view.comparison!.probe!.variants[0]!.artifactId = 'presentation:forged' },
    (view: ProductLearningView) => { view.comparison!.material!.manifest.blocks[0]!.segments[0]!.text += ' altered' },
    (view: ProductLearningView) => { view.binding = { ...view.binding, bindingId: 'binding:other' } }]) {
    const value = structuredClone(f.view); change(value); await expect(checkedLearningView(f.owner, value)).rejects.toThrow()
  }
})
it('retains a reference-only original outbox, rejects malformed/foreign data, and cannot mutate an independent Ask', async () => {
  const f = await learningFixture(), raw = JSON.stringify(f.pending), key = learningStorageKey(f.owner)
  f.storage.setItem('question', 'unchanged question/sourceRefs/selection tickets'); saveLearningPending(f.storage, f.pending)
  expect(f.storage.getItem(key)).toBe(raw); expect(raw).not.toContain(f.material.manifest.blocks[0]!.segments[0]!.text)
  expect(parseLearningPending(raw, f.owner)).toEqual(f.pending)
  expect(readLearningPending(f.storage, { ...f.owner, generation: 2, bindingId: 'binding:next' })).toMatchObject({ state: 'pending', current: false, value: f.pending })
  expect(() => saveLearningPending(f.storage, f.pending)).toThrow('uncertain')
  for (const invalid of ['{', JSON.stringify({ ...f.pending, actorId: 'injected' }), JSON.stringify({ ...f.pending, profileEpoch: 2 }),
    JSON.stringify({ ...f.pending, owner: { ...f.owner, actorId: 'actor:foreign' } }), JSON.stringify({ ...f.pending, material: { ...f.pending.material, sourceScopeVersionId: '/private/path' } })]) {
    expect(() => parseLearningPending(invalid, f.owner)).toThrow()
  }
  expect(f.storage.getItem('question')).toBe('unchanged question/sourceRefs/selection tickets')
})
it('keeps early null candidate receipts immutable and clears only exactly matched original commit metadata', async () => {
  const f = await learningFixture(), operation = await f.operation()
  saveLearningPending(f.storage, f.pending)
  expect(operation.receipt!.candidateId).toBeNull(); expect(await learningReceiptMatches(f.pending, operation)).toBe(true)
  for (const change of ['requestHash', 'actorId', 'bindingId', 'action', 'targetId', 'targetVersion', 'profileEpoch'] as const) {
    const changed = structuredClone(operation)
    Reflect.set(changed.receipt!, change, change === 'targetVersion' || change === 'profileEpoch' ? 5 : change === 'requestHash' ? 'f'.repeat(64) : 'foreign:value')
    expect(await acknowledgeLearning(f.storage, f.pending, changed, () => true)).toBe(false)
  }
  expect(await acknowledgeLearning(f.storage, f.pending, { ...operation, receipt: null }, () => true)).toBe(false)
  expect(await acknowledgeLearning(f.storage, f.pending, operation, () => false)).toBe(false)
  expect(await acknowledgeLearning(f.storage, f.pending, operation, () => true)).toBe(true)
  expect(readLearningPending(f.storage, f.owner)).toEqual({ state: 'empty' })
})
it('does not clear replaced pending input or cross a newly observed owner/epoch during async digest checks', async () => {
  const f = await learningFixture(), result = await f.operation(); saveLearningPending(f.storage, f.pending)
  const pending = acknowledgeLearning(f.storage, f.pending, result, () => true)
  f.storage.setItem(learningStorageKey(f.owner), 'a different pending body')
  expect(await pending).toBe(false); expect(f.storage.getItem(learningStorageKey(f.owner))).toBe('a different pending body')
  expect(await learningReceiptMatches(f.pending, { ...result, profileEpoch: 1, receipt: { ...result.receipt!, profileEpoch: 1 } })).toBe(false)
  expect(learningOwnerKey(f.owner)).not.toBe(learningOwnerKey({ ...f.owner, generation: 2 }))
})
it('offers only for the latest actual native Answer, remains default-off and suppresses generation/unknown/old/dismissed invitations without recording feedback', async () => {
  const f = await learningFixture(), enabled = { ...f.view, settings: { version: 1, enabled: true }, offers: [f.offer] }
  expect(activeLearningOffer(f.state, { ...enabled, settings: { version: 0, enabled: false } })).toBeUndefined()
  expect(activeLearningOffer(f.state, enabled)).toEqual(f.offer)
  expect(activeLearningOffer({ ...f.state, sending: true }, enabled)).toBeUndefined()
  expect(activeLearningOffer(f.state, { ...enabled, contributionAllowed: false })).toBeUndefined()
  expect(activeLearningOffer(f.state, enabled, new Set([f.offer.offerId]))).toBeUndefined()
  expect(activeLearningOffer(f.state, enabled, new Set(), f.offer.offerId)).toBeUndefined()
  const next = structuredClone(f.state); next.snapshot!.history.messages.push({ entryId: '00000001', role: 'assistant', text: 'Later in real native order, despite a smaller ID.', truncated: false })
  expect(activeLearningOffer(next, enabled)).toBeUndefined()
  next.history = { ...next.history, loaded: true, messages: [f.snapshot.history.messages[0]!] }
  expect(activeLearningOffer(next, enabled)).toBeUndefined()
  const client = { state: () => f.state, learningQuery: vi.fn(), learningCommand: vi.fn(), learningOperation: vi.fn() }
  expect(renderToStaticMarkup(createElement(LiveLearning, { client, state: f.state, onCitation: async () => {} }))).toBe('')
  expect(client.learningCommand).not.toHaveBeenCalled(); expect(client.learningOperation).not.toHaveBeenCalled()
})
