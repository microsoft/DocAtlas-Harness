import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { productAnswerIssues, type ProductAnswerValue } from '../src/product-answer-contracts.js'

type FixturePath = Array<string | number>
interface FixtureCase {
  name: string
  base: string
  set?: Array<{ path: FixturePath, value: unknown }>
  remove?: FixturePath[]
  codes?: string[]
}
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-answer.json', import.meta.url), 'utf8')) as {
  bases: Record<string, ProductAnswerValue>
  valid: FixtureCase[]
  invalidShape: FixtureCase[]
  invalidSemantic: FixtureCase[]
}

function materialize(example: FixtureCase): ProductAnswerValue {
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

describe('read-only product answer and original-PDF citation contracts', () => {
  it.each(fixture.valid)('accepts $name in Node and static browser', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('product-answer', value)).toEqual(value)
    expect(productAnswerIssues(value)).toEqual([])
    expect(parseBrowserContract('product-answer', value)).toEqual(value)
    expect(value).toEqual(before)
  })

  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('product-answer', value).ok).toBe(false)
    expect(() => parseContract('product-answer', value)).toThrow()
    expect(() => parseBrowserContract('product-answer', value)).toThrow()
  })

  it.each(fixture.invalidSemantic)('rejects semantics: $name', example => {
    const value = materialize(example)
    // Node/Python shape parsers are deliberately not cross-field or source-byte
    // authorities. The browser and owning application additionally check these.
    expect(parseContract('product-answer', value)).toEqual(value)
    expect(productAnswerIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('product-answer', value)).toThrow('Inconsistent answer response')
  })

  it('covers both response states and every truthful focus status', () => {
    const values = fixture.valid.map(materialize)
    expect([...new Set(values.filter(value => value.kind === 'answer-response').map(value => value.status))].sort()).toEqual(['available', 'unavailable'])
    expect([...new Set(values.filter(value => value.kind === 'citation-focus').map(value => value.status))].sort()).toEqual(['ambiguous', 'page-only', 'resolved'])
    const response = fixture.bases.response!, focus = fixture.bases.focus!
    if (response.kind !== 'answer-response' || !response.manifest || focus.kind !== 'citation-focus') throw new Error('Invalid fixture variants')
    expect(response.nativeTextHash).not.toBe(response.manifest.answerTextHash)
    expect(focus.original.contentHash).not.toBe(focus.locator.representationContentHash)
  })

  it('counts exact text limits in Unicode scalars, not UTF-16 code units', () => {
    const value = structuredClone(fixture.bases.focus!)
    if (value.kind !== 'citation-focus') throw new Error('Wrong focus fixture')
    value.exactText = '文😀'.repeat(10000)
    expect(parseContract('product-answer', value)).toEqual(value)
    expect(parseBrowserContract('product-answer', value)).toEqual(value)
    value.exactText += '。'
    expect(() => parseContract('product-answer', value)).toThrow()
    expect(() => parseBrowserContract('product-answer', value)).toThrow()
  })
})
