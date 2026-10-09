import { readFileSync } from 'node:fs'

import {
  type ResearchLifecycleRequest,
  type ResearchLifecycleResult,
  researchLifecycleRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m3/research-lifecycle.json', import.meta.url),
  'utf8',
)) as {
  editRequest: ResearchLifecycleRequest
  editResult: ResearchLifecycleResult
  deleteRequest: ResearchLifecycleRequest
  deleteResult: ResearchLifecycleResult
}

describe('Research record lifecycle contracts', () => {
  it.each([
    ['edit', fixture.editRequest, fixture.editResult],
    ['delete', fixture.deleteRequest, fixture.deleteResult],
  ])('accepts an authenticated versioned %s', (_name, request, result) => {
    expect(validateContractShape('research-lifecycle-rpc', request).ok).toBe(true)
    expect(validateContractShape('research-lifecycle-rpc', result).ok).toBe(true)
    expect(researchLifecycleRpcIssues(request)).toEqual([])
    expect(researchLifecycleRpcIssues(result, request)).toEqual([])
  })

  it('rejects model authority, stale identity, invalid version chains, and tombstone content', () => {
    expect(validateContractShape('research-lifecycle-rpc', {
      ...fixture.deleteRequest,
      text: 'secretly retained',
    }).ok).toBe(false)
    const wrong = structuredClone(fixture.deleteResult)
    wrong.state.updatedBy = { kind: 'agent', actorId: 'agent:forged' }
    wrong.state.previousVersion = 1
    wrong.state.text = 'secretly retained'
    wrong.state.workspaceId = 'workspace:other'
    expect(researchLifecycleRpcIssues(wrong, fixture.deleteRequest).map(issue => issue.code))
      .toEqual([
        'research-lifecycle-actor',
        'research-lifecycle-version',
        'research-lifecycle-content',
        'research-lifecycle-identity',
      ])
  })
})
