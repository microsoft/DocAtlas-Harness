import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productResearchIssues, type ProductResearchValue } from '../src/product-research-contracts.js'

type FixturePath = Array<string | number>
interface FixtureCase { name: string, base: string, set?: Array<{ path: FixturePath, value: unknown }>, remove?: FixturePath[], codes?: string[] }
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-research.json', import.meta.url), 'utf8')) as {
  bases: Record<string, ProductResearchValue>, valid: FixtureCase[], invalidShape: FixtureCase[], invalidSemantic: FixtureCase[]
}
function materialize(example: FixtureCase): ProductResearchValue {
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

describe('shared product research contracts', () => {
  it.each(fixture.valid)('accepts $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-research', value)).toEqual(value)
    expect(productResearchIssues(value)).toEqual([])
    expect(parseBrowserContract('product-research', value)).toEqual(value)
    expect(value).toEqual(before)
  })
  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-research', value).ok).toBe(false)
    expect(() => parseContract('product-research', value)).toThrow()
    expect(() => parseBrowserContract('product-research', value)).toThrow()
  })
  it.each(fixture.invalidSemantic)('rejects semantics: $name', example => {
    const value = materialize(example)
    // Wire shape alone does not grant authority or validate application relationships.
    expect(parseContract('product-research', value)).toEqual(value)
    expect(productResearchIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-research', value)).toThrow('Inconsistent research response')
  })
  it('covers every registered kind without treating schema acceptance as operation authority', () => {
    expect([...new Set(fixture.valid.map(example => materialize(example).kind))].sort()).toEqual(["note-save","note-saved","notebook-entry","notebook-mutate","notebook-query","notebook-response","notebook-updated","research-call-provenance","research-focus","research-policy-set","research-session-policy"])
  })
})
