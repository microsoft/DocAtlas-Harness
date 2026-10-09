import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseContract } from '../src/node.js'
const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-http.json', import.meta.url), 'utf8')) as { valid: unknown[], invalid: unknown[] }
it.each(fixtures.valid)('accepts product HTTP frame %#', value => { expect(() => parseContract('product-http', value)).not.toThrow() })
it.each(fixtures.invalid)('rejects product HTTP frame %#', value => { expect(() => parseContract('product-http', value)).toThrow() })
