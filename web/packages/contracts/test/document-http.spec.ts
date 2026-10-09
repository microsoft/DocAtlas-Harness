import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseContract } from '../src/node.js'
import { parseBrowserContract } from '../src/browser.js'
const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document-http.json', import.meta.url), 'utf8')) as { valid: unknown[], invalid: unknown[] }
it.each(fixtures.valid)('accepts document HTTP %# in Node and static browser validators', value => {
  expect(parseContract('document-http', value)).toEqual(value); expect(parseBrowserContract('document-http', value)).toEqual(value)
})
it.each(fixtures.invalid)('rejects document HTTP %# in Node and static browser validators', value => {
  expect(() => parseContract('document-http', value)).toThrow(); expect(() => parseBrowserContract('document-http', value)).toThrow()
})
