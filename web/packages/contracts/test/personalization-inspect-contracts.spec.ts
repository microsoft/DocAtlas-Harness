import { readFileSync } from 'node:fs'

import {
  personalizationInspectIssues,
  type PersonalizationInspectRequest,
  type PersonalizationInspectResult,
} from '../src/personalization-inspect-contracts.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m6/personalization-inspect.json', import.meta.url),
  'utf8',
)) as { request: PersonalizationInspectRequest, result: PersonalizationInspectResult }

describe('personalization inspection contract', () => {
  it('accepts a bounded path-free authenticated snapshot', () => {
    expect(validateContractShape('personalization-inspect', fixture.request).ok).toBe(true)
    expect(validateContractShape('personalization-inspect', fixture.result).ok).toBe(true)
    expect(personalizationInspectIssues(fixture.result, fixture.request)).toEqual([])
  })

  it('rejects path injection and cross-session why-used state', () => {
    expect(validateContractShape('personalization-inspect', {
      ...fixture.request,
      path: '/private/profile.sqlite3',
    }).ok).toBe(false)
    expect(personalizationInspectIssues({
      ...fixture.result,
      decisions: [{
        schemaVersion: 1,
        recordType: 'personalization-decision',
        decisionId: 'decision:forged',
        profileId: fixture.request.profileId,
        memoryVersionIds: [],
        appliesTo: { mode: 'explore', sessionId: 'session:other', turn: 1 },
        effects: [],
        why: [],
        factTraceGuard: {
          sourceScopeVersionId: 'scope:forged',
          baselineDigest: 'a'.repeat(64),
          evidenceSupportInvariant: true,
          contradictionDisclosureInvariant: true,
          publicationGateInvariant: true,
          sourceScopeInvariant: true,
        },
        expiresAfterTurn: 1,
        createdAt: '2026-08-31T16:00:00.000Z',
      }],
      counts: { ...fixture.result.counts, decisions: 1 },
    }, fixture.request)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'identity', path: '/decisions/0' }),
    ]))
  })
})
