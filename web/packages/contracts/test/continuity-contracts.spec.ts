import { readFileSync } from 'node:fs'

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import * as addFormatsModule from 'ajv-formats'
import type { FormatsPlugin } from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import {
  type ContinuityAssessRequest,
  type ContinuityAssessResult,
  type ContinuityIssueCode,
  type ContinuityRpcValue,
  type ContinuityValidationContext,
  type RevisionImpactRequest,
  type RevisionImpactResult,
  continuityRpcIssues,
  revisionImpactSequenceIssues,
} from '../src/continuity-contracts.ts'

interface AssessmentCase {
  request: ContinuityAssessRequest
  result: ContinuityAssessResult
  context: ContinuityValidationContext
}

interface ValidFixture {
  assessments: Record<'continuing' | 'changed' | 'conflicted' | 'unknown', AssessmentCase>
  revisionImpact: {
    pageOneRequest: RevisionImpactRequest
    pageOneResult: RevisionImpactResult
    pageTwoRequest: RevisionImpactRequest
    pageTwoResult: RevisionImpactResult
    context: ContinuityValidationContext
  }
}

interface InvalidShapeCase {
  name: string
  value: unknown
}

interface InvalidSemanticCase {
  name: string
  value: ContinuityRpcValue
  request?: ContinuityAssessRequest | RevisionImpactRequest
  context?: ContinuityValidationContext
  expectedIssueCodes: ContinuityIssueCode[]
}

interface InvalidFixture {
  shapeCases: InvalidShapeCase[]
  semanticCases: InvalidSemanticCase[]
}

const contractRoot = new URL('../../../contracts/', import.meta.url)
const readJson = <T>(relative: string): T => JSON.parse(
  readFileSync(new URL(relative, contractRoot), 'utf8'),
) as T

const validFixture = readJson<ValidFixture>('fixtures/m5/research-continuity.valid.json')
const invalidFixture = readJson<InvalidFixture>('fixtures/m5/research-continuity.invalid.json')
const addFormats = addFormatsModule.default as unknown as FormatsPlugin

function continuityValidator(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  for (const path of [
    'protocol/common.schema.json',
    'protocol/page-info.schema.json',
    'investigation/research-recall-rpc.schema.json',
  ]) {
    ajv.addSchema(readJson<Record<string, unknown>>(path))
  }
  return ajv.compile(readJson<Record<string, unknown>>('investigation/continuity-rpc.schema.json'))
}

describe('Research Continuity contracts', () => {
  const validate = continuityValidator()

  it.each(Object.entries(validFixture.assessments))(
    'accepts the evidence-gated %s longitudinal scenario',
    (state, fixture) => {
      expect(validate(fixture.request), JSON.stringify(validate.errors)).toBe(true)
      expect(validate(fixture.result), JSON.stringify(validate.errors)).toBe(true)
      expect(fixture.result.link.state).toBe(state)
      expect(continuityRpcIssues(fixture.request, undefined, fixture.context)).toEqual([])
      expect(continuityRpcIssues(fixture.result, fixture.request, fixture.context)).toEqual([])
    },
  )

  it('classifies an exact predecessor snapshot over a complete cursor chain', () => {
    const fixture = validFixture.revisionImpact
    for (const [request, result] of [
      [fixture.pageOneRequest, fixture.pageOneResult],
      [fixture.pageTwoRequest, fixture.pageTwoResult],
    ] as const) {
      expect(validate(request), JSON.stringify(validate.errors)).toBe(true)
      expect(validate(result), JSON.stringify(validate.errors)).toBe(true)
      expect(continuityRpcIssues(request)).toEqual([])
      expect(continuityRpcIssues(result, request, fixture.context)).toEqual([])
    }
    expect(revisionImpactSequenceIssues([
      { request: fixture.pageOneRequest, result: fixture.pageOneResult },
      { request: fixture.pageTwoRequest, result: fixture.pageTwoResult },
    ], fixture.context)).toEqual([])
  })

  it.each(invalidFixture.shapeCases)('strictly rejects $name', ({ value }) => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(false)
  })

  it.each(invalidFixture.semanticCases)(
    'fails closed when $name',
    ({ value, request, context, expectedIssueCodes }) => {
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true)
      expect(continuityRpcIssues(value, request, context).map(issue => issue.code))
        .toEqual(expectedIssueCodes)
    },
  )

  it('binds each next page to the exact preceding cursor and stable request order', () => {
    const fixture = validFixture.revisionImpact
    const wrongCursor = structuredClone(fixture.pageTwoRequest)
    wrongCursor.cursor = 'cursor:revision-impact:other'
    expect(revisionImpactSequenceIssues([
      { request: fixture.pageOneRequest, result: fixture.pageOneResult },
      { request: wrongCursor, result: fixture.pageTwoResult },
    ], fixture.context).map(issue => issue.code)).toContain('continuity-pagination')

    const reordered = structuredClone(fixture.pageTwoRequest)
    reordered.recordIds.reverse()
    expect(revisionImpactSequenceIssues([
      { request: fixture.pageOneRequest, result: fixture.pageOneResult },
      { request: reordered, result: fixture.pageTwoResult },
    ], fixture.context).map(issue => issue.code)).toContain('continuity-identity')
  })
})
