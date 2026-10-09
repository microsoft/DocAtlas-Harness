import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { nativeControlIssues, type NativeControlValue } from '../src/index.js'
import { parseContract, validateContractShape } from '../src/node.js'
import { parseBrowserContract } from '../src/browser.js'

type Patch = { path: Array<string | number>, value?: unknown, remove?: boolean, repeat?: number }
type Vector = { name: string, base: number, patches: Patch[] }
type Mutation = { name: string, vector: number, patches: Patch[] }
const load = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${file}`, import.meta.url), 'utf8')) as T
const original = load<{ 'native-control': unknown[] }>('native-history.json')['native-control']
const fixtures = load<{ vectors: Vector[], invalidShape: Mutation[], invalidSemantic: Mutation[] }>('native-compaction-cases.json')
function patched(candidate: unknown, patches: Patch[]): unknown {
  let result = structuredClone(candidate)
  for (const patch of patches) {
    if (!patch.path.length) { result = structuredClone(patch.value); continue }
    let current = result as Record<string | number, unknown>
    for (const part of patch.path.slice(0, -1)) current = current[part] as typeof current
    const last = patch.path.at(-1)!
    if (patch.remove) delete current[last]
    else current[last] = patch.repeat ? String(patch.value).repeat(patch.repeat) : structuredClone(patch.value)
  }
  return result
}
const values = fixtures.vectors.map(vector => patched(original[vector.base], vector.patches))
it.each(fixtures.vectors.map((vector, index) => ({ name: vector.name, value: values[index] })))('accepts additive compact wire: $name', ({ value }) => {
  const before = structuredClone(value)
  expect(parseContract('native-control', value)).toEqual(value)
  expect(nativeControlIssues(value as NativeControlValue)).toEqual([])
  expect(parseBrowserContract('native-control', value)).toEqual(value)
  expect(value).toEqual(before)
})
it.each(fixtures.invalidShape)('rejects malformed compact wire: $name', vector => {
  const value = patched(values[vector.vector], vector.patches)
  expect(validateContractShape('native-control', value).ok).toBe(false)
  expect(() => parseBrowserContract('native-control', value)).toThrow()
})
it.each(fixtures.invalidSemantic)('rejects inconsistent compact proof: $name', vector => {
  const value = patched(values[vector.vector], vector.patches)
  expect(validateContractShape('native-control', value).ok).toBe(true)
  expect(nativeControlIssues(value as NativeControlValue).length).toBeGreaterThan(0)
  expect(() => parseBrowserContract('native-control', value)).toThrow()
})
it('counts Unicode code points rather than UTF-16 units in the shared instruction limit', () => {
  const value = { kind: 'compact', instructions: '🔬'.repeat(4096) }
  expect(parseContract('native-control', value)).toEqual(value)
  expect(parseBrowserContract('native-control', value)).toEqual(value)
  expect(() => parseBrowserContract('native-control', { ...value, instructions: `${value.instructions}🔬` })).toThrow()
})
