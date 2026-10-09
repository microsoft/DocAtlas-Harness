import type { ActorRef, IsoTimestamp, OpaqueId, Sha256 } from './m0-contracts.js'
import type {
  AddPersonalizationContractIssue,
  PersonalizationContractIssue,
} from './personalization-contract-issues.js'

export interface UserActorRef extends ActorRef {
  kind: 'user'
}

export interface RuleActorRef extends ActorRef {
  kind: 'rule'
}

export type PersonalizationActorRef = UserActorRef | RuleActorRef

export type MemorySessionPolicy = {
  schemaVersion: 1
  recordType: 'memory-session-policy'
  policyId: OpaqueId
  profileId: OpaqueId
  sessionId: OpaqueId
  version: number
  useExisting: boolean
  contributeToFuture: boolean
  updatedBy: UserActorRef
  updatedAt: IsoTimestamp
}

export type PersonalizationScope =
  | { kind: 'global', profileId: OpaqueId }
  | { kind: 'domain', profileId: OpaqueId, domain: string }
  | { kind: 'workspace', profileId: OpaqueId, workspaceId: OpaqueId }
  | {
    kind: 'collection'
    profileId: OpaqueId
    workspaceId: OpaqueId
    collectionId: OpaqueId
  }
  | {
    kind: 'document-revision'
    profileId: OpaqueId
    workspaceId: OpaqueId
    documentId: OpaqueId
    revisionId: OpaqueId
  }
  | {
    kind: 'task-family'
    profileId: OpaqueId
    taskFamily: string
    workspaceId?: OpaqueId
    domain?: string
  }

export interface PersonalizationTaskContext {
  mode: 'explore' | 'verify' | 'publish'
  workspaceId?: OpaqueId
  investigationId?: OpaqueId
  collectionId?: OpaqueId
  documentId?: OpaqueId
  revisionId?: OpaqueId
  documentSetId?: OpaqueId
  taskFamily?: string
  domain?: string
}

export type PersonalizationEffect =
  | { key: 'answer-order', value: 'conclusion-first' | 'evidence-first' }
  | { key: 'explanation-depth', value: 'brief' | 'standard' | 'teaching' }
  | {
    key: 'evidence-presentation'
    value: 'quote' | 'table-context' | 'visual-context'
  }
  | {
    key: 'preferred-representation'
    value: 'pdf' | 'markdown' | 'page-image' | 'table' | 'comparison'
  }
  | {
    key: 'terminology-depth'
    value: 'professional' | 'explain-on-first-use' | 'teaching'
  }
  | { key: 'artifact-format', value: 'brief' | 'matrix' | 'timeline' }
  | { key: 'evidence-density', value: 'compact' | 'context-expanded' }
  | { key: 'comparison-layout', value: 'side-by-side' | 'stacked' }
  | { key: 'challenge-depth', value: 'standard' | 'extra-counterevidence' }

export type PersonalizationMemoryType =
  | 'presentation-preference'
  | 'evidence-preference'
  | 'reader-preference'
  | 'familiarity-estimate'
  | 'workflow-preference'

export type MemorySensitivity = 'ordinary' | 'personal' | 'sensitive'

export interface PersonalizationConsent {
  retention: 'eligible' | 'session-only' | 'ineligible'
  basis: 'user-explicit' | 'session-policy'
}

export type PersonalizationProvenanceRef =
  | {
    kind: 'user-message'
    sessionId: OpaqueId
    seq: number
    contentHash: Sha256
  }
  | {
    kind: 'ui-action'
    sessionId: OpaqueId
    actionId: OpaqueId
    actionType: string
    payloadHash: Sha256
  }
  | {
    kind: 'investigation-record'
    workspaceId: OpaqueId
    investigationId: OpaqueId
    recordId: OpaqueId
    version: number
  }
  | { kind: 'preference-probe', probeId: OpaqueId }
  | { kind: 'memory-use', memoryUseId: OpaqueId }
  | { kind: 'import', importId: OpaqueId, contentHash: Sha256 }

interface PersonalizationObservationBase {
  schemaVersion: 1
  recordType: 'personalization-observation'
  observationId: OpaqueId
  profileId: OpaqueId
  sessionId: OpaqueId
  seq?: number
  occurredAt: IsoTimestamp
  observedActor: PersonalizationActorRef
  sourceRef: PersonalizationProvenanceRef
  lineageKey: OpaqueId
  taskContext: PersonalizationTaskContext
  scope: PersonalizationScope
  consent: PersonalizationConsent
}

export type PersonalizationObservation = PersonalizationObservationBase & (
  | {
    signal: 'explicit-setting'
    detail: { effect: PersonalizationEffect, appliesBeyondTurn: true }
  }
  | {
    signal: 'explicit-language'
    detail: { proposedEffect: PersonalizationEffect, utteranceHash: Sha256 }
  }
  | {
    signal: 'claim-correction'
    detail: {
      claimVersionId: OpaqueId
      correctionKind: 'factual' | 'scope' | 'presentation'
      disposition: 'accepted' | 'rejected' | 'withdrawn'
    }
  }
  | {
    signal: 'evidence-accept' | 'evidence-reject'
    detail: { evidenceId: OpaqueId, claimVersionId?: OpaqueId }
  }
  | {
    signal: 'scope-steer'
    detail: {
      sourceScopeVersionId: OpaqueId
      action: 'include-source' | 'exclude-source' | 'narrow-scope' | 'expand-scope'
      targetId: OpaqueId
    }
  }
  | {
    signal: 'artifact-revision'
    detail: {
      artifactId: OpaqueId
      artifactVersion: number
      revisionKinds: Array<'order' | 'depth' | 'format' | 'terminology' | 'evidence-context'>
    }
  }
  | {
    signal: 'reader-action'
    detail: {
      action: 'switch-representation' | 'expand-context' | 'collapse-context' | 'change-layout'
      representation?: 'pdf' | 'markdown' | 'page-image' | 'table' | 'comparison'
    }
  }
  | {
    signal: 'pairwise-preference-choice'
    detail: {
      probeId: OpaqueId
      choiceObservationId: OpaqueId
      selected: OpaqueId | 'both' | 'neither' | 'dismissed'
    }
  }
  | {
    signal: 'task-outcome'
    detail: {
      memoryUseId: OpaqueId
      status: 'accepted' | 'corrected' | 'dismissed'
      causedMiss: boolean
    }
  }
)

export interface MemoryCandidate {
  schemaVersion: 1
  recordType: 'memory-candidate'
  candidateId: OpaqueId
  profileId: OpaqueId
  version: number
  proposedMemoryType: PersonalizationMemoryType
  proposedEffect: PersonalizationEffect
  proposedScope: PersonalizationScope
  observationIds: OpaqueId[]
  independentLineageCount: number
  counterObservationIds: OpaqueId[]
  formation:
    | 'explicit-setting'
    | 'explicit-language'
    | 'preference-probe'
    | 'inferred-behavior'
    | 'import'
  risk: 'low' | 'medium' | 'high'
  sensitivity: MemorySensitivity
  decision: 'pending' | 'promote' | 'reject' | 'needs-review'
  rationaleCode:
    | 'explicit-user-setting'
    | 'explicit-user-language'
    | 'controlled-probe-choice'
    | 'independent-positive-outcomes'
    | 'counterevidence-present'
    | 'insufficient-lineage'
    | 'sensitive-review-required'
    | 'user-rejected'
  decidedBy?: PersonalizationActorRef
  decidedAt?: IsoTimestamp
  createdAt: IsoTimestamp
}

interface MemoryVersionBase {
  schemaVersion: 1
  recordType: 'memory-version'
  memoryVersionId: OpaqueId
  chainId: OpaqueId
  version: number
  profileId: OpaqueId
  status:
    | 'active'
    | 'paused'
    | 'disputed'
    | 'superseded'
    | 'expired'
    | 'archived'
    | 'deleted'
  previousMemoryVersionId?: OpaqueId
  supersededByMemoryVersionId?: OpaqueId
  transactionTime: { recordedAt: IsoTimestamp, retiredAt?: IsoTimestamp }
}

interface CurrentMemoryVersionContent {
  memoryType: PersonalizationMemoryType
  effect: PersonalizationEffect
  summary: string
  scope: PersonalizationScope
  sensitivity: MemorySensitivity
  observationIds: OpaqueId[]
  candidateId?: OpaqueId
  contentSafety: {
    secretScan: 'passed'
    sensitiveInference: 'none' | 'user-declared'
  }
  retentionConsent: 'eligible'
  validTime: { from?: IsoTimestamp, until?: IsoTimestamp }
  activation: {
    kind: 'explicit-setting' | 'explicit-confirmation' | 'low-risk-rule' | 'import-confirmation'
    actor: PersonalizationActorRef
    activatedAt: IsoTimestamp
  }
  policy: {
    apply: 'silent-ui' | 'disclose' | 'confirm-each-use'
    expiresAfterDays?: number
  }
}

export type MemoryVersion =
  | MemoryVersionBase & CurrentMemoryVersionContent & {
    status: Exclude<MemoryVersionBase['status'], 'deleted'>
  }
  | MemoryVersionBase & { status: 'deleted' }

export interface PersonalizationFactTraceGuard {
  sourceScopeVersionId: OpaqueId
  baselineDigest: Sha256
  evidenceSupportInvariant: true
  contradictionDisclosureInvariant: true
  publicationGateInvariant: true
  sourceScopeInvariant: true
}

export interface PersonalizationDecision {
  schemaVersion: 1
  recordType: 'personalization-decision'
  decisionId: OpaqueId
  profileId: OpaqueId
  memoryVersionIds: OpaqueId[]
  appliesTo: PersonalizationTaskContext & { sessionId: OpaqueId, turn: number }
  effects: PersonalizationEffect[]
  why: Array<{
    memoryVersionId: OpaqueId
    reason:
      | 'explicit-setting'
      | 'stable-profile'
      | 'scope-match'
      | 'task-match'
      | 'recent-confirmation'
      | 'validated-outcome'
  }>
  factTraceGuard: PersonalizationFactTraceGuard
  expiresAfterTurn: number
  createdAt: IsoTimestamp
}

export interface MemoryUseOutcome {
  status: 'accepted' | 'corrected' | 'dismissed' | 'unknown'
  observedAt: IsoTimestamp
  savedSteps?: number
  timeToEvidenceMs?: number
  causedMiss?: boolean
  feedbackObservationId?: OpaqueId
}

export interface MemoryUse {
  schemaVersion: 1
  recordType: 'memory-use'
  memoryUseId: OpaqueId
  decisionId: OpaqueId
  memoryVersionId: OpaqueId
  profileId: OpaqueId
  sessionId: OpaqueId
  turn: number
  effect: PersonalizationEffect
  affectedActions: Array<
    | 'reader-render'
    | 'answer-render'
    | 'evidence-context-render'
    | 'artifact-render'
    | 'reading-plan'
    | 'source-ranking'
    | 'challenge-depth'
  >
  usedAt: IsoTimestamp
  outcome?: MemoryUseOutcome
}

export type PreferenceProbeAxis =
  | 'answer-order'
  | 'explanation-depth'
  | 'preferred-representation'
  | 'evidence-density'
  | 'terminology-depth'
  | 'comparison-layout'

export interface PreferenceProbe {
  schemaVersion: 1
  recordType: 'preference-probe'
  probeId: OpaqueId
  profileId: OpaqueId
  sessionId: OpaqueId
  turn: number
  taskContext: PersonalizationTaskContext
  axis: PreferenceProbeAxis
  trigger:
    | 'user-requested'
    | 'low-confidence'
    | 'preference-drift'
    | 'expired-preference'
    | 'repeated-steering'
  investigationId?: OpaqueId
  automaticOrdinal?: 1
  backbone: {
    sourceScopeVersionId: OpaqueId
    claimVersionIds: OpaqueId[]
    evidenceAtomIds: OpaqueId[]
    uncertaintyIds: OpaqueId[]
    conflictIds: OpaqueId[]
    factTraceDigest: Sha256
  }
  variants: Array<{
    variantKey: OpaqueId
    effect: PersonalizationEffect
    artifactId: OpaqueId
    factTraceDigest: Sha256
    invariantCheck: 'passed'
  }>
  presentationOrder: OpaqueId[]
  generatedAt: IsoTimestamp
}

export interface PreferenceChoiceObservation {
  schemaVersion: 1
  recordType: 'preference-choice-observation'
  choiceObservationId: OpaqueId
  probeId: OpaqueId
  profileId: OpaqueId
  sessionId: OpaqueId
  turn: number
  selected: OpaqueId | 'both' | 'neither' | 'dismissed'
  scopeIntent: 'turn' | 'workspace' | 'task-family' | 'global'
  reasonTags?: Array<'faster-understanding' | 'easier-verification' | 'better-deliverable' | 'less-cognitive-load'>
  consent: PersonalizationConsent
  occurredAt: IsoTimestamp
}

export type PersonalizationCoreValue =
  | MemorySessionPolicy
  | PersonalizationObservation
  | MemoryCandidate
  | MemoryVersion
  | PersonalizationDecision
  | MemoryUse
  | PreferenceProbe
  | PreferenceChoiceObservation

export interface PersonalizationValidationContext {
  profileId?: OpaqueId
  sessionPolicies?: readonly MemorySessionPolicy[]
  observations?: readonly PersonalizationObservation[]
  choices?: readonly PreferenceChoiceObservation[]
  candidates?: readonly MemoryCandidate[]
  memories?: readonly MemoryVersion[]
  decisions?: readonly PersonalizationDecision[]
  probes?: readonly PreferenceProbe[]
  priorAutomaticProbeInvestigationIds?: ReadonlySet<OpaqueId>
}

interface PersonalizationCommandBase {
  schemaVersion: 1
  requestType: 'personalization-command'
  profileId: OpaqueId
  sessionId: OpaqueId
  idempotencyKey: OpaqueId
  actor: UserActorRef
}

export interface EditableMemoryDraft {
  memoryType: PersonalizationMemoryType
  effect: PersonalizationEffect
  summary: string
  scope: PersonalizationScope
  sensitivity: MemorySensitivity
  policy: {
    apply: 'silent-ui' | 'disclose' | 'confirm-each-use'
    expiresAfterDays?: number
  }
}

export type PersonalizationCommandRequest = PersonalizationCommandBase & (
  | {
    action: 'set-session-policy'
    expectedVersion: number
    policy: { useExisting: boolean, contributeToFuture: boolean }
  }
  | { action: 'set-preference', preference: EditableMemoryDraft }
  | {
    action: 'review-candidate'
    candidateId: OpaqueId
    expectedVersion: number
    decision: 'accept' | 'reject'
    replacement?: EditableMemoryDraft
  }
  | {
    action: 'pause'
    memoryVersionId: OpaqueId
    expectedVersion: number
    until?: IsoTimestamp
  }
  | { action: 'resume', memoryVersionId: OpaqueId, expectedVersion: number }
  | {
    action: 'edit'
    memoryVersionId: OpaqueId
    expectedVersion: number
    replacement: EditableMemoryDraft
    statusAfterEdit: 'active' | 'paused'
  }
  | {
    action: 'forget'
    target: 'memory-chain' | 'profile'
    memoryVersionId?: OpaqueId
    expectedVersion?: number
    expectedProfileRevision?: number
    mode: 'memory-only' | 'privacy-erasure'
    provenanceHandling: 'orphan' | 'redact-derived-excerpts'
    acknowledgeExternalRetention: true
  }
  | {
    action: 'export'
    format: 'json' | 'markdown'
    includeProvenanceRefs: boolean
    includeStatuses: Array<'active' | 'paused' | 'disputed' | 'superseded' | 'expired' | 'archived'>
  }
)

export interface ForgetReceipt {
  receiptId: OpaqueId
  target: 'memory-chain' | 'profile'
  targetId: OpaqueId
  mode: 'memory-only' | 'privacy-erasure'
  activeProjectionRemoved: true
  sessionLogChanged: false
  providerCopiesChanged: false
  provenanceHandling: 'orphan' | 'redact-derived-excerpts'
  backupDisposition: 'not-applicable' | 'scheduled-compaction' | 'compacted'
  completedAt?: IsoTimestamp
}

export interface PersonalizationExportDescriptor {
  exportId: OpaqueId
  assetId: OpaqueId
  bundleSchemaVersion: 1
  format: 'json' | 'markdown'
  contentHash: Sha256
  byteLength: number
  createdAt: IsoTimestamp
  expiresAt: IsoTimestamp
  provenance: 'references-only' | 'omitted'
  includedStatuses: Array<'active' | 'paused' | 'disputed' | 'superseded' | 'expired' | 'archived'>
}

interface PersonalizationCommandResultBase {
  schemaVersion: 1
  resultType: 'personalization-command'
  profileId: OpaqueId
  action: PersonalizationCommandRequest['action']
}

export type PersonalizationCommandResult = PersonalizationCommandResultBase & (
  | {
    action: 'set-session-policy'
    status: 'applied' | 'replayed'
    sessionPolicy: MemorySessionPolicy
  }
  | {
    action: 'set-preference'
    status: 'created' | 'replayed'
    memoryVersion: MemoryVersion
  }
  | {
    action: 'review-candidate'
    status: 'updated' | 'replayed'
    candidate: MemoryCandidate
    memoryVersion?: MemoryVersion
  }
  | {
    action: 'pause' | 'resume' | 'edit'
    status: 'updated' | 'replayed'
    memoryVersion: MemoryVersion
  }
  | {
    action: 'forget'
    status: 'accepted' | 'completed' | 'replayed'
    receipt: ForgetReceipt
  }
  | {
    action: 'export'
    status: 'created' | 'replayed'
    export: PersonalizationExportDescriptor
  }
)

export type PersonalizationCommandValue = PersonalizationCommandRequest | PersonalizationCommandResult

export function personalizationCoreIssues(
  value: PersonalizationCoreValue,
  context: PersonalizationValidationContext = {},
): PersonalizationContractIssue[] {
  const { issues, add } = issueCollector()
  if (context.profileId !== undefined && value.profileId !== context.profileId) {
    add(
      value.recordType === 'memory-session-policy'
        ? 'personalization-session-policy-identity'
        : 'personalization-memory-scope',
      '/profileId',
      'personalization value must belong to the authenticated profile',
    )
  }
  if (containsForbiddenDomainPayload(value)) {
    add(
      'personalization-domain-separation',
      '',
      'personalization cannot contain document text, Locators, EvidenceRelations, or Review truth',
    )
  }
  switch (value.recordType) {
    case 'memory-session-policy':
      validateSessionPolicy(value, add)
      break
    case 'personalization-observation':
      validateObservation(value, context, add)
      break
    case 'memory-candidate':
      validateCandidate(value, context, add)
      break
    case 'memory-version':
      validateMemoryVersion(value, context, add)
      break
    case 'personalization-decision':
      validateDecision(value, context, add)
      break
    case 'memory-use':
      validateMemoryUse(value, context, add)
      break
    case 'preference-probe':
      validatePreferenceProbe(value, context, add)
      break
    case 'preference-choice-observation':
      validatePreferenceChoice(value, context, add)
      break
  }
  return issues
}

export function personalizationCommandIssues(
  value: PersonalizationCommandValue,
  request?: PersonalizationCommandRequest,
): PersonalizationContractIssue[] {
  const { issues, add } = issueCollector()
  if ('requestType' in value) {
    if (value.actor.kind !== 'user') {
      add(
        'personalization-command-authority',
        '/actor/kind',
        'personalization mutation and export commands require direct user authority',
      )
    }
    validateCommandRequest(value, add)
    return issues
  }
  if (request === undefined) return issues
  if (value.profileId !== request.profileId || value.action !== request.action) {
    add(
      'personalization-command-result',
      '',
      'command result must match the exact authenticated profile and action',
    )
    return issues
  }
  validateCommandResult(value, request, add)
  return issues
}

export function memoryVersionSetIssues(
  values: readonly MemoryVersion[],
): PersonalizationContractIssue[] {
  const { issues, add } = issueCollector()
  const byId = new Map<OpaqueId, MemoryVersion>()
  const byChain = new Map<OpaqueId, MemoryVersion[]>()
  for (const [index, value] of values.entries()) {
    if (byId.has(value.memoryVersionId)) {
      add(
        'personalization-memory-duplicate',
        `/${index}/memoryVersionId`,
        'memory version IDs must be unique in a profile ledger',
      )
    }
    byId.set(value.memoryVersionId, value)
    const chain = byChain.get(value.chainId) ?? []
    chain.push(value)
    byChain.set(value.chainId, chain)
  }
  for (const [chainId, chain] of byChain) {
    const current = chain.filter(item => (
      item.status === 'active' || item.status === 'paused' || item.status === 'disputed'
    ))
    if (current.length > 1) {
      add(
        'personalization-memory-current-version',
        `/chains/${chainId}`,
        'a memory chain can have at most one current active, paused, or disputed version',
      )
    }
    const versions = chain.map(item => item.version)
    if (new Set(versions).size !== versions.length) {
      add(
        'personalization-memory-duplicate',
        `/chains/${chainId}`,
        'a memory chain cannot repeat a version number',
      )
    }
    for (const value of chain) {
      if (value.previousMemoryVersionId === undefined) continue
      const predecessor = byId.get(value.previousMemoryVersionId)
      if (
        predecessor === undefined
        || predecessor.chainId !== value.chainId
        || predecessor.profileId !== value.profileId
        || predecessor.version !== value.version - 1
        || predecessor.status !== 'superseded'
        || predecessor.supersededByMemoryVersionId !== value.memoryVersionId
      ) {
        add(
          'personalization-memory-lineage',
          `/memoryVersions/${value.memoryVersionId}/previousMemoryVersionId`,
          'predecessor must be the immediately prior superseded version in the same profile chain',
        )
      }
    }
  }
  return issues
}

function validateSessionPolicy(
  value: MemorySessionPolicy,
  add: AddPersonalizationContractIssue,
): void {
  if (value.updatedBy.kind !== 'user') {
    add(
      'personalization-session-policy-identity',
      '/updatedBy/kind',
      'session use/contribution controls require direct user authority',
    )
  }
}

function validateObservation(
  value: PersonalizationObservation,
  context: PersonalizationValidationContext,
  add: AddPersonalizationContractIssue,
): void {
  if (value.scope.profileId !== value.profileId) {
    add(
      'personalization-observation-scope',
      '/scope/profileId',
      'observation scope must match its profile',
    )
  }
  if (
    (value.sourceRef.kind === 'user-message' || value.sourceRef.kind === 'ui-action')
    && value.sourceRef.sessionId !== value.sessionId
  ) {
    add(
      'personalization-observation-source',
      '/sourceRef/sessionId',
      'message and UI provenance must come from the exact observation Session',
    )
  }
  if (
    value.sourceRef.kind === 'user-message'
    && value.seq !== undefined
    && value.sourceRef.seq !== value.seq
  ) {
    add(
      'personalization-observation-source',
      '/sourceRef/seq',
      'message provenance sequence must match the observation sequence',
    )
  }
  if (value.sourceRef.kind === 'investigation-record' && (
    value.sourceRef.workspaceId !== value.taskContext.workspaceId
    || value.sourceRef.investigationId !== value.taskContext.investigationId
  )) {
    add(
      'personalization-observation-source',
      '/sourceRef',
      'Investigation provenance must match the observation task context',
    )
  }
  const userSignals = new Set<PersonalizationObservation['signal']>([
    'explicit-setting',
    'explicit-language',
    'claim-correction',
    'evidence-accept',
    'evidence-reject',
    'scope-steer',
    'artifact-revision',
    'reader-action',
    'pairwise-preference-choice',
  ])
  if (userSignals.has(value.signal) && value.observedActor.kind !== 'user') {
    add(
      'personalization-observation-actor',
      '/observedActor/kind',
      'user preference signals cannot be authored by the Agent or a rule',
    )
  }
  if (
    (value.signal === 'explicit-setting' || value.signal === 'explicit-language')
    && value.sourceRef.kind !== 'user-message'
    && value.sourceRef.kind !== 'ui-action'
  ) {
    add(
      'personalization-observation-source',
      '/sourceRef/kind',
      'an explicit preference requires an exact user message or UI action reference',
    )
  }
  if (value.signal === 'pairwise-preference-choice') {
    if (value.sourceRef.kind !== 'preference-probe' || value.sourceRef.probeId !== value.detail.probeId) {
      add(
        'personalization-observation-source',
        '/sourceRef',
        'a pairwise choice must reference the exact probe that produced it',
      )
    }
    const choice = context.choices?.find(item => item.choiceObservationId === value.detail.choiceObservationId)
    if (choice !== undefined && (
      choice.probeId !== value.detail.probeId
      || choice.selected !== value.detail.selected
      || choice.profileId !== value.profileId
    )) {
      add(
        'personalization-observation-source',
        '/detail/choiceObservationId',
        'pairwise observation must match its governed PreferenceChoiceObservation',
      )
    }
  }
  if (
    value.signal === 'task-outcome'
    && (value.sourceRef.kind !== 'memory-use' || value.sourceRef.memoryUseId !== value.detail.memoryUseId)
  ) {
    add(
      'personalization-observation-source',
      '/sourceRef',
      'task outcome must reference the exact MemoryUse it evaluates',
    )
  }
  if (value.signal === 'explicit-setting' && value.consent.retention !== 'eligible') {
    add(
      'personalization-observation-consent',
      '/consent/retention',
      'an explicit setting that applies beyond the turn requires future-retention consent',
    )
  }
  if (
    value.consent.retention === 'eligible'
    && value.consent.basis === 'session-policy'
    && context.sessionPolicies !== undefined
  ) {
    const policy = context.sessionPolicies.find(item => (
      item.profileId === value.profileId && item.sessionId === value.sessionId
    ))
    if (policy?.contributeToFuture !== true) {
      add(
        'personalization-observation-consent',
        '/consent',
        'session-policy consent is eligible only while contribution to future memory is enabled',
      )
    }
  }
}

function validateCandidate(
  value: MemoryCandidate,
  context: PersonalizationValidationContext,
  add: AddPersonalizationContractIssue,
): void {
  if (value.proposedScope.profileId !== value.profileId) {
    add(
      'personalization-memory-scope',
      '/proposedScope/profileId',
      'candidate scope must match its profile',
    )
  }
  if (!effectAllowedForMemoryType(value.proposedMemoryType, value.proposedEffect)) {
    add(
      'personalization-memory-effect',
      '/proposedEffect/key',
      'candidate effect is not valid for the proposed memory type',
    )
  }
  if (value.decision === 'promote' && value.decidedBy?.kind !== 'user') {
    add(
      'personalization-candidate-promotion',
      '/decidedBy',
      'v1 candidate promotion requires an explicit user decision',
    )
  }
  if (
    value.sensitivity === 'sensitive'
    && value.formation === 'inferred-behavior'
    && value.decision !== 'needs-review'
    && value.decision !== 'reject'
  ) {
    add(
      'personalization-candidate-promotion',
      '/decision',
      'an implicitly inferred sensitive candidate can only be rejected or held for review',
    )
  }
  const observations = new Map(context.observations?.map(item => [item.observationId, item]))
  if (context.observations !== undefined) {
    const referenced = value.observationIds.map(id => observations.get(id))
    if (referenced.some(item => item === undefined)) {
      add(
        'personalization-candidate-reference',
        '/observationIds',
        'candidate observations must resolve in the same profile ledger',
      )
    } else {
      const resolved = referenced as PersonalizationObservation[]
      if (resolved.some(item => item.profileId !== value.profileId || item.consent.retention !== 'eligible')) {
        add(
          'personalization-observation-consent',
          '/observationIds',
          'only eligible observations from the same profile may contribute to future memory',
        )
      }
      const lineageCount = new Set(resolved.map(item => item.lineageKey)).size
      if (lineageCount !== value.independentLineageCount) {
        add(
          'personalization-candidate-lineage',
          '/independentLineageCount',
          'candidate lineage count must equal its distinct referenced lineages',
        )
      }
    }
    if (value.counterObservationIds.some(id => observations.get(id) === undefined)) {
      add(
        'personalization-candidate-reference',
        '/counterObservationIds',
        'counter observations must resolve in the same profile ledger',
      )
    }
  }
  if (value.counterObservationIds.some(id => value.observationIds.includes(id))) {
    add(
      'personalization-candidate-reference',
      '/counterObservationIds',
      'supporting and counter observations must be distinct',
    )
  }
  if (
    value.formation === 'inferred-behavior'
    && value.decision === 'promote'
    && (value.independentLineageCount < 2 || value.counterObservationIds.length > 0)
  ) {
    add(
      'personalization-candidate-promotion',
      '/decision',
      'inferred behavior cannot promote without independent lineage and resolved counterevidence',
    )
  }
}

function validateMemoryVersion(
  value: MemoryVersion,
  context: PersonalizationValidationContext,
  add: AddPersonalizationContractIssue,
): void {
  if (value.version === 1 && value.previousMemoryVersionId !== undefined) {
    add(
      'personalization-memory-lineage',
      '/previousMemoryVersionId',
      'memory version 1 cannot have a predecessor',
    )
  }
  if (value.version > 1 && value.previousMemoryVersionId === undefined) {
    add(
      'personalization-memory-lineage',
      '/previousMemoryVersionId',
      'later memory versions require an exact predecessor',
    )
  }
  if (
    value.previousMemoryVersionId === value.memoryVersionId
    || value.supersededByMemoryVersionId === value.memoryVersionId
  ) {
    add(
      'personalization-memory-lineage',
      '/memoryVersionId',
      'a memory version cannot precede or supersede itself',
    )
  }
  const recordedAt = Date.parse(value.transactionTime.recordedAt)
  const retiredAt = value.transactionTime.retiredAt === undefined
    ? undefined
    : Date.parse(value.transactionTime.retiredAt)
  if (retiredAt !== undefined && retiredAt < recordedAt) {
    add(
      'personalization-memory-time-order',
      '/transactionTime/retiredAt',
      'memory retirement cannot precede recording',
    )
  }
  if (value.status === 'deleted') return
  if (value.scope.profileId !== value.profileId) {
    add(
      'personalization-memory-scope',
      '/scope/profileId',
      'memory scope must match its profile',
    )
  }
  if (!effectAllowedForMemoryType(value.memoryType, value.effect)) {
    add(
      'personalization-memory-effect',
      '/effect/key',
      'memory effect is not valid for its memory type',
    )
  }
  if (
    value.validTime.from !== undefined
    && value.validTime.until !== undefined
    && Date.parse(value.validTime.until) < Date.parse(value.validTime.from)
  ) {
    add(
      'personalization-memory-time-order',
      '/validTime/until',
      'memory valid-time end cannot precede its start',
    )
  }
  if (Date.parse(value.activation.activatedAt) > recordedAt) {
    add(
      'personalization-memory-time-order',
      '/activation/activatedAt',
      'memory activation cannot occur after the version is recorded',
    )
  }
  if (value.contentSafety.secretScan !== 'passed') {
    add(
      'personalization-memory-content-safety',
      '/contentSafety/secretScan',
      'memory content must pass the Host secret scanner before persistence',
    )
  }
  if (value.policy.apply === 'silent-ui' && !lowRiskRuleEffect(value.effect)) {
    add(
      'personalization-memory-activation',
      '/policy/apply',
      'only low-risk renderer preferences may apply without disclosure',
    )
  }
  if (value.sensitivity === 'sensitive' && value.policy.apply !== 'confirm-each-use') {
    add(
      'personalization-memory-activation',
      '/policy/apply',
      'sensitive memory requires confirmation for every use',
    )
  }
  if (
    value.sensitivity === 'sensitive'
    && (
      value.contentSafety.sensitiveInference !== 'user-declared'
      || value.activation.kind !== 'explicit-confirmation'
      || value.activation.actor.kind !== 'user'
    )
  ) {
    add(
      'personalization-memory-activation',
      '/activation',
      'sensitive memory requires user declaration and explicit confirmation',
    )
  }
  if (
    value.activation.kind === 'low-risk-rule'
    && (
      value.activation.actor.kind !== 'rule'
      || value.sensitivity !== 'ordinary'
      || !lowRiskRuleEffect(value.effect)
    )
  ) {
    add(
      'personalization-memory-activation',
      '/activation',
      'rule activation is limited to ordinary, low-risk renderer preferences',
    )
  }
  if (value.activation.kind !== 'low-risk-rule' && value.activation.actor.kind !== 'user') {
    add(
      'personalization-memory-activation',
      '/activation/actor/kind',
      'non-rule activation requires direct user authority',
    )
  }
  const observations = new Map(context.observations?.map(item => [item.observationId, item]))
  if (context.observations !== undefined) {
    const invalidObservation = value.observationIds.some(id => {
      const observation = observations.get(id)
      return observation === undefined
        || observation.profileId !== value.profileId
        || observation.consent.retention !== 'eligible'
    })
    if (invalidObservation) {
      add(
        'personalization-observation-consent',
        '/observationIds',
        'active memory may use only eligible observations from the same profile',
      )
    }
  }
  if (value.candidateId !== undefined && context.candidates !== undefined) {
    const candidate = context.candidates.find(item => item.candidateId === value.candidateId)
    if (
      candidate === undefined
      || candidate.profileId !== value.profileId
      || candidate.decision !== 'promote'
      || candidate.proposedMemoryType !== value.memoryType
      || candidate.sensitivity !== value.sensitivity
      || !effectsEqual(candidate.proposedEffect, value.effect)
      || !scopesEqual(candidate.proposedScope, value.scope)
    ) {
      add(
        'personalization-candidate-reference',
        '/candidateId',
        'memory must match an explicitly promoted candidate in the same profile',
      )
    }
  }
}

function validateDecision(
  value: PersonalizationDecision,
  context: PersonalizationValidationContext,
  add: AddPersonalizationContractIssue,
): void {
  if (value.expiresAfterTurn < value.appliesTo.turn) {
    add(
      'personalization-decision-expiry',
      '/expiresAfterTurn',
      'a personalization decision cannot expire before its target turn',
    )
  }
  const whyIds = value.why.map(item => item.memoryVersionId)
  if (
    new Set(whyIds).size !== whyIds.length
    || whyIds.length !== value.memoryVersionIds.length
    || value.memoryVersionIds.some(id => !whyIds.includes(id))
  ) {
    add(
      'personalization-decision-why',
      '/why',
      'why-used must explain every and only referenced memory version exactly once',
    )
  }
  const effectKeys = value.effects.map(effect => effect.key)
  if (new Set(effectKeys).size !== effectKeys.length) {
    add(
      'personalization-memory-effect',
      '/effects',
      'a decision cannot apply conflicting values for the same effect key',
    )
  }
  const guard = value.factTraceGuard
  if (
    guard.evidenceSupportInvariant !== true
    || guard.contradictionDisclosureInvariant !== true
    || guard.publicationGateInvariant !== true
    || guard.sourceScopeInvariant !== true
  ) {
    add(
      'personalization-decision-fact-trace',
      '/factTraceGuard',
      'personalization on/off must preserve source scope and every factual verification gate',
    )
  }
  if (context.memories !== undefined) {
    const memories = new Map(context.memories.map(item => [item.memoryVersionId, item]))
    for (const id of value.memoryVersionIds) {
      const memory = memories.get(id)
      const why = value.why.find(item => item.memoryVersionId === id)
      if (
        memory === undefined
        || memory.status !== 'active'
        || memory.profileId !== value.profileId
        || !scopeApplies(memory.scope, value.appliesTo)
        || !value.effects.some(effect => effectsEqual(effect, memory.effect))
      ) {
        add(
          'personalization-decision-reference',
          '/memoryVersionIds',
          'decision memories must be active, scope-admitted, same-profile, and effect-matched',
        )
        break
      }
      if (memory.sensitivity === 'sensitive' && why?.reason !== 'recent-confirmation') {
        add(
          'personalization-decision-reference',
          '/why',
          'sensitive memory requires an explicit confirmation bound to this decision',
        )
        break
      }
    }
  }
}

function validateMemoryUse(
  value: MemoryUse,
  context: PersonalizationValidationContext,
  add: AddPersonalizationContractIssue,
): void {
  if (context.decisions !== undefined) {
    const decision = context.decisions.find(item => item.decisionId === value.decisionId)
    if (
      decision === undefined
      || decision.profileId !== value.profileId
      || decision.appliesTo.sessionId !== value.sessionId
      || decision.appliesTo.turn !== value.turn
      || !decision.memoryVersionIds.includes(value.memoryVersionId)
      || !decision.effects.some(effect => effectsEqual(effect, value.effect))
    ) {
      add(
        'personalization-use-reference',
        '/decisionId',
        'MemoryUse must match the exact decision, memory, turn, profile, and effect',
      )
    }
  }
  if (context.memories !== undefined) {
    const memory = context.memories.find(item => item.memoryVersionId === value.memoryVersionId)
    if (
      memory === undefined
      || memory.status === 'deleted'
      || memory.profileId !== value.profileId
      || !effectsEqual(memory.effect, value.effect)
    ) {
      add(
        'personalization-use-reference',
        '/memoryVersionId',
        'MemoryUse must resolve to the same non-deleted memory effect',
      )
    }
  }
  const outcome = value.outcome
  if (outcome === undefined) return
  if (
    (outcome.status === 'corrected' || outcome.status === 'dismissed')
    && outcome.feedbackObservationId === undefined
  ) {
    add(
      'personalization-use-outcome',
      '/outcome/feedbackObservationId',
      'corrected or dismissed use requires a feedback observation',
    )
  }
  if (outcome.status === 'unknown' && (
    outcome.savedSteps !== undefined
    || outcome.timeToEvidenceMs !== undefined
    || outcome.causedMiss !== undefined
    || outcome.feedbackObservationId !== undefined
  )) {
    add(
      'personalization-use-outcome',
      '/outcome',
      'unknown outcome cannot claim measured utility or feedback',
    )
  }
  if (outcome.status === 'accepted' && outcome.causedMiss === true) {
    add(
      'personalization-use-outcome',
      '/outcome/causedMiss',
      'a use that caused a miss cannot be classified as accepted',
    )
  }
}

function validatePreferenceProbe(
  value: PreferenceProbe,
  context: PersonalizationValidationContext,
  add: AddPersonalizationContractIssue,
): void {
  const variantKeys = value.variants.map(variant => variant.variantKey)
  if (
    new Set(variantKeys).size !== 2
    || value.presentationOrder.length !== 2
    || new Set(value.presentationOrder).size !== 2
    || variantKeys.some(key => !value.presentationOrder.includes(key))
  ) {
    add(
      'personalization-probe-variant',
      '/presentationOrder',
      'presentation order must be a permutation of exactly two stable variant keys',
    )
  }
  if (
    value.variants.some(variant => (
      variant.effect.key !== value.axis
      || variant.factTraceDigest !== value.backbone.factTraceDigest
      || variant.invariantCheck !== 'passed'
    ))
  ) {
    add(
      'personalization-probe-backbone',
      '/variants',
      'probe variants may change only the declared axis over one invariant Fact Trace backbone',
    )
  }
  if (value.variants.length === 2 && effectsEqual(value.variants[0]!.effect, value.variants[1]!.effect)) {
    add(
      'personalization-probe-variant',
      '/variants',
      'the two controlled variants must use different values on the same axis',
    )
  }
  if (value.trigger !== 'user-requested') {
    if (value.investigationId === undefined || value.automaticOrdinal !== 1) {
      add(
        'personalization-probe-budget',
        '/automaticOrdinal',
        'an automatic probe must bind investigation identity and the sole automatic ordinal',
      )
    }
    if (
      value.investigationId !== undefined
      && context.priorAutomaticProbeInvestigationIds?.has(value.investigationId) === true
    ) {
      add(
        'personalization-probe-budget',
        '/investigationId',
        'v1 permits at most one automatic preference probe per investigation',
      )
    }
  }
}

function validatePreferenceChoice(
  value: PreferenceChoiceObservation,
  context: PersonalizationValidationContext,
  add: AddPersonalizationContractIssue,
): void {
  const probe = context.probes?.find(item => item.probeId === value.probeId)
  if (probe !== undefined) {
    const isReservedChoice = ['both', 'neither', 'dismissed'].includes(value.selected)
    if (
      probe.profileId !== value.profileId
      || probe.sessionId !== value.sessionId
      || probe.turn !== value.turn
      || (!isReservedChoice && !probe.variants.some(variant => variant.variantKey === value.selected))
    ) {
      add(
        'personalization-probe-variant',
        '/selected',
        'preference choice must select a real variant from the exact profile/session/turn probe',
      )
    }
    if (value.scopeIntent === 'task-family' && probe.taskContext.taskFamily === undefined) {
      add(
        'personalization-choice-scope',
        '/scopeIntent',
        'task-family scope requires a task-family-bound probe',
      )
    }
    if (value.scopeIntent === 'workspace' && probe.taskContext.workspaceId === undefined) {
      add(
        'personalization-choice-scope',
        '/scopeIntent',
        'workspace scope requires a workspace-bound probe',
      )
    }
  }
  if (['both', 'neither', 'dismissed'].includes(value.selected) && value.scopeIntent !== 'turn') {
    add(
      'personalization-choice-scope',
      '/scopeIntent',
      'both, neither, and dismissed cannot create a durable broader preference',
    )
  }
}

function validateCommandRequest(
  value: PersonalizationCommandRequest,
  add: AddPersonalizationContractIssue,
): void {
  if (value.action === 'set-preference' && value.preference.scope.profileId !== value.profileId) {
    add(
      'personalization-memory-scope',
      '/preference/scope/profileId',
      'explicit preference scope must match the authenticated profile',
    )
  }
  if (
    value.action === 'set-preference'
    && !effectAllowedForMemoryType(value.preference.memoryType, value.preference.effect)
  ) {
    add(
      'personalization-memory-effect',
      '/preference/effect',
      'explicit preference effect is not valid for its memory type',
    )
  }
  if (
    value.action === 'set-preference'
    && value.preference.sensitivity === 'sensitive'
    && value.preference.policy.apply !== 'confirm-each-use'
  ) {
    add(
      'personalization-memory-activation',
      '/preference/policy/apply',
      'sensitive preference requires confirmation for every use',
    )
  }
  if (value.action === 'edit' && value.replacement.scope.profileId !== value.profileId) {
    add(
      'personalization-memory-scope',
      '/replacement/scope/profileId',
      'edited preference scope must match the authenticated profile',
    )
  }
  if (value.action === 'edit' && (
    !effectAllowedForMemoryType(value.replacement.memoryType, value.replacement.effect)
    || (value.replacement.sensitivity === 'sensitive'
      && value.replacement.policy.apply !== 'confirm-each-use')
  )) {
    add(
      value.replacement.sensitivity === 'sensitive'
        ? 'personalization-memory-activation'
        : 'personalization-memory-effect',
      '/replacement',
      'edited preference must preserve its typed effect and sensitivity use gate',
    )
  }
  if (value.action === 'review-candidate' && value.replacement?.scope.profileId !== undefined
    && value.replacement.scope.profileId !== value.profileId) {
    add(
      'personalization-memory-scope',
      '/replacement/scope/profileId',
      'candidate replacement scope must match the authenticated profile',
    )
  }
  if (value.action === 'review-candidate' && value.replacement !== undefined && (
    !effectAllowedForMemoryType(value.replacement.memoryType, value.replacement.effect)
    || (value.replacement.sensitivity === 'sensitive'
      && value.replacement.policy.apply !== 'confirm-each-use')
  )) {
    add(
      value.replacement.sensitivity === 'sensitive'
        ? 'personalization-memory-activation'
        : 'personalization-memory-effect',
      '/replacement',
      'candidate replacement must preserve its typed effect and sensitivity use gate',
    )
  }
  if (value.action === 'forget') {
    const chainShape = value.target === 'memory-chain'
      && value.memoryVersionId !== undefined
      && value.expectedVersion !== undefined
    const profileShape = value.target === 'profile'
      && value.memoryVersionId === undefined
      && value.expectedVersion === undefined
      && value.expectedProfileRevision !== undefined
    const chainRevisionShape = value.target === 'memory-chain'
      && value.expectedProfileRevision === undefined
    if ((!chainShape || !chainRevisionShape) && !profileShape) {
      add(
        'personalization-command-version',
        '/target',
        'memory-chain forget requires CAS identity; profile forget must not pretend to use one version',
      )
    }
  }
}

function validateCommandResult(
  value: PersonalizationCommandResult,
  request: PersonalizationCommandRequest,
  add: AddPersonalizationContractIssue,
): void {
  if (value.action === 'set-session-policy' && request.action === 'set-session-policy') {
    if (
      value.sessionPolicy.profileId !== request.profileId
      || value.sessionPolicy.sessionId !== request.sessionId
      || value.sessionPolicy.version !== request.expectedVersion + 1
      || value.sessionPolicy.useExisting !== request.policy.useExisting
      || value.sessionPolicy.contributeToFuture !== request.policy.contributeToFuture
    ) {
      add(
        'personalization-command-result',
        '/sessionPolicy',
        'session policy result must match the requested profile, session, and independent controls',
      )
    }
    return
  }
  if (value.action === 'set-preference' && request.action === 'set-preference') {
    const memory = value.memoryVersion
    if (
      memory.status === 'deleted'
      || memory.version !== 1
      || memory.status !== 'active'
      || memory.profileId !== request.profileId
      || memory.memoryType !== request.preference.memoryType
      || !effectsEqual(memory.effect, request.preference.effect)
      || !scopesEqual(memory.scope, request.preference.scope)
      || memory.summary !== request.preference.summary
      || memory.sensitivity !== request.preference.sensitivity
      || !policiesEqual(memory.policy, request.preference.policy)
      || memory.activation.kind !== (
        request.preference.sensitivity === 'sensitive'
          ? 'explicit-confirmation'
          : 'explicit-setting'
      )
      || memory.activation.actor.kind !== 'user'
    ) {
      add(
        'personalization-command-result',
        '/memoryVersion',
        'set-preference must create matching active version 1 under user authority',
      )
    }
    return
  }
  if (value.action === 'review-candidate' && request.action === 'review-candidate') {
    if (
      value.candidate.candidateId !== request.candidateId
      || value.candidate.version !== request.expectedVersion + 1
      || value.candidate.decision !== (request.decision === 'accept' ? 'promote' : 'reject')
    ) {
      add(
        'personalization-command-version',
        '/candidate',
        'candidate review must advance the exact candidate once with the requested decision',
      )
    }
    if ((request.decision === 'accept') !== (value.memoryVersion !== undefined)) {
      add(
        'personalization-command-result',
        '/memoryVersion',
        'accepted review creates a memory version; rejected review cannot create one',
      )
    }
    if (request.decision === 'accept' && value.memoryVersion !== undefined) {
      const memory = value.memoryVersion
      const expected = request.replacement
      const candidateMatches = memory.status !== 'deleted'
        && memory.candidateId === value.candidate.candidateId
        && memory.profileId === request.profileId
        && memory.version === 1
        && memory.status === 'active'
        && memory.activation.kind === 'explicit-confirmation'
        && memory.activation.actor.kind === 'user'
        && memory.memoryType === (expected?.memoryType ?? value.candidate.proposedMemoryType)
        && effectsEqual(memory.effect, expected?.effect ?? value.candidate.proposedEffect)
        && scopesEqual(memory.scope, expected?.scope ?? value.candidate.proposedScope)
        && memory.sensitivity === (expected?.sensitivity ?? value.candidate.sensitivity)
      if (!candidateMatches) {
        add(
          'personalization-command-result',
          '/memoryVersion',
          'accepted candidate must create matching active version 1 under explicit user confirmation',
        )
      }
    }
    return
  }
  if (
    (value.action === 'pause' || value.action === 'resume' || value.action === 'edit')
    && (request.action === 'pause' || request.action === 'resume' || request.action === 'edit')
  ) {
    const memory = value.memoryVersion
    const expectedStatus = request.action === 'pause'
      ? 'paused'
      : request.action === 'resume'
        ? 'active'
        : request.statusAfterEdit
    if (
      memory.memoryVersionId === request.memoryVersionId
      || memory.previousMemoryVersionId !== request.memoryVersionId
      || memory.version !== request.expectedVersion + 1
      || memory.profileId !== request.profileId
      || memory.status !== expectedStatus
    ) {
      add(
        'personalization-command-version',
        '/memoryVersion',
        'memory mutation must create the next immutable version with the requested state',
      )
    }
    if (request.action === 'edit' && memory.status !== 'deleted' && (
      memory.memoryType !== request.replacement.memoryType
      || !effectsEqual(memory.effect, request.replacement.effect)
      || memory.summary !== request.replacement.summary
      || !scopesEqual(memory.scope, request.replacement.scope)
      || memory.sensitivity !== request.replacement.sensitivity
      || !policiesEqual(memory.policy, request.replacement.policy)
    )) {
      add(
        'personalization-command-result',
        '/memoryVersion',
        'edit result must contain the exact user-authorized replacement',
      )
    }
    return
  }
  if (value.action === 'forget' && request.action === 'forget') {
    if (
      value.receipt.target !== request.target
      || value.receipt.targetId !== (
        request.target === 'profile' ? request.profileId : request.memoryVersionId
      )
      || value.receipt.mode !== request.mode
      || value.receipt.provenanceHandling !== request.provenanceHandling
      || value.receipt.activeProjectionRemoved !== true
      || value.receipt.sessionLogChanged !== false
      || value.receipt.providerCopiesChanged !== false
    ) {
      add(
        'personalization-forget-boundary',
        '/receipt',
        'forget receipt must disclose the exact deletion target and external retention boundary',
      )
    }
    if (value.status === 'completed' && value.receipt.completedAt === undefined) {
      add(
        'personalization-forget-boundary',
        '/receipt/completedAt',
        'a completed forget result requires a completion timestamp',
      )
    }
    if (value.status === 'accepted' && value.receipt.completedAt !== undefined) {
      add(
        'personalization-forget-boundary',
        '/receipt/completedAt',
        'an accepted asynchronous erasure cannot claim completion',
      )
    }
    if (
      request.mode === 'privacy-erasure'
      && value.receipt.backupDisposition === 'not-applicable'
    ) {
      add(
        'personalization-forget-boundary',
        '/receipt/backupDisposition',
        'privacy erasure must schedule or complete WAL/backup compaction',
      )
    }
    return
  }
  if (value.action === 'export' && request.action === 'export') {
    if (
      value.export.format !== request.format
      || value.export.bundleSchemaVersion !== 1
      || value.export.provenance !== (request.includeProvenanceRefs ? 'references-only' : 'omitted')
      || !sameStringSet(value.export.includedStatuses, request.includeStatuses)
    ) {
      add(
        'personalization-export-boundary',
        '/export',
        'export descriptor must match the requested format and reference-only provenance policy',
      )
    }
    if (Date.parse(value.export.expiresAt) <= Date.parse(value.export.createdAt)) {
      add(
        'personalization-export-boundary',
        '/export/expiresAt',
        'authenticated export asset must expire after it is created',
      )
    }
  }
}

function effectAllowedForMemoryType(
  memoryType: PersonalizationMemoryType,
  effect: PersonalizationEffect,
): boolean {
  const allowed: Record<PersonalizationMemoryType, ReadonlySet<PersonalizationEffect['key']>> = {
    'presentation-preference': new Set([
      'answer-order',
      'explanation-depth',
      'terminology-depth',
      'artifact-format',
      'comparison-layout',
    ]),
    'evidence-preference': new Set([
      'evidence-presentation',
      'evidence-density',
      'challenge-depth',
    ]),
    'reader-preference': new Set(['preferred-representation']),
    'familiarity-estimate': new Set(['terminology-depth']),
    'workflow-preference': new Set(['challenge-depth']),
  }
  return allowed[memoryType].has(effect.key)
}

function lowRiskRuleEffect(effect: PersonalizationEffect): boolean {
  return new Set<PersonalizationEffect['key']>([
    'answer-order',
    'explanation-depth',
    'preferred-representation',
    'terminology-depth',
    'artifact-format',
    'comparison-layout',
  ]).has(effect.key)
}

function scopeApplies(
  scope: PersonalizationScope,
  context: PersonalizationTaskContext,
): boolean {
  switch (scope.kind) {
    case 'global':
      return true
    case 'domain':
      return scope.domain === context.domain
    case 'workspace':
      return scope.workspaceId === context.workspaceId
    case 'collection':
      return scope.workspaceId === context.workspaceId && scope.collectionId === context.collectionId
    case 'document-revision':
      return scope.workspaceId === context.workspaceId
        && scope.documentId === context.documentId
        && scope.revisionId === context.revisionId
    case 'task-family':
      return scope.taskFamily === context.taskFamily
        && (scope.workspaceId === undefined || scope.workspaceId === context.workspaceId)
        && (scope.domain === undefined || scope.domain === context.domain)
  }
}

function effectsEqual(left: PersonalizationEffect, right: PersonalizationEffect): boolean {
  return left.key === right.key && left.value === right.value
}

function scopesEqual(left: PersonalizationScope, right: PersonalizationScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function policiesEqual(left: EditableMemoryDraft['policy'], right: EditableMemoryDraft['policy']): boolean {
  return left.apply === right.apply && left.expiresAfterDays === right.expiresAfterDays
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

const FORBIDDEN_PERSONALIZATION_KEYS = new Set([
  'documentText',
  'sourceText',
  'quote',
  'locator',
  'evidenceAtom',
  'evidenceAtoms',
  'evidenceRelation',
  'claimSupport',
  'reviewResult',
])

function containsForbiddenDomainPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(item => containsForbiddenDomainPayload(item))
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_PERSONALIZATION_KEYS.has(key) || containsForbiddenDomainPayload(child)
  ))
}

function issueCollector(): {
  issues: PersonalizationContractIssue[]
  add: AddPersonalizationContractIssue
} {
  const issues: PersonalizationContractIssue[] = []
  return {
    issues,
    add: (code, path, message) => issues.push({ code, path, message }),
  }
}
