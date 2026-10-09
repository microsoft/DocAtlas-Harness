import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productPersonalizationIssues, type ProductPersonalizationValue } from '../src/product-personalization-contracts.js'

type FixturePath = Array<string | number>
interface FixtureCase { name: string, base: string, set?: Array<{ path: FixturePath, value: unknown }>, remove?: FixturePath[], codes?: string[] }
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-personalization.json', import.meta.url), 'utf8')) as {
  bases: Record<string, ProductPersonalizationValue>, valid: FixtureCase[], invalidShape: FixtureCase[], invalidSemantic: FixtureCase[]
}
function materialize(example: FixtureCase): ProductPersonalizationValue {
  const base = fixture.bases[example.base]
  if (!base) throw new Error(`Missing fixture base ${example.base}`)
  const value = structuredClone(base)
  const parent = (path: FixturePath): object => {
    let result: object = value
    for (const part of path.slice(0, -1)) {
      const child: unknown = Reflect.get(result, part)
      if (child === null || typeof child !== 'object') throw new Error(`Invalid fixture path ${path.join('.')}`)
      result = child
    }
    return result
  }
  for (const change of example.set ?? []) Reflect.set(parent(change.path), change.path.at(-1)!, structuredClone(change.value))
  for (const path of example.remove ?? []) Reflect.deleteProperty(parent(path), path.at(-1)!)
  return value
}

describe('shared product personalization contracts', () => {
  it.each(fixture.valid)('accepts $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-personalization', value)).toEqual(value)
    expect(productPersonalizationIssues(value)).toEqual([])
    expect(parseBrowserContract('product-personalization', value)).toEqual(value)
    expect(value).toEqual(before)
  })
  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-personalization', value).ok).toBe(false)
    expect(() => parseContract('product-personalization', value)).toThrow()
    expect(() => parseBrowserContract('product-personalization', value)).toThrow()
  })
  it.each(fixture.invalidSemantic)('rejects semantics: $name', example => {
    const value = materialize(example)
    // Wire shape alone does not grant authority or validate application relationships.
    expect(parseContract('product-personalization', value)).toEqual(value)
    expect(productPersonalizationIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-personalization', value)).toThrow('Inconsistent personalization response')
  })
  it('covers every registered kind without treating schema acceptance as operation authority', () => {
    expect([...new Set(fixture.valid.map(example => materialize(example).kind))].sort()).toEqual(["preference-command","preference-inspection","preference-result"])
  })
})
