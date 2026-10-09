import { createHash } from 'node:crypto'
import { documentLocatorIssues, readResultIssues, pageInfoIssues, resolveResultIssues, type DocumentLocator, type ProductSelectionProposal, type ScopedSourceIdentity, type SidecarMethodMap, type VerifiedSelectionItem } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { DocumentAccessError } from './session.js'

export interface SelectionResolverPort { call<K extends 'read' | 'resolve'>(method: K, request: SidecarMethodMap[K]['params'], signal?: AbortSignal): Promise<SidecarMethodMap[K]['result']> }
function fail(message: string): never { throw new DocumentAccessError('invalid-request', message) }
const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim()
/** Only whitespace differences are tolerated; no fuzzy match or automatic cross-page re-anchoring. */
export async function verifyTextSelection(proposal: ProductSelectionProposal, source: ScopedSourceIdentity, port: SelectionResolverPort, assertCurrent: () => void, signal?: AbortSignal): Promise<VerifiedSelectionItem> {
  const check = () => { signal?.throwIfAborted(); assertCurrent() }; check()
  if (proposal.documentId !== source.documentId || proposal.revisionId !== source.revisionId || !Number.isSafeInteger(proposal.physicalPage) || proposal.physicalPage < 1 || [...proposal.quote].length > 2000) fail('Invalid selection source or range')
  const identity = { documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId }
  const points: Array<{ scalar: number, char: string }> = [], cursors = new Set<string>(), blocks = new Set<string>()
  let cursor: string | undefined, last = -1
  do {
    const request = { schemaVersion: 1 as const, requestType: 'read' as const, source: identity, mode: 'page' as const, physicalPage: proposal.physicalPage, limits: { maxItems: 200, maxChars: 20000 }, ...(cursor ? { cursor } : {}) }
    const result = await port.call('read', request, signal); check(); parseContract('sidecar-document-rpc', result)
    if (result.mode !== 'page' || result.resultType !== 'read' || readResultIssues(result).length || pageInfoIssues(result.pageInfo).length
      || result.items.length > 200 || result.items.reduce((sum, item) => sum + (item.itemType === 'block' ? [...item.text].length : 0), 0) > 20000
      || Object.entries(identity).some(([key, value]) => Reflect.get(result.source, key) !== value)) fail('Selection page identity mismatch')
    for (const block of result.items) {
      if (block.itemType !== 'block' || blocks.has(block.blockId) || block.physicalPage !== proposal.physicalPage || block.locator.physicalPage !== proposal.physicalPage
        || block.locator.representationContentHash !== source.representationContentHash || Object.entries(identity).some(([key, value]) => Reflect.get(block.locator, key) !== value)) fail('Invalid selection page block')
      const position = block.locator.selectors.find(selector => selector.type === 'text-position')
      if (position?.type !== 'text-position' || position.unit !== 'unicode-scalar' || position.end - position.start !== [...block.text].length || position.start < last) fail('Selection page position is incomplete')
      if (points.length && position.start > last) points.push({ scalar: last, char: ' ' })
      let scalar = position.start
      for (const char of block.text) points.push({ scalar: scalar++, char })
      last = position.end; blocks.add(block.blockId)
    }
    if (points.length > 200000 || blocks.size > 2000) fail('Selection page exceeds verification budget')
    cursor = result.pageInfo.nextCursor
    if (result.pageInfo.truncated && !cursor) fail('Selection page is truncated')
    if (cursor) { if (cursors.has(cursor) || cursors.size >= 10) fail('Selection pagination is incomplete'); cursors.add(cursor) }
  } while (cursor)
  const text: string[] = [], positions: number[] = []
  for (const point of points) {
    if (/\s/u.test(point.char)) { if (text.length && text.at(-1) !== ' ') { text.push(' '); positions.push(point.scalar) } }
    else { for (const unit of point.char.split('')) { text.push(unit); positions.push(point.scalar) } }
  }
  const canonical = text.join(''), needle = normalized(proposal.quote), start = canonical.indexOf(needle)
  if (!needle || start < 0 || canonical.indexOf(needle, start + 1) >= 0) fail('Selection is missing or ambiguous on the original page')
  const from = positions[start]!, to = positions[start + needle.length - 1]! + 1
  const locator: DocumentLocator = { schemaVersion: 1, locatorId: `loc:selection:${createHash('sha256').update(JSON.stringify([source, proposal.physicalPage, from, to])).digest('hex').slice(0, 32)}`,
    ...identity, representationContentHash: source.representationContentHash, physicalPage: proposal.physicalPage,
    selectors: [{ type: 'text-position', start: from, end: to, unit: 'unicode-scalar' }], createdAt: new Date().toISOString() }
  const request = { schemaVersion: 1 as const, requestType: 'resolve' as const, locator, allowCandidates: false, maxCandidates: 1 }
  const result = await port.call('resolve', request, signal); check(); parseContract('sidecar-document-rpc', result)
  const resolved = result.resolvedLocator
  if (resolveResultIssues(result, request).length || result.status !== 'resolved' || !resolved || result.checkedRepresentationHash !== source.representationContentHash
    || normalized(result.exactText ?? '') !== needle || [...(result.exactText ?? '')].length > 4000 || resolved.physicalPage !== proposal.physicalPage
    || Object.entries(identity).some(([key, value]) => Reflect.get(resolved!, key) !== value) || resolved.representationContentHash !== source.representationContentHash || documentLocatorIssues(resolved).length
    || !resolved.selectors.some(selector => selector.type === 'text-position' && selector.start === from && selector.end === to)
    || !resolved.selectors.some(selector => selector.type === 'text-quote' && selector.exact === result.exactText && selector.normalizedHash === createHash('sha256').update(result.exactText!).digest('hex'))) fail('Selection could not be verified against the same source positions')
  return { locator: resolved!, text: result.exactText! }
}
