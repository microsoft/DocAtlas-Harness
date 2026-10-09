import type { ActorRef, IsoTimestamp, OpaqueId, Sha256 } from './m0-contracts.js'
import type { ClaimVersion, EvidenceRelation } from './claim-contracts.js'
import type { AddM4ContractIssue, M4ContractIssue } from './m4-contract-issues.js'
import type { ReviewResult } from './review-contracts.js'
import { reviewResultIssues } from './review-contracts.js'

export type ArtifactKind = 'brief' | 'matrix'
export type ArtifactStatus = 'draft' | 'published' | 'superseded' | 'withdrawn'
export type ClaimUseKind =
  | 'assertion'
  | 'assumption'
  | 'decision'
  | 'external-knowledge'
  | 'conflict-disclosure'

export interface ClaimUse {
  claimUseId: OpaqueId
  claimVersionId: OpaqueId
  useKind: ClaimUseKind
  span: {
    start: number
    end: number
    unit: 'unicode-scalar'
  }
  citationEvidenceIds: OpaqueId[]
}

export interface ArtifactSection {
  sectionId: OpaqueId
  heading: string
  markdown: string
  claimUses: ClaimUse[]
}

export interface BriefArtifactContent {
  kind: 'brief'
  sections: ArtifactSection[]
}

export interface MatrixArtifactRow {
  rowId: OpaqueId
  label: string
  source?: {
    documentId: OpaqueId
    revisionId: OpaqueId
  }
}

export interface MatrixArtifactColumn {
  columnId: OpaqueId
  label: string
  question?: string
}

export interface MatrixArtifactCell {
  cellId: OpaqueId
  rowId: OpaqueId
  columnId: OpaqueId
  markdown: string
  claimUses: ClaimUse[]
}

export interface MatrixArtifactContent {
  kind: 'matrix'
  rows: MatrixArtifactRow[]
  columns: MatrixArtifactColumn[]
  cells: MatrixArtifactCell[]
}

export interface ArtifactPublication {
  reviewResultId: OpaqueId
  deterministicDecision: 'pass' | 'needs-human'
  humanReviewDecisionId?: OpaqueId
  publishedBy: ActorRef & { kind: 'user' | 'system' }
  publishedAt: IsoTimestamp
}

interface ArtifactManifestBase {
  schemaVersion: 1
  artifactManifestId: OpaqueId
  artifactId: OpaqueId
  version: number
  previousArtifactManifestId?: OpaqueId
  workspaceId: OpaqueId
  investigationId: OpaqueId
  sourceScopeVersionId: OpaqueId
  title: string
  contentHash: Sha256
  personalizationUseIds: OpaqueId[]
  createdBy: ActorRef
  createdAt: IsoTimestamp
}

type ArtifactLifecycle =
  | {
    status: 'draft'
    publication?: never
  }
  | {
    status: 'published' | 'superseded' | 'withdrawn'
    publication: ArtifactPublication
  }

export type ArtifactManifest = ArtifactManifestBase & ArtifactLifecycle & (
  | { kind: 'brief', content: BriefArtifactContent }
  | { kind: 'matrix', content: MatrixArtifactContent }
)

export interface ArtifactValidationContext {
  /** When supplied, every ClaimUse must resolve within this complete set. */
  claims?: readonly ClaimVersion[]
  /** When supplied, visible Evidence must resolve through this complete relation set. */
  evidenceRelations?: readonly EvidenceRelation[]
  /** Required to validate a non-draft publication decision. */
  reviewResult?: ReviewResult
}

/** Validate internal layout plus optional Claim Ledger and Review bindings. */
export function artifactManifestIssues(
  value: ArtifactManifest,
  context: ArtifactValidationContext = {},
): M4ContractIssue[] {
  const { issues, add } = issueCollector()
  if (value.version === 1 && value.previousArtifactManifestId !== undefined) {
    add('artifact-version-lineage', '/previousArtifactManifestId', 'the first artifact version cannot name a predecessor')
  }
  if (value.version > 1 && value.previousArtifactManifestId === undefined) {
    add('artifact-version-lineage', '/previousArtifactManifestId', 'later artifact versions must pin their immutable predecessor')
  }
  if (value.previousArtifactManifestId === value.artifactManifestId) {
    add('artifact-version-lineage', '/previousArtifactManifestId', 'an artifact manifest cannot precede itself')
  }
  if (value.kind !== value.content.kind) {
    add('artifact-publication-shape', '/content/kind', 'artifact kind and content kind must agree')
  }
  if (value.status === 'draft') {
    if (value.publication !== undefined) {
      add('artifact-publication-shape', '/publication', 'a draft cannot claim publication')
    }
  } else if (value.publication === undefined) {
    add('artifact-publication-shape', '/publication', 'published history must retain its review and publisher binding')
  } else {
    if ((value.publication.deterministicDecision === 'needs-human')
      !== (value.publication.humanReviewDecisionId !== undefined)) {
      add('artifact-publication-shape', '/publication/humanReviewDecisionId', 'needs-human publication requires a human decision, while deterministic pass must not invent one')
    }
    if (Date.parse(value.publication.publishedAt) < Date.parse(value.createdAt)) {
      add('artifact-time-order', '/publication/publishedAt', 'publication cannot precede manifest creation')
    }
  }

  const claimUseIds = new Set<OpaqueId>()
  const units = artifactUnits(value, add)
  for (const unit of units) {
    for (const [index, claimUse] of unit.claimUses.entries()) {
      const prefix = `${unit.path}/claimUses/${index}`
      if (claimUseIds.has(claimUse.claimUseId)) {
        add('artifact-duplicate-id', `${prefix}/claimUseId`, 'ClaimUse ids must be unique across the entire manifest')
      }
      claimUseIds.add(claimUse.claimUseId)
      const scalars = [...unit.markdown]
      if (claimUse.span.start >= claimUse.span.end || claimUse.span.end > scalars.length) {
        add('artifact-claim-use-range', `${prefix}/span`, 'ClaimUse must select a non-empty Unicode-scalar range inside its content unit')
      } else if (scalars.slice(claimUse.span.start, claimUse.span.end).join('').trim().length === 0) {
        add('artifact-claim-use-range', `${prefix}/span`, 'ClaimUse cannot map only whitespace')
      }
      const factualUse = claimUse.useKind === 'assertion' || claimUse.useKind === 'conflict-disclosure'
      if (factualUse !== (claimUse.citationEvidenceIds.length > 0)) {
        add('artifact-evidence-reference', `${prefix}/citationEvidenceIds`, 'assertions and conflict disclosures require visible Evidence; assumptions, decisions, and external knowledge cannot cite document Evidence as their basis')
      }
    }
  }

  validateClaimBindings(value, units, context, add)
  validateReviewBinding(value, context.reviewResult, add)
  return issues
}

interface ArtifactUnit {
  path: string
  markdown: string
  claimUses: readonly ClaimUse[]
}

function artifactUnits(value: ArtifactManifest, add: AddM4ContractIssue): ArtifactUnit[] {
  if (value.content.kind === 'brief') {
    const sectionIds = new Set<OpaqueId>()
    return value.content.sections.map((section, index) => {
      if (sectionIds.has(section.sectionId)) {
        add('artifact-duplicate-id', `/content/sections/${index}/sectionId`, 'Brief section ids must be unique')
      }
      sectionIds.add(section.sectionId)
      return {
        path: `/content/sections/${index}`,
        markdown: section.markdown,
        claimUses: section.claimUses,
      }
    })
  }

  const rowIds = new Set<OpaqueId>()
  const columnIds = new Set<OpaqueId>()
  const cellIds = new Set<OpaqueId>()
  const coordinates = new Set<string>()
  for (const [index, row] of value.content.rows.entries()) {
    if (rowIds.has(row.rowId)) {
      add('artifact-duplicate-id', `/content/rows/${index}/rowId`, 'Matrix row ids must be unique')
    }
    rowIds.add(row.rowId)
  }
  for (const [index, column] of value.content.columns.entries()) {
    if (columnIds.has(column.columnId)) {
      add('artifact-duplicate-id', `/content/columns/${index}/columnId`, 'Matrix column ids must be unique')
    }
    columnIds.add(column.columnId)
  }
  return value.content.cells.map((cell, index) => {
    if (cellIds.has(cell.cellId)) {
      add('artifact-duplicate-id', `/content/cells/${index}/cellId`, 'Matrix cell ids must be unique')
    }
    cellIds.add(cell.cellId)
    if (!rowIds.has(cell.rowId) || !columnIds.has(cell.columnId)) {
      add('artifact-matrix-reference', `/content/cells/${index}`, 'Matrix cells must reference rows and columns in the same manifest')
    }
    const coordinate = `${cell.rowId}\0${cell.columnId}`
    if (coordinates.has(coordinate)) {
      add('artifact-matrix-duplicate-cell', `/content/cells/${index}`, 'a Matrix can contain at most one cell at each row/column coordinate')
    }
    coordinates.add(coordinate)
    return {
      path: `/content/cells/${index}`,
      markdown: cell.markdown,
      claimUses: cell.claimUses,
    }
  })
}

function validateClaimBindings(
  artifact: ArtifactManifest,
  units: readonly ArtifactUnit[],
  context: ArtifactValidationContext,
  add: AddM4ContractIssue,
): void {
  if (context.claims === undefined) return
  const claims = new Map(context.claims.map(claim => [claim.claimVersionId, claim]))
  const relations = context.evidenceRelations === undefined
    ? undefined
    : context.evidenceRelations.filter(relation => relation.reviewStatus !== 'human-rejected')
  for (const unit of units) {
    for (const [index, claimUse] of unit.claimUses.entries()) {
      const path = `${unit.path}/claimUses/${index}`
      const claim = claims.get(claimUse.claimVersionId)
      if (claim === undefined) {
        add('artifact-claim-reference', `${path}/claimVersionId`, 'ClaimUse references an unknown ClaimVersion')
        continue
      }
      if (claim.workspaceId !== artifact.workspaceId
        || claim.investigationId !== artifact.investigationId) {
        add('artifact-claim-reference', `${path}/claimVersionId`, 'ClaimUse cannot cross workspace or Investigation identity')
      }
      if (claim.scope.sourceScopeVersionId !== artifact.sourceScopeVersionId) {
        add('artifact-source-scope', `${path}/claimVersionId`, 'published claim use must pin the artifact source-scope version exactly')
      }
      const expectedUse = expectedClaimUseKind(claim)
      if (claimUse.useKind !== expectedUse) {
        add('artifact-claim-state', `${path}/useKind`, 'ClaimUse must disclose assumptions, decisions, external knowledge, and conflicts instead of presenting them as ordinary assertions')
      }
      const documentTruth = claim.basis === 'document-supported'
        || claim.basis === 'derived-from-claims'
      const ineligibleEpistemicStatus = claim.epistemicStatus === 'stale'
        || claim.epistemicStatus === 'withdrawn'
        || claim.epistemicStatus === 'proposed'
        || (documentTruth && claim.epistemicStatus === 'unresolved')
      if (artifact.status === 'published'
        && (claim.reviewStatus !== 'accepted'
          || claim.lifecycleStatus !== 'current'
          || ineligibleEpistemicStatus)) {
        add('artifact-claim-state', `${path}/claimVersionId`, 'published artifacts may use only accepted, current, publication-eligible ClaimVersions')
      }
      if (relations !== undefined) {
        const linked = relations.filter(relation => relation.claimVersionId === claim.claimVersionId)
        for (const evidenceId of claimUse.citationEvidenceIds) {
          if (!linked.some(relation => relation.evidenceId === evidenceId)) {
            add('artifact-evidence-reference', `${path}/citationEvidenceIds`, 'visible Evidence must be linked to this exact ClaimVersion by a non-rejected EvidenceRelation')
          }
        }
        if (claimUse.useKind === 'assertion') {
          const allowed = linked.filter(relation => relation.kind === 'supports'
            || relation.kind === 'qualifies'
            || relation.kind === 'derived-input')
          if (!claimUse.citationEvidenceIds.some(id => allowed.some(relation => relation.evidenceId === id))) {
            add('artifact-evidence-reference', `${path}/citationEvidenceIds`, 'an assertion requires supporting or qualifying Evidence')
          }
        }
        if (claimUse.useKind === 'conflict-disclosure') {
          const citesSupport = claimUse.citationEvidenceIds.some(id => linked.some(relation => relation.evidenceId === id && relation.kind === 'supports'))
          const citesRefute = claimUse.citationEvidenceIds.some(id => linked.some(relation => relation.evidenceId === id && relation.kind === 'refutes'))
          if (!citesSupport || !citesRefute) {
            add('artifact-evidence-reference', `${path}/citationEvidenceIds`, 'a conflict disclosure must expose at least one supporting and one refuting EvidenceAtom')
          }
        }
      }
    }
  }
}

function expectedClaimUseKind(claim: ClaimVersion): ClaimUseKind {
  if (claim.basis === 'user-assumption') return 'assumption'
  if (claim.basis === 'project-decision') return 'decision'
  if (claim.basis === 'external-knowledge') return 'external-knowledge'
  if (claim.epistemicStatus === 'contested' || claim.epistemicStatus === 'contradicted') {
    return 'conflict-disclosure'
  }
  return 'assertion'
}

function validateReviewBinding(
  artifact: ArtifactManifest,
  review: ReviewResult | undefined,
  add: AddM4ContractIssue,
): void {
  if (artifact.status === 'draft') return
  const publication = artifact.publication
  if (publication === undefined) return
  if (review === undefined) {
    add('artifact-review-reference', '/publication/reviewResultId', 'a non-draft artifact requires its deterministic ReviewResult for publication validation')
    return
  }
  if (reviewResultIssues(review).length > 0) {
    add('artifact-publish-gate', '/publication/reviewResultId', 'referenced ReviewResult is not semantically valid')
  }
  if (publication.reviewResultId !== review.reviewResultId
    || review.workspaceId !== artifact.workspaceId
    || review.investigationId !== artifact.investigationId
    || review.sourceScopeVersionId !== artifact.sourceScopeVersionId) {
    add('artifact-review-reference', '/publication/reviewResultId', 'publication and ReviewResult identities must match exactly')
  }
  if (review.mode !== 'publish-gate'
    || review.subject.kind !== 'artifact-manifest'
    || review.subject.objectIds.length !== 1
    || review.subject.objectIds[0] !== artifact.artifactManifestId
    || review.subject.contentHash !== artifact.contentHash) {
    add('artifact-review-reference', '/publication/reviewResultId', 'publication review must pin this exact artifact manifest and content hash')
  }
  if (review.decision !== publication.deterministicDecision) {
    add('artifact-publish-gate', '/publication/deterministicDecision', 'manifest must preserve the deterministic ReviewResult decision')
  }
  if (review.decision !== 'pass' && review.decision !== 'needs-human') {
    add('artifact-publish-gate', '/publication/reviewResultId', 'failed or incomplete deterministic gates cannot be published')
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
