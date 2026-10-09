import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import * as addFormatsModule from 'ajv-formats'
import type { FormatsPlugin } from 'ajv-formats'

import { SCHEMA_CATALOG, SCHEMA_DEFINITIONS } from './generated-schema-registry.js'
import type { AssetDescriptor } from './asset-contracts.js'
import type { NativeControlValue } from './native-control-contracts.js'
import type { NativeLineageValue } from './native-lineage-contracts.js'
import type { ProductHistoryValue } from './product-history-contracts.js'
import type { ProductControlValue } from './product-control-contracts.js'
import type { WorkerFrame } from './worker-contracts.js'
import type { ResourceTrustValue } from './resource-trust-contracts.js'
import type { ProductHttpValue } from './product-http-contracts.js'
import type { ProductAnswerValue } from './product-answer-contracts.js'
import type { ProductResearchValue } from './product-research-contracts.js'
import type { HumanResearchValue } from './human-research-contracts.js'
import type { ProductPersonalizationValue } from './product-personalization-contracts.js'
import type { ProductPersonalizationV2Value } from './product-personalization-v2-contracts.js'
import type { ProductReviewValue } from './product-review-contracts.js'
import type { ProductLibraryValue } from './product-library-contracts.js'
import type { ProductContinuityValue } from './product-continuity-contracts.js'
import type { ProductProbeValue } from './product-probe-contracts.js'
import type { ProductLearningValue } from './product-learning-contracts.js'
import type { DocumentHttpValue } from './document-http-contracts.js'
import type { EnrichmentValue } from './enrichment-contracts.js'
import type { RuntimeProgress, ConversationObservationValue } from './observation-contracts.js'
import type { TreeIndexValue } from './tree-index-contracts.js'
import type { SelectionContext, SelectionRpcRequest, SelectionRpcResult } from './selection-contracts.js'
import type { SourceScopeRpcRequest, SourceScopeRpcResult } from './source-scope-rpc.js'
import type { DocAtlasBrowserRpcEnvelope } from './browser-rpc.js'
import type { LibraryDocument, LibraryRpcRequest, LibraryRpcResult } from './library-contracts.js'
import type { ReaderFocusRpcValue } from './reader-focus-contracts.js'
import type { ReaderPageRpcValue } from './reader-page-contracts.js'
import type { ResearchRecallRpcValue } from './research-recall-contracts.js'
import type { ResearchRecordRpcValue } from './research-record-contracts.js'
import type { ResearchLifecycleRpcValue } from './research-lifecycle-contracts.js'
import type { ResearchGovernanceRpcValue } from './research-governance-contracts.js'
import type { ResearchNotebookRpcValue } from './research-notebook-contracts.js'
import type { TreeOverlayRpcValue } from './tree-overlay-contracts.js'
import type { ContinuityRpcValue } from './continuity-contracts.js'
import type { ClaimVersion, EvidenceRelation, DerivationActivity } from './claim-contracts.js'
import type { ReviewResult } from './review-contracts.js'
import type { ArtifactManifest } from './artifact-contracts.js'
import type { M4RpcValue } from './m4-rpc-contracts.js'
import type {
  PersonalizationCommandValue,
  PersonalizationCoreValue,
} from './personalization-contracts.js'
import type { PersonalizationInspectValue } from './personalization-inspect-contracts.js'
import type { AnswerManifest, AnswerRpcValue } from './answer-contracts.js'
import type { SidecarDocumentRpcValue } from './document-rpc.js'
import type {
  DocumentLocator,
  DocumentRevision,
  EvidenceAtom,
  LegacyEvidenceLead,
  PageInfo,
  ProtocolError,
  SourceRepresentation,
  SourceScopeVersion,
} from './m0-contracts.js'
import type { SidecarCapabilitiesResult, SidecarEnvelope } from './sidecar-protocol.js'
import type { DocAtlasToolMetaV1 } from './tool-contracts.js'

import type { QuestionContextValue } from './question-context-contracts.js'
import type { ProductSearchValue } from './product-search-contracts.js'
export interface ContractTypeMap {
  'product-search': ProductSearchValue
  'question-context': QuestionContextValue
  'native-lineage': NativeLineageValue
  'native-control': NativeControlValue
  'product-history': ProductHistoryValue
  'product-research': ProductResearchValue
  'human-research': HumanResearchValue
  'product-personalization': ProductPersonalizationValue
  'product-personalization-v2': ProductPersonalizationV2Value
  'product-review': ProductReviewValue
  'product-library': ProductLibraryValue
  'product-continuity': ProductContinuityValue
  'product-probe': ProductProbeValue
  'product-learning': ProductLearningValue
  'tree-index': TreeIndexValue
  'product-control': ProductControlValue
  'worker-frame': WorkerFrame
  'resource-trust': ResourceTrustValue
  'product-http': ProductHttpValue
  'product-answer': ProductAnswerValue
  'document-http': DocumentHttpValue
  'enrichment': EnrichmentValue
  'runtime-progress': RuntimeProgress
  'conversation-observation': ConversationObservationValue
  'sidecar-envelope': SidecarEnvelope
  'sidecar-capabilities': SidecarCapabilitiesResult
  'sidecar-document-rpc': SidecarDocumentRpcValue
  'protocol-error': ProtocolError
  'page-info': PageInfo
  'document-revision': DocumentRevision
  'source-representation': SourceRepresentation
  'source-scope-version': SourceScopeVersion
  'document-locator': DocumentLocator
  'evidence-atom': EvidenceAtom
  'legacy-evidence-lead': LegacyEvidenceLead
  'docatlas-tool-meta': DocAtlasToolMetaV1
  'asset-descriptor': AssetDescriptor
  'selection-context': SelectionContext
  'selection-rpc': SelectionRpcRequest | SelectionRpcResult
  'source-scope-rpc': SourceScopeRpcRequest | SourceScopeRpcResult
  'browser-rpc': DocAtlasBrowserRpcEnvelope
  'library-document': LibraryDocument
  'library-rpc': LibraryRpcRequest | LibraryRpcResult
  'reader-focus-rpc': ReaderFocusRpcValue
  'reader-page-rpc': ReaderPageRpcValue
  'research-recall-rpc': ResearchRecallRpcValue
  'research-record-rpc': ResearchRecordRpcValue
  'research-lifecycle-rpc': ResearchLifecycleRpcValue
  'research-governance-rpc': ResearchGovernanceRpcValue
  'research-notebook-rpc': ResearchNotebookRpcValue
  'tree-overlay-rpc': TreeOverlayRpcValue
  'continuity-rpc': ContinuityRpcValue
  'claim-version': ClaimVersion
  'evidence-relation': EvidenceRelation
  'derivation-activity': DerivationActivity
  'review-result': ReviewResult
  'artifact-manifest': ArtifactManifest
  'm4-rpc': M4RpcValue
  'personalization-core': PersonalizationCoreValue
  'personalization-command': PersonalizationCommandValue
  'personalization-inspect': PersonalizationInspectValue
  'answer-manifest': AnswerManifest
  'answer-rpc': AnswerRpcValue
}

export type ContractName = keyof ContractTypeMap

export interface ContractShapeIssue {
  instancePath: string
  schemaPath: string
  keyword: string
  message: string
}

export type ContractValidation<K extends ContractName> =
  | { ok: true, value: ContractTypeMap[K] }
  | { ok: false, issues: ContractShapeIssue[] }

const addFormats = addFormatsModule.default as unknown as FormatsPlugin
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)

for (const entry of SCHEMA_CATALOG.schemas) {
  const schema = SCHEMA_DEFINITIONS[entry.name]
  ajv.addSchema(schema as AnySchema, entry.id)
}

const validators = new Map<ContractName, ValidateFunction>()
for (const entry of SCHEMA_CATALOG.schemas) {
  if (entry.name === 'common') continue
  const validator = ajv.getSchema(entry.id)
  if (validator === undefined) throw new Error(`missing generated validator for ${entry.name}`)
  validators.set(entry.name, validator)
}

function shapeIssue(error: ErrorObject): ContractShapeIssue {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'contract validation failed',
  }
}

export function validateContractShape<K extends ContractName>(
  name: K,
  value: unknown,
): ContractValidation<K> {
  const validator = validators.get(name)
  if (validator === undefined) throw new Error(`unknown DocAtlas contract: ${name}`)
  if (validator(value)) return { ok: true, value: value as ContractTypeMap[K] }
  return { ok: false, issues: (validator.errors ?? []).map(shapeIssue) }
}

export class ContractValidationError extends Error {
  readonly contract: ContractName
  readonly issues: readonly ContractShapeIssue[]

  constructor(contract: ContractName, issues: readonly ContractShapeIssue[]) {
    super(`invalid ${contract} contract: ${issues.map(issue => issue.message).join('; ')}`)
    this.name = 'ContractValidationError'
    this.contract = contract
    this.issues = issues
  }
}

export function parseContract<K extends ContractName>(
  name: K,
  value: unknown,
): ContractTypeMap[K] {
  const result = validateContractShape(name, value)
  if (!result.ok) throw new ContractValidationError(name, result.issues)
  return result.value
}

export { SCHEMA_CATALOG, SCHEMA_DEFINITIONS }
