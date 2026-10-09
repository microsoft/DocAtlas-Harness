import { createHash } from 'node:crypto'
import { personalizationCoreIssues, type MemoryUse, type MemoryVersion, type PersonalizationDecision,
  type PersonalizationEffect, type PersonalizationTaskContext } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { PersonalizationStoreError, type PersonalizationStore } from '../storage/personalization-store.js'
import type { ExplicitPreferenceEffect } from './controls.js'

export interface TrustedApplicationIdentity {
  actorId: string
  profileId: string
  sessionId: string
  workspaceId: string
  submissionId: string
  turn: number
  sourceScopeVersionId: string
  baselineDigest: string
  mode: PersonalizationTaskContext['mode']
  assertCurrent(): void
}
export interface ObservedPersonalizationGeneration { observationId: string, observedAt: string }
export interface PersonalizationApplicationPlan {
  readonly instruction: string
  readonly decision: PersonalizationDecision
  readonly context: Omit<TrustedApplicationIdentity, 'assertCurrent'>
}
export interface PersonalizationApplicationPorts {
  identity(): TrustedApplicationIdentity
  /** Seal the host source snapshot only after at least one explicit preference is eligible. */
  beforeDecision?(identity: Readonly<TrustedApplicationIdentity>): void
  /** Host proves the first nonempty provider text delta (or nonempty final-text fallback) was observed. Must throw on denial. */
  assertObservedGeneration(observation: ObservedPersonalizationGeneration, plan: PersonalizationApplicationPlan): void
  now?(): Date
}
type StorePort = Pick<PersonalizationStore, 'sessionPolicy' | 'currentMemories' | 'compileDecision' | 'recordMemoryUse'>
type LiveMemory = Exclude<MemoryVersion, { status: 'deleted' }>
interface IssuedPlan {
  identity: TrustedApplicationIdentity
  seal: string
  eligibilityHash: string
  memories: LiveMemory[]
  invalidated: boolean
  uses: Map<string, { observation: ObservedPersonalizationGeneration, records: MemoryUse[] }>
}
const MAX_INSTRUCTION_CHARS = 4096
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const heading = `DocAtlas explicit response-presentation preferences for this request only.
Current user instructions take precedence. Apply these only to how the answer is presented; do not infer personal traits or knowledge.
Do not change source scope or ranking, tool authority, facts, evidence support, uncertainty, contradiction disclosure, or publication/review gates.
For claims about provided documents, keep material factual propositions traceable to the same original-PDF evidence. Do not invent document citations for general tasks. These preferences are not evidence or a claim of model compliance.`
const instructions: Record<ExplicitPreferenceEffect['key'], Record<string, string>> = {
  'answer-order': { 'conclusion-first': 'Lead with the conclusion, then its evidence and caveats.', 'evidence-first': 'Present the supporting evidence before the conclusion, retaining caveats.' },
  'explanation-depth': { brief: 'Keep the explanation concise without omitting material evidence, uncertainty or contradictions.', standard: 'Use a balanced level of explanation.', teaching: 'Explain the reasoning in clear, incremental steps without assuming personal ability or background.' },
  'preferred-representation': { pdf: 'Prefer pointers to the original PDF for reading and verification.', 'page-image': 'Where useful, explain with actual original-page visuals; do not invent image content or geometry.', table: 'Where the available facts support it, organize the answer in a table.', comparison: 'Where comparison is requested, align facts from the relevant sources without changing their support.' },
  'terminology-depth': { professional: 'Use the source domain terminology accurately.', 'explain-on-first-use': 'Briefly define technical terms when first used.', teaching: 'Explain technical terms and their context step by step.' },
  'artifact-format': { brief: 'When a deliverable is requested, prefer a concise brief.', matrix: 'When a deliverable is requested, prefer a comparison matrix where the facts permit it.', timeline: 'When a deliverable is requested, prefer a timeline using only supported dates and events.' },
  'comparison-layout': { 'side-by-side': 'When comparing items in the answer, prefer a side-by-side organization.', stacked: 'When comparing items in the answer, prefer a vertically stacked organization.' },
}
function fail(code: 'invalid-request' | 'permission-denied' | 'conflict' | 'integrity-error', message: string): never { throw new PersonalizationStoreError(code, message) }
function approvedEffect(effect: PersonalizationEffect): effect is ExplicitPreferenceEffect {
  return Object.hasOwn(instructions, effect.key) && Object.hasOwn(instructions[effect.key as ExplicitPreferenceEffect['key']], effect.value)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function context(identity: TrustedApplicationIdentity): PersonalizationApplicationPlan['context'] {
  const { assertCurrent: _assert, ...value } = identity
  return value
}

/** Transient host-side presentation planning. Nothing here mutates modelText, Pi history, facts or Evidence. */
export class PersonalizationApplication {
  private readonly issued = new WeakMap<PersonalizationApplicationPlan, IssuedPlan>()
  constructor(private readonly store: StorePort, private readonly ports: PersonalizationApplicationPorts) {}

  prepare(): PersonalizationApplicationPlan | undefined {
    const identity = this.identity(), policy = this.policy(identity)
    if (!policy?.useExisting) return undefined
    const memories = this.eligible(identity)
    if (!memories.length) return undefined
    if (this.ports.beforeDecision) {
      this.ports.beforeDecision(Object.freeze({ ...identity }))
      identity.assertCurrent()
      const current = this.identity()
      if (hash(context(current)) !== hash(context(identity))) fail('conflict', 'Personalization request changed while sealing its source snapshot')
      if (!this.policy(current)?.useExisting) return undefined
      if (hash(this.eligible(current)) !== hash(memories)) fail('conflict', 'Personalization eligibility changed while sealing its source snapshot')
    }
    const decision = this.store.compileDecision({ profileId: identity.profileId, sessionId: identity.sessionId, turn: identity.turn,
      taskContext: { mode: identity.mode, workspaceId: identity.workspaceId }, sourceScopeVersionId: identity.sourceScopeVersionId,
      baselineDigest: identity.baselineDigest, eligibleMemoryVersionIds: memories.map(memory => memory.memoryVersionId), maxMemories: 6 })
    identity.assertCurrent()
    if (!decision) return undefined
    if (personalizationCoreIssues(decision, { memories }).length || decision.effects.length > 6 || decision.effects.some(effect => !approvedEffect(effect))) fail('integrity-error', 'Decision escaped the admitted presentation preferences')
    const instruction = `${heading}\n${decision.effects.map(effect => `- ${instructions[effect.key as ExplicitPreferenceEffect['key']][effect.value]!}`).join('\n')}`
    if ([...instruction].length > MAX_INSTRUCTION_CHARS) fail('integrity-error', 'Presentation instruction exceeds its fixed bound')
    const plan = freeze<PersonalizationApplicationPlan>({ instruction, decision: structuredClone(decision), context: context(identity) })
    this.issued.set(plan, { identity, seal: hash(plan), eligibilityHash: hash(memories), memories, invalidated: false,
      uses: new Map() })
    this.assertUsable(plan)
    return plan
  }

  /** Call at provider admission and while observing generation; invalidation never reactivates a prior plan. */
  assertUsable(plan: PersonalizationApplicationPlan): void {
    const issued = this.owned(plan)
    if (issued.invalidated) fail('conflict', 'Personalization plan was already invalidated')
    try {
      const identity = this.identity()
      issued.identity.assertCurrent()
      if (hash(context(identity)) !== hash(plan.context)) fail('conflict', 'Personalization request identity changed')
      const policy = this.policy(identity)
      // Contribution consent is independent of using an existing explicit preference.
      if (!policy?.useExisting) fail('conflict', 'Personalization use policy changed')
      const memories = this.eligible(identity)
      if (hash(memories) !== issued.eligibilityHash || personalizationCoreIssues(plan.decision, { memories }).length) fail('conflict', 'Personalization memory versions changed or expired')
      identity.assertCurrent()
    } catch (error) { issued.invalidated = true; throw error }
  }

  /** Actual observed generation only. answer-render means observed answer text, not DOM rendering, compliance, or correctness. */
  recordObservedUse(plan: PersonalizationApplicationPlan, observation: ObservedPersonalizationGeneration): MemoryUse[] {
    const issued = this.owned(plan)
    if (!observation || Object.keys(observation).sort().join(',') !== 'observationId,observedAt' || !opaque(observation.observationId)
      || typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt))
      || Date.parse(observation.observedAt) < Date.parse(plan.decision.createdAt)) fail('invalid-request', 'Invalid observed-generation identity or timestamp')
    this.assertUsable(plan)
    this.ports.assertObservedGeneration(observation, plan)
    const previous = issued.uses.get(observation.observationId)
    if (previous) {
      if (hash(previous.observation) !== hash(observation)) fail('conflict', 'Observed generation identity was reused with different facts')
      return structuredClone(previous.records)
    }
    const selected = new Map(issued.memories.map(memory => [memory.memoryVersionId, memory]))
    const values: MemoryUse[] = plan.decision.memoryVersionIds.map(memoryVersionId => ({
      schemaVersion: 1, recordType: 'memory-use', memoryUseId: `memory-use:pi:${hash([plan.context.submissionId, observation.observationId, plan.decision.decisionId, memoryVersionId]).slice(0, 40)}`,
      decisionId: plan.decision.decisionId, memoryVersionId, profileId: plan.context.profileId, sessionId: plan.context.sessionId,
      turn: plan.context.turn, effect: structuredClone(selected.get(memoryVersionId)!.effect), affectedActions: ['answer-render'],
      usedAt: observation.observedAt, outcome: { status: 'unknown', observedAt: observation.observedAt },
    }))
    for (const value of values) { parseContract('personalization-core', value); if (personalizationCoreIssues(value, { decisions: [plan.decision], memories: issued.memories }).length) fail('integrity-error', 'Observed use does not match its admitted decision') }
    const records = values.map(value => this.store.recordMemoryUse(value))
    issued.uses.set(observation.observationId, { observation: { ...observation }, records: structuredClone(records) })
    return records
  }

  private owned(plan: PersonalizationApplicationPlan): IssuedPlan {
    const issued = this.issued.get(plan)
    if (!issued || issued.seal !== hash(plan)) fail('permission-denied', 'Presentation plan was not issued by this application instance')
    return issued
  }
  private identity(): TrustedApplicationIdentity {
    const candidate = this.ports.identity()
    if (!candidate || ![candidate.actorId, candidate.profileId, candidate.sessionId, candidate.workspaceId, candidate.submissionId, candidate.sourceScopeVersionId].every(opaque)
      || !Number.isSafeInteger(candidate.turn) || candidate.turn < 1 || !/^[a-f0-9]{64}$/u.test(candidate.baselineDigest)
      || !['explore', 'verify', 'publish'].includes(candidate.mode) || typeof candidate.assertCurrent !== 'function') fail('permission-denied', 'Personalization application requires a trusted current request identity')
    // Copy only admitted identity fields: no extra host metadata can enter a plan or its prompt.
    const identity: TrustedApplicationIdentity = { actorId: candidate.actorId, profileId: candidate.profileId, sessionId: candidate.sessionId,
      workspaceId: candidate.workspaceId, submissionId: candidate.submissionId, turn: candidate.turn, sourceScopeVersionId: candidate.sourceScopeVersionId,
      baselineDigest: candidate.baselineDigest, mode: candidate.mode, assertCurrent: candidate.assertCurrent }
    identity.assertCurrent()
    return identity
  }
  private policy(identity: TrustedApplicationIdentity) {
    const policy = this.store.sessionPolicy(identity.profileId, identity.sessionId)
    if (policy && (policy.profileId !== identity.profileId || policy.sessionId !== identity.sessionId || policy.updatedBy.kind !== 'user'
      || policy.updatedBy.actorId !== identity.actorId)) fail('permission-denied', 'Personalization policy belongs to another identity')
    return policy
  }
  private eligible(identity: TrustedApplicationIdentity): LiveMemory[] {
    const now = (this.ports.now?.() ?? new Date()).getTime()
    if (!Number.isFinite(now)) fail('integrity-error', 'Invalid personalization application clock')
    return this.store.currentMemories(identity.profileId).filter((memory): memory is LiveMemory => memory.status === 'active'
      && memory.profileId === identity.profileId && memory.sensitivity === 'ordinary' && memory.policy.apply === 'disclose'
      && ['explicit-setting', 'explicit-confirmation'].includes(memory.activation.kind) && memory.activation.actor.kind === 'user'
      && memory.activation.actor.actorId === identity.actorId && memory.memoryType !== 'familiarity-estimate' && approvedEffect(memory.effect)
      && (memory.scope.kind === 'global' || memory.scope.kind === 'workspace' && memory.scope.workspaceId === identity.workspaceId)
      && (!memory.validTime.from || Date.parse(memory.validTime.from) <= now) && (!memory.validTime.until || Date.parse(memory.validTime.until) > now))
      .sort((left, right) => left.memoryVersionId.localeCompare(right.memoryVersionId))
  }
}
