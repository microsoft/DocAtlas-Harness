import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productPersonalizationIssues, type ProductPersonalizationValue } from '../src/product-personalization-contracts.js'
import type { ProductPersonalizationV2Value } from '../src/product-personalization-v2-contracts.js'

type Path = Array<string | number>
interface Case { name: string, base: string, set?: Array<{ path: Path, value: unknown }>, remove?: Path[], codes?: string[] }
const directory = new URL('../../../contracts/fixtures/', import.meta.url)
const source = JSON.parse(readFileSync(new URL('product-personalization.json', directory), 'utf8')) as { bases: Record<string, ProductPersonalizationValue>, valid: Case[], invalidSemantic: Case[] }
const fixture = JSON.parse(readFileSync(new URL('product-personalization-v2.json', directory), 'utf8')) as { valid: Case[], invalidShape: Case[], invalidSemantic: Case[] }
function materialize(example: Case): ProductPersonalizationV2Value {
  const base = source.bases[example.base]!
  const value = { ...structuredClone(base), schemaVersion: 2, ...(base.kind === 'preference-inspection' ? { profileEpoch: 0, modelApplication: 'host-ephemeral', useSemantics: 'observed-answer-generation' } : {}),
    ...(base.kind === 'preference-command' ? { expectedProfileEpoch: 0 } : {}) } as ProductPersonalizationV2Value
  const parent = (path: Path): object => {
    let result: object = value
    for (const key of path.slice(0, -1)) result = Reflect.get(result, key) as object
    return result
  }
  for (const change of example.set ?? []) Reflect.set(parent(change.path), change.path.at(-1)!, structuredClone(change.value))
  for (const path of example.remove ?? []) Reflect.deleteProperty(parent(path), path.at(-1)!)
  return value
}

describe('versioned host-ephemeral personalization wire', () => {
  it.each([...fixture.valid, ...source.valid])('accepts $name with unchanged action and inner-record semantics', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-personalization-v2', value)).toEqual(value)
    expect(parseBrowserContract('product-personalization-v2', value)).toEqual(value)
    expect(productPersonalizationIssues(value)).toEqual([])
    expect(value).toEqual(before)
    expect(() => parseBrowserContract('product-personalization', value)).toThrow()
  })
  it.each(fixture.invalidShape)('rejects $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-personalization-v2', value).ok).toBe(false)
    expect(() => parseBrowserContract('product-personalization-v2', value)).toThrow()
  })
  it.each([...fixture.invalidSemantic, ...source.invalidSemantic])('preserves cross-field rejection: $name', example => {
    const value = materialize(example)
    expect(parseContract('product-personalization-v2', value)).toEqual(value)
    expect(productPersonalizationIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-personalization-v2', value)).toThrow('Inconsistent personalization response')
  })
  it('leaves v1 disconnected-only and unable to imply v2 use semantics', () => {
    const original = source.bases.inspection!
    expect(parseBrowserContract('product-personalization', original)).toEqual(original)
    for (const change of [{ modelApplication: 'host-ephemeral' }, { useSemantics: 'observed-answer-generation' }]) {
      expect(() => parseContract('product-personalization', { ...original, ...change })).toThrow()
    }
  })
})
