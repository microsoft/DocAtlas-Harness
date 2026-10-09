import { readFileSync } from 'node:fs'

import {
  type ResearchRecallRequest,
  type ResearchRecallResult,
  researchRecallRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m3/research-recall.json', import.meta.url),
  'utf8',
)) as { request: ResearchRecallRequest, result: ResearchRecallResult }

describe('Research Memory recall contracts', () => {
  it('accepts bounded cross-Investigation leads without promoting them to evidence', () => {
    expect(validateContractShape('research-recall-rpc', fixture.request).ok).toBe(true)
    expect(validateContractShape('research-recall-rpc', fixture.result).ok).toBe(true)
    expect(researchRecallRpcIssues(fixture.request)).toEqual([])
    expect(researchRecallRpcIssues(fixture.result, fixture.request)).toEqual([])
    expect(fixture.result.leads.every(lead => lead.verificationStatus === 'unverified-lead'))
      .toBe(true)
  })

  it('rejects path-shaped input and reports identity, filter, source, and budget drift', () => {
    expect(validateContractShape('research-recall-rpc', {
      ...fixture.request,
      path: '/private/investigation.sqlite3',
    }).ok).toBe(false)
    const result = structuredClone(fixture.result)
    result.workspaceId = 'workspace:other'
    result.leads[0]!.recordType = 'claim-proposal'
    result.leads[1]!.sourceState = 'current-scope'
    result.pageInfo.usedChars = 1
    expect(researchRecallRpcIssues(result, fixture.request).map(issue => issue.code)).toEqual([
      'research-recall-identity',
      'research-recall-filter',
      'research-recall-source-state',
      'research-recall-count',
    ])
  })

  it('requires a cursor for truncated recall results', () => {
    const result = structuredClone(fixture.result)
    result.pageInfo.truncated = true
    result.pageInfo.completeness = 'partial'
    expect(validateContractShape('research-recall-rpc', result).ok).toBe(false)
  })
})
