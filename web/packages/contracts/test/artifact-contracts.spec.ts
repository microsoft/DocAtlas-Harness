import { describe, expect, it } from 'vitest'

import {
  type ArtifactManifest,
  artifactManifestIssues,
} from '../src/artifact-contracts.ts'
import type { ClaimLedgerSnapshot } from '../src/claim-contracts.ts'
import type { ReviewResult } from '../src/review-contracts.ts'
import {
  type InvalidM4Case,
  m4Validators,
  materializeInvalidCase,
  readM4Fixture,
} from './m4-schema-test-utils.ts'

const artifacts = readM4Fixture<{ brief: ArtifactManifest, matrix: ArtifactManifest }>('artifacts.json')
const ledger = readM4Fixture<ClaimLedgerSnapshot>('claim-ledger.json')
const review = readM4Fixture<ReviewResult>('review-result.json')
const invalidCase = readM4Fixture<{ cases: InvalidM4Case[] }>('invalid-cases.json').cases[4]!
const validators = m4Validators()

const ledgerContext = {
  claims: ledger.claims,
  evidenceRelations: ledger.evidenceRelations,
}

describe('M4 Brief and Matrix ArtifactManifest contracts', () => {
  it('accepts a reviewed Brief whose exact factual span discloses both sides of a conflict', () => {
    expect(validators['artifact-manifest'](artifacts.brief)).toBe(true)
    expect(artifactManifestIssues(artifacts.brief, { ...ledgerContext, reviewResult: review })).toEqual([])
  })

  it('accepts a sparse draft Matrix over the same Claim/Evidence ledger', () => {
    expect(validators['artifact-manifest'](artifacts.matrix)).toBe(true)
    expect(artifactManifestIssues(artifacts.matrix, ledgerContext)).toEqual([])
  })

  it('rejects a draft that falsely retains publication state', () => {
    expect(validators[invalidCase.schemaName](materializeInvalidCase(invalidCase))).toBe(false)
  })

  it('detects wrong Matrix coordinates and Unicode-scalar ranges', () => {
    const matrix = structuredClone(artifacts.matrix)
    if (matrix.content.kind !== 'matrix') throw new Error('expected Matrix fixture')
    matrix.content.cells[0]!.rowId = 'row:missing'
    matrix.content.cells[0]!.claimUses[0]!.span.end = 10_000
    expect(artifactManifestIssues(matrix, ledgerContext).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'artifact-matrix-reference',
      'artifact-claim-use-range',
    ]))
  })

  it('rejects an ordinary assertion that hides a contested Claim', () => {
    const brief = structuredClone(artifacts.brief)
    if (brief.content.kind !== 'brief') throw new Error('expected Brief fixture')
    brief.content.sections[0]!.claimUses[0]!.useKind = 'assertion'
    expect(artifactManifestIssues(brief, { ...ledgerContext, reviewResult: review }).map(issue => issue.code))
      .toContain('artifact-claim-state')
  })

  it('pins publication to the exact reviewed manifest hash', () => {
    const drift = structuredClone(review)
    drift.subject.contentHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    expect(artifactManifestIssues(artifacts.brief, { ...ledgerContext, reviewResult: drift }).map(issue => issue.code))
      .toContain('artifact-review-reference')
  })
})
