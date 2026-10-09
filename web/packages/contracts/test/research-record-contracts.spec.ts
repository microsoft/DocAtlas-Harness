import { readFileSync } from 'node:fs'

import {
  type ResearchRecordRequest,
  type ResearchRecordResult,
  researchRecordRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m3/research-record.json', import.meta.url),
  'utf8',
)) as {
  checkpointRequest: ResearchRecordRequest
  checkpointResult: ResearchRecordResult
  questionRequest: ResearchRecordRequest
  questionResult: ResearchRecordResult
}

describe('typed Research Memory record contracts', () => {
  it.each([
    ['checkpoint', fixture.checkpointRequest, fixture.checkpointResult],
    ['open question', fixture.questionRequest, fixture.questionResult],
  ])('accepts an Agent-authored unverified %s', (_name, request, result) => {
    expect(validateContractShape('research-record-rpc', request).ok).toBe(true)
    expect(validateContractShape('research-record-rpc', result).ok).toBe(true)
    expect(researchRecordRpcIssues(request)).toEqual([])
    expect(researchRecordRpcIssues(result, request)).toEqual([])
  })

  it('rejects paths, accepted facts, user impersonation, and kind drift', () => {
    expect(validateContractShape('research-record-rpc', {
      ...fixture.checkpointRequest,
      path: '/private/research.sqlite3',
    }).ok).toBe(false)
    expect(validateContractShape('research-record-rpc', {
      ...fixture.checkpointResult,
      record: { ...fixture.checkpointResult.record, epistemicStatus: 'verified' },
    }).ok).toBe(false)
    const wrong = structuredClone(fixture.checkpointResult)
    wrong.record.createdBy = { kind: 'user', actorId: 'user:forged' }
    wrong.record.workspaceId = 'workspace:other'
    if (wrong.record.recordType === 'research-note') wrong.record.body = 'different'
    expect(researchRecordRpcIssues(wrong, fixture.checkpointRequest).map(issue => issue.code))
      .toEqual(['research-record-actor', 'research-record-identity', 'research-record-kind'])
  })
})
