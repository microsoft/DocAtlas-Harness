import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { UploadStart, UploadReceipt } from '@docatlas/contracts'
import { parsePendingUpload, uploadQuestionMatches } from '../src/live/upload-state'

const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document-http.json', import.meta.url), 'utf8')) as { valid: Array<UploadStart | UploadReceipt> }
const request = fixtures.valid.find((value): value is UploadStart => value.kind === 'upload-start')!
const receipt = { ...fixtures.valid.find((value): value is UploadReceipt => value.kind === 'upload')!, name: request.name, byteLength: request.byteLength, contentHash: request.contentHash }
const parse = (value: unknown) => parsePendingUpload(JSON.stringify(value), receipt.conversationId)

describe('upload retry intent', () => {
  it('preserves legacy notes without inventing permission to select a source', () => {
    expect(parse({ request, receipt })).toEqual({ request, receipt })
    expect(parse({ request, receipt: null })).toEqual({ request, receipt: null })
  })
  it('retains the explicit upload-and-ask choice across a user-requested retry', () => {
    const attachToQuestion = { bindingId: 'binding:original', generation: 2 }, value = parse({ request, receipt, attachToQuestion })
    expect(value.attachToQuestion).toEqual(attachToQuestion)
    expect(uploadQuestionMatches(value, attachToQuestion)).toBe(true)
    expect(uploadQuestionMatches(value, { ...attachToQuestion, generation: 3 })).toBe(false)
    expect(uploadQuestionMatches(value, { ...attachToQuestion, bindingId: 'binding:other' })).toBe(false)
    expect(uploadQuestionMatches(value, undefined)).toBe(false)
    expect(uploadQuestionMatches({ request, receipt }, attachToQuestion)).toBe(false)
  })
  it.each(['conversationId', 'contentHash', 'name', 'byteLength'] as const)('rejects a receipt with different %s', field => {
    expect(() => parse({ request, receipt: { ...receipt, [field]: field === 'byteLength' ? receipt.byteLength + 1 : field === 'contentHash' ? 'f'.repeat(64) : 'different' } })).toThrow()
  })
  it('rejects malformed, oversized and unknown intent fields', () => {
    for (const value of [null, [], {}, { request }, { request, receipt, sourceRefs: [] }]) expect(() => parse(value)).toThrow()
    for (const target of [null, true, 'yes', {}, [], { bindingId: 'binding:one', generation: 0 }, { bindingId: 'binding:one', generation: 1, actorId: 'invented' }]) expect(() => parse({ request, receipt, attachToQuestion: target })).toThrow()
    expect(() => parsePendingUpload('x'.repeat(8193), receipt.conversationId)).toThrow()
  })
})
