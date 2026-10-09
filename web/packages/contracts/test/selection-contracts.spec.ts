import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  type SelectionContext,
  formatSelectionMarker,
  parseSelectionMarkers,
  selectionContextIssues,
  type SelectionRpcRequest,
  type SelectionRpcResult,
  selectionRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'

interface SelectionFixture {
  context: SelectionContext
  stageRequest: SelectionRpcRequest
  stageResult: SelectionRpcResult
  prepareRequest: SelectionRpcRequest
  prepareResult: SelectionRpcResult
  statusRequest: SelectionRpcRequest
  statusResult: SelectionRpcResult
  cancelRequest: SelectionRpcRequest
  cancelResult: SelectionRpcResult
  actionRequest: SelectionRpcRequest
  actionResult: SelectionRpcResult
}

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/selection.json', import.meta.url),
  'utf8',
)) as SelectionFixture

describe('M2 selection contracts', () => {
  it('accepts the shared stable context and complete browser RPC lifecycle', () => {
    expect(validateContractShape('selection-context', fixture.context).ok).toBe(true)
    expect(selectionContextIssues(fixture.context)).toEqual([])
    for (const value of [
      fixture.stageRequest,
      fixture.stageResult,
      fixture.prepareRequest,
      fixture.prepareResult,
      fixture.statusRequest,
      fixture.statusResult,
      fixture.cancelRequest,
      fixture.cancelResult,
      fixture.actionRequest,
      fixture.actionResult,
    ]) {
      expect(validateContractShape('selection-rpc', value).ok).toBe(true)
      expect(selectionRpcIssues(value)).toEqual([])
    }
  })

  it('rejects transient nonce/path fields in durable context and malformed nonces', () => {
    expect(validateContractShape('selection-context', {
      ...fixture.context,
      nonce: fixture.stageResult.resultType === 'selection-staged' ? fixture.stageResult.nonce : '',
    }).ok).toBe(false)
    expect(validateContractShape('selection-rpc', {
      ...fixture.cancelRequest,
      nonce: 'seln_too-short',
    }).ok).toBe(false)
    expect(validateContractShape('selection-rpc', {
      ...fixture.stageRequest,
      path: '/etc/passwd',
    }).ok).toBe(false)
  })

  it('formats and strips only exact stable selection markers', () => {
    const marker = formatSelectionMarker('selection-context:tilde~1')
    expect(marker).toBe('[[docatlas.selection.v1:selection-context:tilde~1]]')
    expect(parseSelectionMarkers(`Before ${marker} after`)).toEqual({
      ids: ['selection-context:tilde~1'],
      text: 'Before  after',
      malformed: false,
    })
    expect(parseSelectionMarkers('[[docatlas.selection.v1:not closed')).toMatchObject({
      ids: [],
      malformed: true,
    })
  })

  it('detects cross-field identity, completeness, range, and preview violations', () => {
    const context = structuredClone(fixture.context)
    context.selections[0]!.locators[0]!.documentId = 'doc:other'
    context.selections[0]!.content.truncated = true
    expect(selectionContextIssues(context).map(issue => issue.code)).toEqual([
      'selection-locator-mismatch',
      'selection-content-completeness',
    ])

    if (fixture.stageRequest.requestType !== 'selection-stage') throw new Error('wrong fixture')
    const request = structuredClone(fixture.stageRequest)
    request.selections[0]!.ranges.push(structuredClone(request.selections[0]!.ranges[0]!))
    expect(validateContractShape('selection-rpc', request).ok).toBe(true)
    expect(selectionRpcIssues(request).map(issue => issue.code)).toEqual([
      'selection-range-cardinality',
    ])

    if (fixture.statusResult.resultType !== 'selection-status') throw new Error('wrong fixture')
    const status = structuredClone(fixture.statusResult)
    status.previews![0]!.physicalPageStart = 3
    expect(selectionRpcIssues(status).map(issue => issue.code)).toEqual([
      'selection-preview-page-order',
    ])
    if (fixture.actionResult.resultType !== 'selection-action-recorded') throw new Error('wrong fixture')
    const action = structuredClone(fixture.actionResult)
    action.action = 'propose-claim'
    action.evidence[0]!.documentId = 'doc:other'
    expect(selectionRpcIssues(action).map(issue => issue.code)).toEqual([
      'selection-action-record-mismatch',
      'selection-action-evidence-identity',
    ])
  })

  it('keeps every mutating selection action explicit and typed', () => {
    if (fixture.actionRequest.requestType !== 'selection-action') throw new Error('wrong fixture')
    const common = fixture.actionRequest
    for (const action of [
      common,
      { ...common, action: 'create-note', noteKind: 'commentary', body: 'User comment' },
      { ...common, action: 'open-question', question: 'What changed?' },
      { ...common, action: 'propose-claim', statement: 'Revenue increased.', relation: 'support' },
    ]) {
      expect(validateContractShape('selection-rpc', action).ok).toBe(true)
    }
    expect(validateContractShape('selection-rpc', {
      ...common,
      action: 'propose-claim',
      statement: 'Revenue increased.',
    }).ok).toBe(false)
  })
})
