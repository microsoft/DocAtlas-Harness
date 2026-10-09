import { readFileSync } from 'node:fs'

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import * as addFormatsModule from 'ajv-formats'
import type { FormatsPlugin } from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import {
  buildLegacyEvidenceLead,
  type DocumentLocator,
  type DocumentRevision,
  documentLocatorIssues,
  documentRevisionIssues,
  type EvidenceAtom,
  evidenceLocatorIssues,
  type LegacyEvidenceLead,
  type PageInfo,
  pageInfoIssues,
  type SourceRepresentation,
  sourceRepresentationIssues,
  type SourceScopeVersion,
  sourceScopeIssues,
} from '../src/index.ts'
import { ContractValidationError, parseContract, validateContractShape } from '../src/node.ts'

interface SchemaCatalog {
  schemaVersion: 1
  schemas: Array<{ name: string, path: string, id: string }>
}

interface CanonicalSlice {
  pageInfo: PageInfo
  protocolError: unknown
  documentRevision: DocumentRevision
  originalRepresentation: SourceRepresentation
  textRepresentation: SourceRepresentation
  sourceScope: SourceScopeVersion
  quoteLocator: DocumentLocator
  evidence: EvidenceAtom
  legacyLead: LegacyEvidenceLead
}

interface MultiDocumentSlice {
  locatorA: DocumentLocator
  locatorB: DocumentLocator
  evidenceB: EvidenceAtom
  staleEvidenceB: EvidenceAtom
  ambiguousEvidenceB: EvidenceAtom
}

const contractRoot = new URL('../../../contracts/', import.meta.url)

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, contractRoot), 'utf8')) as T
}

const catalog = readJson<SchemaCatalog>('schema-catalog.json')
const schemas = new Map(
  catalog.schemas.map(entry => [entry.name, readJson<Record<string, unknown>>(entry.path)]),
)
const fixture = readJson<CanonicalSlice>('fixtures/m0/canonical-slice.json')
const multiDocFixture = readJson<MultiDocumentSlice>('fixtures/m0/multi-document-same-page.json')
const addFormats = addFormatsModule.default as unknown as FormatsPlugin

function validators(): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  for (const entry of catalog.schemas) {
    const schema = schemas.get(entry.name)
    if (schema === undefined) throw new Error(`missing schema for ${entry.name}`)
    ajv.addSchema(schema, entry.id)
  }
  return new Map(catalog.schemas.map(entry => {
    const validate = ajv.getSchema(entry.id)
    if (validate === undefined) throw new Error(`missing validator for ${entry.name}`)
    return [entry.name, validate]
  }))
}

function expectValid(validate: ValidateFunction, value: unknown): void {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true)
}

describe('M0 canonical JSON schemas', () => {
  it('loads a unique and internally consistent schema catalog', () => {
    expect(catalog.schemaVersion).toBe(1)
    expect(new Set(catalog.schemas.map(entry => entry.name)).size).toBe(catalog.schemas.length)
    expect(new Set(catalog.schemas.map(entry => entry.id)).size).toBe(catalog.schemas.length)
    for (const entry of catalog.schemas) {
      expect(schemas.get(entry.name)?.$id).toBe(entry.id)
    }
    expect(() => validators()).not.toThrow()
  })

  it('accepts the shared canonical research slice', () => {
    const byName = validators()
    expectValid(byName.get('protocol-error')!, fixture.protocolError)
    expectValid(byName.get('page-info')!, fixture.pageInfo)
    expectValid(byName.get('document-revision')!, fixture.documentRevision)
    expectValid(byName.get('source-representation')!, fixture.originalRepresentation)
    expectValid(byName.get('source-representation')!, fixture.textRepresentation)
    expectValid(byName.get('source-scope-version')!, fixture.sourceScope)
    expectValid(byName.get('document-locator')!, fixture.quoteLocator)
    expectValid(byName.get('evidence-atom')!, fixture.evidence)
    expectValid(byName.get('legacy-evidence-lead')!, fixture.legacyLead)
  })

  it('rejects malformed or incomplete boundary objects', () => {
    const byName = validators()

    const page = structuredClone(fixture.pageInfo)
    page.truncated = true
    page.completeness = 'partial'
    expect(byName.get('page-info')!(page)).toBe(false)

    const revision = structuredClone(fixture.documentRevision)
    delete revision.pageCount
    expect(byName.get('document-revision')!(revision)).toBe(false)

    const representation = structuredClone(fixture.textRepresentation)
    delete representation.generator
    expect(byName.get('source-representation')!(representation)).toBe(false)

    const locator = structuredClone(fixture.quoteLocator)
    locator.physicalPage = 0
    expect(byName.get('document-locator')!(locator)).toBe(false)

    const evidence = structuredClone(fixture.evidence)
    evidence.content = { mediaType: 'image/png', assetId: 'asset:1' }
    expect(byName.get('evidence-atom')!(evidence)).toBe(false)
    expect(byName.get('evidence-atom')!(fixture.legacyLead)).toBe(false)
  })
})

describe('M0 semantic validation', () => {
  it('accepts the shared canonical objects', () => {
    expect(pageInfoIssues(fixture.pageInfo)).toEqual([])
    expect(documentRevisionIssues(fixture.documentRevision)).toEqual([])
    expect(sourceRepresentationIssues(
      fixture.originalRepresentation,
      fixture.documentRevision,
    )).toEqual([])
    expect(sourceRepresentationIssues(
      fixture.textRepresentation,
      fixture.documentRevision,
    )).toEqual([])
    expect(sourceScopeIssues(fixture.sourceScope)).toEqual([])
    expect(documentLocatorIssues(fixture.quoteLocator)).toEqual([])
    expect(evidenceLocatorIssues(fixture.evidence, fixture.quoteLocator)).toEqual([])
  })

  it('finds pagination, lineage, scope, selector, and evidence-link violations', () => {
    const page = { ...fixture.pageInfo, returned: 9 }
    expect(pageInfoIssues(page).map(value => value.code)).toEqual([
      'page-returned-exceeds-limit',
      'page-returned-exceeds-total',
    ])

    const revision = {
      ...fixture.documentRevision,
      previousRevisionId: fixture.documentRevision.revisionId,
    }
    expect(documentRevisionIssues(revision).map(value => value.code)).toContain(
      'revision-self-previous',
    )

    const representation = {
      ...fixture.textRepresentation,
      derivedFromRepresentationIds: [fixture.textRepresentation.representationId],
    }
    expect(sourceRepresentationIssues(representation).map(value => value.code)).toContain(
      'representation-self-derived',
    )

    const included = fixture.sourceScope.included[0]!
    const scope: SourceScopeVersion = {
      ...fixture.sourceScope,
      included: [included, { ...included, role: 'secondary' }],
      excluded: [{
        documentId: included.documentId,
        revisionId: included.revisionId,
        reason: 'user',
      }],
    }
    expect(sourceScopeIssues(scope).map(value => value.code)).toEqual([
      'scope-duplicate-included',
      'scope-included-and-excluded',
    ])

    const locator: DocumentLocator = {
      ...fixture.quoteLocator,
      supersedesLocatorId: fixture.quoteLocator.locatorId,
      selectors: [
        { type: 'text-position', start: 8, end: 8, unit: 'unicode-scalar' },
        { type: 'bbox', unit: 'ratio', x: 0.8, y: 0.9, width: 0.3, height: 0.2, rotation: 0 },
      ],
    }
    expect(documentLocatorIssues(locator).map(value => value.code)).toEqual([
      'locator-self-supersedes',
      'locator-text-position-order',
      'locator-ratio-bounds',
    ])

    const evidence = { ...fixture.evidence, revisionId: 'rev:other' }
    expect(evidenceLocatorIssues(evidence, fixture.quoteLocator).map(value => value.code)).toEqual([
      'evidence-locator-mismatch',
    ])
  })

  it('keeps identical physical pages in different documents unambiguous', () => {
    const byName = validators()
    expectValid(byName.get('document-locator')!, multiDocFixture.locatorA)
    expectValid(byName.get('document-locator')!, multiDocFixture.locatorB)
    expectValid(byName.get('evidence-atom')!, multiDocFixture.evidenceB)
    expectValid(byName.get('evidence-atom')!, multiDocFixture.staleEvidenceB)
    expectValid(byName.get('evidence-atom')!, multiDocFixture.ambiguousEvidenceB)

    expect(multiDocFixture.locatorA.physicalPage).toBe(2)
    expect(multiDocFixture.locatorB.physicalPage).toBe(2)
    expect(multiDocFixture.locatorA.documentId).not.toBe(multiDocFixture.locatorB.documentId)
    expect(multiDocFixture.locatorA.revisionId).not.toBe(multiDocFixture.locatorB.revisionId)
    expect(evidenceLocatorIssues(multiDocFixture.evidenceB, multiDocFixture.locatorB)).toEqual([])
    expect(evidenceLocatorIssues(
      multiDocFixture.evidenceB,
      multiDocFixture.locatorA,
    ).map(value => value.code)).toEqual(['evidence-locator-mismatch'])
    expect(multiDocFixture.staleEvidenceB.resolutionStatus).toBe('stale')
    expect(multiDocFixture.staleEvidenceB.status).toBe('stale')
    expect(multiDocFixture.ambiguousEvidenceB.resolutionStatus).toBe('ambiguous')
    expect(multiDocFixture.ambiguousEvidenceB.status).toBe('current')
  })
})

describe('production Node contract parser', () => {
  it('returns typed values for valid objects', () => {
    const result = validateContractShape('document-locator', fixture.quoteLocator)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.locatorId).toBe('loc:revenue-growth')
    expect(parseContract('evidence-atom', fixture.evidence).evidenceId).toBe(
      'evidence:revenue-growth',
    )
    expect(parseContract('legacy-evidence-lead', fixture.legacyLead).resolutionStatus).toBe(
      'unresolved',
    )
  })

  it('returns structured issues and throws a typed error for invalid objects', () => {
    const invalid = { ...fixture.quoteLocator, physicalPage: 0 }
    const result = validateContractShape('document-locator', invalid)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some(issue => issue.instancePath === '/physicalPage')).toBe(true)
    }
    expect(() => parseContract('document-locator', invalid)).toThrow(ContractValidationError)
  })
})

describe('legacy import containment', () => {
  it('can only create an unresolved, unverified lead', () => {
    const lead = buildLegacyEvidenceLead({
      leadId: 'legacy-lead:test',
      legacyKind: 'note-evidence',
      sourceSessionId: 'session:legacy',
      rawSource: '  Page 2  ',
      rawContent: 'legacy observation',
      documentCandidates: [
        { documentId: 'doc:a', revisionId: 'rev:a:1' },
        { documentId: 'doc:b', revisionId: 'rev:b:1' },
      ],
      importedBy: { kind: 'system', actorId: 'system:legacy-import' },
      importedAt: '2026-08-30T00:00:00Z',
    })

    expect(lead.physicalPageCandidate).toBe(2)
    expect(lead.resolutionStatus).toBe('unresolved')
    expect(lead.verificationStatus).toBe('unverified')
    expect(validateContractShape('legacy-evidence-lead', lead).ok).toBe(true)
    expect(validateContractShape('evidence-atom', lead).ok).toBe(false)
  })

  it('does not invent a page from an arbitrary source string', () => {
    const lead = buildLegacyEvidenceLead({
      leadId: 'legacy-lead:no-page',
      legacyKind: 'page-finding',
      sourceSessionId: 'session:legacy',
      rawSource: 'not a locator',
      documentCandidates: [],
      importedBy: { kind: 'system', actorId: 'system:legacy-import' },
      importedAt: '2026-08-30T00:00:00Z',
    })
    expect(lead.physicalPageCandidate).toBeUndefined()
  })
})
