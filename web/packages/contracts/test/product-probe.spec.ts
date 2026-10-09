import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productProbeIssues, type ProductProbeValue } from '../src/product-probe-contracts.js'

type Path = Array<string | number>
interface Case { name: string, base: string, set?: Array<{ path: Path, value: unknown }>, remove?: Path[], codes?: string[], authority?: string }
const directory = new URL('../../../contracts/fixtures/', import.meta.url)
const fixture = JSON.parse(readFileSync(new URL('product-probe.json', directory), 'utf8')) as {
  imports: Record<string, string>, bases: Record<string, unknown>, valid: Case[], invalidShape: Case[], invalidSemantic: Case[], hostOnly: Case[]
}
const imported: Record<string, unknown> = Object.fromEntries(Object.entries(fixture.imports).map(([name, path]) => [name, JSON.parse(readFileSync(new URL(path, directory), 'utf8'))]))
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand)
  if (value === null || typeof value !== 'object') return value
  if ('$fixture' in value) {
    const reference = value as { $fixture: string, path: Path }
    if (Object.keys(value).sort().join(',') !== '$fixture,path' || !Object.hasOwn(imported, reference.$fixture)) throw new Error('Invalid fixture reference')
    let source: unknown = imported[reference.$fixture]
    for (const part of reference.path) {
      if (source === null || typeof source !== 'object' || !Object.hasOwn(source, part)) throw new Error('Invalid fixture path')
      source = Reflect.get(source, part)
    }
    return structuredClone(source)
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]))
}
function materialize(example: Case): ProductProbeValue {
  if (!Object.hasOwn(fixture.bases, example.base)) throw new Error('Missing fixture base')
  const value = expand(fixture.bases[example.base]) as ProductProbeValue
  const parent = (path: Path): object => {
    let current: object = value
    for (const part of path.slice(0, -1)) current = Reflect.get(current, part) as object
    return current
  }
  for (const change of example.set ?? []) Reflect.set(parent(change.path), change.path.at(-1)!, expand(change.value))
  for (const path of example.remove ?? []) Reflect.deleteProperty(parent(path), path.at(-1)!)
  return value
}

describe('shared controlled presentation wire (not host publication, retention or choice authority)', () => {
  it.each(fixture.valid)('accepts $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-probe', value)).toEqual(value)
    expect(productProbeIssues(value)).toEqual([])
    expect(parseBrowserContract('product-probe', value)).toEqual(value)
    expect(value).toEqual(before)
  })
  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-probe', value).ok).toBe(false)
    expect(() => parseContract('product-probe', value)).toThrow()
    expect(() => parseBrowserContract('product-probe', value)).toThrow()
  })
  it.each(fixture.invalidSemantic)('rejects inconsistent display: $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-probe', value)).toEqual(value)
    expect(productProbeIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-probe', value)).toThrow('Inconsistent controlled presentation response')
    expect(value).toEqual(before)
  })
  it.each(fixture.hostOnly)('does not confuse parser acceptance with authority: $name', example => {
    const value = materialize(example)
    expect(example.authority?.length).toBeGreaterThan(0)
    expect(parseContract('product-probe', value)).toEqual(value)
    expect(productProbeIssues(value)).toEqual([])
    expect(parseBrowserContract('product-probe', value)).toEqual(value)
  })
  it('covers all request and response kinds and keeps actual empty Claim references', () => {
    const values = fixture.valid.map(materialize)
    expect([...new Set(values.map(value => value.kind))].sort()).toEqual(['probe-choice-result', 'probe-choose', 'probe-inspect', 'probe-prepare', 'probe-review', 'probe-review-result', 'probe-view'])
    const ready = materialize({ name: 'ready', base: 'ready' })
    if (ready.kind !== 'probe-view') throw new Error('Missing ready view')
    expect(ready.probe!.backbone.claimVersionIds).toEqual([])
    expect(ready.probe!.backbone.evidenceAtomIds).toEqual(['evidence:revenue-growth'])
    const names = [...fixture.valid, ...fixture.invalidShape, ...fixture.invalidSemantic, ...fixture.hostOnly].map(example => example.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
