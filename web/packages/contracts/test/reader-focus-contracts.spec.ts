import { readFileSync } from 'node:fs'

import {
  type ReaderFocusResolveRequest,
  type ReaderFocusResolveResult,
  readerFocusRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/reader-focus.json', import.meta.url),
  'utf8',
)) as { request: ReaderFocusResolveRequest, result: ReaderFocusResolveResult }

describe('reader focus contracts', () => {
  it('accepts an authenticated locator request and bounded resolution', () => {
    expect(validateContractShape('reader-focus-rpc', fixture.request).ok).toBe(true)
    expect(validateContractShape('reader-focus-rpc', fixture.result).ok).toBe(true)
    expect(readerFocusRpcIssues(fixture.request)).toEqual([])
    expect(readerFocusRpcIssues(fixture.result)).toEqual([])
  })

  it('rejects mismatched focus identity and unbound Library access', () => {
    expect(readerFocusRpcIssues({
      ...fixture.request,
      focusId: 'loc:other',
    }).map(issue => issue.code)).toEqual(['reader-focus-identity'])
    expect(validateContractShape('reader-focus-rpc', {
      ...fixture.result,
      access: 'library',
    }).ok).toBe(false)
  })

  it('does not admit paths or more than five ambiguous candidates', () => {
    expect(validateContractShape('reader-focus-rpc', {
      ...fixture.request,
      path: '/private/report.pdf',
    }).ok).toBe(false)
    const result = structuredClone(fixture.result)
    result.resolution.status = 'ambiguous'
    delete result.resolution.resolvedLocator
    result.resolution.candidates = Array.from({ length: 6 }, (_, index) => ({
      ...fixture.request.locator,
      locatorId: `loc:candidate:${index}`,
    }))
    expect(readerFocusRpcIssues(result).map(issue => issue.code)).toContain(
      'reader-focus-candidate-limit',
    )
  })
})
