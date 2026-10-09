import { readFileSync } from 'node:fs'

import {
  type AnswerGetRequest,
  type AnswerGetResult,
  type AnswerManifest,
  answerManifestIssues,
  answerRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/answer-manifest.json', import.meta.url),
  'utf8',
)) as {
  manifest: AnswerManifest
  getRequest: AnswerGetRequest
  getResult: AnswerGetResult
}

describe('answer manifest contracts', () => {
  it('accepts a factual span mapped to one Locator-bound EvidenceAtom', () => {
    expect(validateContractShape('answer-manifest', fixture.manifest).ok).toBe(true)
    expect(answerManifestIssues(fixture.manifest)).toEqual([])
    expect(validateContractShape('answer-rpc', fixture.getRequest).ok).toBe(true)
    expect(validateContractShape('answer-rpc', fixture.getResult).ok).toBe(true)
    const available: AnswerGetResult = {
      ...fixture.getResult,
      status: 'available',
      manifest: fixture.manifest,
    }
    expect(validateContractShape('answer-rpc', available).ok).toBe(true)
    expect(answerRpcIssues(available)).toEqual([])
  })

  it('detects unknown citation references and a summary/status overclaim', () => {
    const manifest = structuredClone(fixture.manifest)
    manifest.blocks[0]!.segments[0]!.visibleCitationIds = ['citation:missing']
    manifest.verificationSummary.supportedSegments = 0
    manifest.manifestStatus = 'partial'
    expect(answerManifestIssues(manifest).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'answer-citation-reference',
      'answer-summary-mismatch',
      'answer-status-mismatch',
    ]))
  })

  it('refuses read-verified status without Evidence and cross-source Evidence identity', () => {
    const missing = structuredClone(fixture.manifest)
    delete missing.citations[0]!.evidence
    expect(answerManifestIssues(missing).map(issue => issue.code)).toContain(
      'answer-evidence-identity',
    )
    const drift = structuredClone(fixture.manifest)
    drift.citations[0]!.evidence!.documentId = 'doc:other'
    expect(answerManifestIssues(drift).map(issue => issue.code)).toContain(
      'evidence-locator-mismatch',
    )
  })

  it('rejects mixed RPC availability shapes and Host paths', () => {
    expect(validateContractShape('answer-rpc', {
      ...fixture.getResult,
      manifest: fixture.manifest,
    }).ok).toBe(false)
    expect(validateContractShape('answer-manifest', {
      ...fixture.manifest,
      path: '/private/report.pdf',
    }).ok).toBe(false)
  })
})
