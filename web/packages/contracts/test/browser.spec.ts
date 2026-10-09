import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseBrowserContract } from '../src/browser.js'
for (const [contract, file] of [['product-http', 'product-http'], ['conversation-observation', 'conversation-observations']] as const) {
  const fixtures = JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${file}.json`, import.meta.url), 'utf8')) as { valid: unknown[], invalid: unknown[] }
  it.each(fixtures.valid)(`browser ${contract} accepts %#`, value => { expect(parseBrowserContract(contract, value)).toEqual(value) })
  it.each(fixtures.invalid)(`browser ${contract} rejects %#`, value => { expect(() => parseBrowserContract(contract, value)).toThrow() })
}
