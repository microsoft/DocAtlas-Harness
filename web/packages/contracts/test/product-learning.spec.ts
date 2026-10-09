import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productLearningIssues, type ProductLearningValue } from '../src/product-learning-contracts.js'

type Path = Array<string | number>
interface Case { name: string, base: string, set?: Array<{ path: Path, value: unknown }>, remove?: Path[], codes?: string[], authority?: string }
const directory = new URL('../../../contracts/fixtures/', import.meta.url)
const fixture = JSON.parse(readFileSync(new URL('product-learning.json', directory), 'utf8')) as {
  imports: Record<string, string>, bases: Record<string, unknown>, valid: Case[], invalidShape: Case[], invalidSemantic: Case[], hostOnly: Case[]
}
const imported: Record<string, unknown> = Object.fromEntries(Object.entries(fixture.imports).map(([name, path]) => [name, JSON.parse(readFileSync(new URL(path, directory), 'utf8'))]))
function expand(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new Error('Fixture nesting limit')
  if (Array.isArray(value)) return value.map(item => expand(item, depth + 1))
  if (value === null || typeof value !== 'object') return value
  if ('$fixture' in value) {
    const reference = value as { $fixture: string, path: Path }
    if (Object.keys(value).sort().join(',') !== '$fixture,path' || !Object.hasOwn(imported, reference.$fixture)) throw new Error('Invalid fixture reference')
    let source = imported[reference.$fixture]
    for (const part of reference.path) {
      if (source === null || typeof source !== 'object' || !Object.hasOwn(source, part)) throw new Error('Invalid fixture path')
      source = Reflect.get(source, part)
    }
    return expand(source, depth + 1)
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, depth + 1)]))
}
function materialize(example: Case): ProductLearningValue {
  if (!Object.hasOwn(fixture.bases, example.base)) throw new Error('Missing fixture base')
  const value = expand(fixture.bases[example.base]) as ProductLearningValue
  const parent = (path: Path): object => { let current: object = value; for (const part of path.slice(0, -1)) current = Reflect.get(current, part) as object; return current }
  for (const change of example.set ?? []) Reflect.set(parent(change.path), change.path.at(-1)!, expand(change.value))
  for (const path of example.remove ?? []) Reflect.deleteProperty(parent(path), path.at(-1)!)
  return value
}
describe('shared learning shapes and bounded display consistency, not permission or utility proofs', () => {
  it.each(fixture.valid)('accepts $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-learning', value)).toEqual(value)
    expect(productLearningIssues(value)).toEqual([])
    expect(parseBrowserContract('product-learning', value)).toEqual(value); expect(value).toEqual(before)
  })
  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-learning', value).ok).toBe(false)
    expect(() => parseContract('product-learning', value)).toThrow()
    expect(() => parseBrowserContract('product-learning', value)).toThrow()
  })
  it.each(fixture.invalidSemantic)('rejects inconsistent display: $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-learning', value)).toEqual(value)
    expect(productLearningIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-learning', value)).toThrow('Inconsistent preference learning response')
    expect(value).toEqual(before)
  })
  it.each(fixture.hostOnly)('keeps authority separate: $name', example => {
    const value = materialize(example)
    expect(example.authority?.length).toBeGreaterThan(0)
    expect(parseContract('product-learning', value)).toEqual(value); expect(productLearningIssues(value)).toEqual([])
    expect(parseBrowserContract('product-learning', value)).toEqual(value)
  })
  it('covers every human learning action and preserves null historical candidate receipts', () => {
    const values = fixture.valid.map(materialize)
    expect([...new Set(values.filter(value => value.kind === 'learning-command').map(value => value.action))].sort()).toEqual(['choose', 'configure', 'dismiss', 'prepare', 'review'])
    expect([...new Set(values.map(value => value.kind))].sort()).toEqual(['learning-command', 'learning-operation', 'learning-query', 'learning-receipt', 'learning-view'])
    const value = materialize({ name: 'chosen', base: 'chosen' })
    if (value.kind !== 'learning-view') throw new Error('Wrong fixture')
    expect(value.comparison?.choiceReceipt?.choice.scopeIntent).toBe('workspace')
    expect(value.comparison?.choiceReceipt?.candidateId).toBeNull()
  })
})
