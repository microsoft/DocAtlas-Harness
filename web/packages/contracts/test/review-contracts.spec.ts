import { describe, expect, it } from 'vitest'

import { type ReviewResult, reviewResultIssues } from '../src/review-contracts.ts'
import {
  type InvalidM4Case,
  m4Validators,
  materializeInvalidCase,
  readM4Fixture,
} from './m4-schema-test-utils.ts'

const fixture = readM4Fixture<ReviewResult>('review-result.json')
const invalidCase = readM4Fixture<{ cases: InvalidM4Case[] }>('invalid-cases.json').cases[3]!
const validators = m4Validators()

describe('M4 deterministic Review contracts', () => {
  it('accepts exact G0-G4 results whose human sign-off remains separate', () => {
    expect(validators['review-result'](fixture)).toBe(true)
    expect(reviewResultIssues(fixture)).toEqual([])
    expect(fixture.decision).toBe('needs-human')
  })

  it('rejects a language-neutral result with reordered gates', () => {
    expect(validators[invalidCase.schemaName](materializeInvalidCase(invalidCase))).toBe(false)
  })

  it('distinguishes a non-applicable gate from an incomplete required gate', () => {
    const review = structuredClone(fixture)
    review.mode = 'claim-challenge'
    review.subject = { kind: 'claim-set', objectIds: ['claim:termination:v1'] }
    review.gates[4] = {
      gateId: 'G4-publication',
      status: 'not-applicable',
      checkedObjectIds: [],
      issueIds: [],
    }
    review.signoffRequirement = 'not-required'
    review.decision = 'pass'
    expect(validators['review-result'](review)).toBe(true)
    expect(reviewResultIssues(review)).toEqual([])
  })

  it('derives gate failure from blockers and never lets needs-human hide it', () => {
    const review = structuredClone(fixture)
    review.issues[0]!.severity = 'blocker'
    expect(reviewResultIssues(review).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'review-gate-status',
      'review-decision-mismatch',
    ]))
  })

  it('detects issue-to-gate drift and fabricated coverage', () => {
    const review = structuredClone(fixture)
    review.issues[0]!.gateId = 'G3-conflict'
    review.coverage.checkedItems = 0
    expect(reviewResultIssues(review).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'review-issue-reference',
      'review-coverage-mismatch',
      'review-decision-mismatch',
    ]))
  })
})
