import type { ActorRef, IsoTimestamp, OpaqueId, Sha256 } from './m0-contracts.js'
import type { AddM4ContractIssue, M4ContractIssue } from './m4-contract-issues.js'

export const REVIEW_GATE_IDS = [
  'G0-integrity',
  'G1-grounding',
  'G2-scope',
  'G3-conflict',
  'G4-publication',
] as const

export type ReviewGateId = typeof REVIEW_GATE_IDS[number]
export type ReviewGateStatus = 'pass' | 'fail' | 'not-run' | 'not-applicable'

export type ReviewMode =
  | 'answer-coverage'
  | 'claim-challenge'
  | 'document-diff'
  | 'note-hygiene'
  | 'memory-refresh'
  | 'policy-check'
  | 'publish-gate'

export type ReviewIssueCode =
  | 'locator-unresolvable'
  | 'source-revision-mismatch'
  | 'content-hash-mismatch'
  | 'missing-object'
  | 'derivation-unreproducible'
  | 'claim-without-support'
  | 'partial-support-undisclosed'
  | 'citation-does-not-support'
  | 'claim-use-unmapped'
  | 'derived-claim-input-invalid'
  | 'source-outside-scope'
  | 'scope-coverage-incomplete'
  | 'temporal-scope-mismatch'
  | 'jurisdiction-scope-mismatch'
  | 'definition-scope-mismatch'
  | 'source-authority-limited'
  | 'conflict-search-incomplete'
  | 'material-conflict-undisclosed'
  | 'refuting-evidence-unresolved'
  | 'dependent-lineage-double-counted'
  | 'unreviewed-claim'
  | 'rejected-claim'
  | 'stale-claim'
  | 'unresolved-claim'
  | 'policy-violation'
  | 'artifact-claim-use-invalid'

export type ReviewSubjectKind =
  | 'answer-manifest'
  | 'claim-set'
  | 'document-revisions'
  | 'artifact-manifest'

export interface ReviewSubject {
  kind: ReviewSubjectKind
  objectIds: OpaqueId[]
  contentHash?: Sha256
}

export type ReviewIssueSubjectKind =
  | 'source-scope'
  | 'locator'
  | 'evidence'
  | 'evidence-relation'
  | 'claim-version'
  | 'derivation'
  | 'answer-manifest'
  | 'artifact-manifest'
  | 'claim-use'
  | 'policy'

export interface ReviewIssue {
  issueId: OpaqueId
  code: ReviewIssueCode
  gateId: ReviewGateId
  severity: 'blocker' | 'warning'
  message: string
  subjects: Array<{
    kind: ReviewIssueSubjectKind
    objectId: OpaqueId
    path?: string
  }>
  ruleId: OpaqueId
  /** Human resolution and waiver live in a separate ReviewDecision record. */
  status: 'open'
}

export interface ReviewGateResult {
  gateId: ReviewGateId
  status: ReviewGateStatus
  checkedObjectIds: OpaqueId[]
  issueIds: OpaqueId[]
}

export interface ReviewCoverageSummary {
  requiredItems: number
  checkedItems: number
  passedItems: number
  failedItems: number
  notApplicableItems: number
  complete: boolean
}

export interface ReviewResult {
  schemaVersion: 1
  reviewResultId: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  sourceScopeVersionId: OpaqueId
  mode: ReviewMode
  subject: ReviewSubject
  ruleset: {
    name: string
    version: string
    configHash: Sha256
  }
  checkedObjectIds: OpaqueId[]
  gates: [ReviewGateResult, ReviewGateResult, ReviewGateResult, ReviewGateResult, ReviewGateResult]
  issues: ReviewIssue[]
  coverage: ReviewCoverageSummary
  signoffRequirement: 'not-required' | 'required'
  decision: 'pass' | 'fail' | 'needs-human' | 'incomplete'
  reviewer: ActorRef & { kind: 'rule' }
  createdAt: IsoTimestamp
}

const ISSUE_GATE = {
  'locator-unresolvable': 'G0-integrity',
  'source-revision-mismatch': 'G0-integrity',
  'content-hash-mismatch': 'G0-integrity',
  'missing-object': 'G0-integrity',
  'derivation-unreproducible': 'G0-integrity',
  'claim-without-support': 'G1-grounding',
  'partial-support-undisclosed': 'G1-grounding',
  'citation-does-not-support': 'G1-grounding',
  'claim-use-unmapped': 'G1-grounding',
  'derived-claim-input-invalid': 'G1-grounding',
  'source-outside-scope': 'G2-scope',
  'scope-coverage-incomplete': 'G2-scope',
  'temporal-scope-mismatch': 'G2-scope',
  'jurisdiction-scope-mismatch': 'G2-scope',
  'definition-scope-mismatch': 'G2-scope',
  'source-authority-limited': 'G2-scope',
  'conflict-search-incomplete': 'G3-conflict',
  'material-conflict-undisclosed': 'G3-conflict',
  'refuting-evidence-unresolved': 'G3-conflict',
  'dependent-lineage-double-counted': 'G3-conflict',
  'unreviewed-claim': 'G4-publication',
  'rejected-claim': 'G4-publication',
  'stale-claim': 'G4-publication',
  'unresolved-claim': 'G4-publication',
  'policy-violation': 'G4-publication',
  'artifact-claim-use-invalid': 'G4-publication',
} as const satisfies Record<ReviewIssueCode, ReviewGateId>

/**
 * Recompute all semantic invariants of a deterministic review. Agent
 * challenge and human decisions are separate records and cannot alter this
 * result in place.
 */
export function reviewResultIssues(value: ReviewResult): M4ContractIssue[] {
  const { issues, add } = issueCollector()
  const checked = new Set(value.checkedObjectIds)
  const issueById = new Map<OpaqueId, ReviewIssue>()
  const referencedIssues = new Set<OpaqueId>()

  if (new Set(value.checkedObjectIds).size !== value.checkedObjectIds.length) {
    add('review-duplicate-id', '/checkedObjectIds', 'checked object ids must be unique')
  }
  for (const [index, objectId] of value.subject.objectIds.entries()) {
    if (!checked.has(objectId)) {
      add('review-checked-reference', `/subject/objectIds/${index}`, 'every review subject must be included in checkedObjectIds')
    }
  }
  validateSubject(value, add)

  for (const [index, issue] of value.issues.entries()) {
    if (issueById.has(issue.issueId)) {
      add('review-duplicate-id', `/issues/${index}/issueId`, 'review issue ids must be unique')
    }
    issueById.set(issue.issueId, issue)
    if (issue.gateId !== ISSUE_GATE[issue.code]) {
      add('review-issue-reference', `/issues/${index}/gateId`, 'review issue code is assigned to the wrong deterministic gate')
    }
    for (const [subjectIndex, subject] of issue.subjects.entries()) {
      if (!checked.has(subject.objectId)) {
        add('review-checked-reference', `/issues/${index}/subjects/${subjectIndex}/objectId`, 'issue subjects must be included in checkedObjectIds')
      }
    }
  }

  for (const [index, gate] of value.gates.entries()) {
    if (gate.gateId !== REVIEW_GATE_IDS[index]) {
      add('review-gate-order', `/gates/${index}/gateId`, 'review gates must contain G0 through G4 exactly once in order')
    }
    if (new Set(gate.checkedObjectIds).size !== gate.checkedObjectIds.length
      || new Set(gate.issueIds).size !== gate.issueIds.length) {
      add('review-duplicate-id', `/gates/${index}`, 'gate checked-object and issue ids must be unique')
    }
    for (const objectId of gate.checkedObjectIds) {
      if (!checked.has(objectId)) {
        add('review-checked-reference', `/gates/${index}/checkedObjectIds`, 'gate checks cannot escape the result checkedObjectIds set')
      }
    }
    for (const issueId of gate.issueIds) {
      const issue = issueById.get(issueId)
      if (issue === undefined || issue.gateId !== gate.gateId) {
        add('review-issue-reference', `/gates/${index}/issueIds`, 'gate issue ids must resolve to issues owned by the same gate')
      }
      if (referencedIssues.has(issueId)) {
        add('review-duplicate-id', `/gates/${index}/issueIds`, 'each review issue must belong to exactly one gate')
      }
      referencedIssues.add(issueId)
    }
    const blocker = gate.issueIds.some(issueId => issueById.get(issueId)?.severity === 'blocker')
    if (gate.status === 'not-run' || gate.status === 'not-applicable') {
      if (gate.checkedObjectIds.length > 0 || gate.issueIds.length > 0) {
        add('review-gate-status', `/gates/${index}/status`, 'a not-run or not-applicable gate cannot claim checks or issues')
      }
    } else {
      if (gate.checkedObjectIds.length === 0) {
        add('review-gate-status', `/gates/${index}/checkedObjectIds`, 'a completed gate must identify what it checked')
      }
      if ((gate.status === 'fail') !== blocker) {
        add('review-gate-status', `/gates/${index}/status`, 'a gate fails exactly when it contains an open blocker issue')
      }
    }
  }
  for (const [index, issue] of value.issues.entries()) {
    if (!referencedIssues.has(issue.issueId)) {
      add('review-issue-reference', `/issues/${index}/issueId`, 'every issue must be referenced by exactly one gate')
    }
  }

  const coverage = value.coverage
  const summed = coverage.passedItems + coverage.failedItems + coverage.notApplicableItems
  if (coverage.checkedItems !== summed || coverage.checkedItems > coverage.requiredItems
    || coverage.complete !== (coverage.checkedItems === coverage.requiredItems)) {
    add('review-coverage-mismatch', '/coverage', 'coverage counts and complete flag must be derived exactly')
  }

  const hasFailedGate = value.gates.some(gate => gate.status === 'fail')
    || value.issues.some(issue => issue.severity === 'blocker')
  const hasUnrunGate = value.gates.some(gate => gate.status === 'not-run')
  const effectiveCoverageComplete = coverage.checkedItems === coverage.requiredItems
    && coverage.checkedItems === summed
  const expectedDecision = hasFailedGate
    ? 'fail'
    : hasUnrunGate || !effectiveCoverageComplete
      ? 'incomplete'
      : value.signoffRequirement === 'required'
        ? 'needs-human'
        : 'pass'
  if (value.decision !== expectedDecision) {
    add('review-decision-mismatch', '/decision', 'review decision must be derived from gate status, coverage, and sign-off requirement')
  }
  return issues
}

function validateSubject(value: ReviewResult, add: AddM4ContractIssue): void {
  const { mode, subject } = value
  const expected = mode === 'publish-gate'
    ? 'artifact-manifest'
    : mode === 'claim-challenge'
      ? 'claim-set'
      : mode === 'document-diff'
        ? 'document-revisions'
        : mode === 'answer-coverage'
          ? 'answer-manifest'
          : undefined
  if (expected !== undefined && subject.kind !== expected) {
    add('review-subject-shape', '/subject/kind', `${mode} requires a ${expected} subject`)
  }
  if ((subject.kind === 'artifact-manifest' || subject.kind === 'answer-manifest')
    && (subject.objectIds.length !== 1 || subject.contentHash === undefined)) {
    add('review-subject-shape', '/subject', 'manifest review requires exactly one immutable object id and content hash')
  }
  if (subject.kind === 'document-revisions' && subject.objectIds.length !== 2) {
    add('review-subject-shape', '/subject/objectIds', 'document diff requires exactly two revision ids')
  }
}

function issueCollector(): { issues: M4ContractIssue[], add: AddM4ContractIssue } {
  const issues: M4ContractIssue[] = []
  return {
    issues,
    add(code, path, message) {
      issues.push({ code, path, message })
    },
  }
}
