import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditableMemoryDraft, PersonalizationEffect } from '@docatlas/contracts'
import { PersonalizationStore, PersonalizationStoreError, type CompilePersonalizationDecisionInput } from '../src/storage/personalization-store.js'
import { PersonalizationControls } from '../src/personalization/controls.js'
import { PersonalizationApplication, type ObservedPersonalizationGeneration, type TrustedApplicationIdentity } from '../src/personalization/application.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const actor = { kind: 'user' as const, actorId: 'actor:application' }, profileId = 'profile:application', sessionId = 'conversation:application', workspaceId = 'workspace:application'

async function fixture(useExisting: boolean | null = true) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-personalization-application-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let clock = new Date('2026-09-09T12:00:00.000Z'), authorized = true, serial = 0
  const now = () => new Date(clock), store = await PersonalizationStore.open(root, now)
  cleanup.push(() => store.close())
  let identity: TrustedApplicationIdentity = { actorId: actor.actorId, profileId, sessionId, workspaceId, submissionId: 'submission:application', turn: 1,
    sourceScopeVersionId: 'scope:actual-sources', baselineDigest: 'b'.repeat(64), mode: 'explore',
    assertCurrent: () => { if (!authorized) throw new PersonalizationStoreError('permission-denied', 'Host request was revoked') } }
  const controls = new PersonalizationControls(store, () => ({ actor, profileId, sessionId, workspaceId, assertCurrent: identity.assertCurrent }))
  const grants = new Map<string, string>()
  const observe = vi.fn((observation: ObservedPersonalizationGeneration) => {
    if (grants.get(observation.observationId) !== observation.observedAt) throw new PersonalizationStoreError('permission-denied', 'No host-observed answer text')
  })
  const ports = { identity: () => identity, now, assertObservedGeneration: observe }
  const application = new PersonalizationApplication(store, ports)
  function policy(use: boolean, contribute = false) {
    return controls.command({ action: 'set-session-policy', idempotencyKey: `policy:application:${++serial}`,
      expectedVersion: store.sessionPolicy(profileId, sessionId)?.version ?? 0, policy: { useExisting: use, contributeToFuture: contribute } })
  }
  if (useExisting !== null) policy(useExisting)
  function preference(effect: PersonalizationEffect = { key: 'answer-order', value: 'evidence-first' }, extra: Partial<EditableMemoryDraft> = {}, by = actor) {
    const memoryType = effect.key === 'preferred-representation' ? 'reader-preference' : effect.key.startsWith('evidence-') ? 'evidence-preference' : 'presentation-preference'
    const result = store.command({ schemaVersion: 1, requestType: 'personalization-command', profileId, sessionId, actor: by,
      idempotencyKey: `preference:application:${++serial}`, action: 'set-preference', preference: {
        memoryType, effect, summary: 'UNTRUSTED_FREEFORM_SUMMARY_DO_NOT_INJECT', scope: { kind: 'workspace', profileId, workspaceId },
        sensitivity: 'ordinary', policy: { apply: 'disclose' }, ...extra,
      } })
    if (result.action !== 'set-preference' || result.memoryVersion.status === 'deleted') throw new Error('Expected explicit memory')
    return result.memoryVersion
  }
  function inspect() { return store.inspect({ schemaVersion: 1, requestType: 'personalization-inspect', profileId, sessionId, maxItems: 50 }) }
  return { root, store, controls, application, ports, observe, policy, preference, inspect,
    get identity() { return identity }, changeIdentity(change: Partial<TrustedApplicationIdentity>) { identity = { ...identity, ...change } },
    advance(ms: number) { clock = new Date(clock.getTime() + ms) }, revoke() { authorized = false },
    grant(id = 'generation:observed') { const observation = { observationId: id, observedAt: clock.toISOString() }; grants.set(id, observation.observedAt); return observation },
  }
}

describe('transient Core personalization application at a host generation boundary', () => {
  it('seals a host snapshot only for eligible preferences, then rechecks authority and eligibility before compiling', async () => {
    for (const eligibility of ['no-policy', 'disabled', 'empty', 'unsupported'] as const) {
      const value = await fixture(eligibility === 'no-policy' ? null : eligibility !== 'disabled'), beforeDecision = vi.fn()
      if (eligibility === 'unsupported') value.preference({ key: 'preferred-representation', value: 'markdown' })
      else if (eligibility !== 'empty') value.preference()
      const application = new PersonalizationApplication(value.store, { ...value.ports, beforeDecision })
      expect(application.prepare()).toBeUndefined()
      expect(beforeDecision).not.toHaveBeenCalled()
      expect(value.inspect().counts.decisions).toBe(0)
    }
    const eligible = await fixture(), order: string[] = []
    eligible.preference()
    const compile = eligible.store.compileDecision.bind(eligible.store)
    vi.spyOn(eligible.store, 'compileDecision').mockImplementation(input => { order.push('compile'); return compile(input) })
    const application = new PersonalizationApplication(eligible.store, { ...eligible.ports, beforeDecision: identity => {
      order.push('snapshot'); expect(identity.submissionId).toBe(eligible.identity.submissionId)
      eligible.policy(true, true) // Contribution-only changes remain orthogonal even across the host hook.
    } })
    expect(application.prepare()).toBeDefined(); expect(order).toEqual(['snapshot', 'compile'])
    for (const change of ['revoke', 'pause', 'disable', 'source-change'] as const) {
      const value = await fixture(), memory = value.preference(), compiler = vi.spyOn(value.store, 'compileDecision')
      const interrupted = new PersonalizationApplication(value.store, { ...value.ports, beforeDecision: () => {
        if (change === 'revoke') value.revoke()
        else if (change === 'pause') value.controls.command({ action: 'pause', idempotencyKey: 'pause:before-compile', memoryVersionId: memory.memoryVersionId, expectedVersion: 1 })
        else if (change === 'disable') value.policy(false)
        else value.changeIdentity({ sourceScopeVersionId: 'scope:changed-during-snapshot' })
      } })
      if (change === 'disable') expect(interrupted.prepare()).toBeUndefined()
      else expect(() => interrupted.prepare()).toThrow()
      expect(compiler).not.toHaveBeenCalled()
      expect(value.inspect().counts.decisions).toBe(0); expect(value.inspect().counts.uses).toBe(0)
    }
  })

  it('does not prepare or claim a use when existing-memory consent is absent or disabled', async () => {
    for (const policy of [null, false] as const) {
      const value = await fixture(policy); value.preference()
      const compile = vi.spyOn(value.store, 'compileDecision'), record = vi.spyOn(value.store, 'recordMemoryUse')
      expect(value.application.prepare()).toBeUndefined()
      expect(compile).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled(); expect(value.observe).not.toHaveBeenCalled()
      expect(value.inspect().counts).toMatchObject({ memories: 1, decisions: 0, uses: 0 })
    }
  })

  it('compiles only the six explicit ordinary axes into a fixed bounded instruction, without source facts, identifiers or free summaries', async () => {
    const value = await fixture()
    const effects: PersonalizationEffect[] = [
      { key: 'answer-order', value: 'evidence-first' }, { key: 'explanation-depth', value: 'brief' },
      { key: 'preferred-representation', value: 'pdf' }, { key: 'terminology-depth', value: 'explain-on-first-use' },
      { key: 'artifact-format', value: 'matrix' }, { key: 'comparison-layout', value: 'stacked' },
    ]
    effects.forEach(effect => value.preference(effect))
    value.preference({ key: 'evidence-presentation', value: 'table-context' })
    const before = JSON.stringify(value.identity), plan = value.application.prepare()!
    expect(plan.decision.effects).toHaveLength(6)
    expect(plan.decision.effects).toEqual(expect.arrayContaining(effects))
    expect(plan.instruction.length).toBeLessThanOrEqual(4096)
    expect(plan.instruction).toContain('Current user instructions take precedence')
    expect(plan.instruction).toContain('Do not change source scope or ranking, tool authority, facts, evidence support')
    expect(plan.instruction).toContain('contradiction disclosure')
    expect(plan.instruction).toContain('publication/review gates')
    for (const secret of ['UNTRUSTED_FREEFORM_SUMMARY_DO_NOT_INJECT', profileId, actor.actorId, sessionId, value.identity.sourceScopeVersionId, value.identity.baselineDigest]) expect(plan.instruction).not.toContain(secret)
    expect(JSON.stringify(value.identity)).toBe(before)
    expect(plan.decision.factTraceGuard).toEqual({ sourceScopeVersionId: value.identity.sourceScopeVersionId, baselineDigest: value.identity.baselineDigest,
      evidenceSupportInvariant: true, contradictionDisclosureInvariant: true, publicationGateInvariant: true, sourceScopeInvariant: true })
    expect(value.inspect().counts.uses).toBe(0); expect(value.observe).not.toHaveBeenCalled()
    expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.decision.effects)).toBe(true)
    expect(Reflect.set(plan.decision.factTraceGuard, 'evidenceSupportInvariant', false)).toBe(false)
    expect(() => value.application.assertUsable(structuredClone(plan))).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
    const foreign = new PersonalizationApplication(value.store, value.ports)
    expect(() => foreign.assertUsable(plan)).toThrowError(expect.objectContaining({ code: 'permission-denied' }))
  })

  it('excludes private, silent, inferred-familiarity, foreign-author, unsupported, and out-of-workspace preferences', async () => {
    for (const variant of ['personal', 'sensitive', 'silent-ui', 'familiarity', 'foreign-author', 'markdown', 'foreign-workspace', 'foreign-activation'] as const) {
      const value = await fixture()
      if (variant === 'personal') value.preference(undefined, { sensitivity: 'personal' })
      else if (variant === 'sensitive') value.preference(undefined, { sensitivity: 'sensitive', policy: { apply: 'confirm-each-use' } })
      else if (variant === 'silent-ui') value.preference(undefined, { policy: { apply: 'silent-ui' } })
      else if (variant === 'familiarity') value.preference({ key: 'terminology-depth', value: 'teaching' }, { memoryType: 'familiarity-estimate' })
      else if (variant === 'foreign-author') value.preference(undefined, {}, { kind: 'user', actorId: 'actor:other' })
      else if (variant === 'markdown') value.preference({ key: 'preferred-representation', value: 'markdown' })
      else if (variant === 'foreign-workspace') value.preference(undefined, { scope: { kind: 'workspace', profileId, workspaceId: 'workspace:other' } })
      else {
        const memory = value.preference()
        // Fault injection at the typed store port: an inferred rule must not become explicit user consent.
        vi.spyOn(value.store, 'currentMemories').mockReturnValue([{ ...memory, activation: { kind: 'low-risk-rule', actor: { kind: 'rule', actorId: 'rule:inferred' }, activatedAt: memory.activation.activatedAt } }])
      }
      expect(value.application.prepare(), variant).toBeUndefined()
      expect(value.inspect().counts.uses).toBe(0)
    }
  })

  it('invalidates exact old plans after edit, pause, logical forget, privacy erasure, use disablement or expiration', async () => {
    for (const mutation of ['edit', 'pause', 'forget', 'erase', 'disable', 'expire'] as const) {
      const value = await fixture(), memory = value.preference(undefined, mutation === 'expire' ? { policy: { apply: 'disclose', expiresAfterDays: 1 } } : {})
      const plan = value.application.prepare()!
      if (mutation === 'edit') value.controls.command({ action: 'edit', idempotencyKey: 'edit:invalidate', memoryVersionId: memory.memoryVersionId, expectedVersion: 1,
        replacement: { effect: { key: 'answer-order', value: 'conclusion-first' }, scope: 'workspace' }, statusAfterEdit: 'active' })
      else if (mutation === 'pause') value.controls.command({ action: 'pause', idempotencyKey: 'pause:invalidate', memoryVersionId: memory.memoryVersionId, expectedVersion: 1 })
      else if (mutation === 'forget') value.controls.command({ action: 'forget', idempotencyKey: 'forget:invalidate', target: 'memory-chain', memoryVersionId: memory.memoryVersionId, expectedVersion: 1,
        mode: 'memory-only', provenanceHandling: 'orphan', acknowledgeExternalRetention: true })
      else if (mutation === 'erase') value.controls.command({ action: 'forget', idempotencyKey: 'erase:invalidate', target: 'profile', expectedProfileRevision: value.store.ledgerRevision(profileId),
        mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true })
      else if (mutation === 'disable') value.policy(false)
      else value.advance(86400001)
      expect(() => value.application.assertUsable(plan), mutation).toThrowError(expect.objectContaining({ code: 'conflict' }))
      expect(() => value.application.recordObservedUse(plan, value.grant()), mutation).toThrowError(expect.objectContaining({ code: 'conflict' }))
      expect(value.inspect().counts.uses).toBe(0)
      if (mutation === 'disable') { value.policy(true); expect(() => value.application.assertUsable(plan)).toThrow('already invalidated') }
    }
  })

  it('keeps contribution consent and export metadata orthogonal to applying an existing explicit preference', async () => {
    const value = await fixture(); value.preference()
    const plan = value.application.prepare()!
    value.policy(true, true)
    expect(() => value.application.assertUsable(plan)).not.toThrow()
    value.policy(true, false)
    expect(() => value.application.assertUsable(plan)).not.toThrow()
    value.controls.command({ action: 'export', idempotencyKey: 'export:orthogonal', format: 'json', includeProvenanceRefs: false, includeStatuses: ['active'] })
    expect(() => value.application.assertUsable(plan)).not.toThrow()
    expect(value.inspect().counts.uses).toBe(0)
    value.application.recordObservedUse(plan, value.grant())
    expect(() => value.application.assertUsable(plan)).not.toThrow() // Recording actual use also updates ledger metadata, not preference eligibility.
  })

  it('binds a plan to the trusted actor/profile/session/submission/turn/source baseline and current host authority', async () => {
    const value = await fixture(); value.preference()
    const original = { ...value.identity }
    const changes: Array<Partial<TrustedApplicationIdentity>> = [
      { actorId: 'actor:other' }, { profileId: 'profile:other' }, { sessionId: 'conversation:other' }, { workspaceId: 'workspace:other' },
      { submissionId: 'submission:other' }, { turn: 2 }, { sourceScopeVersionId: 'scope:other' }, { baselineDigest: 'c'.repeat(64) }, { mode: 'verify' },
    ]
    for (const change of changes) {
      value.changeIdentity(original)
      const plan = value.application.prepare()!
      value.changeIdentity(change)
      expect(() => value.application.assertUsable(plan)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    }
    value.changeIdentity(original)
    const plan = value.application.prepare()!
    value.revoke()
    expect(() => value.application.assertUsable(plan)).toThrow('revoked')
    expect(value.inspect().counts.uses).toBe(0)
  })

  it('records use only after host-observed answer text, replays stable call receipts and never claims compliance or correctness', async () => {
    const value = await fixture(); value.preference()
    const plan = value.application.prepare()!, unobserved = { observationId: 'generation:not-observed', observedAt: '2026-09-09T12:00:00.000Z' }
    expect(() => value.application.recordObservedUse(plan, unobserved)).toThrow('No host-observed answer text')
    expect(value.inspect().counts.uses).toBe(0)
    const observation = value.grant(), first = value.application.recordObservedUse(plan, observation)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ decisionId: plan.decision.decisionId, memoryVersionId: plan.decision.memoryVersionIds[0], profileId, sessionId, turn: 1,
      affectedActions: ['answer-render'], usedAt: observation.observedAt, outcome: { status: 'unknown', observedAt: observation.observedAt } })
    value.advance(1000)
    expect(value.application.recordObservedUse(plan, observation)).toEqual(first)
    const anotherPlan = value.application.prepare()!
    expect(value.application.recordObservedUse(anotherPlan, observation)).toEqual(first)
    expect(value.inspect().counts.uses).toBe(1)
    const changed = value.grant(observation.observationId)
    expect(() => value.application.recordObservedUse(plan, changed)).toThrow('reused with different facts')
    // The stored receipt remains historical; a revoked plan is not a second history-reading API.
    value.ports.assertObservedGeneration.mockImplementation(() => {})
    value.policy(false)
    expect(() => value.application.assertUsable(plan)).toThrow('policy changed')
    expect(() => value.application.recordObservedUse(plan, observation)).toThrow('already invalidated')
    expect(() => value.application.recordObservedUse(plan, value.grant('generation:new-after-disable'))).toThrow('already invalidated')
    expect(value.inspect().counts.uses).toBe(1)
  })

  it('keeps compileDecision createdAt stable across clock changes and reopening, while an explicit eligibility filter leaves legacy calls unchanged', async () => {
    const value = await fixture(), safe = value.preference()
    value.preference({ key: 'evidence-presentation', value: 'table-context' })
    const input: CompilePersonalizationDecisionInput = { profileId, sessionId, turn: 3, taskContext: { mode: 'explore', workspaceId },
      sourceScopeVersionId: 'scope:stable', baselineDigest: 'd'.repeat(64) }
    const first = value.store.compileDecision(input)!, revision = value.store.ledgerRevision(profileId)
    expect(first.effects).toHaveLength(2)
    value.advance(60000)
    expect(value.store.compileDecision(input)).toEqual(first)
    expect(value.store.ledgerRevision(profileId)).toBe(revision)
    const filtered = value.store.compileDecision({ ...input, eligibleMemoryVersionIds: [safe.memoryVersionId] })!
    expect(filtered.memoryVersionIds).toEqual([safe.memoryVersionId])
    expect(value.store.compileDecision({ ...input, eligibleMemoryVersionIds: [] })).toBeUndefined()
    expect(() => value.store.compileDecision({ ...input, eligibleMemoryVersionIds: [safe.memoryVersionId, safe.memoryVersionId] })).toThrow('eligibility')
    value.store.close()
    const reopened = await PersonalizationStore.open(value.root, () => new Date('2026-09-09T13:00:00.000Z'))
    cleanup.push(() => reopened.close())
    expect(reopened.compileDecision(input)).toEqual(first)
    expect(reopened.compileDecision({ ...input, eligibleMemoryVersionIds: [safe.memoryVersionId] })).toEqual(filtered)
  })
})
