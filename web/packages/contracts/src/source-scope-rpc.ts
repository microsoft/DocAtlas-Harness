import { pageInfoIssues, sourceScopeIssues } from './m0-contracts.js'
import type {
  ContractIssue,
  ContractIssueCode,
  OpaqueId,
  PageInfo,
  Sha256,
  SourceRole,
  SourceScopeVersion,
} from './m0-contracts.js'

export interface ScopedSourceIdentity {
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  representationContentHash: Sha256
}

export interface SourceScopeGetRequest {
  schemaVersion: 1
  requestType: 'source-scope-get'
  sessionId: OpaqueId
}

export interface SourceScopeGetResult {
  schemaVersion: 1
  resultType: 'source-scope'
  sessionId: OpaqueId
  status: 'unbound' | 'active'
  scope?: SourceScopeVersion
  sources?: ScopedSourceIdentity[]
}

export interface SourceScopeCommitRequest {
  schemaVersion: 1
  requestType: 'source-scope-commit'
  sessionId: OpaqueId
  idempotencyKey: OpaqueId
  expectedScopeVersionId?: OpaqueId
  scope: SourceScopeVersion
  sources: ScopedSourceIdentity[]
}

export interface SourceScopeCommitResult {
  schemaVersion: 1
  resultType: 'source-scope-committed'
  sessionId: OpaqueId
  status: 'created' | 'updated' | 'replayed'
  scope: SourceScopeVersion
  sources: ScopedSourceIdentity[]
}

export interface SourceScopeBindRequest {
  schemaVersion: 1
  requestType: 'source-scope-bind'
  sessionId: OpaqueId
  idempotencyKey: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  expectedScopeVersionId: OpaqueId
}

export interface SourceScopeBindResult {
  schemaVersion: 1
  resultType: 'source-scope-bound'
  sessionId: OpaqueId
  status: 'bound' | 'replayed'
  scope: SourceScopeVersion
  sources: ScopedSourceIdentity[]
}

export interface SourceScopeUnbindRequest {
  schemaVersion: 1
  requestType: 'source-scope-unbind'
  sessionId: OpaqueId
  idempotencyKey: OpaqueId
}

export interface SourceScopeUnbindResult {
  schemaVersion: 1
  resultType: 'source-scope-unbound'
  sessionId: OpaqueId
  status: 'unbound' | 'replayed'
}

export type SourceScopeOverviewState = 'eligible' | 'included' | 'used' | 'cited' | 'excluded'

export interface SourceScopeOverviewItem {
  itemId: OpaqueId
  documentId: OpaqueId
  revisionId: OpaqueId
  displayName: string
  mediaType?: 'application/pdf' | 'text/markdown' | 'text/plain'
  sourceRole?: SourceRole
  revisionState: 'current' | 'historical' | 'scope-only'
  libraryStatus?: 'ready' | 'partial' | 'archived'
  states: SourceScopeOverviewState[]
  canInclude: boolean
  source?: Pick<ScopedSourceIdentity, 'representationId' | 'representationContentHash'>
  excludedReason?: SourceScopeVersion['excluded'][number]['reason']
  capabilities: Array<'text' | 'ocr' | 'table' | 'figure' | 'page-image' | 'original'>
}

export interface SourceScopeOverviewCounts {
  eligible: number
  included: number
  used: number
  cited: number
  excluded: number
  candidate: number
  candidateStatus: 'complete' | 'unavailable'
}

export interface SourceScopeOverviewRequest {
  schemaVersion: 1
  requestType: 'source-scope-overview'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  limit: number
  cursor?: OpaqueId
}

export interface SourceScopeOverviewResult {
  schemaVersion: 1
  resultType: 'source-scope-overview'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  scopeStatus: 'unbound' | 'active'
  scope?: SourceScopeVersion
  mutationState: 'ready' | 'agent-busy' | 'unavailable'
  counts: SourceScopeOverviewCounts
  items: SourceScopeOverviewItem[]
  pageInfo: PageInfo
}

export interface SourceScopePatchEntry {
  documentId: OpaqueId
  revisionId: OpaqueId
  role?: SourceRole
}

export interface SourceScopePatchRequest {
  schemaVersion: 1
  requestType: 'source-scope-patch'
  sessionId: OpaqueId
  workspaceId: OpaqueId
  idempotencyKey: OpaqueId
  expectedScopeVersionId?: OpaqueId
  add: SourceScopePatchEntry[]
  remove: SourceScopePatchEntry[]
}

export type SourceScopeRpcRequest =
  | SourceScopeGetRequest
  | SourceScopeCommitRequest
  | SourceScopeBindRequest
  | SourceScopeUnbindRequest
  | SourceScopeOverviewRequest
  | SourceScopePatchRequest

export type SourceScopeRpcResult =
  | SourceScopeGetResult
  | SourceScopeCommitResult
  | SourceScopeBindResult
  | SourceScopeUnbindResult
  | SourceScopeOverviewResult

export function sourceScopeRpcIssues(
  value: SourceScopeRpcRequest | SourceScopeRpcResult,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  const add = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if ('status' in value && value.resultType === 'source-scope') {
    if ((value.status === 'active') !== (value.scope !== undefined && value.sources !== undefined)) {
      add('scope-rpc-active-shape', '/status', 'active scope status must carry scope and sources only')
    }
  }
  if ('scope' in value && value.scope !== undefined && 'sources' in value && value.sources !== undefined) {
    for (const issue of sourceScopeIssues(value.scope)) {
      add(issue.code, `/scope${issue.path === '/' ? '' : issue.path}`, issue.message)
    }
    if (!value.scope.locked) {
      add('scope-rpc-unlocked', '/scope/locked', 'only a locked scope version may become active')
    }
    const revisions = new Set<string>()
    const included = new Set(value.scope.included.map(sourcePair))
    const covered = new Set<string>()
    for (const [index, source] of value.sources.entries()) {
      const pair = sourcePair(source)
      if (revisions.has(pair)) {
        add('scope-rpc-duplicate-source', `/sources/${index}`, 'each scoped revision must choose exactly one representation')
      }
      revisions.add(pair)
      covered.add(pair)
      if (!included.has(pair)) {
        add('scope-rpc-source-outside-included', `/sources/${index}`, 'scoped representation is not included by the scope version')
      }
    }
    for (const [index, source] of value.scope.included.entries()) {
      if (!covered.has(sourcePair(source))) {
        add('scope-rpc-included-without-source', `/scope/included/${index}`, 'every included revision requires a scoped representation')
      }
    }
  }
  if ('requestType' in value && value.requestType === 'source-scope-commit') {
    if ((value.scope.version === 1) === (value.expectedScopeVersionId !== undefined)) {
      add('scope-rpc-cas-shape', '/expectedScopeVersionId', 'version 1 omits expected scope identity; later versions require it')
    }
  }
  if ('requestType' in value && value.requestType === 'source-scope-patch') {
    const added = new Set<string>()
    for (const entry of value.add) {
      const pair = sourcePair(entry)
      if (added.has(pair)) {
        add('scope-patch-conflict', '/add', 'source scope patch cannot add one revision twice')
      }
      added.add(pair)
    }
    const removed = new Set<string>()
    for (const entry of value.remove) {
      const pair = sourcePair(entry)
      if (removed.has(pair) || added.has(pair)) {
        add('scope-patch-conflict', '/remove', 'source scope patch operations must be unique and disjoint')
      }
      if (entry.role !== undefined) {
        add('scope-patch-conflict', '/remove', 'remove operations cannot change a source role')
      }
      removed.add(pair)
    }
  }
  if ('resultType' in value && value.resultType === 'source-scope-overview') {
    if ((value.scopeStatus === 'active') !== (value.scope !== undefined)) {
      add('scope-overview-identity', '/scopeStatus', 'active overview status must carry exactly one scope')
    }
    if (value.scope !== undefined && value.scope.workspaceId !== value.workspaceId) {
      add('scope-overview-identity', '/scope/workspaceId', 'overview scope must belong to the requested workspace')
    }
    if (value.scope !== undefined) {
      for (const issue of sourceScopeIssues(value.scope)) {
        add(issue.code, `/scope${issue.path === '/' ? '' : issue.path}`, issue.message)
      }
      if (!value.scope.locked) {
        add('scope-rpc-unlocked', '/scope/locked', 'overview can expose only a locked active scope')
      }
    }
    for (const issue of pageInfoIssues(value.pageInfo)) {
      add(issue.code, `/pageInfo${issue.path === '/' ? '' : issue.path}`, issue.message)
    }
    if (value.counts.candidateStatus === 'unavailable' && value.counts.candidate !== 0) {
      add('scope-overview-identity', '/counts/candidate', 'unavailable candidate aggregation cannot report an inferred count')
    }
    const itemIds = new Set<string>()
    const sourceIds = new Set<string>()
    for (const [index, item] of value.items.entries()) {
      const key = sourcePair(item)
      if (itemIds.has(item.itemId) || sourceIds.has(key)) {
        add('scope-overview-item', `/items/${index}`, 'overview items require unique ids and document revisions')
      }
      itemIds.add(item.itemId)
      sourceIds.add(key)
      if ((item.canInclude || item.states.some(state => ['included', 'used', 'cited'].includes(state)))
        && item.source === undefined) {
        add('scope-overview-item', `/items/${index}/source`, 'actionable and grounded items require exact representation identity')
      }
      if (item.states.includes('excluded') !== (item.excludedReason !== undefined)) {
        add('scope-overview-item', `/items/${index}/excludedReason`, 'excluded overview items require exactly one reason')
      }
    }
  }
  return issues
}

function sourcePair(source: { documentId: string, revisionId: string }): string {
  return `${source.documentId}\0${source.revisionId}`
}
