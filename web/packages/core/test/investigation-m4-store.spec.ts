import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type { ArtifactManifest } from '@docatlas/contracts'
import type {
  ClaimVersion,
  DerivationActivity,
  EvidenceRelation,
} from '@docatlas/contracts'
import type { EvidenceAtom } from '@docatlas/contracts'
import { describe, expect, it } from 'vitest'

import {
  artifactContentHash,
  InvestigationM4Store,
  type M4EvidenceResolution,
  type RecordClaimVersionCommand,
} from '../src/storage/investigation-m4-store.ts'

const WORKSPACE_ID = 'workspace:m4-test'
const INVESTIGATION_ID = 'investigation:contract-review'
const SCOPE_ID = 'scope:contract-review:v1'
const T0 = '2026-08-31T10:00:00.000Z'

describe('InvestigationM4Store', () => {
  it('runs one immutable claim through support + refute, human sign-off, and an idempotent published brief', () => {
    const database = new DatabaseSync(':memory:')
    const evidence = evidenceFixture()
    const store = attach(database, evidence)
    const claimCommand = claimBundle({ reviewStatus: 'accepted' })

    expect(store.recordClaimVersion(claimCommand)).toMatchObject({
      status: 'created',
      value: { claimVersionId: 'claim:termination:v1', epistemicStatus: 'contested' },
    })
    expect(store.recordClaimVersion(claimCommand).status).toBe('replayed')
    expect(() => store.recordClaimVersion({
      ...claimCommand,
      expectedCurrentClaimVersionId: 'claim:forged',
    })).toThrowError(expect.objectContaining({ code: 'conflict' }))

    const draft = briefDraft('claim:termination:v1')
    expect(store.recordArtifactDraft({
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      idempotencyKey: 'idem:artifact:draft:v1',
      expectedPreviousArtifactManifestId: null,
      manifest: draft,
    }).status).toBe('created')
    expect(store.recordConflictSearchAssurance(conflictAssurance()).status).toBe('created')

    const reviewCommand = {
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      idempotencyKey: 'idem:review:brief:v1',
      artifactManifestId: draft.artifactManifestId,
      reviewResultId: 'review:brief:v1',
      ruleset: {
        name: 'docatlas-publish-gates',
        version: '1.0.0',
        configHash: 'b'.repeat(64),
      },
      signoffRequirement: 'required' as const,
      reviewer: { kind: 'rule' as const, actorId: 'rule:publish-gates' },
      createdAt: '2026-08-31T10:05:00.000Z',
    }
    const reviewed = store.runArtifactReview(reviewCommand)
    expect(reviewed.value).toMatchObject({
      decision: 'needs-human',
      coverage: { requiredItems: 5, checkedItems: 5, complete: true },
      gates: [
        { gateId: 'G0-integrity', status: 'pass' },
        { gateId: 'G1-grounding', status: 'pass' },
        { gateId: 'G2-scope', status: 'pass' },
        { gateId: 'G3-conflict', status: 'pass' },
        { gateId: 'G4-publication', status: 'pass' },
      ],
    })
    expect(store.runArtifactReview(reviewCommand).status).toBe('replayed')

    const decisionCommand = {
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      idempotencyKey: 'idem:human-review:brief:v1',
      decision: {
        schemaVersion: 1 as const,
        reviewDecisionId: 'human-review:brief:v1',
        workspaceId: WORKSPACE_ID,
        investigationId: INVESTIGATION_ID,
        reviewResultId: 'review:brief:v1',
        decision: 'approved' as const,
        rationale: 'The brief visibly preserves both sides of the conflict.',
        decidedBy: { kind: 'user' as const, actorId: 'user:reviewer' },
        decidedAt: '2026-08-31T10:06:00.000Z',
      },
    }
    expect(store.recordHumanReviewDecision(decisionCommand).status).toBe('created')

    const publishCommand = {
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      idempotencyKey: 'idem:publish:brief:v1',
      artifactManifestId: draft.artifactManifestId,
      expectedStatus: 'draft' as const,
      reviewResultId: 'review:brief:v1',
      humanReviewDecisionId: 'human-review:brief:v1',
      publishedBy: { kind: 'user' as const, actorId: 'user:reviewer' },
      publishedAt: '2026-08-31T10:07:00.000Z',
    }
    const published = store.publishArtifact(publishCommand)
    expect(published).toMatchObject({
      status: 'created',
      value: {
        status: 'published',
        contentHash: draft.contentHash,
        publication: {
          reviewResultId: 'review:brief:v1',
          deterministicDecision: 'needs-human',
          humanReviewDecisionId: 'human-review:brief:v1',
        },
      },
    })
    expect(store.publishArtifact(publishCommand).status).toBe('replayed')
    expect(store.getArtifactManifest(draft.artifactManifestId)).toEqual(published.value)
    expect(store.listJournal(INVESTIGATION_ID).map(event => event.eventType)).toEqual([
      'claim-version.recorded',
      'artifact-draft.recorded',
      'conflict-search-assurance.recorded',
      'review-result.recorded',
      'human-review-decision.recorded',
      'artifact.published',
    ])
    database.close()
  })

  it('projects ClaimVersion CAS without rewriting v1 and never accepts Memory as Evidence', () => {
    const database = new DatabaseSync(':memory:')
    const evidence = evidenceFixture()
    const store = attach(database, evidence)
    const first = claimBundle({ reviewStatus: 'accepted' })
    store.recordClaimVersion(first)

    const second = claimBundleV2()
    expect(() => store.recordClaimVersion({
      ...second,
      expectedCurrentClaimVersionId: 'claim:not-current',
    })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.recordClaimVersion(second)
    expect(store.getClaimLedger(INVESTIGATION_ID).claims).toMatchObject([
      {
        claimVersionId: 'claim:termination:v1',
        lifecycleStatus: 'superseded',
        supersededByClaimVersionId: 'claim:termination:v2',
      },
      {
        claimVersionId: 'claim:termination:v2',
        previousClaimVersionId: 'claim:termination:v1',
        lifecycleStatus: 'current',
      },
    ])
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM investigation_m4_events
      WHERE event_type = 'claim-version.recorded'
    `).get()).toMatchObject({ count: 2 })
    database.close()

    const memoryDatabase = new DatabaseSync(':memory:')
    const memoryStore = InvestigationM4Store.attach(memoryDatabase, {
      workspaceId: WORKSPACE_ID,
      resolveEvidence(evidenceId): M4EvidenceResolution {
        return {
          kind: 'personal-memory',
          workspaceId: WORKSPACE_ID,
          recordId: evidenceId,
        }
      },
    })
    expect(() => memoryStore.recordClaimVersion(claimBundle({
      reviewStatus: 'accepted',
      evidenceIds: ['memory:preference', 'memory:prior-note'],
    }))).toThrowError(expect.objectContaining({
      code: 'invalid-request',
      message: expect.stringContaining('Memory'),
    }))
    memoryDatabase.close()
  })

  it('keeps deterministic failure authoritative and detects journal tampering', () => {
    const database = new DatabaseSync(':memory:')
    const evidence = evidenceFixture()
    const store = attach(database, evidence)
    store.recordClaimVersion(claimBundle({ reviewStatus: 'unreviewed' }))
    const draft = briefDraft('claim:termination:v1')
    store.recordArtifactDraft({
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      idempotencyKey: 'idem:artifact:unreviewed',
      expectedPreviousArtifactManifestId: null,
      manifest: draft,
    })
    const failed = store.runArtifactReview({
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      idempotencyKey: 'idem:review:unreviewed',
      artifactManifestId: draft.artifactManifestId,
      reviewResultId: 'review:unreviewed',
      ruleset: { name: 'publish-gates', version: '1', configHash: 'c'.repeat(64) },
      signoffRequirement: 'required',
      reviewer: { kind: 'rule', actorId: 'rule:publisher' },
      createdAt: '2026-08-31T10:05:00.000Z',
    })
    expect(failed.value).toMatchObject({
      decision: 'fail',
      gates: expect.arrayContaining([
        expect.objectContaining({ gateId: 'G4-publication', status: 'fail' }),
      ]),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unreviewed-claim', severity: 'blocker' }),
        expect.objectContaining({ code: 'conflict-search-incomplete', severity: 'blocker' }),
      ]),
    })
    expect(() => store.recordHumanReviewDecision({
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      idempotencyKey: 'idem:forged-approval',
      decision: {
        schemaVersion: 1,
        reviewDecisionId: 'human-review:forged',
        workspaceId: WORKSPACE_ID,
        investigationId: INVESTIGATION_ID,
        reviewResultId: 'review:unreviewed',
        decision: 'approved',
        decidedBy: { kind: 'user', actorId: 'user:reviewer' },
        decidedAt: '2026-08-31T10:06:00.000Z',
      },
    })).toThrowError(expect.objectContaining({ code: 'publish-blocked' }))

    expect(() => database.prepare(`
      UPDATE investigation_m4_events SET result_json = '{}'
    `).run()).toThrow(/append-only/)
    database.exec('DROP TRIGGER investigation_m4_events_no_update')
    database.prepare(`
      UPDATE investigation_m4_events SET result_json = '{}' WHERE sequence = 1
    `).run()
    expect(() => store.verifyIntegrity()).toThrowError(expect.objectContaining({
      code: 'integrity-error',
    }))
    database.close()
  })
})

function attach(
  database: DatabaseSync,
  evidence: ReadonlyMap<string, M4EvidenceResolution>,
): InvestigationM4Store {
  return InvestigationM4Store.attach(database, {
    workspaceId: WORKSPACE_ID,
    resolveEvidence: evidenceId => evidence.get(evidenceId),
    publicationAssurance: { publicationAllowed: () => true },
  })
}

function conflictAssurance() {
  return {
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    idempotencyKey: 'idem:conflict-search:termination:v1',
    assurance: {
      schemaVersion: 1 as const,
      assuranceId: 'conflict-assurance:termination:v1',
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      sourceScopeVersionId: SCOPE_ID,
      claimVersionIds: ['claim:termination:v1'],
      evidenceIds: ['evidence:termination-refute', 'evidence:termination-support'],
      assuredBy: { kind: 'user' as const, actorId: 'user:reviewer' },
      assuredAt: '2026-08-31T10:04:30.000Z',
    },
  }
}

function claimBundle(input: {
  reviewStatus: ClaimVersion['reviewStatus']
  evidenceIds?: [string, string]
}): RecordClaimVersionCommand {
  const [supportId, refuteId] = input.evidenceIds
    ?? ['evidence:termination-support', 'evidence:termination-refute']
  const claim: ClaimVersion = {
    schemaVersion: 1,
    claimVersionId: 'claim:termination:v1',
    claimChainId: 'claim-chain:termination',
    version: 1,
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    statement: 'The reviewed agreement materials conflict on termination for convenience.',
    basis: 'document-supported',
    scope: { sourceScopeVersionId: SCOPE_ID, section: 'Termination' },
    epistemicStatus: 'contested',
    reviewStatus: input.reviewStatus,
    lifecycleStatus: 'current',
    createdBy: { kind: 'agent', actorId: 'agent:dsh-root' },
    createdAt: '2026-08-31T10:03:00.000Z',
    provenanceActivityId: 'derivation:termination:v1',
  }
  const provenance: DerivationActivity = {
    schemaVersion: 1,
    derivationActivityId: claim.provenanceActivityId,
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    operation: 'verify',
    inputEvidenceIds: [supportId, refuteId],
    inputClaimVersionIds: [],
    outputClaimVersionIds: [claim.claimVersionId],
    actor: { kind: 'rule', actorId: 'rule:claim-verifier' },
    startedAt: '2026-08-31T10:02:00.000Z',
    completedAt: '2026-08-31T10:02:30.000Z',
  }
  return {
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    idempotencyKey: 'idem:claim:termination:v1',
    expectedCurrentClaimVersionId: null,
    claim,
    provenance,
    evidenceRelations: [
      relation('relation:termination:support:v1', claim.claimVersionId, supportId, 'supports'),
      relation('relation:termination:refute:v1', claim.claimVersionId, refuteId, 'refutes'),
    ],
  }
}

function claimBundleV2(): RecordClaimVersionCommand {
  const claim: ClaimVersion = {
    schemaVersion: 1,
    claimVersionId: 'claim:termination:v2',
    claimChainId: 'claim-chain:termination',
    version: 2,
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    statement: 'The agreement and amendment conflict on termination for convenience.',
    basis: 'document-supported',
    scope: { sourceScopeVersionId: SCOPE_ID, section: 'Termination' },
    epistemicStatus: 'contested',
    reviewStatus: 'accepted',
    lifecycleStatus: 'current',
    previousClaimVersionId: 'claim:termination:v1',
    createdBy: { kind: 'user', actorId: 'user:reviewer' },
    createdAt: '2026-08-31T10:08:00.000Z',
    provenanceActivityId: 'derivation:termination:v2',
  }
  return {
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    idempotencyKey: 'idem:claim:termination:v2',
    expectedCurrentClaimVersionId: 'claim:termination:v1',
    claim,
    provenance: {
      schemaVersion: 1,
      derivationActivityId: claim.provenanceActivityId,
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      operation: 'human-edit',
      inputEvidenceIds: ['evidence:termination-support', 'evidence:termination-refute'],
      inputClaimVersionIds: ['claim:termination:v1'],
      outputClaimVersionIds: [claim.claimVersionId],
      actor: { kind: 'user', actorId: 'user:reviewer' },
      startedAt: '2026-08-31T10:07:30.000Z',
      completedAt: '2026-08-31T10:08:00.000Z',
    },
    evidenceRelations: [
      relation('relation:termination:support:v2', claim.claimVersionId, 'evidence:termination-support', 'supports'),
      relation('relation:termination:refute:v2', claim.claimVersionId, 'evidence:termination-refute', 'refutes'),
    ],
  }
}

function relation(
  relationId: string,
  claimVersionId: string,
  evidenceId: string,
  kind: 'supports' | 'refutes',
): EvidenceRelation {
  return {
    schemaVersion: 1,
    evidenceRelationId: relationId,
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    claimVersionId,
    evidenceId,
    kind,
    coverage: 'full',
    createdBy: { kind: 'agent', actorId: 'agent:dsh-root' },
    createdAt: '2026-08-31T10:01:00.000Z',
    reviewStatus: 'human-confirmed',
    reviewedBy: { kind: 'user', actorId: 'user:reviewer' },
    reviewedAt: '2026-08-31T10:02:00.000Z',
  }
}

function briefDraft(claimVersionId: string): ArtifactManifest & { status: 'draft' } {
  const markdown = 'The reviewed materials conflict on termination for convenience.'
  const content = {
    kind: 'brief' as const,
    sections: [{
      sectionId: 'section:termination',
      heading: 'Termination',
      markdown,
      claimUses: [{
        claimUseId: 'claim-use:termination-conflict',
        claimVersionId,
        useKind: 'conflict-disclosure' as const,
        span: { start: 0, end: [...markdown].length, unit: 'unicode-scalar' as const },
        citationEvidenceIds: ['evidence:termination-support', 'evidence:termination-refute'],
      }],
    }],
  }
  return {
    schemaVersion: 1,
    artifactManifestId: 'artifact-manifest:brief:v1',
    artifactId: 'artifact:brief',
    version: 1,
    workspaceId: WORKSPACE_ID,
    investigationId: INVESTIGATION_ID,
    sourceScopeVersionId: SCOPE_ID,
    kind: 'brief',
    title: 'Termination evidence brief',
    status: 'draft',
    content,
    contentHash: artifactContentHash(content),
    personalizationUseIds: [],
    createdBy: { kind: 'agent', actorId: 'agent:dsh-root' },
    createdAt: '2026-08-31T10:04:00.000Z',
  }
}

function evidenceFixture(): ReadonlyMap<string, M4EvidenceResolution> {
  const values = [
    evidenceAtom('evidence:termination-support', 'Section 8.2 grants termination for convenience.'),
    evidenceAtom('evidence:termination-refute', 'The amendment prohibits termination for convenience.'),
  ]
  return new Map(values.map(evidence => [
    evidence.evidenceId,
    {
      kind: 'evidence-atom' as const,
      workspaceId: WORKSPACE_ID,
      investigationId: INVESTIGATION_ID,
      sourceScopeVersionIds: [SCOPE_ID],
      evidence,
      integrity: 'valid' as const,
    },
  ]))
}

function evidenceAtom(evidenceId: string, text: string): EvidenceAtom {
  return {
    schemaVersion: 1,
    evidenceId,
    documentId: `document:${evidenceId}`,
    revisionId: `revision:${evidenceId}:v1`,
    representationId: `representation:${evidenceId}:markdown`,
    locatorId: `locator:${evidenceId}`,
    kind: 'quote',
    content: { mediaType: 'text/plain', text },
    contentHash: createHash('sha256').update(text).digest('hex'),
    sourceRole: 'primary',
    resolutionStatus: 'resolved',
    status: 'current',
    createdBy: { kind: 'user', actorId: 'user:reviewer' },
    provenanceActivityId: `selection:${evidenceId}`,
    createdAt: T0,
  }
}
