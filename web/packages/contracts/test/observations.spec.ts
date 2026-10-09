import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseContract } from '../src/node.js'
import { conversationObservationIssues } from '../src/observation-contracts.js'
const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: unknown[], invalid: unknown[], semantic: Array<{ value: unknown, codes: string[] }> }
it.each(fixtures.valid)('accepts conversation observation %#', value => { expect(conversationObservationIssues(parseContract('conversation-observation', value))).toEqual([]) })
it.each(fixtures.invalid)('rejects invalid conversation observation %#', value => { expect(() => parseContract('conversation-observation', value)).toThrow() })
it.each(fixtures.semantic)('checks observation identity %#', ({ value, codes }) => { expect(conversationObservationIssues(parseContract('conversation-observation', value))).toEqual(codes) })
