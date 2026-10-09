import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs'
import { chmod, copyFile, lstat, mkdir, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

import {
  libraryDocumentIssues,
  libraryRpcIssues,
  answerManifestIssues,
  type AnswerManifest,
  type LibraryDocument,
  type LibraryImportRequest,
  type LibraryRevisionTarget,
  type LibraryImportResult,
  type LibraryJobResult,
  sourceScopeRpcIssues,
  selectionContextIssues,
  selectionRpcIssues,
  type ScopedSourceIdentity,
  type SourceScopeBindRequest,
  type SourceScopeBindResult,
  type SourceScopeCommitRequest,
  type SourceScopeCommitResult,
  type SourceScopeGetResult,
  type SourceScopePatchRequest,
  type SourceScopeVersion,
  type SourceScopeUnbindRequest,
  type SourceScopeUnbindResult,
  type SelectionActionRequest,
  type SelectionActionResult,
  type SelectionContext,
  type DocumentLocator,
  type DocumentRevision,
  type EvidenceAtom,
  documentLocatorIssues,
  evidenceLocatorIssues,
  researchRecallRpcIssues,
  type ResearchRecallRequest,
  type ResearchRecallResult,
  type ResearchRecordStatus,
  type ResearchRecordType,
  type ResearchSourceIdentity,
  researchRecordRpcIssues,
  type AgentResearchRecord,
  type ResearchRecordRequest,
  type ResearchRecordResult,
  researchLifecycleRpcIssues,
  type ResearchLifecycleRequest,
  type ResearchLifecycleResult,
  type ResearchRecordState,
  researchGovernanceRpcIssues,
  type ResearchGovernanceRecord,
  type ResearchGovernanceRequest,
  type ResearchGovernanceResult,
  researchNotebookRpcIssues,
  type ResearchNotebookItem,
  type ResearchNotebookRequest,
  type ResearchNotebookResult,
  treeOverlayRpcIssues,
  type TreeOverlayItem,
  type TreeOverlayRequest,
  type TreeOverlayResult,
  sourceRepresentationIssues,
  type SourceRepresentation,
  type ActorRef,
  type ContinuityAssessRequest,
  type ContinuityAssessResult,
  type ContinuityEvidenceContext,
  type ContinuityLink,
  type RevisionImpactRecordContext,
  type RevisionImpactRequest,
  type RevisionImpactResult,
  type ClaimLedgerSnapshot,
  m4RpcIssues,
  humanResearchIssues,
  type HumanResearchRecord,
  type HumanResearchDraft,
  type HumanResearchCommandIdentity,
  type HumanResearchReceipt,
  type VerifiedSelectionItem,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

import {
  InvestigationM4Store,
  type M4EvidenceResolution,
  type M4WorkspaceSnapshot,
  type PublishArtifactCommand,
  type RecordArtifactDraftCommand,
  type RecordClaimVersionCommand,
  type RecordConflictSearchAssuranceCommand,
  type RecordHumanReviewDecisionCommand,
  type RunArtifactReviewCommand,
} from './investigation-m4-store.js'
import {
  InvestigationContinuityStore,
} from './investigation-continuity-store.js'
import {
  ContinuityService,
  type ContinuityRecord,
  type ContinuityServiceBackend,
} from './continuity-service.js'

const STORE_SCHEMA_VERSION = 6
const PREVIOUS_STORE_SCHEMA_VERSIONS = [1, 2, 3, 4, 5] as const
const DATABASE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const MAX_LIBRARY_DOCUMENTS = 10_000
const MAX_ANSWER_MANIFESTS = 10_000
const MAX_SELECTION_ACTIONS = 10_000
const MAX_RECALL_CURSOR_OFFSET = 10_000
const MAX_RESEARCH_RECORDS = 10_000
const MAX_RESEARCH_GOVERNANCE_RECORDS = 10_000
const MAX_RESEARCH_NOTEBOOK_CURSOR_OFFSET = 10_000
const MAX_TREE_OVERLAY_CURSOR_OFFSET = 10_000
const RECALL_TOKEN = /[\p{L}\p{N}_]+/gu

export type SourceScopeStoreErrorCode =
  | 'invalid-request'
  | 'conflict'
  | 'limit-exceeded'
  | 'integrity-error'

export class SourceScopeStoreError extends Error {
  constructor(readonly code: SourceScopeStoreErrorCode, message: string) {
    super(message)
    this.name = 'SourceScopeStoreError'
  }
}

export interface StoredSourceScope {
  sessionId: string
  scope: SourceScopeCommitResult['scope']
  sources: ScopedSourceIdentity[]
}

export interface LibraryImportIdentity {
  documentId: string
  previous?: LibraryDocument
  exact?: LibraryDocument
}

export interface StoredLibraryRevision {
  revision: DocumentRevision
  representations: SourceRepresentation[]
}

function libraryImportRequestHash(request: LibraryImportRequest, productCommandHash?: string): string {
  if (productCommandHash !== undefined && (typeof productCommandHash !== 'string' || !/^[a-f0-9]{64}$/.test(productCommandHash))) {
    throw new SourceScopeStoreError('invalid-request', 'Library product command hash must be canonical SHA-256')
  }
  return sha256(canonicalJson(productCommandHash === undefined ? request : { request, productCommandHash }))
}

export interface LibraryRecordInput {
  workspaceId: string
  idempotencyKey: string
  sourceKey: string
  rootId: string
  relativePath: string
  document: LibraryDocument
  revisionTarget?: LibraryRevisionTarget
}

export interface LibraryRecordResult {
  status: 'created' | 'updated' | 'reused' | 'replayed'
  document: LibraryDocument
}

/** Trusted host completion; deliberately outside LibraryRecordInput's legacy durable hash. */
export interface LibraryRecordCompletion {
  request: LibraryImportRequest
  jobId: string
  productCommandHash?: string
  completedAt: string
  assertCurrent(): void
}

export interface WorkspaceBackup {
  workspaceId: string
  createdAt: string
  path: string
  byteLength: number
}

export interface WorkspaceRestore {
  workspaceId: string
  restoredAt: string
  path: string
  byteLength: number
}

export type AnswerManifestRecordStatus = 'created' | 'replayed'

export interface ResearchVisibilityRef {
  recordId: string, investigationId: string, sourceSessionId: string, sourceScopeVersionId?: string,
  provenanceCallId?: string,
  sourceIdentities: ResearchSourceIdentity[]
}
/** Host-owned authorization, applied before FTS/counts/cursors; never a browser-supplied relevance filter. */
export type ResearchVisibility = (reference: ResearchVisibilityRef) => boolean
/** Private product authority. Never construct this from a browser/model supplied actor or scope. */
export interface HumanResearchCommitContext {
  actor: { kind: 'user', actorId: string }
  command: HumanResearchCommandIdentity
  /** Required for human-created Governance, including an explicit empty capture. Never browser authority. */
  governanceSources?: ResearchSourceIdentity[]
  assertCurrent(): void
}
export interface HumanResearchCreateInput {
  workspaceId: string, investigationId: string, sourceSessionId: string, sourceScopeVersionId: string,
  entry: HumanResearchDraft, anchors: VerifiedSelectionItem[], sourceIdentities: ResearchSourceIdentity[]
}
export interface StoredResearchNote {
  recordId: string, recordType: 'research-note' | 'open-question', workspaceId: string, investigationId: string,
  sourceSessionId: string, scopeVersionId: string, version: number, status: 'active' | 'open' | 'resolved' | 'archived' | 'deleted',
  text: string | null, locators: DocumentLocator[], evidence: EvidenceAtom[], authoredBy: 'user' | 'agent',
  sourceIdentities: ResearchSourceIdentity[], anchors: VerifiedSelectionItem[]
}

/** The existing immutable capture, not a new Evidence store or proof of product publication. */
export type CanonicalEvidenceOrigin =
  | { kind: 'answer-read', sessionId: string, manifestId: string, messageId: string, citationId: string }
  | { kind: 'selection-action', sessionId: string, actionId: string, selectionContextId: string, action: SelectionActionResult['action'] }
export interface StoredCanonicalEvidence {
  kind: 'evidence-atom'
  workspaceId: string
  investigationId: string
  sourceScopeVersionIds: readonly string[]
  evidence: EvidenceAtom
  locator: DocumentLocator
  integrity: 'valid'
  /** Hosts must authorize the original conversation and, for answers, its completed publication. */
  origins: CanonicalEvidenceOrigin[]
}

interface ContinuityEvidenceReference { investigationId: string, scopeVersionId: string, evidenceId: string }
type ContinuityAuthorizationReference = { sessionId: string, investigationId: string, scopeVersionId: string, referenceId: string } & (
  | { kind: 'answer-read', messageId: string, citationId: string }
  | { kind: 'selection-action', selectionContextId: string }
  | { kind: 'research-record', provenanceCallId?: string }
  | { kind: 'm4-command', recordId: string, recordType: 'claim-version' | 'artifact-manifest' }
)
/** Private, bounded metadata only. Hosts must authorize every original identity before disclosure. */
export interface StoredContinuityRecord extends ContinuityRecord {
  recordType: ResearchRecordType | 'claim-version' | 'artifact-brief' | 'artifact-matrix'
  scopeVersionId: string
  version: number
  identity:
    | { kind: 'research-record', recordId: string, version: number }
    | { kind: 'claim-version', claimVersionId: string, claimChainId: string, version: number }
    | { kind: 'artifact-manifest', artifactManifestId: string, artifactId: string, version: number }
  sourceReferencesComplete: boolean
  evidenceRefs: ContinuityEvidenceReference[]
  authorizationRefs: ContinuityAuthorizationReference[]
  /** Complete provenance handles, not granted access or completed Answer publication. Unknown sessions are never inferred from actors. */
  authorizationComplete: boolean
}

export class SourceScopeStore {
  private readonly workspaces = new Map<string, DatabaseSync>()
  private readonly m4Stores = new Map<string, InvestigationM4Store>()
  private readonly continuityStores = new Map<string, InvestigationContinuityStore>()
  private closed = false

  private constructor(
    private readonly investigationsRoot: string,
    private readonly backupsRoot: string,
    private readonly index: DatabaseSync,
  ) {}

  static async open(root: string): Promise<SourceScopeStore> {
    const investigationsRoot = join(root, 'investigations')
    const backupsRoot = join(root, 'backups')
    await mkdir(investigationsRoot, { recursive: true, mode: DIRECTORY_MODE })
    await mkdir(backupsRoot, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(root, DIRECTORY_MODE)
    await chmod(investigationsRoot, DIRECTORY_MODE)
    await chmod(backupsRoot, DIRECTORY_MODE)
    const indexPath = join(root, 'session-scope-index.sqlite3')
    const index = new DatabaseSync(indexPath)
    try {
      preflight(index)
      configure(index)
      initializeIndex(index)
      await chmod(indexPath, DATABASE_MODE)
    } catch (error) {
      index.close()
      throw error
    }
    const store = new SourceScopeStore(investigationsRoot, backupsRoot, index)
    try {
      store.snapshots()
      return store
    } catch (error) {
      store.close()
      throw error
    }
  }

  static async restoreWorkspaceBackup(
    root: string,
    workspaceId: string,
    backupPath: string,
  ): Promise<WorkspaceRestore> {
    if (!isAbsolute(root) || !isAbsolute(backupPath)) {
      throw new SourceScopeStoreError('invalid-request', 'Workspace restore paths must be absolute')
    }
    const sourceInfo = await lstat(backupPath)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new SourceScopeStoreError('invalid-request', 'Workspace backup must be a regular file')
    }
    verifyWorkspaceBackupFile(backupPath, workspaceId, true)
    const investigationsRoot = join(root, 'investigations')
    await mkdir(investigationsRoot, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(root, DIRECTORY_MODE)
    await chmod(investigationsRoot, DIRECTORY_MODE)
    const targetPath = join(investigationsRoot, `${sha256(workspaceId)}.sqlite3`)
    if (existsSync(targetPath)) {
      throw new SourceScopeStoreError(
        'conflict',
        'Workspace restore refuses to overwrite an existing Investigation database',
      )
    }
    let copied = false
    try {
      await copyFile(backupPath, targetPath, fsConstants.COPYFILE_EXCL)
      copied = true
      await chmod(targetPath, DATABASE_MODE)
      verifyWorkspaceBackupFile(targetPath, workspaceId, true)
      return {
        workspaceId,
        restoredAt: new Date().toISOString(),
        path: targetPath,
        byteLength: (await stat(targetPath)).size,
      }
    } catch (error) {
      if (copied) await unlink(targetPath).catch(() => undefined)
      throw error
    }
  }

  commit(requestCandidate: unknown): SourceScopeCommitResult {
    return this.commitInternal(requestCandidate)
  }

  replaySourceScopePatch(requestCandidate: unknown): SourceScopeCommitResult | undefined {
    const request = parseSourceScopePatchRequest(requestCandidate)
    const database = this.workspace(request.workspaceId)
    const requestHash = sha256(canonicalJson(request))
    const replay = readRow(database, `
      SELECT request_hash, result_json
      FROM source_scope_patch_idempotency
      WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay === undefined) return undefined
    if (stringColumn(replay, 'request_hash') !== requestHash) {
      throw new SourceScopeStoreError(
        'conflict',
        'source scope patch idempotency key was already used for a different request',
      )
    }
    const result = parseScopeCommitResult(stringColumn(replay, 'result_json'))
    verifyPatchResult(database, request.workspaceId, request.idempotencyKey, result)
    if (result.sessionId !== request.sessionId) {
      throw new SourceScopeStoreError('integrity-error', 'source scope patch replay session is invalid')
    }
    this.bindSession(request.sessionId, result.scope.workspaceId, result.scope.investigationId)
    return { ...result, status: 'replayed' }
  }

  commitSourceScopePatch(
    patchCandidate: unknown,
    commitCandidate: unknown,
  ): SourceScopeCommitResult {
    const patch = parseSourceScopePatchRequest(patchCandidate)
    const replay = this.replaySourceScopePatch(patch)
    if (replay !== undefined) return replay
    const commit = parseSourceScopeCommitRequest(commitCandidate)
    if (commit.sessionId !== patch.sessionId
      || commit.scope.workspaceId !== patch.workspaceId
      || commit.idempotencyKey !== patch.idempotencyKey
      || commit.expectedScopeVersionId !== patch.expectedScopeVersionId) {
      throw new SourceScopeStoreError('invalid-request', 'source scope patch commit identity is invalid')
    }
    return this.commitInternal(commit, {
      idempotencyKey: patch.idempotencyKey,
      requestHash: sha256(canonicalJson(patch)),
    })
  }

  private commitInternal(
    requestCandidate: unknown,
    patch?: { idempotencyKey: string, requestHash: string },
  ): SourceScopeCommitResult {
    const request = parseSourceScopeCommitRequest(requestCandidate)
    const database = this.workspace(request.scope.workspaceId)
    const requestJson = canonicalJson(request)
    const requestHash = sha256(requestJson)
    const replay = readRow(database, `
      SELECT request_hash, result_json
      FROM idempotency
      WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay !== undefined) {
      if (patch !== undefined) {
        throw new SourceScopeStoreError(
          'conflict',
          'source scope idempotency key was already used outside the patch route',
        )
      }
      if (stringColumn(replay, 'request_hash') !== requestHash) {
        throw new SourceScopeStoreError(
          'conflict',
          'source scope idempotency key was already used for a different request',
        )
      }
      const result = parseScopeCommitResult(stringColumn(replay, 'result_json'))
      this.bindSession(request.sessionId, request.scope.workspaceId, request.scope.investigationId)
      return { ...result, status: 'replayed' }
    }

    const current = readRow(database, `
      SELECT version, scope_version_id
      FROM source_scope_current
      WHERE investigation_id = ?
    `, request.scope.investigationId)
    const status = current === undefined ? 'created' : 'updated'
    if (current === undefined) {
      if (request.scope.version !== 1 || request.expectedScopeVersionId !== undefined) {
        throw new SourceScopeStoreError('conflict', 'first source scope version must start at version 1')
      }
    } else {
      const currentVersion = numberColumn(current, 'version')
      const currentId = stringColumn(current, 'scope_version_id')
      if (request.expectedScopeVersionId !== currentId
        || request.scope.previousScopeVersionId !== currentId
        || request.scope.version !== currentVersion + 1) {
        throw new SourceScopeStoreError('conflict', 'source scope compare-and-set precondition failed')
      }
    }
    const result: SourceScopeCommitResult = {
      schemaVersion: 1,
      resultType: 'source-scope-committed',
      sessionId: request.sessionId,
      status,
      scope: structuredClone(request.scope),
      sources: structuredClone(request.sources),
    }
    const resultJson = canonicalJson(result)
    const payloadJson = canonicalJson({ scope: request.scope, sources: request.sources })
    const eventId = `event:${sha256(`${request.scope.workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`

    transaction(database, () => {
      database.prepare(`
        INSERT INTO journal_events (
          event_id, workspace_id, aggregate_id, aggregate_version, actor_json,
          occurred_at, idempotency_key, event_type, payload_version, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'source-scope.committed', 1, ?, ?)
      `).run(
        eventId,
        request.scope.workspaceId,
        request.scope.investigationId,
        request.scope.version,
        canonicalJson(request.scope.createdBy),
        request.scope.createdAt,
        request.idempotencyKey,
        payloadJson,
        sha256(payloadJson),
      )
      database.prepare(`
        INSERT INTO source_scope_current (
          workspace_id, investigation_id, version, scope_version_id,
          scope_json, sources_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(investigation_id) DO UPDATE SET
          version = excluded.version,
          scope_version_id = excluded.scope_version_id,
          scope_json = excluded.scope_json,
          sources_json = excluded.sources_json,
          updated_at = excluded.updated_at
      `).run(
        request.scope.workspaceId,
        request.scope.investigationId,
        request.scope.version,
        request.scope.scopeVersionId,
        canonicalJson(request.scope),
        canonicalJson(request.sources),
        request.scope.createdAt,
      )
      database.prepare(`
        INSERT INTO idempotency (idempotency_key, request_hash, result_json)
        VALUES (?, ?, ?)
      `).run(request.idempotencyKey, requestHash, resultJson)
      if (patch !== undefined) {
        database.prepare(`
          INSERT INTO source_scope_patch_idempotency (
            idempotency_key, request_hash, result_json
          ) VALUES (?, ?, ?)
        `).run(patch.idempotencyKey, patch.requestHash, resultJson)
      }
    })
    this.bindSession(request.sessionId, request.scope.workspaceId, request.scope.investigationId)
    return result
  }

  get(sessionId: string): SourceScopeGetResult {
    const binding = readRow(this.index, `
      SELECT workspace_id, investigation_id
      FROM session_bindings
      WHERE session_id = ?
    `, sessionId)
    if (binding === undefined) {
      return {
        schemaVersion: 1,
        resultType: 'source-scope',
        sessionId,
        status: 'unbound',
      }
    }
    const workspaceId = stringColumn(binding, 'workspace_id')
    const investigationId = stringColumn(binding, 'investigation_id')
    const current = this.readCurrent(workspaceId, investigationId)
    if (current === undefined) {
      throw new SourceScopeStoreError(
        'integrity-error',
        'session source scope binding points to missing investigation state',
      )
    }
    return {
      schemaVersion: 1,
      resultType: 'source-scope',
      sessionId,
      status: 'active',
      scope: current.scope,
      sources: current.sources,
    }
  }

  bind(requestCandidate: unknown): SourceScopeBindResult {
    const parsedRequest = parseContract('source-scope-rpc', requestCandidate)
    if (!('requestType' in parsedRequest) || parsedRequest.requestType !== 'source-scope-bind') {
      throw new SourceScopeStoreError('invalid-request', 'source scope bind request type is required')
    }
    const request: SourceScopeBindRequest = parsedRequest
    const requestHash = sha256(canonicalJson(request))
    const replay = readRow(this.index, `
      SELECT request_hash, result_json
      FROM bind_idempotency
      WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay !== undefined) {
      if (stringColumn(replay, 'request_hash') !== requestHash) {
        throw new SourceScopeStoreError(
          'conflict',
          'source scope bind idempotency key was already used for a different request',
        )
      }
      const result = parseScopeBindResult(stringColumn(replay, 'result_json'))
      return { ...result, status: 'replayed' }
    }
    const current = this.readCurrent(request.workspaceId, request.investigationId)
    if (current === undefined
      || current.scope.scopeVersionId !== request.expectedScopeVersionId) {
      throw new SourceScopeStoreError('conflict', 'source scope bind precondition failed')
    }
    const result: SourceScopeBindResult = {
      schemaVersion: 1,
      resultType: 'source-scope-bound',
      sessionId: request.sessionId,
      status: 'bound',
      scope: current.scope,
      sources: current.sources,
    }
    transaction(this.index, () => {
      upsertSessionBinding(
        this.index,
        request.sessionId,
        request.workspaceId,
        request.investigationId,
      )
      this.index.prepare(`
        INSERT INTO bind_idempotency (idempotency_key, request_hash, result_json)
        VALUES (?, ?, ?)
      `).run(request.idempotencyKey, requestHash, canonicalJson(result))
    })
    return result
  }

  unbind(requestCandidate: unknown): SourceScopeUnbindResult {
    const parsedRequest = parseContract('source-scope-rpc', requestCandidate)
    if (!('requestType' in parsedRequest)
      || parsedRequest.requestType !== 'source-scope-unbind') {
      throw new SourceScopeStoreError('invalid-request', 'source scope unbind request type is required')
    }
    const request: SourceScopeUnbindRequest = parsedRequest
    const requestJson = canonicalJson(request)
    const requestHash = sha256(requestJson)
    const replay = readRow(this.index, `
      SELECT request_hash, result_json
      FROM unbind_idempotency
      WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay !== undefined) {
      if (stringColumn(replay, 'request_hash') !== requestHash) {
        throw new SourceScopeStoreError(
          'conflict',
          'source scope unbind idempotency key was already used for a different request',
        )
      }
      const result = parseScopeUnbindResult(stringColumn(replay, 'result_json'))
      return { ...result, status: 'replayed' }
    }
    const result: SourceScopeUnbindResult = {
      schemaVersion: 1,
      resultType: 'source-scope-unbound',
      sessionId: request.sessionId,
      status: 'unbound',
    }
    transaction(this.index, () => {
      this.index.prepare('DELETE FROM session_bindings WHERE session_id = ?').run(request.sessionId)
      this.index.prepare(`
        INSERT INTO unbind_idempotency (idempotency_key, request_hash, result_json)
        VALUES (?, ?, ?)
      `).run(request.idempotencyKey, requestHash, canonicalJson(result))
    })
    return result
  }

  acceptLibraryJob(
    request: LibraryImportRequest,
    jobId: string,
    now: string,
    productCommandHash?: string,
  ): LibraryImportResult {
    const database = this.workspace(request.workspaceId)
    const requestHash = libraryImportRequestHash(request, productCommandHash)
    const replay = readRow(database, `
      SELECT request_hash, job_id
      FROM library_job_idempotency
      WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay !== undefined) {
      if (stringColumn(replay, 'request_hash') !== requestHash) {
        throw new SourceScopeStoreError(
          'conflict',
          'Library import idempotency key was already used for a different request',
        )
      }
      this.getLibraryImport(request, productCommandHash)
      this.rememberLibraryWorkspace(request.workspaceId)
      return {
        schemaVersion: 1,
        resultType: 'library-import-accepted',
        workspaceId: request.workspaceId,
        jobId: stringColumn(replay, 'job_id'),
        status: 'replayed',
      }
    }
    const job: LibraryJobResult = {
      schemaVersion: 1,
      resultType: 'library-job',
      workspaceId: request.workspaceId,
      jobId,
      status: 'queued',
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    transaction(database, () => {
      database.prepare(`
        INSERT INTO library_jobs (job_id, workspace_id, session_id, state_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(jobId, request.workspaceId, request.sessionId, canonicalJson(job), now)
      database.prepare(`
        INSERT INTO library_job_idempotency (idempotency_key, request_hash, job_id)
        VALUES (?, ?, ?)
      `).run(request.idempotencyKey, requestHash, jobId)
    })
    this.rememberLibraryWorkspace(request.workspaceId)
    return {
      schemaVersion: 1,
      resultType: 'library-import-accepted',
      workspaceId: request.workspaceId,
      jobId,
      status: 'queued',
    }
  }

  /** Exact original-body lookup only: never accepts, schedules or creates a Library job. */
  getLibraryImport(request: LibraryImportRequest, productCommandHash?: string): LibraryJobResult | undefined {
    const requestHash = libraryImportRequestHash(request, productCommandHash), database = this.workspaceIfExists(request.workspaceId)
    if (!database) return undefined
    const row = readRow(database, 'SELECT request_hash, job_id FROM library_job_idempotency WHERE idempotency_key = ?', request.idempotencyKey)
    if (!row) return undefined
    if (stringColumn(row, 'request_hash') !== requestHash) throw new SourceScopeStoreError('conflict', 'Library import key belongs to a different complete request')
    const jobId = stringColumn(row, 'job_id'), stored = readRow(database, 'SELECT workspace_id, session_id FROM library_jobs WHERE job_id = ?', jobId)
    const job = this.getLibraryJob(request.workspaceId, jobId)
    if (!stored || !job || stringColumn(stored, 'workspace_id') !== request.workspaceId || stringColumn(stored, 'session_id') !== request.sessionId
      || job.workspaceId !== request.workspaceId || job.jobId !== jobId) {
      throw new SourceScopeStoreError('integrity-error', 'Library import receipt lost its original workspace or session binding')
    }
    return job
  }

  updateLibraryJob(job: LibraryJobResult): void {
    const issues = libraryRpcIssues(job)
    if (issues.length > 0) {
      throw new SourceScopeStoreError('invalid-request', issues[0]!.message)
    }
    const database = this.workspaceIfExists(job.workspaceId)
    if (database === undefined) {
      throw new SourceScopeStoreError('integrity-error', 'Library job workspace is missing')
    }
    const updated = database.prepare(`
      UPDATE library_jobs SET state_json = ?, updated_at = ?
      WHERE job_id = ? AND workspace_id = ?
        AND (json_extract(state_json, '$.status') != 'succeeded' OR state_json = ?)
    `).run(canonicalJson(job), job.updatedAt, job.jobId, job.workspaceId, canonicalJson(job))
    if (updated.changes !== 1) {
      // A stale runner/error handler cannot downgrade another writer's committed receipt.
      if (job.status !== 'succeeded' && this.getLibraryJob(job.workspaceId, job.jobId)?.status === 'succeeded') return
      throw new SourceScopeStoreError('conflict', 'Library job is unavailable or already has an immutable success receipt')
    }
  }

  getLibraryJob(workspaceId: string, jobId: string): LibraryJobResult | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return undefined
    const row = readRow(database, `
      SELECT state_json FROM library_jobs
      WHERE workspace_id = ? AND job_id = ?
    `, workspaceId, jobId)
    if (row === undefined) return undefined
    const parsed = parseContract('library-rpc', parseJson(stringColumn(row, 'state_json')))
    if (!('resultType' in parsed) || parsed.resultType !== 'library-job'
      || libraryRpcIssues(parsed).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'stored Library job is invalid')
    }
    return parsed
  }

  resolveLibraryImport(
    workspaceId: string,
    sourceKey: string,
    contentHash: string,
    revisionTarget?: LibraryRevisionTarget,
  ): LibraryImportIdentity {
    if (revisionTarget !== undefined && (!revisionTarget || typeof revisionTarget !== 'object'
      || Object.keys(revisionTarget).sort().join(',') !== 'documentId,expectedCurrentRevisionId'
      || ![revisionTarget.documentId, revisionTarget.expectedCurrentRevisionId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)))) {
      throw new SourceScopeStoreError('invalid-request', 'Library revision target must name exact document and expected current revision')
    }
    const database = this.workspace(workspaceId)
    const source = readRow(database, `
      SELECT document_id FROM library_source_bindings WHERE source_key = ?
    `, sourceKey)
    const duplicate = readRow(database, `
      SELECT document_id, revision_id FROM library_revisions WHERE content_hash = ?
    `, contentHash)
    if (revisionTarget !== undefined) {
      const document = this.getLibraryDocument(workspaceId, revisionTarget.documentId)
      if (!document || document.status === 'archived' || document.currentRevision.revisionId !== revisionTarget.expectedCurrentRevisionId) {
        throw new SourceScopeStoreError('conflict', 'Library revision target is unavailable or its current revision changed')
      }
      this.getLibraryRevisions(workspaceId, document.documentId)
      if (source !== undefined && stringColumn(source, 'document_id') !== document.documentId
        || duplicate !== undefined && stringColumn(duplicate, 'document_id') !== document.documentId) {
        throw new SourceScopeStoreError('conflict', 'Library source or bytes already belong to another document')
      }
      if (duplicate !== undefined && stringColumn(duplicate, 'revision_id') !== document.currentRevision.revisionId) {
        throw new SourceScopeStoreError('conflict', 'Historical revision bytes cannot be imported as the current revision')
      }
      return { documentId: document.documentId, previous: document,
        ...(document.currentRevision.contentHash === contentHash ? { exact: document } : {}) }
    }
    if (source !== undefined) {
      const document = this.requireLibraryDocument(database, stringColumn(source, 'document_id'))
      if (duplicate !== undefined && (stringColumn(duplicate, 'document_id') !== document.documentId
        || stringColumn(duplicate, 'revision_id') !== document.currentRevision.revisionId)) {
        throw new SourceScopeStoreError('conflict', 'Library source bytes belong to another document or a historical revision')
      }
      if (document.currentRevision.contentHash === contentHash) {
        return { documentId: document.documentId, previous: document, exact: document }
      }
      return { documentId: document.documentId, previous: document }
    }
    if (duplicate !== undefined) {
      const document = this.requireLibraryDocument(database, stringColumn(duplicate, 'document_id'))
      if (document.currentRevision.revisionId !== stringColumn(duplicate, 'revision_id') || document.currentRevision.contentHash !== contentHash) {
        throw new SourceScopeStoreError('conflict', 'Historical revision bytes cannot reuse the current document index')
      }
      return { documentId: document.documentId, previous: document, exact: document }
    }
    return {
      documentId: `doc:${sha256(`${workspaceId}\0${sourceKey}`).slice(0, 32)}`,
    }
  }

  recordLibraryDocument(input: LibraryRecordInput, completion?: LibraryRecordCompletion): LibraryRecordResult {
    if (input.document.workspaceId !== input.workspaceId) {
      throw new SourceScopeStoreError('invalid-request', 'Library document workspace mismatch')
    }
    const issues = libraryDocumentIssues(input.document)
    if (issues.length > 0) {
      throw new SourceScopeStoreError('invalid-request', issues[0]!.message)
    }
    const database = this.workspace(input.workspaceId)
    this.rememberLibraryWorkspace(input.workspaceId)
    let result: LibraryRecordResult
    transaction(database, () => {
      if (completion) {
        this.requireLibraryCompletion(completion)
        if (input.workspaceId !== completion.request.workspaceId || input.idempotencyKey !== `${completion.jobId}:record`
          || canonicalJson(input.revisionTarget) !== canonicalJson(completion.request.revisionTarget)) {
          throw new SourceScopeStoreError('integrity-error', 'Library completion does not name its original record')
        }
      }
      const requestHash = sha256(canonicalJson(input))
      const replay = readRow(database, `
        SELECT request_hash, result_json
        FROM library_record_idempotency
        WHERE idempotency_key = ?
      `, input.idempotencyKey)
      if (replay !== undefined) {
        if (stringColumn(replay, 'request_hash') !== requestHash) {
          throw new SourceScopeStoreError(
            'conflict',
            'Library record idempotency key was already used for a different request',
          )
        }
        const value = parseJson(stringColumn(replay, 'result_json'))
        if (!isLibraryRecordResult(value)) {
          throw new SourceScopeStoreError('integrity-error', 'stored Library record result is invalid')
        }
        result = { ...value, status: 'replayed' }
        if (completion) this.completeLibraryJob(completion, value.document)
        return
      }
      if (completion && !['queued', 'running'].includes(this.requireLibraryCompletion(completion).status)) {
        throw new SourceScopeStoreError('conflict', 'A terminal Library job cannot create a new domain commit')
      }
      const identity = this.resolveLibraryImport(
        input.workspaceId,
        input.sourceKey,
        input.document.currentRevision.contentHash,
        input.revisionTarget,
      )
      if (identity.documentId !== input.document.documentId) {
        throw new SourceScopeStoreError('conflict', 'Library import resolved a different logical document')
      }
      const existing = identity.exact ?? identity.previous
      const source = readRow(database, `
        SELECT document_id FROM library_source_bindings WHERE source_key = ?
      `, input.sourceKey)
      if (source !== undefined && stringColumn(source, 'document_id') !== input.document.documentId) {
        throw new SourceScopeStoreError('conflict', 'Library source binding belongs to another document')
      }
      const status = identity.exact !== undefined
        ? 'reused'
        : existing === undefined ? 'created' : 'updated'
      if (status === 'updated' && (input.document.currentRevision.previousRevisionId !== identity.previous!.currentRevision.revisionId
        || input.document.currentRevision.revisionId === identity.previous!.currentRevision.revisionId
        || input.document.revisionCount !== identity.previous!.revisionCount + 1 || input.document.createdAt !== identity.previous!.createdAt)
        || status === 'created' && (input.document.revisionCount !== 1 || input.document.currentRevision.previousRevisionId !== undefined)) {
        throw new SourceScopeStoreError('conflict', 'Library revision lineage changed before commit')
      }
      if (status === 'created') {
        const count = database.prepare('SELECT count(*) AS count FROM library_documents').get()
        if (count === undefined || numberColumn(count, 'count') >= MAX_LIBRARY_DOCUMENTS) {
          throw new SourceScopeStoreError('limit-exceeded', 'Library document limit is reached')
        }
      }
      const document = identity.exact ?? input.document
      const currentRow = readRow(database, `
        SELECT aggregate_version FROM library_documents WHERE document_id = ?
      `, document.documentId)
      const bindingIsNew = source === undefined
      const writesEvent = status !== 'reused' || bindingIsNew
      const aggregateVersion = currentRow === undefined
        ? 1
        : numberColumn(currentRow, 'aggregate_version') + (writesEvent ? 1 : 0)
      result = { status, document }
      if (writesEvent) {
        appendLibraryEvent(
          database,
          input.workspaceId,
          document.documentId,
          aggregateVersion,
          input.idempotencyKey,
          bindingIsNew && status === 'reused' ? 'library.source-linked' : 'library.document-imported',
          { document, sourceKey: input.sourceKey },
          document.updatedAt,
        )
      }
      database.prepare(`
        INSERT INTO library_source_bindings (source_key, document_id, root_id, relative_path)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source_key) DO NOTHING
      `).run(input.sourceKey, document.documentId, input.rootId, input.relativePath)
      if (status !== 'reused') {
        if (identity.previous !== undefined) {
          const previousRevision = {
            ...identity.previous.currentRevision,
            status: 'superseded' as const,
            supersededByRevisionId: document.currentRevision.revisionId,
          }
          database.prepare(`
            UPDATE library_revisions SET revision_json = ?
            WHERE document_id = ? AND revision_id = ?
          `).run(
            canonicalJson(previousRevision),
            identity.previous.documentId,
            identity.previous.currentRevision.revisionId,
          )
        }
        database.prepare(`
          INSERT INTO library_revisions (
            document_id, revision_id, content_hash, revision_json, representations_json
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          document.documentId,
          document.currentRevision.revisionId,
          document.currentRevision.contentHash,
          canonicalJson(document.currentRevision),
          canonicalJson(document.representations),
        )
        database.prepare(`
          INSERT INTO library_documents (
            workspace_id, document_id, aggregate_version, current_revision_id,
            current_content_hash, document_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(document_id) DO UPDATE SET
            aggregate_version = excluded.aggregate_version,
            current_revision_id = excluded.current_revision_id,
            current_content_hash = excluded.current_content_hash,
            document_json = excluded.document_json,
            updated_at = excluded.updated_at
        `).run(
          input.workspaceId,
          document.documentId,
          aggregateVersion,
          document.currentRevision.revisionId,
          document.currentRevision.contentHash,
          canonicalJson(document),
          document.updatedAt,
        )
      } else if (writesEvent) {
        database.prepare(`
          UPDATE library_documents SET aggregate_version = ? WHERE document_id = ?
        `).run(aggregateVersion, document.documentId)
      }
      database.prepare(`
        INSERT INTO library_record_idempotency (idempotency_key, request_hash, result_json)
        VALUES (?, ?, ?)
      `).run(input.idempotencyKey, requestHash, canonicalJson(result))
      if (completion) this.completeLibraryJob(completion, document)
    })
    return result!
  }

  /** Explicit original-command repair of an old committed-domain/orphaned-job gap.
   * No ingestion, current-revision substitution, new journal or source-scope admission. */
  reconcileLibraryImport(completion: LibraryRecordCompletion): LibraryJobResult | undefined {
    const database = this.workspaceIfExists(completion.request.workspaceId)
    if (!database) return undefined
    let result: LibraryJobResult | undefined
    transaction(database, () => {
      const job = this.getLibraryImport(completion.request, completion.productCommandHash)
      if (!job) return
      this.requireLibraryCompletion(completion)
      result = job
      if (job.status === 'succeeded') return
      const key = `${completion.jobId}:record`
      const row = readRow(database, 'SELECT request_hash, result_json FROM library_record_idempotency WHERE idempotency_key = ?', key)
      if (!row) return
      const receipt = parseJson(stringColumn(row, 'result_json'))
      if (!isLibraryRecordResult(receipt) || receipt.document.workspaceId !== completion.request.workspaceId) {
        throw new SourceScopeStoreError('integrity-error', 'Library committed record receipt is invalid')
      }
      const { document } = receipt, target = completion.request.revisionTarget
      if (receipt.status === 'created' && (document.revisionCount !== 1 || document.currentRevision.previousRevisionId !== undefined)
        || receipt.status === 'updated' && (document.revisionCount < 2 || document.currentRevision.previousRevisionId === undefined)
        || target && (document.documentId !== target.documentId
        || (receipt.status === 'reused' ? document.currentRevision.revisionId : document.currentRevision.previousRevisionId) !== target.expectedCurrentRevisionId)
        || receipt.status !== 'reused' && document.sourceRole !== completion.request.sourceRole) {
        throw new SourceScopeStoreError('integrity-error', 'Library committed record differs from the original import intent')
      }
      // Verify the entire immutable history and its projections before trusting a historical image.
      this.getLibraryRevisions(completion.request.workspaceId, document.documentId)
      const events = database.prepare('SELECT idempotency_key, event_type, payload_json FROM journal_events WHERE aggregate_id = ? ORDER BY aggregate_version')
        .all(`library:${document.documentId}`)
      const original = events.some(event => canonicalJson(Reflect.get(parseJson(stringColumn(event, 'payload_json')) as object, 'document')) === canonicalJson(document))
      const recordEvent = events.find(event => stringColumn(event, 'idempotency_key') === `library:${key}`)
      if (!original || receipt.status !== 'reused' && !recordEvent
        || recordEvent && (stringColumn(recordEvent, 'event_type') !== (receipt.status === 'reused' ? 'library.source-linked' : 'library.document-imported')
          || canonicalJson(Reflect.get(parseJson(stringColumn(recordEvent, 'payload_json')) as object, 'document')) !== canonicalJson(document))) {
        throw new SourceScopeStoreError('integrity-error', 'Library receipt has no matching original canonical journal image')
      }
      const bindings = database.prepare('SELECT source_key, root_id, relative_path FROM library_source_bindings WHERE document_id = ? LIMIT 4097').all(document.documentId)
      if (bindings.length > 4096) throw new SourceScopeStoreError('limit-exceeded', 'Library receipt reconciliation exceeds its source binding bound')
      const matches = bindings.filter(binding => {
        const sourceKey = stringColumn(binding, 'source_key'), rootId = stringColumn(binding, 'root_id'), relativePath = stringColumn(binding, 'relative_path')
        if (sourceKey !== sha256(`${rootId}\0${relativePath}`) || recordEvent
          && Reflect.get(parseJson(stringColumn(recordEvent, 'payload_json')) as object, 'sourceKey') !== sourceKey) return false
        const input: LibraryRecordInput = { workspaceId: completion.request.workspaceId, idempotencyKey: key, sourceKey, rootId, relativePath, document,
          ...(target === undefined ? {} : { revisionTarget: target }) }
        return sha256(canonicalJson(input)) === stringColumn(row, 'request_hash')
      })
      if (matches.length !== 1) throw new SourceScopeStoreError('integrity-error', 'Library receipt cannot unambiguously reconstruct its original record hash')
      result = this.completeLibraryJob(completion, document)
    })
    return result
  }

  private requireLibraryCompletion(completion: LibraryRecordCompletion): LibraryJobResult {
    const assertion: unknown = completion.assertCurrent()
    if (assertion !== null && typeof assertion === 'object' && 'then' in assertion) {
      void Promise.resolve(assertion).catch(() => undefined)
      throw new SourceScopeStoreError('invalid-request', 'Library completion authority must be synchronous')
    }
    const request = parseContract('library-rpc', completion.request)
    if (!('requestType' in request) || request.requestType !== 'library-import' || libraryRpcIssues(request).length) {
      throw new SourceScopeStoreError('invalid-request', 'Library completion requires the original valid import request')
    }
    const job = this.getLibraryImport(request, completion.productCommandHash)
    if (!job || job.jobId !== completion.jobId || completion.jobId !== `job:${sha256(`${request.workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`) {
      throw new SourceScopeStoreError('integrity-error', 'Library completion has no exact accepted job authority')
    }
    return job
  }

  private completeLibraryJob(completion: LibraryRecordCompletion, document: LibraryDocument): LibraryJobResult {
    const current = this.requireLibraryCompletion(completion)
    if (current.status === 'succeeded') {
      if (canonicalJson(current.document) !== canonicalJson(document)) throw new SourceScopeStoreError('integrity-error', 'Library success receipt names another original document image')
      return current
    }
    const job: LibraryJobResult = { schemaVersion: 1, resultType: 'library-job', workspaceId: current.workspaceId, jobId: current.jobId,
      status: 'succeeded', phase: 'complete', document, createdAt: current.createdAt, updatedAt: completion.completedAt }
    this.updateLibraryJob(job)
    return job
  }

  listLibraryDocuments(workspaceId: string): LibraryDocument[] {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return []
    return database.prepare(`
      SELECT document_json FROM library_documents
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, document_id
    `).all(workspaceId).map(row => parseLibraryDocument(stringColumn(row, 'document_json')))
  }

  getLibraryDocument(workspaceId: string, documentId: string): LibraryDocument | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return undefined
    const row = readRow(database, `
      SELECT document_json FROM library_documents
      WHERE workspace_id = ? AND document_id = ?
    `, workspaceId, documentId)
    return row === undefined ? undefined : parseLibraryDocument(stringColumn(row, 'document_json'))
  }

  eligibleLibrarySources(workspaceId: string): ScopedSourceIdentity[] {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return []
    const documents = new Map(this.listLibraryDocuments(workspaceId)
      .filter(document => document.status !== 'archived')
      .map(document => [document.documentId, document]))
    return database.prepare(`
      SELECT r.document_id, r.revision_id
      FROM library_revisions AS r
      JOIN library_documents AS d ON d.document_id = r.document_id
      WHERE d.workspace_id = ?
      ORDER BY r.document_id, r.revision_id
    `).all(workspaceId).flatMap((row): ScopedSourceIdentity[] => {
      const documentId = stringColumn(row, 'document_id')
      const document = documents.get(documentId)
      if (document === undefined) return []
      const source = this.libraryRevisionSource(
        database,
        document,
        stringColumn(row, 'revision_id'),
      )
      return source === undefined ? [] : [source]
    })
  }

  getEligibleLibrarySource(
    workspaceId: string,
    documentId: string,
    revisionId: string,
  ): ScopedSourceIdentity | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return undefined
    const document = this.getLibraryDocument(workspaceId, documentId)
    if (document === undefined || document.status === 'archived') return undefined
    return this.libraryRevisionSource(database, document, revisionId)
  }

  getLibraryRepresentations(workspaceId: string, documentId: string, revisionId: string): SourceRepresentation[] {
    if (!this.getEligibleLibrarySource(workspaceId, documentId, revisionId)) return []
    const row = readRow(this.workspace(workspaceId), 'SELECT representations_json FROM library_revisions WHERE document_id = ? AND revision_id = ?', documentId, revisionId)
    if (!row) return []
    const value = parseJson(stringColumn(row, 'representations_json'))
    if (!Array.isArray(value)) throw new SourceScopeStoreError('integrity-error', 'Invalid revision representations')
    const representations = value.map(parseSourceRepresentation)
    if (representations.some(item => item.documentId !== documentId || item.revisionId !== revisionId)) throw new SourceScopeStoreError('integrity-error', 'Revision representation identity mismatch')
    return representations
  }

  /** Private host read: original journal-backed revisions, not implicit old-source authorization. */
  getLibraryRevisions(workspaceId: string, documentId: string): StoredLibraryRevision[] {
    const database = this.workspaceIfExists(workspaceId), document = this.getLibraryDocument(workspaceId, documentId)
    if (!database || !document) return []
    const captured = new Map<string, StoredLibraryRevision>()
    let latest: LibraryDocument | undefined, version = 0
    for (const row of database.prepare(`SELECT * FROM journal_events WHERE aggregate_id = ? ORDER BY aggregate_version`).iterate(`library:${documentId}`)) {
      const payloadJson = stringColumn(row, 'payload_json')
      if (stringColumn(row, 'workspace_id') !== workspaceId || numberColumn(row, 'aggregate_version') !== ++version
        || numberColumn(row, 'payload_version') !== 1 || !['library.document-imported', 'library.source-linked'].includes(stringColumn(row, 'event_type'))
        || sha256(payloadJson) !== stringColumn(row, 'payload_hash')) {
        throw new SourceScopeStoreError('integrity-error', 'Library revision journal identity or hash is invalid')
      }
      const payload = parseJson(payloadJson)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'document,sourceKey'
        || typeof Reflect.get(payload, 'sourceKey') !== 'string') throw new SourceScopeStoreError('integrity-error', 'Library revision journal payload is invalid')
      let original: LibraryDocument
      try { original = parseLibraryDocument(canonicalJson(Reflect.get(payload, 'document'))) }
      catch { throw new SourceScopeStoreError('integrity-error', 'Library revision journal document is invalid') }
      if (original.workspaceId !== workspaceId || original.documentId !== documentId) throw new SourceScopeStoreError('integrity-error', 'Library revision journal belongs to another document')
      const item = { revision: original.currentRevision, representations: original.representations }, previous = captured.get(item.revision.revisionId)
      if (previous && canonicalJson(previous) !== canonicalJson(item)) throw new SourceScopeStoreError('integrity-error', 'Library revision identity has conflicting canonical captures')
      if (!previous) {
        if (original.revisionCount !== captured.size + 1 || item.revision.previousRevisionId !== latest?.currentRevision.revisionId) throw new SourceScopeStoreError('integrity-error', 'Library revision chain is invalid')
        captured.set(item.revision.revisionId, item)
      }
      latest = original
    }
    const current = readRow(database, 'SELECT aggregate_version, current_revision_id, current_content_hash FROM library_documents WHERE document_id = ?', documentId)
    if (!latest || canonicalJson(latest) !== canonicalJson(document) || !current || numberColumn(current, 'aggregate_version') !== version
      || stringColumn(current, 'current_revision_id') !== document.currentRevision.revisionId || stringColumn(current, 'current_content_hash') !== document.currentRevision.contentHash) {
      throw new SourceScopeStoreError('integrity-error', 'Library current projection disagrees with its original journal')
    }
    const rows = database.prepare('SELECT * FROM library_revisions WHERE document_id = ?').all(documentId)
    if (rows.length !== captured.size) throw new SourceScopeStoreError('integrity-error', 'Library revision projection count is invalid')
    const result: StoredLibraryRevision[] = []
    const originals = [...captured]
    for (const [index, [revisionId, original]] of originals.entries()) {
      const row = rows.find(item => item.revision_id === revisionId)
      if (!row || stringColumn(row, 'content_hash') !== original.revision.contentHash) throw new SourceScopeStoreError('integrity-error', 'Library revision projection identity is invalid')
      const successor = originals[index + 1]?.[0]
      const expected = { ...original.revision, ...(successor === undefined ? {} : { status: 'superseded' as const, supersededByRevisionId: successor }) }
      let revision: DocumentRevision, representations: SourceRepresentation[]
      try {
        const stored = parseJson(stringColumn(row, 'revision_json'))
        // Earlier writers omitted only this required lifecycle field. Reconstruct it from the
        // verified next revision's backlink, without rewriting old bytes, IDs or persisted rows.
        const legacy = successor !== undefined && canonicalJson(stored) === canonicalJson({ ...original.revision, status: 'superseded' })
        revision = parseContract('document-revision', legacy ? expected : stored)
        const value = parseJson(stringColumn(row, 'representations_json'))
        if (!Array.isArray(value)) throw new Error('Invalid representations')
        representations = value.map(parseSourceRepresentation)
      } catch { throw new SourceScopeStoreError('integrity-error', 'Library revision projection is invalid') }
      if (canonicalJson(revision) !== canonicalJson(expected) || canonicalJson(representations) !== canonicalJson(original.representations)
        || representations.some(item => sourceRepresentationIssues(item, revision).length)) {
        throw new SourceScopeStoreError('integrity-error', 'Library revision bytes or representations disagree with the original journal')
      }
      result.push({ revision, representations })
    }
    return structuredClone(result)
  }

  getCurrentSourceScope(workspaceId: string, investigationId: string): { scope: SourceScopeVersion, sources: ScopedSourceIdentity[] } | undefined {
    return this.readCurrent(workspaceId, investigationId)
  }

  recordAnswerManifest(manifestCandidate: unknown): AnswerManifestRecordStatus {
    const manifest = parseContract('answer-manifest', manifestCandidate)
    const issues = answerManifestIssues(manifest)
    if (issues.length > 0 || manifest.answerTextHash !== answerVisibleTextHash(manifest)) {
      throw new SourceScopeStoreError(
        'invalid-request',
        issues[0]?.message ?? 'answer manifest text hash is invalid',
      )
    }
    const database = this.workspace(manifest.workspaceId)
    const manifestJson = canonicalJson(manifest)
    const existing = readRow(database, `
      SELECT manifest_json FROM answer_manifests
      WHERE session_id = ? AND message_id = ?
    `, manifest.sessionId, manifest.messageId)
    if (existing !== undefined) {
      if (stringColumn(existing, 'manifest_json') !== manifestJson) {
        throw new SourceScopeStoreError(
          'conflict',
          'answer message already has a different immutable manifest',
        )
      }
      return 'replayed'
    }
    const count = database.prepare('SELECT count(*) AS count FROM answer_manifests').get()
    if (count === undefined || numberColumn(count, 'count') >= MAX_ANSWER_MANIFESTS) {
      throw new SourceScopeStoreError('limit-exceeded', 'answer manifest limit is reached')
    }
    database.prepare(`
      INSERT INTO answer_manifests (
        workspace_id, session_id, message_id, manifest_id,
        source_scope_version_id, manifest_json, manifest_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      manifest.workspaceId,
      manifest.sessionId,
      manifest.messageId,
      manifest.manifestId,
      manifest.sourceScopeVersionId,
      manifestJson,
      sha256(manifestJson),
      manifest.createdAt,
    )
    return 'created'
  }

  getAnswerManifest(
    workspaceId: string,
    sessionId: string,
    messageId: string,
  ): AnswerManifest | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return undefined
    const row = readRow(database, `
      SELECT workspace_id, session_id, message_id, manifest_json, manifest_hash
      FROM answer_manifests
      WHERE session_id = ? AND message_id = ?
    `, sessionId, messageId)
    if (row === undefined) return undefined
    const manifestJson = stringColumn(row, 'manifest_json')
    if (sha256(manifestJson) !== stringColumn(row, 'manifest_hash')) {
      throw new SourceScopeStoreError('integrity-error', 'stored answer manifest hash is invalid')
    }
    const manifest = parseAnswerManifest(manifestJson)
    if (stringColumn(row, 'workspace_id') !== workspaceId
      || stringColumn(row, 'session_id') !== sessionId
      || stringColumn(row, 'message_id') !== messageId
      || manifest.workspaceId !== workspaceId
      || manifest.sessionId !== sessionId
      || manifest.messageId !== messageId) {
      throw new SourceScopeStoreError('integrity-error', 'stored answer manifest identity is invalid')
    }
    return manifest
  }

  listAnswerManifests(workspaceId: string, sessionId: string, scopeVersionId?: string, recent?: { maxItems: number }): AnswerManifest[] {
    if (recent && (Object.keys(recent).join(',') !== 'maxItems' || !Number.isSafeInteger(recent.maxItems) || recent.maxItems < 1 || recent.maxItems > 256)) {
      throw new SourceScopeStoreError('invalid-request', 'Recent Answer enumeration requires a bounded item count')
    }
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return []
    return database.prepare(`
      SELECT *
      FROM answer_manifests
      WHERE session_id = ?${scopeVersionId === undefined ? '' : ' AND source_scope_version_id = ?'}
      ORDER BY ${recent ? "CAST(json_extract(manifest_json, '$.turn') AS INTEGER) DESC, rowid DESC" : 'created_at, message_id'}
      ${recent ? 'LIMIT ?' : ''}
    `).all(sessionId, ...(scopeVersionId === undefined ? [] : [scopeVersionId]), ...(recent ? [recent.maxItems] : [])).map((row) => {
      const manifest = verifyCanonicalAnswerRow(row, workspaceId)
      if (manifest.sessionId !== sessionId || scopeVersionId !== undefined && manifest.sourceScopeVersionId !== scopeVersionId) {
        throw new SourceScopeStoreError('integrity-error', 'stored answer manifest identity is invalid')
      }
      return manifest
    })
  }

  replaySelectionAction(
    workspaceId: string,
    requestCandidate: unknown,
  ): SelectionActionResult | undefined {
    const request = parseSelectionActionRequest(requestCandidate)
    const database = this.workspace(workspaceId)
    const row = readRow(database, `
      SELECT * FROM selection_actions WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (row === undefined) return undefined
    if (stringColumn(row, 'request_hash') !== sha256(canonicalJson(request))) {
      throw new SourceScopeStoreError(
        'conflict',
        'selection action idempotency key was already used for a different request',
      )
    }
    const { result } = verifySelectionActionRow(database, workspaceId, row)
    if (result.sessionId !== request.sessionId
      || result.selectionContextId !== request.selectionContextId
      || result.action !== request.action) {
      throw new SourceScopeStoreError('integrity-error', 'selection action replay identity is invalid')
    }
    return { ...result, status: 'replayed' }
  }

  recordSelectionAction(
    workspaceId: string,
    requestCandidate: unknown,
    contextCandidate: unknown,
    resultCandidate: unknown,
  ): SelectionActionResult {
    const request = parseSelectionActionRequest(requestCandidate)
    const replay = this.replaySelectionAction(workspaceId, request)
    if (replay !== undefined) return replay
    const context = parseSelectionContext(contextCandidate)
    const result = parseSelectionActionResult(resultCandidate)
    if (!selectionActionMatches(workspaceId, request, context, result)) {
      throw new SourceScopeStoreError('invalid-request', 'selection action identities are inconsistent')
    }
    const database = this.workspace(workspaceId)
    if (readRow(database, 'SELECT event_id FROM journal_events WHERE idempotency_key = ?',
      request.idempotencyKey) !== undefined) {
      throw new SourceScopeStoreError(
        'conflict',
        'selection action idempotency key was already used by another journal operation',
      )
    }
    const count = database.prepare('SELECT count(*) AS count FROM selection_actions').get()
    if (count === undefined || numberColumn(count, 'count') >= MAX_SELECTION_ACTIONS) {
      throw new SourceScopeStoreError('limit-exceeded', 'selection action record limit is reached')
    }
    const requestHash = sha256(canonicalJson(request))
    const resultJson = canonicalJson(result)
    const contextJson = canonicalJson(context)
    const payloadJson = canonicalJson({
      schemaVersion: 1,
      result,
      context,
    })
    const eventId = `event:${sha256(`${workspaceId}\0${result.actionId}`).slice(0, 32)}`
    transaction(database, () => {
      database.prepare(`
        INSERT INTO journal_events (
          event_id, workspace_id, aggregate_id, aggregate_version, actor_json,
          occurred_at, idempotency_key, event_type, payload_version, payload_json, payload_hash
        ) VALUES (?, ?, ?, 1, ?, ?, ?, 'selection-action.recorded', 1, ?, ?)
      `).run(
        eventId,
        workspaceId,
        result.actionId,
        canonicalJson(result.record.createdBy),
        result.record.createdAt,
        request.idempotencyKey,
        payloadJson,
        sha256(payloadJson),
      )
      database.prepare(`
        INSERT INTO selection_actions (
          action_id, workspace_id, investigation_id, session_id,
          selection_context_id, action, idempotency_key, request_hash,
          result_json, result_hash, context_json, context_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.actionId,
        workspaceId,
        context.investigationId,
        request.sessionId,
        request.selectionContextId,
        request.action,
        request.idempotencyKey,
        requestHash,
        resultJson,
        sha256(resultJson),
        contextJson,
        sha256(contextJson),
        result.record.createdAt,
      )
      upsertResearchRecallProjection(database, researchProjection(result, context))
      for (const overlay of researchTreeProjections(result)) {
        upsertResearchTreeOverlay(database, overlay)
      }
    })
    return result
  }

  listSelectionActions(workspaceId: string, investigationId: string): SelectionActionResult[] {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return []
    return database.prepare(`
      SELECT * FROM selection_actions
      WHERE investigation_id = ?
      ORDER BY created_at, action_id
    `).all(investigationId).map(row =>
      verifySelectionActionRow(database, workspaceId, row).result)
  }

  /**
   * Trusted host read port over canonical Answer/selection captures. This does not authorize a
   * browser, prove a Pi publication, re-resolve a source, or lend old Evidence to a new scope.
   * Note/Recall/Profile record IDs are never interpreted as Evidence IDs.
   */
  getCanonicalEvidence(
    workspaceId: string,
    investigationId: string,
    sourceScopeVersionId: string,
    evidenceId: string,
  ): StoredCanonicalEvidence | undefined {
    for (const id of [workspaceId, investigationId, sourceScopeVersionId, evidenceId]) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(id)) {
        throw new SourceScopeStoreError('invalid-request', 'Canonical Evidence read requires exact scoped identities')
      }
    }
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return undefined
    return resolveCanonicalEvidence(database, workspaceId, evidenceId, { investigationId, sourceScopeVersionId })
  }

  recordM4ClaimVersion(command: RecordClaimVersionCommand) {
    return this.m4(command.workspaceId).recordClaimVersion(command)
  }

  getM4ClaimLedger(workspaceId: string, investigationId: string) {
    return this.m4(workspaceId).getClaimLedger(investigationId)
  }

  /** Private host input, not a public whole-workspace authorization or browser response. */
  getM4WorkspaceSnapshot(workspaceId: string, investigationId: string): M4WorkspaceSnapshot {
    const database = this.workspaceIfExists(workspaceId)
    if (!database) return { artifacts: [], reviews: [], decisions: [] }
    return this.m4(workspaceId).getWorkspaceSnapshot(investigationId)
  }

  recordM4ArtifactDraft(command: RecordArtifactDraftCommand) {
    return this.m4(command.workspaceId).recordArtifactDraft(command)
  }

  recordM4ConflictSearchAssurance(command: RecordConflictSearchAssuranceCommand) {
    return this.m4(command.workspaceId).recordConflictSearchAssurance(command)
  }

  runM4ArtifactReview(command: RunArtifactReviewCommand) {
    return this.m4(command.workspaceId).runArtifactReview(command)
  }

  recordM4HumanReviewDecision(command: RecordHumanReviewDecisionCommand) {
    return this.m4(command.workspaceId).recordHumanReviewDecision(command)
  }

  publishM4Artifact(command: PublishArtifactCommand) {
    return this.m4(command.workspaceId).publishArtifact(command)
  }

  getM4ArtifactManifest(workspaceId: string, artifactManifestId: string) {
    return this.m4(workspaceId).getArtifactManifest(artifactManifestId)
  }

  getM4ReviewResult(workspaceId: string, reviewResultId: string) {
    return this.m4(workspaceId).getReviewResult(reviewResultId)
  }

  assessContinuity(
    request: ContinuityAssessRequest,
    actor: ActorRef & { kind: 'user' | 'rule' },
  ): ContinuityAssessResult {
    return new ContinuityService(this.continuityBackend(request.workspaceId, {
      investigationId: request.investigationId, sourceScopeVersionId: request.scopeVersionId,
    })).assess(request, actor)
  }

  revisionImpact(request: RevisionImpactRequest): RevisionImpactResult {
    return new ContinuityService(this.continuityBackend(request.workspaceId)).revisionImpact(request)
  }

  getContinuityLink(workspaceId: string, continuityLinkId: string): ContinuityLink | undefined {
    return this.continuity(workspaceId).getLink(continuityLinkId)
  }

  /** Trusted host commit port; product authorization and fresh-read checks must finish before this synchronous write. */
  commitContinuityLink(workspaceId: string, idempotencyKey: string, requestHash: string, link: ContinuityLink) {
    if (link.workspaceId !== workspaceId) throw new SourceScopeStoreError('invalid-request', 'Continuity link workspace changed')
    return this.continuity(workspaceId).commitLink(idempotencyKey, requestHash, link)
  }

  replayContinuityLink(workspaceId: string, idempotencyKey: string, requestHash: string) {
    if (!this.workspaceIfExists(workspaceId)) return undefined
    return this.continuity(workspaceId).replayLink(idempotencyKey, requestHash)
  }

  listContinuityLinks(
    workspaceId: string,
    investigationId: string,
    limit?: number,
  ): ContinuityLink[] {
    return this.continuity(workspaceId).listLinks(investigationId, limit)
  }

  /** No ACL or content oracle: only exact immutable IDs, with complete authorization handles or an explicit gap. */
  getContinuityRecord(workspaceId: string, exactRecordId: string): StoredContinuityRecord | undefined {
    for (const id of [workspaceId, exactRecordId]) if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(id)) {
      throw new SourceScopeStoreError('invalid-request', 'Continuity metadata requires exact scoped record identities')
    }
    const database = this.workspaceIfExists(workspaceId)
    if (!database) return undefined
    const record = resolveContinuityRecord(database, this.m4(workspaceId), workspaceId, exactRecordId, true)
    return record ? structuredClone(record) : undefined
  }

  async backupWorkspace(workspaceId: string): Promise<WorkspaceBackup> {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) {
      throw new SourceScopeStoreError('conflict', 'Workspace Investigation database does not exist')
    }
    const directory = join(this.backupsRoot, sha256(workspaceId))
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(directory, DIRECTORY_MODE)
    const createdAt = new Date().toISOString()
    const path = join(
      directory,
      `${createdAt.replaceAll(/[:.]/g, '-')}-${randomUUID()}.sqlite3`,
    )
    database.exec('PRAGMA wal_checkpoint(PASSIVE)')
    await backup(database, path)
    await chmod(path, DATABASE_MODE)
    verifyWorkspaceBackupFile(path, workspaceId, true)
    return {
      workspaceId,
      createdAt,
      path,
      byteLength: (await stat(path)).size,
    }
  }

  getHumanResearchReceipt(workspaceId: string, actorId: string, conversationId: string, operationId: string): HumanResearchReceipt | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (!database) return undefined
    const row = readRow(database, 'SELECT * FROM human_research_commands WHERE operation_id = ?', operationId)
    if (!row) return undefined
    const receipt = verifyHumanResearchReceiptRow(database, workspaceId, row)
    return receipt.actorId === actorId && receipt.conversationId === conversationId ? receipt : undefined
  }

  replayHumanResearchCommand(authority: HumanResearchCommitContext): HumanResearchReceipt | undefined {
    const trusted = humanResearchAuthority(authority)
    trusted.check()
    const result = this.getHumanResearchReceipt(trusted.command.workspaceId, trusted.command.actorId, trusted.command.conversationId, trusted.command.operationId)
    if (result && canonicalJson(humanCommandIdentity(result)) !== canonicalJson(trusted.command)) {
      throw new SourceScopeStoreError('conflict', 'Human research operation was already committed for a different complete command')
    }
    trusted.check()
    return result
  }

  recordHumanResearch(input: HumanResearchCreateInput, authority: HumanResearchCommitContext): HumanResearchReceipt {
    input = structuredClone(input)
    const trusted = humanResearchAuthority(authority)
    trusted.check()
    if (trusted.command.action !== 'create' || input.workspaceId !== trusted.command.workspaceId || input.sourceSessionId !== trusted.command.conversationId) {
      throw new SourceScopeStoreError('invalid-request', 'Human research creation does not match its trusted command')
    }
    const replay = this.replayHumanResearchCommand(authority)
    if (replay) return replay
    const createdAt = new Date().toISOString()
    const recordId = `${input.entry.recordType === 'research-note' ? 'note' : 'question'}:${sha256(`${input.workspaceId}\0${trusted.command.operationId}`).slice(0, 32)}`
    const record = parseHumanResearchRecord({ schemaVersion: 1, origin: 'human-command', recordId,
      workspaceId: input.workspaceId, investigationId: input.investigationId, sourceSessionId: input.sourceSessionId,
      sourceScopeVersionId: input.sourceScopeVersionId, provenanceCommandId: trusted.command.operationId,
      commandHash: trusted.command.requestHash, version: 1, createdBy: trusted.actor, createdAt,
      epistemicStatus: 'unverified', ...structuredClone(input.entry), status: input.entry.recordType === 'research-note' ? 'active' : 'open',
      anchors: structuredClone(input.anchors), sourceIdentities: structuredClone(input.sourceIdentities) }, 'invalid-request')
    const database = this.workspace(input.workspaceId)
    if (numberColumn(database.prepare('SELECT count(*) AS count FROM human_research_records').get()!, 'count') >= MAX_RESEARCH_RECORDS) {
      throw new SourceScopeStoreError('limit-exceeded', 'Human research record limit is reached')
    }
    const recordJson = canonicalJson(record), payloadJson = canonicalJson({ schemaVersion: 1, record })
    const receipt = humanResearchReceipt(trusted.command, recordId, record.recordType, 1, createdAt)
    trusted.check()
    transaction(database, () => {
      trusted.check()
      if (numberColumn(database.prepare('SELECT count(*) AS count FROM human_research_records').get()!, 'count') >= MAX_RESEARCH_RECORDS) {
        throw new SourceScopeStoreError('limit-exceeded', 'Human research record limit is reached')
      }
      database.prepare(`INSERT INTO journal_events (event_id,workspace_id,aggregate_id,aggregate_version,actor_json,occurred_at,idempotency_key,event_type,payload_version,payload_json,payload_hash)
        VALUES (?,?,?,1,?,?,?,'human-research.created',1,?,?)`).run(`event:${sha256(`${input.workspaceId}\0${trusted.command.operationId}`).slice(0, 32)}`,
        input.workspaceId, recordId, canonicalJson(record.createdBy), createdAt, trusted.command.operationId, payloadJson, sha256(payloadJson))
      database.prepare(`INSERT INTO human_research_records(record_id,workspace_id,investigation_id,source_session_id,source_scope_version_id,provenance_command_id,record_json,record_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(recordId, input.workspaceId, input.investigationId, input.sourceSessionId, input.sourceScopeVersionId,
        trusted.command.operationId, recordJson, sha256(recordJson), createdAt)
      upsertResearchRecallProjection(database, researchProjectionFromHumanRecord(record))
      for (const overlay of humanResearchTreeProjections(record)) upsertResearchTreeOverlay(database, overlay)
      commitHumanResearchReceipt(database, receipt, recordId, 'human-research.created')
      trusted.check()
    })
    return receipt
  }

  recordResearch(requestCandidate: unknown): ResearchRecordResult {
    const request = parseResearchRecordRequest(requestCandidate)
    const database = this.workspace(request.workspaceId)
    const requestHash = sha256(canonicalJson(request))
    const replay = readRow(database, `
      SELECT request_hash, result_json, result_hash, record_id
      FROM research_record_idempotency WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay !== undefined) {
      if (stringColumn(replay, 'request_hash') !== requestHash) {
        throw new SourceScopeStoreError(
          'conflict',
          'Research record idempotency key was already used for a different request',
        )
      }
      const resultJson = stringColumn(replay, 'result_json')
      if (sha256(resultJson) !== stringColumn(replay, 'result_hash')) {
        throw new SourceScopeStoreError('integrity-error', 'Research record replay hash is invalid')
      }
      const result = parseResearchRecordResult(resultJson)
      if (result.record.recordId !== stringColumn(replay, 'record_id')
        || researchRecordRpcIssues(result, request).length > 0) {
        throw new SourceScopeStoreError('integrity-error', 'Research record replay identity is invalid')
      }
      return { ...result, status: 'replayed' }
    }
    if (readRow(database, 'SELECT event_id FROM journal_events WHERE idempotency_key = ?',
      request.idempotencyKey) !== undefined) {
      throw new SourceScopeStoreError(
        'conflict',
        'Research record idempotency key was already used by another journal operation',
      )
    }
    const count = database.prepare('SELECT count(*) AS count FROM research_records').get()
    if (count === undefined || numberColumn(count, 'count') >= MAX_RESEARCH_RECORDS) {
      throw new SourceScopeStoreError('limit-exceeded', 'Research record limit is reached')
    }
    const createdAt = new Date().toISOString()
    const recordId = `${request.kind === 'checkpoint' ? 'note' : 'question'}:${sha256(
      `${request.workspaceId}\0${request.idempotencyKey}`,
    ).slice(0, 32)}`
    const common = {
      schemaVersion: 1 as const,
      recordId,
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      sourceSessionId: request.sessionId,
      sourceScopeVersionId: request.scopeVersionId,
      provenanceCallId: request.callId,
      version: 1 as const,
      createdBy: { kind: 'agent' as const, actorId: request.sessionId },
      createdAt,
      epistemicStatus: 'unverified' as const,
    }
    const record: AgentResearchRecord = request.kind === 'checkpoint'
      ? {
          ...common,
          recordType: 'research-note',
          noteKind: 'checkpoint',
          body: request.body,
          status: 'active',
        }
      : {
          ...common,
          recordType: 'open-question',
          question: request.question,
          status: 'open',
        }
    const result: ResearchRecordResult = {
      schemaVersion: 1,
      resultType: 'research-recorded',
      status: 'created',
      record,
    }
    if (researchRecordRpcIssues(result, request).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'Research record result is inconsistent')
    }
    const recordJson = canonicalJson(record)
    const resultJson = canonicalJson(result)
    const payloadJson = canonicalJson({ schemaVersion: 1, record })
    transaction(database, () => {
      database.prepare(`
        INSERT INTO journal_events (
          event_id, workspace_id, aggregate_id, aggregate_version, actor_json,
          occurred_at, idempotency_key, event_type, payload_version, payload_json, payload_hash
        ) VALUES (?, ?, ?, 1, ?, ?, ?, 'research-record.created', 1, ?, ?)
      `).run(
        `event:${sha256(`${request.workspaceId}\0${recordId}`).slice(0, 32)}`,
        request.workspaceId,
        recordId,
        canonicalJson(record.createdBy),
        createdAt,
        request.idempotencyKey,
        payloadJson,
        sha256(payloadJson),
      )
      database.prepare(`
        INSERT INTO research_records (
          record_id, workspace_id, investigation_id, source_session_id,
          source_scope_version_id, provenance_call_id, record_type, aggregate_version,
          record_json, record_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        recordId,
        request.workspaceId,
        request.investigationId,
        request.sessionId,
        request.scopeVersionId,
        request.callId,
        record.recordType,
        recordJson,
        sha256(recordJson),
        createdAt,
      )
      database.prepare(`
        INSERT INTO research_record_idempotency (
          idempotency_key, request_hash, result_json, result_hash, record_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        request.idempotencyKey,
        requestHash,
        resultJson,
        sha256(resultJson),
        recordId,
      )
      upsertResearchRecallProjection(database, researchProjectionFromAgentRecord(record))
    })
    return result
  }

  transitionResearchRecord(requestCandidate: unknown, trustedActor?: ActorRef, authority?: HumanResearchCommitContext): ResearchLifecycleResult {
    const trusted = authority ? humanResearchAuthority(authority) : undefined
    trusted?.check()
    const request = parseResearchLifecycleRequest(requestCandidate)
    if (!trusted && /^human-op:[a-f0-9]{64}$/u.test(request.idempotencyKey)) throw new SourceScopeStoreError('invalid-request', 'Human operation keys require trusted command authority')
    if (trusted && (trusted.command.workspaceId !== request.workspaceId || trusted.command.operationId !== request.idempotencyKey
      || trusted.command.action !== request.action || trustedActor && canonicalJson(trustedActor) !== canonicalJson(trusted.actor))) {
      throw new SourceScopeStoreError('invalid-request', 'Research lifecycle differs from its trusted human command')
    }
    if (trusted) trustedActor = trusted.actor
    if (trustedActor !== undefined && (trustedActor.kind !== 'user' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(trustedActor.actorId))) throw new SourceScopeStoreError('invalid-request', 'Research lifecycle requires a trusted human actor')
    const database = this.workspace(request.workspaceId)
    if (!trusted && readRow(database, 'SELECT record_id FROM human_research_records WHERE record_id = ?', request.recordId)) {
      throw new SourceScopeStoreError('invalid-request', 'Human-created research records require a human command and receipt')
    }
    const requestHash = sha256(canonicalJson(trusted ? { request, actor: trusted.actor, productCommand: trusted.command } : trustedActor ? { request, actor: trustedActor } : request))
    const replay = readRow(database, `
      SELECT request_hash, result_json, result_hash, record_id
      FROM research_lifecycle_idempotency WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay !== undefined) {
      if (stringColumn(replay, 'request_hash') !== requestHash) {
        throw new SourceScopeStoreError(
          'conflict',
          'Research lifecycle idempotency key was already used for a different request',
        )
      }
      const resultJson = stringColumn(replay, 'result_json')
      if (sha256(resultJson) !== stringColumn(replay, 'result_hash')) {
        throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay hash is invalid')
      }
      const result = parseResearchLifecycleResult(resultJson)
      if (result.state.recordId !== stringColumn(replay, 'record_id')
        || researchLifecycleRpcIssues(result, request).length > 0) {
        throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay identity is invalid')
      }
      if (authority && !this.replayHumanResearchCommand(authority)) throw new SourceScopeStoreError('integrity-error', 'Human lifecycle receipt is missing')
      trusted?.check()
      return { ...result, status: 'replayed' }
    }
    if (readRow(database, 'SELECT event_id FROM journal_events WHERE idempotency_key = ?',
      request.idempotencyKey) !== undefined) {
      throw new SourceScopeStoreError(
        'conflict',
        'Research lifecycle idempotency key was already used by another journal operation',
      )
    }
    const base = researchLifecycleBase(database, request.workspaceId, request.recordId)
    if (base === undefined) {
      throw new SourceScopeStoreError('conflict', 'Research record does not exist')
    }
    if (base.investigationId !== request.investigationId) {
      throw new SourceScopeStoreError('conflict', 'Research record belongs to another Investigation')
    }
    const stateRow = readRow(database, 'SELECT * FROM research_record_states WHERE record_id = ?', request.recordId)
    const currentState = stateRow === undefined
      ? undefined
      : verifyResearchLifecycleState(database, request.workspaceId, stateRow)
    const currentVersion = currentState?.version ?? 1
    if (request.expectedVersion !== currentVersion) {
      throw new SourceScopeStoreError('conflict', 'Research record compare-and-set precondition failed')
    }
    if (currentState?.status === 'deleted') {
      throw new SourceScopeStoreError('conflict', 'deleted Research record cannot transition')
    }
    const currentText = currentState?.text ?? base.currentText
    let status: ResearchRecordState['status']
    let text: string | undefined
    switch (request.action) {
      case 'edit': {
        const maximum = base.recordType === 'open-question' ? 4000 : 8000
        const candidate = request.text?.normalize('NFC').trim() ?? ''
        if ([...candidate].length < 1 || [...candidate].length > maximum) {
          throw new SourceScopeStoreError('invalid-request', 'Research record replacement text is invalid')
        }
        status = base.recordType === 'open-question' ? 'open' : 'active'
        text = candidate
        break
      }
      case 'resolve':
        if (base.recordType !== 'open-question') {
          throw new SourceScopeStoreError('conflict', 'only an Open Question can be resolved')
        }
        status = 'resolved'
        text = currentText
        break
      case 'archive':
        status = 'archived'
        text = currentText
        break
      case 'delete':
        status = 'deleted'
        break
    }
    const state: ResearchRecordState = {
      schemaVersion: 1,
      recordId: base.recordId,
      workspaceId: base.workspaceId,
      investigationId: base.investigationId,
      recordType: base.recordType,
      version: currentVersion + 1,
      previousVersion: currentVersion,
      status,
      epistemicStatus: 'unverified',
      ...(text === undefined ? {} : { text }),
      updatedBy: trustedActor ? { ...trustedActor } : { kind: 'user', actorId: request.sessionId },
      updatedAt: new Date().toISOString(),
    }
    const result: ResearchLifecycleResult = {
      schemaVersion: 1,
      resultType: 'research-record-lifecycle',
      status: 'updated',
      state,
    }
    if (researchLifecycleRpcIssues(result, request).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'Research lifecycle result is inconsistent')
    }
    const stateJson = canonicalJson(state)
    const resultJson = canonicalJson(result)
    const payloadJson = canonicalJson({ schemaVersion: 1, state })
    trusted?.check()
    transaction(database, () => {
      trusted?.check()
      database.prepare(`
        INSERT INTO journal_events (
          event_id, workspace_id, aggregate_id, aggregate_version, actor_json,
          occurred_at, idempotency_key, event_type, payload_version, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'research-record.lifecycle', 1, ?, ?)
      `).run(
        `event:${sha256(`${request.workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`,
        request.workspaceId,
        base.aggregateId,
        state.version,
        canonicalJson(state.updatedBy),
        state.updatedAt,
        request.idempotencyKey,
        payloadJson,
        sha256(payloadJson),
      )
      database.prepare(`
        INSERT INTO research_record_states (
          record_id, workspace_id, investigation_id, version, state_json, state_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          version = excluded.version,
          state_json = excluded.state_json,
          state_hash = excluded.state_hash,
          updated_at = excluded.updated_at
      `).run(
        base.recordId,
        base.workspaceId,
        base.investigationId,
        state.version,
        stateJson,
        sha256(stateJson),
        state.updatedAt,
      )
      database.prepare(`
        INSERT INTO research_lifecycle_idempotency (
          idempotency_key, request_hash, result_json, result_hash, record_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        request.idempotencyKey,
        requestHash,
        resultJson,
        sha256(resultJson),
        base.recordId,
      )
      deleteResearchRecallProjection(database, base.recordId)
      if (state.status !== 'deleted') {
        upsertResearchRecallProjection(
          database,
          researchProjectionWithState(base.projection, state),
        )
      }
      deleteResearchTreeOverlays(database, base.recordId)
      if (state.status !== 'deleted') {
        for (const overlay of base.treeOverlays) {
          upsertResearchTreeOverlay(database, researchTreeProjectionWithState(overlay, state))
        }
      }
      if (trusted) commitHumanResearchReceipt(database, humanResearchReceipt(trusted.command, base.recordId, base.recordType, state.version, state.updatedAt), base.aggregateId, 'research-record.lifecycle')
      trusted?.check()
    })
    return result
  }

  mutateResearchGovernance(requestCandidate: unknown, authority?: HumanResearchCommitContext): ResearchGovernanceResult {
    const trusted = authority ? humanResearchAuthority(authority) : undefined
    trusted?.check()
    const request = parseResearchGovernanceRequest(requestCandidate)
    if (!trusted && /^human-op:[a-f0-9]{64}$/u.test(request.idempotencyKey)) throw new SourceScopeStoreError('invalid-request', 'Human operation keys require trusted command authority')
    if (trusted && (trusted.command.workspaceId !== request.workspaceId || trusted.command.operationId !== request.idempotencyKey || trusted.command.action !== request.action)) {
      throw new SourceScopeStoreError('invalid-request', 'Research governance differs from its trusted human command')
    }
    const database = this.workspace(request.workspaceId)
    const originalSources = request.action === 'create' ? undefined : humanGovernanceOrigin(database, request.workspaceId, request.recordId)?.humanCommand?.sourceIdentities
    if (originalSources !== undefined && !trusted) throw new SourceScopeStoreError('invalid-request', 'Human-created Governance requires a human command and receipt')
    if (trusted && (request.action === 'create' || originalSources !== undefined) && trusted.governanceSources === undefined) {
      throw new SourceScopeStoreError('invalid-request', 'Human Governance requires its complete original source capture')
    }
    if (originalSources !== undefined && canonicalJson(originalSources) !== canonicalJson(trusted?.governanceSources)) {
      throw new SourceScopeStoreError('conflict', 'Human Governance cannot change its original source representations')
    }
    const governanceSources = originalSources ?? trusted?.governanceSources ?? []
    const requestHash = sha256(canonicalJson(trusted ? { request, actor: trusted.actor, productCommand: trusted.command, governanceSources } : request))
    const replay = readRow(database, `
      SELECT request_hash, result_json, result_hash, record_id
      FROM research_governance_idempotency WHERE idempotency_key = ?
    `, request.idempotencyKey)
    if (replay !== undefined) {
      if (stringColumn(replay, 'request_hash') !== requestHash) {
        throw new SourceScopeStoreError(
          'conflict',
          'Research Governance idempotency key was already used for a different request',
        )
      }
      const resultJson = stringColumn(replay, 'result_json')
      if (sha256(resultJson) !== stringColumn(replay, 'result_hash')) {
        throw new SourceScopeStoreError('integrity-error', 'Research Governance replay hash is invalid')
      }
      const result = parseResearchGovernanceResult(resultJson)
      if (result.record.recordId !== stringColumn(replay, 'record_id')
        || researchGovernanceRpcIssues(result, request).length > 0) {
        throw new SourceScopeStoreError('integrity-error', 'Research Governance replay identity is invalid')
      }
      if (authority && !this.replayHumanResearchCommand(authority)) throw new SourceScopeStoreError('integrity-error', 'Human governance receipt is missing')
      trusted?.check()
      return { ...result, status: 'replayed' }
    }
    if (readRow(database, 'SELECT event_id FROM journal_events WHERE idempotency_key = ?',
      request.idempotencyKey) !== undefined) {
      throw new SourceScopeStoreError(
        'conflict',
        'Research Governance idempotency key was already used by another journal operation',
      )
    }

    let previous: ResearchGovernanceRecord | undefined
    let recordId: string
    if (request.action === 'create') {
      const count = database.prepare('SELECT count(*) AS count FROM research_governance_records').get()
      if (count === undefined || numberColumn(count, 'count') >= MAX_RESEARCH_GOVERNANCE_RECORDS) {
        throw new SourceScopeStoreError('limit-exceeded', 'Research Governance record limit is reached')
      }
      const prefix = request.entry.recordType === 'project-decision' ? 'decision' : 'policy'
      recordId = `${prefix}:${sha256(`${request.workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`
      if (readRow(database, 'SELECT record_id FROM research_governance_records WHERE record_id = ?',
        recordId) !== undefined) {
        throw new SourceScopeStoreError('conflict', 'Research Governance record identity already exists')
      }
    } else {
      recordId = request.recordId
      const row = readRow(database, `
        SELECT * FROM research_governance_records WHERE record_id = ?
      `, recordId)
      if (row === undefined) {
        throw new SourceScopeStoreError('conflict', 'Research Governance record does not exist')
      }
      previous = verifyResearchGovernanceRow(database, request.workspaceId, row)
      if (originalSources !== undefined && (request.sessionId !== previous.sourceSessionId || request.scopeVersionId !== previous.sourceScopeVersionId)) {
        throw new SourceScopeStoreError('conflict', 'Human Governance cannot rebind its original source frame')
      }
      if (previous.investigationId !== request.investigationId) {
        throw new SourceScopeStoreError('conflict', 'Research Governance record belongs to another Investigation')
      }
      if (previous.version !== request.expectedVersion) {
        throw new SourceScopeStoreError('conflict', 'Research Governance compare-and-set precondition failed')
      }
      if (previous.status === 'deleted') {
        throw new SourceScopeStoreError('conflict', 'deleted Research Governance record cannot transition')
      }
      if (request.action === 'archive' && previous.status !== 'active') {
        throw new SourceScopeStoreError('conflict', 'only an active Research Governance record can be archived')
      }
      if (request.action === 'revise' && request.entry.recordType !== previous.recordType) {
        throw new SourceScopeStoreError('conflict', 'Research Governance record type cannot change')
      }
    }

    const now = new Date().toISOString()
    const actor = trusted?.actor ?? {
      kind: 'user' as const,
      actorId: `user:${sha256(request.sessionId).slice(0, 32)}`,
    }
    const common = {
      schemaVersion: 1 as const,
      recordId,
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      sourceSessionId: request.sessionId,
      sourceScopeVersionId: request.scopeVersionId,
      recordType: request.action === 'create' || request.action === 'revise'
        ? request.entry.recordType
        : previous!.recordType,
      version: previous === undefined ? 1 : previous.version + 1,
      createdBy: previous?.createdBy ?? actor,
      updatedBy: actor,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    let record: ResearchGovernanceRecord
    if (request.action === 'delete') {
      record = { ...common, status: 'deleted' }
    } else {
      const entry = request.action === 'create' || request.action === 'revise'
        ? request.entry
        : governanceEntryFromRecord(previous!)
      record = {
        ...common,
        ...structuredClone(entry),
        status: request.action === 'archive' ? 'archived' : 'active',
      } as ResearchGovernanceRecord
    }
    const result: ResearchGovernanceResult = {
      schemaVersion: 1,
      resultType: 'research-governance',
      status: previous === undefined ? 'created' : 'updated',
      record,
    }
    if (researchGovernanceRpcIssues(result, request).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'Research Governance result is inconsistent')
    }
    const recordJson = canonicalJson(record)
    const resultJson = canonicalJson(result)
    const payloadJson = canonicalJson({ schemaVersion: 1, record, ...(trusted ? { humanCommand: { identity: trusted.command, sourceIdentities: governanceSources } } : {}) })
    const eventType = request.action === 'create'
      ? 'research-governance.created'
      : request.action === 'revise'
        ? 'research-governance.revised'
        : request.action === 'archive'
          ? 'research-governance.archived'
          : 'research-governance.deleted'
    trusted?.check()
    transaction(database, () => {
      trusted?.check()
      database.prepare(`
        INSERT INTO journal_events (
          event_id, workspace_id, aggregate_id, aggregate_version, actor_json,
          occurred_at, idempotency_key, event_type, payload_version, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        `event:${sha256(`${request.workspaceId}\0${request.idempotencyKey}`).slice(0, 32)}`,
        request.workspaceId,
        record.recordId,
        record.version,
        canonicalJson(record.updatedBy),
        record.updatedAt,
        request.idempotencyKey,
        eventType,
        payloadJson,
        sha256(payloadJson),
      )
      database.prepare(`
        INSERT INTO research_governance_records (
          record_id, workspace_id, investigation_id, source_session_id,
          source_scope_version_id, record_type, aggregate_version, status,
          record_json, record_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          source_session_id = excluded.source_session_id,
          source_scope_version_id = excluded.source_scope_version_id,
          aggregate_version = excluded.aggregate_version,
          status = excluded.status,
          record_json = excluded.record_json,
          record_hash = excluded.record_hash,
          updated_at = excluded.updated_at
      `).run(
        record.recordId,
        record.workspaceId,
        record.investigationId,
        record.sourceSessionId,
        record.sourceScopeVersionId,
        record.recordType,
        record.version,
        record.status,
        recordJson,
        sha256(recordJson),
        record.createdAt,
        record.updatedAt,
      )
      database.prepare(`
        INSERT INTO research_governance_idempotency (
          idempotency_key, request_hash, result_json, result_hash, record_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        request.idempotencyKey,
        requestHash,
        resultJson,
        sha256(resultJson),
        record.recordId,
      )
      deleteResearchRecallProjection(database, record.recordId)
      if (record.status !== 'deleted') {
        upsertResearchRecallProjection(database, researchProjectionFromGovernanceRecord(record, governanceSources))
      }
      if (trusted) commitHumanResearchReceipt(database, humanResearchReceipt(trusted.command, record.recordId, record.recordType, record.version, record.updatedAt), record.recordId, eventType)
      trusted?.check()
    })
    return result
  }

  recallResearch(
    requestCandidate: unknown,
    currentSources: readonly ResearchSourceIdentity[],
    visibility?: ResearchVisibility,
  ): ResearchRecallResult {
    const request = parseResearchRecallRequest(requestCandidate)
    const database = this.workspace(request.workspaceId)
    const query = normalizeRecallQuery(request.query)
    const ftsQuery = recallFtsQuery(query)
    const placeholders = request.recordTypes.map(() => '?').join(',')
    const allowed = visibility ? researchVisibleIds(database, visibility) : undefined
    const clause = allowed === undefined ? '' : ' AND record_id IN (SELECT value FROM json_each(?))'
    const qualifiedClause = allowed === undefined ? '' : ' AND r.record_id IN (SELECT value FROM json_each(?))'
    const visibilityParams = allowed === undefined ? [] : [JSON.stringify(allowed)]
    const fingerprintRows = database.prepare(`
      SELECT record_id, projection_hash
      FROM research_recall_records
      WHERE record_type IN (${placeholders})${clause}
      ORDER BY record_id
    `).all(...request.recordTypes, ...visibilityParams)
    const fingerprint = sha256(canonicalJson(fingerprintRows.map(row => ({
      recordId: stringColumn(row, 'record_id'),
      projectionHash: stringColumn(row, 'projection_hash'),
    }))))
    const queryHash = sha256(canonicalJson({
      workspaceId: request.workspaceId,
      scopeVersionId: request.scopeVersionId,
      query,
      recordTypes: [...request.recordTypes].sort(),
      fingerprint,
    }))
    const offset = parseRecallCursor(request.cursor, queryHash)
    const countRow = database.prepare(`
      SELECT count(*) AS count
      FROM research_recall_fts AS f
      JOIN research_recall_records AS r ON r.record_id = f.record_id
      WHERE research_recall_fts MATCH ?
        AND r.record_type IN (${placeholders})${qualifiedClause}
    `).get(ftsQuery, ...request.recordTypes, ...visibilityParams)
    if (countRow === undefined) {
      throw new SourceScopeStoreError('integrity-error', 'Research Recall count is unavailable')
    }
    const total = numberColumn(countRow, 'count')
    if (offset > total) {
      throw new SourceScopeStoreError('invalid-request', 'Research Recall cursor is exhausted')
    }
    const rows = database.prepare(`
      SELECT r.*${visibility ? '' : ', bm25(research_recall_fts) AS rank'}
      FROM research_recall_fts AS f
      JOIN research_recall_records AS r ON r.record_id = f.record_id
      WHERE research_recall_fts MATCH ?
        AND r.record_type IN (${placeholders})${qualifiedClause}
      ORDER BY ${visibility ? '' : 'rank, '}r.created_at DESC, r.record_id
      LIMIT ? OFFSET ?
    `).all(
      ftsQuery,
      ...request.recordTypes,
      ...visibilityParams,
      request.limits.maxItems + 1,
      offset,
    )
    const current = new Set(currentSources.map(researchSourceKey))
    const leads: ResearchRecallResult['leads'] = []
    let usedChars = 0
    for (const row of rows) {
      if (leads.length >= request.limits.maxItems) break
      const remaining = request.limits.maxChars - usedChars
      if (remaining <= 0) break
      const sourceIdentities = parseResearchSourceIdentities(
        stringColumn(row, 'source_identities_json'),
      )
      const preview = [...stringColumn(row, 'preview_text')].slice(0, remaining).join('')
      if (preview.length === 0) continue
      const inScope = sourceIdentities.filter(source => current.has(researchSourceKey(source))).length
      const sourceState = sourceIdentities.length === 0
        ? 'none' as const
        : inScope === sourceIdentities.length
          ? 'current-scope' as const
          : inScope === 0
            ? 'outside-current-scope' as const
            : 'mixed' as const
      const sourceScopeVersionId = optionalStringColumn(row, 'source_scope_version_id')
      const provenanceCallId = optionalStringColumn(row, 'provenance_call_id')
      const recordId = stringColumn(row, 'record_id')
      const recordType = researchRecordTypeColumn(row)
      leads.push({
        leadId: `lead:${sha256(`${queryHash}\0${recordId}`).slice(0, 32)}`,
        recordId,
        recordType,
        recordStatus: researchRecordStatusColumn(row),
        sourceInvestigationId: stringColumn(row, 'investigation_id'),
        sourceSessionId: stringColumn(row, 'source_session_id'),
        ...(sourceScopeVersionId === undefined ? {} : { sourceScopeVersionId }),
        ...(provenanceCallId === undefined ? {} : { provenanceCallId }),
        preview,
        sourceIdentities,
        sourceState,
        verificationStatus: 'unverified-lead',
        reason: recordType === 'project-decision' || recordType === 'research-policy'
          ? 'User-authored governance record; it is not document evidence. Confirm active scope before applying it.'
          : sourceState === 'current-scope'
            ? 'Lexical match in prior research; re-read the current source before factual use.'
            : sourceState === 'none'
              ? 'Lexical match in prior research; this record is a lead, not evidence.'
              : 'Lexical match in prior research; source inclusion and re-verification are required.',
        createdAt: stringColumn(row, 'created_at'),
      })
      usedChars += [...preview].length
    }
    const consumed = offset + leads.length
    const truncated = consumed < total
    const result: ResearchRecallResult = {
      schemaVersion: 1,
      resultType: 'research-recall',
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      scopeVersionId: request.scopeVersionId,
      queryHash,
      leads,
      pageInfo: {
        schemaVersion: 1,
        limit: request.limits.maxItems,
        returned: leads.length,
        total,
        usedChars,
        truncated,
        completeness: 'candidate',
        ...(truncated ? { nextCursor: recallCursor(queryHash, consumed) } : {}),
      },
    }
    if (researchRecallRpcIssues(result, request).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'Research Recall result is inconsistent')
    }
    return result
  }

  queryResearchNotebook(
    requestCandidate: unknown,
    currentSources: readonly ResearchSourceIdentity[],
    visibility?: ResearchVisibility,
  ): ResearchNotebookResult {
    const request = parseResearchNotebookRequest(requestCandidate)
    const database = this.workspaceIfExists(request.workspaceId)
    if (!database) return emptyResearchNotebook(request)
    const typePlaceholders = request.recordTypes.map(() => '?').join(',')
    const statusPlaceholders = request.recordStatuses.map(() => '?').join(',')
    const viewClause = request.view === 'working' ? ' AND investigation_id = ?' : ''
    const allowed = visibility ? researchVisibleIds(database, visibility) : undefined
    const visibilityClause = allowed === undefined ? '' : ' AND record_id IN (SELECT value FROM json_each(?))'
    const where = `
      record_type IN (${typePlaceholders})
      AND record_status IN (${statusPlaceholders})${viewClause}${visibilityClause}
    `
    const params = [
      ...request.recordTypes,
      ...request.recordStatuses,
      ...(request.view === 'working' ? [request.investigationId] : []),
      ...(allowed === undefined ? [] : [JSON.stringify(allowed)]),
    ]
    const fingerprintRows = database.prepare(`
      SELECT record_id, projection_hash
      FROM research_recall_records
      WHERE ${where}
      ORDER BY record_id
    `).all(...params)
    const total = fingerprintRows.length
    const generation = sha256(canonicalJson(fingerprintRows.map(row => ({
      recordId: stringColumn(row, 'record_id'),
      projectionHash: stringColumn(row, 'projection_hash'),
    }))))
    const queryHash = sha256(canonicalJson({
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      scopeVersionId: request.scopeVersionId,
      view: request.view,
      recordTypes: [...request.recordTypes].sort(),
      recordStatuses: [...request.recordStatuses].sort(),
      generation,
    }))
    const offset = parseResearchNotebookCursor(request.cursor, queryHash)
    if (offset > total) {
      throw new SourceScopeStoreError('invalid-request', 'Research Notebook cursor is exhausted')
    }
    const rows = database.prepare(`
      SELECT * FROM research_recall_records
      WHERE ${where}
      ORDER BY created_at DESC, record_id
      LIMIT ? OFFSET ?
    `).all(...params, request.limits.maxItems + 1, offset)
    const current = new Set(currentSources.map(researchSourceKey))
    const items: ResearchNotebookItem[] = []
    let usedChars = 0
    for (const row of rows) {
      if (items.length >= request.limits.maxItems) break
      const remaining = request.limits.maxChars - usedChars
      if (remaining <= 0) break
      const sourceIdentities = parseResearchSourceIdentities(
        stringColumn(row, 'source_identities_json'),
      )
      const preview = [...stringColumn(row, 'preview_text')].slice(0, remaining).join('')
      if (preview.length === 0) continue
      const inScope = sourceIdentities.filter(source => current.has(researchSourceKey(source))).length
      const sourceState = sourceIdentities.length === 0
        ? 'none' as const
        : inScope === sourceIdentities.length
          ? 'current-scope' as const
          : inScope === 0
            ? 'outside-current-scope' as const
            : 'mixed' as const
      const recordId = stringColumn(row, 'record_id')
      const recordType = researchRecordTypeColumn(row)
      const sourceInvestigationId = stringColumn(row, 'investigation_id')
      const sourceScopeVersionId = optionalStringColumn(row, 'source_scope_version_id')
      items.push({
        itemId: `notebook:${sha256(`${queryHash}\0${recordId}`).slice(0, 32)}`,
        recordId,
        recordType,
        recordStatus: activeResearchRecordStatusColumn(row),
        recordVersion: numberColumn(row, 'record_version'),
        sourceInvestigationId,
        sourceSessionId: stringColumn(row, 'source_session_id'),
        ...(sourceScopeVersionId === undefined ? {} : { sourceScopeVersionId }),
        layer: sourceInvestigationId === request.investigationId ? 'working' : 'research',
        preview,
        sourceIdentities,
        sourceState,
        useStatus: recordType === 'project-decision' || recordType === 'research-policy'
          ? 'user-governance'
          : 'unverified-lead',
        updatedAt: stringColumn(row, 'created_at'),
      })
      usedChars += [...preview].length
    }
    const consumed = offset + items.length
    const truncated = consumed < total
    const result: ResearchNotebookResult = {
      schemaVersion: 1,
      resultType: 'research-notebook',
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      scopeVersionId: request.scopeVersionId,
      view: request.view,
      queryHash,
      items,
      pageInfo: {
        schemaVersion: 1,
        limit: request.limits.maxItems,
        returned: items.length,
        total,
        usedChars,
        truncated,
        completeness: truncated ? 'partial' : 'complete',
        ...(truncated ? { nextCursor: researchNotebookCursor(queryHash, consumed) } : {}),
      },
    }
    if (researchNotebookRpcIssues(result, request).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'Research Notebook result is inconsistent')
    }
    return result
  }

  /** Canonical content plus the latest typed lifecycle overlay, never a truncated Notebook preview. */
  getResearchNote(workspaceId: string, recordId: string): StoredResearchNote | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (!database) return undefined
    const agentRow = readRow(database, 'SELECT * FROM research_records WHERE record_id = ?', recordId)
    let value: StoredResearchNote
    if (agentRow) {
      const record = verifyResearchRecordRow(database, workspaceId, agentRow)
      value = { recordId, recordType: record.recordType, workspaceId, investigationId: record.investigationId, sourceSessionId: record.sourceSessionId,
        scopeVersionId: record.sourceScopeVersionId, version: 1, status: record.status,
        text: record.recordType === 'research-note' ? record.body : record.question, locators: [], evidence: [], authoredBy: 'agent', sourceIdentities: [], anchors: [] }
    } else {
      const humanRow = readRow(database, 'SELECT * FROM human_research_records WHERE record_id = ?', recordId)
      if (humanRow) {
        const record = verifyHumanResearchRecordRow(database, workspaceId, humanRow)
        value = { recordId, recordType: record.recordType, workspaceId, investigationId: record.investigationId, sourceSessionId: record.sourceSessionId,
          scopeVersionId: record.sourceScopeVersionId, version: 1, status: record.status,
          text: record.recordType === 'research-note' ? record.body : record.question, locators: record.anchors.map(anchor => anchor.locator),
          evidence: [], authoredBy: 'user', sourceIdentities: record.sourceIdentities, anchors: record.anchors }
      } else {
      const row = readRow(database, `SELECT * FROM selection_actions WHERE json_extract(result_json, '$.record.noteId') = ? OR json_extract(result_json, '$.record.questionId') = ?`, recordId, recordId)
      if (!row) return undefined
      const { result, context } = verifySelectionActionRow(database, workspaceId, row), record = result.record
      if (record.recordType !== 'research-note' && record.recordType !== 'open-question') return undefined
      value = { recordId, recordType: record.recordType, workspaceId, investigationId: record.investigationId, sourceSessionId: result.sessionId,
        scopeVersionId: context.scopeVersionId, version: 1, status: record.status,
        text: record.recordType === 'research-note' ? record.body : record.question, locators: result.locators, evidence: result.evidence, authoredBy: 'user',
        sourceIdentities: researchProjection(result, context).sourceIdentities, anchors: [] }
      }
    }
    const stateRow = readRow(database, 'SELECT * FROM research_record_states WHERE record_id = ?', recordId)
    if (stateRow) {
      const state = verifyResearchLifecycleState(database, workspaceId, stateRow)
      value = { ...value, version: state.version, status: state.status, text: state.text ?? null,
        ...(state.status === 'deleted' ? { locators: [], evidence: [], anchors: [] } : {}) }
    }
    return value
  }

  /** Complete human governance content, never a truncated Notebook preview. Hosts authorize the
   * original conversation and captured scope before exposing this value. */
  getResearchGovernance(workspaceId: string, recordId: string): ResearchGovernanceRecord | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (!database) return undefined
    const row = readRow(database, 'SELECT * FROM research_governance_records WHERE record_id = ?', recordId)
    return row ? verifyResearchGovernanceRow(database, workspaceId, row) : undefined
  }

  /** Exact creation-frame representations for new human Governance; undefined distinguishes legacy creation. */
  getResearchGovernanceSources(workspaceId: string, recordId: string): ResearchSourceIdentity[] | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (!database || !this.getResearchGovernance(workspaceId, recordId)) return undefined
    return humanGovernanceOrigin(database, workspaceId, recordId)?.humanCommand?.sourceIdentities
  }

  treeOverlay(requestCandidate: unknown, visibility?: ResearchVisibility): TreeOverlayResult {
    const request = parseTreeOverlayRequest(requestCandidate)
    const database = this.workspaceIfExists(request.workspaceId)
    if (!database) return emptyResearchTreeOverlay(request)
    const typePlaceholders = request.recordTypes.map(() => '?').join(',')
    const pageClause = request.physicalPage === undefined ? '' : ' AND physical_page = ?'
    const allowed = visibility ? researchVisibleIds(database, visibility) : undefined
    const visibilityClause = allowed === undefined ? '' : ' AND record_id IN (SELECT value FROM json_each(?))'
    const where = `
      document_id = ? AND revision_id = ? AND representation_id = ?
      AND representation_hash = ?
      AND record_type IN (${typePlaceholders})${pageClause}${visibilityClause}
    `
    const params: Array<string | number> = [
      request.source.documentId,
      request.source.revisionId,
      request.source.representationId,
      request.source.representationContentHash,
      ...request.recordTypes,
      ...(request.physicalPage === undefined ? [] : [request.physicalPage]),
      ...(allowed === undefined ? [] : [JSON.stringify(allowed)]),
    ]
    const fingerprintRows = database.prepare(`
      SELECT overlay_id, projection_hash
      FROM research_tree_overlays WHERE ${where}
      ORDER BY overlay_id
    `).all(...params)
    const total = fingerprintRows.length
    const generation = sha256(canonicalJson(fingerprintRows.map(row => ({
      overlayId: stringColumn(row, 'overlay_id'),
      projectionHash: stringColumn(row, 'projection_hash'),
    }))))
    const queryHash = sha256(canonicalJson({
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      scopeVersionId: request.scopeVersionId,
      source: request.source,
      physicalPage: request.physicalPage,
      recordTypes: [...request.recordTypes].sort(),
      generation,
    }))
    const offset = parseTreeOverlayCursor(request.cursor, queryHash)
    if (offset > total) {
      throw new SourceScopeStoreError('invalid-request', 'Research Tree Overlay cursor is exhausted')
    }
    const rows = database.prepare(`
      SELECT * FROM research_tree_overlays
      WHERE ${where}
      ORDER BY physical_page, created_at DESC, overlay_id
      LIMIT ? OFFSET ?
    `).all(...params, request.limits.maxItems + 1, offset)
    const items: TreeOverlayItem[] = []
    let usedChars = 0
    for (const row of rows) {
      if (items.length >= request.limits.maxItems) break
      const remaining = request.limits.maxChars - usedChars
      if (remaining <= 0) break
      const projected = treeOverlayItemFromRow(request.workspaceId, row)
      const item: TreeOverlayItem = {
        ...projected,
        layer: projected.sourceInvestigationId === request.investigationId
          ? 'working'
          : 'research',
      }
      const previewChars = [...item.preview].length
      if (previewChars > remaining) break
      items.push(item)
      usedChars += previewChars
    }
    const consumed = offset + items.length
    const truncated = consumed < total
    const result: TreeOverlayResult = {
      schemaVersion: 1,
      resultType: 'tree-overlay',
      workspaceId: request.workspaceId,
      investigationId: request.investigationId,
      scopeVersionId: request.scopeVersionId,
      source: structuredClone(request.source),
      ...(request.physicalPage === undefined ? {} : { physicalPage: request.physicalPage }),
      queryHash,
      items,
      pageInfo: {
        schemaVersion: 1,
        limit: request.limits.maxItems,
        returned: items.length,
        total,
        usedChars,
        truncated,
        completeness: 'candidate',
        ...(truncated ? { nextCursor: treeOverlayCursor(queryHash, consumed) } : {}),
      },
    }
    if (treeOverlayRpcIssues(result, request).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'Research Tree Overlay result is inconsistent')
    }
    return result
  }

  getSourceScopeVersion(
    workspaceId: string,
    scopeVersionId: string,
  ): { scope: SourceScopeVersion, sources: ScopedSourceIdentity[] } | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return undefined
    return readCanonicalSourceScope(database, workspaceId, scopeVersionId)
  }

  /** Enumerate immutable original snapshots; choosing one never changes a native active frame. */
  listSourceScopeVersions(workspaceId: string, investigationId: string): Array<{ scope: SourceScopeVersion, sources: ScopedSourceIdentity[] }> {
    const database = this.workspaceIfExists(workspaceId)
    if (!database) return []
    return database.prepare(`
      SELECT json_extract(payload_json, '$.scope.scopeVersionId') AS scope_version_id
      FROM journal_events WHERE event_type = 'source-scope.committed' AND aggregate_id = ?
      ORDER BY aggregate_version, event_id
    `).all(investigationId).map(row => {
      const snapshot = readCanonicalSourceScope(database, workspaceId, stringColumn(row, 'scope_version_id'))
      if (!snapshot || snapshot.scope.investigationId !== investigationId) {
        throw new SourceScopeStoreError('integrity-error', 'source scope enumeration identity is invalid')
      }
      return snapshot
    })
  }

  libraryWorkspaceIds(): string[] {
    return this.index.prepare(`
      SELECT workspace_id FROM library_workspaces ORDER BY workspace_id
    `).all().map(row => stringColumn(row, 'workspace_id'))
  }

  snapshots(): StoredSourceScope[] {
    const rows = this.index.prepare(`
      SELECT session_id, workspace_id, investigation_id
      FROM session_bindings
      ORDER BY session_id
    `).all()
    return rows.map((row) => {
      const sessionId = stringColumn(row, 'session_id')
      const current = this.readCurrent(
        stringColumn(row, 'workspace_id'),
        stringColumn(row, 'investigation_id'),
      )
      if (current === undefined) {
        throw new SourceScopeStoreError(
          'integrity-error',
          'session source scope binding points to missing investigation state',
        )
      }
      return { sessionId, ...current }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.m4Stores.clear()
    this.continuityStores.clear()
    for (const database of this.workspaces.values()) database.close()
    this.workspaces.clear()
    this.index.close()
  }

  private bindSession(sessionId: string, workspaceId: string, investigationId: string): void {
    transaction(this.index, () => {
      upsertSessionBinding(this.index, sessionId, workspaceId, investigationId)
    })
  }

  private rememberLibraryWorkspace(workspaceId: string): void {
    this.index.prepare(`
      INSERT INTO library_workspaces (workspace_id) VALUES (?) ON CONFLICT DO NOTHING
    `).run(workspaceId)
  }

  private readCurrent(
    workspaceId: string,
    investigationId: string,
  ): { scope: SourceScopeCommitResult['scope'], sources: ScopedSourceIdentity[] } | undefined {
    const database = this.workspaceIfExists(workspaceId)
    if (database === undefined) return undefined
    const row = readRow(database, `
      SELECT workspace_id, scope_json, sources_json
      FROM source_scope_current
      WHERE investigation_id = ?
    `, investigationId)
    if (row === undefined) return undefined
    if (stringColumn(row, 'workspace_id') !== workspaceId) {
      throw new SourceScopeStoreError('integrity-error', 'stored source scope workspace identity is invalid')
    }
    const scope = parseContract('source-scope-version', parseJson(stringColumn(row, 'scope_json')))
    if (scope.workspaceId !== workspaceId || scope.investigationId !== investigationId) {
      throw new SourceScopeStoreError('integrity-error', 'stored source scope aggregate identity is invalid')
    }
    const sourcesValue = parseJson(stringColumn(row, 'sources_json'))
    if (!Array.isArray(sourcesValue)) {
      throw new SourceScopeStoreError('integrity-error', 'stored source scope sources are corrupt')
    }
    const candidate: SourceScopeCommitResult = {
      schemaVersion: 1,
      resultType: 'source-scope-committed',
      sessionId: 'session:integrity-check',
      status: 'created',
      scope,
      sources: sourcesValue as ScopedSourceIdentity[],
    }
    const parsed = parseContract('source-scope-rpc', candidate)
    if (!('resultType' in parsed) || parsed.resultType !== 'source-scope-committed'
      || sourceScopeRpcIssues(parsed).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'stored source scope snapshot is invalid')
    }
    return { scope: parsed.scope, sources: parsed.sources }
  }

  private libraryRevisionSource(
    database: DatabaseSync,
    document: LibraryDocument,
    revisionId: string,
  ): ScopedSourceIdentity | undefined {
    const row = readRow(database, `
      SELECT representations_json FROM library_revisions
      WHERE document_id = ? AND revision_id = ?
    `, document.documentId, revisionId)
    if (row === undefined) return undefined
    const value = parseJson(stringColumn(row, 'representations_json'))
    if (!Array.isArray(value)) {
      throw new SourceScopeStoreError('integrity-error', 'Library revision representations are invalid')
    }
    const representations = value.map(parseSourceRepresentation)
    const preferredId = revisionId === document.currentRevision.revisionId
      ? document.activeRepresentationId
      : undefined
    const representation = selectLibraryRepresentation(representations, preferredId)
    if (representation === undefined
      || representation.documentId !== document.documentId
      || representation.revisionId !== revisionId) return undefined
    return {
      documentId: document.documentId,
      revisionId,
      representationId: representation.representationId,
      representationContentHash: representation.contentHash,
    }
  }

  private requireLibraryDocument(database: DatabaseSync, documentId: string): LibraryDocument {
    const row = readRow(database, `
      SELECT document_json FROM library_documents WHERE document_id = ?
    `, documentId)
    if (row === undefined) {
      throw new SourceScopeStoreError('integrity-error', 'Library source points to a missing document')
    }
    return parseLibraryDocument(stringColumn(row, 'document_json'))
  }

  private workspace(workspaceId: string): DatabaseSync {
    if (this.closed) throw new SourceScopeStoreError('integrity-error', 'source scope store is closed')
    const existing = this.workspaces.get(workspaceId)
    if (existing !== undefined) return existing
    const key = sha256(workspaceId)
    const path = join(this.investigationsRoot, `${key}.sqlite3`)
    const database = new DatabaseSync(path)
    let m4Store: InvestigationM4Store
    let continuityStore: InvestigationContinuityStore
    try {
      preflight(database)
      configure(database)
      initializeWorkspace(database, workspaceId, path, this.backupsRoot)
      verifyWorkspaceJournal(database, workspaceId)
      rebuildResearchRecallProjection(database, workspaceId)
      rebuildResearchTreeOverlayProjection(database, workspaceId)
      recoverLibraryJobs(database)
      m4Store = InvestigationM4Store.attach(database, {
        workspaceId,
        resolveEvidence: (evidenceId, context) => resolveM4Evidence(database, workspaceId, evidenceId, context),
      })
      continuityStore = InvestigationContinuityStore.attach(database, workspaceId)
    } catch (error) {
      database.close()
      throw error
    }
    this.workspaces.set(workspaceId, database)
    this.m4Stores.set(workspaceId, m4Store)
    this.continuityStores.set(workspaceId, continuityStore)
    chmodSync(path, DATABASE_MODE)
    return database
  }

  private m4(workspaceId: string): InvestigationM4Store {
    const existing = this.m4Stores.get(workspaceId)
    if (existing !== undefined) return existing
    const database = this.workspace(workspaceId)
    const store = InvestigationM4Store.attach(database, {
      workspaceId,
      resolveEvidence: (evidenceId, context) => resolveM4Evidence(database, workspaceId, evidenceId, context),
    })
    this.m4Stores.set(workspaceId, store)
    return store
  }

  private continuity(workspaceId: string): InvestigationContinuityStore {
    const existing = this.continuityStores.get(workspaceId)
    if (existing !== undefined) return existing
    const database = this.workspace(workspaceId)
    const store = InvestigationContinuityStore.attach(database, workspaceId)
    this.continuityStores.set(workspaceId, store)
    return store
  }

  private continuityBackend(workspaceId: string, evidenceScope?: { investigationId: string, sourceScopeVersionId: string }): ContinuityServiceBackend {
    const database = this.workspace(workspaceId)
    const continuity = this.continuity(workspaceId)
    return {
      activeScope: (sessionId) => {
        const active = this.get(sessionId)
        if (active.status !== 'active' || active.scope === undefined || active.sources === undefined) {
          return undefined
        }
        return {
          workspaceId: active.scope.workspaceId,
          investigationId: active.scope.investigationId,
          scopeVersionId: active.scope.scopeVersionId,
          sources: active.sources.map(source => ({ ...source })),
        }
      },
      researchRecord: (candidateWorkspaceId, recordId) => {
        if (candidateWorkspaceId !== workspaceId) return undefined
        return resolveContinuityRecord(
          database,
          this.m4(workspaceId),
          candidateWorkspaceId,
          recordId,
        )
      },
      resolveEvidence: (candidateWorkspaceId, evidenceId) => {
        if (candidateWorkspaceId !== workspaceId || !evidenceScope) return undefined
        // assess validates this exact frame against activeScope before resolving inputs.
        return resolveContinuityEvidence(database, candidateWorkspaceId, evidenceId, evidenceScope)
      },
      commitLink: (idempotencyKey, requestHash, link) =>
        continuity.commitLink(idempotencyKey, requestHash, link),
      impactRecords: (candidateWorkspaceId, recordIds, previousSource) => {
        if (candidateWorkspaceId !== workspaceId) return []
        const previousSourceAvailability = sourceIdentityAvailable(database, previousSource)
          ? 'available' as const
          : 'missing' as const
        return recordIds.flatMap((recordId): RevisionImpactRecordContext[] => {
          const record = resolveContinuityRecord(
            database,
            this.m4(workspaceId),
            candidateWorkspaceId,
            recordId,
          )
          return record === undefined || record.status === 'deleted' ? [] : [{
            recordId,
            sources: record.sources.map(source => ({ ...source })),
            previousSourceAvailability,
            sourceReferencesComplete: record.sourceReferencesComplete !== false && record.sourceAvailability !== 'denied',
          }]
        })
      },
    }
  }

  private workspaceIfExists(workspaceId: string): DatabaseSync | undefined {
    const existing = this.workspaces.get(workspaceId)
    if (existing !== undefined) return existing
    const path = join(this.investigationsRoot, `${sha256(workspaceId)}.sqlite3`)
    if (!existsSync(path)) return undefined
    return this.workspace(workspaceId)
  }
}

function configure(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA trusted_schema = OFF')
}

function verifyWorkspaceBackupFile(
  path: string,
  workspaceId: string,
  requireCurrentSchema: boolean,
): void {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    preflight(database)
    const identity = readRow(database, "SELECT value FROM metadata WHERE key = 'workspace_id'")
    const version = readRow(database, "SELECT value FROM metadata WHERE key = 'schema_version'")
    if (identity === undefined || stringColumn(identity, 'value') !== workspaceId
      || version === undefined
      || (requireCurrentSchema && stringColumn(version, 'value') !== String(STORE_SCHEMA_VERSION))) {
      throw new SourceScopeStoreError('integrity-error', 'Workspace backup identity or schema is invalid')
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'Workspace backup foreign keys are invalid')
    }
    verifyWorkspaceJournal(database, workspaceId)
    InvestigationM4Store.verifyExisting(database, workspaceId)
    InvestigationContinuityStore.verifyExisting(database, workspaceId)
  } finally {
    database.close()
    for (const suffix of ['-shm', '-wal']) {
      const sidecarPath = `${path}${suffix}`
      if (existsSync(sidecarPath)) unlinkSync(sidecarPath)
    }
  }
}

function preflight(database: DatabaseSync): void {
  const integrity = database.prepare('PRAGMA quick_check').get()
  if (integrity === undefined || Object.values(integrity)[0] !== 'ok') {
    throw new SourceScopeStoreError('integrity-error', 'source scope database integrity check failed')
  }
  assertSupportedSchemaBeforeMigration(database)
}

function initializeIndex(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_bindings (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS unbind_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bind_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS library_workspaces (
      workspace_id TEXT PRIMARY KEY
    ) STRICT;
  `)
  initializeMetadata(database, undefined)
}

function initializeWorkspace(
  database: DatabaseSync,
  workspaceId: string,
  databasePath: string,
  backupsRoot: string,
): void {
  migrateHumanResearchSchema(database, workspaceId, databasePath, backupsRoot)
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS journal_events (
      event_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
      actor_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      UNIQUE (aggregate_id, aggregate_version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS source_scope_snapshot_lookup
      ON journal_events (json_extract(payload_json, '$.scope.scopeVersionId'))
      WHERE event_type = 'source-scope.committed';
    CREATE TABLE IF NOT EXISTS source_scope_current (
      workspace_id TEXT NOT NULL,
      investigation_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 1),
      scope_version_id TEXT NOT NULL UNIQUE,
      scope_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_scope_patch_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS library_documents (
      workspace_id TEXT NOT NULL,
      document_id TEXT PRIMARY KEY,
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
      current_revision_id TEXT NOT NULL UNIQUE,
      current_content_hash TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS library_revisions (
      document_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      revision_json TEXT NOT NULL,
      representations_json TEXT NOT NULL,
      PRIMARY KEY (document_id, revision_id),
      FOREIGN KEY (document_id) REFERENCES library_documents(document_id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE TABLE IF NOT EXISTS library_source_bindings (
      source_key TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES library_documents(document_id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE TABLE IF NOT EXISTS library_record_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS library_jobs (
      job_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS library_job_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      job_id TEXT NOT NULL UNIQUE,
      FOREIGN KEY (job_id) REFERENCES library_jobs(job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS answer_manifests (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      manifest_id TEXT NOT NULL UNIQUE,
      source_scope_version_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS selection_actions (
      action_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      selection_context_id TEXT NOT NULL,
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      context_json TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS research_recall_records (
      record_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_scope_version_id TEXT,
      provenance_call_id TEXT,
      record_type TEXT NOT NULL,
      record_status TEXT NOT NULL,
      record_version INTEGER NOT NULL DEFAULT 1 CHECK (record_version >= 1),
      preview_text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      source_identities_json TEXT NOT NULL,
      projection_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS research_recall_by_investigation
      ON research_recall_records (investigation_id, created_at, record_id);
    CREATE INDEX IF NOT EXISTS research_recall_by_type
      ON research_recall_records (record_type, created_at, record_id);
    CREATE INDEX IF NOT EXISTS selection_note_lookup
      ON selection_actions (json_extract(result_json, '$.record.noteId'));
    CREATE INDEX IF NOT EXISTS selection_question_lookup
      ON selection_actions (json_extract(result_json, '$.record.questionId'));
    CREATE VIRTUAL TABLE IF NOT EXISTS research_recall_fts USING fts5(
      record_id UNINDEXED,
      search_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS research_records (
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
    CREATE TABLE IF NOT EXISTS research_record_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      record_id TEXT NOT NULL UNIQUE,
      FOREIGN KEY (record_id) REFERENCES research_records(record_id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE TABLE IF NOT EXISTS research_record_states (
      record_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 2),
      state_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS research_lifecycle_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      record_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS research_governance_records (
      record_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_scope_version_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS research_governance_by_investigation
      ON research_governance_records (investigation_id, updated_at, record_id);
    CREATE TABLE IF NOT EXISTS research_governance_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      record_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS research_tree_overlays (
      overlay_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      record_status TEXT NOT NULL,
      document_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      representation_id TEXT NOT NULL,
      representation_hash TEXT NOT NULL,
      physical_page INTEGER NOT NULL CHECK (physical_page >= 1),
      locator_json TEXT NOT NULL,
      locator_hash TEXT NOT NULL,
      preview_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      projection_hash TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS research_tree_overlay_by_source
      ON research_tree_overlays (
        document_id, revision_id, representation_id, representation_hash,
        physical_page, created_at, overlay_id
      );
    CREATE INDEX IF NOT EXISTS research_tree_overlay_by_record
      ON research_tree_overlays (record_id, overlay_id);
  `)
  createHumanResearchTables(database)
  verifyHumanResearchTableShapes(database)
  ensureResearchRecallRecordVersionColumn(database)
  migrateResearchLifecycleTables(database, workspaceId, databasePath, backupsRoot)
  initializeMetadata(database, workspaceId)
}

function createHumanResearchTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS human_research_records (
      record_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, investigation_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL, source_scope_version_id TEXT NOT NULL, provenance_command_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL, record_hash TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS human_research_commands (
      operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_hash TEXT NOT NULL,
      aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 1), event_type TEXT NOT NULL,
      event_hash TEXT NOT NULL, UNIQUE(actor_id,conversation_id,idempotency_key)
    ) STRICT;
  `)
}

function verifyHumanResearchTableShapes(database: DatabaseSync): void {
  for (const [table, names] of [
    ['human_research_records', 'record_id,workspace_id,investigation_id,source_session_id,source_scope_version_id,provenance_command_id,record_json,record_hash,created_at'],
    ['human_research_commands', 'operation_id,workspace_id,actor_id,conversation_id,idempotency_key,request_hash,receipt_json,receipt_hash,aggregate_id,aggregate_version,event_type,event_hash'],
  ]) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all()
    if (columns.map(column => column.name).join(',') !== names || columns.some((column, index) => column.type !== (column.name === 'aggregate_version' ? 'INTEGER' : 'TEXT')
      || column.pk !== (index === 0 ? 1 : 0) || index > 0 && column.notnull !== 1)) {
      throw new SourceScopeStoreError('integrity-error', 'Human research table shape is unsupported')
    }
    const shape = database.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(table!)
    if (!shape || shape.strict !== 1) throw new SourceScopeStoreError('integrity-error', 'Human research tables must retain STRICT typing')
    const unique = database.prepare(`PRAGMA index_list(${table})`).all().filter(index => index.unique === 1 && index.partial === 0)
      .map(index => database.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(column => column.name).join(','))
    const required = table === 'human_research_records' ? ['record_id', 'provenance_command_id'] : ['operation_id', 'actor_id,conversation_id,idempotency_key']
    if (required.some(key => !unique.includes(key))) throw new SourceScopeStoreError('integrity-error', 'Human research uniqueness constraints changed')
  }
}

function migrateHumanResearchSchema(database: DatabaseSync, workspaceId: string, databasePath: string, backupsRoot: string): void {
  if (!databaseTableExists(database, 'metadata')) return
  const row = readRow(database, "SELECT value FROM metadata WHERE key = 'schema_version'")
  if (!row) return
  const version = stringColumn(row, 'value')
  if (version === '6') { verifyHumanResearchTableShapes(database); return }
  if (version !== '5') return
  for (const table of ['human_research_records', 'human_research_commands']) {
    if (databaseTableExists(database, table) && numberColumn(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!, 'count')) {
      throw new SourceScopeStoreError('integrity-error', 'Human research content cannot be downgraded to schema v5')
    }
  }
  verifyWorkspaceJournal(database, workspaceId)
  const migrationRoot = join(backupsRoot, 'migrations', sha256(workspaceId))
  mkdirSync(migrationRoot, { recursive: true, mode: DIRECTORY_MODE })
  chmodSync(join(backupsRoot, 'migrations'), DIRECTORY_MODE); chmodSync(migrationRoot, DIRECTORY_MODE)
  const checkpoint = database.prepare('PRAGMA wal_checkpoint(FULL)').get()
  if (checkpoint?.busy !== 0) throw new SourceScopeStoreError('conflict', 'Human research migration requires a completed database checkpoint')
  const path = join(migrationRoot, `schema-v5-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}.sqlite3`)
  copyFileSync(databasePath, path, fsConstants.COPYFILE_EXCL); chmodSync(path, DATABASE_MODE)
  verifyWorkspaceBackupFile(path, workspaceId, false)
  transaction(database, () => {
    createHumanResearchTables(database)
    verifyHumanResearchTableShapes(database)
    database.prepare("UPDATE metadata SET value = '6' WHERE key = 'schema_version'").run()
  })
}

function ensureResearchRecallRecordVersionColumn(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(research_recall_records)').all()
  if (columns.some(row => row.name === 'record_version')) return
  database.exec(`
    ALTER TABLE research_recall_records
    ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1 CHECK (record_version >= 1)
  `)
}

function migrateResearchLifecycleTables(
  database: DatabaseSync,
  workspaceId: string,
  databasePath: string,
  backupsRoot: string,
): void {
  const stateForeignKeys = database.prepare(
    'PRAGMA foreign_key_list(research_record_states)',
  ).all()
  const replayForeignKeys = database.prepare(
    'PRAGMA foreign_key_list(research_lifecycle_idempotency)',
  ).all()
  if (stateForeignKeys.length === 0 && replayForeignKeys.length === 0) return
  const migrationRoot = join(backupsRoot, 'migrations', sha256(workspaceId))
  mkdirSync(migrationRoot, { recursive: true, mode: DIRECTORY_MODE })
  chmodSync(join(backupsRoot, 'migrations'), DIRECTORY_MODE)
  chmodSync(migrationRoot, DIRECTORY_MODE)
  database.exec('PRAGMA wal_checkpoint(FULL)')
  const migrationBackup = join(
    migrationRoot,
    `schema-v4-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}.sqlite3`,
  )
  copyFileSync(databasePath, migrationBackup, fsConstants.COPYFILE_EXCL)
  chmodSync(migrationBackup, DATABASE_MODE)
  verifyWorkspaceBackupFile(migrationBackup, workspaceId, false)
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    transaction(database, () => {
      if (stateForeignKeys.length > 0) {
        database.exec(`
          CREATE TABLE research_record_states_next (
            record_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            investigation_id TEXT NOT NULL,
            version INTEGER NOT NULL CHECK (version >= 2),
            state_json TEXT NOT NULL,
            state_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO research_record_states_next
          SELECT record_id, workspace_id, investigation_id, version,
                 state_json, state_hash, updated_at
          FROM research_record_states;
          DROP TABLE research_record_states;
          ALTER TABLE research_record_states_next RENAME TO research_record_states;
        `)
      }
      if (replayForeignKeys.length > 0) {
        database.exec(`
          CREATE TABLE research_lifecycle_idempotency_next (
            idempotency_key TEXT PRIMARY KEY,
            request_hash TEXT NOT NULL,
            result_json TEXT NOT NULL,
            result_hash TEXT NOT NULL,
            record_id TEXT NOT NULL
          ) STRICT;
          INSERT INTO research_lifecycle_idempotency_next
          SELECT idempotency_key, request_hash, result_json, result_hash, record_id
          FROM research_lifecycle_idempotency;
          DROP TABLE research_lifecycle_idempotency;
          ALTER TABLE research_lifecycle_idempotency_next
            RENAME TO research_lifecycle_idempotency;
        `)
      }
    })
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

function initializeMetadata(database: DatabaseSync, workspaceId: string | undefined): void {
  const version = readRow(database, "SELECT value FROM metadata WHERE key = 'schema_version'")
  if (version === undefined) {
    database.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', ?)")
      .run(String(STORE_SCHEMA_VERSION))
  } else {
    const current = stringColumn(version, 'value')
    if (PREVIOUS_STORE_SCHEMA_VERSIONS.map(String).includes(current)) {
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'")
        .run(String(STORE_SCHEMA_VERSION))
    } else if (current !== String(STORE_SCHEMA_VERSION)) {
      throw new SourceScopeStoreError('integrity-error', 'unsupported source scope database schema version')
    }
  }
  if (workspaceId === undefined) return
  const current = readRow(database, "SELECT value FROM metadata WHERE key = 'workspace_id'")
  if (current === undefined) {
    database.prepare("INSERT INTO metadata (key, value) VALUES ('workspace_id', ?)").run(workspaceId)
  } else if (stringColumn(current, 'value') !== workspaceId) {
    throw new SourceScopeStoreError('integrity-error', 'source scope database workspace identity mismatch')
  }
}

function assertSupportedSchemaBeforeMigration(database: DatabaseSync): void {
  const metadata = readRow(database, `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'metadata'
  `)
  if (metadata === undefined) return
  const version = readRow(database, "SELECT value FROM metadata WHERE key = 'schema_version'")
  if (version === undefined || ![
    ...PREVIOUS_STORE_SCHEMA_VERSIONS.map(String),
    String(STORE_SCHEMA_VERSION),
  ].includes(stringColumn(version, 'value'))) {
    throw new SourceScopeStoreError('integrity-error', 'unsupported source scope database schema version')
  }
}

function verifyWorkspaceJournal(database: DatabaseSync, workspaceId: string): void {
  const versions = new Map<string, number>()
  const rows = database.prepare(`
    SELECT workspace_id, aggregate_id, aggregate_version, event_type,
           payload_version, payload_json, payload_hash
    FROM journal_events
    ORDER BY aggregate_id, aggregate_version
  `).all()
  for (const row of rows) {
    const aggregateId = stringColumn(row, 'aggregate_id')
    const version = numberColumn(row, 'aggregate_version')
    const expectedVersion = (versions.get(aggregateId) ?? 0) + 1
    const eventType = stringColumn(row, 'event_type')
    if (stringColumn(row, 'workspace_id') !== workspaceId
      || version !== expectedVersion
      || ![
        'source-scope.committed',
        'library.document-imported',
        'library.source-linked',
        'selection-action.recorded',
        'research-record.created',
        'human-research.created',
        'research-record.lifecycle',
        'research-governance.created',
        'research-governance.revised',
        'research-governance.archived',
        'research-governance.deleted',
      ].includes(eventType)
      || numberColumn(row, 'payload_version') !== 1) {
      throw new SourceScopeStoreError('integrity-error', 'source scope journal identity or version chain is invalid')
    }
    const payload = stringColumn(row, 'payload_json')
    if (sha256(payload) !== stringColumn(row, 'payload_hash')) {
      throw new SourceScopeStoreError('integrity-error', 'source scope journal payload hash mismatch')
    }
    versions.set(aggregateId, version)
  }
  const current = database.prepare(`
    SELECT investigation_id, version
    FROM source_scope_current
  `).all()
  for (const row of current) {
    if (versions.get(stringColumn(row, 'investigation_id')) !== numberColumn(row, 'version')) {
      throw new SourceScopeStoreError('integrity-error', 'source scope current projection is ahead of its journal')
    }
  }
  const library = database.prepare(`
    SELECT document_id, aggregate_version FROM library_documents
  `).all()
  for (const row of library) {
    if (versions.get(`library:${stringColumn(row, 'document_id')}`)
      !== numberColumn(row, 'aggregate_version')) {
      throw new SourceScopeStoreError('integrity-error', 'Library current projection is ahead of its journal')
    }
  }
  const answers = database.prepare(`
    SELECT workspace_id, session_id, message_id, manifest_json, manifest_hash
    FROM answer_manifests
  `).all()
  for (const row of answers) {
    const manifestJson = stringColumn(row, 'manifest_json')
    if (sha256(manifestJson) !== stringColumn(row, 'manifest_hash')) {
      throw new SourceScopeStoreError('integrity-error', 'answer manifest projection hash is invalid')
    }
    const manifest = parseAnswerManifest(manifestJson)
    if (stringColumn(row, 'workspace_id') !== workspaceId
      || manifest.workspaceId !== workspaceId
      || manifest.sessionId !== stringColumn(row, 'session_id')
      || manifest.messageId !== stringColumn(row, 'message_id')) {
      throw new SourceScopeStoreError('integrity-error', 'answer manifest projection identity is invalid')
    }
  }
  const patches = database.prepare(`
    SELECT idempotency_key, request_hash, result_json FROM source_scope_patch_idempotency
  `).all()
  for (const row of patches) {
    if (!/^[a-f0-9]{64}$/.test(stringColumn(row, 'request_hash'))) {
      throw new SourceScopeStoreError('integrity-error', 'source scope patch request hash is invalid')
    }
    const result = parseScopeCommitResult(stringColumn(row, 'result_json'))
    verifyPatchResult(database, workspaceId, stringColumn(row, 'idempotency_key'), result)
  }
  const actions = database.prepare('SELECT * FROM selection_actions').all()
  for (const row of actions) verifySelectionActionRow(database, workspaceId, row)
  const researchRecords = database.prepare('SELECT * FROM research_records').all()
  for (const row of researchRecords) verifyResearchRecordRow(database, workspaceId, row)
  if (databaseTableExists(database, 'human_research_records')) {
    for (const row of database.prepare('SELECT * FROM human_research_records').all()) verifyHumanResearchRecordRow(database, workspaceId, row)
    for (const row of database.prepare('SELECT * FROM human_research_commands').all()) verifyHumanResearchReceiptRow(database, workspaceId, row)
    const missing = database.prepare(`SELECT e.event_id FROM journal_events e LEFT JOIN human_research_records r ON r.record_id=e.aggregate_id
      WHERE e.event_type='human-research.created' AND r.record_id IS NULL LIMIT 1`).get()
    if (missing) throw new SourceScopeStoreError('integrity-error', 'Human research journal lost its canonical record projection')
    const missingReceipt = database.prepare(`SELECT e.event_id FROM journal_events e LEFT JOIN human_research_commands c ON c.operation_id=e.idempotency_key
      WHERE e.idempotency_key GLOB 'human-op:*' AND length(e.idempotency_key)=73 AND c.operation_id IS NULL
      AND (e.event_type='human-research.created' OR e.event_type='research-record.lifecycle' OR e.event_type LIKE 'research-governance.%') LIMIT 1`).get()
    if (missingReceipt) throw new SourceScopeStoreError('integrity-error', 'Human research journal lost its command receipt')
  } else if (database.prepare("SELECT event_id FROM journal_events WHERE event_type='human-research.created' LIMIT 1").get()) {
    throw new SourceScopeStoreError('integrity-error', 'Human research journal requires schema v6')
  }
  const researchStates = database.prepare('SELECT * FROM research_record_states').all()
  for (const row of researchStates) {
    const state = verifyResearchLifecycleState(database, workspaceId, row)
    const base = researchLifecycleBase(database, workspaceId, state.recordId)
    if (base === undefined || versions.get(base.aggregateId) !== state.version) {
      throw new SourceScopeStoreError('integrity-error', 'Research lifecycle current state is behind its journal')
    }
  }
  const lifecycleReplays = database.prepare('SELECT * FROM research_lifecycle_idempotency').all()
  for (const row of lifecycleReplays) verifyResearchLifecycleReplayRow(database, workspaceId, row)
  if (databaseTableExists(database, 'research_governance_records')) {
    const governanceRecords = database.prepare('SELECT * FROM research_governance_records').all()
    for (const row of governanceRecords) {
      const record = verifyResearchGovernanceRow(database, workspaceId, row)
      if (versions.get(record.recordId) !== record.version) {
        throw new SourceScopeStoreError(
          'integrity-error',
          'Research Governance current state is behind its journal',
        )
      }
    }
  }
  if (databaseTableExists(database, 'research_governance_idempotency')) {
    const governanceReplays = database.prepare('SELECT * FROM research_governance_idempotency').all()
    for (const row of governanceReplays) verifyResearchGovernanceReplayRow(database, workspaceId, row)
  }
}

function databaseTableExists(database: DatabaseSync, table: string): boolean {
  return readRow(database, `
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `, table) !== undefined
}

function verifyPatchResult(
  database: DatabaseSync,
  workspaceId: string,
  idempotencyKey: string,
  result: SourceScopeCommitResult,
): void {
  const journal = readRow(database, `
    SELECT payload_json, payload_hash FROM journal_events
    WHERE idempotency_key = ? AND event_type = 'source-scope.committed'
  `, idempotencyKey)
  if (journal === undefined || result.scope.workspaceId !== workspaceId) {
    throw new SourceScopeStoreError('integrity-error', 'source scope patch journal identity is invalid')
  }
  const payloadJson = stringColumn(journal, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(journal, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'source scope patch journal hash is invalid')
  }
  const payload = parseScopePayload(payloadJson)
  if (canonicalJson(payload.scope) !== canonicalJson(result.scope)
    || canonicalJson(payload.sources) !== canonicalJson(result.sources)) {
    throw new SourceScopeStoreError('integrity-error', 'source scope patch result does not match its journal event')
  }
}

function verifySelectionActionRow(
  database: DatabaseSync,
  workspaceId: string,
  row: Record<string, unknown>,
): { result: SelectionActionResult, context: SelectionContext } {
  const requestHash = stringColumn(row, 'request_hash')
  const resultJson = stringColumn(row, 'result_json')
  const contextJson = stringColumn(row, 'context_json')
  if (!/^[a-f0-9]{64}$/.test(requestHash)
    || sha256(resultJson) !== stringColumn(row, 'result_hash')
    || sha256(contextJson) !== stringColumn(row, 'context_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'selection action projection hash is invalid')
  }
  const result = parseSelectionActionResult(resultJson)
  const context = parseSelectionContext(contextJson)
  if (stringColumn(row, 'workspace_id') !== workspaceId
    || result.actionId !== stringColumn(row, 'action_id')
    || result.sessionId !== stringColumn(row, 'session_id')
    || result.selectionContextId !== stringColumn(row, 'selection_context_id')
    || result.action !== stringColumn(row, 'action')
    || context.workspaceId !== workspaceId
    || context.investigationId !== stringColumn(row, 'investigation_id')
    || context.selectionContextId !== result.selectionContextId
    || context.sessionId !== result.sessionId) {
    throw new SourceScopeStoreError('integrity-error', 'selection action projection identity is invalid')
  }
  const journal = readRow(database, `
    SELECT aggregate_id, payload_json, payload_hash FROM journal_events
    WHERE idempotency_key = ? AND event_type = 'selection-action.recorded'
  `, stringColumn(row, 'idempotency_key'))
  if (journal === undefined || stringColumn(journal, 'aggregate_id') !== result.actionId) {
    throw new SourceScopeStoreError('integrity-error', 'selection action journal identity is invalid')
  }
  const payloadJson = stringColumn(journal, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(journal, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'selection action journal hash is invalid')
  }
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'selection action journal payload is invalid')
  }
  if (canonicalJson(payload) !== canonicalJson({ schemaVersion: 1, result, context })) {
    throw new SourceScopeStoreError('integrity-error', 'selection action projection does not match its journal event')
  }
  return { result, context }
}

function readCanonicalSourceScope(database: DatabaseSync, workspaceId: string, scopeVersionId: string) {
  const rows = database.prepare(`
    SELECT workspace_id, aggregate_id, aggregate_version, payload_version, payload_json, payload_hash
    FROM journal_events
    WHERE event_type = 'source-scope.committed' AND json_extract(payload_json, '$.scope.scopeVersionId') = ?
    ORDER BY occurred_at DESC, event_id DESC LIMIT 2
  `).all(scopeVersionId)
  if (rows.length > 1) throw new SourceScopeStoreError('integrity-error', 'source scope identity has multiple canonical snapshots')
  const row = rows[0]
  if (!row) return undefined
  const payloadJson = stringColumn(row, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(row, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'source scope journal payload hash mismatch')
  }
  const payload = parseScopePayload(payloadJson)
  if (stringColumn(row, 'workspace_id') !== workspaceId || payload.scope.workspaceId !== workspaceId
    || payload.scope.scopeVersionId !== scopeVersionId || stringColumn(row, 'aggregate_id') !== payload.scope.investigationId
    || numberColumn(row, 'aggregate_version') !== payload.scope.version || numberColumn(row, 'payload_version') !== 1) {
    throw new SourceScopeStoreError('integrity-error', 'source scope journal identity is invalid')
  }
  return payload
}

function verifyCanonicalAnswerRow(row: Record<string, unknown>, workspaceId: string): AnswerManifest {
  const manifestJson = stringColumn(row, 'manifest_json')
  if (sha256(manifestJson) !== stringColumn(row, 'manifest_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'stored answer manifest hash is invalid')
  }
  let manifest: AnswerManifest
  try { manifest = parseAnswerManifest(manifestJson) }
  catch { throw new SourceScopeStoreError('integrity-error', 'stored answer manifest is invalid') }
  if (stringColumn(row, 'workspace_id') !== workspaceId || manifest.workspaceId !== workspaceId
    || stringColumn(row, 'session_id') !== manifest.sessionId || stringColumn(row, 'message_id') !== manifest.messageId
    || stringColumn(row, 'manifest_id') !== manifest.manifestId || stringColumn(row, 'source_scope_version_id') !== manifest.sourceScopeVersionId
    || stringColumn(row, 'created_at') !== manifest.createdAt) {
    throw new SourceScopeStoreError('integrity-error', 'stored answer manifest identity is invalid')
  }
  return manifest
}

function resolveCanonicalEvidence(
  database: DatabaseSync,
  workspaceId: string,
  evidenceId: string,
  identity: { investigationId: string, sourceScopeVersionId: string },
): StoredCanonicalEvidence | undefined {
  const snapshot = readCanonicalSourceScope(database, workspaceId, identity.sourceScopeVersionId)
  if (!snapshot || snapshot.scope.investigationId !== identity.investigationId) return undefined
  let resolved: StoredCanonicalEvidence | undefined
  const capture = (evidence: EvidenceAtom, locator: DocumentLocator, origin: CanonicalEvidenceOrigin): void => {
    const quote = locator.selectors.find(selector => selector.type === 'text-quote')
    if (documentLocatorIssues(locator).length || evidenceLocatorIssues(evidence, locator).length
      || evidence.content.text !== undefined && (sha256(evidence.content.text) !== evidence.contentHash
        || quote?.type !== 'text-quote' || evidence.content.text !== quote.exact || evidence.contentHash !== quote.normalizedHash)
      || locator.selectors.some(selector => selector.type === 'text-quote' && sha256(selector.exact) !== selector.normalizedHash)
      || !snapshot.sources.some(source => source.documentId === locator.documentId && source.revisionId === locator.revisionId
        && source.representationId === locator.representationId && source.representationContentHash === locator.representationContentHash)
      || !snapshot.scope.included.some(source => source.documentId === evidence.documentId && source.revisionId === evidence.revisionId && source.role === evidence.sourceRole)) {
      throw new SourceScopeStoreError('integrity-error', 'canonical Evidence does not match its original Locator, content hash and immutable source scope')
    }
    if (resolved) {
      // A repeated presentation may reference one atom; a conflicting capture must not pick a
      // convenient provenance, merge source scopes, or silently rewrite the original identity.
      if (canonicalJson(resolved.evidence) !== canonicalJson(evidence) || canonicalJson(resolved.locator) !== canonicalJson(locator)) {
        throw new SourceScopeStoreError('integrity-error', 'canonical Evidence identity has conflicting captures in its source scope')
      }
      resolved.origins.push(structuredClone(origin))
    } else {
      resolved = { kind: 'evidence-atom', workspaceId, investigationId: identity.investigationId,
        sourceScopeVersionIds: [identity.sourceScopeVersionId], evidence: structuredClone(evidence), locator: structuredClone(locator), integrity: 'valid', origins: [structuredClone(origin)] }
    }
  }
  for (const row of database.prepare(`
    SELECT * FROM selection_actions WHERE workspace_id = ? AND investigation_id = ?
      AND json_extract(context_json, '$.scopeVersionId') = ?
    ORDER BY created_at, action_id
  `).iterate(workspaceId, identity.investigationId, identity.sourceScopeVersionId)) {
    const { result, context } = verifySelectionActionRow(database, workspaceId, row)
    if (context.scopeVersionId !== identity.sourceScopeVersionId) continue
    const evidence = result.evidence.find(item => item.evidenceId === evidenceId)
    if (!evidence) continue
    const locator = result.locators.find(item => item.locatorId === evidence.locatorId)
    const selection = context.selections.find(item => item.locators.some(anchor => anchor.locatorId === evidence.locatorId))
    if (!locator || result.record.workspaceId !== workspaceId || result.record.investigationId !== identity.investigationId
      || context.investigationId !== identity.investigationId || canonicalJson(result.locators) !== canonicalJson(context.selections.flatMap(item => item.locators))
      || evidence.content.assetId !== undefined && (!selection || selection.content.assetId !== evidence.content.assetId
        || selection.content.mediaType !== evidence.content.mediaType || selection.content.contentHash !== evidence.contentHash)) {
      throw new SourceScopeStoreError('integrity-error', 'canonical selection Evidence lost its original capture identity')
    }
    const journal = readRow(database, `SELECT workspace_id, aggregate_version, payload_version FROM journal_events
      WHERE aggregate_id = ? AND event_type = 'selection-action.recorded'`, result.actionId)
    if (!journal || stringColumn(journal, 'workspace_id') !== workspaceId
      || numberColumn(journal, 'aggregate_version') !== 1 || numberColumn(journal, 'payload_version') !== 1) {
      throw new SourceScopeStoreError('integrity-error', 'canonical selection Evidence journal identity is invalid')
    }
    capture(evidence, locator, { kind: 'selection-action', sessionId: result.sessionId, actionId: result.actionId,
      selectionContextId: result.selectionContextId, action: result.action })
  }
  for (const row of database.prepare(`
    SELECT * FROM answer_manifests WHERE source_scope_version_id = ? ORDER BY created_at, session_id, message_id
  `).iterate(identity.sourceScopeVersionId)) {
    const manifest = verifyCanonicalAnswerRow(row, workspaceId)
    if (manifest.investigationId !== identity.investigationId) {
      throw new SourceScopeStoreError('integrity-error', 'canonical Answer Evidence belongs to another Investigation')
    }
    for (const citation of manifest.citations) {
      if (citation.verificationStatus !== 'read-verified' || citation.evidence?.evidenceId !== evidenceId) continue
      capture(citation.evidence, citation.locator, { kind: 'answer-read', sessionId: manifest.sessionId,
        manifestId: manifest.manifestId, messageId: manifest.messageId, citationId: citation.citationId })
    }
  }
  return resolved
}

function resolveM4Evidence(
  database: DatabaseSync,
  workspaceId: string,
  evidenceId: string,
  context?: { investigationId: string, sourceScopeVersionId: string },
): M4EvidenceResolution | undefined {
  if (context) return resolveCanonicalEvidence(database, workspaceId, evidenceId, context)
  let resolved: M4EvidenceResolution | undefined
  const rows = database.prepare(`
    SELECT * FROM selection_actions
    WHERE workspace_id = ?
    ORDER BY created_at, action_id
  `).all(workspaceId)
  for (const row of rows) {
    const { result, context } = verifySelectionActionRow(database, workspaceId, row)
    const evidence = result.evidence.find(candidate => candidate.evidenceId === evidenceId)
    if (evidence === undefined) continue
    if (resolved !== undefined) {
      throw new SourceScopeStoreError(
        'integrity-error',
        'canonical EvidenceAtom identity appears in more than one validated selection action',
      )
    }
    resolved = {
      kind: 'evidence-atom',
      workspaceId,
      investigationId: context.investigationId,
      sourceScopeVersionIds: [context.scopeVersionId],
      evidence: structuredClone(evidence),
      integrity: 'valid',
    }
  }
  return resolved
}

function resolveContinuityEvidence(
  database: DatabaseSync,
  workspaceId: string,
  evidenceId: string,
  identity: { investigationId: string, sourceScopeVersionId: string },
): ContinuityEvidenceContext | undefined {
  const capture = resolveCanonicalEvidence(database, workspaceId, evidenceId, identity)
  if (!capture) return undefined
  const { evidence, locator } = capture
  return { evidenceId, source: { documentId: locator.documentId, revisionId: locator.revisionId,
    representationId: locator.representationId, representationContentHash: locator.representationContentHash },
  scopeVersionId: identity.sourceScopeVersionId, resolutionStatus: evidence.resolutionStatus, status: evidence.status }
}

function resolveContinuityRecord(
  database: DatabaseSync,
  m4Store: InvestigationM4Store,
  workspaceId: string,
  recordId: string,
  exactOnly = false,
): StoredContinuityRecord | undefined {
  const research = continuityResearchMetadata(database, workspaceId, recordId)
  if (research) return research

  const journal = m4Store.listJournal(), origin = continuityM4Origin(database, workspaceId, journal)
  const ledgers = [...new Set(journal.map(event => event.investigationId))].map(id => m4Store.getClaimLedger(id))
  const claims = ledgers.flatMap(ledger => ledger.claims)
  const exactClaim = claims.find(claim => claim.claimVersionId === recordId)
  const claimCandidates = exactClaim ? [exactClaim] : exactOnly ? [] : claims.filter(claim => claim.claimChainId === recordId)
  if (claimCandidates.length > 1) throw new SourceScopeStoreError('conflict', 'Continuity requires an exact ClaimVersion; its chain has multiple immutable versions')
  const claim = claimCandidates[0]
  if (claim !== undefined) {
    const ledger = ledgers.find(ledger => ledger.claims.some(item => item.claimVersionId === claim.claimVersionId))!
    const dependencies = continuityClaimSources(database, workspaceId, ledger, [claim.claimVersionId], origin)
    return { recordId, workspaceId, investigationId: claim.investigationId, recordType: 'claim-version', version: claim.version,
      scopeVersionId: claim.scope.sourceScopeVersionId, identity: { kind: 'claim-version', claimVersionId: claim.claimVersionId, claimChainId: claim.claimChainId, version: claim.version },
      status: `${claim.lifecycleStatus}/${claim.epistemicStatus}`, ...continuityMetadata(database, dependencies) }
  }

  const artifacts = m4Store.listArtifactManifests(), exactArtifact = artifacts.find(artifact => artifact.artifactManifestId === recordId)
  const artifactCandidates = exactArtifact ? [exactArtifact] : exactOnly ? [] : artifacts.filter(artifact => artifact.artifactId === recordId)
  if (artifactCandidates.length > 1) throw new SourceScopeStoreError('conflict', 'Continuity requires an exact ArtifactManifest; its artifact has multiple immutable versions')
  const artifact = artifactCandidates[0]
  if (artifact === undefined) return undefined
  const claimUses = artifact.content.kind === 'brief'
    ? artifact.content.sections.flatMap(section => section.claimUses)
    : artifact.content.cells.flatMap(cell => cell.claimUses)
  const ledger = m4Store.getClaimLedger(artifact.investigationId)
  const direct = continuitySourcesFromEvidence(database, workspaceId, claimUses.flatMap(use => use.citationEvidenceIds),
    { investigationId: artifact.investigationId, sourceScopeVersionId: artifact.sourceScopeVersionId })
  const derived = continuityClaimSources(database, workspaceId, ledger, claimUses.map(use => use.claimVersionId), origin)
  const authority = origin('m4-artifact-draft', artifact.artifactManifestId, artifact.artifactId, artifact.version, artifact.investigationId, artifact.sourceScopeVersionId)
  const dependencies = mergeContinuitySources([direct, derived, { ...emptyContinuitySources(), authorizationRefs: authority ? [authority] : [], authorizationComplete: !!authority }])
  return { recordId, workspaceId, investigationId: artifact.investigationId, recordType: `artifact-${artifact.kind}`, version: artifact.version,
    scopeVersionId: artifact.sourceScopeVersionId, identity: { kind: 'artifact-manifest', artifactManifestId: artifact.artifactManifestId, artifactId: artifact.artifactId, version: artifact.version },
    status: artifact.status, ...continuityMetadata(database, dependencies) }
}

function continuityResearchMetadata(database: DatabaseSync, workspaceId: string, recordId: string): StoredContinuityRecord | undefined {
  const candidates: StoredContinuityRecord[] = []
  const stateRow = readRow(database, 'SELECT * FROM research_record_states WHERE record_id = ?', recordId)
  const state = stateRow ? verifyResearchLifecycleState(database, workspaceId, stateRow) : undefined
  const describe = (projection: ResearchRecallProjection, dependencies: ContinuitySourceProjection): StoredContinuityRecord => {
    const cached = readRow(database, 'SELECT * FROM research_recall_records WHERE workspace_id = ? AND record_id = ?', workspaceId, recordId)
    if (cached && canonicalJson(researchRecallProjectionFromRow(cached, workspaceId)) !== canonicalJson(projection)) {
      throw new SourceScopeStoreError('integrity-error', 'Continuity research metadata differs from its canonical record and lifecycle')
    }
    if (!projection.sourceScopeVersionId) throw new SourceScopeStoreError('integrity-error', 'Continuity research record lacks its original scope identity')
    return { recordId, workspaceId, investigationId: projection.investigationId, scopeVersionId: projection.sourceScopeVersionId,
      recordType: projection.recordType, version: projection.recordVersion, status: projection.recordStatus,
      identity: { kind: 'research-record', recordId, version: projection.recordVersion }, ...continuityMetadata(database, dependencies) }
  }
  const agentRow = readRow(database, 'SELECT * FROM research_records WHERE record_id = ?', recordId)
  if (agentRow) {
    const record = verifyResearchRecordRow(database, workspaceId, agentRow), projection = researchProjectionFromAgentRecord(record, state)
    candidates.push(describe(projection, { ...emptyContinuitySources(), incomplete: true,
      authorizationRefs: [{ kind: 'research-record', sessionId: record.sourceSessionId, investigationId: record.investigationId,
        scopeVersionId: record.sourceScopeVersionId, referenceId: record.recordId, provenanceCallId: record.provenanceCallId }] }))
  }
  const humanRow = readRow(database, 'SELECT * FROM human_research_records WHERE record_id = ?', recordId)
  if (humanRow) {
    const record = verifyHumanResearchRecordRow(database, workspaceId, humanRow), projection = researchProjectionFromHumanRecord(record, state)
    // Saved quotations are exact navigation anchors, not fresh factual Evidence or completed work.
    candidates.push(describe(projection, { ...emptyContinuitySources(), incomplete: true, sources: state?.status === 'deleted' ? [] : record.sourceIdentities,
      authorizationRefs: [{ kind: 'research-record', sessionId: record.sourceSessionId, investigationId: record.investigationId,
        scopeVersionId: record.sourceScopeVersionId, referenceId: record.recordId }] }))
  }
  const governanceRow = readRow(database, 'SELECT * FROM research_governance_records WHERE record_id = ?', recordId)
  if (governanceRow) {
    const record = verifyResearchGovernanceRow(database, workspaceId, governanceRow)
    const sources = humanGovernanceOrigin(database, workspaceId, recordId)?.humanCommand?.sourceIdentities ?? []
    if (record.status === 'deleted') {
      // Deleted content is never reconstructed just to describe an old work item.
      candidates.push({ recordId, workspaceId, investigationId: record.investigationId, scopeVersionId: record.sourceScopeVersionId,
        recordType: record.recordType, version: record.version, status: record.status, identity: { kind: 'research-record', recordId, version: record.version },
        ...continuityMetadata(database, { ...emptyContinuitySources(), incomplete: true, authorizationRefs: [{ kind: 'research-record', sessionId: record.sourceSessionId,
          investigationId: record.investigationId, scopeVersionId: record.sourceScopeVersionId, referenceId: record.recordId }] }) })
    } else candidates.push(describe(researchProjectionFromGovernanceRecord(record, sources), { ...emptyContinuitySources(), incomplete: true, sources,
      authorizationRefs: [{ kind: 'research-record', sessionId: record.sourceSessionId, investigationId: record.investigationId, scopeVersionId: record.sourceScopeVersionId, referenceId: record.recordId }] }))
  }
  for (const row of database.prepare(`SELECT * FROM selection_actions WHERE workspace_id = ? AND (
    json_extract(result_json, '$.record.noteId') = ? OR json_extract(result_json, '$.record.questionId') = ?
    OR json_extract(result_json, '$.record.bookmarkId') = ? OR json_extract(result_json, '$.record.claimProposalId') = ?)
  `).iterate(workspaceId, recordId, recordId, recordId, recordId)) {
    const { result, context } = verifySelectionActionRow(database, workspaceId, row)
    const original = researchProjection(result, context)
    if (original.recordId !== recordId) throw new SourceScopeStoreError('integrity-error', 'Continuity selection record identity changed')
    const projection = state ? state.status === 'deleted'
      ? { ...original, recordStatus: state.status, recordVersion: state.version, createdAt: state.updatedAt, previewText: '', searchText: '' }
      : researchProjectionWithState(original, state) : original
    const authority: ContinuityAuthorizationReference = { kind: 'selection-action', sessionId: result.sessionId, investigationId: context.investigationId,
      scopeVersionId: context.scopeVersionId, referenceId: result.actionId, selectionContextId: result.selectionContextId }
    const evidence = state?.status === 'deleted' ? { ...emptyContinuitySources(), incomplete: true }
      : continuitySourcesFromEvidence(database, workspaceId, result.evidence.map(item => item.evidenceId), { investigationId: context.investigationId, sourceScopeVersionId: context.scopeVersionId })
    const dependencies = mergeContinuitySources([evidence, { ...emptyContinuitySources(), sources: state?.status === 'deleted' ? [] : original.sourceIdentities,
      authorizationRefs: [authority] }])
    candidates.push(describe(projection, dependencies))
  }
  if (candidates.length > 1) throw new SourceScopeStoreError('integrity-error', 'Continuity research identity has multiple canonical origins')
  return candidates[0]
}

/** Original session provenance is read only from the hash-verified creation command, never inferred from actor IDs. */
function continuityM4Origin(database: DatabaseSync, workspaceId: string, journal: ReturnType<InvestigationM4Store['listJournal']>) {
  return (requestType: 'm4-claim-record' | 'm4-artifact-draft', recordId: string, aggregateId: string, version: number, investigationId: string, scopeVersionId: string): ContinuityAuthorizationReference | undefined => {
    const eventType = requestType === 'm4-claim-record' ? 'claim-version.recorded' : 'artifact-draft.recorded'
    const events = journal.filter(event => event.eventType === eventType && event.investigationId === investigationId && event.aggregateId === aggregateId && event.aggregateVersion === version)
    if (events.length !== 1) return undefined
    const event = events[0]!, row = readRow(database, 'SELECT * FROM investigation_m4_events WHERE event_id = ?', event.eventId)
    if (!row || stringColumn(row, 'event_hash') !== event.eventHash) throw new SourceScopeStoreError('integrity-error', 'Continuity M4 creation journal changed')
    const envelope = { eventId: stringColumn(row, 'event_id'), workspaceId: stringColumn(row, 'workspace_id'), investigationId: stringColumn(row, 'investigation_id'),
      eventType: stringColumn(row, 'event_type'), aggregateId: stringColumn(row, 'aggregate_id'), aggregateVersion: numberColumn(row, 'aggregate_version'),
      idempotencyKey: stringColumn(row, 'idempotency_key'), requestHash: stringColumn(row, 'request_hash'), payloadHash: stringColumn(row, 'payload_hash'),
      resultHash: stringColumn(row, 'result_hash'), previousEventHash: stringColumn(row, 'previous_event_hash'), createdAt: stringColumn(row, 'created_at') }
    const json = stringColumn(row, 'request_json')
    if (sha256(json) !== envelope.requestHash || sha256(canonicalJson(envelope)) !== event.eventHash || envelope.workspaceId !== workspaceId) {
      throw new SourceScopeStoreError('integrity-error', 'Continuity M4 original request failed its verified event seal')
    }
    let request: ReturnType<typeof parseContract<'m4-rpc'>>
    try {
      const input: unknown = JSON.parse(json), candidate = input !== null && typeof input === 'object' && !Array.isArray(input) && 'request' in input ? input.request : input
      request = parseContract('m4-rpc', candidate)
    } catch { return undefined }
    if (!('requestType' in request) || request.requestType !== requestType || m4RpcIssues(request).length || request.workspaceId !== workspaceId
      || request.investigationId !== investigationId || request.scopeVersionId !== scopeVersionId) return undefined
    if (request.requestType === 'm4-claim-record' ? request.claim.claimVersionId !== recordId || request.claim.claimChainId !== aggregateId || request.claim.version !== version
      : request.requestType !== 'm4-artifact-draft' || request.manifest.artifactManifestId !== recordId || request.manifest.artifactId !== aggregateId || request.manifest.version !== version) return undefined
    return { kind: 'm4-command', sessionId: request.sessionId, investigationId, scopeVersionId, referenceId: event.eventId,
      recordId, recordType: requestType === 'm4-claim-record' ? 'claim-version' : 'artifact-manifest' }
  }
}

function researchRecallProjectionFromRow(
  row: Record<string, unknown>,
  workspaceId: string,
): ResearchRecallProjection {
  const sourceScopeVersionId = optionalStringColumn(row, 'source_scope_version_id')
  if (sourceScopeVersionId === undefined) {
    throw new SourceScopeStoreError(
      'integrity-error',
      'active Research Recall projection lost its source scope identity',
    )
  }
  const provenanceCallId = optionalStringColumn(row, 'provenance_call_id')
  const projection: ResearchRecallProjection = {
    recordId: stringColumn(row, 'record_id'),
    workspaceId: stringColumn(row, 'workspace_id'),
    investigationId: stringColumn(row, 'investigation_id'),
    sourceSessionId: stringColumn(row, 'source_session_id'),
    sourceScopeVersionId,
    ...(provenanceCallId === undefined ? {} : { provenanceCallId }),
    recordType: researchRecordTypeColumn(row),
    recordStatus: researchRecordStatusColumn(row),
    recordVersion: numberColumn(row, 'record_version'),
    previewText: stringColumn(row, 'preview_text'),
    searchText: stringColumn(row, 'search_text'),
    sourceIdentities: parseResearchSourceIdentities(stringColumn(row, 'source_identities_json')),
    createdAt: stringColumn(row, 'created_at'),
  }
  if (projection.workspaceId !== workspaceId
    || sha256(canonicalJson(projection)) !== stringColumn(row, 'projection_hash')) {
    throw new SourceScopeStoreError(
      'integrity-error',
      'Research Recall projection failed Continuity integrity validation',
    )
  }
  return projection
}

interface ContinuitySourceProjection {
  sources: ResearchSourceIdentity[], incomplete: boolean,
  evidenceRefs: ContinuityEvidenceReference[], authorizationRefs: ContinuityAuthorizationReference[], authorizationComplete: boolean,
}
const MAX_CONTINUITY_REFERENCES = 1024
function emptyContinuitySources(): ContinuitySourceProjection { return { sources: [], incomplete: false, evidenceRefs: [], authorizationRefs: [], authorizationComplete: true } }
function boundedContinuityRefs<T>(values: T[]): T[] {
  const unique = new Map<string, T>()
  for (const value of values) {
    unique.set(canonicalJson(value), value)
    if (unique.size > MAX_CONTINUITY_REFERENCES) throw new SourceScopeStoreError('limit-exceeded', 'Continuity metadata reference bound exceeded')
  }
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
}

function continuitySourcesFromEvidence(
  database: DatabaseSync,
  workspaceId: string,
  evidenceIds: readonly string[],
  identity: { investigationId: string, sourceScopeVersionId: string },
): ContinuitySourceProjection {
  const projection = emptyContinuitySources(), sources = new Map<string, ResearchSourceIdentity>()
  for (const evidenceId of new Set(evidenceIds)) {
    projection.evidenceRefs.push({ investigationId: identity.investigationId, scopeVersionId: identity.sourceScopeVersionId, evidenceId })
    if (projection.evidenceRefs.length > MAX_CONTINUITY_REFERENCES) throw new SourceScopeStoreError('limit-exceeded', 'Continuity Evidence reference bound exceeded')
    const capture = resolveCanonicalEvidence(database, workspaceId, evidenceId, identity)
    if (capture === undefined) { projection.incomplete = true; projection.authorizationComplete = false; continue }
    const source = { documentId: capture.locator.documentId, revisionId: capture.locator.revisionId,
      representationId: capture.locator.representationId, representationContentHash: capture.locator.representationContentHash }
    sources.set(researchSourceKey(source), source)
    for (const origin of capture.origins) projection.authorizationRefs.push(origin.kind === 'answer-read'
      ? { kind: 'answer-read', sessionId: origin.sessionId, investigationId: identity.investigationId, scopeVersionId: identity.sourceScopeVersionId,
          referenceId: origin.manifestId, messageId: origin.messageId, citationId: origin.citationId }
      : { kind: 'selection-action', sessionId: origin.sessionId, investigationId: identity.investigationId, scopeVersionId: identity.sourceScopeVersionId,
          referenceId: origin.actionId, selectionContextId: origin.selectionContextId })
    projection.authorizationRefs = boundedContinuityRefs(projection.authorizationRefs)
  }
  return { ...projection, sources: [...sources.values()].sort((left, right) => researchSourceKey(left).localeCompare(researchSourceKey(right))) }
}

function mergeContinuitySources(parts: ContinuitySourceProjection[]): ContinuitySourceProjection {
  const sources = new Map(parts.flatMap(part => part.sources).map(source => [researchSourceKey(source), source]))
  if (sources.size > MAX_CONTINUITY_REFERENCES) throw new SourceScopeStoreError('limit-exceeded', 'Continuity source reference bound exceeded')
  return { sources: [...sources.values()].sort((left, right) => researchSourceKey(left).localeCompare(researchSourceKey(right))), incomplete: parts.some(part => part.incomplete),
    evidenceRefs: boundedContinuityRefs(parts.flatMap(part => part.evidenceRefs)), authorizationRefs: boundedContinuityRefs(parts.flatMap(part => part.authorizationRefs)),
    authorizationComplete: parts.every(part => part.authorizationComplete) }
}

function continuityMetadata(database: DatabaseSync, projection: ContinuitySourceProjection) {
  return { sources: projection.sources, sourceReferencesComplete: !projection.incomplete && projection.sources.length > 0,
    sourceAvailability: continuityAvailability(database, projection), evidenceRefs: projection.evidenceRefs,
    authorizationRefs: projection.authorizationRefs, authorizationComplete: projection.authorizationComplete }
}

function continuityAvailability(database: DatabaseSync, projection: ContinuitySourceProjection): 'missing' | 'available' {
  return projection.incomplete || !projection.sources.length || projection.sources.some(source => !sourceIdentityAvailable(database, source)) ? 'missing' : 'available'
}

function continuityClaimSources(database: DatabaseSync, workspaceId: string, ledger: ClaimLedgerSnapshot, ids: readonly string[], origin: ReturnType<typeof continuityM4Origin>): ContinuitySourceProjection {
  const claims = new Map(ledger.claims.map(claim => [claim.claimVersionId, claim])), activities = new Map(ledger.derivations.map(activity => [activity.derivationActivityId, activity]))
  const pending = [...ids], visited = new Set<string>()
  let dependencies = emptyContinuitySources()
  while (pending.length) {
    const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id)
    if (visited.size > 10000) throw new SourceScopeStoreError('limit-exceeded', 'Continuity Claim dependency traversal exceeds its bound')
    const claim = claims.get(id), activity = claim ? activities.get(claim.provenanceActivityId) : undefined
    if (!claim || !activity) { dependencies.incomplete = true; dependencies.authorizationComplete = false; continue }
    const authority = origin('m4-claim-record', claim.claimVersionId, claim.claimChainId, claim.version, claim.investigationId, claim.scope.sourceScopeVersionId)
    const captured = continuitySourcesFromEvidence(database, workspaceId,
      [...activity.inputEvidenceIds, ...ledger.evidenceRelations.filter(relation => relation.claimVersionId === id).map(relation => relation.evidenceId)],
      { investigationId: claim.investigationId, sourceScopeVersionId: claim.scope.sourceScopeVersionId })
    // Merge on each step, so the authority bound applies to the whole closure, not only individual Claims.
    dependencies = mergeContinuitySources([dependencies, { ...captured, authorizationRefs: [...captured.authorizationRefs, ...(authority ? [authority] : [])],
      authorizationComplete: captured.authorizationComplete && !!authority }])
    // Actual derived inputs are dependencies. Version-history metadata is not a
    // substitute: an independently re-read human edit does not borrow old support.
    if (claim.basis === 'derived-from-claims') pending.push(...activity.inputClaimVersionIds)
  }
  return dependencies
}

function sourceIdentityAvailable(
  database: DatabaseSync,
  source: ResearchSourceIdentity,
): boolean {
  const row = readRow(database, `
    SELECT representations_json FROM library_revisions
    WHERE document_id = ? AND revision_id = ?
  `, source.documentId, source.revisionId)
  if (row === undefined) return false
  const representations = parseJson(stringColumn(row, 'representations_json'))
  if (!Array.isArray(representations)) {
    throw new SourceScopeStoreError('integrity-error', 'Library revision representations are invalid')
  }
  return representations.some((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false
    const value = candidate as Record<string, unknown>
    return value.representationId === source.representationId
      && value.revisionId === source.revisionId
      && value.contentHash === source.representationContentHash
  })
}

function humanCommandIdentity(value: HumanResearchCommandIdentity): HumanResearchCommandIdentity {
  return { operationId: value.operationId, idempotencyKey: value.idempotencyKey, requestHash: value.requestHash,
    actorId: value.actorId, workspaceId: value.workspaceId, conversationId: value.conversationId,
    bindingId: value.bindingId, generation: value.generation, action: value.action }
}

function assertHumanCommandIdentity(value: HumanResearchCommandIdentity, code: SourceScopeStoreErrorCode): void {
  const invalid = () => { throw new SourceScopeStoreError(code, 'Human research command identity is invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (canonicalJson(value) !== canonicalJson(humanCommandIdentity(value))) return invalid()
  for (const key of ['operationId', 'idempotencyKey', 'actorId', 'workspaceId', 'conversationId', 'bindingId'] as const) {
    if (typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value[key])) return invalid()
  }
  if (value.idempotencyKey.length < 16 || !Number.isSafeInteger(value.generation) || value.generation < 1 || !/^[a-f0-9]{64}$/u.test(value.requestHash)
    || !['create', 'edit', 'resolve', 'archive', 'delete', 'revise'].includes(value.action)
    || value.operationId !== `human-op:${sha256(canonicalJson([value.actorId, value.workspaceId, value.conversationId, value.idempotencyKey]))}`) return invalid()
}

function humanResearchAuthority(authority: HumanResearchCommitContext) {
  if (!authority || typeof authority !== 'object' || authority.actor?.kind !== 'user' || typeof authority.assertCurrent !== 'function') {
    throw new SourceScopeStoreError('invalid-request', 'Human research mutation requires synchronous trusted human authority')
  }
  assertHumanCommandIdentity(authority.command, 'invalid-request')
  if (authority.actor.actorId !== authority.command.actorId) throw new SourceScopeStoreError('invalid-request', 'Human research actor differs from its command owner')
  const actor = structuredClone(authority.actor), command = structuredClone(authority.command)
  const suppliedSources = authority.governanceSources === undefined ? undefined : structuredClone(authority.governanceSources)
  const governanceSources = suppliedSources === undefined ? undefined : parseHumanGovernanceSources(suppliedSources, 'invalid-request')
  const identity = canonicalJson({ actor, command, governanceSources: suppliedSources })
  const check = () => {
    const result: unknown = authority.assertCurrent()
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
      throw new SourceScopeStoreError('invalid-request', 'Human research authority assertions must be synchronous')
    }
    if (canonicalJson({ actor: authority.actor, command: authority.command, governanceSources: authority.governanceSources }) !== identity) throw new SourceScopeStoreError('conflict', 'Human research trusted authority changed')
  }
  return { actor, command, governanceSources, check }
}

function parseHumanResearchRecord(value: unknown, code: SourceScopeStoreErrorCode = 'integrity-error'): HumanResearchRecord {
  try {
    const parsed = parseContract('human-research', typeof value === 'string' ? JSON.parse(value) : value)
    if (!('origin' in parsed) || humanResearchIssues(parsed).length || Buffer.byteLength(canonicalJson(parsed)) > 131072) throw new Error('Invalid human record')
    return parsed
  } catch { throw new SourceScopeStoreError(code, 'Human research canonical record is invalid') }
}

function parseHumanResearchReceipt(value: unknown): HumanResearchReceipt {
  try {
    const parsed = parseContract('human-research', typeof value === 'string' ? JSON.parse(value) : value)
    if (!('kind' in parsed) || parsed.kind !== 'human-research-receipt' || humanResearchIssues(parsed).length || Buffer.byteLength(canonicalJson(parsed)) > 8192) throw new Error('Invalid receipt')
    assertHumanCommandIdentity(humanCommandIdentity(parsed), 'integrity-error')
    return parsed
  } catch { throw new SourceScopeStoreError('integrity-error', 'Human research receipt is invalid') }
}

function humanResearchReceipt(command: HumanResearchCommandIdentity, recordId: string, recordType: ResearchRecordType, recordVersion: number, committedAt: string): HumanResearchReceipt {
  return parseHumanResearchReceipt({ schemaVersion: 1, kind: 'human-research-receipt', ...command, status: 'committed', recordId, recordType, recordVersion, committedAt })
}

function commitHumanResearchReceipt(database: DatabaseSync, receipt: HumanResearchReceipt, aggregateId: string, eventType: string): void {
  const journal = readRow(database, 'SELECT payload_hash FROM journal_events WHERE aggregate_id=? AND aggregate_version=? AND event_type=? AND idempotency_key=?',
    aggregateId, String(receipt.recordVersion), eventType, receipt.operationId)
  if (!journal) throw new SourceScopeStoreError('integrity-error', 'Human research receipt requires its committed domain event')
  const receiptJson = canonicalJson(receipt)
  database.prepare(`INSERT INTO human_research_commands(operation_id,workspace_id,actor_id,conversation_id,idempotency_key,request_hash,receipt_json,receipt_hash,aggregate_id,aggregate_version,event_type,event_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.operationId, receipt.workspaceId, receipt.actorId, receipt.conversationId, receipt.idempotencyKey,
    receipt.requestHash, receiptJson, sha256(receiptJson), aggregateId, receipt.recordVersion, eventType, stringColumn(journal, 'payload_hash'))
}

function verifyHumanResearchReceiptRow(database: DatabaseSync, workspaceId: string, row: Record<string, unknown>): HumanResearchReceipt {
  const receiptJson = stringColumn(row, 'receipt_json')
  if (Buffer.byteLength(receiptJson) > 8192 || sha256(receiptJson) !== stringColumn(row, 'receipt_hash')) throw new SourceScopeStoreError('integrity-error', 'Human research receipt hash is invalid')
  const receipt = parseHumanResearchReceipt(receiptJson)
  if (receipt.workspaceId !== workspaceId || receipt.workspaceId !== row.workspace_id || receipt.operationId !== row.operation_id || receipt.actorId !== row.actor_id
    || receipt.conversationId !== row.conversation_id || receipt.idempotencyKey !== row.idempotency_key || receipt.requestHash !== row.request_hash
    || receipt.recordVersion !== row.aggregate_version || canonicalJson(receipt) !== receiptJson) throw new SourceScopeStoreError('integrity-error', 'Human research receipt owner or operation changed')
  const journal = readRow(database, 'SELECT * FROM journal_events WHERE aggregate_id=? AND aggregate_version=? AND event_type=? AND idempotency_key=?',
    stringColumn(row, 'aggregate_id'), String(receipt.recordVersion), stringColumn(row, 'event_type'), receipt.operationId)
  if (!journal || journal.workspace_id !== workspaceId || journal.payload_version !== 1 || journal.payload_hash !== row.event_hash
    || sha256(stringColumn(journal, 'payload_json')) !== journal.payload_hash || journal.actor_json !== canonicalJson({ kind: 'user', actorId: receipt.actorId })
    || journal.occurred_at !== receipt.committedAt) throw new SourceScopeStoreError('integrity-error', 'Human research receipt lost its exact domain event')
  const payload = parseJsonWithMessage(stringColumn(journal, 'payload_json'), 'Human research receipt event is invalid') as Record<string, unknown>
  if (row.event_type === 'human-research.created') {
    const record = parseHumanResearchRecord(payload.record)
    if (record.recordId !== receipt.recordId || record.recordType !== receipt.recordType || receipt.action !== 'create' || receipt.recordVersion !== 1
      || record.provenanceCommandId !== receipt.operationId || record.commandHash !== receipt.requestHash || record.createdBy.actorId !== receipt.actorId
      || record.sourceSessionId !== receipt.conversationId || record.recordId !== row.aggregate_id) throw new SourceScopeStoreError('integrity-error', 'Human research creation receipt is inconsistent')
  } else if (row.event_type === 'research-record.lifecycle') {
    const state = parseResearchRecordState(payload.state)
    const statusMatches = receipt.action === 'edit' ? state.status === (state.recordType === 'open-question' ? 'open' : 'active')
      : receipt.action === 'resolve' ? state.status === 'resolved' : receipt.action === 'archive' ? state.status === 'archived' : receipt.action === 'delete' && state.status === 'deleted'
    if (!statusMatches || state.recordId !== receipt.recordId || state.recordType !== receipt.recordType || state.version !== receipt.recordVersion || state.updatedBy.actorId !== receipt.actorId) {
      throw new SourceScopeStoreError('integrity-error', 'Human research lifecycle receipt is inconsistent')
    }
  } else if (typeof row.event_type === 'string' && row.event_type.startsWith('research-governance.')) {
    const governance = parseGovernanceJournalPayload(workspaceId, journal), record = governance.record
    const expected = { create: 'created', revise: 'revised', archive: 'archived', delete: 'deleted' }[receipt.action as 'create' | 'revise' | 'archive' | 'delete']
    if (!expected || row.event_type !== `research-governance.${expected}` || record.recordId !== receipt.recordId || record.recordType !== receipt.recordType
      || record.version !== receipt.recordVersion || record.updatedBy.actorId !== receipt.actorId || record.recordId !== row.aggregate_id
      || !governance.humanCommand || canonicalJson(governance.humanCommand.identity) !== canonicalJson(humanCommandIdentity(receipt))) throw new SourceScopeStoreError('integrity-error', 'Human governance receipt is inconsistent')
  } else throw new SourceScopeStoreError('integrity-error', 'Human research receipt has an unsupported event type')
  return receipt
}

function verifyHumanResearchRecordRow(database: DatabaseSync, workspaceId: string, row: Record<string, unknown>): HumanResearchRecord {
  const json = stringColumn(row, 'record_json')
  if (Buffer.byteLength(json) > 131072 || sha256(json) !== stringColumn(row, 'record_hash')) throw new SourceScopeStoreError('integrity-error', 'Human research record hash is invalid')
  const record = parseHumanResearchRecord(json)
  if (record.workspaceId !== workspaceId || record.workspaceId !== row.workspace_id || record.recordId !== row.record_id || record.investigationId !== row.investigation_id
    || record.sourceSessionId !== row.source_session_id || record.sourceScopeVersionId !== row.source_scope_version_id || record.provenanceCommandId !== row.provenance_command_id
    || record.createdAt !== row.created_at || canonicalJson(record) !== json) throw new SourceScopeStoreError('integrity-error', 'Human research record identity is invalid')
  const journal = readRow(database, "SELECT payload_json,payload_hash FROM journal_events WHERE aggregate_id=? AND aggregate_version=1 AND event_type='human-research.created' AND idempotency_key=?", record.recordId, record.provenanceCommandId)
  if (!journal || sha256(stringColumn(journal, 'payload_json')) !== journal.payload_hash || stringColumn(journal, 'payload_json') !== canonicalJson({ schemaVersion: 1, record })) {
    throw new SourceScopeStoreError('integrity-error', 'Human research record differs from its canonical journal')
  }
  const receiptRow = readRow(database, 'SELECT * FROM human_research_commands WHERE operation_id=?', record.provenanceCommandId)
  if (!receiptRow || verifyHumanResearchReceiptRow(database, workspaceId, receiptRow).recordId !== record.recordId) throw new SourceScopeStoreError('integrity-error', 'Human research command provenance is missing')
  const latest = database.prepare('SELECT max(aggregate_version) AS version FROM journal_events WHERE aggregate_id=?').get(record.recordId)!
  const current = readRow(database, 'SELECT version FROM research_record_states WHERE record_id=?', record.recordId)
  if (latest.version !== (current?.version ?? 1)) throw new SourceScopeStoreError('integrity-error', 'Human research current lifecycle projection is behind its journal')
  return record
}

function verifyResearchRecordRow(
  database: DatabaseSync,
  workspaceId: string,
  row: Record<string, unknown>,
): AgentResearchRecord {
  const recordJson = stringColumn(row, 'record_json')
  if (sha256(recordJson) !== stringColumn(row, 'record_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research record projection hash is invalid')
  }
  const record = parseAgentResearchRecord(recordJson)
  if (record.workspaceId !== workspaceId
    || record.recordId !== stringColumn(row, 'record_id')
    || record.workspaceId !== stringColumn(row, 'workspace_id')
    || record.investigationId !== stringColumn(row, 'investigation_id')
    || record.sourceSessionId !== stringColumn(row, 'source_session_id')
    || record.sourceScopeVersionId !== stringColumn(row, 'source_scope_version_id')
    || record.provenanceCallId !== stringColumn(row, 'provenance_call_id')
    || record.recordType !== stringColumn(row, 'record_type')
    || numberColumn(row, 'aggregate_version') !== 1
    || record.createdAt !== stringColumn(row, 'created_at')) {
    throw new SourceScopeStoreError('integrity-error', 'Research record projection identity is invalid')
  }
  const journal = readRow(database, `
    SELECT aggregate_id, payload_json, payload_hash FROM journal_events
    WHERE aggregate_id = ? AND aggregate_version = 1 AND event_type = 'research-record.created'
  `, record.recordId)
  if (journal === undefined || stringColumn(journal, 'aggregate_id') !== record.recordId) {
    throw new SourceScopeStoreError('integrity-error', 'Research record journal identity is invalid')
  }
  const payloadJson = stringColumn(journal, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(journal, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research record journal hash is invalid')
  }
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'Research record journal payload is invalid')
  }
  if (canonicalJson(payload) !== canonicalJson({ schemaVersion: 1, record })) {
    throw new SourceScopeStoreError('integrity-error', 'Research record does not match its journal event')
  }
  const replay = readRow(database, `
    SELECT result_json, result_hash, record_id FROM research_record_idempotency
    WHERE record_id = ?
  `, record.recordId)
  if (replay === undefined) {
    throw new SourceScopeStoreError('integrity-error', 'Research record idempotency projection is missing')
  }
  const resultJson = stringColumn(replay, 'result_json')
  if (sha256(resultJson) !== stringColumn(replay, 'result_hash')
    || stringColumn(replay, 'record_id') !== record.recordId
    || canonicalJson(parseResearchRecordResult(resultJson).record) !== canonicalJson(record)) {
    throw new SourceScopeStoreError('integrity-error', 'Research record idempotency projection is invalid')
  }
  return record
}

function verifyResearchLifecycleState(
  database: DatabaseSync,
  workspaceId: string,
  row: Record<string, unknown>,
): ResearchRecordState {
  const stateJson = stringColumn(row, 'state_json')
  if (sha256(stateJson) !== stringColumn(row, 'state_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle state hash is invalid')
  }
  const state = parseResearchRecordState(stateJson)
  if (state.workspaceId !== workspaceId
    || state.recordId !== stringColumn(row, 'record_id')
    || state.workspaceId !== stringColumn(row, 'workspace_id')
    || state.investigationId !== stringColumn(row, 'investigation_id')
    || state.version !== numberColumn(row, 'version')
    || state.updatedAt !== stringColumn(row, 'updated_at')) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle state identity is invalid')
  }
  const base = researchLifecycleBase(database, workspaceId, state.recordId)
  if (base === undefined || base.investigationId !== state.investigationId
    || base.recordType !== state.recordType) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle base record is invalid')
  }
  const journal = readRow(database, `
    SELECT payload_json, payload_hash FROM journal_events
    WHERE aggregate_id = ? AND aggregate_version = ? AND event_type = 'research-record.lifecycle'
  `, base.aggregateId, String(state.version))
  if (journal === undefined) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle journal event is missing')
  }
  const payloadJson = stringColumn(journal, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(journal, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle journal hash is invalid')
  }
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle journal payload is invalid')
  }
  if (canonicalJson(payload) !== canonicalJson({ schemaVersion: 1, state })) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle state does not match its journal event')
  }
  return state
}

function verifyResearchLifecycleReplayRow(
  database: DatabaseSync,
  workspaceId: string,
  row: Record<string, unknown>,
): void {
  const resultJson = stringColumn(row, 'result_json')
  if (!/^[a-f0-9]{64}$/.test(stringColumn(row, 'request_hash'))
    || sha256(resultJson) !== stringColumn(row, 'result_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay hash is invalid')
  }
  const result = parseResearchLifecycleResult(resultJson)
  if (result.state.workspaceId !== workspaceId
    || result.state.recordId !== stringColumn(row, 'record_id')) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay identity is invalid')
  }
  const journal = readRow(database, `
    SELECT payload_json, payload_hash FROM journal_events
    WHERE idempotency_key = ? AND event_type = 'research-record.lifecycle'
  `, stringColumn(row, 'idempotency_key'))
  if (journal === undefined) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay journal is missing')
  }
  const payloadJson = stringColumn(journal, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(journal, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay journal hash is invalid')
  }
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay payload is invalid')
  }
  if (canonicalJson(payload) !== canonicalJson({ schemaVersion: 1, state: result.state })) {
    throw new SourceScopeStoreError('integrity-error', 'Research lifecycle replay does not match its journal event')
  }
}

interface ResearchGovernanceJournalPayload {
  schemaVersion: 1
  record: ResearchGovernanceRecord
  humanCommand?: { identity: HumanResearchCommandIdentity, sourceIdentities: ResearchSourceIdentity[] }
}

function parseHumanGovernanceSources(value: unknown, code: SourceScopeStoreErrorCode): ResearchSourceIdentity[] {
  try {
    const sources = parseResearchSourceIdentities(canonicalJson(value)), ids = new Set<string>()
    for (const source of sources) {
      if (![source.documentId, source.revisionId, source.representationId].every(id => /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(id))) throw new Error('Invalid source identity')
      const key = canonicalJson([source.documentId, source.revisionId])
      if (ids.has(key)) throw new Error('Duplicated source revision')
      ids.add(key)
    }
    return sources.sort((left, right) => researchSourceKey(left).localeCompare(researchSourceKey(right)))
  } catch { throw new SourceScopeStoreError(code, 'Human Governance source identities are invalid') }
}

function parseGovernanceJournalPayload(workspaceId: string, row: Record<string, unknown>): ResearchGovernanceJournalPayload {
  const json = stringColumn(row, 'payload_json')
  if (sha256(json) !== row.payload_hash) throw new SourceScopeStoreError('integrity-error', 'Research Governance journal hash is invalid')
  const value = parseJsonWithMessage(json, 'Research Governance journal payload is invalid')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceScopeStoreError('integrity-error', 'Research Governance journal payload is invalid')
  const candidate = value as Record<string, unknown>, record = parseResearchGovernanceRecord(candidate.record)
  if (record.workspaceId !== workspaceId || row.workspace_id !== workspaceId || record.recordId !== row.aggregate_id || record.version !== row.aggregate_version
    || record.updatedAt !== row.occurred_at || canonicalJson(record.updatedBy) !== row.actor_json || row.payload_version !== 1) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance journal identity is invalid')
  }
  const payload: ResearchGovernanceJournalPayload = { schemaVersion: 1, record }
  if (candidate.humanCommand !== undefined) {
    const marker = candidate.humanCommand
    if (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.keys(marker).sort().join(',') !== 'identity,sourceIdentities') {
      throw new SourceScopeStoreError('integrity-error', 'Human Governance journal command marker is invalid')
    }
    const command = Reflect.get(marker, 'identity') as HumanResearchCommandIdentity
    assertHumanCommandIdentity(command, 'integrity-error')
    const sourceIdentities = parseHumanGovernanceSources(Reflect.get(marker, 'sourceIdentities'), 'integrity-error')
    const event = { create: 'created', revise: 'revised', archive: 'archived', delete: 'deleted' }[command.action as 'create' | 'revise' | 'archive' | 'delete']
    const expectedStatus = command.action === 'archive' ? 'archived' : command.action === 'delete' ? 'deleted' : 'active'
    if (!event || row.event_type !== `research-governance.${event}` || row.idempotency_key !== command.operationId
      || command.workspaceId !== workspaceId || command.actorId !== record.updatedBy.actorId || record.status !== expectedStatus
      || (record.version === 1) !== (command.action === 'create') || record.version === 1 && command.conversationId !== record.sourceSessionId) {
      throw new SourceScopeStoreError('integrity-error', 'Human Governance journal command identity is inconsistent')
    }
    payload.humanCommand = { identity: command, sourceIdentities }
  } else if (/^human-op:[a-f0-9]{64}$/u.test(stringColumn(row, 'idempotency_key'))) {
    throw new SourceScopeStoreError('integrity-error', 'Human Governance journal lost its command marker')
  }
  if (canonicalJson(payload) !== canonicalJson(candidate)) throw new SourceScopeStoreError('integrity-error', 'Research Governance journal payload shape is invalid')
  return payload
}

function requireGovernanceReceipt(database: DatabaseSync, workspaceId: string, payload: ResearchGovernanceJournalPayload): void {
  if (!payload.humanCommand) return
  const row = readRow(database, 'SELECT * FROM human_research_commands WHERE operation_id=?', payload.humanCommand.identity.operationId)
  if (!row) throw new SourceScopeStoreError('integrity-error', 'Human Governance journal command receipt is missing')
  const receipt = verifyHumanResearchReceiptRow(database, workspaceId, row)
  if (canonicalJson(humanCommandIdentity(receipt)) !== canonicalJson(payload.humanCommand.identity)) throw new SourceScopeStoreError('integrity-error', 'Human Governance receipt changed its complete command')
}

function humanGovernanceOrigin(database: DatabaseSync, workspaceId: string, recordId: string): ResearchGovernanceJournalPayload | undefined {
  const row = readRow(database, "SELECT * FROM journal_events WHERE aggregate_id=? AND aggregate_version=1 AND event_type='research-governance.created'", recordId)
  if (!row) return undefined
  const payload = parseGovernanceJournalPayload(workspaceId, row)
  requireGovernanceReceipt(database, workspaceId, payload)
  return payload
}

function verifyResearchGovernanceRow(
  database: DatabaseSync,
  workspaceId: string,
  row: Record<string, unknown>,
): ResearchGovernanceRecord {
  const recordJson = stringColumn(row, 'record_json')
  if (sha256(recordJson) !== stringColumn(row, 'record_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance projection hash is invalid')
  }
  const record = parseResearchGovernanceRecord(recordJson)
  if (record.workspaceId !== workspaceId
    || record.recordId !== stringColumn(row, 'record_id')
    || record.workspaceId !== stringColumn(row, 'workspace_id')
    || record.investigationId !== stringColumn(row, 'investigation_id')
    || record.sourceSessionId !== stringColumn(row, 'source_session_id')
    || record.sourceScopeVersionId !== stringColumn(row, 'source_scope_version_id')
    || record.recordType !== stringColumn(row, 'record_type')
    || record.version !== numberColumn(row, 'aggregate_version')
    || record.status !== stringColumn(row, 'status')
    || record.createdAt !== stringColumn(row, 'created_at')
    || record.updatedAt !== stringColumn(row, 'updated_at')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance projection identity is invalid')
  }
  const journal = readRow(database, `
    SELECT * FROM journal_events
    WHERE aggregate_id = ? AND aggregate_version = ?
      AND event_type IN (
        'research-governance.created', 'research-governance.revised',
        'research-governance.archived', 'research-governance.deleted'
      )
  `, record.recordId, String(record.version))
  if (journal === undefined) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance journal event is missing')
  }
  const payloadJson = stringColumn(journal, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(journal, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance journal hash is invalid')
  }
  const payload = parseGovernanceJournalPayload(workspaceId, journal)
  if (canonicalJson(payload.record) !== canonicalJson(record)) {
    throw new SourceScopeStoreError(
      'integrity-error',
      'Research Governance projection does not match its journal event',
    )
  }
  const original = humanGovernanceOrigin(database, workspaceId, record.recordId)
  if (!original) throw new SourceScopeStoreError('integrity-error', 'Research Governance creation journal is missing')
  if (original.humanCommand && (!payload.humanCommand || canonicalJson(payload.humanCommand.sourceIdentities) !== canonicalJson(original.humanCommand.sourceIdentities)
    || record.sourceSessionId !== original.record.sourceSessionId || record.sourceScopeVersionId !== original.record.sourceScopeVersionId
    || record.investigationId !== original.record.investigationId || canonicalJson(record.createdBy) !== canonicalJson(original.record.createdBy))) {
    throw new SourceScopeStoreError('integrity-error', 'Human Governance changed its immutable original source capture')
  }
  requireGovernanceReceipt(database, workspaceId, payload)
  return record
}

function verifyResearchGovernanceReplayRow(
  database: DatabaseSync,
  workspaceId: string,
  row: Record<string, unknown>,
): void {
  const resultJson = stringColumn(row, 'result_json')
  if (!/^[a-f0-9]{64}$/.test(stringColumn(row, 'request_hash'))
    || sha256(resultJson) !== stringColumn(row, 'result_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance replay hash is invalid')
  }
  const result = parseResearchGovernanceResult(resultJson)
  if (result.record.workspaceId !== workspaceId
    || result.record.recordId !== stringColumn(row, 'record_id')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance replay identity is invalid')
  }
  const journal = readRow(database, `
    SELECT * FROM journal_events
    WHERE idempotency_key = ? AND event_type LIKE 'research-governance.%'
  `, stringColumn(row, 'idempotency_key'))
  if (journal === undefined) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance replay journal is missing')
  }
  const payloadJson = stringColumn(journal, 'payload_json')
  if (sha256(payloadJson) !== stringColumn(journal, 'payload_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Governance replay journal hash is invalid')
  }
  const payload = parseGovernanceJournalPayload(workspaceId, journal)
  if (canonicalJson(payload.record) !== canonicalJson(result.record)) {
    throw new SourceScopeStoreError(
      'integrity-error',
      'Research Governance replay does not match its journal event',
    )
  }
  const original = humanGovernanceOrigin(database, workspaceId, result.record.recordId)
  if (original?.humanCommand && (!payload.humanCommand || canonicalJson(payload.humanCommand.sourceIdentities) !== canonicalJson(original.humanCommand.sourceIdentities)
    || result.record.sourceSessionId !== original.record.sourceSessionId || result.record.sourceScopeVersionId !== original.record.sourceScopeVersionId)) {
    throw new SourceScopeStoreError('integrity-error', 'Human Governance replay changed its original source capture')
  }
  requireGovernanceReceipt(database, workspaceId, payload)
}

function selectionActionMatches(
  workspaceId: string,
  request: SelectionActionRequest,
  context: SelectionContext,
  result: SelectionActionResult,
): boolean {
  if (result.status !== 'created'
    || result.sessionId !== request.sessionId
    || result.selectionContextId !== request.selectionContextId
    || result.action !== request.action
    || context.sessionId !== request.sessionId
    || context.selectionContextId !== request.selectionContextId
    || context.workspaceId !== workspaceId
    || result.record.workspaceId !== workspaceId
    || result.record.investigationId !== context.investigationId
    || result.record.selectionContextId !== context.selectionContextId
    || result.record.createdBy.kind !== 'user') return false
  const locators = context.selections.flatMap(selection => selection.locators)
  if (canonicalJson(result.locators) !== canonicalJson(locators)) return false
  const actionMatches = request.action === 'save-evidence'
    ? result.record.recordType === 'evidence-bookmark'
    : request.action === 'create-note'
      ? result.record.recordType === 'research-note'
        && result.record.noteKind === request.noteKind && result.record.body === request.body
      : request.action === 'open-question'
        ? result.record.recordType === 'open-question'
          && result.record.question === request.question
        : result.record.recordType === 'claim-proposal'
          && result.record.statement === request.statement
          && result.record.relation === request.relation
          && result.record.assertedBy.kind === 'user'
  return actionMatches && selectionRpcIssues(result).length === 0
}

interface ResearchRecallProjection {
  recordId: string
  workspaceId: string
  investigationId: string
  sourceSessionId: string
  sourceScopeVersionId: string
  provenanceCallId?: string
  recordType: ResearchRecordType
  recordStatus: ResearchRecordStatus
  recordVersion: number
  previewText: string
  searchText: string
  sourceIdentities: ResearchSourceIdentity[]
  createdAt: string
}

interface ResearchLifecycleBase {
  aggregateId: string
  recordId: string
  workspaceId: string
  investigationId: string
  recordType: 'research-note' | 'open-question'
  currentText: string
  projection: ResearchRecallProjection
  treeOverlays: ResearchTreeOverlayProjection[]
}

function researchLifecycleBase(
  database: DatabaseSync,
  workspaceId: string,
  recordId: string,
): ResearchLifecycleBase | undefined {
  const humanRow = databaseTableExists(database, 'human_research_records') ? readRow(database, 'SELECT * FROM human_research_records WHERE record_id = ?', recordId) : undefined
  if (humanRow) {
    const record = verifyHumanResearchRecordRow(database, workspaceId, humanRow)
    return { aggregateId: record.recordId, recordId: record.recordId, workspaceId: record.workspaceId, investigationId: record.investigationId,
      recordType: record.recordType, currentText: record.recordType === 'research-note' ? record.body : record.question,
      projection: researchProjectionFromHumanRecord(record), treeOverlays: humanResearchTreeProjections(record) }
  }
  const agentRow = readRow(database, `
    SELECT * FROM research_records WHERE record_id = ?
  `, recordId)
  if (agentRow !== undefined) {
    const record = verifyResearchRecordRow(database, workspaceId, agentRow)
    const currentText = record.recordType === 'research-note' ? record.body : record.question
    return {
      aggregateId: record.recordId,
      recordId: record.recordId,
      workspaceId: record.workspaceId,
      investigationId: record.investigationId,
      recordType: record.recordType,
      currentText,
      projection: researchProjectionFromAgentRecord(record),
      treeOverlays: [],
    }
  }
  const rows = database.prepare('SELECT * FROM selection_actions').all()
  for (const row of rows) {
    const { result, context } = verifySelectionActionRow(database, workspaceId, row)
    const record = result.record
    if (record.recordType === 'research-note' && record.noteId === recordId) {
      return {
        aggregateId: result.actionId,
        recordId: record.noteId,
        workspaceId: record.workspaceId,
        investigationId: record.investigationId,
        recordType: 'research-note',
        currentText: record.body,
        projection: researchProjection(result, context),
        treeOverlays: researchTreeProjections(result),
      }
    }
    if (record.recordType === 'open-question' && record.questionId === recordId) {
      return {
        aggregateId: result.actionId,
        recordId: record.questionId,
        workspaceId: record.workspaceId,
        investigationId: record.investigationId,
        recordType: 'open-question',
        currentText: record.question,
        projection: researchProjection(result, context),
        treeOverlays: researchTreeProjections(result),
      }
    }
  }
  return undefined
}

function researchProjection(
  result: SelectionActionResult,
  context: SelectionContext,
): ResearchRecallProjection {
  const record = result.record
  const sourceIdentities = [...new Map(result.locators.map(locator => {
    const source: ResearchSourceIdentity = {
      documentId: locator.documentId,
      revisionId: locator.revisionId,
      representationId: locator.representationId,
      representationContentHash: locator.representationContentHash,
    }
    return [researchSourceKey(source), source] as const
  })).values()]
  let recordId: string
  let previewText: string
  let searchText: string
  switch (record.recordType) {
    case 'evidence-bookmark': {
      recordId = record.bookmarkId
      previewText = `Saved evidence bookmark with ${record.locatorIds.length} source locator(s).`
      // Never turn Recall into a content oracle for evidence outside the active SourceScope.
      searchText = previewText
      break
    }
    case 'research-note':
      recordId = record.noteId
      previewText = recallPreview(record.body)
      searchText = record.body
      break
    case 'open-question':
      recordId = record.questionId
      previewText = recallPreview(record.question)
      searchText = record.question
      break
    case 'claim-proposal':
      recordId = record.claimProposalId
      previewText = recallPreview(record.statement)
      searchText = record.statement
      break
  }
  return {
    recordId,
    workspaceId: record.workspaceId,
    investigationId: record.investigationId,
    sourceSessionId: result.sessionId,
    sourceScopeVersionId: context.scopeVersionId,
    recordType: record.recordType,
    recordStatus: record.status,
    recordVersion: 1,
    previewText,
    searchText,
    sourceIdentities,
    createdAt: record.createdAt,
  }
}

function researchVisibleIds(database: DatabaseSync, visibility: ResearchVisibility): string[] {
  const rows = database.prepare('SELECT record_id, investigation_id, source_session_id, source_scope_version_id, provenance_call_id, source_identities_json FROM research_recall_records ORDER BY record_id').all()
  return rows.flatMap(row => {
    const sourceScopeVersionId = optionalStringColumn(row, 'source_scope_version_id')
    const reference: ResearchVisibilityRef = { recordId: stringColumn(row, 'record_id'), investigationId: stringColumn(row, 'investigation_id'),
      sourceSessionId: stringColumn(row, 'source_session_id'), ...(sourceScopeVersionId ? { sourceScopeVersionId } : {}),
      ...(optionalStringColumn(row, 'provenance_call_id') ? { provenanceCallId: stringColumn(row, 'provenance_call_id') } : {}),
      sourceIdentities: parseResearchSourceIdentities(stringColumn(row, 'source_identities_json')) }
    return visibility(reference) ? [reference.recordId] : []
  })
}

function researchProjectionFromAgentRecord(
  record: AgentResearchRecord,
  state?: ResearchRecordState,
): ResearchRecallProjection {
  const text = state?.text
    ?? (record.recordType === 'research-note' ? record.body : record.question)
  return {
    recordId: record.recordId,
    workspaceId: record.workspaceId,
    investigationId: record.investigationId,
    sourceSessionId: record.sourceSessionId,
    sourceScopeVersionId: record.sourceScopeVersionId,
    provenanceCallId: record.provenanceCallId,
    recordType: record.recordType,
    recordStatus: state?.status ?? record.status,
    recordVersion: state?.version ?? 1,
    previewText: recallPreview(text),
    searchText: text,
    sourceIdentities: [],
    createdAt: state?.updatedAt ?? record.createdAt,
  }
}

function researchProjectionFromHumanRecord(record: HumanResearchRecord, state?: ResearchRecordState): ResearchRecallProjection {
  const text = state?.text ?? (record.recordType === 'research-note' ? record.body : record.question)
  return { recordId: record.recordId, workspaceId: record.workspaceId, investigationId: record.investigationId,
    sourceSessionId: record.sourceSessionId, sourceScopeVersionId: record.sourceScopeVersionId,
    recordType: record.recordType, recordStatus: state?.status ?? record.status, recordVersion: state?.version ?? 1,
    previewText: state?.status === 'deleted' ? '' : recallPreview(text), searchText: state?.status === 'deleted' ? '' : text,
    sourceIdentities: structuredClone(record.sourceIdentities), createdAt: state?.updatedAt ?? record.createdAt }
}

function researchProjectionWithState(
  projection: ResearchRecallProjection,
  state: ResearchRecordState,
): ResearchRecallProjection {
  if (state.text === undefined) {
    throw new SourceScopeStoreError('integrity-error', 'active Research lifecycle state lost its text')
  }
  return {
    ...projection,
    recordStatus: state.status,
    recordVersion: state.version,
    previewText: recallPreview(state.text),
    searchText: state.text,
    createdAt: state.updatedAt,
  }
}

function researchProjectionFromGovernanceRecord(
  record: ResearchGovernanceRecord,
  sourceIdentities: ResearchSourceIdentity[] = [],
): ResearchRecallProjection {
  if (record.status === 'deleted') {
    throw new SourceScopeStoreError(
      'integrity-error',
      'deleted Research Governance record cannot enter the active projection',
    )
  }
  const primary = record.recordType === 'project-decision'
    ? record.decision
    : record.directive
  const searchText = [record.title, primary, record.rationale].filter(Boolean).join('\n')
  return {
    recordId: record.recordId,
    workspaceId: record.workspaceId,
    investigationId: record.investigationId,
    sourceSessionId: record.sourceSessionId,
    sourceScopeVersionId: record.sourceScopeVersionId,
    recordType: record.recordType,
    recordStatus: record.status,
    recordVersion: record.version,
    previewText: recallPreview(`${record.title} — ${primary}`),
    searchText,
    sourceIdentities: structuredClone(sourceIdentities),
    createdAt: record.updatedAt,
  }
}

function governanceEntryFromRecord(
  record: ResearchGovernanceRecord,
): Exclude<ResearchGovernanceRequest, { action: 'archive' | 'delete' }>['entry'] {
  if (record.status === 'deleted') {
    throw new SourceScopeStoreError('integrity-error', 'deleted Research Governance record lost its content')
  }
  return record.recordType === 'project-decision'
    ? {
        recordType: record.recordType,
        title: record.title,
        decision: record.decision,
        ...(record.rationale === undefined ? {} : { rationale: record.rationale }),
      }
    : {
        recordType: record.recordType,
        title: record.title,
        directive: record.directive,
        policyScope: record.policyScope,
        ...(record.rationale === undefined ? {} : { rationale: record.rationale }),
      }
}

function deleteResearchRecallProjection(database: DatabaseSync, recordId: string): void {
  database.prepare('DELETE FROM research_recall_fts WHERE record_id = ?').run(recordId)
  database.prepare('DELETE FROM research_recall_records WHERE record_id = ?').run(recordId)
}

interface ResearchTreeOverlayProjection {
  overlayId: string
  recordId: string
  workspaceId: string
  investigationId: string
  sourceSessionId: string
  recordType: ResearchRecordType
  recordStatus: ResearchRecordStatus
  locator: DocumentLocator
  previewText: string
  createdAt: string
}

function researchTreeProjections(result: SelectionActionResult): ResearchTreeOverlayProjection[] {
  const record = result.record
  let recordId: string
  let previewText: string
  switch (record.recordType) {
    case 'evidence-bookmark':
      recordId = record.bookmarkId
      previewText = `Saved evidence bookmark with ${record.locatorIds.length} source locator(s).`
      break
    case 'research-note':
      recordId = record.noteId
      previewText = recallPreview(record.body)
      break
    case 'open-question':
      recordId = record.questionId
      previewText = recallPreview(record.question)
      break
    case 'claim-proposal':
      recordId = record.claimProposalId
      previewText = recallPreview(`Proposed ${record.relation} claim: ${record.statement}`)
      break
  }
  return result.locators.map(locator => ({
    overlayId: `overlay:${sha256(`${recordId}\0${locator.locatorId}`).slice(0, 32)}`,
    recordId,
    workspaceId: record.workspaceId,
    investigationId: record.investigationId,
    sourceSessionId: result.sessionId,
    recordType: record.recordType,
    recordStatus: record.status,
    locator: structuredClone(locator),
    previewText,
    createdAt: record.createdAt,
  }))
}

function humanResearchTreeProjections(record: HumanResearchRecord): ResearchTreeOverlayProjection[] {
  return record.anchors.map(anchor => ({ overlayId: `overlay:${sha256(`${record.recordId}\0${anchor.locator.locatorId}`).slice(0, 32)}`,
    recordId: record.recordId, workspaceId: record.workspaceId, investigationId: record.investigationId, sourceSessionId: record.sourceSessionId,
    recordType: record.recordType, recordStatus: record.status, locator: structuredClone(anchor.locator),
    previewText: recallPreview(record.recordType === 'research-note' ? record.body : record.question), createdAt: record.createdAt }))
}

function researchTreeProjectionWithState(
  projection: ResearchTreeOverlayProjection,
  state: ResearchRecordState,
): ResearchTreeOverlayProjection {
  if (state.text === undefined || state.recordId !== projection.recordId
    || state.recordType !== projection.recordType) {
    throw new SourceScopeStoreError('integrity-error', 'Research Tree Overlay lifecycle state is invalid')
  }
  return {
    ...projection,
    recordStatus: state.status,
    previewText: recallPreview(state.text),
    createdAt: state.updatedAt,
  }
}

function upsertResearchTreeOverlay(
  database: DatabaseSync,
  projection: ResearchTreeOverlayProjection,
): void {
  const locatorJson = canonicalJson(projection.locator)
  const projectionHash = sha256(canonicalJson(projection))
  const existing = readRow(database, `
    SELECT projection_hash FROM research_tree_overlays WHERE overlay_id = ?
  `, projection.overlayId)
  if (existing !== undefined) {
    if (stringColumn(existing, 'projection_hash') !== projectionHash) {
      throw new SourceScopeStoreError('integrity-error', 'Research Tree Overlay identity collided')
    }
    return
  }
  database.prepare(`
    INSERT INTO research_tree_overlays (
      overlay_id, record_id, workspace_id, investigation_id, source_session_id,
      record_type, record_status, document_id, revision_id, representation_id,
      representation_hash, physical_page, locator_json, locator_hash,
      preview_text, created_at, projection_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projection.overlayId,
    projection.recordId,
    projection.workspaceId,
    projection.investigationId,
    projection.sourceSessionId,
    projection.recordType,
    projection.recordStatus,
    projection.locator.documentId,
    projection.locator.revisionId,
    projection.locator.representationId,
    projection.locator.representationContentHash,
    projection.locator.physicalPage,
    locatorJson,
    sha256(locatorJson),
    projection.previewText,
    projection.createdAt,
    projectionHash,
  )
}

function deleteResearchTreeOverlays(database: DatabaseSync, recordId: string): void {
  database.prepare('DELETE FROM research_tree_overlays WHERE record_id = ?').run(recordId)
}

function treeOverlayItemFromRow(
  workspaceId: string,
  row: Record<string, unknown>,
): Omit<TreeOverlayItem, 'layer'> {
  const locatorJson = stringColumn(row, 'locator_json')
  if (sha256(locatorJson) !== stringColumn(row, 'locator_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Tree Overlay Locator hash is invalid')
  }
  let locator: DocumentLocator
  try {
    locator = parseContract('document-locator', JSON.parse(locatorJson))
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'Research Tree Overlay Locator is invalid')
  }
  const projection: ResearchTreeOverlayProjection = {
    overlayId: stringColumn(row, 'overlay_id'),
    recordId: stringColumn(row, 'record_id'),
    workspaceId: stringColumn(row, 'workspace_id'),
    investigationId: stringColumn(row, 'investigation_id'),
    sourceSessionId: stringColumn(row, 'source_session_id'),
    recordType: researchRecordTypeColumn(row),
    recordStatus: researchRecordStatusColumn(row),
    locator,
    previewText: stringColumn(row, 'preview_text'),
    createdAt: stringColumn(row, 'created_at'),
  }
  if (projection.workspaceId !== workspaceId
    || projection.locator.documentId !== stringColumn(row, 'document_id')
    || projection.locator.revisionId !== stringColumn(row, 'revision_id')
    || projection.locator.representationId !== stringColumn(row, 'representation_id')
    || projection.locator.representationContentHash !== stringColumn(row, 'representation_hash')
    || projection.locator.physicalPage !== numberColumn(row, 'physical_page')
    || sha256(canonicalJson(projection)) !== stringColumn(row, 'projection_hash')) {
    throw new SourceScopeStoreError('integrity-error', 'Research Tree Overlay projection is invalid')
  }
  return {
    overlayId: projection.overlayId,
    recordId: projection.recordId,
    recordType: projection.recordType,
    recordStatus: projection.recordStatus,
    sourceInvestigationId: projection.investigationId,
    sourceSessionId: projection.sourceSessionId,
    locator: structuredClone(projection.locator),
    preview: projection.previewText,
    relation: 'research-record-anchor',
    verificationStatus: 'anchor-only',
    createdAt: projection.createdAt,
  }
}

function upsertResearchRecallProjection(
  database: DatabaseSync,
  projection: ResearchRecallProjection,
): void {
  const sourceJson = canonicalJson(projection.sourceIdentities)
  const projectionHash = sha256(canonicalJson(projection))
  const existing = readRow(database, `
    SELECT projection_hash FROM research_recall_records WHERE record_id = ?
  `, projection.recordId)
  if (existing !== undefined) {
    if (stringColumn(existing, 'projection_hash') !== projectionHash) {
      throw new SourceScopeStoreError('integrity-error', 'Research Recall record identity collided')
    }
    return
  }
  database.prepare(`
    INSERT INTO research_recall_records (
      record_id, workspace_id, investigation_id, source_session_id,
      source_scope_version_id, provenance_call_id, record_type, record_status, preview_text,
      record_version, search_text, source_identities_json, projection_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projection.recordId,
    projection.workspaceId,
    projection.investigationId,
    projection.sourceSessionId,
    projection.sourceScopeVersionId,
    projection.provenanceCallId ?? null,
    projection.recordType,
    projection.recordStatus,
    projection.previewText,
    projection.recordVersion,
    projection.searchText,
    sourceJson,
    projectionHash,
    projection.createdAt,
  )
  database.prepare(`
    INSERT INTO research_recall_fts (record_id, search_text) VALUES (?, ?)
  `).run(projection.recordId, projection.searchText)
}

function rebuildResearchRecallProjection(database: DatabaseSync, workspaceId: string): void {
  const selectionRows = database.prepare(`
    SELECT * FROM selection_actions ORDER BY created_at, action_id
  `).all()
  const researchRows = database.prepare(`
    SELECT * FROM research_records ORDER BY created_at, record_id
  `).all()
  const humanRows = database.prepare('SELECT * FROM human_research_records ORDER BY created_at, record_id').all()
  const governanceRows = database.prepare(`
    SELECT * FROM research_governance_records ORDER BY updated_at, record_id
  `).all()
  const stateRows = database.prepare('SELECT * FROM research_record_states').all()
  const states = new Map(stateRows.map((row) => {
    const state = verifyResearchLifecycleState(database, workspaceId, row)
    return [state.recordId, state] as const
  }))
  transaction(database, () => {
    database.exec('DELETE FROM research_recall_fts')
    database.exec('DELETE FROM research_recall_records')
    for (const row of selectionRows) {
      const { result, context } = verifySelectionActionRow(database, workspaceId, row)
      const projection = researchProjection(result, context)
      const state = states.get(projection.recordId)
      if (state?.status !== 'deleted') {
        upsertResearchRecallProjection(
          database,
          state === undefined ? projection : researchProjectionWithState(projection, state),
        )
      }
    }
    for (const row of researchRows) {
      const record = verifyResearchRecordRow(database, workspaceId, row)
      const state = states.get(record.recordId)
      if (state?.status !== 'deleted') {
        const projection = researchProjectionFromAgentRecord(record)
        upsertResearchRecallProjection(
          database,
          state === undefined ? projection : researchProjectionWithState(projection, state),
        )
      }
    }
    for (const row of humanRows) {
      const record = verifyHumanResearchRecordRow(database, workspaceId, row), state = states.get(record.recordId)
      if (state?.status !== 'deleted') upsertResearchRecallProjection(database, researchProjectionFromHumanRecord(record, state))
    }
    for (const row of governanceRows) {
      const record = verifyResearchGovernanceRow(database, workspaceId, row)
      if (record.status !== 'deleted') {
        upsertResearchRecallProjection(database, researchProjectionFromGovernanceRecord(record, humanGovernanceOrigin(database, workspaceId, record.recordId)?.humanCommand?.sourceIdentities ?? []))
      }
    }
  })
}

function rebuildResearchTreeOverlayProjection(database: DatabaseSync, workspaceId: string): void {
  const selectionRows = database.prepare(`
    SELECT * FROM selection_actions ORDER BY created_at, action_id
  `).all()
  const stateRows = database.prepare('SELECT * FROM research_record_states').all()
  const humanRows = database.prepare('SELECT * FROM human_research_records ORDER BY created_at, record_id').all()
  const states = new Map(stateRows.map((row) => {
    const state = verifyResearchLifecycleState(database, workspaceId, row)
    return [state.recordId, state] as const
  }))
  transaction(database, () => {
    database.exec('DELETE FROM research_tree_overlays')
    for (const row of selectionRows) {
      const { result } = verifySelectionActionRow(database, workspaceId, row)
      for (const projection of researchTreeProjections(result)) {
        const state = states.get(projection.recordId)
        if (state?.status === 'deleted') continue
        upsertResearchTreeOverlay(
          database,
          state === undefined ? projection : researchTreeProjectionWithState(projection, state),
        )
      }
    }
    for (const row of humanRows) {
      const record = verifyHumanResearchRecordRow(database, workspaceId, row), state = states.get(record.recordId)
      if (state?.status === 'deleted') continue
      for (const projection of humanResearchTreeProjections(record)) upsertResearchTreeOverlay(database, state ? researchTreeProjectionWithState(projection, state) : projection)
    }
  })
}

function recallPreview(value: string): string {
  const normalized = value.normalize('NFC').replaceAll(/\s+/g, ' ').trim()
  return [...normalized].slice(0, 1000).join('')
}

function normalizeRecallQuery(value: string): string {
  const normalized = value.normalize('NFC').replaceAll(/\s+/g, ' ').trim()
  if (normalized.length === 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research Recall query is empty')
  }
  return normalized
}

function recallFtsQuery(query: string): string {
  const tokens = [...new Set((query.match(RECALL_TOKEN) ?? [])
    .map(token => [...token.toLocaleLowerCase()].slice(0, 64).join(''))
    .filter(Boolean))].slice(0, 32)
  if (tokens.length === 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research Recall query has no searchable terms')
  }
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

function recallCursor(queryHash: string, offset: number): string {
  return `recall:${queryHash.slice(0, 16)}:${offset}`
}

function treeOverlayCursor(queryHash: string, offset: number): string {
  return `overlay:${queryHash.slice(0, 16)}:${offset}`
}

function researchNotebookCursor(queryHash: string, offset: number): string {
  return `notebook:${queryHash.slice(0, 16)}:${offset}`
}

function emptyResearchNotebook(request: ResearchNotebookRequest): ResearchNotebookResult {
  const queryHash = sha256(canonicalJson({ workspaceId: request.workspaceId, investigationId: request.investigationId, scopeVersionId: request.scopeVersionId,
    view: request.view, recordTypes: [...request.recordTypes].sort(), recordStatuses: [...request.recordStatuses].sort(), generation: sha256(canonicalJson([])) }))
  if (parseResearchNotebookCursor(request.cursor, queryHash) !== 0) throw new SourceScopeStoreError('invalid-request', 'Research Notebook cursor is exhausted')
  return { schemaVersion: 1, resultType: 'research-notebook', workspaceId: request.workspaceId, investigationId: request.investigationId,
    scopeVersionId: request.scopeVersionId, view: request.view, queryHash, items: [], pageInfo: { schemaVersion: 1, limit: request.limits.maxItems,
      returned: 0, total: 0, usedChars: 0, truncated: false, completeness: 'candidate' } }
}

function emptyResearchTreeOverlay(request: TreeOverlayRequest): TreeOverlayResult {
  const queryHash = sha256(canonicalJson({ workspaceId: request.workspaceId, investigationId: request.investigationId, scopeVersionId: request.scopeVersionId,
    source: request.source, physicalPage: request.physicalPage, recordTypes: [...request.recordTypes].sort(), generation: sha256(canonicalJson([])) }))
  if (parseTreeOverlayCursor(request.cursor, queryHash) !== 0) throw new SourceScopeStoreError('invalid-request', 'Research Tree Overlay cursor is exhausted')
  return { schemaVersion: 1, resultType: 'tree-overlay', workspaceId: request.workspaceId, investigationId: request.investigationId, scopeVersionId: request.scopeVersionId,
    source: structuredClone(request.source), ...(request.physicalPage === undefined ? {} : { physicalPage: request.physicalPage }), queryHash, items: [],
    pageInfo: { schemaVersion: 1, limit: request.limits.maxItems, returned: 0, total: 0, usedChars: 0, truncated: false, completeness: 'candidate' } }
}

function parseResearchNotebookCursor(cursor: string | undefined, queryHash: string): number {
  if (cursor === undefined) return 0
  const match = /^notebook:([a-f0-9]{16}):(\d+)$/.exec(cursor)
  if (match === null || match[1] !== queryHash.slice(0, 16)) {
    throw new SourceScopeStoreError('invalid-request', 'Research Notebook cursor does not match the query')
  }
  const offset = Number(match[2])
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > MAX_RESEARCH_NOTEBOOK_CURSOR_OFFSET) {
    throw new SourceScopeStoreError('invalid-request', 'Research Notebook cursor offset is invalid')
  }
  return offset
}

function parseTreeOverlayCursor(cursor: string | undefined, queryHash: string): number {
  if (cursor === undefined) return 0
  const match = /^overlay:([a-f0-9]{16}):(\d+)$/.exec(cursor)
  if (match === null || match[1] !== queryHash.slice(0, 16)) {
    throw new SourceScopeStoreError('invalid-request', 'Research Tree Overlay cursor does not match the query')
  }
  const offset = Number(match[2])
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > MAX_TREE_OVERLAY_CURSOR_OFFSET) {
    throw new SourceScopeStoreError('invalid-request', 'Research Tree Overlay cursor offset is invalid')
  }
  return offset
}

function parseRecallCursor(cursor: string | undefined, queryHash: string): number {
  if (cursor === undefined) return 0
  const match = /^recall:([a-f0-9]{16}):(\d+)$/.exec(cursor)
  if (match === null || match[1] !== queryHash.slice(0, 16)) {
    throw new SourceScopeStoreError('invalid-request', 'Research Recall cursor does not match the query')
  }
  const offset = Number(match[2])
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > MAX_RECALL_CURSOR_OFFSET) {
    throw new SourceScopeStoreError('invalid-request', 'Research Recall cursor offset is invalid')
  }
  return offset
}

function researchSourceKey(source: ResearchSourceIdentity): string {
  return [
    source.documentId,
    source.revisionId,
    source.representationId,
    source.representationContentHash,
  ].join('\0')
}

function parseResearchSourceIdentities(value: string): ResearchSourceIdentity[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'Research Recall source identities are invalid')
  }
  if (!Array.isArray(parsed) || parsed.length > 64) {
    throw new SourceScopeStoreError('integrity-error', 'Research Recall source identities are invalid')
  }
  const sources: ResearchSourceIdentity[] = []
  const keys = new Set<string>()
  for (const candidate of parsed) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new SourceScopeStoreError('integrity-error', 'Research Recall source identity is invalid')
    }
    const record = candidate as Record<string, unknown>
    if (Object.keys(record).length !== 4
      || typeof record.documentId !== 'string'
      || typeof record.revisionId !== 'string'
      || typeof record.representationId !== 'string'
      || typeof record.representationContentHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.representationContentHash)) {
      throw new SourceScopeStoreError('integrity-error', 'Research Recall source identity is invalid')
    }
    const source = record as unknown as ResearchSourceIdentity
    const key = researchSourceKey(source)
    if (keys.has(key)) {
      throw new SourceScopeStoreError('integrity-error', 'Research Recall source identity is duplicated')
    }
    keys.add(key)
    sources.push(source)
  }
  return sources
}

function researchRecordTypeColumn(row: Record<string, unknown>): ResearchRecordType {
  const value = stringColumn(row, 'record_type')
  if (![
    'evidence-bookmark',
    'research-note',
    'open-question',
    'claim-proposal',
    'project-decision',
    'research-policy',
  ].includes(value)) {
    throw new SourceScopeStoreError('integrity-error', 'Research Recall record type is invalid')
  }
  return value as ResearchRecordType
}

function activeResearchRecordStatusColumn(
  row: Record<string, unknown>,
): ResearchNotebookItem['recordStatus'] {
  const value = researchRecordStatusColumn(row)
  if (value === 'deleted') {
    throw new SourceScopeStoreError(
      'integrity-error',
      'deleted Research record remained in an active projection',
    )
  }
  return value
}

function researchRecordStatusColumn(row: Record<string, unknown>): ResearchRecordStatus {
  const value = stringColumn(row, 'record_status')
  if (!['active', 'open', 'proposed', 'resolved', 'superseded', 'archived', 'deleted'].includes(value)) {
    throw new SourceScopeStoreError('integrity-error', 'Research Recall record status is invalid')
  }
  return value as ResearchRecordStatus
}

function optionalStringColumn(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new SourceScopeStoreError('integrity-error', `source scope database column ${key} is invalid`)
  }
  return value
}

function parseResearchRecallRequest(value: unknown): ResearchRecallRequest {
  let parsed: ReturnType<typeof parseContract<'research-recall-rpc'>>
  try {
    parsed = parseContract('research-recall-rpc', value)
  } catch {
    throw new SourceScopeStoreError('invalid-request', 'Research Recall request is invalid')
  }
  if (!('requestType' in parsed) || parsed.requestType !== 'research-recall'
    || researchRecallRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research Recall request is invalid')
  }
  return parsed
}

function parseTreeOverlayRequest(value: unknown): TreeOverlayRequest {
  let parsed: ReturnType<typeof parseContract<'tree-overlay-rpc'>>
  try {
    parsed = parseContract('tree-overlay-rpc', value)
  } catch {
    throw new SourceScopeStoreError('invalid-request', 'Research Tree Overlay request is invalid')
  }
  if (!('requestType' in parsed) || parsed.requestType !== 'tree-overlay-get'
    || treeOverlayRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research Tree Overlay request is invalid')
  }
  return parsed
}

function parseResearchRecordRequest(value: unknown): ResearchRecordRequest {
  let parsed: ReturnType<typeof parseContract<'research-record-rpc'>>
  try {
    parsed = parseContract('research-record-rpc', value)
  } catch {
    throw new SourceScopeStoreError('invalid-request', 'Research record request is invalid')
  }
  if (!('requestType' in parsed) || parsed.requestType !== 'research-record'
    || researchRecordRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research record request is invalid')
  }
  return parsed
}

function parseResearchGovernanceRequest(value: unknown): ResearchGovernanceRequest {
  let parsed: ReturnType<typeof parseContract<'research-governance-rpc'>>
  try {
    parsed = parseContract('research-governance-rpc', value)
  } catch {
    throw new SourceScopeStoreError('invalid-request', 'Research Governance request is invalid')
  }
  if (!('requestType' in parsed) || parsed.requestType !== 'research-governance'
    || researchGovernanceRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research Governance request is invalid')
  }
  return parsed
}

function parseResearchGovernanceResult(value: unknown): ResearchGovernanceResult {
  let parsed: ReturnType<typeof parseContract<'research-governance-rpc'>>
  try {
    parsed = parseContract(
      'research-governance-rpc',
      typeof value === 'string' ? JSON.parse(value) : value,
    )
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'stored Research Governance result is invalid')
  }
  if (!('resultType' in parsed) || parsed.resultType !== 'research-governance'
    || researchGovernanceRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored Research Governance result is invalid')
  }
  return parsed
}

function parseResearchGovernanceRecord(value: unknown): ResearchGovernanceRecord {
  const result = parseResearchGovernanceResult({
    schemaVersion: 1,
    resultType: 'research-governance',
    status: 'updated',
    record: typeof value === 'string'
      ? parseJsonWithMessage(value, 'Research Governance record JSON is invalid')
      : value,
  })
  return result.record
}

function parseResearchNotebookRequest(value: unknown): ResearchNotebookRequest {
  let parsed: ReturnType<typeof parseContract<'research-notebook-rpc'>>
  try {
    parsed = parseContract('research-notebook-rpc', value)
  } catch {
    throw new SourceScopeStoreError('invalid-request', 'Research Notebook request is invalid')
  }
  if (!('requestType' in parsed) || parsed.requestType !== 'research-notebook'
    || researchNotebookRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research Notebook request is invalid')
  }
  return parsed
}

function parseResearchRecordResult(value: unknown): ResearchRecordResult {
  let parsed: ReturnType<typeof parseContract<'research-record-rpc'>>
  try {
    parsed = parseContract(
      'research-record-rpc',
      typeof value === 'string' ? JSON.parse(value) : value,
    )
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'stored Research record result is invalid')
  }
  if (!('resultType' in parsed) || parsed.resultType !== 'research-recorded'
    || researchRecordRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored Research record result is invalid')
  }
  return parsed
}

function parseAgentResearchRecord(value: unknown): AgentResearchRecord {
  const result = parseResearchRecordResult({
    schemaVersion: 1,
    resultType: 'research-recorded',
    status: 'created',
    record: typeof value === 'string'
      ? parseJsonWithMessage(value, 'Research record JSON is invalid')
      : value,
  })
  return result.record
}

function parseResearchLifecycleRequest(value: unknown): ResearchLifecycleRequest {
  let parsed: ReturnType<typeof parseContract<'research-lifecycle-rpc'>>
  try {
    parsed = parseContract('research-lifecycle-rpc', value)
  } catch {
    throw new SourceScopeStoreError('invalid-request', 'Research lifecycle request is invalid')
  }
  if (!('requestType' in parsed) || parsed.requestType !== 'research-record-lifecycle'
    || researchLifecycleRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('invalid-request', 'Research lifecycle request is invalid')
  }
  return parsed
}

function parseResearchLifecycleResult(value: unknown): ResearchLifecycleResult {
  let parsed: ReturnType<typeof parseContract<'research-lifecycle-rpc'>>
  try {
    parsed = parseContract(
      'research-lifecycle-rpc',
      typeof value === 'string' ? JSON.parse(value) : value,
    )
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'stored Research lifecycle result is invalid')
  }
  if (!('resultType' in parsed) || parsed.resultType !== 'research-record-lifecycle'
    || researchLifecycleRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored Research lifecycle result is invalid')
  }
  return parsed
}

function parseResearchRecordState(value: unknown): ResearchRecordState {
  const result = parseResearchLifecycleResult({
    schemaVersion: 1,
    resultType: 'research-record-lifecycle',
    status: 'updated',
    state: typeof value === 'string'
      ? parseJsonWithMessage(value, 'Research lifecycle state JSON is invalid')
      : value,
  })
  return result.state
}

function parseJsonWithMessage(value: string, message: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new SourceScopeStoreError('integrity-error', message)
  }
}

function transaction(database: DatabaseSync, operation: () => void): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    operation()
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function readRow(database: DatabaseSync, sql: string, ...params: string[]): Record<string, unknown> | undefined {
  return database.prepare(sql).get(...params) as Record<string, unknown> | undefined
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new SourceScopeStoreError('integrity-error', `source scope database column ${key} is invalid`)
  }
  return value
}

function numberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SourceScopeStoreError('integrity-error', `source scope database column ${key} is invalid`)
  }
  return value
}

function parseSourceScopeCommitRequest(value: unknown): SourceScopeCommitRequest {
  const parsed = parseContract('source-scope-rpc', value)
  if (!('requestType' in parsed) || parsed.requestType !== 'source-scope-commit') {
    throw new SourceScopeStoreError('invalid-request', 'source scope commit request type is required')
  }
  const issues = sourceScopeRpcIssues(parsed)
  if (issues.length > 0) {
    throw new SourceScopeStoreError('invalid-request', issues[0]!.message)
  }
  return parsed
}

function parseSourceScopePatchRequest(value: unknown): SourceScopePatchRequest {
  const parsed = parseContract('source-scope-rpc', value)
  if (!('requestType' in parsed) || parsed.requestType !== 'source-scope-patch') {
    throw new SourceScopeStoreError('invalid-request', 'source scope patch request type is required')
  }
  const issues = sourceScopeRpcIssues(parsed)
  if (issues.length > 0) {
    throw new SourceScopeStoreError('invalid-request', issues[0]!.message)
  }
  return parsed
}

function parseSelectionActionRequest(value: unknown): SelectionActionRequest {
  let parsed: ReturnType<typeof parseContract<'selection-rpc'>>
  try {
    parsed = parseContract('selection-rpc', value)
  } catch {
    throw new SourceScopeStoreError('invalid-request', 'selection action request is invalid')
  }
  if (!('requestType' in parsed) || parsed.requestType !== 'selection-action'
    || selectionRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('invalid-request', 'selection action request is invalid')
  }
  return parsed
}

function parseSelectionActionResult(value: unknown): SelectionActionResult {
  let parsed: ReturnType<typeof parseContract<'selection-rpc'>>
  try {
    parsed = parseContract('selection-rpc', typeof value === 'string' ? JSON.parse(value) : value)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'stored selection action result is invalid')
  }
  if (!('resultType' in parsed) || parsed.resultType !== 'selection-action-recorded'
    || selectionRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored selection action result is invalid')
  }
  return parsed
}

function parseSelectionContext(value: unknown): SelectionContext {
  let parsed: SelectionContext
  try {
    parsed = parseContract(
      'selection-context',
      typeof value === 'string' ? JSON.parse(value) : value,
    )
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'stored selection context is invalid')
  }
  if (selectionContextIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored selection context is invalid')
  }
  return parsed
}

function parseScopeCommitResult(value: string): SourceScopeCommitResult {
  const parsed = parseContract('source-scope-rpc', parseJson(value))
  if (!('resultType' in parsed) || parsed.resultType !== 'source-scope-committed') {
    throw new SourceScopeStoreError('integrity-error', 'stored source scope commit result is invalid')
  }
  return parsed
}

function parseScopePayload(value: string): {
  scope: SourceScopeVersion
  sources: ScopedSourceIdentity[]
} {
  const payload = parseJson(value)
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
    || !Object.hasOwn(payload, 'scope') || !Object.hasOwn(payload, 'sources')) {
    throw new SourceScopeStoreError('integrity-error', 'stored source scope payload is invalid')
  }
  const record = payload as Record<string, unknown>
  const candidate = {
    schemaVersion: 1,
    resultType: 'source-scope-committed',
    sessionId: 'session:scope-payload-check',
    status: 'created',
    scope: record.scope,
    sources: record.sources,
  }
  const parsed = parseContract('source-scope-rpc', candidate)
  if (!('resultType' in parsed) || parsed.resultType !== 'source-scope-committed'
    || sourceScopeRpcIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored source scope payload is invalid')
  }
  return { scope: parsed.scope, sources: parsed.sources }
}

function parseScopeUnbindResult(value: string): SourceScopeUnbindResult {
  const parsed = parseContract('source-scope-rpc', parseJson(value))
  if (!('resultType' in parsed) || parsed.resultType !== 'source-scope-unbound') {
    throw new SourceScopeStoreError('integrity-error', 'stored source scope unbind result is invalid')
  }
  return parsed
}

function parseScopeBindResult(value: string): SourceScopeBindResult {
  const parsed = parseContract('source-scope-rpc', parseJson(value))
  if (!('resultType' in parsed) || parsed.resultType !== 'source-scope-bound') {
    throw new SourceScopeStoreError('integrity-error', 'stored source scope bind result is invalid')
  }
  return parsed
}

function upsertSessionBinding(
  database: DatabaseSync,
  sessionId: string,
  workspaceId: string,
  investigationId: string,
): void {
  database.prepare(`
    INSERT INTO session_bindings (session_id, workspace_id, investigation_id)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      investigation_id = excluded.investigation_id
  `).run(sessionId, workspaceId, investigationId)
}

function appendLibraryEvent(
  database: DatabaseSync,
  workspaceId: string,
  documentId: string,
  aggregateVersion: number,
  idempotencyKey: string,
  eventType: 'library.document-imported' | 'library.source-linked',
  payload: unknown,
  occurredAt: string,
): void {
  const payloadJson = canonicalJson(payload)
  const journalIdempotency = `library:${idempotencyKey}`
  database.prepare(`
    INSERT INTO journal_events (
      event_id, workspace_id, aggregate_id, aggregate_version, actor_json,
      occurred_at, idempotency_key, event_type, payload_version, payload_json, payload_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    `event:${sha256(`${workspaceId}\0${journalIdempotency}`).slice(0, 32)}`,
    workspaceId,
    `library:${documentId}`,
    aggregateVersion,
    canonicalJson({ kind: 'system', actorId: 'system:library-import' }),
    occurredAt,
    journalIdempotency,
    eventType,
    payloadJson,
    sha256(payloadJson),
  )
}

function parseLibraryDocument(value: string): LibraryDocument {
  const parsed = parseContract('library-document', parseJson(value))
  if (libraryDocumentIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored Library document is invalid')
  }
  return parsed
}

function parseSourceRepresentation(value: unknown): SourceRepresentation {
  let parsed: ReturnType<typeof parseContract<'source-representation'>>
  try {
    parsed = parseContract('source-representation', value)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'stored Library representation is invalid')
  }
  if (sourceRepresentationIssues(parsed).length > 0) {
    throw new SourceScopeStoreError('integrity-error', 'stored Library representation is invalid')
  }
  return parsed
}

function selectLibraryRepresentation(
  representations: readonly SourceRepresentation[],
  preferredId?: string,
): SourceRepresentation | undefined {
  const available = representations.filter(representation => representation.status === 'current')
  if (preferredId !== undefined) {
    return available.find(representation => representation.representationId === preferredId)
  }
  return [...available].sort((left, right) =>
    representationPreference(right) - representationPreference(left)
    || left.representationId.localeCompare(right.representationId))[0]
}

function representationPreference(representation: SourceRepresentation): number {
  if (representation.textQuality === 'usable') return 4
  if (representation.mediaType.startsWith('text/')) return 3
  if (representation.kind !== 'original-bytes') return 2
  return 1
}

function parseAnswerManifest(value: string): AnswerManifest {
  const parsed = parseContract('answer-manifest', parseJson(value))
  if (answerManifestIssues(parsed).length > 0
    || parsed.answerTextHash !== answerVisibleTextHash(parsed)) {
    throw new SourceScopeStoreError('integrity-error', 'stored answer manifest is invalid')
  }
  return parsed
}

function answerVisibleTextHash(manifest: AnswerManifest): string {
  return sha256(manifest.blocks.map(block => block.segments.map(segment => segment.text).join(''))
    .join('\n\n'))
}

function isLibraryRecordResult(value: unknown): value is LibraryRecordResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'document,status') return false
  if (!['created', 'updated', 'reused'].includes(String(record.status))) return false
  try {
    parseLibraryDocument(JSON.stringify(record.document))
    return true
  } catch {
    return false
  }
}

function recoverLibraryJobs(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT job_id, state_json FROM library_jobs
  `).all()
  const now = new Date().toISOString()
  for (const row of rows) {
    const parsed = parseContract('library-rpc', parseJson(stringColumn(row, 'state_json')))
    if (!('resultType' in parsed) || parsed.resultType !== 'library-job'
      || libraryRpcIssues(parsed).length > 0) {
      throw new SourceScopeStoreError('integrity-error', 'stored Library job is invalid')
    }
    if (parsed.status !== 'queued' && parsed.status !== 'running') continue
    const failed: LibraryJobResult = {
      ...parsed,
      status: 'failed',
      phase: 'complete',
      error: {
        schemaVersion: 1,
        code: 'unavailable',
        message: 'Library import was interrupted before completion',
        retryable: true,
        nextActions: ['retry'],
      },
      updatedAt: now,
    }
    database.prepare(`
      UPDATE library_jobs SET state_json = ?, updated_at = ? WHERE job_id = ?
    `).run(canonicalJson(failed), now, stringColumn(row, 'job_id'))
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new SourceScopeStoreError('integrity-error', 'stored source scope JSON is invalid')
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
