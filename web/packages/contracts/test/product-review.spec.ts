import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productReviewIssues, type ProductReviewValue } from '../src/product-review-contracts.js'

type FixturePath = Array<string | number>
interface FixtureCase { name: string, base: string, set?: Array<{ path: FixturePath, value: unknown }>, remove?: FixturePath[], codes?: string[], authority?: string }
const directory = new URL('../../../contracts/fixtures/', import.meta.url)
const fixture = JSON.parse(readFileSync(new URL('product-review.json', directory), 'utf8')) as {
  imports: Record<string, string>, bases: Record<string, unknown>, valid: FixtureCase[], invalidShape: FixtureCase[], invalidSemantic: FixtureCase[], hostOnly: FixtureCase[]
}
const imported: Record<string, unknown> = Object.fromEntries(Object.entries(fixture.imports)
  .map(([name, path]) => [name, JSON.parse(readFileSync(new URL(path, directory), 'utf8'))]))
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand)
  if (value === null || typeof value !== 'object') return value
  if ('$fixture' in value) {
    const reference = value as { $fixture: string, path: FixturePath }
    if (Object.keys(value).sort().join(',') !== '$fixture,path' || !Object.hasOwn(imported, reference.$fixture)) throw new Error('Invalid fixture reference')
    let source: unknown = imported[reference.$fixture]
    for (const part of reference.path) {
      if (source === null || typeof source !== 'object' || !Object.hasOwn(source, part)) throw new Error('Invalid fixture reference path')
      source = Reflect.get(source, part)
    }
    return structuredClone(source)
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]))
}
function materialize(example: FixtureCase): ProductReviewValue {
  if (!Object.hasOwn(fixture.bases, example.base)) throw new Error(`Missing fixture base ${example.base}`)
  const value = expand(fixture.bases[example.base]) as ProductReviewValue
  const parent = (path: FixturePath): object => {
    let result: object = value
    for (const part of path.slice(0, -1)) {
      const child: unknown = Reflect.get(result, part)
      if (child === null || typeof child !== 'object') throw new Error(`Invalid fixture path ${path.join('.')}`)
      result = child
    }
    return result
  }
  for (const change of example.set ?? []) Reflect.set(parent(change.path), change.path.at(-1)!, expand(change.value))
  for (const path of example.remove ?? []) Reflect.deleteProperty(parent(path), path.at(-1)!)
  return value
}

describe('shared human product Review parser contracts (not host authorization)', () => {
  it.each(fixture.valid)('accepts $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-review', value)).toEqual(value)
    expect(productReviewIssues(value)).toEqual([])
    expect(parseBrowserContract('product-review', value)).toEqual(value)
    expect(value).toEqual(before)
  })
  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-review', value).ok).toBe(false)
    expect(() => parseContract('product-review', value)).toThrow()
    expect(() => parseBrowserContract('product-review', value)).toThrow()
  })
  it.each(fixture.invalidSemantic)('rejects semantic display inconsistency: $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-review', value)).toEqual(value)
    expect(productReviewIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-review', value)).toThrow('Inconsistent review response')
    expect(value).toEqual(before)
  })
  it.each(fixture.hostOnly)('does not mistake shape acceptance for host authority: $name', example => {
    const value = materialize(example)
    expect(example.authority?.length).toBeGreaterThan(0)
    expect(parseContract('product-review', value)).toEqual(value)
    expect(productReviewIssues(value)).toEqual([])
    expect(parseBrowserContract('product-review', value)).toEqual(value)
  })
  it('covers all six actions, four response/command kinds, Brief/Matrix and published Review pins', () => {
    const values = fixture.valid.map(materialize)
    expect([...new Set(values.map(value => value.kind))].sort()).toEqual(['review-command', 'review-focus', 'review-result', 'review-workspace'])
    expect([...new Set(values.flatMap(value => value.kind === 'review-command' ? [value.action] : []))].sort())
      .toEqual(['artifact-create', 'artifact-publish', 'claim-save', 'review-attest', 'review-decide', 'review-run'])
    const workspace = materialize({ name: 'canonical workspace', base: 'workspace' })
    if (workspace.kind !== 'review-workspace') throw new Error('Missing workspace base')
    expect(new Set(workspace.artifacts.map(item => item.kind))).toEqual(new Set(['brief', 'matrix']))
    for (const artifact of workspace.artifacts) if (artifact.publication) {
      const review = workspace.reviews.find(item => item.reviewResultId === artifact.publication!.reviewResultId)
      expect(review?.subject.objectIds).toContain(artifact.artifactManifestId)
      expect(review?.subject.contentHash).toBe(artifact.contentHash)
    }
    const names = [...fixture.valid, ...fixture.invalidShape, ...fixture.invalidSemantic, ...fixture.hostOnly].map(item => item.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
