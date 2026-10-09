import { createHash } from 'node:crypto'
import { answerManifestIssues, personalizationCoreIssues, type PreferenceProbe, type ProductProbeMaterial } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { enrichmentHash } from '../document/enrichment.js'
import { PersonalizationStoreError } from '../storage/personalization-store.js'

export const MAX_PROBE_MATERIAL_BYTES = 131072
export const CONTROLLED_PROBE_RECIPES = [
  { variantKey: 'variant:answer-first', effect: { key: 'answer-order' as const, value: 'conclusion-first' as const }, sections: ['answer', 'evidence'] as const },
  { variantKey: 'variant:evidence-first', effect: { key: 'answer-order' as const, value: 'evidence-first' as const }, sections: ['evidence', 'answer'] as const },
] as const
const invalid = (message: string): never => { throw new PersonalizationStoreError('integrity-error', message) }
const hashPattern = /^[a-f0-9]{64}$/u

/** Content is ephemeral and belongs to the authorized Answer, never to the profile ledger. */
export function controlledProbeMaterial(candidate: ProductProbeMaterial['manifest'], nativeTextHash: string): ProductProbeMaterial {
  const manifest = structuredClone(parseContract('answer-manifest', candidate))
  if (answerManifestIssues(manifest).length || !hashPattern.test(nativeTextHash)) return invalid('Invalid controlled presentation source')
  // Reconstruct the actual stored content, not just caller-declared matching digests.
  const text = manifest.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n')
  if (enrichmentHashText(text) !== manifest.answerTextHash) return invalid('Controlled presentation Answer content changed')
  const segments = manifest.blocks.flatMap(block => block.segments)
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_PROBE_MATERIAL_BYTES || manifest.blocks.length > 64 || manifest.citations.length > 32
    || new Set(segments.flatMap(segment => segment.claimVersionIds)).size > 200
    || segments.filter(segment => segment.status === 'unresolved' || segment.status === 'qualified' || segment.kind === 'unclassified').length > 200
    || segments.filter(segment => segment.status === 'contested').length + manifest.citations.filter(citation => citation.relation === 'refute').length > 200) throw new PersonalizationStoreError('limit-exceeded', 'Answer exceeds the optional controlled-presentation bound')
  return { manifest, nativeTextHash, materialHash: enrichmentHash({ recipeVersion: 1, manifest, nativeTextHash }) }
}

const enrichmentHashText = (text: string) => createHash('sha256').update(text).digest('hex')
export function controlledProbeId(profileId: string, profileEpoch: number, material: ProductProbeMaterial): string {
  return `probe:${enrichmentHash([profileId, profileEpoch, material.manifest.sessionId, material.manifest.messageId, material.manifest.manifestId, material.materialHash, 'answer-order:v1'])}`
}
/** A separate namespace prevents accumulated learning from reinterpreting a v1 single choice. */
export function learningProbeId(profileId: string, profileEpoch: number, material: ProductProbeMaterial): string {
  return `learning-probe:${enrichmentHash([profileId, profileEpoch, material.manifest.sessionId, material.manifest.messageId, material.manifest.manifestId, material.materialHash, 'answer-order:learning:v1'])}`
}
export function createLearningProbe(input: Parameters<typeof createControlledProbe>[0]): PreferenceProbe {
  const probe = { ...createControlledProbe(input), probeId: learningProbeId(input.profileId, input.profileEpoch, input.material) }
  verifyLearningProbe(probe, input.material, input.profileId, input.profileEpoch)
  return probe
}
export function verifyLearningProbe(probe: PreferenceProbe, material: ProductProbeMaterial, profileId: string, profileEpoch: number): void {
  if (probe.probeId !== learningProbeId(profileId, profileEpoch, material)) return invalid('Accumulated learning Probe identity changed')
  verifyControlledProbe({ ...probe, probeId: controlledProbeId(profileId, profileEpoch, material) }, material, profileId, profileEpoch)
}
function backbone(material: ProductProbeMaterial): PreferenceProbe['backbone'] {
  const manifest = material.manifest, segments = manifest.blocks.flatMap(block => block.segments)
  return { sourceScopeVersionId: manifest.sourceScopeVersionId,
    claimVersionIds: [...new Set(segments.flatMap(segment => segment.claimVersionIds))].sort(),
    evidenceAtomIds: [...new Set(manifest.citations.flatMap(citation => citation.evidence ? [citation.evidence.evidenceId] : []))].sort(),
    uncertaintyIds: segments.filter(segment => segment.status === 'unresolved' || segment.status === 'qualified' || segment.kind === 'unclassified').map(segment => segment.segmentId).sort(),
    conflictIds: [...segments.filter(segment => segment.status === 'contested').map(segment => segment.segmentId), ...manifest.citations.filter(citation => citation.relation === 'refute').map(citation => citation.citationId)].sort(),
    factTraceDigest: material.materialHash }
}
export function createControlledProbe(input: { profileId: string, profileEpoch: number, material: ProductProbeMaterial, evidenceFirstOnLeft: boolean, generatedAt: string }): PreferenceProbe {
  const material = controlledProbeMaterial(input.material.manifest, input.material.nativeTextHash)
  if (material.materialHash !== input.material.materialHash) return invalid('Controlled presentation material hash changed')
  const variants = CONTROLLED_PROBE_RECIPES.map(recipe => ({ variantKey: recipe.variantKey, effect: recipe.effect,
    artifactId: `presentation:${enrichmentHash({ materialHash: material.materialHash, recipeVersion: 1, sections: recipe.sections })}`,
    factTraceDigest: material.materialHash, invariantCheck: 'passed' as const }))
  const manifest = material.manifest
  const probe: PreferenceProbe = { schemaVersion: 1, recordType: 'preference-probe', probeId: controlledProbeId(input.profileId, input.profileEpoch, material),
    profileId: input.profileId, sessionId: manifest.sessionId, turn: manifest.turn, taskContext: { mode: manifest.mode, workspaceId: manifest.workspaceId, investigationId: manifest.investigationId },
    axis: 'answer-order', trigger: 'user-requested', investigationId: manifest.investigationId, backbone: backbone(material), variants,
    presentationOrder: (input.evidenceFirstOnLeft ? [...variants].reverse() : variants).map(variant => variant.variantKey), generatedAt: input.generatedAt }
  verifyControlledProbe(probe, material, input.profileId, input.profileEpoch)
  return probe
}

/** Whitelisted recipes imply the exact same complete sections, not alternate free-form artifacts. */
export function verifyControlledProbe(probe: PreferenceProbe, material: ProductProbeMaterial, profileId: string, profileEpoch: number): void {
  const validated = controlledProbeMaterial(material.manifest, material.nativeTextHash)
  parseContract('personalization-core', probe)
  if (personalizationCoreIssues(probe).length || validated.materialHash !== material.materialHash
    || probe.probeId !== controlledProbeId(profileId, profileEpoch, validated) || probe.profileId !== profileId || probe.sessionId !== material.manifest.sessionId
    || probe.axis !== 'answer-order' || probe.trigger !== 'user-requested' || probe.turn !== material.manifest.turn || probe.investigationId !== material.manifest.investigationId
    || enrichmentHash(probe.taskContext) !== enrichmentHash({ mode: material.manifest.mode, workspaceId: material.manifest.workspaceId, investigationId: material.manifest.investigationId })
    || enrichmentHash(probe.backbone) !== enrichmentHash(backbone(validated))) return invalid('Controlled presentation origin or complete backbone changed')
  const content = { answer: material.manifest.blocks, evidence: { citations: material.manifest.citations, verification: material.manifest.verificationSummary } }
  for (const recipe of CONTROLLED_PROBE_RECIPES) {
    const variant = probe.variants.find(value => value.variantKey === recipe.variantKey)
    if (!variant || enrichmentHash(variant.effect) !== enrichmentHash(recipe.effect)
      || variant.artifactId !== `presentation:${enrichmentHash({ materialHash: validated.materialHash, recipeVersion: 1, sections: recipe.sections })}`) return invalid('Controlled presentation recipe changed')
    const actual = Object.fromEntries(recipe.sections.map(section => [section, content[section]]))
    if (enrichmentHash(actual) !== enrichmentHash(content)) return invalid('Controlled presentation dropped or changed source material')
  }
}
