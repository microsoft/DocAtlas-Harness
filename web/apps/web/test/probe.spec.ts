import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { answerVerificationSummary, type AnswerManifest, type AnswerResponse } from '@docatlas/contracts'
import { ProbeEvidenceCollection, ProbePresentationCard, ProbePresentations } from '../src/live/ProbePresentations'
import { LearningChoiceControls } from '../src/live/Learning'
import { blankProbeChoice, chooseProbeDraft, probeAnswerOwner, probeAnswerOwnerKey, probeDraftReady, probeOwnerKey, probePresentations, probePrefix, probeStorageKey, type ProbeOwner, type ProbeVariantInput } from '../src/live/probe-state'
import type { LiveState } from '../src/live/client'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-answer.json', import.meta.url), 'utf8')) as { bases: { response: AnswerResponse } }
const variants: ProbeVariantInput[] = [
  { variantKey: 'variant:whole-answer', effect: { key: 'answer-order', value: 'conclusion-first' } },
  { variantKey: 'variant:whole-evidence', effect: { key: 'answer-order', value: 'evidence-first' } },
]
const order = variants.map(variant => variant.variantKey)
function richManifest(): AnswerManifest {
  const manifest = structuredClone(fixture.bases.response.manifest!), original = manifest.citations[0]!
  for (const relation of ['refute', 'qualify'] as const) manifest.citations.push({ ...structuredClone(original), citationId: `citation:${relation}`, ordinal: manifest.citations.length + 1, relation })
  const clue = { ...structuredClone(original), citationId: 'citation:unverified', ordinal: 4, verificationStatus: 'locator-only' as const }
  delete clue.evidence; manifest.citations.push(clue)
  manifest.blocks[0]!.segments = [
    { ...manifest.blocks[0]!.segments[0]!, status: 'contested', text: '<script>same facts, never executed</script> 仍有争议。', visibleCitationIds: manifest.citations.slice(0, 3).map(value => value.citationId) },
    { segmentId: 'segment:unresolved', kind: 'factual', status: 'unresolved', text: '尚不能支持的结论也必须保留。', claimVersionIds: [], visibleCitationIds: [clue.citationId] },
    { segmentId: 'segment:unclassified', kind: 'unclassified', status: 'unresolved', text: '尚未分类的原始文字，不因呈现比较而省略。', claimVersionIds: [], visibleCitationIds: [] },
  ]
  manifest.answerTextHash = createHash('sha256').update(manifest.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n')).digest('hex')
  manifest.verificationSummary = answerVerificationSummary(manifest.blocks.flatMap(block => block.segments), manifest.citations, ['scope-conflict', 'unknown-locator', 'limit-exceeded'])
  manifest.manifestStatus = 'partial'
  return manifest
}
const rendered = (presentation: ReturnType<typeof probePresentations>[number]) => renderToStaticMarkup(createElement(ProbePresentationCard, { presentation, busy: false, onCitation() {} }))
const section = (html: string, key: string) => new RegExp(`<section[^>]+data-probe-section="${key}">([\\s\\S]*?)</section>`, 'u').exec(html)?.[1]

describe('one-variable canonical Answer presentation', () => {
  it('uses the same manifest reference and only swaps the two complete sections', () => {
    const manifest = richManifest(), before = structuredClone(manifest), pair = probePresentations(manifest, variants, order)
    expect(pair.map(value => value.position)).toEqual(['A', 'B'])
    expect(pair.map(value => value.sections)).toEqual([['answer', 'evidence'], ['evidence', 'answer']])
    expect(pair[0].manifest).toBe(manifest); expect(pair[1].manifest).toBe(manifest)
    expect(pair[0].manifest.blocks).toBe(pair[1].manifest.blocks); expect(pair[0].manifest.citations).toBe(pair[1].manifest.citations)
    expect(pair[0].manifest.verificationSummary).toBe(pair[1].manifest.verificationSummary)
    const a = rendered(pair[0]), b = rendered(pair[1])
    expect(section(a, 'answer')).toBeDefined(); expect(section(a, 'answer')).toBe(section(b, 'answer'))
    expect(section(a, 'evidence')).toBeDefined(); expect(section(a, 'evidence')).toBe(section(b, 'evidence'))
    expect(a.indexOf('data-probe-section="answer"')).toBeLessThan(a.indexOf('data-probe-section="evidence"'))
    expect(b.indexOf('data-probe-section="evidence"')).toBeLessThan(b.indexOf('data-probe-section="answer"'))
    expect(manifest).toEqual(before)
  })
  it('preserves host-frozen A/B order rather than sorting IDs, recipe names or randomizing in the browser', () => {
    const pair = probePresentations(richManifest(), variants, [...order].reverse())
    expect(pair[0]).toMatchObject({ position: 'A', variantKey: order[1], recipe: 'evidence-first', sections: ['evidence', 'answer'] })
    expect(pair[1]).toMatchObject({ position: 'B', variantKey: order[0], recipe: 'conclusion-first', sections: ['answer', 'evidence'] })
    expect(probePresentations(pair[0].manifest, [...variants].reverse(), [...order].reverse())).toEqual(pair)
  })
  it('rejects unsupported axes, duplicate recipes, reserved/foreign keys, incomplete order and broken canonical evidence', () => {
    const manifest = richManifest()
    for (const candidate of [[], [order[0]!], [order[0]!, order[0]!], ['variant:foreign', order[1]!], [...order, 'variant:third']]) expect(() => probePresentations(manifest, variants, candidate)).toThrow('single-axis')
    for (const change of [
      (value: ProbeVariantInput[]) => { value[0]!.effect.key = 'explanation-depth' },
      (value: ProbeVariantInput[]) => { value[0]!.effect.value = 'teaching' },
      (value: ProbeVariantInput[]) => { value[1]!.effect.value = 'conclusion-first' },
      (value: ProbeVariantInput[]) => { value[0]!.variantKey = 'both' },
    ]) { const value = structuredClone(variants); change(value); expect(() => probePresentations(manifest, value, value.map(item => item.variantKey))).toThrow('single-axis') }
    manifest.citations[0]!.verificationStatus = 'locator-only'
    expect(() => probePresentations(manifest, variants, order)).toThrow('intact')
  })
  it('retains all conflicting, qualifying, unresolved and unclassified material, warnings and weak locating clues in both variants', () => {
    const manifest = richManifest(), html = renderToStaticMarkup(createElement(ProbePresentations, { manifest, variants, presentationOrder: order, busy: false, onCitation() {} }))
    expect(html.match(/data-probe-citation=/gu)).toHaveLength(8)
    for (const relation of ['support', 'refute', 'qualify']) expect(html.match(new RegExp(`data-probe-relation="${relation}"`, 'gu'))?.length).toBe(relation === 'support' ? 4 : 2)
    expect(html.match(/data-probe-verification="locator-only"/gu)).toHaveLength(2)
    // Both variants retain the complete body. ADR-062 removes only the
    // redundant answer explanation, not the dedicated uncertainty collection.
    expect(html.match(/data-answer-segment="unresolved"[^>]*>尚不能支持的结论也必须保留/gu)).toHaveLength(2)
    expect(html.match(/尚不能支持的结论也必须保留。/gu)).toHaveLength(2)
    expect(html.match(/尚未分类的原始文字/gu)).toHaveLength(2)
    for (const warning of manifest.verificationSummary.warnings) expect(html.match(new RegExp(`data-probe-warning="${warning}"`, 'gu'))).toHaveLength(2)
    expect(html.match(/存在争议 1/gu)).toHaveLength(2); expect(html.match(/未解决 1/gu)).toHaveLength(2)
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('href=')
  })
  it('renders the full saved evidence text with no recipe-dependent truncation or supplemental generation', () => {
    const manifest = structuredClone(fixture.bases.response.manifest!), citation = manifest.citations[0]!
    const text = `${'完整证据不得为了版式被截断。'.repeat(150)}结尾必须保留。`, contentHash = createHash('sha256').update(text).digest('hex')
    citation.evidence!.content.text = text; citation.evidence!.contentHash = contentHash
    for (const selector of citation.locator.selectors) {
      if (selector.type === 'text-quote') { selector.exact = text; selector.normalizedHash = contentHash }
      if (selector.type === 'text-position') selector.end = selector.start + [...text].length
    }
    for (const presentation of probePresentations(manifest, variants, order)) {
      const html = rendered(presentation)
      expect(html).toContain(text); expect(html.match(/结尾必须保留/gu)).toHaveLength(1)
    }
  })
  it('keeps every verified evidence item linked to the original PDF and never activates unverified clues', () => {
    const manifest = richManifest(), html = renderToStaticMarkup(createElement(ProbeEvidenceCollection, { citations: manifest.citations, busy: false, onCitation() {} }))
    expect(html.match(/<button /gu)).toHaveLength(3)
    expect(html).toContain('核对完整出处 1 · 支持 · 原始 PDF'); expect(html).toContain('核对完整出处 2 · 反驳 · 原始 PDF'); expect(html).toContain('核对完整出处 3 · 限定 · 原始 PDF')
    expect(html).not.toContain('核对完整出处 4'); expect(html).toContain('尚未通过真实 Read 核验')
    const busy = renderToStaticMarkup(createElement(ProbeEvidenceCollection, { citations: manifest.citations, busy: true, onCitation() {} }))
    expect(busy.match(/disabled=""/gu)).toHaveLength(3)
  })
})

describe('explicit local choice controls, no implied durable preference', () => {
  it('separates answer/probe/profile erasure identities while retaining the same-message reconciliation prefix', () => {
    const owner: ProbeOwner = { actorId: 'actor:probe', workspaceId: 'workspace:probe', conversationId: 'conversation:probe', bindingId: 'binding:probe', generation: 1,
      messageId: 'message:original', probeId: 'probe:original', profileId: 'profile:probe', profileEpoch: 1 }
    const state = { phase: 'ready', actor: { actorId: owner.actorId, workspaceId: owner.workspaceId }, selected: owner.conversationId,
      snapshot: { binding: { bindingId: owner.bindingId, generation: owner.generation, conversationId: owner.conversationId, workspaceId: owner.workspaceId, ownerActorId: owner.actorId } } } as LiveState
    expect(probeAnswerOwner(state, owner.messageId)).toMatchObject({ actorId: owner.actorId, messageId: owner.messageId, generation: 1 })
    expect(probeAnswerOwner({ ...state, phase: 'pairing' }, owner.messageId)).toBeNull()
    expect(probeAnswerOwner({ ...state, selected: 'conversation:other' }, owner.messageId)).toBeNull()
    expect(probeAnswerOwner(state, '../private')).toBeNull()
    for (const change of [{ messageId: 'message:other' }, { probeId: 'probe:other' }, { profileEpoch: 2 }, { generation: 2 }, { profileId: 'profile:other' }, { actorId: 'actor:other' }, { workspaceId: 'workspace:other' }]) {
      expect(probeStorageKey({ ...owner, ...change })).not.toBe(probeStorageKey(owner)); expect(probeOwnerKey({ ...owner, ...change })).not.toBe(probeOwnerKey(owner))
    }
    expect(probePrefix({ ...owner, bindingId: 'binding:restart', generation: 2 })).toBe(probePrefix(owner))
    expect(probeAnswerOwnerKey({ ...owner, messageId: 'message:other' })).not.toBe(probeAnswerOwnerKey(owner))
  })
  it('starts unselected and only for this comparison, with no automatic pick', () => {
    expect(blankProbeChoice()).toEqual({ selected: null, scopeIntent: 'turn' })
    expect(probeDraftReady(blankProbeChoice(), order, 'enabled')).toBe(false)
    expect(probeDraftReady(chooseProbeDraft(blankProbeChoice(), order[1]!, order), order, 'enabled')).toBe(true)
  })
  it('requires a verified enabled contribution policy, not merely visible controls or an old preference', () => {
    const draft = chooseProbeDraft(blankProbeChoice(), order[0]!, order)
    for (const contribution of ['disabled', 'unavailable'] as const) expect(probeDraftReady(draft, order, contribution)).toBe(false)
    expect(probeDraftReady(draft, order, 'enabled')).toBe(true)
  })
  it('forces both/neither/dismissed back to this turn and never infers a wider preference', () => {
    for (const selected of ['both', 'neither', 'dismissed', null]) {
      expect(chooseProbeDraft({ selected: order[0]!, scopeIntent: 'workspace' }, selected, order)).toEqual({ selected, scopeIntent: 'turn' })
      if (selected !== null) expect(probeDraftReady({ selected, scopeIntent: 'workspace' }, order, 'enabled')).toBe(false)
    }
    expect(() => chooseProbeDraft(blankProbeChoice(), 'variant:other-probe', order)).toThrow('frozen')
  })
  it('separates future contribution from later confirmation and never writes on render', () => {
    let changes = 0, writes = 0
    const html = renderToStaticMarkup(createElement(LearningChoiceControls, { draft: { selected: order[0]!, scopeIntent: 'workspace' }, presentationOrder: order, contribution: 'enabled', busy: false, onChange() { changes++ }, onConfirm() { writes++ } }))
    expect(html).toContain('记录为未来学习信号'); expect(html).toContain('仍须单独确认'); expect(html).toContain('至少三个独立研究')
    expect(html.match(/type="radio"/gu)).toHaveLength(5); expect(html).toContain('两种都可以'); expect(html).toContain('两种都不适合'); expect(html).toContain('明确记录本次跳过')
    expect(html).not.toContain('value="global"'); expect(html).not.toContain('value="task-family"')
    expect(changes).toBe(0); expect(writes).toBe(0)
  })
  it('disables both scope editing and confirmation while contribution is unavailable', () => {
    for (const contribution of ['disabled', 'unavailable'] as const) {
      const html = renderToStaticMarkup(createElement(LearningChoiceControls, { draft: { selected: order[0]!, scopeIntent: 'workspace' }, presentationOrder: order, contribution, busy: false, onChange() {}, onConfirm() {} }))
      expect(html).toContain('<fieldset disabled="">'); expect(html).toContain('<button type="button" disabled="">记录为未来学习信号</button>')
      expect(html).toContain('aria-label="学习选择作用范围" disabled=""')
    }
  })
  it('never enables a foreign choice, a reserved choice promoted to workspace, or a busy submission', () => {
    for (const [selected, scopeIntent, busy] of [['variant:foreign', 'turn', false], ['both', 'workspace', false], [order[0]!, 'turn', true]] as const) {
      const html = renderToStaticMarkup(createElement(LearningChoiceControls, { draft: { selected, scopeIntent }, presentationOrder: order, contribution: 'enabled', busy, onChange() {}, onConfirm() {} }))
      expect(html).toMatch(/<button type="button" disabled="">/u)
    }
  })
})
