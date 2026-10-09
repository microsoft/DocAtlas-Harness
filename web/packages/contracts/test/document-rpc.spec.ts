import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ingestRequestIssues,
  ingestResultIssues,
  type IngestRequest,
  type IngestResult,
  readResultIssues,
  type ReadRequest,
  type ReadResult,
  resolveResultIssues,
  type ResolveRequest,
  type ResolveResult,
  searchResultIssues,
  type SearchRequest,
  type SearchResult,
  sourceBindingIssues,
} from '../src/index.ts'
import { parseContract, validateContractShape } from '../src/node.ts'

interface DocumentRpcFixture {
  ingestRequest: IngestRequest
  ingestResult: IngestResult
  searchRequest: SearchRequest
  searchResult: SearchResult
  readRequests: ReadRequest[]
  readResult: ReadResult
  resolveRequest: ResolveRequest
  resolveResult: ResolveResult
}

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m1/document-rpc.json', import.meta.url),
  'utf8',
)) as DocumentRpcFixture

const values = (): Array<[string, object]> => [
  ['ingest', fixture.ingestRequest],
  ['ingest', fixture.ingestResult],
  ['search', fixture.searchRequest],
  ['search', fixture.searchResult],
  ...fixture.readRequests.map(value => ['read', value] as [string, object]),
  ['read', fixture.readResult],
  ['resolve', fixture.resolveRequest],
  ['resolve', fixture.resolveResult],
]

describe('sidecar document RPC contracts', () => {
  it('parses every canonical request and result', () => {
    for (const [, value] of values()) {
      expect(validateContractShape('sidecar-document-rpc', value).ok).toBe(true)
      expect(parseContract('sidecar-document-rpc', value)).toBe(value)
    }
  })

  it('accepts every canonical value in its JSON-RPC envelope', () => {
    for (const [method, value] of values()) {
      const isRequest = 'requestType' in value
      const envelope = isRequest
        ? { jsonrpc: '2.0', id: `request:${method}`, method, params: value }
        : { jsonrpc: '2.0', id: `result:${method}`, result: value }
      expect(validateContractShape('sidecar-envelope', envelope).ok).toBe(true)
    }
  })

  it('allows input-only PDF page count discovery without weakening durable revisions', () => {
    const request = structuredClone(fixture.ingestRequest)
    delete request.revision.pageCount
    expect(validateContractShape('sidecar-document-rpc', request).ok).toBe(true)
    expect(validateContractShape('document-revision', request.revision).ok).toBe(false)
  })

  it('keeps all canonical cross-field identities consistent', () => {
    expect(ingestRequestIssues(fixture.ingestRequest)).toEqual([])
    expect(ingestResultIssues(fixture.ingestResult)).toEqual([])
    expect(searchResultIssues(fixture.searchResult)).toEqual([])
    expect(readResultIssues(fixture.readResult)).toEqual([])
    expect(resolveResultIssues(fixture.resolveResult, fixture.resolveRequest)).toEqual([])
  })

  it('rejects mode confusion and unsafe path semantics', () => {
    const confused = { ...fixture.readRequests[0], mode: 'blocks' }
    expect(validateContractShape('sidecar-document-rpc', confused).ok).toBe(false)

    const binding = { ...fixture.ingestRequest.sourceBinding, relativePath: 'docs/./report.pdf' }
    expect(sourceBindingIssues(binding).map(issue => issue.code)).toEqual([
      'source-binding-absolute-or-unsafe-path',
    ])
  })

  it('reports identity and range conflicts deterministically', () => {
    const ingest = structuredClone(fixture.ingestRequest)
    ingest.sourceBinding.expectedContentHash = 'f'.repeat(64)
    expect(ingestRequestIssues(ingest).map(issue => issue.code)).toEqual([
      'ingest-binding-hash-mismatch',
    ])

    const search = structuredClone(fixture.searchResult)
    search.candidates[0]!.physicalPageEnd = 1
    expect(searchResultIssues(search).map(issue => issue.code)).toEqual([
      'search-candidate-page-order',
    ])

    const read = structuredClone(fixture.readResult)
    read.items[0]!.physicalPage = 3
    expect(readResultIssues(read).map(issue => issue.code)).toEqual([
      'read-item-page-mismatch',
    ])

    const resolve = structuredClone(fixture.resolveResult)
    delete resolve.resolvedLocator
    expect(resolveResultIssues(resolve, fixture.resolveRequest).map(issue => issue.code)).toEqual([
      'resolve-resolved-target-missing',
    ])
  })
})
