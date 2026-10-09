import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { conversationObservationIssues, nativeControlIssues, nativeLineageIssues, productAnswerIssues, productHistoryIssues,
  type AnswerResponse, type ConversationObservationValue, type NativeControlValue, type NativeLineageValue, type ProductAnswerValue, type ProductHistoryValue } from '../src/index.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { parseBrowserContract } from '../src/browser.js'

type Contract = 'native-lineage' | 'native-control' | 'product-history' | 'conversation-observation' | 'product-answer'
type Patch = { path: Array<string | number>, value?: unknown, remove?: boolean, repeat?: number }
interface Vector { id: string, name: string, contract: Contract, value: unknown, patches?: Patch[] }
interface Mutation { name: string, vector: string, patches: Patch[] }
interface Fixtures { templates: Record<string, unknown>, vectors: Vector[], invalidShape: Mutation[], invalidSemantic: Mutation[] }
const cache = new Map<string, unknown>()
function load(file: string): unknown {
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${file}`, import.meta.url), 'utf8')))
  return cache.get(file)
}
const fixtures = load('native-lineage-cases.json') as Fixtures
/** Fixture-only expansion. Neither these directives nor paths are product wire or execution authority. */
function expand(value: unknown, depth = 0): unknown {
  if (depth > 128) throw new Error('Cyclic fixture reference')
  if (Array.isArray(value)) return value.map(item => expand(item, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (typeof record.$template === 'string' && Object.keys(record).length === 1) {
    if (!Object.hasOwn(fixtures.templates, record.$template)) throw new Error('Unknown fixture template')
    return expand(fixtures.templates[record.$template], depth + 1)
  }
  if (typeof record.$fixture === 'string' && Array.isArray(record.path) && Object.keys(record).length === 2) {
    let selected = load(record.$fixture)
    for (const key of record.path) selected = (selected as Record<string | number, unknown>)[key as string | number]
    if (selected === undefined) throw new Error('Missing fixture source')
    return expand(selected, depth + 1)
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expand(item, depth + 1)]))
}
function patched(candidate: unknown, patches: Patch[] = []): unknown {
  let result = structuredClone(candidate)
  for (const patch of patches) {
    if (!patch.path.length) { result = expand(patch.value); continue }
    let current = result as Record<string | number, unknown>
    for (const part of patch.path.slice(0, -1)) current = current[part] as typeof current
    const key = patch.path.at(-1)!
    if (patch.remove) delete current[key]
    else current[key] = patch.repeat === undefined ? expand(patch.value) : String(patch.value).repeat(patch.repeat)
  }
  return result
}
const vectors = fixtures.vectors.map(vector => ({ ...vector, value: patched(expand(vector.value), vector.patches) }))
const byId = new Map(vectors.map(vector => [vector.id, vector]))
function issues(contract: Contract, value: unknown): string[] {
  if (contract === 'native-lineage') return nativeLineageIssues(value as NativeLineageValue)
  if (contract === 'native-control') return nativeControlIssues(value as NativeControlValue)
  if (contract === 'product-history') return productHistoryIssues(value as ProductHistoryValue)
  if (contract === 'conversation-observation') return conversationObservationIssues(value as ConversationObservationValue)
  return productAnswerIssues(value as ProductAnswerValue)
}

it.each(vectors)('accepts shared native lineage wire: $name', ({ contract, value }) => {
  const before = structuredClone(value)
  expect(parseContract(contract, value)).toEqual(value)
  expect(issues(contract, value)).toEqual([])
  expect(parseBrowserContract(contract, value)).toEqual(value)
  expect(value).toEqual(before)
})

it.each(fixtures.invalidShape)('rejects malformed shared native lineage wire: $name', mutation => {
  const vector = byId.get(mutation.vector)!, value = patched(vector.value, mutation.patches)
  expect(validateContractShape(vector.contract, value).ok).toBe(false)
  expect(() => parseContract(vector.contract, value)).toThrow()
  expect(() => parseBrowserContract(vector.contract, value)).toThrow()
})

it.each(fixtures.invalidSemantic)('rejects inconsistent native lineage semantics: $name', mutation => {
  const vector = byId.get(mutation.vector)!, value = patched(vector.value, mutation.patches)
  expect(validateContractShape(vector.contract, value).ok).toBe(true)
  expect(parseContract(vector.contract, value)).toEqual(value) // Node shape parsing is distinct from the owning consumer's semantic gate.
  expect(issues(vector.contract, value).length).toBeGreaterThan(0)
  expect(() => parseBrowserContract(vector.contract, value)).toThrow()
})

it('counts exact Unicode code points for native instructions and labels rather than UTF-16 units', () => {
  const action = { kind: 'navigate', targetEntryId: 'entry:target', summarize: true, instructions: '🔬'.repeat(4096), replaceInstructions: false, label: '🔬'.repeat(256) }
  expect(parseContract('native-lineage', action)).toEqual(action); expect(parseBrowserContract('native-lineage', action)).toEqual(action)
  for (const excess of [{ ...action, instructions: `${action.instructions}🔬` }, { ...action, label: `${action.label}🔬` }]) {
    expect(() => parseContract('native-lineage', excess)).toThrow(); expect(() => parseBrowserContract('native-lineage', excess)).toThrow()
  }
})

it('keeps the original published Answer manifest byte-equivalent under a different response conversation', () => {
  const original = expand({ $fixture: 'product-answer.json', path: ['bases', 'response'] }) as AnswerResponse
  const inherited = byId.get('inherited-answer')!.value as AnswerResponse
  expect(inherited.conversationId).not.toBe(original.conversationId)
  expect(inherited.origin?.conversationId).toBe(original.conversationId)
  expect(inherited.origin?.entryId).toBe(inherited.messageId)
  expect(JSON.stringify(inherited.manifest)).toBe(JSON.stringify(original.manifest))
  expect(inherited.nativeTextHash).toBe(original.nativeTextHash)
})

it('keeps vector identities unique and every mutation attached to an existing independently valid base', () => {
  expect(byId.size).toBe(vectors.length)
  for (const mutation of [...fixtures.invalidShape, ...fixtures.invalidSemantic]) expect(byId.has(mutation.vector)).toBe(true)
})
