import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  type SourceScopeRpcRequest,
  type SourceScopeRpcResult,
  sourceScopeRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'

interface Fixture {
  commitRequest: SourceScopeRpcRequest
  commitResult: SourceScopeRpcResult
  getRequest: SourceScopeRpcRequest
  activeResult: SourceScopeRpcResult
  bindRequest: SourceScopeRpcRequest
  bindResult: SourceScopeRpcResult
  unboundResult: SourceScopeRpcResult
  unbindRequest: SourceScopeRpcRequest
  unbindResult: SourceScopeRpcResult
  overviewRequest: SourceScopeRpcRequest
  overviewResult: SourceScopeRpcResult
  patchRequest: SourceScopeRpcRequest
}

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/source-scope.json', import.meta.url),
  'utf8',
)) as Fixture

describe('per-session source scope RPC', () => {
  it('accepts the shared commit/get/unbind lifecycle', () => {
    for (const value of Object.values(fixture)) {
      expect(validateContractShape('source-scope-rpc', value).ok).toBe(true)
      expect(sourceScopeRpcIssues(value)).toEqual([])
    }
  })

  it('fails semantic coverage, locking, duplicate representation, and CAS shape', () => {
    if (fixture.commitRequest.requestType !== 'source-scope-commit') throw new Error('wrong fixture')
    const request = structuredClone(fixture.commitRequest)
    request.scope.locked = false
    request.expectedScopeVersionId = 'scope:unexpected'
    request.sources[0]!.documentId = 'doc:outside'
    request.sources.push(structuredClone(request.sources[0]!))
    expect(sourceScopeRpcIssues(request).map(issue => issue.code)).toEqual([
      'scope-rpc-unlocked',
      'scope-rpc-source-outside-included',
      'scope-rpc-duplicate-source',
      'scope-rpc-source-outside-included',
      'scope-rpc-included-without-source',
      'scope-rpc-cas-shape',
    ])
  })

  it('does not allow active status without its complete immutable snapshot', () => {
    expect(validateContractShape('source-scope-rpc', {
      schemaVersion: 1,
      resultType: 'source-scope',
      sessionId: 'session:scope:one',
      status: 'active',
    }).ok).toBe(false)
  })

  it('rejects overlapping patch operations and incomplete grounded overview items', () => {
    if (fixture.patchRequest.requestType !== 'source-scope-patch') throw new Error('wrong fixture')
    const patch = structuredClone(fixture.patchRequest)
    patch.remove = [{ ...patch.add[0]!, role: 'primary' }]
    expect(sourceScopeRpcIssues(patch).map(issue => issue.code)).toEqual([
      'scope-patch-conflict',
      'scope-patch-conflict',
    ])
    expect(validateContractShape('source-scope-rpc', {
      ...fixture.patchRequest,
      createdAt: '1999-01-01T00:00:00Z',
    }).ok).toBe(false)
    if (!('resultType' in fixture.overviewResult)
      || fixture.overviewResult.resultType !== 'source-scope-overview') throw new Error('wrong fixture')
    const overview = structuredClone(fixture.overviewResult)
    delete overview.items[0]!.source
    expect(sourceScopeRpcIssues(overview).map(issue => issue.code)).toContain('scope-overview-item')
    expect(validateContractShape('source-scope-rpc', overview).ok).toBe(false)
    expect(validateContractShape('source-scope-rpc', {
      ...fixture.overviewResult,
      items: [{ ...fixture.overviewResult.items[0], path: '/private/report.pdf' }],
    }).ok).toBe(false)
  })
})
