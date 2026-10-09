import { readFileSync } from 'node:fs'

import type { ReaderPageRequest, ReaderPageResult } from '../src/index.ts'
import { readerPageRpcIssues } from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/reader-page.json', import.meta.url),
  'utf8',
)) as { request: ReaderPageRequest, result: ReaderPageResult }

describe('controlled Reader page contracts', () => {
  it('accepts only opaque identities and bounded page data', () => {
    expect(validateContractShape('reader-page-rpc', fixture.request).ok).toBe(true)
    expect(validateContractShape('reader-page-rpc', fixture.result).ok).toBe(true)
    expect(readerPageRpcIssues(fixture.request)).toEqual([])
    expect(readerPageRpcIssues(fixture.result, fixture.request)).toEqual([])
  })

  it('rejects paths and reports page, source, count, and pixel drift', () => {
    expect(validateContractShape('reader-page-rpc', {
      ...fixture.request,
      path: '/private/report.pdf',
    }).ok).toBe(false)
    const result = structuredClone(fixture.result)
    result.documentId = 'doc:other'
    result.blocks[0]!.physicalPage = 1
    result.pageInfo.returned = 0
    result.visual.asset.width = fixture.request.maxPixels + 1
    expect(readerPageRpcIssues(result, fixture.request).map(issue => issue.code)).toEqual([
      'reader-page-identity',
      'reader-page-count',
      'reader-page-item-identity',
      'reader-page-item-identity',
      'reader-page-pixel-limit',
    ])
  })

  it('requires a pagination cursor whenever a page result is truncated', () => {
    const result = structuredClone(fixture.result)
    result.pageInfo.truncated = true
    result.pageInfo.completeness = 'partial'
    expect(validateContractShape('reader-page-rpc', result).ok).toBe(false)
  })
})
