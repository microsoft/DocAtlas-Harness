import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  m4RpcIssues,
  type M4RpcRequest,
  type M4RpcResult,
} from '../src/m4-rpc-contracts.ts'
import { validateContractShape } from '../src/node.ts'

const fixture = readJson('m4-rpc.json') as Record<string, M4RpcRequest | M4RpcResult>
const invalid = readJson('m4-rpc.invalid.json') as Record<string, unknown>

const pairs = [
  ['claimRecordRequest', 'claimRecordResult'],
  ['ledgerGetRequest', 'ledgerGetResult'],
  ['artifactDraftRequest', 'artifactDraftResult'],
  ['conflictAssureRequest', 'conflictAssureResult'],
  ['reviewRunRequest', 'reviewRunResult'],
  ['humanDecisionRequest', 'humanDecisionResult'],
  ['publishRequest', 'publishResult'],
  ['artifactGetRequest', 'artifactGetResult'],
  ['reviewGetRequest', 'reviewGetResult'],
] as const

describe('authenticated M4 RPC contracts', () => {
  it.each(pairs)('accepts and semantically binds %s -> %s', (requestName, resultName) => {
    const request = fixture[requestName] as M4RpcRequest
    const result = fixture[resultName] as M4RpcResult
    expect(validateContractShape('m4-rpc', request)).toMatchObject({ ok: true })
    expect(validateContractShape('m4-rpc', result)).toMatchObject({ ok: true })
    expect(m4RpcIssues(request)).toEqual([])
    expect(m4RpcIssues(result, request)).toEqual([])
    expect(validateContractShape('browser-rpc', {
      schemaVersion: 1,
      ok: true,
      result,
    })).toMatchObject({ ok: true })
  })

  it.each(Object.entries(invalid))('rejects untrusted or unbounded request shape: %s', (_name, value) => {
    expect(validateContractShape('m4-rpc', value).ok).toBe(false)
  })

  it('omits Host-owned review, publication, relation and clock authority from browser drafts', () => {
    const review = fixture.reviewRunRequest as unknown as Record<string, unknown>
    const publish = fixture.publishRequest as unknown as Record<string, unknown>
    const claim = fixture.claimRecordRequest as unknown as {
      claim: Record<string, unknown>
      provenance: Record<string, unknown>
      evidenceRelations: Array<Record<string, unknown>>
    }
    expect(review).not.toHaveProperty('reviewer')
    expect(review).not.toHaveProperty('createdAt')
    expect(publish).not.toHaveProperty('publishedBy')
    expect(publish).not.toHaveProperty('publishedAt')
    expect(claim.claim).not.toHaveProperty('createdBy')
    expect(claim.claim).not.toHaveProperty('createdAt')
    expect(claim.provenance).not.toHaveProperty('actor')
    expect(claim.evidenceRelations[0]).not.toHaveProperty('reviewedBy')
  })

  it('rejects semantic scope drift, wrong response kinds and non-canonical assurance sets', () => {
    const assurance = structuredClone(fixture.conflictAssureRequest) as Extract<
      M4RpcRequest,
      { requestType: 'm4-conflict-search-assure' }
    >
    assurance.claimVersionIds = ['claim:z', 'claim:a']
    expect(validateContractShape('m4-rpc', assurance).ok).toBe(true)
    expect(m4RpcIssues(assurance).map(issue => issue.code)).toContain('m4-rpc-assurance-set')

    const wrongRuleset = structuredClone(fixture.reviewRunRequest) as Extract<
      M4RpcRequest,
      { requestType: 'm4-review-run' }
    >
    wrongRuleset.ruleset.configHash = 'f'.repeat(64)
    expect(validateContractShape('m4-rpc', wrongRuleset).ok).toBe(true)
    expect(m4RpcIssues(wrongRuleset).map(issue => issue.code)).toContain('m4-rpc-ruleset')

    const drift = structuredClone(fixture.reviewRunResult) as M4RpcResult
    drift.workspaceId = 'workspace:other'
    expect(m4RpcIssues(drift, fixture.reviewRunRequest as M4RpcRequest).map(issue => issue.code))
      .toContain('m4-rpc-identity')

    expect(m4RpcIssues(
      fixture.reviewGetResult as M4RpcResult,
      fixture.artifactGetRequest as M4RpcRequest,
    ).map(issue => issue.code)).toContain('m4-rpc-result')
  })

  it('keeps the browser-rpc root as an envelope while exposing M4 results', () => {
    expect(validateContractShape('browser-rpc', fixture.claimRecordRequest).ok).toBe(false)
    expect(validateContractShape('browser-rpc', {
      schemaVersion: 1,
      ok: true,
      result: fixture.publishResult,
    }).ok).toBe(true)
  })

  it('binds canonical Artifact and ruleset values independently of object key order', () => {
    const request = structuredClone(fixture.artifactDraftRequest) as Extract<
      M4RpcRequest,
      { requestType: 'm4-artifact-draft' }
    >
    const result = structuredClone(fixture.artifactDraftResult) as Extract<
      M4RpcResult,
      { resultType: 'm4-artifact-draft' }
    >
    if (result.manifest.content.kind !== 'brief') throw new Error('fixture must be a Brief')
    result.manifest.content = {
      sections: result.manifest.content.sections,
      kind: 'brief',
    }
    expect(m4RpcIssues(result, request)).toEqual([])

    const reviewRequest = structuredClone(fixture.reviewRunRequest) as Extract<
      M4RpcRequest,
      { requestType: 'm4-review-run' }
    >
    reviewRequest.ruleset = {
      configHash: reviewRequest.ruleset.configHash,
      version: reviewRequest.ruleset.version,
      name: reviewRequest.ruleset.name,
    }
    expect(m4RpcIssues(reviewRequest)).toEqual([])
    expect(m4RpcIssues(
      fixture.reviewRunResult as M4RpcResult,
      reviewRequest,
    )).toEqual([])
  })
})

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(
    new URL(`../../../contracts/fixtures/m4/${name}`, import.meta.url),
    'utf8',
  )) as unknown
}
