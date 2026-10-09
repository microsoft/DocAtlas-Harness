import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
import { enrichmentIssues, type EnrichmentValue } from '../src/enrichment-contracts.js'
import { parseContract, validateContractShape } from '../src/node.js'

type FixturePath = Array<string | number>
interface FixtureCase {
  name: string
  base: string
  set?: Array<{ path: FixturePath, value: unknown }>
  remove?: FixturePath[]
  codes?: string[]
}
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document/enrichment.json', import.meta.url), 'utf8')) as {
  bases: Record<string, EnrichmentValue>
  valid: FixtureCase[]
  invalidShape: FixtureCase[]
  invalidSemantic: FixtureCase[]
}

/** The same bounded fixture mutations are materialized by the Python shape suite. */
function materialize(example: FixtureCase): EnrichmentValue {
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

describe('shared enrichment contracts in Node and static browser validators', () => {
  it('covers every public enrichment union and explicit job state', () => {
    const valid = fixture.valid.map(materialize)
    expect([...new Set(valid.map(value => value.kind))].sort()).toEqual([
      'enrichment-job', 'enrichment-list', 'enrichment-page', 'enrichment-start', 'enrichment-tree', 'tree-enrichment',
    ])
    expect([...new Set(valid.filter(value => value.kind === 'enrichment-job').map(value => value.state))].sort()).toEqual([
      'cancelled', 'completed', 'failed', 'generating', 'preparing', 'queued',
    ])
  })

  it.each(fixture.valid)('accepts $name', example => {
    const value = materialize(example), before = structuredClone(value)
    expect(parseContract('enrichment', value)).toEqual(value)
    expect(enrichmentIssues(value)).toEqual([])
    expect(parseBrowserContract('enrichment', value)).toEqual(value)
    expect(value).toEqual(before)
  })

  it.each(fixture.invalidShape)('rejects shape: $name', example => {
    const value = materialize(example)
    expect(validateContractShape('enrichment', value).ok).toBe(false)
    expect(() => parseContract('enrichment', value)).toThrow()
    expect(() => parseBrowserContract('enrichment', value)).toThrow()
  })

  it.each(fixture.invalidSemantic)('rejects semantics: $name', example => {
    const value = materialize(example)
    // The Node parser intentionally handles shape only, like Python. The owning
    // consumer and browser additionally reject cross-field inconsistency.
    expect(parseContract('enrichment', value)).toEqual(value)
    expect(enrichmentIssues(value)).toEqual(example.codes)
    expect(() => parseBrowserContract('enrichment', value)).toThrow('Inconsistent enrichment result')
  })

  it('does not mistake lexical wire hashes or pagination for cryptographic attestations', () => {
    const result = structuredClone(fixture.bases.result!)
    if (result.kind !== 'tree-enrichment') throw new Error('Wrong result fixture')
    result.resultHash = '0'.repeat(64)
    expect(enrichmentIssues(parseContract('enrichment', result))).toEqual([])
    expect(parseBrowserContract('enrichment', result)).toEqual(result)
    // The durable store verifies the complete canonical result hash; a partial
    // page deliberately retains that full-result seal without resealing itself.
    const page = fixture.bases.page!
    if (page.kind !== 'enrichment-page') throw new Error('Wrong page fixture')
    expect(page.resultHash).toBe((fixture.bases.result as typeof result).resultHash)
    expect(page.nodes.length).toBeLessThan((fixture.bases.result as typeof result).nodes.length)
  })
})
