import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  MemoryCandidate,
  MemoryUse,
  PersonalizationCommandRequest,
  PersonalizationObservation,
  PreferenceProbe,
} from '@docatlas/contracts'
import { validateContractShape } from '@docatlas/contracts/node'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PersonalizationStore,
  PersonalizationStoreError,
  personalizationProfileDatabasePath,
} from '../src/storage/personalization-store.ts'

const fixture = JSON.parse(await readFile(
  new URL('../../../contracts/fixtures/m6/personalization.valid.json', import.meta.url),
  'utf8',
)) as {
  explicitObservation: PersonalizationObservation
  inferredObservation: PersonalizationObservation
  candidate: MemoryCandidate
  sensitiveCandidate: MemoryCandidate
  preferenceProbe: PreferenceProbe
  commands: {
    setSessionPolicyRequest: PersonalizationCommandRequest
    setPreferenceRequest: PersonalizationCommandRequest
  }
}

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('PersonalizationStore', () => {
  it('keeps profile state physically separate and compiles a bounded why-used decision', async () => {
    const { root, store } = await testStore()
    const policy = store.command(fixture.commands.setSessionPolicyRequest)
    expect(policy.action).toBe('set-session-policy')
    const replay = store.command(fixture.commands.setSessionPolicyRequest)
    expect(replay.status).toBe('replayed')
    expect(() => store.command({
      ...fixture.commands.setSessionPolicyRequest,
      policy: { useExisting: false, contributeToFuture: true },
    })).toThrowError(expect.objectContaining({ code: 'conflict' }) as PersonalizationStoreError)

    const created = store.command(fixture.commands.setPreferenceRequest)
    expect(created.action).toBe('set-preference')
    if (created.action !== 'set-preference' || created.memoryVersion.status === 'deleted') {
      throw new Error('expected active memory')
    }
    const baseline = sha256('fixed claims + evidence relations + G0-G4 review')
    const decision = store.compileDecision({
      profileId: created.profileId,
      sessionId: fixture.commands.setSessionPolicyRequest.sessionId,
      turn: 3,
      taskContext: {
        mode: 'verify',
        workspaceId: 'workspace:finance',
        investigationId: 'investigation:finance:q4',
        domain: 'finance',
      },
      sourceScopeVersionId: 'scope:finance:q4:v2',
      baselineDigest: baseline,
    })
    expect(decision).toMatchObject({
      effects: [{ key: 'evidence-presentation', value: 'table-context' }],
      why: [{ reason: 'explicit-setting' }],
      factTraceGuard: {
        baselineDigest: baseline,
        evidenceSupportInvariant: true,
        contradictionDisclosureInvariant: true,
        publicationGateInvariant: true,
        sourceScopeInvariant: true,
      },
    })
    if (decision === undefined) throw new Error('expected decision')
    const use: MemoryUse = {
      schemaVersion: 1,
      recordType: 'memory-use',
      memoryUseId: 'memory-use:store:one',
      decisionId: decision.decisionId,
      memoryVersionId: created.memoryVersion.memoryVersionId,
      profileId: created.profileId,
      sessionId: decision.appliesTo.sessionId,
      turn: decision.appliesTo.turn,
      effect: created.memoryVersion.effect,
      affectedActions: ['evidence-context-render'],
      usedAt: '2026-08-31T15:00:00Z',
      outcome: { status: 'unknown', observedAt: '2026-08-31T15:00:01Z' },
    }
    expect(store.recordMemoryUse(use)).toEqual(use)
    expect(store.inspect({
      schemaVersion: 1,
      requestType: 'personalization-inspect',
      profileId: created.profileId,
      sessionId: decision.appliesTo.sessionId,
      maxItems: 10,
    })).toMatchObject({
      resultType: 'personalization-inspection',
      profileId: created.profileId,
      sessionPolicy: { useExisting: true, contributeToFuture: true },
      memories: [{ memoryVersionId: created.memoryVersion.memoryVersionId }],
      decisions: [{ decisionId: decision.decisionId }],
      uses: [{ memoryUseId: use.memoryUseId }],
      counts: { memories: 1, decisions: 1, uses: 1 },
      truncated: { memories: false, decisions: false, uses: false },
    })

    const profiles = join(root, 'profiles')
    expect((await stat(profiles)).mode & 0o777).toBe(0o700)
    expect((await stat(store.databasePath(created.profileId))).mode & 0o777).toBe(0o600)
    expect(store.databasePath(created.profileId)).toContain(`${join(root, 'profiles')}/`)
    expect(store.databasePath(created.profileId)).not.toContain('/investigations/')
    const secondProfileId = 'profile:local-secondary'
    store.command({
      ...fixture.commands.setSessionPolicyRequest,
      profileId: secondProfileId,
      idempotencyKey: 'idempotency:test:second-profile',
    })
    expect(store.databasePath(secondProfileId)).not.toBe(store.databasePath(created.profileId))
    expect((await stat(store.databasePath(secondProfileId))).mode & 0o777).toBe(0o600)
    expect(store.sessionPolicy(secondProfileId, fixture.commands.setSessionPolicyRequest.sessionId))
      ?.toMatchObject({ profileId: secondProfileId })
    store.close()

    const reopened = await PersonalizationStore.open(root, fixedClock())
    expect(reopened.currentMemories(created.profileId)).toHaveLength(1)
    reopened.close()
  })

  it('uses immutable CAS versions for pause, resume, edit, and forget', async () => {
    const { store } = await testStore()
    store.command(fixture.commands.setSessionPolicyRequest)
    const created = store.command(fixture.commands.setPreferenceRequest)
    if (created.action !== 'set-preference') throw new Error('expected memory')
    const first = created.memoryVersion
    const paused = store.command(command({
      action: 'pause',
      memoryVersionId: first.memoryVersionId,
      expectedVersion: 1,
    }, 'pause'))
    expect(paused.action === 'pause' && paused.memoryVersion).toMatchObject({
      version: 2,
      status: 'paused',
      previousMemoryVersionId: first.memoryVersionId,
    })
    expect(() => store.command(command({
      action: 'pause',
      memoryVersionId: first.memoryVersionId,
      expectedVersion: 1,
    }, 'stale-pause'))).toThrowError(expect.objectContaining({ code: 'conflict' }) as PersonalizationStoreError)
    if (paused.action !== 'pause') throw new Error('expected pause')
    const resumed = store.command(command({
      action: 'resume',
      memoryVersionId: paused.memoryVersion.memoryVersionId,
      expectedVersion: 2,
    }, 'resume'))
    if (resumed.action !== 'resume') throw new Error('expected resume')
    expect(resumed.memoryVersion).toMatchObject({ version: 3, status: 'active' })
    const edited = store.command(command({
      action: 'edit',
      memoryVersionId: resumed.memoryVersion.memoryVersionId,
      expectedVersion: 3,
      replacement: {
        memoryType: 'evidence-preference',
        effect: { key: 'evidence-presentation', value: 'quote' },
        summary: 'Show exact quotes for key figures.',
        scope: {
          kind: 'workspace',
          profileId: 'profile:local-default',
          workspaceId: 'workspace:finance',
        },
        sensitivity: 'ordinary',
        policy: { apply: 'disclose' },
      },
      statusAfterEdit: 'active',
    }, 'edit'))
    if (edited.action !== 'edit') throw new Error('expected edit')
    expect(edited.memoryVersion).toMatchObject({
      version: 4,
      effect: { key: 'evidence-presentation', value: 'quote' },
    })
    const forgotten = store.command(command({
      action: 'forget',
      target: 'memory-chain',
      memoryVersionId: edited.memoryVersion.memoryVersionId,
      expectedVersion: 4,
      mode: 'memory-only',
      provenanceHandling: 'orphan',
      acknowledgeExternalRetention: true,
    }, 'forget'))
    expect(forgotten).toMatchObject({
      action: 'forget',
      status: 'completed',
      receipt: {
        activeProjectionRemoved: true,
        sessionLogChanged: false,
        providerCopiesChanged: false,
      },
    })
    expect(store.currentMemories(first.profileId)).toEqual([
      expect.objectContaining({ status: 'deleted', version: 5 }),
    ])
    expect(store.compileDecision({
      profileId: first.profileId,
      sessionId: fixture.commands.setSessionPolicyRequest.sessionId,
      turn: 5,
      taskContext: { mode: 'verify', workspaceId: 'workspace:finance' },
      sourceScopeVersionId: 'scope:finance:q4:v2',
      baselineDigest: sha256('same facts'),
    })).toBeUndefined()
    store.close()
  })

  it('retracts unused decisions while retaining completed use history across lifecycle changes', async () => {
    const { root, store } = await testStore()
    store.command(fixture.commands.setSessionPolicyRequest)
    const created = store.command(fixture.commands.setPreferenceRequest)
    if (created.action !== 'set-preference' || created.memoryVersion.status === 'deleted') {
      throw new Error('expected active memory')
    }
    const decisionInput = {
      profileId: created.profileId,
      sessionId: fixture.commands.setSessionPolicyRequest.sessionId,
      turn: 4,
      taskContext: { mode: 'verify' as const, workspaceId: 'workspace:finance' },
      sourceScopeVersionId: 'scope:finance:q4:v2',
      baselineDigest: sha256('immutable fact trace'),
    }
    expect(store.compileDecision(decisionInput)).toBeDefined()
    const paused = store.command(command({
      action: 'pause',
      memoryVersionId: created.memoryVersion.memoryVersionId,
      expectedVersion: 1,
    }, 'decision-pause'))
    if (paused.action !== 'pause') throw new Error('expected pause')
    store.close()

    const databasePath = personalizationProfileDatabasePath(join(root, 'profiles'), created.profileId)
    const afterPause = new DatabaseSync(databasePath, { readOnly: true })
    expect(afterPause.prepare('SELECT COUNT(*) AS count FROM personalization_decisions').get())
      .toMatchObject({ count: 0 })
    afterPause.close()

    const reopened = await PersonalizationStore.open(root, fixedClock())
    const resumed = reopened.command(command({
      action: 'resume',
      memoryVersionId: paused.memoryVersion.memoryVersionId,
      expectedVersion: 2,
    }, 'decision-resume'))
    if (resumed.action !== 'resume' || resumed.memoryVersion.status === 'deleted') {
      throw new Error('expected resumed memory')
    }
    const resumedEffect = resumed.memoryVersion.effect
    const usedDecision = reopened.compileDecision(decisionInput)
    if (usedDecision === undefined) throw new Error('expected decision')
    reopened.recordMemoryUse({
      schemaVersion: 1,
      recordType: 'memory-use',
      memoryUseId: 'memory-use:lifecycle:completed',
      decisionId: usedDecision.decisionId,
      memoryVersionId: resumed.memoryVersion.memoryVersionId,
      profileId: resumed.profileId,
      sessionId: usedDecision.appliesTo.sessionId,
      turn: usedDecision.appliesTo.turn,
      effect: resumedEffect,
      affectedActions: ['evidence-context-render'],
      usedAt: '2026-08-31T15:00:00Z',
      outcome: { status: 'accepted', observedAt: '2026-08-31T15:00:01Z' },
    })
    const edited = reopened.command(command({
      action: 'edit',
      memoryVersionId: resumed.memoryVersion.memoryVersionId,
      expectedVersion: 3,
      replacement: {
        memoryType: 'evidence-preference',
        effect: { key: 'evidence-presentation', value: 'quote' },
        summary: 'Show exact quotes for key figures.',
        scope: {
          kind: 'workspace',
          profileId: created.profileId,
          workspaceId: 'workspace:finance',
        },
        sensitivity: 'ordinary',
        policy: { apply: 'disclose' },
      },
      statusAfterEdit: 'active',
    }, 'decision-edit'))
    if (edited.action !== 'edit') throw new Error('expected edit')
    reopened.command(command({
      action: 'forget',
      target: 'memory-chain',
      memoryVersionId: edited.memoryVersion.memoryVersionId,
      expectedVersion: 4,
      mode: 'memory-only',
      provenanceHandling: 'orphan',
      acknowledgeExternalRetention: true,
    }, 'decision-forget'))
    expect(() => reopened.recordMemoryUse({
      schemaVersion: 1,
      recordType: 'memory-use',
      memoryUseId: 'memory-use:lifecycle:stale',
      decisionId: usedDecision.decisionId,
      memoryVersionId: resumed.memoryVersion.memoryVersionId,
      profileId: resumed.profileId,
      sessionId: usedDecision.appliesTo.sessionId,
      turn: usedDecision.appliesTo.turn,
      effect: resumedEffect,
      affectedActions: ['evidence-context-render'],
      usedAt: '2026-08-31T15:00:02Z',
    })).toThrowError(expect.objectContaining({ code: 'conflict' }) as PersonalizationStoreError)
    reopened.close()

    const history = new DatabaseSync(databasePath, { readOnly: true })
    expect(history.prepare('SELECT COUNT(*) AS count FROM personalization_decisions').get())
      .toMatchObject({ count: 1 })
    expect(history.prepare('SELECT COUNT(*) AS count FROM personalization_memory_uses').get())
      .toMatchObject({ count: 1 })
    history.close()
    const verified = await PersonalizationStore.open(root, fixedClock())
    expect(verified.currentMemories(created.profileId)).toEqual([
      expect.objectContaining({ status: 'deleted', version: 5 }),
    ])
    verified.close()
  })

  it('expires a preference from recall using its bounded retention policy', async () => {
    const root = await makeRoot()
    let now = new Date('2026-08-31T15:00:00Z')
    const store = await PersonalizationStore.open(root, () => now)
    store.command(fixture.commands.setSessionPolicyRequest)
    const preferenceRequest = fixture.commands.setPreferenceRequest
    if (preferenceRequest.action !== 'set-preference') throw new Error('expected preference request fixture')
    const created = store.command({
      ...preferenceRequest,
      idempotencyKey: 'idempotency:test:expiring-preference',
      preference: {
        ...preferenceRequest.preference,
        policy: { apply: 'disclose', expiresAfterDays: 1 },
      },
    })
    if (created.action !== 'set-preference' || created.memoryVersion.status === 'deleted') {
      throw new Error('expected active memory')
    }
    expect(created.memoryVersion.validTime.until).toBe('2026-09-01T15:00:00.000Z')
    const input = {
      profileId: created.profileId,
      sessionId: fixture.commands.setSessionPolicyRequest.sessionId,
      turn: 2,
      taskContext: { mode: 'verify' as const, workspaceId: 'workspace:finance' },
      sourceScopeVersionId: 'scope:finance:q4:v2',
      baselineDigest: sha256('fixed fact trace'),
    }
    expect(store.compileDecision(input)).toBeDefined()
    now = new Date('2026-09-01T15:00:00.000Z')
    expect(store.compileDecision({ ...input, turn: 3 })).toBeUndefined()
    store.close()
  })

  it('requires governed observations before candidate promotion and enforces one auto probe', async () => {
    const { store } = await testStore()
    store.command(fixture.commands.setSessionPolicyRequest)
    store.recordObservation(fixture.explicitObservation)
    const pending = structuredClone(fixture.candidate) as MemoryCandidate
    pending.decision = 'pending'
    delete pending.decidedBy
    delete pending.decidedAt
    expect(store.recordCandidate(pending)).toEqual(pending)
    const promoted = store.command(command({
      action: 'review-candidate',
      candidateId: pending.candidateId,
      expectedVersion: 1,
      decision: 'accept',
    }, 'candidate-accept'))
    expect(promoted).toMatchObject({
      action: 'review-candidate',
      candidate: { version: 2, decision: 'promote' },
      memoryVersion: { version: 1, status: 'active' },
    })

    store.recordObservation(fixture.inferredObservation)
    expect(store.recordCandidate(fixture.sensitiveCandidate)).toEqual(fixture.sensitiveCandidate)
    expect(() => store.command(command({
      action: 'review-candidate',
      candidateId: fixture.sensitiveCandidate.candidateId,
      expectedVersion: 1,
      decision: 'accept',
    }, 'sensitive-accept'))).toThrowError(expect.objectContaining({
      code: 'invalid-request',
    }) as PersonalizationStoreError)

    expect(store.recordProbe(fixture.preferenceProbe)).toEqual(fixture.preferenceProbe)
    const second = structuredClone(fixture.preferenceProbe) as PreferenceProbe
    second.probeId = 'probe:answer-order:second'
    expect(() => store.recordProbe(second)).toThrowError(expect.objectContaining({
      code: 'limit-exceeded',
    }) as PersonalizationStoreError)
    const requested = structuredClone(second) as PreferenceProbe
    requested.probeId = 'probe:answer-order:user-requested'
    requested.trigger = 'user-requested'
    delete requested.investigationId
    delete requested.automaticOrdinal
    expect(store.recordProbe(requested)).toEqual(requested)
    store.close()
  })

  it('records an explicitly reviewed candidate replacement as the promoted proposal', async () => {
    const { store } = await testStore()
    store.command(fixture.commands.setSessionPolicyRequest)
    store.recordObservation(fixture.explicitObservation)
    const pending = structuredClone(fixture.candidate) as MemoryCandidate
    pending.decision = 'pending'
    delete pending.decidedBy
    delete pending.decidedAt
    store.recordCandidate(pending)
    const promoted = store.command(command({
      action: 'review-candidate',
      candidateId: pending.candidateId,
      expectedVersion: 1,
      decision: 'accept',
      replacement: {
        memoryType: 'evidence-preference',
        effect: { key: 'evidence-presentation', value: 'quote' },
        summary: 'Show exact quotes for key figures.',
        scope: pending.proposedScope,
        sensitivity: 'ordinary',
        policy: { apply: 'disclose' },
      },
    }, 'candidate-replacement'))
    expect(promoted).toMatchObject({
      action: 'review-candidate',
      candidate: {
        proposedEffect: { key: 'evidence-presentation', value: 'quote' },
      },
      memoryVersion: {
        effect: { key: 'evidence-presentation', value: 'quote' },
        summary: 'Show exact quotes for key figures.',
      },
    })
    store.close()
  })

  it('exports only governed profile state and physically erases DocAtlas-owned copies', async () => {
    const { root, store } = await testStore()
    store.command(fixture.commands.setSessionPolicyRequest)
    const created = store.command(fixture.commands.setPreferenceRequest)
    if (created.action !== 'set-preference' || created.memoryVersion.status === 'deleted') {
      throw new Error('expected memory')
    }
    const exported = store.command(command({
      action: 'export',
      format: 'json',
      includeProvenanceRefs: true,
      includeStatuses: ['active', 'paused', 'disputed', 'superseded', 'expired', 'archived'],
    }, 'export'))
    if (exported.action !== 'export') throw new Error('expected export')
    const asset = store.exportAsset(created.profileId, exported.export.assetId)
    const text = asset.bytes.toString('utf8')
    expect(text).toContain('Show key figures with their table context.')
    expect(text).not.toContain('documentText')
    expect(text).not.toContain('sourceText')
    expect(text).not.toContain('evidenceRelation')
    expect(text).not.toContain('"path"')
    const exportPath = join(
      root,
      'profiles',
      'exports',
      sha256(created.profileId),
      `${sha256(exported.export.assetId)}.json`,
    )
    expect((await stat(exportPath)).mode & 0o777).toBe(0o600)
    const orphanExportPath = join(root, 'profiles', 'exports', sha256(created.profileId), 'orphan.tmp')
    await writeFile(orphanExportPath, 'interrupted export must be erased', { mode: 0o600 })

    const eraseRequest = command({
      action: 'forget',
      target: 'profile',
      expectedProfileRevision: store.ledgerRevision(created.profileId),
      mode: 'privacy-erasure',
      provenanceHandling: 'redact-derived-excerpts',
      acknowledgeExternalRetention: true,
    }, 'erase-profile')
    const erased = store.command(eraseRequest)
    expect(erased).toMatchObject({
      action: 'forget',
      status: 'completed',
      receipt: {
        mode: 'privacy-erasure',
        backupDisposition: 'compacted',
        sessionLogChanged: false,
        providerCopiesChanged: false,
      },
    })
    expect(store.command(eraseRequest).status).toBe('replayed')
    expect(store.currentMemories(created.profileId)).toEqual([])
    expect(store.sessionPolicy(created.profileId, fixture.commands.setSessionPolicyRequest.sessionId))
      .toBeUndefined()
    expect(() => store.exportAsset(created.profileId, exported.export.assetId)).toThrowError(
      expect.objectContaining({ code: 'not-found' }) as PersonalizationStoreError,
    )
    await expect(stat(exportPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(orphanExportPath)).rejects.toMatchObject({ code: 'ENOENT' })
    try {
      expect((await stat(`${store.databasePath(created.profileId)}-wal`)).size).toBe(0)
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENOENT' })
    }
    store.close()
  })

  it('fails privacy erasure closed when a managed profile backup is corrupt', async () => {
    const { root, store } = await testStore()
    store.command(fixture.commands.setSessionPolicyRequest)
    const created = store.command(fixture.commands.setPreferenceRequest)
    if (created.action !== 'set-preference') throw new Error('expected memory')
    const corruptBackup = join(
      root,
      'profiles',
      'backups',
      `${sha256(created.profileId)}.corrupt.sqlite3`,
    )
    await writeFile(corruptBackup, 'not a SQLite database', { mode: 0o600 })
    expect(() => store.command(command({
      action: 'forget',
      target: 'profile',
      expectedProfileRevision: store.ledgerRevision(created.profileId),
      mode: 'privacy-erasure',
      provenanceHandling: 'orphan',
      acknowledgeExternalRetention: true,
    }, 'corrupt-backup-erase'))).toThrowError(expect.objectContaining({
      code: 'integrity-error',
      message: 'personalization storage operation failed',
    }) as PersonalizationStoreError)
    expect(store.currentMemories(created.profileId)).toHaveLength(1)
    await expect(stat(corruptBackup)).resolves.toBeDefined()
    store.close()
  })

  it('migrates v0 with a private backup and rejects newer schemas or journal tampering', async () => {
    const root = await makeRoot()
    const profilesRoot = join(root, 'profiles')
    const bootstrap = await PersonalizationStore.open(root, fixedClock())
    bootstrap.close()
    const legacyProfile = 'profile:legacy'
    const legacyPath = personalizationProfileDatabasePath(profilesRoot, legacyProfile)
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`
      CREATE TABLE personalization_metadata(
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        ledger_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    legacy.prepare(`
      INSERT INTO personalization_metadata VALUES (1, 0, ?, 0, ?)
    `).run(legacyProfile, '2026-08-31T00:00:00Z')
    legacy.close()
    const migrated = await PersonalizationStore.open(root, fixedClock())
    expect(migrated.currentMemories(legacyProfile)).toEqual([])
    const backups = await readdir(join(profilesRoot, 'backups'))
    expect(backups.some(name => name.startsWith(`${sha256(legacyProfile)}.v0.`))).toBe(true)
    migrated.command({
      ...fixture.commands.setSessionPolicyRequest,
      profileId: legacyProfile,
      idempotencyKey: 'idempotency:test:legacy-policy',
    })
    migrated.command({
      schemaVersion: 1,
      requestType: 'personalization-command',
      profileId: legacyProfile,
      sessionId: fixture.commands.setSessionPolicyRequest.sessionId,
      idempotencyKey: 'idempotency:test:legacy-erasure',
      actor: { kind: 'user', actorId: 'user:local' },
      action: 'forget',
      target: 'profile',
      expectedProfileRevision: migrated.ledgerRevision(legacyProfile),
      mode: 'privacy-erasure',
      provenanceHandling: 'orphan',
      acknowledgeExternalRetention: true,
    })
    expect((await readdir(join(profilesRoot, 'backups')))
      .some(name => name.startsWith(`${sha256(legacyProfile)}.`))).toBe(false)
    migrated.close()

    const newerProfile = 'profile:newer'
    const newerPath = personalizationProfileDatabasePath(profilesRoot, newerProfile)
    const newer = new DatabaseSync(newerPath)
    newer.exec(`
      CREATE TABLE personalization_metadata(
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        ledger_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    newer.prepare('INSERT INTO personalization_metadata VALUES (1, 2, ?, 0, ?)')
      .run(newerProfile, '2026-08-31T00:00:00Z')
    newer.close()
    const rejected = await PersonalizationStore.open(root, fixedClock())
    expect(() => rejected.currentMemories(newerProfile)).toThrowError(expect.objectContaining({
      code: 'integrity-error',
    }) as PersonalizationStoreError)
    rejected.close()

    const healthy = await PersonalizationStore.open(root, fixedClock())
    healthy.command(fixture.commands.setSessionPolicyRequest)
    const path = healthy.databasePath('profile:local-default')
    healthy.close()
    const tampered = new DatabaseSync(path)
    tampered.prepare("UPDATE personalization_journal SET event_hash = ? WHERE event_seq = 1")
      .run('0'.repeat(64))
    tampered.close()
    const reopened = await PersonalizationStore.open(root, fixedClock())
    expect(() => reopened.currentMemories('profile:local-default')).toThrowError(
      expect.objectContaining({ code: 'integrity-error' }) as PersonalizationStoreError,
    )
    reopened.close()
  })

  it('keeps the same Claim/Evidence/Review backbone with personalization off and on', async () => {
    const { store } = await testStore()
    const backbone = {
      sourceScopeVersionId: 'scope:fixed:v1',
      claimVersionIds: ['claim:fixed:v1'],
      evidenceRelationIds: ['relation:fixed:v1'],
      reviewResultId: 'review:fixed:v1',
      gateStatuses: ['pass', 'pass', 'pass', 'pass', 'needs-human'],
    }
    const before = structuredClone(backbone)
    const digest = sha256(JSON.stringify(backbone))
    expect(store.compileDecision({
      profileId: 'profile:local-default',
      sessionId: 'session:personalization:one',
      turn: 1,
      taskContext: { mode: 'verify', workspaceId: 'workspace:finance' },
      sourceScopeVersionId: backbone.sourceScopeVersionId,
      baselineDigest: digest,
    })).toBeUndefined()
    store.command(fixture.commands.setSessionPolicyRequest)
    store.command(fixture.commands.setPreferenceRequest)
    const decision = store.compileDecision({
      profileId: 'profile:local-default',
      sessionId: 'session:personalization:one',
      turn: 1,
      taskContext: { mode: 'verify', workspaceId: 'workspace:finance' },
      sourceScopeVersionId: backbone.sourceScopeVersionId,
      baselineDigest: digest,
    })
    expect(backbone).toEqual(before)
    expect(decision?.factTraceGuard).toMatchObject({
      baselineDigest: digest,
      evidenceSupportInvariant: true,
      contradictionDisclosureInvariant: true,
      publicationGateInvariant: true,
      sourceScopeInvariant: true,
    })
    expect(validateContractShape('personalization-core', decision).ok).toBe(true)
    expect(JSON.stringify(decision)).not.toContain('evidenceRelationIds')
    expect(JSON.stringify(decision)).not.toContain('gateStatuses')
    store.close()
  })
})

async function testStore(): Promise<{ root: string, store: PersonalizationStore }> {
  const root = await makeRoot()
  return { root, store: await PersonalizationStore.open(root, fixedClock()) }
}

async function makeRoot(): Promise<string> {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => (
    mkdtemp(join(tmpdir(), 'docatlas-personalization-'))
  ))
  roots.push(root)
  return root
}

function fixedClock(): () => Date {
  return () => new Date('2026-08-31T15:00:00Z')
}

type CommandBody<T = PersonalizationCommandRequest> = T extends PersonalizationCommandRequest ? Omit<T, keyof CommandBase> : never

function command(
  body: CommandBody,
  key: string,
): PersonalizationCommandRequest {
  return {
    schemaVersion: 1,
    requestType: 'personalization-command',
    profileId: 'profile:local-default',
    sessionId: 'session:personalization:one',
    idempotencyKey: `idempotency:test:${key}`,
    actor: { kind: 'user', actorId: 'user:local' },
    ...body,
  }
}

interface CommandBase {
  schemaVersion: 1
  requestType: 'personalization-command'
  profileId: string
  sessionId: string
  idempotencyKey: string
  actor: { kind: 'user', actorId: string }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
