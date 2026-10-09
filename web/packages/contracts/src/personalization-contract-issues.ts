export type PersonalizationContractIssueCode =
  | 'personalization-session-policy-identity'
  | 'personalization-observation-actor'
  | 'personalization-observation-consent'
  | 'personalization-observation-source'
  | 'personalization-observation-scope'
  | 'personalization-candidate-reference'
  | 'personalization-candidate-lineage'
  | 'personalization-candidate-promotion'
  | 'personalization-memory-lineage'
  | 'personalization-memory-duplicate'
  | 'personalization-memory-current-version'
  | 'personalization-memory-time-order'
  | 'personalization-memory-activation'
  | 'personalization-memory-content-safety'
  | 'personalization-memory-scope'
  | 'personalization-memory-effect'
  | 'personalization-decision-reference'
  | 'personalization-decision-why'
  | 'personalization-decision-expiry'
  | 'personalization-decision-fact-trace'
  | 'personalization-use-reference'
  | 'personalization-use-outcome'
  | 'personalization-probe-backbone'
  | 'personalization-probe-variant'
  | 'personalization-probe-budget'
  | 'personalization-choice-scope'
  | 'personalization-command-authority'
  | 'personalization-command-version'
  | 'personalization-command-result'
  | 'personalization-forget-boundary'
  | 'personalization-export-boundary'
  | 'personalization-domain-separation'

/**
 * M6 contracts keep their issue registry local until the shared M0 registry is
 * updated in the integration pass. The shape intentionally matches the common
 * ContractIssue type.
 */
export interface PersonalizationContractIssue {
  code: PersonalizationContractIssueCode
  path: string
  message: string
}

export type AddPersonalizationContractIssue = (
  code: PersonalizationContractIssueCode,
  path: string,
  message: string,
) => void
