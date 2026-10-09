import { readFileSync } from 'node:fs'

import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js'
import * as addFormatsModule from 'ajv-formats'
import type { FormatsPlugin } from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import {
  type MemoryCandidate,
  type MemorySessionPolicy,
  type MemoryUse,
  type MemoryVersion,
  type PersonalizationCommandRequest,
  type PersonalizationCommandResult,
  type PersonalizationCommandValue,
  type PersonalizationCoreValue,
  type PersonalizationDecision,
  type PersonalizationObservation,
  type PersonalizationValidationContext,
  type PreferenceChoiceObservation,
  type PreferenceProbe,
  memoryVersionSetIssues,
  personalizationCommandIssues,
  personalizationCoreIssues,
} from '../src/personalization-contracts.ts'
import type { PersonalizationContractIssueCode } from '../src/personalization-contract-issues.ts'

interface CommandsFixture {
  setSessionPolicyRequest: PersonalizationCommandRequest
  setSessionPolicyResult: PersonalizationCommandResult
  setPreferenceRequest: PersonalizationCommandRequest
  setPreferenceResult: PersonalizationCommandResult
  reviewCandidateRequest: PersonalizationCommandRequest
  reviewCandidateResult: PersonalizationCommandResult
  pauseRequest: PersonalizationCommandRequest
  pauseResult: PersonalizationCommandResult
  resumeRequest: PersonalizationCommandRequest
  resumeResult: PersonalizationCommandResult
  editRequest: PersonalizationCommandRequest
  editResult: PersonalizationCommandResult
  forgetChainRequest: PersonalizationCommandRequest
  forgetChainResult: PersonalizationCommandResult
  forgetProfileRequest: PersonalizationCommandRequest
  forgetProfileResult: PersonalizationCommandResult
  exportRequest: PersonalizationCommandRequest
  exportResult: PersonalizationCommandResult
}

interface ValidFixture {
  sessionPolicy: MemorySessionPolicy
  explicitObservation: PersonalizationObservation
  sessionOnlyObservation: PersonalizationObservation
  inferredObservation: PersonalizationObservation
  candidate: MemoryCandidate
  sensitiveCandidate: MemoryCandidate
  memoryVersion: MemoryVersion
  decision: PersonalizationDecision
  memoryUse: MemoryUse
  preferenceProbe: PreferenceProbe
  preferenceChoice: PreferenceChoiceObservation
  pairwiseObservation: PersonalizationObservation
  commands: CommandsFixture
}

interface Mutation {
  path: string
  value: unknown
}

interface ShapeCase {
  name: string
  schema: 'core' | 'command'
  base: string
  mutations: Mutation[]
}

interface SemanticCase {
  name: string
  kind:
    | 'core'
    | 'core-prior-probe'
    | 'core-policy-off'
    | 'command-request'
    | 'command-result-export'
    | 'command-result-forget'
  base: string
  mutations: Mutation[]
  expectedIssueCodes: PersonalizationContractIssueCode[]
}

interface InvalidFixture {
  shapeCases: ShapeCase[]
  semanticCases: SemanticCase[]
}

const contractRoot = new URL('../../../contracts/', import.meta.url)
const addFormats = addFormatsModule.default as unknown as FormatsPlugin
const readJson = <T>(relative: string): T => JSON.parse(
  readFileSync(new URL(relative, contractRoot), 'utf8'),
) as T

const valid = readJson<ValidFixture>('fixtures/m6/personalization.valid.json')
const invalid = readJson<InvalidFixture>('fixtures/m6/personalization.invalid.json')

function validators(): { core: ValidateFunction, command: ValidateFunction } {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  for (const path of [
    'protocol/common.schema.json',
    'personalization/personalization-core.schema.json',
    'personalization/personalization-command.schema.json',
  ]) {
    ajv.addSchema(readJson<AnySchema>(path))
  }
  const core = ajv.getSchema('https://docatlas.dev/schemas/personalization-core.v1.json')
  const command = ajv.getSchema('https://docatlas.dev/schemas/personalization-command.v1.json')
  if (core === undefined || command === undefined) throw new Error('missing personalization schema')
  return { core, command }
}

function fullContext(): PersonalizationValidationContext {
  return {
    profileId: valid.sessionPolicy.profileId,
    sessionPolicies: [valid.sessionPolicy],
    observations: [
      valid.explicitObservation,
      valid.sessionOnlyObservation,
      valid.inferredObservation,
      valid.pairwiseObservation,
    ],
    choices: [valid.preferenceChoice],
    candidates: [valid.candidate, valid.sensitiveCandidate],
    memories: [valid.memoryVersion],
    decisions: [valid.decision],
    probes: [valid.preferenceProbe],
  }
}

function coreValues(): PersonalizationCoreValue[] {
  return [
    valid.sessionPolicy,
    valid.explicitObservation,
    valid.sessionOnlyObservation,
    valid.inferredObservation,
    valid.candidate,
    valid.sensitiveCandidate,
    valid.memoryVersion,
    valid.decision,
    valid.memoryUse,
    valid.preferenceProbe,
    valid.preferenceChoice,
    valid.pairwiseObservation,
  ]
}

function commandValues(): PersonalizationCommandValue[] {
  return Object.values(valid.commands)
}

describe('governed personalization contracts', () => {
  const validate = validators()

  it('accepts K0-K3 records with profile, consent, scope, provenance, and Fact Trace guards', () => {
    const context = fullContext()
    for (const value of coreValues()) {
      expect(validate.core(value), JSON.stringify(validate.core.errors)).toBe(true)
      expect(personalizationCoreIssues(value, context)).toEqual([])
    }
  })

  it('keeps use-existing and contribute-to-future as independent session controls', () => {
    for (const [useExisting, contributeToFuture] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const policy: MemorySessionPolicy = {
        ...valid.sessionPolicy,
        policyId: `policy:${String(useExisting)}:${String(contributeToFuture)}`,
        useExisting,
        contributeToFuture,
      }
      expect(validate.core(policy), JSON.stringify(validate.core.errors)).toBe(true)
      expect(personalizationCoreIssues(policy, { profileId: policy.profileId })).toEqual([])
    }
  })

  it('accepts authenticated set/review/pause/resume/edit/forget/export commands without paths', () => {
    for (const value of commandValues()) {
      expect(validate.command(value), JSON.stringify(validate.command.errors)).toBe(true)
      if ('requestType' in value) expect(personalizationCommandIssues(value)).toEqual([])
    }
    for (const [request, result] of [
      [valid.commands.setSessionPolicyRequest, valid.commands.setSessionPolicyResult],
      [valid.commands.setPreferenceRequest, valid.commands.setPreferenceResult],
      [valid.commands.reviewCandidateRequest, valid.commands.reviewCandidateResult],
      [valid.commands.pauseRequest, valid.commands.pauseResult],
      [valid.commands.resumeRequest, valid.commands.resumeResult],
      [valid.commands.editRequest, valid.commands.editResult],
      [valid.commands.forgetChainRequest, valid.commands.forgetChainResult],
      [valid.commands.forgetProfileRequest, valid.commands.forgetProfileResult],
      [valid.commands.exportRequest, valid.commands.exportResult],
    ] as const) {
      expect(personalizationCommandIssues(result, request)).toEqual([])
    }
  })

  it('allows declared sensitive memory only after explicit user confirmation', () => {
    if (valid.memoryVersion.status === 'deleted') throw new Error('fixture memory must be active')
    const memoryBase = structuredClone(valid.memoryVersion)
    delete memoryBase.candidateId
    const memory: MemoryVersion = {
      ...memoryBase,
      sensitivity: 'sensitive',
      contentSafety: { secretScan: 'passed', sensitiveInference: 'user-declared' },
      activation: {
        kind: 'explicit-confirmation',
        actor: { kind: 'user', actorId: 'user:local' },
        activatedAt: '2026-08-31T13:04:00Z',
      },
      policy: { apply: 'confirm-each-use' },
    }
    expect(validate.core(memory), JSON.stringify(validate.core.errors)).toBe(true)
    expect(personalizationCoreIssues(memory, {
      profileId: memory.profileId,
      observations: [valid.explicitObservation],
      candidates: [valid.candidate],
    })).toEqual([])
  })

  it('enforces one current immutable version and exact predecessor links per chain', () => {
    if (valid.memoryVersion.status === 'deleted') throw new Error('fixture memory must be active')
    const first: MemoryVersion = {
      ...valid.memoryVersion,
      status: 'superseded',
      supersededByMemoryVersionId: 'memory:table-context:v2',
      transactionTime: {
        ...valid.memoryVersion.transactionTime,
        retiredAt: '2026-08-31T14:10:00Z',
      },
    }
    const second: MemoryVersion = {
      ...valid.memoryVersion,
      memoryVersionId: 'memory:table-context:v2',
      version: 2,
      previousMemoryVersionId: valid.memoryVersion.memoryVersionId,
      status: 'paused',
      transactionTime: { recordedAt: '2026-08-31T14:10:00Z' },
    }
    expect(memoryVersionSetIssues([first, second])).toEqual([])
    expect(memoryVersionSetIssues([valid.memoryVersion, second]).map(issue => issue.code)).toEqual([
      'personalization-memory-current-version',
      'personalization-memory-lineage',
    ])
  })

  it.each(invalid.shapeCases)('strictly rejects $name', ({ schema, base, mutations }) => {
    const value = materialize(base, mutations)
    expect(validate[schema](value), JSON.stringify(validate[schema].errors)).toBe(false)
  })

  it.each(invalid.semanticCases)(
    'fails closed when $name',
    ({ kind, base, mutations, expectedIssueCodes }) => {
      const value = materialize(base, mutations)
      const schema = kind.startsWith('command') ? validate.command : validate.core
      expect(schema(value), JSON.stringify(schema.errors)).toBe(true)
      const issues = semanticIssues(kind, value)
      expect(issues.map(issue => issue.code)).toEqual(expectedIssueCodes)
    },
  )

  it('never treats Personal Memory as Evidence or stores source text', () => {
    const polluted = {
      ...valid.memoryVersion,
      quote: 'content copied from a PDF must not enter the profile ledger',
      evidenceRelation: { relation: 'supports' },
    } as unknown as PersonalizationCoreValue
    expect(validate.core(polluted)).toBe(false)
    expect(personalizationCoreIssues(polluted).map(issue => issue.code)).toContain(
      'personalization-domain-separation',
    )
    expect(JSON.stringify(valid).includes('documentText')).toBe(false)
    expect(JSON.stringify(valid).includes('sourceText')).toBe(false)
    expect(JSON.stringify(valid).includes('locator')).toBe(false)
  })
})

function semanticIssues(kind: SemanticCase['kind'], value: unknown) {
  if (kind === 'command-request') {
    return personalizationCommandIssues(value as PersonalizationCommandRequest)
  }
  if (kind === 'command-result-export') {
    return personalizationCommandIssues(
      value as PersonalizationCommandResult,
      valid.commands.exportRequest,
    )
  }
  if (kind === 'command-result-forget') {
    return personalizationCommandIssues(
      value as PersonalizationCommandResult,
      valid.commands.forgetProfileRequest,
    )
  }
  const context = fullContext()
  if (kind === 'core-prior-probe') {
    context.priorAutomaticProbeInvestigationIds = new Set(['investigation:finance:q4'])
  }
  if (kind === 'core-policy-off') {
    context.sessionPolicies = [{ ...valid.sessionPolicy, contributeToFuture: false }]
  }
  return personalizationCoreIssues(value as PersonalizationCoreValue, context)
}

function materialize(pointer: string, mutations: Mutation[]): unknown {
  const value = structuredClone(resolvePointer(valid, pointer))
  for (const mutation of mutations) setPointer(value, mutation.path, mutation.value)
  return value
}

function resolvePointer(value: unknown, pointer: string): unknown {
  let current = value
  for (const token of pointerTokens(pointer)) {
    if (typeof current !== 'object' || current === null) throw new Error(`invalid fixture pointer: ${pointer}`)
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function setPointer(value: unknown, pointer: string, replacement: unknown): void {
  const tokens = pointerTokens(pointer)
  const last = tokens.pop()
  if (last === undefined) throw new Error('mutation cannot replace the fixture root')
  let current = value
  for (const token of tokens) {
    if (typeof current !== 'object' || current === null) throw new Error(`invalid mutation pointer: ${pointer}`)
    current = (current as Record<string, unknown>)[token]
  }
  if (typeof current !== 'object' || current === null) throw new Error(`invalid mutation pointer: ${pointer}`)
  ;(current as Record<string, unknown>)[last] = replacement
}

function pointerTokens(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}
