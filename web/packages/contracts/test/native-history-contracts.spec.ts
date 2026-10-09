import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { nativeControlIssues, productHistoryIssues, type NativeControlValue, type ProductHistoryValue } from '../src/index.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { parseBrowserContract } from '../src/browser.js'

type Name = 'native-control' | 'product-history'
type Vector = { name: string, contract: Name, index: number, path: Array<string | number>, value?: unknown, remove?: boolean, repeat?: number }
const load = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${file}`, import.meta.url), 'utf8')) as T
const fixtures = load<Record<Name, unknown[]>>('native-history.json')
const cases = load<Record<'invalidShape' | 'invalidSemantic', Vector[]>>('native-history-cases.json')
const issues = (name: Name, value: unknown) => name === 'native-control' ? nativeControlIssues(value as NativeControlValue) : productHistoryIssues(value as ProductHistoryValue)
function materialize(vector: Vector): unknown {
  const value = structuredClone(fixtures[vector.contract][vector.index])
  let current = value as Record<string | number, unknown>
  for (const part of vector.path.slice(0, -1)) current = current[part] as typeof current
  const last = vector.path.at(-1)!
  if (vector.remove) delete current[last]
  else current[last] = vector.repeat ? 'x'.repeat(vector.repeat) : structuredClone(vector.value)
  return value
}
for (const name of ['native-control', 'product-history'] as const) it.each(fixtures[name].map((value, index) => ({ value, index })))(`${name} valid vector $index is immutable in Node and static browser`, ({ value }) => {
  const before = structuredClone(value)
  expect(parseContract(name, value)).toEqual(value)
  expect(issues(name, value)).toEqual([])
  expect(parseBrowserContract(name, value)).toEqual(value)
  expect(value).toEqual(before)
})
it.each(cases.invalidShape)('rejects malformed wire: $name', vector => {
  const value = materialize(vector)
  expect(validateContractShape(vector.contract, value).ok).toBe(false)
  expect(() => parseBrowserContract(vector.contract, value)).toThrow()
})
it.each(cases.invalidSemantic)('rejects shape-valid inconsistency: $name', vector => {
  const value = materialize(vector)
  expect(validateContractShape(vector.contract, value).ok).toBe(true)
  expect(issues(vector.contract, value).length).toBeGreaterThan(0)
  expect(() => parseBrowserContract(vector.contract, value)).toThrow()
})
it('does not confuse JSON key order with a different native action or prefix', () => {
  const value = structuredClone(fixtures['native-control'][7]) as Extract<NativeControlValue, { kind: 'native-operation' }>
  value.result!.action = { level: 'max', kind: 'set-thinking' }
  value.result!.beforeHead = Object.fromEntries(Object.entries(value.request.expectedHead).reverse()) as typeof value.request.expectedHead
  expect(nativeControlIssues(value)).toEqual([])
  expect(parseBrowserContract('native-control', value)).toEqual(value)
})
it('bounds total displayed history after original-user text mapping', () => {
  const value = structuredClone(fixtures['product-history'][1]) as Extract<ProductHistoryValue, { kind: 'history-page' }>
  value.messages = Array.from({ length: 3 }, (_, index) => ({ ...value.messages[0]!, entryId: `message:${index}`, text: 'x'.repeat(65536) }))
  expect(validateContractShape('product-history', value).ok).toBe(true)
  expect(productHistoryIssues(value)).toContain('history-budget')
})
