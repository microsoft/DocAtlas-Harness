import type { DocumentLocator, OpaqueId } from './m0-contracts.js'

/** Bounded, replayable presentation state persisted on DSH's standard tool/result event. */
export interface DocAtlasToolMetaV1 {
  schemaVersion: 1
  schema: 'docatlas.tool-meta.v1'
  operation: 'search' | 'read'
  scopeVersionId: OpaqueId
  documentIds: OpaqueId[]
  candidateIds?: OpaqueId[]
  assetIds?: OpaqueId[]
  locators?: DocumentLocator[]
  uiSummary: string
  truncated: boolean
  nextCursor?: OpaqueId
}
