import { readFileSync } from 'node:fs'

import {
  type ResearchGovernanceRequest,
  type ResearchGovernanceResult,
  researchGovernanceRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m3/research-governance.json', import.meta.url),
  'utf8',
)) as {
  createDecisionRequest: ResearchGovernanceRequest
  createDecisionResult: ResearchGovernanceResult
  createPolicyRequest: ResearchGovernanceRequest
  createPolicyResult: ResearchGovernanceResult
  archivePolicyRequest: ResearchGovernanceRequest
  archivePolicyResult: ResearchGovernanceResult
}

describe('Research Governance contracts', () => {
  it.each([
    [fixture.createDecisionRequest, fixture.createDecisionResult],
    [fixture.createPolicyRequest, fixture.createPolicyResult],
    [fixture.archivePolicyRequest, fixture.archivePolicyResult],
  ])('accepts a user-authorized typed mutation', (request, result) => {
    expect(validateContractShape('research-governance-rpc', request).ok).toBe(true)
    expect(validateContractShape('research-governance-rpc', result).ok).toBe(true)
    expect(researchGovernanceRpcIssues(result, request)).toEqual([])
  })

  it('rejects model authority, path input, stale versions, and content-bearing tombstones', () => {
    expect(validateContractShape('research-governance-rpc', {
      ...fixture.createDecisionRequest,
      path: '/private/project.sqlite3',
    }).ok).toBe(false)
    const result = structuredClone(fixture.archivePolicyResult)
    result.record.updatedBy = { kind: 'agent', actorId: 'agent:forged' }
    result.record.version = 1
    result.record.workspaceId = 'workspace:other'
    expect(researchGovernanceRpcIssues(result, fixture.archivePolicyRequest).map(issue => issue.code))
      .toEqual([
        'research-governance-actor',
        'research-governance-identity',
        'research-governance-version',
      ])
    expect(validateContractShape('research-governance-rpc', {
      ...fixture.archivePolicyResult,
      record: { ...fixture.archivePolicyResult.record, status: 'deleted' },
    }).ok).toBe(false)
  })
})
