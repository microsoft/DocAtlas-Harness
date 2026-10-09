import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AnswerManifest,
  LibraryDocument,
  LibraryImportRequest,
  LibraryJobResult,
  ResearchRecallRequest,
  ResearchRecordRequest,
  ResearchLifecycleRequest,
  SelectionActionRequest,
  SelectionActionResult,
  SelectionContext,
  SourceScopeBindRequest,
  SourceScopeCommitRequest,
  SourceScopeUnbindRequest,
} from '@docatlas/contracts'
import { validateContractShape } from '@docatlas/contracts/node'
import { describe, expect, it } from 'vitest'

import { SourceScopeStore, SourceScopeStoreError } from '../src/storage/source-scope-store.ts'

interface Fixture {
  commitRequest: SourceScopeCommitRequest
  bindRequest: SourceScopeBindRequest
  unbindRequest: SourceScopeUnbindRequest
}

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/source-scope.json', import.meta.url),
  'utf8',
)) as Fixture
const libraryFixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/library.json', import.meta.url),
  'utf8',
)) as { document: LibraryDocument }
const answerFixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/answer-manifest.json', import.meta.url),
  'utf8',
)) as { manifest: AnswerManifest }
const selectionFixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/selection.json', import.meta.url),
  'utf8',
)) as {
  context: SelectionContext
  actionRequest: SelectionActionRequest
  actionResult: SelectionActionResult
}

describe('SourceScopeStore', () => {
  it('journals explicit selection actions without persisting cancellation authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-selection-actions-'))
    let store = await SourceScopeStore.open(root)
    const workspaceId = selectionFixture.context.workspaceId
    const workspacePath = join(
      root,
      'investigations',
      `${createHash('sha256').update(workspaceId).digest('hex')}.sqlite3`,
    )
    try {
      expect(store.recordSelectionAction(
        workspaceId,
        selectionFixture.actionRequest,
        selectionFixture.context,
        selectionFixture.actionResult,
      ).status).toBe('created')
      expect(store.recordSelectionAction(
        workspaceId,
        selectionFixture.actionRequest,
        selectionFixture.context,
        selectionFixture.actionResult,
      ).status).toBe('replayed')
      expect(store.listSelectionActions(
        workspaceId,
        selectionFixture.context.investigationId,
      )).toEqual([selectionFixture.actionResult])
      expect(() => store.replaySelectionAction(workspaceId, {
        ...selectionFixture.actionRequest,
        selectionContextId: 'selection-context:different',
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)
      store.close()

      const database = new DatabaseSync(workspacePath)
      const row = database.prepare(`
        SELECT request_hash, result_json, context_json FROM selection_actions
      `).get() as Record<string, unknown>
      const journal = database.prepare(`
        SELECT payload_json FROM journal_events WHERE event_type = 'selection-action.recorded'
      `).get() as Record<string, unknown>
      expect(JSON.stringify({ row, journal })).not.toContain(selectionFixture.actionRequest.nonce)
      database.close()

      store = await SourceScopeStore.open(root)
      expect(store.listSelectionActions(
        workspaceId,
        selectionFixture.context.investigationId,
      )).toEqual([selectionFixture.actionResult])
      store.close()
      const tampered = new DatabaseSync(workspacePath)
      tampered.prepare("UPDATE selection_actions SET result_json = '{}'").run()
      tampered.close()
      store = await SourceScopeStore.open(root)
      expect(() => store.listSelectionActions(
        workspaceId,
        selectionFixture.context.investigationId,
      )).toThrowError(expect.objectContaining({ code: 'integrity-error' }) as SourceScopeStoreError)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recalls bounded cross-Session leads and rebuilds the disposable FTS projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-research-recall-'))
    let store = await SourceScopeStore.open(root)
    const workspaceId = selectionFixture.context.workspaceId
    const source = selectionFixture.actionResult.locators[0]!
    const currentSources = [{
      documentId: source.documentId,
      revisionId: source.revisionId,
      representationId: source.representationId,
      representationContentHash: source.representationContentHash,
    }]
    const request: ResearchRecallRequest = {
      schemaVersion: 1,
      requestType: 'research-recall',
      sessionId: 'session:recall:later',
      workspaceId,
      investigationId: 'investigation:later',
      scopeVersionId: 'scope:later:1',
      query: 'evidence bookmark',
      recordTypes: ['evidence-bookmark', 'research-note', 'open-question', 'claim-proposal'],
      limits: { maxItems: 10, maxChars: 1000 },
    }
    const workspacePath = join(
      root,
      'investigations',
      `${createHash('sha256').update(workspaceId).digest('hex')}.sqlite3`,
    )
    try {
      store.recordSelectionAction(
        workspaceId,
        selectionFixture.actionRequest,
        selectionFixture.context,
        selectionFixture.actionResult,
      )
      const recalled = store.recallResearch(request, currentSources)
      expect(recalled).toMatchObject({
        workspaceId,
        investigationId: 'investigation:later',
        leads: [{
          recordId: 'bookmark:northstar:revenue',
          recordType: 'evidence-bookmark',
          sourceSessionId: selectionFixture.context.sessionId,
          sourceInvestigationId: selectionFixture.context.investigationId,
          sourceState: 'current-scope',
          verificationStatus: 'unverified-lead',
        }],
        pageInfo: { returned: 1, total: 1, truncated: false },
      })
      expect(JSON.stringify(recalled)).not.toContain('USD 15.2 million')
      expect(store.recallResearch({ ...request, query: 'million' }, currentSources).leads)
        .toEqual([])
      expect(store.recallResearch(request, []).leads[0]?.sourceState)
        .toBe('outside-current-scope')

      store.close()
      const damaged = new DatabaseSync(workspacePath)
      damaged.exec('DELETE FROM research_recall_fts; DELETE FROM research_recall_records;')
      damaged.prepare("UPDATE metadata SET value = '3' WHERE key = 'schema_version'").run()
      damaged.close()

      store = await SourceScopeStore.open(root)
      expect(store.recallResearch(request, currentSources).leads).toHaveLength(1)
      store.close()
      const migrated = new DatabaseSync(workspacePath, { readOnly: true })
      expect(migrated.prepare(
        "SELECT value FROM metadata WHERE key = 'schema_version'",
      ).get()).toMatchObject({ value: '6' })
      expect(migrated.prepare('SELECT count(*) AS count FROM research_recall_records').get())
        .toMatchObject({ count: 1 })
      migrated.close()
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('journals Agent checkpoints as unverified typed records with idempotent recall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-research-record-'))
    let store = await SourceScopeStore.open(root)
    const request: ResearchRecordRequest = {
      schemaVersion: 1,
      requestType: 'research-record',
      sessionId: 'session:record:one',
      workspaceId: 'workspace:record',
      investigationId: 'investigation:record:one',
      scopeVersionId: 'scope:record:1',
      callId: 'call:record:one',
      idempotencyKey: 'idempotency:record:one',
      kind: 'checkpoint',
      body: 'Audit margin definition remains unverified.',
    }
    const workspacePath = join(
      root,
      'investigations',
      `${createHash('sha256').update(request.workspaceId).digest('hex')}.sqlite3`,
    )
    try {
      const created = store.recordResearch(request)
      expect(created).toMatchObject({
        status: 'created',
        record: {
          recordType: 'research-note',
          noteKind: 'checkpoint',
          epistemicStatus: 'unverified',
          createdBy: { kind: 'agent', actorId: request.sessionId },
        },
      })
      expect(store.recordResearch(request)).toEqual({ ...created, status: 'replayed' })
      expect(() => store.recordResearch({
        ...request,
        body: 'Conflicting reuse',
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)
      const recalled = store.recallResearch({
        schemaVersion: 1,
        requestType: 'research-recall',
        sessionId: 'session:record:two',
        workspaceId: request.workspaceId,
        investigationId: 'investigation:record:two',
        scopeVersionId: 'scope:record:2',
        query: 'margin definition',
        recordTypes: ['research-note'],
        limits: { maxItems: 8, maxChars: 1000 },
      }, [])
      expect(recalled.leads).toEqual([expect.objectContaining({
        recordId: created.record.recordId,
        sourceSessionId: request.sessionId,
        sourceInvestigationId: request.investigationId,
        preview: request.body,
        sourceState: 'none',
        verificationStatus: 'unverified-lead',
      })])
      const edit: ResearchLifecycleRequest = {
        schemaVersion: 1,
        requestType: 'research-record-lifecycle',
        sessionId: 'session:record:one',
        workspaceId: request.workspaceId,
        investigationId: request.investigationId,
        scopeVersionId: request.scopeVersionId,
        recordId: created.record.recordId,
        expectedVersion: 1,
        idempotencyKey: 'idempotency:record:edit',
        action: 'edit',
        text: 'Corrected margin definition remains unverified.',
      }
      expect(store.transitionResearchRecord(edit)).toMatchObject({
        status: 'updated',
        state: { version: 2, previousVersion: 1, status: 'active', text: edit.text },
      })
      expect(store.transitionResearchRecord(edit).status).toBe('replayed')
      expect(() => store.transitionResearchRecord({
        ...edit,
        idempotencyKey: 'idempotency:record:stale',
        text: 'stale edit',
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)
      expect(store.recallResearch({
        schemaVersion: 1,
        requestType: 'research-recall',
        sessionId: 'session:record:two',
        workspaceId: request.workspaceId,
        investigationId: 'investigation:record:two',
        scopeVersionId: 'scope:record:2',
        query: 'corrected margin',
        recordTypes: ['research-note'],
        limits: { maxItems: 8, maxChars: 1000 },
      }, []).leads[0]).toMatchObject({ preview: edit.text, recordStatus: 'active' })
      const archived = store.transitionResearchRecord({
        ...edit,
        expectedVersion: 2,
        idempotencyKey: 'idempotency:record:archive',
        action: 'archive',
        text: undefined,
      })
      expect(archived.state).toMatchObject({ version: 3, status: 'archived' })
      const deleted = store.transitionResearchRecord({
        ...edit,
        expectedVersion: 3,
        idempotencyKey: 'idempotency:record:delete',
        action: 'delete',
        text: undefined,
      })
      expect(deleted.state).toMatchObject({ version: 4, status: 'deleted' })
      expect(deleted.state).not.toHaveProperty('text')
      expect(store.recallResearch({
        schemaVersion: 1,
        requestType: 'research-recall',
        sessionId: 'session:record:two',
        workspaceId: request.workspaceId,
        investigationId: 'investigation:record:two',
        scopeVersionId: 'scope:record:2',
        query: 'corrected margin',
        recordTypes: ['research-note'],
        limits: { maxItems: 8, maxChars: 1000 },
      }, []).leads).toEqual([])
      const backup = await store.backupWorkspace(request.workspaceId)
      expect(backup).toMatchObject({ workspaceId: request.workspaceId })
      expect(backup.byteLength).toBeGreaterThan(0)
      if (process.platform !== 'win32') expect(statSync(backup.path).mode & 0o777).toBe(0o600)
      const backupDatabase = new DatabaseSync(backup.path, { readOnly: true })
      expect(backupDatabase.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' })
      expect(backupDatabase.prepare('SELECT count(*) AS count FROM research_records').get())
        .toMatchObject({ count: 1 })
      backupDatabase.close()
      store.close()
      store = await SourceScopeStore.open(root)
      expect(store.recordResearch(request).status).toBe('replayed')
      expect(() => store.transitionResearchRecord({
        ...edit,
        expectedVersion: 4,
        idempotencyKey: 'idempotency:record:after-delete',
        action: 'archive',
        text: undefined,
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)
      store.close()
      const tampered = new DatabaseSync(workspacePath)
      tampered.prepare("UPDATE research_records SET record_json = '{}'").run()
      tampered.close()
      store = await SourceScopeStore.open(root)
      expect(() => store.recordResearch(request)).toThrowError(expect.objectContaining({
        code: 'integrity-error',
      }) as SourceScopeStoreError)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('versions and retracts selection-authored Research Notes through their action aggregate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-selection-record-lifecycle-'))
    let store = await SourceScopeStore.open(root)
    const workspacePath = join(
      root,
      'investigations',
      `${createHash('sha256').update(selectionFixture.context.workspaceId).digest('hex')}.sqlite3`,
    )
    const request: SelectionActionRequest = {
      ...selectionFixture.actionRequest,
      idempotencyKey: 'selection-action:northstar:note',
      action: 'create-note',
      noteKind: 'commentary',
      body: 'Initial margin interpretation.',
    }
    const result: SelectionActionResult = {
      ...selectionFixture.actionResult,
      actionId: 'selection-action-result:northstar:note',
      action: 'create-note',
      evidence: selectionFixture.actionResult.evidence.map(evidence => ({
        ...evidence,
        provenanceActivityId: 'selection-action-result:northstar:note',
      })),
      record: {
        schemaVersion: 1,
        recordType: 'research-note',
        noteId: 'note:northstar:margin',
        version: 1,
        noteKind: 'commentary',
        body: request.body,
        status: 'active',
        workspaceId: selectionFixture.context.workspaceId,
        investigationId: selectionFixture.context.investigationId,
        selectionContextId: selectionFixture.context.selectionContextId,
        evidenceIds: selectionFixture.actionResult.evidence.map(evidence => evidence.evidenceId),
        locatorIds: selectionFixture.actionResult.locators.map(locator => locator.locatorId),
        createdBy: { kind: 'user', actorId: 'user:northstar' },
        createdAt: '2026-08-31T12:30:00Z',
      },
    }
    try {
      store.recordSelectionAction(
        selectionFixture.context.workspaceId,
        request,
        selectionFixture.context,
        result,
      )
      store.recordSelectionAction(
        selectionFixture.context.workspaceId,
        selectionFixture.actionRequest,
        selectionFixture.context,
        selectionFixture.actionResult,
      )
      const questionActionId = 'selection-action-result:northstar:question'
      const questionRequest: SelectionActionRequest = {
        ...selectionFixture.actionRequest,
        idempotencyKey: 'selection-action:northstar:question',
        action: 'open-question',
        question: 'Which audited margin definition applies?',
      }
      const questionResult: SelectionActionResult = {
        ...selectionFixture.actionResult,
        actionId: questionActionId,
        action: 'open-question',
        evidence: selectionFixture.actionResult.evidence.map(evidence => ({
          ...evidence,
          provenanceActivityId: questionActionId,
        })),
        record: {
          schemaVersion: 1,
          recordType: 'open-question',
          questionId: 'question:northstar:margin',
          version: 1,
          question: questionRequest.question,
          status: 'open',
          workspaceId: selectionFixture.context.workspaceId,
          investigationId: selectionFixture.context.investigationId,
          selectionContextId: selectionFixture.context.selectionContextId,
          evidenceIds: selectionFixture.actionResult.evidence.map(evidence => evidence.evidenceId),
          locatorIds: selectionFixture.actionResult.locators.map(locator => locator.locatorId),
          createdBy: { kind: 'user', actorId: 'user:northstar' },
          createdAt: '2026-08-31T12:31:00Z',
        },
      }
      store.recordSelectionAction(
        selectionFixture.context.workspaceId,
        questionRequest,
        selectionFixture.context,
        questionResult,
      )
      expect(store.transitionResearchRecord({
        schemaVersion: 1,
        requestType: 'research-record-lifecycle',
        sessionId: selectionFixture.context.sessionId,
        workspaceId: selectionFixture.context.workspaceId,
        investigationId: selectionFixture.context.investigationId,
        scopeVersionId: selectionFixture.context.scopeVersionId,
        recordId: 'question:northstar:margin',
        expectedVersion: 1,
        idempotencyKey: 'idempotency:selection-question:resolve',
        action: 'resolve',
      }).state.status).toBe('resolved')
      const overlayRequest = {
        schemaVersion: 1 as const,
        requestType: 'tree-overlay-get' as const,
        sessionId: 'session:northstar:later',
        workspaceId: selectionFixture.context.workspaceId,
        investigationId: 'investigation:northstar:later',
        scopeVersionId: 'scope:northstar:later',
        source: {
          documentId: result.locators[0]!.documentId,
          revisionId: result.locators[0]!.revisionId,
          representationId: result.locators[0]!.representationId,
          representationContentHash: result.locators[0]!.representationContentHash,
        },
        physicalPage: result.locators[0]!.physicalPage,
        recordTypes: ['research-note' as const],
        limits: { maxItems: 20, maxChars: 1000 },
      }
      expect(store.treeOverlay(overlayRequest)).toMatchObject({
        items: [{
          recordId: 'note:northstar:margin',
          preview: request.body,
          layer: 'research',
          relation: 'research-record-anchor',
          verificationStatus: 'anchor-only',
          locator: { locatorId: result.locators[0]!.locatorId },
        }],
        pageInfo: { returned: 1, total: 1, truncated: false },
      })
      expect(store.treeOverlay({
        ...overlayRequest,
        investigationId: selectionFixture.context.investigationId,
      }).items[0]?.layer).toBe('working')
      expect(store.treeOverlay({
        ...overlayRequest,
        recordTypes: ['open-question'],
      }).items[0]).toMatchObject({
        recordId: 'question:northstar:margin',
        recordStatus: 'resolved',
        preview: questionRequest.question,
      })
      const pagedOverlayRequest = {
        ...overlayRequest,
        recordTypes: ['evidence-bookmark' as const, 'research-note' as const],
        limits: { maxItems: 1, maxChars: 1000 },
      }
      const firstPage = store.treeOverlay(pagedOverlayRequest)
      expect(firstPage.pageInfo).toMatchObject({ returned: 1, total: 2, truncated: true })
      expect(firstPage.pageInfo.nextCursor).toBeDefined()
      const edited = store.transitionResearchRecord({
        schemaVersion: 1,
        requestType: 'research-record-lifecycle',
        sessionId: selectionFixture.context.sessionId,
        workspaceId: selectionFixture.context.workspaceId,
        investigationId: selectionFixture.context.investigationId,
        scopeVersionId: selectionFixture.context.scopeVersionId,
        recordId: result.record.recordType === 'research-note' ? result.record.noteId : '',
        expectedVersion: 1,
        idempotencyKey: 'idempotency:selection-note:edit',
        action: 'edit',
        text: 'Corrected margin interpretation, still user commentary.',
      })
      expect(edited.state).toMatchObject({
        recordId: 'note:northstar:margin',
        version: 2,
        recordType: 'research-note',
        text: 'Corrected margin interpretation, still user commentary.',
      })
      expect(store.treeOverlay(overlayRequest).items[0]).toMatchObject({
        recordStatus: 'active',
        preview: edited.state.text,
      })
      expect(() => store.treeOverlay({
        ...pagedOverlayRequest,
        cursor: firstPage.pageInfo.nextCursor,
      })).toThrowError(expect.objectContaining({ code: 'invalid-request' }) as SourceScopeStoreError)
      const freshFirstPage = store.treeOverlay(pagedOverlayRequest)
      const freshSecondPage = store.treeOverlay({
        ...pagedOverlayRequest,
        cursor: freshFirstPage.pageInfo.nextCursor,
      })
      expect(new Set([...freshFirstPage.items, ...freshSecondPage.items]
        .map(item => item.recordType))).toEqual(new Set(['evidence-bookmark', 'research-note']))
      const backup = await store.backupWorkspace(selectionFixture.context.workspaceId)
      const restoreRoot = await mkdtemp(join(tmpdir(), 'docatlas-selection-record-restore-'))
      try {
        await expect(SourceScopeStore.restoreWorkspaceBackup(
          restoreRoot,
          'workspace:wrong',
          backup.path,
        )).rejects.toMatchObject({ code: 'integrity-error' })
        const restored = await SourceScopeStore.restoreWorkspaceBackup(
          restoreRoot,
          selectionFixture.context.workspaceId,
          backup.path,
        )
        expect(restored.byteLength).toBeGreaterThan(0)
        await expect(SourceScopeStore.restoreWorkspaceBackup(
          restoreRoot,
          selectionFixture.context.workspaceId,
          backup.path,
        )).rejects.toMatchObject({ code: 'conflict' })
        const restoredStore = await SourceScopeStore.open(restoreRoot)
        try {
          expect(restoredStore.treeOverlay(overlayRequest).items[0]?.preview)
            .toBe(edited.state.text)
        } finally {
          restoredStore.close()
        }
      } finally {
        await rm(restoreRoot, { recursive: true, force: true })
      }
      expect(store.recallResearch({
        schemaVersion: 1,
        requestType: 'research-recall',
        sessionId: 'session:northstar:later',
        workspaceId: selectionFixture.context.workspaceId,
        investigationId: 'investigation:northstar:later',
        scopeVersionId: 'scope:northstar:later',
        query: 'corrected margin interpretation',
        recordTypes: ['research-note'],
        limits: { maxItems: 8, maxChars: 1000 },
      }, []).leads[0]).toMatchObject({
        recordId: 'note:northstar:margin',
        sourceState: 'outside-current-scope',
        preview: edited.state.text,
      })
      store.close()
      const damagedOverlay = new DatabaseSync(workspacePath)
      damagedOverlay.exec('DELETE FROM research_tree_overlays')
      damagedOverlay.close()
      store = await SourceScopeStore.open(root)
      expect(store.treeOverlay(overlayRequest).items[0]?.preview).toBe(edited.state.text)
      const deleted = store.transitionResearchRecord({
        schemaVersion: 1,
        requestType: 'research-record-lifecycle',
        sessionId: selectionFixture.context.sessionId,
        workspaceId: selectionFixture.context.workspaceId,
        investigationId: selectionFixture.context.investigationId,
        scopeVersionId: selectionFixture.context.scopeVersionId,
        recordId: 'note:northstar:margin',
        expectedVersion: 2,
        idempotencyKey: 'idempotency:selection-note:delete',
        action: 'delete',
      })
      expect(deleted.state).toMatchObject({ version: 3, status: 'deleted' })
      expect(store.treeOverlay(overlayRequest).items).toEqual([])
      expect(store.recallResearch({
        schemaVersion: 1,
        requestType: 'research-recall',
        sessionId: 'session:northstar:later',
        workspaceId: selectionFixture.context.workspaceId,
        investigationId: 'investigation:northstar:later',
        scopeVersionId: 'scope:northstar:later',
        query: 'corrected margin interpretation',
        recordTypes: ['research-note'],
        limits: { maxItems: 8, maxChars: 1000 },
      }, []).leads).toEqual([])
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds Research Recall cursors to filters, scope, and projection generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-research-cursor-'))
    const store = await SourceScopeStore.open(root)
    const common = {
      schemaVersion: 1 as const,
      requestType: 'research-record' as const,
      sessionId: 'session:cursor:prior',
      workspaceId: 'workspace:cursor',
      investigationId: 'investigation:cursor:prior',
      scopeVersionId: 'scope:cursor:prior',
      callId: 'call:cursor:base',
    }
    try {
      store.recordResearch({
        ...common,
        idempotencyKey: 'idempotency:cursor:note',
        callId: 'call:cursor:note',
        kind: 'checkpoint',
        body: 'Margin definition requires source verification.',
      })
      store.recordResearch({
        ...common,
        idempotencyKey: 'idempotency:cursor:question',
        callId: 'call:cursor:question',
        kind: 'open-question',
        question: 'Which margin definition requires source verification?',
      })
      const request: ResearchRecallRequest = {
        schemaVersion: 1,
        requestType: 'research-recall',
        sessionId: 'session:cursor:current',
        workspaceId: common.workspaceId,
        investigationId: 'investigation:cursor:current',
        scopeVersionId: 'scope:cursor:current',
        query: 'margin definition',
        recordTypes: ['research-note', 'open-question'],
        limits: { maxItems: 1, maxChars: 1000 },
      }
      const first = store.recallResearch(request, [])
      expect(first.pageInfo).toMatchObject({ returned: 1, total: 2, truncated: true })
      expect(first.pageInfo.nextCursor).toBeDefined()
      const second = store.recallResearch({ ...request, cursor: first.pageInfo.nextCursor }, [])
      expect(second.pageInfo).toMatchObject({ returned: 1, total: 2, truncated: false })
      expect(new Set([...first.leads, ...second.leads].map(lead => lead.recordType)))
        .toEqual(new Set(['research-note', 'open-question']))
      expect(() => store.recallResearch({
        ...request,
        recordTypes: ['research-note'],
        cursor: first.pageInfo.nextCursor,
      }, [])).toThrowError(expect.objectContaining({ code: 'invalid-request' }) as SourceScopeStoreError)

      store.recordResearch({
        ...common,
        idempotencyKey: 'idempotency:cursor:new',
        callId: 'call:cursor:new',
        kind: 'checkpoint',
        body: 'Another margin definition checkpoint.',
      })
      expect(() => store.recallResearch({
        ...request,
        cursor: first.pageInfo.nextCursor,
      }, [])).toThrowError(expect.objectContaining({ code: 'invalid-request' }) as SourceScopeStoreError)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves only Open Questions and keeps resolved records as explicit recall leads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-research-resolve-'))
    const store = await SourceScopeStore.open(root)
    try {
      const question = store.recordResearch({
        schemaVersion: 1,
        requestType: 'research-record',
        sessionId: 'session:resolve',
        workspaceId: 'workspace:resolve',
        investigationId: 'investigation:resolve',
        scopeVersionId: 'scope:resolve:1',
        callId: 'call:resolve:question',
        idempotencyKey: 'idempotency:resolve:question',
        kind: 'open-question',
        question: 'Which audited margin definition applies?',
      })
      expect(validateContractShape('research-record-rpc', question)).toMatchObject({ ok: true })
      const resolved = store.transitionResearchRecord({
        schemaVersion: 1,
        requestType: 'research-record-lifecycle',
        sessionId: 'session:resolve',
        workspaceId: 'workspace:resolve',
        investigationId: 'investigation:resolve',
        scopeVersionId: 'scope:resolve:1',
        recordId: question.record.recordId,
        expectedVersion: 1,
        idempotencyKey: 'idempotency:resolve:lifecycle',
        action: 'resolve',
      })
      expect(resolved.state).toMatchObject({
        recordType: 'open-question',
        status: 'resolved',
        text: 'Which audited margin definition applies?',
      })
      expect(store.recallResearch({
        schemaVersion: 1,
        requestType: 'research-recall',
        sessionId: 'session:resolve',
        workspaceId: 'workspace:resolve',
        investigationId: 'investigation:resolve',
        scopeVersionId: 'scope:resolve:1',
        query: 'audited margin',
        recordTypes: ['open-question'],
        limits: { maxItems: 8, maxChars: 1000 },
      }, []).leads[0]?.recordStatus).toBe('resolved')

      const note = store.recordResearch({
        schemaVersion: 1,
        requestType: 'research-record',
        sessionId: 'session:resolve',
        workspaceId: 'workspace:resolve',
        investigationId: 'investigation:resolve',
        scopeVersionId: 'scope:resolve:1',
        callId: 'call:resolve:note',
        idempotencyKey: 'idempotency:resolve:note',
        kind: 'checkpoint',
        body: 'Unverified margin note.',
      })
      expect(() => store.transitionResearchRecord({
        schemaVersion: 1,
        requestType: 'research-record-lifecycle',
        sessionId: 'session:resolve',
        workspaceId: 'workspace:resolve',
        investigationId: 'investigation:resolve',
        scopeVersionId: 'scope:resolve:1',
        recordId: note.record.recordId,
        expectedVersion: 1,
        idempotencyKey: 'idempotency:resolve:note-lifecycle',
        action: 'resolve',
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('journals CAS versions and restores per-session bindings across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-source-scopes-'))
    let store = await SourceScopeStore.open(root)
    try {
      const created = store.commit(fixture.commitRequest)
      expect(created.status).toBe('created')
      expect(store.commit(fixture.commitRequest).status).toBe('replayed')
      expect(store.get('session:scope:one')).toMatchObject({
        status: 'active',
        scope: { scopeVersionId: 'scope:workspace:1' },
      })

      const reusedKey = structuredClone(fixture.commitRequest)
      reusedKey.scope.scopeVersionId = 'scope:other'
      expect(() => store.commit(reusedKey)).toThrowError(expect.objectContaining({
        code: 'conflict',
      }) as SourceScopeStoreError)

      expect(store.bind(fixture.bindRequest).status).toBe('bound')
      expect(store.bind(fixture.bindRequest).status).toBe('replayed')
      expect(store.get('session:scope:two').status).toBe('active')
      const workspaceFiles = await readdir(join(root, 'investigations'))
      expect(() => store.bind({
        ...fixture.bindRequest,
        idempotencyKey: 'idempotency:scope:unknown-workspace',
        workspaceId: 'workspace:unknown',
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)
      expect(await readdir(join(root, 'investigations'))).toEqual(workspaceFiles)

      const updated: SourceScopeCommitRequest = {
        ...structuredClone(fixture.commitRequest),
        idempotencyKey: 'idempotency:scope:two',
        expectedScopeVersionId: 'scope:workspace:1',
        scope: {
          ...structuredClone(fixture.commitRequest.scope),
          scopeVersionId: 'scope:workspace:2',
          previousScopeVersionId: 'scope:workspace:1',
          version: 2,
          createdAt: '2026-08-30T17:01:00Z',
        },
      }
      expect(store.commit(updated).status).toBe('updated')
      expect(store.get('session:scope:two')).toMatchObject({
        status: 'active',
        scope: { scopeVersionId: 'scope:workspace:2', version: 2 },
      })
      expect(() => store.commit({
        ...updated,
        idempotencyKey: 'idempotency:scope:bad-cas',
        scope: {
          ...updated.scope,
          scopeVersionId: 'scope:workspace:3',
          previousScopeVersionId: 'scope:workspace:2',
          version: 3,
        },
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)

      expect(store.unbind(fixture.unbindRequest).status).toBe('unbound')
      expect(store.unbind(fixture.unbindRequest).status).toBe('replayed')
      expect(store.get('session:scope:one').status).toBe('unbound')
      expect(store.snapshots().map(snapshot => snapshot.sessionId)).toEqual(['session:scope:two'])

      store.close()
      store = await SourceScopeStore.open(root)
      expect(store.get('session:scope:two')).toMatchObject({
        status: 'active',
        scope: { scopeVersionId: 'scope:workspace:2' },
      })
      expect(store.snapshots()).toHaveLength(1)

      const workspaceKey = createHash('sha256').update('workspace:scope').digest('hex')
      const workspacePath = join(root, 'investigations', `${workspaceKey}.sqlite3`)
      const database = new DatabaseSync(workspacePath, { readOnly: true })
      try {
        expect(database.prepare('SELECT count(*) AS count FROM journal_events').get())
          .toMatchObject({ count: 2 })
      } finally {
        database.close()
      }
      if (process.platform !== 'win32') {
        expect(statSync(root).mode & 0o777).toBe(0o700)
        expect(statSync(join(root, 'investigations')).mode & 0o777).toBe(0o700)
        expect(statSync(join(root, 'session-scope-index.sqlite3')).mode & 0o777).toBe(0o600)
        expect(statSync(workspacePath).mode & 0o777).toBe(0o600)
      }
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed on an unknown store schema version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-source-scopes-version-'))
    await mkdir(join(root, 'investigations'))
    const path = join(root, 'session-scope-index.sqlite3')
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    database.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', '99')").run()
    database.close()
    try {
      await expect(SourceScopeStore.open(root)).rejects.toMatchObject({
        code: 'integrity-error',
      })
      const after = new DatabaseSync(path, { readOnly: true })
      try {
        expect(after.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_bindings'
        `).get()).toBeUndefined()
        expect(after.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' })
      } finally {
        after.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('migrates known v1 index/workspace stores before exposing current projection tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-source-scopes-migrate-v1-'))
    const investigations = join(root, 'investigations')
    await mkdir(investigations)
    const indexPath = join(root, 'session-scope-index.sqlite3')
    const index = new DatabaseSync(indexPath)
    index.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    index.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', '1')").run()
    index.close()
    const workspaceId = 'workspace:legacy-v1'
    const workspacePath = join(
      investigations,
      `${createHash('sha256').update(workspaceId).digest('hex')}.sqlite3`,
    )
    const workspace = new DatabaseSync(workspacePath)
    workspace.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    workspace.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', '1')").run()
    workspace.prepare("INSERT INTO metadata (key, value) VALUES ('workspace_id', ?)").run(workspaceId)
    workspace.close()
    try {
      const store = await SourceScopeStore.open(root)
      expect(store.listLibraryDocuments(workspaceId)).toEqual([])
      store.close()
      const migratedIndex = new DatabaseSync(indexPath, { readOnly: true })
      const migratedWorkspace = new DatabaseSync(workspacePath, { readOnly: true })
      try {
        expect(migratedIndex.prepare(
          "SELECT value FROM metadata WHERE key = 'schema_version'",
        ).get()).toMatchObject({ value: '6' })
        expect(migratedWorkspace.prepare(
          "SELECT value FROM metadata WHERE key = 'schema_version'",
        ).get()).toMatchObject({ value: '6' })
        expect(migratedWorkspace.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'answer_manifests'
        `).get()).toMatchObject({ name: 'answer_manifests' })
        expect(migratedWorkspace.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'source_scope_patch_idempotency'
        `).get()).toMatchObject({ name: 'source_scope_patch_idempotency' })
        expect(migratedWorkspace.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'selection_actions'
        `).get()).toMatchObject({ name: 'selection_actions' })
      } finally {
        migratedIndex.close()
        migratedWorkspace.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('migrates v4 lifecycle foreign keys for selection-authored record aggregates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-source-scopes-migrate-v4-'))
    const investigations = join(root, 'investigations')
    await mkdir(investigations)
    const index = new DatabaseSync(join(root, 'session-scope-index.sqlite3'))
    index.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO metadata (key, value) VALUES ('schema_version', '4');
    `)
    index.close()
    const workspaceId = 'workspace:legacy-v4'
    const workspacePath = join(
      investigations,
      `${createHash('sha256').update(workspaceId).digest('hex')}.sqlite3`,
    )
    const workspace = new DatabaseSync(workspacePath)
    workspace.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO metadata (key, value) VALUES ('schema_version', '4');
      INSERT INTO metadata (key, value) VALUES ('workspace_id', '${workspaceId}');
      CREATE TABLE research_records (
        record_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_scope_version_id TEXT NOT NULL,
        provenance_call_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL CHECK (aggregate_version = 1),
        record_json TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE research_record_states (
        record_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 2),
        state_json TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (record_id) REFERENCES research_records(record_id) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE TABLE research_lifecycle_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        result_hash TEXT NOT NULL,
        record_id TEXT NOT NULL,
        FOREIGN KEY (record_id) REFERENCES research_records(record_id) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
    `)
    workspace.close()
    try {
      const store = await SourceScopeStore.open(root)
      expect(store.listLibraryDocuments(workspaceId)).toEqual([])
      store.close()
      const migrated = new DatabaseSync(workspacePath, { readOnly: true })
      try {
        expect(migrated.prepare(
          "SELECT value FROM metadata WHERE key = 'schema_version'",
        ).get()).toMatchObject({ value: '6' })
        expect(migrated.prepare('PRAGMA foreign_key_list(research_record_states)').all())
          .toEqual([])
        expect(migrated.prepare('PRAGMA foreign_key_list(research_lifecycle_idempotency)').all())
          .toEqual([])
        const migrationCopies = await readdir(join(
          root,
          'backups',
          'migrations',
          createHash('sha256').update(workspaceId).digest('hex'),
        ))
        expect(migrationCopies).toHaveLength(1)
        const migrationCopy = new DatabaseSync(join(
          root,
          'backups',
          'migrations',
          createHash('sha256').update(workspaceId).digest('hex'),
          migrationCopies[0]!,
        ), { readOnly: true })
        expect(migrationCopy.prepare(
          "SELECT value FROM metadata WHERE key = 'schema_version'",
        ).get()).toMatchObject({ value: '4' })
        migrationCopy.close()
      } finally {
        migrated.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stores immutable AnswerManifests idempotently and restores them after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-answer-manifests-'))
    let store = await SourceScopeStore.open(root)
    try {
      expect(store.recordAnswerManifest(answerFixture.manifest)).toBe('created')
      expect(store.recordAnswerManifest(answerFixture.manifest)).toBe('replayed')
      expect(() => store.recordAnswerManifest({
        ...answerFixture.manifest,
        answerTextHash: 'f'.repeat(64),
      })).toThrowError(expect.objectContaining({ code: 'invalid-request' }) as SourceScopeStoreError)
      expect(store.getAnswerManifest(
        answerFixture.manifest.workspaceId,
        answerFixture.manifest.sessionId,
        answerFixture.manifest.messageId,
      )).toEqual(answerFixture.manifest)
      expect(() => store.recordAnswerManifest({
        ...answerFixture.manifest,
        manifestId: 'answer:manifest:conflict',
      })).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)
      store.close()
      store = await SourceScopeStore.open(root)
      expect(store.getAnswerManifest(
        answerFixture.manifest.workspaceId,
        answerFixture.manifest.sessionId,
        answerFixture.manifest.messageId,
      )).toEqual(answerFixture.manifest)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('detects a changed AnswerManifest payload before returning source content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-answer-manifest-tamper-'))
    let store = await SourceScopeStore.open(root)
    const workspacePath = join(
      root,
      'investigations',
      `${createHash('sha256').update(answerFixture.manifest.workspaceId).digest('hex')}.sqlite3`,
    )
    try {
      store.recordAnswerManifest(answerFixture.manifest)
      store.close()
      const database = new DatabaseSync(workspacePath)
      database.prepare("UPDATE answer_manifests SET manifest_json = manifest_json || ' '").run()
      database.close()
      store = await SourceScopeStore.open(root)
      expect(() => store.getAnswerManifest(
        answerFixture.manifest.workspaceId,
        answerFixture.manifest.sessionId,
        answerFixture.manifest.messageId,
      )).toThrowError(expect.objectContaining({ code: 'integrity-error' }) as SourceScopeStoreError)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails startup when a journal payload no longer matches its hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-source-scopes-tamper-'))
    const store = await SourceScopeStore.open(root)
    store.commit(fixture.commitRequest)
    store.close()
    const workspaceKey = createHash('sha256').update('workspace:scope').digest('hex')
    const path = join(root, 'investigations', `${workspaceKey}.sqlite3`)
    const database = new DatabaseSync(path)
    database.prepare("UPDATE journal_events SET payload_json = payload_json || ' '").run()
    database.close()
    try {
      await expect(SourceScopeStore.open(root)).rejects.toMatchObject({
        code: 'integrity-error',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists Library jobs, exact dedupe, source links, and new revisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docatlas-library-store-'))
    let store = await SourceScopeStore.open(root)
    const request: LibraryImportRequest = {
      schemaVersion: 1,
      requestType: 'library-import',
      sessionId: 'session:library',
      workspaceId: 'workspace:library',
      candidateId: 'candidate:library:report',
      sourceRole: 'primary',
      idempotencyKey: 'idempotency:library:job',
    }
    try {
      expect(store.acceptLibraryJob(request, 'job:library:report', '2026-08-30T20:00:00Z'))
        .toMatchObject({ status: 'queued', jobId: 'job:library:report' })
      expect(store.acceptLibraryJob(request, 'job:ignored', '2026-08-30T20:00:01Z'))
        .toMatchObject({ status: 'replayed', jobId: 'job:library:report' })
      expect(() => store.acceptLibraryJob(
        { ...request, candidateId: 'candidate:other' },
        'job:other',
        '2026-08-30T20:00:01Z',
      )).toThrowError(expect.objectContaining({ code: 'conflict' }) as SourceScopeStoreError)

      const running: LibraryJobResult = {
        ...store.getLibraryJob('workspace:library', 'job:library:report')!,
        status: 'running',
        phase: 'hashing',
        updatedAt: '2026-08-30T20:00:01Z',
      }
      store.updateLibraryJob(running)

      const document = structuredClone(libraryFixture.document)
      const sourceKey = 'source-key:report'
      expect(store.resolveLibraryImport(
        'workspace:library', sourceKey, document.currentRevision.contentHash,
      )).toMatchObject({ documentId: expect.stringMatching(/^doc:/) })
      const expectedId = store.resolveLibraryImport(
        'workspace:library', sourceKey, document.currentRevision.contentHash,
      ).documentId
      document.documentId = expectedId
      document.currentRevision.documentId = expectedId
      for (const representation of document.representations) representation.documentId = expectedId
      expect(store.recordLibraryDocument({
        workspaceId: 'workspace:library',
        idempotencyKey: 'idempotency:library:record:1',
        sourceKey,
        rootId: 'root:library',
        relativePath: 'Report.pdf',
        document,
      }).status).toBe('created')
      expect(store.listLibraryDocuments('workspace:library')).toEqual([document])
      expect(store.eligibleLibrarySources('workspace:library')).toEqual([{
        documentId: expectedId,
        revisionId: 'rev:library:report:1',
        representationId: 'rep:library:report:text',
        representationContentHash: 'b'.repeat(64),
      }])

      expect(store.recordLibraryDocument({
        workspaceId: 'workspace:library',
        idempotencyKey: 'idempotency:library:record:reuse',
        sourceKey,
        rootId: 'root:library',
        relativePath: 'Report.pdf',
        document,
      }).status).toBe('reused')
      const exact = store.resolveLibraryImport(
        'workspace:library', 'source-key:duplicate', document.currentRevision.contentHash,
      )
      expect(exact.exact?.documentId).toBe(expectedId)
      expect(store.recordLibraryDocument({
        workspaceId: 'workspace:library',
        idempotencyKey: 'idempotency:library:record:link',
        sourceKey: 'source-key:duplicate',
        rootId: 'root:library',
        relativePath: 'Copy.pdf',
        document: exact.exact!,
      }).status).toBe('reused')

      const revision2 = structuredClone(document)
      revision2.revisionCount = 2
      revision2.updatedAt = '2026-08-30T20:01:01Z'
      revision2.currentRevision = {
        ...revision2.currentRevision,
        revisionId: 'rev:library:report:2',
        previousRevisionId: 'rev:library:report:1',
        contentHash: 'd'.repeat(64),
        ingestedAt: '2026-08-30T20:01:00Z',
      }
      revision2.representations = revision2.representations.map((representation, index) => ({
        ...representation,
        representationId: index === 0 ? 'rep:library:report:pdf:2' : 'rep:library:report:text:2',
        revisionId: 'rev:library:report:2',
        contentHash: index === 0 ? 'd'.repeat(64) : 'e'.repeat(64),
        derivedFromRepresentationIds: index === 0 ? [] : ['rep:library:report:pdf:2'],
        createdAt: '2026-08-30T20:01:01Z',
      }))
      revision2.activeRepresentationId = 'rep:library:report:text:2'
      expect(store.recordLibraryDocument({
        workspaceId: 'workspace:library',
        idempotencyKey: 'idempotency:library:record:2',
        sourceKey,
        rootId: 'root:library',
        relativePath: 'Report.pdf',
        document: revision2,
      }).status).toBe('updated')
      expect(store.getLibraryDocument('workspace:library', expectedId)?.revisionCount).toBe(2)
      expect(store.eligibleLibrarySources('workspace:library')).toEqual([
        {
          documentId: expectedId,
          revisionId: 'rev:library:report:1',
          representationId: 'rep:library:report:text',
          representationContentHash: 'b'.repeat(64),
        },
        {
          documentId: expectedId,
          revisionId: 'rev:library:report:2',
          representationId: 'rep:library:report:text:2',
          representationContentHash: 'e'.repeat(64),
        },
      ])
      expect(store.getEligibleLibrarySource(
        'workspace:library',
        expectedId,
        'rev:library:report:1',
      )).toMatchObject({ representationId: 'rep:library:report:text' })

      store.close()
      store = await SourceScopeStore.open(root)
      expect(store.getLibraryJob('workspace:library', 'job:library:report'))
        .toMatchObject({ status: 'failed', phase: 'complete', error: { code: 'unavailable' } })
      expect(store.getLibraryDocument('workspace:library', expectedId)?.currentRevision.revisionId)
        .toBe('rev:library:report:2')
      const workspaceKey = createHash('sha256').update('workspace:library').digest('hex')
      const database = new DatabaseSync(
        join(root, 'investigations', `${workspaceKey}.sqlite3`),
        { readOnly: true },
      )
      try {
        expect(database.prepare('SELECT count(*) AS count FROM journal_events').get())
          .toMatchObject({ count: 3 })
      } finally {
        database.close()
      }
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
