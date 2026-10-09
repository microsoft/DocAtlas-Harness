import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { DocAtlasToolMetaV1, DocumentLocator, ProductPiCheckpoint, ReadResult, SourceScopeVersion } from '@docatlas/contracts'
import { projectCheckpointAnswer, type CheckpointAnswerInput } from '../src/answer-projector.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const canonical = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m0/canonical-slice.json', import.meta.url), 'utf8')) as { quoteLocator: DocumentLocator, sourceScope: SourceScopeVersion }
const nativeSessionId = '00000000-0000-4000-8000-000000000000', timestamp = '2026-09-09T01:00:00Z'

function fixture() {
  const locator = structuredClone(canonical.quoteLocator), scope = structuredClone(canonical.sourceScope)
  const source = { documentId: locator.documentId, revisionId: locator.revisionId, representationId: locator.representationId, representationContentHash: locator.representationContentHash }
  const result: ReadResult = { schemaVersion: 1, resultType: 'read', mode: 'page', source: { documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId },
    textQuality: 'usable', items: [{ itemType: 'block', blockId: 'p00017.b00004.text.abc123', physicalPage: 17, kind: 'paragraph', text: 'Revenue increased by 12%.', locator }],
    pageInfo: { schemaVersion: 1, limit: 20, returned: 1, total: 1, usedChars: 24, truncated: false, completeness: 'complete' } }
  const input: CheckpointAnswerInput = { sessionId: 'conversation:answer', turn: 1, scope, sources: [source], reads: [{ callId: 'call:read', scopeVersionId: scope.scopeVersionId, result, locators: [locator] }] }
  const details: DocAtlasToolMetaV1 = { schemaVersion: 1, schema: 'docatlas.tool-meta.v1', operation: 'read', scopeVersionId: scope.scopeVersionId, documentIds: [source.documentId], locators: [structuredClone(locator)], assetIds: [], uiSummary: '1 source items (usable)', truncated: false }
  const entries: Record<string, unknown>[] = [
    { type: 'message', id: '11111111', parentId: null, timestamp, message: { role: 'user', content: 'What changed?' } },
    { type: 'message', id: '22222222', parentId: '11111111', timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call:read', name: 'docatlas_read', arguments: { documentId: source.documentId, mode: 'page', physicalPage: 17 } }] } },
    { type: 'message', id: '33333333', parentId: '22222222', timestamp, message: { role: 'toolResult', toolCallId: 'call:read', toolName: 'docatlas_read', isError: false, content: [{ type: 'text', text: JSON.stringify(result) }], details } },
    { type: 'message', id: '44444444', parentId: '33333333', timestamp, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'private thinking must not project' }, { type: 'text', text: `[Revenue increased by 12%.](#docatlas.v1.support.${locator.locatorId})` }] } },
  ]
  const root = mkdtempSync(join(tmpdir(), 'docatlas-answer-projection-')); directories.push(root)
  const file = join(root, 'session.jsonl')
  const save = (): ProductPiCheckpoint => {
    const bytes = Buffer.from([{ type: 'session', version: 3, id: nativeSessionId, cwd: '/work' }, ...entries].map(value => JSON.stringify(value)).join('\n') + '\n')
    writeFileSync(file, bytes)
    return { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: 'submission:answer', runtimeSessionId: nativeSessionId, requestHash: 'a'.repeat(64), userEntryId: '11111111', leafEntryId: '44444444',
      byteLength: bytes.length, entryCount: entries.length, transcriptHash: createHash('sha256').update(bytes).digest('hex'), settledAt: timestamp }
  }
  const toolResult = entries[2]!.message as Record<string, unknown>, call = ((entries[1]!.message as Record<string, unknown>).content as Record<string, unknown>[])[0]!
  return { input, entries, file, save, toolResult, call, result, details }
}

it('projects native message identity and only host-attested Read locators from the exact verified branch', () => {
  const f = fixture(), before = structuredClone(f.input), checkpoint = f.save()
  const manifest = projectCheckpointAnswer(f.file, checkpoint, f.input)!
  expect(manifest).toMatchObject({ sessionId: f.input.sessionId, messageId: '44444444', turn: 1, manifestStatus: 'mapped',
    citations: [{ verificationStatus: 'read-verified', evidence: { content: { text: 'Revenue increased by 12%.' } } }],
    blocks: [{ sourceBlockIndex: 1, segments: [{ text: 'Revenue increased by 12%.', status: 'supported' }] }],
  })
  expect(JSON.stringify(manifest)).not.toContain('private thinking')
  expect(f.input).toEqual(before)
  appendFileSync(f.file, JSON.stringify({ type: 'message', id: '55555555', parentId: '44444444', message: { role: 'user', content: 'Next turn' } }) + '\n')
  expect(projectCheckpointAnswer(f.file, checkpoint, f.input)).toEqual(manifest)
  writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('What changed?', 'tampered input'))
  expect(() => projectCheckpointAnswer(f.file, checkpoint, f.input)).toThrow('hash mismatch')
})

it.each(['missing-host', 'forged-details', 'forged-text', 'extra-prose', 'wrong-scope', 'wrong-source', 'failed', 'locate', 'search', 'mismatched-tool', 'duplicate-host'] as const)('does not turn %s into an evidence catalog', variant => {
  const f = fixture()
  if (variant === 'missing-host') f.input.reads = []
  if (variant === 'forged-details') f.details.locators = [{ ...f.input.reads[0]!.locators[0]!, physicalPage: 18 }]
  if (variant === 'forged-text') f.toolResult.content = [{ type: 'text', text: JSON.stringify({ ...f.result, textQuality: 'partial' }) }]
  if (variant === 'extra-prose') (f.toolResult.content as unknown[]).push({ type: 'text', text: 'Worker-invented extra quote' })
  if (variant === 'wrong-scope') f.input.reads = [{ ...f.input.reads[0]!, scopeVersionId: 'scope:old' }]
  if (variant === 'wrong-source') f.input.sources = [{ ...f.input.sources[0]!, representationContentHash: 'f'.repeat(64) }]
  if (variant === 'failed') f.toolResult.isError = true
  if (variant === 'locate') { f.result.mode = 'locate'; (f.call.arguments as Record<string, unknown>).mode = 'locate'; f.toolResult.content = [{ type: 'text', text: JSON.stringify(f.result) }] }
  if (variant === 'search') { f.call.name = 'docatlas_search'; f.toolResult.toolName = 'docatlas_search' }
  if (variant === 'mismatched-tool') f.toolResult.toolName = 'read'
  if (variant === 'duplicate-host') f.input.reads = [f.input.reads[0]!, f.input.reads[0]!]
  expect(projectCheckpointAnswer(f.file, f.save(), f.input)).toBeUndefined()
})

it('excludes prior-turn read receipts even if the same locator is named again', () => {
  const f = fixture()
  f.entries[0]!.id = '00000001'; f.entries[1]!.parentId = '00000001'
  f.entries.splice(3, 0, { type: 'message', id: '11111111', parentId: '33333333', timestamp, message: { role: 'user', content: 'New submission, no new Read' } })
  f.entries.at(-1)!.parentId = '11111111'
  expect(projectCheckpointAnswer(f.file, f.save(), f.input)).toBeUndefined()
})

it.each(['compaction', 'branch_summary', 'steering-user', 'custom-message'] as const)('leaves a projection gap across an unproved %s boundary', kind => {
  const f = fixture()
  const inserted = kind === 'steering-user' || kind === 'custom-message'
    ? { type: 'message', id: '55555555', parentId: '33333333', timestamp, message: { role: kind === 'steering-user' ? 'user' : 'custom', content: 'attribution changes' } }
    : { type: kind, id: '55555555', parentId: '33333333', timestamp, summary: 'Not an evidence receipt' }
  f.entries.splice(3, 0, inserted); f.entries.at(-1)!.parentId = '55555555'
  expect(projectCheckpointAnswer(f.file, f.save(), f.input)).toBeUndefined()
})

it('refuses outstanding or duplicate native calls and a tool-using final answer', () => {
  for (const variant of ['outstanding', 'duplicate', 'final-tool'] as const) {
    const f = fixture(), calls = (f.entries[1]!.message as { content: unknown[] }).content
    if (variant === 'duplicate') calls.push(structuredClone(f.call))
    if (variant === 'outstanding') calls.push({ type: 'toolCall', id: 'call:pending', name: 'bash', arguments: { command: 'true' } })
    if (variant === 'final-tool') (f.entries.at(-1)!.message as { content: unknown[] }).content.push({ type: 'toolCall', id: 'call:last', name: 'bash', arguments: {} })
    expect(projectCheckpointAnswer(f.file, f.save(), f.input)).toBeUndefined()
  }
})

it('preserves normal native tool execution without admitting its output as document evidence', () => {
  const f = fixture()
  f.entries.splice(3, 0,
    { type: 'message', id: '55555555', parentId: '33333333', timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call:native', name: 'bash', arguments: { command: 'printf native' } }] } },
    { type: 'message', id: '66666666', parentId: '55555555', timestamp, message: { role: 'toolResult', toolCallId: 'call:native', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'native' }] } })
  f.entries.at(-1)!.parentId = '66666666'
  expect(projectCheckpointAnswer(f.file, f.save(), f.input)).toMatchObject({ messageId: '44444444', citations: [{ verificationStatus: 'read-verified' }] })
})

it.each(['label', 'custom', 'model_change', 'thinking_level_change', 'session_info'])('keeps %s native metadata after an answer without replacing its message identity', type => {
  const f = fixture()
  f.entries.push({ type, id: '77777777', parentId: '44444444', timestamp, data: { arbitraryMetadata: 'not evidence' } })
  const checkpoint = { ...f.save(), leafEntryId: '77777777' }
  expect(projectCheckpointAnswer(f.file, checkpoint, f.input)).toMatchObject({ messageId: '44444444', citations: [{ verificationStatus: 'read-verified' }] })
})
