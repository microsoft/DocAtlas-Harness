import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ReadResult, ResolveRequest, ScopedSourceIdentity } from '@docatlas/contracts'
import { verifyTextSelection, type SelectionResolverPort } from '../src/document/selection-verifier.js'

const source: ScopedSourceIdentity = { documentId: 'doc:one', revisionId: 'rev:one', representationId: 'rep:one', representationContentHash: 'a'.repeat(64) }
const timestamp = '2026-09-09T00:00:00.000Z'
const identity = { documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId }
function backend(text: string, change?: (value: ReadResult) => void): SelectionResolverPort {
  return { call: (async (method: string, request: ResolveRequest) => {
    if (method === 'read') {
      const result: ReadResult = { schemaVersion: 1, resultType: 'read', mode: 'page', source: identity, textQuality: 'usable', items: [{ itemType: 'block', blockId: 'block:one', physicalPage: 1, kind: 'paragraph', text,
        locator: { schemaVersion: 1, locatorId: 'loc:block', ...source, physicalPage: 1, selectors: [{ type: 'text-position', start: 0, end: [...text].length, unit: 'unicode-scalar' }], createdAt: timestamp } }],
        pageInfo: { schemaVersion: 1, limit: 200, returned: 1, total: 1, usedChars: [...text].length, truncated: false, completeness: 'complete' } }
      change?.(result); return result
    }
    const position = request.locator.selectors.find(selector => selector.type === 'text-position')!
    if (position.type !== 'text-position') throw new Error()
    const exactText = [...text].slice(position.start, position.end).join('')
    return { schemaVersion: 1, resultType: 'resolve', ...identity, resolutionId: 'resolve:one', locatorId: request.locator.locatorId, status: 'resolved', checkedAt: timestamp, checkedRepresentationHash: source.representationContentHash, exactText, candidates: [],
      resolvedLocator: { ...request.locator, selectors: [...request.locator.selectors, { type: 'text-quote', exact: exactText, normalizedHash: createHash('sha256').update(exactText).digest('hex') }] } }
  }) as SelectionResolverPort['call'] }
}
it('maps whitespace-only differences and astral Unicode to exact source scalar positions', async () => {
  const value = await verifyTextSelection({ documentId: source.documentId, revisionId: source.revisionId, physicalPage: 1, quote: 'profit 😀 grew 9%' }, source, backend('A report: profit 😀\n grew 9% in 2025'), () => {})
  expect(value.text).toBe('profit 😀\n grew 9%')
  expect(value.locator.selectors).toContainEqual({ type: 'text-position', start: 10, end: 27, unit: 'unicode-scalar' })
})
it.each(['nothing matching', 'quote and quote'])('rejects missing/ambiguous exact text %#', async text => {
  await expect(verifyTextSelection({ ...source, physicalPage: 1, quote: 'quote' }, source, backend(text), () => {})).rejects.toThrow('missing or ambiguous')
})
it('rejects truncated or changed representation data and rechecks authorization after I/O', async () => {
  const proposal = { ...source, physicalPage: 1, quote: 'quote' }
  await expect(verifyTextSelection(proposal, source, backend('quote', value => { value.pageInfo.truncated = true; value.pageInfo.completeness = 'partial' }), () => {})).rejects.toThrow()
  await expect(verifyTextSelection(proposal, source, backend('quote', value => { value.items[0]!.locator.representationContentHash = 'b'.repeat(64) }), () => {})).rejects.toThrow('block')
  let checks = 0
  await expect(verifyTextSelection(proposal, source, backend('quote'), () => { if (++checks > 1) throw new Error('revoked') })).rejects.toThrow('revoked')
})
