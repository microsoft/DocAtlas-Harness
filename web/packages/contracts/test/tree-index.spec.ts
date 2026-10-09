import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseContract, validateContractShape } from '../src/node.js'
import { treeIndexIssues, type TreeIndexValue } from '../src/tree-index-contracts.js'
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document/tree-index.json', import.meta.url), 'utf8')) as {
  valid: TreeIndexValue[], invalidShape: Array<{ name: string, value: unknown }>, invalidSemantic: Array<{ name: string, value: TreeIndexValue, codes: string[] }>
}
describe('immutable navigation tree contracts', () => {
  it.each(fixture.valid)('accepts $kind', value => { expect(parseContract('tree-index', value)).toEqual(value); expect(treeIndexIssues(value)).toEqual([]) })
  it.each(fixture.invalidShape)('rejects $name', ({ value }) => { expect(validateContractShape('tree-index', value).ok).toBe(false) })
  it.each(fixture.invalidSemantic)('detects $name', ({ value, codes }) => { expect(validateContractShape('tree-index', value).ok).toBe(true); expect(treeIndexIssues(value)).toEqual(codes) })
})
