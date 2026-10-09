export type M4ContractIssueCode =
  | 'claim-version-lineage'
  | 'claim-version-time-order'
  | 'claim-proposition-unit'
  | 'evidence-relation-review'
  | 'evidence-relation-time-order'
  | 'derivation-activity-reference-cycle'
  | 'derivation-activity-time-order'
  | 'derivation-activity-provenance'
  | 'claim-ledger-duplicate-id'
  | 'claim-ledger-reference'
  | 'claim-ledger-identity'
  | 'claim-ledger-basis'
  | 'claim-ledger-status'
  | 'claim-ledger-current-version'
  | 'review-gate-order'
  | 'review-duplicate-id'
  | 'review-issue-reference'
  | 'review-gate-status'
  | 'review-checked-reference'
  | 'review-coverage-mismatch'
  | 'review-decision-mismatch'
  | 'review-subject-shape'
  | 'artifact-version-lineage'
  | 'artifact-duplicate-id'
  | 'artifact-claim-use-range'
  | 'artifact-matrix-reference'
  | 'artifact-matrix-duplicate-cell'
  | 'artifact-publication-shape'
  | 'artifact-claim-reference'
  | 'artifact-claim-state'
  | 'artifact-source-scope'
  | 'artifact-evidence-reference'
  | 'artifact-review-reference'
  | 'artifact-publish-gate'
  | 'artifact-time-order'
  | 'm4-rpc-identity'
  | 'm4-rpc-authority'
  | 'm4-rpc-cas'
  | 'm4-rpc-reference'
  | 'm4-rpc-duplicate-id'
  | 'm4-rpc-assurance-set'
  | 'm4-rpc-ruleset'
  | 'm4-rpc-result'

/**
 * M4 modules use a local issue type until their codes are merged into the
 * shared ContractIssueCode registry. It is structurally identical to the
 * shared ContractIssue contract.
 */
export interface M4ContractIssue {
  code: M4ContractIssueCode
  path: string
  message: string
}

export type AddM4ContractIssue = (
  code: M4ContractIssueCode,
  path: string,
  message: string,
) => void
