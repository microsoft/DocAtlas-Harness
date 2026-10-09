import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseContract } from '../src/node.js'
const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/worker-frames.json', import.meta.url), 'utf8')) as { valid: unknown[], invalid: unknown[] }
it.each(fixtures.valid)('accepts worker frame %#', value => { expect(() => parseContract('worker-frame', value)).not.toThrow() })
it.each(fixtures.invalid)('rejects worker frame %#', value => { expect(() => parseContract('worker-frame', value)).toThrow() })
