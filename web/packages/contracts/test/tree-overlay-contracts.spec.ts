import { readFileSync } from 'node:fs'

import {
  type TreeOverlayRequest,
  type TreeOverlayResult,
  treeOverlayRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m3/tree-overlay.json', import.meta.url),
  'utf8',
)) as { request: TreeOverlayRequest, result: TreeOverlayResult }

describe('Research Tree Overlay contracts', () => {
  it('accepts an exact Locator-bound overlay without changing canonical tree data', () => {
    expect(validateContractShape('tree-overlay-rpc', fixture.request).ok).toBe(true)
    expect(validateContractShape('tree-overlay-rpc', fixture.result).ok).toBe(true)
    expect(treeOverlayRpcIssues(fixture.request)).toEqual([])
    expect(treeOverlayRpcIssues(fixture.result, fixture.request)).toEqual([])
    expect(JSON.stringify(fixture.result)).not.toMatch(/treeNode|parentId|children|serverPath/)
  })

  it('rejects wrong source/page, deleted rows, duplicate IDs, filter escape, and budget drift', () => {
    const result = structuredClone(fixture.result)
    const duplicate = structuredClone(result.items[0]!)
    duplicate.locator.documentId = 'doc:wrong'
    duplicate.recordStatus = 'deleted'
    duplicate.recordType = 'claim-proposal'
    duplicate.layer = 'working'
    result.items.push(duplicate)
    result.pageInfo.returned = 2
    result.pageInfo.total = 2
    result.pageInfo.usedChars = 1
    expect(treeOverlayRpcIssues(result, fixture.request).map(issue => issue.code)).toEqual([
      'tree-overlay-duplicate',
      'tree-overlay-anchor',
      'tree-overlay-status',
      'tree-overlay-layer',
      'tree-overlay-count',
      'tree-overlay-filter',
    ])
  })

  it('rejects filesystem and arbitrary tree mutation fields', () => {
    expect(validateContractShape('tree-overlay-rpc', {
      ...fixture.request,
      path: '/private/document.pdf',
      children: ['node:forged'],
    }).ok).toBe(false)
  })
})
