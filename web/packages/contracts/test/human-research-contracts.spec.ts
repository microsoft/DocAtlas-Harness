import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { humanResearchIssues, type HumanResearchCommand, type HumanResearchValue } from '../src/index.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { parseBrowserContract } from '../src/browser.js'

type Patch = { path: Array<string | number>, value?: unknown, remove?: boolean, repeat?: number }
interface Vector { id: string, name: string, contract: 'human-research', value: unknown, patches?: Patch[] }
interface Mutation { name: string, vector: string, patches: Patch[] }
const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/human-research-cases.json', import.meta.url), 'utf8')) as {
  templates: Record<string, unknown>, vectors: Vector[], invalidShape: Mutation[], invalidSemantic: Mutation[],
}
function expand(value: unknown, depth = 0): unknown {
  if (depth > 128) throw new Error('Cyclic fixture')
  if (Array.isArray(value)) return value.map(item => expand(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (typeof record.$template === 'string' && Object.keys(record).length === 1) return expand(fixtures.templates[record.$template], depth + 1)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expand(item, depth + 1)]))
}
function patched(value: unknown, patches: Patch[] = []): unknown {
  const result = structuredClone(value)
  for (const patch of patches) {
    let current = result as Record<string | number, unknown>
    for (const key of patch.path.slice(0, -1)) current = current[key] as typeof current
    const key = patch.path.at(-1)!
    if (patch.remove) delete current[key]
    else current[key] = patch.repeat === undefined ? expand(patch.value) : String(patch.value).repeat(patch.repeat)
  }
  return result
}
const vectors = fixtures.vectors.map(vector => ({ ...vector, value: patched(expand(vector.value), vector.patches) }))
const byId = new Map(vectors.map(vector => [vector.id, vector]))

it.each(vectors)('accepts human authoring wire without inventing source or execution authority: $name', ({ value }) => {
  const before = structuredClone(value)
  expect(parseContract('human-research', value)).toEqual(value)
  expect(humanResearchIssues(value as HumanResearchValue)).toEqual([])
  expect(parseBrowserContract('human-research', value)).toEqual(value)
  expect(value).toEqual(before)
})
it.each(fixtures.invalidShape)('rejects malformed human authoring wire: $name', mutation => {
  const value = patched(byId.get(mutation.vector)!.value, mutation.patches)
  expect(validateContractShape('human-research', value).ok).toBe(false)
  expect(() => parseContract('human-research', value)).toThrow()
  expect(() => parseBrowserContract('human-research', value)).toThrow()
})
it.each(fixtures.invalidSemantic)('rejects inconsistent human authoring semantics: $name', mutation => {
  const value = patched(byId.get(mutation.vector)!.value, mutation.patches)
  expect(validateContractShape('human-research', value).ok).toBe(true)
  expect(humanResearchIssues(value as HumanResearchValue).length).toBeGreaterThan(0)
  expect(() => parseBrowserContract('human-research', value)).toThrow()
})
it('uses Unicode scalar limits and keeps human records distinct from Agent and question-ticket wire', () => {
  const command = structuredClone(byId.get('command')!.value) as Extract<HumanResearchCommand, { action: 'create' }>
  const entry = { recordType: 'research-note' as const, noteKind: 'scratch' as const, body: '🔬'.repeat(4000) }
  command.entry = entry
  expect(parseBrowserContract('human-research', command)).toEqual(command)
  expect(() => parseBrowserContract('human-research', { ...command, entry: { ...entry, body: entry.body + '🔬' } })).toThrow()
  const record = byId.get('record')!.value
  expect(() => parseContract('research-record-rpc', record)).toThrow()
  expect(() => parseContract('selection-context', record)).toThrow()
  expect(JSON.stringify(record)).not.toMatch(/provenanceCallId|selectionContextId|evidenceId|toolCallId/u)
})
it('keeps all mutation bases present and unique', () => {
  expect(byId.size).toBe(vectors.length)
  for (const test of [...fixtures.invalidShape, ...fixtures.invalidSemantic]) expect(byId.has(test.vector)).toBe(true)
})
