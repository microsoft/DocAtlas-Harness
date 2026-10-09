import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DocumentLocator, SourceScopeVersion } from '@docatlas/contracts'
import { compileSourceAnswerManifest, parseCitationSegments, type SourceAnswerCompileInput } from '../src/evidence/answer-manifest.js'

const { quoteLocator: locator } = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as { quoteLocator: DocumentLocator }
const scope: SourceScopeVersion = {
  schemaVersion: 1, scopeVersionId: 'scope:answer:core', workspaceId: 'workspace:answer:core', investigationId: 'investigation:answer:core', version: 1,
  included: [{ documentId: locator.documentId, revisionId: locator.revisionId, role: 'primary' }], excluded: [], locked: true,
  createdBy: { kind: 'user', actorId: 'user:core' }, createdAt: '2026-09-09T00:00:00Z',
}
function input(text = `[Revenue increased by 12%.](#docatlas.v1.support.${locator.locatorId})`): SourceAnswerCompileInput {
  return { sessionId: 'conversation:core', turn: 1, scope: structuredClone(scope),
    sources: [{ documentId: locator.documentId, revisionId: locator.revisionId, representationId: locator.representationId, representationContentHash: locator.representationContentHash }],
    message: { id: 'native-message:one', createdAt: '2026-09-09T01:00:00Z', blocks: [{ index: 0, text }] },
    reads: [{ callId: 'native-call:read', scopeVersionId: scope.scopeVersionId, locators: [structuredClone(locator)] }],
  }
}
describe('host-neutral source answer compiler', () => {
  it('builds stable, source-bound spans without host event types or mutation', () => {
    const request = input(), before = structuredClone(request), manifest = compileSourceAnswerManifest(request)!
    expect(request).toEqual(before); expect(compileSourceAnswerManifest(request)).toEqual(manifest)
    expect(manifest).toMatchObject({ sessionId: request.sessionId, messageId: request.message.id, manifestStatus: 'mapped',
      citations: [{ verificationStatus: 'read-verified', relationAssertedBy: { kind: 'agent' }, evidence: { content: { text: 'Revenue increased by 12%.' } } }],
      blocks: [{ sourceBlockIndex: 0, segments: [{ text: 'Revenue increased by 12%.', status: 'supported' }] }],
    })
    expect(manifest.answerTextHash).toBe(createHash('sha256').update('Revenue increased by 12%.').digest('hex'))
    const another = input(); another.message.id = 'native-message:two'
    expect(compileSourceAnswerManifest(another)!.manifestId).not.toBe(manifest.manifestId)
  })
  it('does not fabricate Read evidence from markers, old scopes, revisions or changed representations', () => {
    const absent = input(); absent.reads = []
    expect(compileSourceAnswerManifest(absent)).toBeUndefined()
    expect(compileSourceAnswerManifest(input('[Invented fact](#docatlas.v1.support.loc:invented)'))).toMatchObject({ citations: [], manifestStatus: 'partial' })
    for (const change of ['scope', 'revision', 'representation', 'source'] as const) {
      const request = input()
      if (change === 'scope') request.scope.scopeVersionId = 'scope:other'
      if (change === 'revision') request.sources = [{ ...request.sources[0]!, revisionId: 'revision:other' }]
      if (change === 'representation') request.sources = [{ ...request.sources[0]!, representationContentHash: 'a'.repeat(64) }]
      if (change === 'source') request.sources = []
      const manifest = compileSourceAnswerManifest(request)!
      expect(manifest.citations[0]).toMatchObject({ verificationStatus: 'locator-only' })
      expect(manifest.citations[0]).not.toHaveProperty('evidence')
      expect(manifest.blocks[0]!.segments[0]!.status).toBe('unresolved')
    }
  })
  it('keeps incomplete mapping, caveats and refutation explicit', () => {
    const manifest = compileSourceAnswerManifest(input(`Background without a source. [Caveat](#docatlas.v1.qualify.${locator.locatorId}) [Contrary finding](#docatlas.v1.refute.${locator.locatorId})`))!
    expect(manifest.manifestStatus).toBe('partial')
    expect(manifest.citations.map(citation => citation.relation)).toEqual(['qualify', 'refute'])
    expect(manifest.blocks[0]!.segments.map(segment => segment.status)).toEqual(['unresolved', 'qualified', 'contested'])
    expect(manifest.verificationSummary.complete).toBe(false)
  })
  it('keeps citations beyond 16 for a full-document answer', () => {
    const request = input(), locators = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(locator), locatorId: `loc:answer:${index}` }))
    request.reads = [{ ...request.reads[0]!, locators }]
    request.message.blocks = [{ index: 0, text: locators.map(item => `[Complete proposition.](#docatlas.v1.support.${item.locatorId})`).join(' ') }]
    const manifest = compileSourceAnswerManifest(request)!
    expect(manifest.citations).toHaveLength(32)
    expect(manifest.verificationSummary.warnings).not.toContain('limit-exceeded')
    expect(manifest.blocks[0]!.segments.at(-1)!.status).toBe('supported')
  })
  it('retains explicit gaps beyond the existing 128-citation contract', () => {
    const request = input(), locators = Array.from({ length: 129 }, (_, index) => ({ ...structuredClone(locator), locatorId: `loc:answer:${index}` }))
    request.reads = [{ ...request.reads[0]!, locators }]
    request.message.blocks = Array.from({ length: 3 }, (_, index) => ({ index, text: locators.slice(index * 50, (index + 1) * 50).map(item => `[Complete proposition.](#docatlas.v1.support.${item.locatorId})`).join(' ') }))
    const manifest = compileSourceAnswerManifest(request)!
    expect(manifest.citations).toHaveLength(128)
    expect(manifest.verificationSummary.warnings).toContain('limit-exceeded')
    expect(manifest.verificationSummary.complete).toBe(false)
    expect(manifest.blocks.at(-1)!.segments.at(-1)!.status).toBe('unresolved')
  })
  it('bounds large evidence payloads without publishing unresolved spans as supported', () => {
    const request = input(), exact = '文'.repeat(15000), hash = createHash('sha256').update(exact).digest('hex')
    const locators = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(locator), locatorId: `loc:large:${index}`,
      selectors: [{ type: 'text-quote' as const, exact, normalizedHash: hash }] }))
    request.reads = [{ ...request.reads[0]!, locators }]
    request.message.blocks = [{ index: 0, text: locators.map(item => `[Complete proposition.](#docatlas.v1.support.${item.locatorId})`).join(' ') }]
    const manifest = compileSourceAnswerManifest(request)!
    expect(manifest.citations.length).toBeGreaterThan(0)
    expect(manifest.citations.length).toBeLessThan(8)
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(512 * 1024)
    expect(manifest.verificationSummary.warnings).toContain('limit-exceeded')
    expect(manifest.blocks[0]!.segments.at(-1)!.status).toBe('unresolved')
  })
  it('keeps malformed markers as unclassified literal text', () => {
    expect(parseCitationSegments('[bad](#docatlas.v1.support./etc/passwd)')).toMatchObject({ malformed: true, segments: [{ kind: 'unclassified' }] })
    expect(parseCitationSegments('[**styled**](#docatlas.v1.support.loc:one)')).toMatchObject({ malformed: true })
  })
})
