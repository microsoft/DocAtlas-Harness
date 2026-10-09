import { createHash } from 'node:crypto'

import {
  answerManifestIssues,
  answerVerificationSummary,
  type AnswerBlock,
  type AnswerManifest,
  type AnswerManifestWarning,
  type AnswerSegment,
  type CitationPresentation,
  type CitationRelation,
  type DocumentLocator,
  documentLocatorIssues,
  type EvidenceAtom,
  type ScopedSourceIdentity,
  type SourceScopeVersion,
  type SourceRole,
} from '@docatlas/contracts'
import { validateContractShape } from '@docatlas/contracts/node'

const MARKER = /\[([^\]\r\n]{1,2000})\]\(#docatlas\.v1\.(support|refute|qualify)\.([A-Za-z0-9][A-Za-z0-9._:~-]{0,127}(?:,[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}){0,7})\)/gu
const MAX_SOURCE_TEXT_CHARS = 400_000
const MAX_LOCATOR_CATALOG = 1000
const MAX_SEGMENT_CHARS = 20_000
// Match the existing v1 contract. A long summary must not lose its 17th source.
const MAX_COMPILED_CITATIONS = 128
const MAX_CITATION_BYTES = 256 * 1024
const MAX_SEGMENTS_PER_BLOCK = 128

export const DOCATLAS_ANSWER_CITATION_PROMPT = `## DocAtlas evidence citations

When you use docatlas_read, cite every material factual span that its exact returned evidence supports. Wrap only the
smallest user-visible words for that fact in this Markdown fragment form:

[the factual words](#docatlas.v1.support.LOCATOR_ID)

Use "qualify" or "refute" instead of "support" only when that relation is accurate. Several Locators with the same
relation may be comma-separated. Use only Locator IDs returned by docatlas_read in this turn; Search candidates, page
numbers, filenames, and invented IDs are not evidence. A cited span must be the smallest COMPLETE factual proposition,
including its subject and predicate — never wrap only a number or short value. Dates, source/page claims, and other
separate factual propositions each need their own mapping (the same Locator may be reused). Do not put Markdown
formatting, brackets, or a newline inside a cited span. If the evidence does not establish a claim, say so plainly
instead of citing a nearby passage. The fragment is presentation metadata: the visible answer remains the span text.`

/** Host adapters supply only successful Read receipts bound to this answer's execution.
 * The compiler does not derive execution authority from model text or a browser request.
 */
export interface AnswerReadReceipt {
  callId: string
  scopeVersionId: string
  locators: readonly DocumentLocator[]
}

export interface SourceAnswerCompileInput {
  sessionId: string
  turn: number
  scope: SourceScopeVersion
  sources: readonly ScopedSourceIdentity[]
  message: {
    id: string
    createdAt: string
    blocks: readonly { index: number, text: string }[]
  }
  reads: readonly AnswerReadReceipt[]
}

interface CatalogLocator {
  locator: DocumentLocator
  callId: string
  scopeVersionId: string
}

interface DraftSegment {
  text: string
  kind: 'factual' | 'unclassified'
  relation?: CitationRelation
  locatorIds: string[]
}

/** Host-neutral deterministic compilation; citation support remains agent-asserted, not semantic proof. */
export function compileSourceAnswerManifest(
  input: SourceAnswerCompileInput,
): AnswerManifest | undefined {
  const textBlocks = input.message.blocks.filter(block => block.text.length > 0)
  const totalChars = textBlocks.reduce((total, block) => total + block.text.length, 0)
  if (textBlocks.length === 0 || textBlocks.length > 64 || totalChars > MAX_SOURCE_TEXT_CHARS) {
    return undefined
  }

  const catalog = collectLocatorCatalog(input.reads)
  if (catalog.locators.size === 0) return undefined
  const warnings = new Set<AnswerManifestWarning>(catalog.warnings)
  const citations: CitationPresentation[] = []
  const citationsByKey = new Map<string, CitationPresentation>()
  let citationBytes = 0
  const roleByRevision = new Map(input.scope.included.map(source => [
    revisionKey(source.documentId, source.revisionId),
    source.role,
  ]))
  const sourceByRevision = new Map(input.sources.map(source => [
    revisionKey(source.documentId, source.revisionId),
    source,
  ]))
  const visibleBlocks: string[] = []
  const blocks: AnswerBlock[] = []

  for (const sourceBlock of textBlocks) {
    const parsed = parseCitationSegments(sourceBlock.text)
    if (parsed.malformed) warnings.add('malformed-marker')
    if (parsed.segments.length > MAX_SEGMENTS_PER_BLOCK) warnings.add('limit-exceeded')
    const draftSegments = parsed.segments.length <= MAX_SEGMENTS_PER_BLOCK
      ? parsed.segments
      : [
          ...parsed.segments.slice(0, MAX_SEGMENTS_PER_BLOCK - 1),
          {
            text: parsed.segments.slice(MAX_SEGMENTS_PER_BLOCK - 1)
              .map(segment => segment.text).join(''),
            kind: 'unclassified' as const,
            locatorIds: [],
          },
        ]
    const segments: AnswerSegment[] = []
    for (const draft of draftSegments) {
      const visibleCitationIds: string[] = []
      if (draft.kind === 'factual' && draft.relation !== undefined) {
        for (const locatorId of draft.locatorIds) {
          const catalogEntry = catalog.locators.get(locatorId)
          if (catalogEntry === undefined) {
            warnings.add('unknown-locator')
            continue
          }
          const key = `${draft.relation}\0${locatorId}`
          let citation = citationsByKey.get(key)
          if (citation === undefined) {
            if (citations.length >= MAX_COMPILED_CITATIONS) {
              warnings.add('limit-exceeded')
              continue
            }
            citation = buildCitation({
              messageId: input.message.id,
              relation: draft.relation,
              entry: catalogEntry,
              scope: input.scope,
              source: sourceByRevision.get(revisionKey(
                catalogEntry.locator.documentId,
                catalogEntry.locator.revisionId,
              )),
              sourceRole: roleByRevision.get(revisionKey(
                catalogEntry.locator.documentId,
                catalogEntry.locator.revisionId,
              )),
              actorId: input.sessionId,
              ordinal: citations.length + 1,
            })
            const bytes = Buffer.byteLength(JSON.stringify(citation), 'utf8')
            if (citationBytes + bytes > MAX_CITATION_BYTES) {
              warnings.add('limit-exceeded')
              continue
            }
            citationBytes += bytes
            citations.push(citation)
            citationsByKey.set(key, citation)
            if (citation.verificationStatus === 'locator-only') {
              warnings.add('locator-without-text')
            }
          }
          if (!visibleCitationIds.includes(citation.citationId)) {
            visibleCitationIds.push(citation.citationId)
          }
        }
      }
      const linked = visibleCitationIds.flatMap(id => {
        const citation = citations.find(candidate => candidate.citationId === id)
        return citation === undefined ? [] : [citation]
      })
      const status = draft.kind === 'unclassified' || linked.length === 0
        || linked.some(citation => citation.verificationStatus !== 'read-verified')
        ? 'unresolved'
        : linked.some(citation => citation.relation === 'refute')
          ? 'contested'
          : linked.some(citation => citation.relation === 'qualify')
            ? 'qualified'
            : 'supported'
      for (const piece of splitBounded(draft.text, MAX_SEGMENT_CHARS)) {
        segments.push({
          segmentId: opaqueDigest(
            'answer-segment',
            input.message.id,
            String(sourceBlock.index),
            String(segments.length),
            piece,
          ),
          text: piece,
          kind: draft.kind,
          status,
          claimVersionIds: [],
          visibleCitationIds: [...visibleCitationIds],
        })
      }
    }
    if (segments.length === 0) continue
    const visibleText = segments.map(segment => segment.text).join('')
    visibleBlocks.push(visibleText)
    blocks.push({
      blockId: opaqueDigest(
        'answer-block',
        input.message.id,
        String(sourceBlock.index),
        visibleText,
      ),
      sourceBlockIndex: sourceBlock.index,
      kind: 'prose',
      segments,
    })
  }
  if (blocks.length === 0) return undefined
  const allSegments = blocks.flatMap(block => block.segments)
  const summary = answerVerificationSummary(allSegments, citations, [...warnings])
  const manifestStatus = summary.factualSegments === 0
    ? 'unmapped'
    : summary.unresolvedSegments === 0 && summary.unclassifiedSegments === 0
      ? 'mapped'
      : 'partial'
  const createdAt = new Date(input.message.createdAt).toISOString()
  const manifest: AnswerManifest = {
    schemaVersion: 1,
    manifestId: opaqueDigest(
      'answer-manifest',
      input.sessionId,
      input.message.id,
      input.scope.scopeVersionId,
    ),
    sessionId: input.sessionId,
    workspaceId: input.scope.workspaceId,
    investigationId: input.scope.investigationId,
    messageId: input.message.id,
    turn: input.turn,
    sourceScopeVersionId: input.scope.scopeVersionId,
    mode: 'explore',
    manifestStatus,
    answerTextHash: sha256(visibleBlocks.join('\n\n')),
    blocks,
    citations,
    verificationSummary: summary,
    createdAt,
  }
  const shape = validateContractShape('answer-manifest', manifest)
  const semantics = answerManifestIssues(manifest)
  if (!shape.ok || semantics.length > 0) {
    const detail = shape.ok ? semantics[0]?.message : shape.issues[0]?.message
    throw new Error(`compiled AnswerManifest failed its canonical contract: ${detail ?? 'unknown issue'}`)
  }
  return manifest
}

export function parseCitationSegments(text: string): {
  segments: DraftSegment[]
  malformed: boolean
} {
  const segments: DraftSegment[] = []
  let cursor = 0
  MARKER.lastIndex = 0
  for (;;) {
    const match = MARKER.exec(text)
    if (match === null) break
    const before = text.slice(cursor, match.index)
    const label = match[1]!
    if (before.length > 0) appendUnclassified(segments, before)
    if (/[*_`\u005B\u005D\\]/u.test(label)) {
      appendUnclassified(segments, match[0])
      cursor = match.index + match[0].length
      continue
    }
    segments.push({
      text: label,
      kind: 'factual',
      relation: match[2] as CitationRelation,
      locatorIds: match[3]!.split(','),
    })
    cursor = match.index + match[0].length
  }
  const tail = text.slice(cursor)
  if (tail.length > 0) appendUnclassified(segments, tail)
  const malformed = segments.some(segment =>
    segment.kind === 'unclassified' && segment.text.includes('#docatlas.v1.'))
  return { segments, malformed }
}

function collectLocatorCatalog(
  reads: readonly AnswerReadReceipt[],
): { locators: Map<string, CatalogLocator>, warnings: AnswerManifestWarning[] } {
  const locators = new Map<string, CatalogLocator>()
  const scopes = new Set<string>()
  let conflict = false
  for (const read of reads) {
    scopes.add(read.scopeVersionId)
    for (const locator of read.locators) {
      if (locators.size >= MAX_LOCATOR_CATALOG) break
      if (documentLocatorIssues(locator).length > 0) continue
      const current = locators.get(locator.locatorId)
      const entry = {
        locator,
        callId: read.callId,
        scopeVersionId: read.scopeVersionId,
      }
      if (current !== undefined && JSON.stringify(current.locator) !== JSON.stringify(locator)) {
        conflict = true
        continue
      }
      locators.set(locator.locatorId, entry)
    }
  }
  return {
    locators,
    warnings: conflict || scopes.size > 1 ? ['scope-conflict'] : [],
  }
}

function buildCitation(input: {
  messageId: string
  relation: CitationRelation
  entry: CatalogLocator
  scope: SourceScopeVersion
  source: ScopedSourceIdentity | undefined
  sourceRole: SourceRole | undefined
  actorId: string
  ordinal: number
}): CitationPresentation {
  const citationId = opaqueDigest(
    'citation',
    input.messageId,
    input.relation,
    input.entry.locator.locatorId,
  )
  const evidence = buildEvidence(input)
  return {
    citationId,
    ordinal: input.ordinal,
    relation: input.relation,
    relationAssertedBy: { kind: 'agent', actorId: input.actorId },
    focusId: input.entry.locator.locatorId,
    locator: input.entry.locator,
    verificationStatus: evidence === undefined ? 'locator-only' : 'read-verified',
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function buildEvidence(input: {
  entry: CatalogLocator
  scope: SourceScopeVersion
  source: ScopedSourceIdentity | undefined
  sourceRole: SourceRole | undefined
  actorId: string
}): EvidenceAtom | undefined {
  const locator = input.entry.locator
  const quote = locator.selectors.find(selector => selector.type === 'text-quote')
  if (quote?.type !== 'text-quote'
    || sha256(quote.exact) !== quote.normalizedHash
    || input.entry.scopeVersionId !== input.scope.scopeVersionId
    || input.sourceRole === undefined
    || input.source === undefined
    || input.source.documentId !== locator.documentId
    || input.source.revisionId !== locator.revisionId
    || input.source.representationId !== locator.representationId
    || input.source.representationContentHash !== locator.representationContentHash) return undefined
  const kind = locator.selectors.some(selector => selector.type === 'table-cell')
    ? 'table-cell'
    : locator.selectors.some(selector => selector.type === 'figure')
      ? 'figure'
      : 'quote'
  return {
    schemaVersion: 1,
    evidenceId: opaqueDigest('evidence', locator.locatorId, quote.normalizedHash),
    documentId: locator.documentId,
    revisionId: locator.revisionId,
    representationId: locator.representationId,
    locatorId: locator.locatorId,
    kind,
    content: { mediaType: 'text/plain', text: quote.exact },
    contentHash: quote.normalizedHash,
    sourceRole: input.sourceRole,
    resolutionStatus: 'resolved',
    status: 'current',
    createdBy: { kind: 'agent', actorId: input.actorId },
    provenanceActivityId: opaqueDigest('activity', input.entry.callId),
    createdAt: locator.createdAt,
  }
}

function appendUnclassified(segments: DraftSegment[], text: string): void {
  if (text.length === 0) return
  if (isStructural(text) && segments.length > 0) {
    segments[segments.length - 1]!.text += text
    return
  }
  segments.push({ text, kind: 'unclassified', locatorIds: [] })
}

function isStructural(text: string): boolean {
  return /^[\s.,;:!?，。；：！？、（）()\u005B\u005D{}“”‘’'"—–-]*$/u.test(text)
}

function splitBounded(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + limit)
    if (end < text.length
      && /[\uDC00-\uDFFF]/u.test(text[end]!)
      && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1
    parts.push(text.slice(cursor, end))
    cursor = end
  }
  return parts
}

function revisionKey(documentId: string, revisionId: string): string {
  return `${documentId}\0${revisionId}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function opaqueDigest(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(parts.join('\0')).slice(0, 32)}`
}
