import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productContinuityIssues, type ProductContinuityValue } from '../src/product-continuity-contracts.js'

type Path = Array<string | number>
interface Case { name: string, base: string, set?: Array<{ path: Path, value: unknown }>, remove?: Path[], codes?: string[], authority?: string }
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-continuity.json', import.meta.url), 'utf8')) as {
  bases: Record<string, ProductContinuityValue>, valid: Case[], invalidShape: Case[], invalidSemantic: Case[], hostOnly: Case[],
}
function materialize(example: Case): ProductContinuityValue {
  const value = structuredClone(fixture.bases[example.base]!)
  const parent = (path: Path): object => { let item: object = value; for (const part of path.slice(0, -1)) item = Reflect.get(item, part) as object; return item }
  for (const change of example.set ?? []) Reflect.set(parent(change.path), change.path.at(-1)!, structuredClone(change.value))
  for (const path of example.remove ?? []) Reflect.deleteProperty(parent(path), path.at(-1)!)
  return value
}
describe('product-continuity Node/static-browser shared vectors', () => {
  it.each(fixture.valid)('accepts $name without mutation', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-continuity', value)).toEqual(value)
    expect(productContinuityIssues(value)).toEqual([])
    expect(parseBrowserContract('product-continuity', value)).toEqual(value)
    expect(value).toEqual(before)
  })
  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-continuity', value).ok).toBe(false)
    expect(() => parseContract('product-continuity', value)).toThrow()
    expect(() => parseBrowserContract('product-continuity', value)).toThrow()
  })
  it.each(fixture.invalidSemantic)('rejects semantic mismatch: $name', example => {
    const value = materialize(example)
    expect(parseContract('product-continuity', value)).toEqual(value)
    expect(productContinuityIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-continuity', value)).toThrow('Inconsistent continuity response')
  })
  it.each(fixture.hostOnly)('does not mistake shape for authority: $name', example => {
    const value = materialize(example)
    expect(example.authority).toBeTruthy()
    expect(parseContract('product-continuity', value)).toEqual(value)
    expect(parseBrowserContract('product-continuity', value)).toEqual(value)
  })
  it('covers all three explicit operations and their fenced responses', () => {
    expect(new Set(fixture.valid.map(item => materialize(item).kind))).toEqual(new Set(['continuity-inspect', 'continuity-impact', 'continuity-assess', 'continuity-inspection', 'continuity-impact-result', 'continuity-assessment']))
  })
})
