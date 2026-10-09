import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { answerManifestIssues, answerVerificationSummary, type AnswerManifest, type CitationPresentation, type PreferenceProbe, type ProductProbeMaterial, type ProductProbeView } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { enrichmentHash } from '../src/document/enrichment.js'
import { CONTROLLED_PROBE_RECIPES, controlledProbeId, controlledProbeMaterial, createControlledProbe, verifyControlledProbe } from '../src/personalization/controlled-presentation.js'

const directory = new URL('../../../contracts/fixtures/', import.meta.url)
const manifestFixture = JSON.parse(readFileSync(new URL('m2/answer-manifest.json', directory), 'utf8')).manifest as AnswerManifest
const wireFixture = JSON.parse(readFileSync(new URL('product-probe.json', directory), 'utf8')).bases.ready as ProductProbeView
const profileId = 'profile:probe', generatedAt = '2026-09-10T00:00:00.000Z'
const hashText = (text: string) => createHash('sha256').update(text).digest('hex')
const actualText = (manifest: AnswerManifest) => manifest.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n')
function normalize(manifest: AnswerManifest): AnswerManifest {
  manifest.answerTextHash = hashText(actualText(manifest))
  manifest.verificationSummary = answerVerificationSummary(manifest.blocks.flatMap(block => block.segments), manifest.citations, manifest.verificationSummary.warnings)
  const summary = manifest.verificationSummary
  manifest.manifestStatus = summary.factualSegments === 0 ? 'unmapped' : summary.unresolvedSegments === 0 && summary.unclassifiedSegments === 0 ? 'mapped' : 'partial'
  expect(answerManifestIssues(manifest)).toEqual([])
  return manifest
}
function mixedManifest(): AnswerManifest {
  const manifest = structuredClone(manifestFixture), base = manifest.citations[0]!
  const qualified = { ...structuredClone(base), citationId: 'citation:qualified', ordinal: 2, relation: 'qualify' as const }
  const refuted = { ...structuredClone(base), citationId: 'citation:refuted', ordinal: 3, relation: 'refute' as const }
  const weak: CitationPresentation = { ...structuredClone(base), citationId: 'citation:weak', ordinal: 4, relation: 'support', verificationStatus: 'locator-only' }
  delete weak.evidence
  manifest.citations.push(qualified, refuted, weak)
  manifest.blocks[0]!.segments[0]!.claimVersionIds = ['claim:actual:z', 'claim:actual:a']
  manifest.blocks.push({ blockId: 'block:caveats', sourceBlockIndex: 1, kind: 'prose', segments: [
    { segmentId: 'segment:qualified', text: 'This figure is qualified by the reporting boundary.', kind: 'factual', status: 'qualified', claimVersionIds: ['claim:actual:a'], visibleCitationIds: [qualified.citationId] },
    { segmentId: 'segment:conflicted', text: 'The cited relation contests that interpretation.', kind: 'factual', status: 'contested', claimVersionIds: [], visibleCitationIds: [refuted.citationId] },
    { segmentId: 'segment:weak', text: 'The following source has a locator but is not verified text.', kind: 'factual', status: 'unresolved', claimVersionIds: [], visibleCitationIds: [weak.citationId] },
    { segmentId: 'segment:unknown', text: 'Unclassified content must remain explicitly uncertain.', kind: 'unclassified', status: 'unresolved', claimVersionIds: [], visibleCitationIds: [] },
  ] })
  return normalize(manifest)
}
function prepared(manifest = structuredClone(manifestFixture)) {
  const material = controlledProbeMaterial(manifest, wireFixture.material!.nativeTextHash)
  const probe = createControlledProbe({ profileId, profileEpoch: 0, material, evidenceFirstOnLeft: false, generatedAt })
  return { material, probe }
}

describe('pure controlled presentation: exact complete content, never alternative model-written facts', () => {
  it('matches the shared real-content hashes and two recipe references without fabricating Claim IDs', () => {
    const { material, probe } = prepared(), before = structuredClone(material)
    expect(material).toEqual({ ...wireFixture.material, manifest: manifestFixture })
    expect(probe).toEqual(wireFixture.probe)
    expect(probe.backbone.claimVersionIds).toEqual([])
    expect(probe.backbone.evidenceAtomIds).toEqual(['evidence:revenue-growth'])
    verifyControlledProbe(probe, material, profileId, 0)
    expect(material).toEqual(before)
    const reversed = createControlledProbe({ profileId, profileEpoch: 0, material, evidenceFirstOnLeft: true, generatedAt })
    expect(reversed).toEqual({ ...probe, presentationOrder: [...probe.presentationOrder].reverse() })
    expect(reversed.probeId).toBe(probe.probeId)
    for (const recipe of CONTROLLED_PROBE_RECIPES) {
      expect(new Set(recipe.sections)).toEqual(new Set(['answer', 'evidence']))
      expect(probe.variants.find(variant => variant.variantKey === recipe.variantKey)?.artifactId)
        .toBe(`presentation:${enrichmentHash({ materialHash: material.materialHash, recipeVersion: 1, sections: recipe.sections })}`)
    }
  })

  it('retains every weak locator, uncertainty, conflict, qualification, text segment and warning in both layouts', () => {
    const original = mixedManifest(), { material, probe } = prepared(original)
    expect(material.manifest).toEqual(original)
    expect(probe.backbone).toEqual({ sourceScopeVersionId: original.sourceScopeVersionId, claimVersionIds: ['claim:actual:a', 'claim:actual:z'],
      evidenceAtomIds: ['evidence:revenue-growth'], uncertaintyIds: ['segment:qualified', 'segment:unknown', 'segment:weak'],
      conflictIds: ['citation:refuted', 'segment:conflicted'], factTraceDigest: material.materialHash })
    expect(material.manifest.verificationSummary).toMatchObject({ complete: false, qualifiedSegments: 1, contestedSegments: 1, unresolvedSegments: 1, unclassifiedSegments: 1,
      warnings: ['locator-without-text', 'unclassified-text'] })
    const sections = { answer: material.manifest.blocks, evidence: { citations: material.manifest.citations, verification: material.manifest.verificationSummary } }
    for (const recipe of CONTROLLED_PROBE_RECIPES) {
      const renderedContent = Object.fromEntries(recipe.sections.map(section => [section, sections[section]]))
      expect(renderedContent).toEqual(sections)
      expect(enrichmentHash(renderedContent)).toBe(enrichmentHash(sections))
    }
    original.blocks[0]!.segments[0]!.text = 'Caller mutation after capture'
    expect(material.manifest.blocks[0]!.segments[0]!.text).toBe(manifestFixture.blocks[0]!.segments[0]!.text)
  })

  it('hashes actual visible text instead of accepting caller-reported invariant equality', () => {
    const { material, probe } = prepared()
    material.manifest.blocks[0]!.segments[0]!.text = 'Revenue increased by 90%.'
    // All declared content/backbone/variant hashes still agree; actual text does not.
    expect(probe.variants.every(variant => variant.factTraceDigest === material.materialHash)).toBe(true)
    expect(answerManifestIssues(material.manifest)).toEqual([])
    expect(() => controlledProbeMaterial(material.manifest, material.nativeTextHash)).toThrow('Answer content changed')
    expect(() => verifyControlledProbe(probe, material, profileId, 0)).toThrow('Answer content changed')
  })

  const alterations: Array<[string, (probe: PreferenceProbe, material: ProductProbeMaterial) => void]> = [
    ['arbitrary artifact ID', probe => { probe.variants[0]!.artifactId = 'presentation:unverified' }],
    ['another recipe version', (probe, material) => { probe.variants[0]!.artifactId = `presentation:${enrichmentHash({ materialHash: material.materialHash, recipeVersion: 2, sections: ['answer', 'evidence'] })}` }],
    ['omitted evidence section', (probe, material) => { probe.variants[0]!.artifactId = `presentation:${enrichmentHash({ materialHash: material.materialHash, recipeVersion: 1, sections: ['answer'] })}` }],
    ['invented Claim', probe => { probe.backbone.claimVersionIds.push('claim:not-in-answer') }],
    ['dropped uncertainty', probe => { probe.backbone.uncertaintyIds = [] }],
    ['dropped conflict', probe => { probe.backbone.conflictIds = [] }],
    ['replacement Evidence identity', probe => { probe.backbone.evidenceAtomIds = ['evidence:invented'] }],
    ['different source scope', (_probe, material) => { material.manifest.sourceScopeVersionId = 'scope:other' }],
    ['changed native text seal', (_probe, material) => { material.nativeTextHash = hashText('different native text') }],
    ['changed material hash', (_probe, material) => { material.materialHash = hashText('different material') }],
    ['changed variant digest', probe => { probe.variants[0]!.factTraceDigest = hashText('different variant') }],
    ['mismatched recipe axis', probe => { probe.variants[0]!.effect = { key: 'explanation-depth', value: 'teaching' } }],
    ['unknown presentation key', probe => { probe.presentationOrder[0] = 'variant:not-present' }],
  ]
  it.each(alterations)('rejects %s rather than accepting declared invariantCheck', (_name, alter) => {
    const { material, probe } = prepared(mixedManifest())
    alter(probe, material)
    expect(probe.variants.every(variant => variant.invariantCheck === 'passed')).toBe(true)
    expect(() => verifyControlledProbe(probe, material, profileId, 0)).toThrow()
  })

  it('pins profile, privacy epoch, Answer identity and task context in independently checked recipe origin', () => {
    const { material, probe } = prepared()
    expect(controlledProbeId(profileId, 0, material)).toBe(probe.probeId)
    expect(() => verifyControlledProbe(probe, material, 'profile:another', 0)).toThrow()
    expect(() => verifyControlledProbe(probe, material, profileId, 1)).toThrow()
    const changed = structuredClone(probe)
    changed.taskContext.workspaceId = 'workspace:other'
    expect(() => verifyControlledProbe(changed, material, profileId, 0)).toThrow()
    changed.taskContext = structuredClone(probe.taskContext); changed.sessionId = 'session:another'
    expect(() => verifyControlledProbe(changed, material, profileId, 0)).toThrow()
    expect(() => parseContract('personalization-core', { ...probe, ownerActorId: 'actor:forged' })).toThrow()
  })

  it('bounds the optional experiment without truncating a saved Answer', () => {
    const original = structuredClone(manifestFixture), block = original.blocks[0]!
    original.blocks = Array.from({ length: 34 }, (_, index) => ({ ...structuredClone(block), blockId: `block:${index}`, sourceBlockIndex: index,
      segments: block.segments.map(segment => ({ ...structuredClone(segment), segmentId: `segment:${index}`, text: 'x'.repeat(4096) })) }))
    normalize(original)
    const before = structuredClone(original)
    expect(() => controlledProbeMaterial(original, wireFixture.material!.nativeTextHash)).toThrowError(expect.objectContaining({ code: 'limit-exceeded' }))
    expect(original).toEqual(before)
  })

  it('refuses 201 actual uncertainty references before ready material without truncation, even below the byte and block limits', () => {
    const original = structuredClone(manifestFixture), first = { ...original.blocks[0]!.segments[0]!, status: 'qualified' as const }
    original.citations[0]!.relation = 'qualify'
    const segments = [first, ...Array.from({ length: 200 }, (_, index) => ({ segmentId: `segment:uncertain:${index}`, text: `Unclassified source segment ${index}.`,
      kind: 'unclassified' as const, status: 'unresolved' as const, claimVersionIds: [], visibleCitationIds: [] }))]
    original.blocks = [segments.slice(0, 128), segments.slice(128)].map((part, index) => ({ blockId: `block:uncertainty:${index}`, sourceBlockIndex: index, kind: 'prose', segments: part }))
    normalize(original)
    expect(parseContract('answer-manifest', original)).toEqual(original)
    expect(Buffer.byteLength(JSON.stringify(original))).toBeLessThan(131072)
    expect(original.blocks.flatMap(block => block.segments)).toHaveLength(201)
    const before = structuredClone(original)
    expect(() => controlledProbeMaterial(original, wireFixture.material!.nativeTextHash)).toThrowError(expect.objectContaining({ code: 'limit-exceeded' }))
    expect(original).toEqual(before)
  })
})
