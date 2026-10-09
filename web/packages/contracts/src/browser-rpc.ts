import type { ProtocolError } from './m0-contracts.js'
import type { SelectionRpcResult } from './selection-contracts.js'
import type { SourceScopeRpcResult } from './source-scope-rpc.js'
import type { LibraryRpcResult } from './library-contracts.js'
import type { ReaderFocusResolveResult } from './reader-focus-contracts.js'
import type { ReaderPageResult } from './reader-page-contracts.js'
import type { AnswerGetResult } from './answer-contracts.js'
import type { ResearchLifecycleResult } from './research-lifecycle-contracts.js'
import type { ResearchGovernanceResult } from './research-governance-contracts.js'
import type { ResearchNotebookResult } from './research-notebook-contracts.js'
import type { TreeOverlayResult } from './tree-overlay-contracts.js'
import type { M4RpcRequest, M4RpcResult } from './m4-rpc-contracts.js'
import type {
  ContinuityAssessRequest,
  ContinuityAssessResult,
  RevisionImpactRequest,
  RevisionImpactResult,
} from './continuity-contracts.js'
import type {
  PersonalizationCommandRequest,
  PersonalizationCommandResult,
} from './personalization-contracts.js'
import type {
  PersonalizationInspectRequest,
  PersonalizationInspectResult,
} from './personalization-inspect-contracts.js'
import type { LibraryRpcRequest } from './library-contracts.js'
import type { ReaderFocusResolveRequest } from './reader-focus-contracts.js'
import type { ReaderPageRequest } from './reader-page-contracts.js'
import type { AnswerGetRequest } from './answer-contracts.js'
import type { ResearchLifecycleRequest } from './research-lifecycle-contracts.js'
import type { ResearchGovernanceRequest } from './research-governance-contracts.js'
import type { ResearchNotebookRequest } from './research-notebook-contracts.js'
import type { TreeOverlayRequest } from './tree-overlay-contracts.js'
import type { SelectionRpcRequest } from './selection-contracts.js'
import type { SourceScopeRpcRequest } from './source-scope-rpc.js'

/** Requests accepted by the authenticated DSH Connection browser channel. */
export type DocAtlasBrowserRpcRequest =
  | LibraryRpcRequest
  | AnswerGetRequest
  | ReaderFocusResolveRequest
  | ReaderPageRequest
  | ResearchLifecycleRequest
  | ResearchGovernanceRequest
  | ResearchNotebookRequest
  | TreeOverlayRequest
  | SelectionRpcRequest
  | SourceScopeRpcRequest
  | M4RpcRequest
  | ContinuityAssessRequest
  | RevisionImpactRequest
  | PersonalizationCommandRequest
  | PersonalizationInspectRequest

export type DocAtlasBrowserRpcResult =
  | LibraryRpcResult
  | AnswerGetResult
  | ReaderFocusResolveResult
  | ReaderPageResult
  | ResearchLifecycleResult
  | ResearchGovernanceResult
  | ResearchNotebookResult
  | TreeOverlayResult
  | SelectionRpcResult
  | SourceScopeRpcResult
  | M4RpcResult
  | ContinuityAssessResult
  | RevisionImpactResult
  | PersonalizationCommandResult
  | PersonalizationInspectResult

export type DocAtlasBrowserRpcEnvelope =
  | { schemaVersion: 1, ok: true, result: DocAtlasBrowserRpcResult }
  | { schemaVersion: 1, ok: false, error: ProtocolError }
