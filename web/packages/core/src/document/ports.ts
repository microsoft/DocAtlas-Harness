import type { LibraryCandidate, LibraryDiscoverRequest, LibraryDiscoverResult, ScopedSourceIdentity, SidecarMethodMap } from '@docatlas/contracts'

/** Supplied by authenticated application composition, never by model/browser parameters. */
export interface LibraryRuntimePort {
  assertBrowserSession(sessionId: string, workspaceId: string, mutation: boolean): void
  registerEligibleSources(workspaceId: string, sources: readonly ScopedSourceIdentity[]): void
  call<K extends keyof SidecarMethodMap>(method: K, params: SidecarMethodMap[K]['params'], signal?: AbortSignal): Promise<SidecarMethodMap[K]['result']>
}
export interface MaterializedLibraryCandidate {
  candidateId: string
  rootId: string
  relativePath: string
  displayName: string
  mediaType: LibraryCandidate['mediaType']
  byteLength: number
  contentHash: string
}
export interface LibraryDiscoveryPort {
  discover(request: LibraryDiscoverRequest, now?: number, signal?: AbortSignal): Promise<LibraryDiscoverResult>
  materialize(candidateId: string, sessionId: string, workspaceId: string, now?: number): Promise<MaterializedLibraryCandidate>
}
export class LibraryDiscoveryError extends Error {
  constructor(readonly code: 'invalid-request' | 'not-found' | 'stale' | 'limit-exceeded', message: string) {
    super(message); this.name = 'LibraryDiscoveryError'
  }
}
export class SidecarSupervisorError extends Error {}
export class SidecarRpcError extends SidecarSupervisorError {
  constructor(message: string, readonly rpcCode: number, readonly data: unknown) {
    super(message); this.name = 'SidecarRpcError'
  }
}
