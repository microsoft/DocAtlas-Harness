import { readFileSync } from 'node:fs'

import type {
  ContinuityAssessRequest,
  ContinuityAssessResult,
  ContinuityValidationContext,
  RevisionImpactRequest,
} from '@docatlas/contracts'
import { describe, expect, it } from 'vitest'

import {
  ContinuityService,
  type ContinuityServiceBackend,
} from '../src/storage/continuity-service.ts'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m5/research-continuity.valid.json', import.meta.url),
  'utf8',
)) as {
  assessments: { continuing: {
    request: ContinuityAssessRequest
    result: ContinuityAssessResult
    context: ContinuityValidationContext
  } }
  revisionImpact: {
    pageOneRequest: RevisionImpactRequest
    context: ContinuityValidationContext
  }
}

describe('ContinuityService', () => {
  it('admits evidence-gated continuity idempotently and rejects scope escape', () => {
    const sample = fixture.assessments.continuing
    const committed = new Map<string, { hash: string, link: ContinuityAssessResult['link'] }>()
    const backend: ContinuityServiceBackend = {
      activeScope: () => sample.context.activeScope,
      researchRecord: () => ({
        recordId: sample.request.priorRecordId,
        workspaceId: sample.request.workspaceId,
        investigationId: 'investigation:prior',
        recordType: 'open-question',
        status: 'open',
        sources: sample.request.priorSources,
      }),
      resolveEvidence: (_workspaceId, evidenceId) =>
        sample.context.evidence?.find(item => item.evidenceId === evidenceId),
      commitLink(key, hash, link) {
        const prior = committed.get(key)
        if (prior !== undefined) {
          if (prior.hash !== hash) throw new Error('idempotency conflict')
          return { status: 'replayed', link: prior.link }
        }
        committed.set(key, { hash, link })
        return { status: 'created', link }
      },
      impactRecords: () => [],
    }
    const service = new ContinuityService(backend, () => Date.parse('2026-08-31T13:30:00Z'))
    expect(service.assess(sample.request, { kind: 'rule', actorId: 'rule:continuity' }))
      .toMatchObject({ status: 'created', link: { state: 'continuing', verificationStatus: 'reverified' } })
    expect(service.assess(sample.request, { kind: 'rule', actorId: 'rule:continuity' }).status)
      .toBe('replayed')
    expect(() => service.assess({
      ...sample.request,
      scopeVersionId: 'scope:forged',
    }, { kind: 'rule', actorId: 'rule:continuity' })).toThrowError(expect.objectContaining({
      code: 'permission-denied',
    }))
    const forgedRecordService = new ContinuityService({
      ...backend,
      researchRecord: () => ({
        recordId: sample.request.priorRecordId,
        workspaceId: 'workspace:forged',
        investigationId: 'investigation:forged',
        recordType: 'open-question',
        status: 'open',
        sources: sample.request.priorSources,
      }),
    })
    expect(() => forgedRecordService.assess(
      { ...sample.request, idempotencyKey: 'idempotency:forged-record' },
      { kind: 'rule', actorId: 'rule:continuity' },
    )).toThrowError(expect.objectContaining({ code: 'integrity-error' }))
  })

  it('classifies revision impact deterministically with stable cursor binding', () => {
    const request = fixture.revisionImpact.pageOneRequest
    const records = fixture.revisionImpact.context.impactRecords ?? []
    const backend: ContinuityServiceBackend = {
      activeScope: () => undefined,
      researchRecord: () => undefined,
      resolveEvidence: () => undefined,
      commitLink: (_key, _hash, link) => ({ status: 'created', link }),
      impactRecords: () => records,
    }
    const service = new ContinuityService(backend)
    const first = service.revisionImpact(request)
    expect(first.pageInfo.returned).toBeLessThanOrEqual(request.limits.maxItems)
    if (first.pageInfo.nextCursor !== undefined) {
      const second = service.revisionImpact({ ...request, cursor: first.pageInfo.nextCursor })
      expect(new Set([...first.impacts, ...second.impacts].map(item => item.recordId)).size)
        .toBe(first.impacts.length + second.impacts.length)
      expect(() => service.revisionImpact({ ...request, cursor: 'impact:deadbeefdeadbeef:1' }))
        .toThrowError(expect.objectContaining({ code: 'invalid-request' }))
      const tamperedOffset = first.pageInfo.nextCursor.replace(/^impact:\d+:/, 'impact:9999:')
      expect(() => service.revisionImpact({ ...request, cursor: tamperedOffset }))
        .toThrowError(expect.objectContaining({ code: 'invalid-request' }))
    }
  })
})
