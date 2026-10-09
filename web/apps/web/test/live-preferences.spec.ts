import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProductPreferenceCommand, ProductPreferenceInspection, ProductPreferenceInspectionV2, ProductPreferenceResult } from '@docatlas/contracts'
import type { LiveState } from '../src/live/client'
import { PreferenceConnectionBoundary, PreferenceMemoryList, PreferenceUseHistory } from '../src/live/Preferences'
import { acknowledgePreference, canRetryPreferenceAtEpoch, parsePendingPreference, preferenceAxes, preferenceExportUrl, preferenceIdentity, preferenceKey,
  preferenceLabel, preferenceReceiptMatches, readPreferenceOutbox, recordedPreferenceUses, savePendingPreference,
  type PendingPreference, type PreferenceIdentity, type PreferenceStorage } from '../src/live/preference-state'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-personalization.json', import.meta.url), 'utf8')) as {
  bases: { policy: ProductPreferenceCommand, policyResult: ProductPreferenceResult, inspection: ProductPreferenceInspection }
}
function inspectionV2(): ProductPreferenceInspectionV2 {
  return { ...structuredClone(fixture.bases.inspection), schemaVersion: 2, profileEpoch: 0, modelApplication: 'host-ephemeral', useSemantics: 'observed-answer-generation' }
}
function setup() {
  const result = structuredClone(fixture.bases.policyResult)
  if (result.result.action !== 'set-session-policy') throw new Error('Expected policy fixture')
  const identity: PreferenceIdentity = { actorId: result.result.sessionPolicy.updatedBy.actorId, workspaceId: 'workspace:test',
    conversationId: result.conversationId, bindingId: 'binding:preferences', generation: 1 }
  const pending: PendingPreference = { schemaVersion: 1, identity, profileId: result.result.profileId, request: structuredClone(fixture.bases.policy) }
  const values = new Map<string, string>(), changes: string[] = []
  const storage: PreferenceStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { changes.push(`set:${key}`); values.set(key, value) },
    removeItem: key => { changes.push(`remove:${key}`); values.delete(key) }, key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
  return { identity, pending, result, values, changes, storage }
}

describe('explicit preference outbox and truthful settings presentation', () => {
  it('binds a settings identity to the current authorized snapshot and separates actor/workspace/conversation/generation keys', () => {
    const { identity } = setup()
    const state = { phase: 'ready', actor: { actorId: identity.actorId, workspaceId: identity.workspaceId }, selected: identity.conversationId,
      snapshot: { binding: { conversationId: identity.conversationId, ownerActorId: identity.actorId, workspaceId: identity.workspaceId, bindingId: identity.bindingId, generation: identity.generation } } } as LiveState
    expect(preferenceIdentity(state)).toEqual(identity)
    expect(preferenceIdentity({ ...state, phase: 'pairing' })).toBeNull()
    expect(preferenceIdentity({ ...state, selected: 'conversation:foreign' })).toBeNull()
    for (const field of ['actorId', 'workspaceId', 'conversationId', 'bindingId'] as const) expect(preferenceKey({ ...identity, [field]: 'other:value' })).not.toBe(preferenceKey(identity))
    expect(preferenceKey({ ...identity, generation: 2 })).not.toBe(preferenceKey(identity))
    expect(preferenceKey(identity)).toMatch(/^docatlas\.live\.draft\.v1:/u)
  })

  it('persists before any send and restores the exact request without replay, repair or rekey', () => {
    const value = setup()
    savePendingPreference(value.storage, value.pending)
    const changes = [...value.changes], raw = value.values.get(preferenceKey(value.identity))!
    const restored = readPreferenceOutbox(value.storage, value.identity)
    expect(restored).toEqual({ state: 'pending', key: preferenceKey(value.identity), current: true, value: value.pending })
    expect(parsePendingPreference(raw, value.identity)).toEqual(value.pending)
    expect(value.changes).toEqual(changes)
    expect(() => savePendingPreference(value.storage, value.pending)).toThrow('still uncertain')
    expect(value.values.size).toBe(1)
    expect(value.values.get(preferenceKey(value.identity))).toBe(raw)
  })

  it('keeps an old binding/generation request visible but not eligible for a current-context retry', () => {
    const value = setup(); savePendingPreference(value.storage, value.pending)
    const next = { ...value.identity, bindingId: 'binding:new', generation: 2 }
    expect(readPreferenceOutbox(value.storage, next)).toMatchObject({ state: 'pending', current: false, value: { identity: value.identity } })
    expect(readPreferenceOutbox(value.storage, { ...next, actorId: 'actor:other' })).toEqual({ state: 'empty' })
    expect(readPreferenceOutbox(value.storage, { ...next, workspaceId: 'workspace:other' })).toEqual({ state: 'empty' })
    expect(readPreferenceOutbox(value.storage, { ...next, conversationId: 'conversation:other' })).toEqual({ state: 'empty' })
    expect(value.values.size).toBe(1)
  })

  it('refuses corrupt drafts, identity injection, unsupported preferences and missing generation binding', () => {
    const value = setup()
    for (const mutate of [
      (item: PendingPreference) => { item.identity.actorId = 'actor:foreign' },
      (item: PendingPreference) => { item.request.expectedGeneration = 2 },
      (item: PendingPreference) => { Reflect.set(item.request.command, 'profileId', 'profile:foreign') },
      (item: PendingPreference) => { Reflect.set(item, 'endpoint', 'https://foreign.example') },
      (item: PendingPreference) => { Reflect.set(item.identity, 'runtimeSessionId', 'runtime:foreign') },
      (item: PendingPreference) => { item.request.command = { action: 'set-preference', idempotencyKey: 'bad:markdown', preference: { effect: { key: 'preferred-representation', value: 'markdown' }, scope: 'global' } } as never },
    ]) {
      const pending = structuredClone(value.pending); mutate(pending)
      expect(() => parsePendingPreference(JSON.stringify(pending), value.identity)).toThrow()
    }
    expect(() => parsePendingPreference('x'.repeat(32769), value.identity)).toThrow()
    value.values.set(preferenceKey(value.identity), '{broken')
    expect(readPreferenceOutbox(value.storage, value.identity)).toEqual({ state: 'invalid', key: preferenceKey(value.identity) })
    expect(value.values.get(preferenceKey(value.identity))).toBe('{broken')
    expect(value.changes).toEqual([])
  })

  it('blocks sending when tab storage throws or fails to retain the outbox', () => {
    const value = setup()
    expect(() => savePendingPreference({ ...value.storage, setItem() { throw new Error('quota exceeded') } }, value.pending)).toThrow('quota')
    expect(() => savePendingPreference({ ...value.storage, setItem() {} }, value.pending)).toThrow('not retained')
    expect(value.values.size).toBe(0)
  })

  it('clears only a matching same-owner command receipt and retains unknown or conflicting outcomes', () => {
    const value = setup(); savePendingPreference(value.storage, value.pending)
    const invalid = [
      { ...value.result, conversationId: 'conversation:foreign' },
      { ...value.result, result: { ...value.result.result, profileId: 'profile:foreign' } },
      { ...value.result, result: { ...value.result.result, action: 'pause' } },
    ]
    for (const candidate of invalid) { expect(preferenceReceiptMatches(value.pending, candidate)).toBe(false); expect(acknowledgePreference(value.storage, value.pending, candidate)).toBe(false) }
    const mismatch = structuredClone(value.result)
    if (mismatch.result.action !== 'set-session-policy') throw new Error('Wrong fixture')
    mismatch.result.sessionPolicy.version++
    expect(acknowledgePreference(value.storage, value.pending, mismatch)).toBe(false)
    expect(value.values.size).toBe(1)
    expect(preferenceReceiptMatches(value.pending, value.result)).toBe(true)
    expect(acknowledgePreference(value.storage, value.pending, value.result)).toBe(true)
    expect(value.values.size).toBe(0)
  })

  it('does not clear a newer local command when an older response arrives, and accepts exact idempotent replay receipts', () => {
    const value = setup(); savePendingPreference(value.storage, value.pending)
    const newer = structuredClone(value.pending); newer.request.command.idempotencyKey = 'newer:command'
    value.values.set(preferenceKey(value.identity), JSON.stringify(newer))
    expect(acknowledgePreference(value.storage, value.pending, value.result)).toBe(false)
    expect(JSON.parse(value.values.get(preferenceKey(value.identity))!)).toEqual(newer)
    value.values.set(preferenceKey(value.identity), JSON.stringify(value.pending))
    const replay = { ...value.result, result: { ...value.result.result, status: 'replayed' } }
    expect(acknowledgePreference(value.storage, value.pending, replay)).toBe(true)
  })

  it('does not infer actual application from saved settings or unused decisions', () => {
    const inspection = inspectionV2()
    expect(recordedPreferenceUses(inspection.result)).toHaveLength(1)
    inspection.result.uses = []
    expect(recordedPreferenceUses(inspection.result)).toEqual([])
    const html = renderToStaticMarkup(createElement(PreferenceUseHistory, { inspection }))
    expect(html).toContain('不等于已经应用')
    expect(html).not.toContain('preference-use-list')
    const foreign = structuredClone(fixture.bases.inspection)
    foreign.result.uses[0]!.sessionId = 'conversation:foreign'
    expect(recordedPreferenceUses(foreign.result)).toEqual([])
    foreign.result.uses[0]!.sessionId = foreign.result.sessionId
    foreign.result.uses[0]!.decisionId = 'decision:unknown'
    expect(recordedPreferenceUses(foreign.result)).toEqual([])
  })

  it('keeps controls and past-use display escaped and avoids Markdown as a document preference', () => {
    expect(preferenceAxes).toHaveLength(6)
    expect(preferenceAxes.find(axis => axis.key === 'preferred-representation')!.values.map(value => value[0])).not.toContain('markdown')
    expect(preferenceLabel({ key: 'answer-order', value: 'evidence-first' })).toBe('回答顺序 · 先看证据')
    expect(preferenceLabel({ key: 'comparison-layout', value: 'side-by-side' })).toBe('回答对照布局 · 左右并排')
    const memories = structuredClone(fixture.bases.inspection.result.memories)
    const html = renderToStaticMarkup(createElement(PreferenceMemoryList, { memories, modelApplication: 'not-connected', disabled: false, onEdit() {}, onAction() {} }))
    expect(html).toContain('尚未接模型'); expect(html).toContain('暂停'); expect(html).toContain('忘记这条偏好')
    const historical = renderToStaticMarkup(createElement(PreferenceUseHistory, { inspection: inspectionV2() }))
    expect(historical).toContain('preference-use-list'); expect(historical).toContain('不改变证据支持关系')
  })

  it.each([1, 2] as const)('retains v%s requests exactly and clears only a receipt of the same wire version', version => {
    const value = setup()
    value.pending.request = version === 2 ? { ...value.pending.request, schemaVersion: 2, expectedProfileEpoch: 0 } : { ...value.pending.request, schemaVersion: 1 }
    const result = { ...value.result, schemaVersion: version }
    savePendingPreference(value.storage, value.pending)
    const raw = value.values.get(preferenceKey(value.identity))!
    expect(parsePendingPreference(raw, value.identity).request).toEqual(value.pending.request)
    expect(readPreferenceOutbox(value.storage, value.identity)).toMatchObject({ state: 'pending', value: { request: { schemaVersion: version, command: value.pending.request.command } } })
    expect(acknowledgePreference(value.storage, value.pending, { ...result, schemaVersion: version === 1 ? 2 : 1 })).toBe(false)
    expect(value.values.get(preferenceKey(value.identity))).toBe(raw)
    expect(acknowledgePreference(value.storage, value.pending, result)).toBe(true)
    expect(value.values.size).toBe(0)
  })

  it('shows connection state separately from saved settings, generation use, compliance and rendering', () => {
    const connected = renderToStaticMarkup(createElement(PreferenceConnectionBoundary, { inspection: inspectionV2() }))
    expect(connected).toContain('偏好已连接回答生成')
    expect(connected).toContain('不等于模型遵从、事实正确或页面已展示')
    expect(connected).toContain('不会自动重排阅读器')
    expect(connected).toContain('可能中止正在使用它的生成，不会自动重问')
    expect(connected).not.toContain('模型应用尚未连接')
    const offline = renderToStaticMarkup(createElement(PreferenceConnectionBoundary, { inspection: { ...inspectionV2(), modelApplication: 'not-connected' } }))
    expect(offline).toContain('模型应用尚未连接')
    expect(renderToStaticMarkup(createElement(PreferenceConnectionBoundary, { inspection: null }))).toContain('正在核对模型应用连接状态')
    const active = renderToStaticMarkup(createElement(PreferenceMemoryList, { memories: inspectionV2().result.memories, modelApplication: 'host-ephemeral', disabled: false, onEdit() {}, onAction() {} }))
    expect(active).toContain('授权后可用于生成'); expect(active).not.toContain('尚未接模型')
    const historical = renderToStaticMarkup(createElement(PreferenceUseHistory, { inspection: inspectionV2() }))
    expect(historical).toContain('观察到已开始生成回答')
    expect(historical).toContain('不证明模型遵从、事实正确或页面已展示')
    expect(historical).toContain(`提交序号 ${inspectionV2().result.uses[0]!.turn}`)
    expect(historical).not.toContain(`第 ${inspectionV2().result.uses[0]!.turn} 轮`)
  })

  it('never upgrades a restored request across privacy erasure; only an exact erasure receipt may be reconciled by the host', () => {
    const value = setup(), legacy = value.pending
    const modern: PendingPreference = { ...legacy, request: { ...legacy.request, schemaVersion: 2, expectedProfileEpoch: 0 } }
    const original = JSON.stringify([legacy, modern])
    for (const pending of [legacy, modern]) {
      expect(canRetryPreferenceAtEpoch(pending, 0)).toBe(true)
      expect(canRetryPreferenceAtEpoch(pending, 1)).toBe(false)
    }
    const fresh: PendingPreference = { ...modern, request: { ...modern.request, schemaVersion: 2, expectedProfileEpoch: 1 } }
    expect(canRetryPreferenceAtEpoch(fresh, 1)).toBe(true)
    expect(canRetryPreferenceAtEpoch(fresh, 0)).toBe(false)
    const erase: PendingPreference = { ...modern, request: { ...modern.request, command: { action: 'forget', idempotencyKey: 'erase:pending-receipt',
      target: 'profile', expectedProfileRevision: 2, mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true } } }
    expect(canRetryPreferenceAtEpoch(erase, 1)).toBe(true)
    expect(JSON.stringify([legacy, modern])).toBe(original)
  })

  it('constructs only a fixed authenticated export route and rejects arbitrary paths or URLs', () => {
    expect(preferenceExportUrl('conversation:one', 'asset:one')).toBe('/api/conversations/conversation%3Aone/preferences/exports/asset%3Aone')
    for (const value of ['/private/export.json', 'https://foreign.example/file', '../escape']) expect(() => preferenceExportUrl('conversation:one', value)).toThrow()
  })
})
