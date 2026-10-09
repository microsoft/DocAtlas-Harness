import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseContract, validateContractShape } from '../src/node.js'
import { productControlIssues, type ProductControlValue, type ProductRunState } from '../src/product-control-contracts.js'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product/control.json', import.meta.url), 'utf8')) as {
  valid: ProductControlValue[]
  invalidShape: Array<{ name: string, value: unknown }>
  invalidSemantic: Array<{ name: string, value: ProductControlValue, codes: string[] }>
  transitions: Record<ProductRunState, ProductRunState[]>
}
describe('product control wire v1', () => {
  it.each(fixture.valid)('accepts canonical $kind', value => {
    expect(parseContract('product-control', value)).toEqual(value)
    expect(productControlIssues(value)).toEqual([])
  })
  it.each(fixture.invalidShape)('rejects $name', ({ value }) => {
    expect(validateContractShape('product-control', value).ok).toBe(false)
  })
  it.each(fixture.invalidSemantic)('detects $name', ({ value, codes }) => {
    expect(validateContractShape('product-control', value).ok).toBe(true)
    expect(productControlIssues(value)).toEqual(codes)
  })
  it('uses the canonical transition graph, with no terminal/unknown blind replay', () => {
    const states = ['accepted', 'preparing', 'ready', 'dispatching', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'outcome-unknown'] as const
    for (const from of states) for (const to of states) {
      expect(validateContractShape('product-control', { schemaVersion: 1, kind: 'run-transition', from, to }).ok, `${from} -> ${to}`)
        .toBe(fixture.transitions[from]?.includes(to) ?? false)
    }
  })
})
