import { describe, expect, it } from 'vitest'

import {
  type ClaimLedgerSnapshot,
  type ClaimVersion,
  type DerivationActivity,
  type EvidenceRelation,
  claimLedgerIssues,
  derivationActivityIssues,
  evidenceRelationIssues,
} from '../src/claim-contracts.ts'
import {
  type InvalidM4Case,
  m4Validators,
  materializeInvalidCase,
  readM4Fixture,
} from './m4-schema-test-utils.ts'

const fixture = readM4Fixture<ClaimLedgerSnapshot>('claim-ledger.json')
const invalidCases = readM4Fixture<{ cases: InvalidM4Case[] }>('invalid-cases.json').cases
const validators = m4Validators()

describe('M4 Claim Ledger contracts', () => {
  it('accepts a contested ClaimVersion with two explicit EvidenceRelations and provenance', () => {
    expect(validators['claim-version'](fixture.claims[0])).toBe(true)
    expect(fixture.evidenceRelations.every(value => validators['evidence-relation'](value))).toBe(true)
    expect(fixture.derivations.every(value => validators['derivation-activity'](value))).toBe(true)
    expect(claimLedgerIssues(fixture)).toEqual([])
  })

  it.each(invalidCases.slice(0, 3).map(testCase => [testCase.description, testCase] as const))(
    'rejects invalid language-neutral shape: %s',
    (_description, testCase) => {
      expect(validators[testCase.schemaName](materializeInvalidCase(testCase))).toBe(false)
    },
  )

  it('detects epistemic overclaim and a non-EvidenceAtom reference', () => {
    const drift = structuredClone(fixture)
    drift.claims[0]!.epistemicStatus = 'supported'
    drift.knownEvidenceIds = ['evidence:termination-support']
    expect(claimLedgerIssues(drift).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'claim-ledger-reference',
      'claim-ledger-status',
    ]))
  })

  it('detects forged human review time and cyclic derivation output', () => {
    const relation = structuredClone(fixture.evidenceRelations[0]) as EvidenceRelation
    if (relation.reviewStatus !== 'machine-proposed') relation.reviewedAt = '2026-08-31T09:00:00Z'
    expect(evidenceRelationIssues(relation).map(issue => issue.code)).toContain(
      'evidence-relation-time-order',
    )
    const derivation = structuredClone(fixture.derivations[0]) as DerivationActivity
    derivation.inputClaimVersionIds = ['claim:termination:v1']
    expect(derivationActivityIssues(derivation).map(issue => issue.code)).toContain(
      'derivation-activity-reference-cycle',
    )
  })

  it('keeps accepted, contested, and current as orthogonal dimensions', () => {
    const claim = fixture.claims[0] as ClaimVersion
    expect(claim.epistemicStatus).toBe('contested')
    expect(claim.reviewStatus).toBe('accepted')
    expect(claim.lifecycleStatus).toBe('current')
  })
})
