import { describe, expect, it } from 'vitest'
import { parseContract } from '../src/node.js'

describe('product search v1 boundaries', () => {
  it('requires an explicit recipe independent of legacy sidecar v1', () => {
    const request = { schemaVersion: 1, kind: 'product-search-request', recipe: 'tree-search.v1', query: 'liquidity', strategy: 'tree', limits: { maxItems: 10, maxChars: 6000 } }
    expect(parseContract('product-search', request)).toEqual(request)
    expect(() => parseContract('product-search', { ...request, recipe: 'v0' })).toThrow()
    expect(() => parseContract('product-search', { ...request, actorId: 'forged' })).toThrow()
  })
  it('rejects arbitrary pages, extra instructions and unbounded planner output', () => {
    const value = { schemaVersion: 1, kind: 'tree-search-selection', nodes: [{ key: 'n0', reason: 'relevant chapter' }] }
    expect(parseContract('product-search', value)).toEqual(value)
    expect(() => parseContract('product-search', { ...value, nodes: [{ key: 'n0', reason: 'r', page: 99 }] })).toThrow()
    expect(() => parseContract('product-search', { ...value, nodes: Array.from({ length: 17 }, (_, index) => ({ key: `n${index}`, reason: 'r' })) })).toThrow()
  })
  it('accepts optional question policy without allowing profile/provider authority', () => {
    const value = { schemaVersion: 1, kind: 'submission', conversationId: 'conversation:one', expectedGeneration: 1, idempotencyKey: 'key:search-request-0001', mode: 'prompt', text: 'q', sourceRefs: [], selectionContextIds: [],
      documentSearch: { recipe: 'tree-search.v1', strategy: 'combined' } }
    expect(parseContract('product-control', value)).toEqual(value)
    expect(() => parseContract('product-control', { ...value, documentSearch: { ...value.documentSearch, model: 'browser-picked' } })).toThrow()
  })
})
