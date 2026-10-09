import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productLibraryIssues, type ProductLibraryValue } from '../src/product-library-contracts.js'

type Path = Array<string | number>
interface Case { name: string, base: string, set?: Array<{ path: Path, value: unknown }>, remove?: Path[], codes?: string[], authority?: string }
const directory = new URL('../../../contracts/fixtures/', import.meta.url)
const fixture = JSON.parse(readFileSync(new URL('product-library.json', directory), 'utf8')) as {
  imports: Record<string, string>, bases: Record<string, unknown>, valid: Case[], invalidShape: Case[], invalidSemantic: Case[], hostOnly: Case[]
}
const imported = Object.fromEntries(Object.entries(fixture.imports).map(([name, path]) => [name, JSON.parse(readFileSync(new URL(path, directory), 'utf8')) as unknown]))
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand)
  if (!value || typeof value !== 'object') return value
  if ('$fixture' in value) {
    const ref = value as { $fixture: string, path: Path }
    let current: unknown = imported[ref.$fixture]
    for (const part of ref.path) {
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) throw new Error('Invalid shared fixture reference')
      current = Reflect.get(current, part)
    }
    return structuredClone(current)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]))
}
function materialize(example: Case): ProductLibraryValue {
  const value = expand(fixture.bases[example.base]) as ProductLibraryValue
  const parent = (path: Path): object => {
    let result: object = value
    for (const part of path.slice(0, -1)) result = Reflect.get(result, part) as object
    return result
  }
  for (const change of example.set ?? []) Reflect.set(parent(change.path), change.path.at(-1)!, expand(change.value))
  for (const path of example.remove ?? []) Reflect.deleteProperty(parent(path), path.at(-1)!)
  return value
}
describe('shared Library revision contracts', () => {
  it.each(fixture.valid)('accepts $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-library', value)).toEqual(value)
    expect(productLibraryIssues(value)).toEqual([])
    expect(parseBrowserContract('product-library', value)).toEqual(value)
    expect(value).toEqual(before)
  })
  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-library', value).ok).toBe(false)
    expect(() => parseContract('product-library', value)).toThrow()
    expect(() => parseBrowserContract('product-library', value)).toThrow()
  })
  it.each(fixture.invalidSemantic)('rejects display inconsistency: $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-library', value)).toEqual(value)
    expect(productLibraryIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-library', value)).toThrow('Inconsistent revision response')
    expect(value).toEqual(before)
  })
  it.each(fixture.hostOnly)('does not infer authority from $name', example => {
    const value = materialize(example)
    expect(example.authority).toBeTruthy()
    expect(parseContract('product-library', value)).toEqual(value)
    expect(productLibraryIssues(value)).toEqual([])
    expect(parseBrowserContract('product-library', value)).toEqual(value)
  })
  it('preserves the legacy Library request while adding an explicit validated revision target', () => {
    const request = { schemaVersion: 1, requestType: 'library-import', sessionId: 'session:one', workspaceId: 'workspace:library', candidateId: 'candidate:one', sourceRole: 'primary', idempotencyKey: 'library:original:key' }
    expect(parseContract('library-rpc', request)).toEqual(request)
    const target = { documentId: 'doc:library:report', expectedCurrentRevisionId: 'rev:library:report:1' }
    expect(parseContract('library-rpc', { ...request, revisionTarget: target })).toMatchObject({ revisionTarget: target })
    for (const revisionTarget of [{ documentId: target.documentId }, { ...target, path: '/private.pdf' }, { ...target, expectedCurrentRevisionId: 1 }]) {
      expect(() => parseContract('library-rpc', { ...request, revisionTarget })).toThrow()
    }
  })
})
