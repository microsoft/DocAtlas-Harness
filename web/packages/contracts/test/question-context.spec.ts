import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseContract, validateContractShape } from '../src/node.js'
import { parseBrowserContract } from '../src/browser.js'
import { questionContextIssues, type QuestionContext, type QuestionSelectionFocus } from '../src/question-context-contracts.js'
import { enrichmentIssues, type EnrichmentTree, type TreeSummaryPreview } from '../src/enrichment-contracts.js'

const binding = JSON.parse(readFileSync('contracts/fixtures/product/control.json', 'utf8')).valid[0]
const original = { documentId: 'doc:one', revisionId: 'rev:one', name: 'Original.pdf', contentHash: 'b'.repeat(64), byteLength: 200, pageCount: 6 }
const context: QuestionContext = { schemaVersion: 1, kind: 'question-context', binding, target: { kind: 'message', id: 'entry:user' }, status: 'available', reason: null,
  requestHash: 'a'.repeat(64), nativeTextHash: 'c'.repeat(64), selectionState: 'consumed', passages: [{ selectionContextId: 'selection:one', locatorId: 'loc:one', physicalPage: 2, text: 'Exact selected passage.', original }] }
const focus: QuestionSelectionFocus = { schemaVersion: 1, kind: 'question-selection-focus', binding, target: context.target, selectionContextId: 'selection:one', locatorId: 'loc:one',
  status: 'resolved', physicalPage: 2, exactText: context.passages[0]!.text, original,
  locator: { schemaVersion: 1, locatorId: 'loc:one', documentId: original.documentId, revisionId: original.revisionId, representationId: 'rep:text', representationContentHash: 'd'.repeat(64), physicalPage: 2,
    selectors: [{ type: 'text-quote', exact: context.passages[0]!.text, normalizedHash: createHash('sha256').update(context.passages[0]!.text).digest('hex') }], createdAt: '2026-09-11T00:00:00Z' } }
describe('read-only question source context', () => {
  it('shares the same fixed wire vectors with Python without giving Python history authority', () => {
    const fixture = JSON.parse(readFileSync('contracts/fixtures/question-context.json', 'utf8')) as { base: Record<string, unknown>, valid: Array<{ set: Record<string, unknown>, remove?: string[] }>, invalid: Array<{ set: Record<string, unknown>, remove?: string[] }> }
    for (const [valid, examples] of [[true, fixture.valid], [false, fixture.invalid]] as const) for (const example of examples) {
      const value = { ...structuredClone(fixture.base), ...structuredClone(example.set) }
      for (const key of example.remove ?? []) delete value[key]
      expect(validateContractShape('question-context', value).ok).toBe(valid)
      if (valid) expect(parseBrowserContract('question-context', value)).toEqual(value)
      else expect(() => parseBrowserContract('question-context', value)).toThrow()
    }
  })
  it('accepts exact message input, live submission input, unavailable context and original focus in Node and browser', () => {
    const values = [context, { ...context, target: { kind: 'submission' as const, id: 'submission:one' }, selectionState: 'attached' as const, nativeTextHash: null },
      { ...context, status: 'none' as const, requestHash: null, selectionState: null, passages: [] },
      ...(['history', 'source', 'purged'] as const).map(reason => ({ ...context, status: 'unavailable' as const, reason, requestHash: null, selectionState: null, passages: [] })),
      focus, { ...focus, status: 'page-only' as const, exactText: null }]
    for (const value of values) { expect(parseContract('question-context', value)).toEqual(value); expect(questionContextIssues(value)).toEqual([]); expect(parseBrowserContract('question-context', value)).toEqual(value) }
  })
  it.each([
    (value: QuestionContext) => { value.passages = [] },
    (value: QuestionContext) => { value.requestHash = null },
    (value: QuestionContext) => { value.nativeTextHash = null },
    (value: QuestionContext) => { value.selectionState = null },
    (value: QuestionContext) => { value.passages.push(structuredClone(value.passages[0]!)) },
    (value: QuestionContext) => { value.passages[0]!.physicalPage = 7 },
    (value: QuestionContext) => { value.status = 'unavailable'; value.reason = 'purged' },
    (value: QuestionContext) => { value.passages[0]!.text = '   ' },
    (value: QuestionContext) => { value.passages = Array.from({ length: 3 }, (_, i) => ({ ...value.passages[0]!, locatorId: `loc:${i}`, text: '中'.repeat(3000) })) },
  ])('rejects inconsistent or oversized source groups', change => {
    const value = structuredClone(context); change(value)
    expect(questionContextIssues(value).length).toBeGreaterThan(0)
    expect(() => parseBrowserContract('question-context', value)).toThrow()
  })
  it('rejects arbitrary wire metadata, paths, malformed identities and source substitutions', () => {
    for (const value of [{ ...context, actorId: 'attacker' }, { ...context, filePath: '/private/file.pdf' }, { ...context, target: { kind: 'message', id: '../../file' } },
      { ...context, passages: [{ ...context.passages[0], text: 'x'.repeat(4001) }] }]) expect(validateContractShape('question-context', value).ok).toBe(false)
    for (const value of [{ ...focus, locatorId: 'loc:foreign' }, { ...focus, original: { ...original, revisionId: 'rev:foreign' } }, { ...focus, status: 'page-only' as const }]) {
      expect(questionContextIssues(value).length).toBeGreaterThan(0); expect(() => parseBrowserContract('question-context', value)).toThrow()
    }
  })
})
describe('navigation summaries do not alter canonical tree shape or hashes', () => {
  const tree: EnrichmentTree = JSON.parse(readFileSync('contracts/fixtures/document/enrichment.json', 'utf8')).bases.tree
  const preview: TreeSummaryPreview = { nodeId: tree.tree.nodes[0]!.nodeId, jobId: 'job:summary', resultHash: 'a'.repeat(64), preview: '章节阅读摘要', summaryKind: 'model', truncated: false }
  it('accepts an optional, page-local overlay while preserving old responses', () => {
    expect(parseBrowserContract('enrichment', tree)).toEqual(tree)
    const value = { ...tree, summaryPreviews: [preview] }
    expect(parseBrowserContract('enrichment', value)).toEqual(value); expect(enrichmentIssues(value)).toEqual([])
    expect(value.tree).toBe(tree.tree); expect(value.generation).toBe(tree.generation)
  })
  it('rejects foreign/duplicate nodes, oversized previews and invalid result hashes', () => {
    for (const previews of [[preview, preview], [{ ...preview, nodeId: 'node:foreign' }], [{ ...preview, preview: ' ' }], [{ ...preview, preview: '中'.repeat(241) }], [{ ...preview, resultHash: 'fake' }]]) {
      expect(() => parseBrowserContract('enrichment', { ...tree, summaryPreviews: previews })).toThrow()
    }
  })
})
