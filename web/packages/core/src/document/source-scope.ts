import {
  type ScopedSourceIdentity,
  sourceScopeIssues,
  type SourceScopeVersion,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export class SourceScopeAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceScopeAuthorizationError'
  }
}

export type SourceScopeSessionErrorCode = 'session-not-found' | 'agent-busy' | 'unavailable'

export class SourceScopeSessionError extends Error {
  constructor(readonly code: SourceScopeSessionErrorCode, message: string) {
    super(message)
    this.name = 'SourceScopeSessionError'
  }
}

export interface ActiveDocAtlasSourceScope {
  readonly scope: Readonly<SourceScopeVersion>
  readonly sources: readonly Readonly<ScopedSourceIdentity>[]
}

export class DocAtlasSourceScopeRegistry {
  private readonly bySession = new Map<string, ActiveDocAtlasSourceScope>()

  activate(
    sessionId: string,
    scope: SourceScopeVersion,
    sources: readonly ScopedSourceIdentity[],
  ): ActiveDocAtlasSourceScope {
    if (sessionId.length === 0) throw new Error('source scope session id must not be empty')
    const active = bindDocAtlasSourceScope(scope, sources)
    this.bySession.set(sessionId, active)
    return active
  }

  get(sessionId: string): ActiveDocAtlasSourceScope | undefined {
    return this.bySession.get(sessionId)
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  clearAll(): void {
    this.bySession.clear()
  }
}

export function bindDocAtlasSourceScope(
  scopeCandidate: unknown,
  sourceCandidates: readonly ScopedSourceIdentity[],
): ActiveDocAtlasSourceScope {
  const scope = parseContract('source-scope-version', scopeCandidate)
  const issues = sourceScopeIssues(scope)
  if (issues.length > 0) throw new Error(`invalid DocAtlas source scope: ${issues[0]!.message}`)

  const included = new Set(scope.included.map(sourceKey))
  const sources = new Map<string, ScopedSourceIdentity>()
  for (const source of sourceCandidates) {
    const keys = Object.keys(source).sort()
    if (keys.join(',') !== 'documentId,representationContentHash,representationId,revisionId') {
      throw new Error('DocAtlas source representation mapping contains unknown fields')
    }
    if (!OPAQUE_ID.test(source.documentId)
      || !OPAQUE_ID.test(source.revisionId)
      || !OPAQUE_ID.test(source.representationId)
      || !/^[a-f0-9]{64}$/.test(source.representationContentHash)) {
      throw new Error('DocAtlas source representation mapping contains an invalid opaque id')
    }
    const key = sourceKey(source)
    if (!included.has(key)) {
      throw new Error('DocAtlas source representation mapping is outside the included scope')
    }
    if (sources.has(key)) {
      throw new Error('DocAtlas source scope maps one revision more than once')
    }
    sources.set(key, structuredClone(source))
  }
  if (sources.size !== included.size) {
    throw new Error('every included DocAtlas source revision requires one representation mapping')
  }

  return deepFreeze({
    scope: structuredClone(scope),
    sources: [...sources.values()],
  })
}

function sourceKey(value: { documentId: string, revisionId: string }): string {
  return `${value.documentId}\0${value.revisionId}`
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
