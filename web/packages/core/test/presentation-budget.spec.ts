import { expect, it } from 'vitest'
import { fitsDocumentPresentation } from '../src/document/presentation-budget.js'

it('uses the same UTF-16 and UTF-8 envelope caps for pagination and native presentation', () => {
  expect(fitsDocumentPresentation('x'.repeat(30000))).toBe(true)
  expect(fitsDocumentPresentation('x'.repeat(30001))).toBe(false)
  expect(fitsDocumentPresentation('界'.repeat(21845))).toBe(true)
  expect(fitsDocumentPresentation('界'.repeat(21846))).toBe(false)
  expect(fitsDocumentPresentation('😀'.repeat(15000))).toBe(true)
  expect(fitsDocumentPresentation('😀'.repeat(15001))).toBe(false)
})
