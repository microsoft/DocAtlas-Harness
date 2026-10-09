import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import type { EnrichmentResult, EnrichmentStart } from '@docatlas/contracts'
import { enrichmentHash } from '@docatlas/core'
import { ControlStore } from '../src/storage/control-store.js'
import { EnrichmentJobs } from '../src/storage/enrichment-jobs.js'

it('persists idempotent queued jobs, fences unclean/cross-process claims, and never replays a terminal job', () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-enrichment-store-')), control = ControlStore.open(join(root, 'control')), actor = { actorId: 'actor:one', workspaceId: 'workspace:one' }
  const binding = control.createManagedConversation(actor, 'enrichment:conversation').binding
  let jobs = new EnrichmentJobs(join(root, 'jobs'))
  try {
    const request: EnrichmentStart = { schemaVersion: 1, kind: 'enrichment-start', idempotencyKey: 'enrich:storage-case', documentId: 'doc:one', revisionId: 'rev:one', baseMode: 'merge', mode: 'summary', nodeIds: ['tree:one:node'],
      budget: { maxNodes: 8, maxPages: 8, maxModelCalls: 4, maxInputChars: 20000, maxOutputTokens: 1024, maxOutputChars: 4000, wallMs: 60000 } }
    const first = jobs.accept(binding, request)
    expect(jobs.accept(binding, request)).toEqual(first)
    expect(() => jobs.accept(binding, { ...request, mode: 'expand' })).toThrow('different request')
    jobs.close(); jobs = new EnrichmentJobs(join(root, 'jobs'))
    expect(jobs.get(binding, first.jobId).state).toBe('queued')
    const claim = jobs.claim(binding, first.jobId), second = new EnrichmentJobs(join(root, 'jobs'))
    try { expect(() => second.claim(binding, first.jobId)).toThrow('owner'); expect(() => second.get({ ...binding, ownerActorId: 'actor:other' }, first.jobId)).toThrow('accessible') } finally { second.close() }
    expect(() => jobs.generating(binding, first.jobId, 'forged', 'a'.repeat(64))).toThrow('claim')
    jobs.generating(binding, first.jobId, claim.token, 'a'.repeat(64))
    jobs.close(); jobs = new EnrichmentJobs(join(root, 'jobs'))
    expect(jobs.get(binding, first.jobId).state).toBe('generating')
    expect(() => jobs.claim(binding, first.jobId)).toThrow('owner')
    expect(() => jobs.cancelQueued(binding, first.jobId)).toThrow('unowned')
    jobs.finish(binding, first.jobId, claim.token, 'cancelled', null, null)
    expect(jobs.accept(binding, request).state).toBe('cancelled')
    expect(() => jobs.claim(binding, first.jobId)).toThrow('terminal')
  } finally { jobs.close(); control.close(); rmSync(root, { recursive: true, force: true }) }
})

it('keeps absent-recipe queued and completed v1 records unchanged across reopen and refuses cross-recipe original keys', () => {
  const { bases } = JSON.parse(readFileSync('contracts/fixtures/document/enrichment.json', 'utf8')) as { bases: { request: EnrichmentStart, result: EnrichmentResult } }
  const root = mkdtempSync(join(tmpdir(), 'docatlas-enrichment-v1-')), control = ControlStore.open(join(root, 'control'))
  const actor = { actorId: 'actor:legacy', workspaceId: 'workspace:legacy' }, binding = control.createManagedConversation(actor, 'enrichment:legacy:conversation').binding
  let jobs = new EnrichmentJobs(join(root, 'jobs'))
  try {
    const request = structuredClone(bases.request), queued = jobs.accept(binding, request)
    expect(Object.hasOwn(request, 'recipe')).toBe(false)
    jobs.close(); jobs = new EnrichmentJobs(join(root, 'jobs'))
    expect(jobs.get(binding, queued.jobId)).toEqual(queued); expect(Object.hasOwn(jobs.get(binding, queued.jobId).request, 'recipe')).toBe(false)
    expect(() => jobs.accept(binding, { ...request, recipe: 'docatlas-flash-enrichment.v2' })).toThrow('different request')
    const claim = jobs.claim(binding, queued.jobId), result = structuredClone(bases.result)
    const { resultHash: _unused, ...unsigned } = result; result.resultHash = enrichmentHash(unsigned)
    jobs.generating(binding, queued.jobId, claim.token, result.inputHash)
    jobs.finish(binding, queued.jobId, claim.token, 'completed', result, null)
    const sealed = JSON.stringify(jobs.get(binding, queued.jobId)), hash = result.resultHash
    jobs.close(); jobs = new EnrichmentJobs(join(root, 'jobs'))
    expect(JSON.stringify(jobs.get(binding, queued.jobId))).toBe(sealed)
    expect(JSON.stringify(jobs.accept(binding, request))).toBe(sealed)
    expect(jobs.get(binding, queued.jobId).result).toMatchObject({ recipe: 'docatlas-flash-enrichment.v1', resultHash: hash })
    expect(() => jobs.accept(binding, { ...request, recipe: 'docatlas-flash-enrichment.v2' })).toThrow('different request')
    expect(() => jobs.claim(binding, queued.jobId)).toThrow('terminal')
  } finally { jobs.close(); control.close(); rmSync(root, { recursive: true, force: true }) }
})

it('persists an explicit v2 seal and rolls back a completed-result recipe mismatch without releasing its claim', () => {
  const { bases } = JSON.parse(readFileSync('contracts/fixtures/document/enrichment.json', 'utf8')) as { bases: { request: EnrichmentStart, result: EnrichmentResult } }
  const root = mkdtempSync(join(tmpdir(), 'docatlas-enrichment-v2-')), control = ControlStore.open(join(root, 'control'))
  const actor = { actorId: 'actor:v2', workspaceId: 'workspace:v2' }, binding = control.createManagedConversation(actor, 'enrichment:v2:conversation').binding
  let jobs = new EnrichmentJobs(join(root, 'jobs'))
  try {
    const request: EnrichmentStart = { ...bases.request, recipe: 'docatlas-flash-enrichment.v2' }, queued = jobs.accept(binding, request), claim = jobs.claim(binding, queued.jobId)
    // Storage-only vector: recompute real hashes, without claiming this fixture
    // is a model call or a verified PDF transformation (the host test does that).
    const result = structuredClone(bases.result), previousId = result.enrichmentId
    result.recipe = 'docatlas-flash-enrichment.v2'; result.inputHash = enrichmentHash({ request, fixture: 'sealed-storage-only' })
    result.enrichmentId = `enrichment:${enrichmentHash([queued.jobId, result.inputHash, result.recipe]).slice(0, 32)}`
    result.nodes = result.nodes.map(node => ({ ...node, nodeId: node.nodeId.replace(previousId, result.enrichmentId), parentId: node.parentId?.replace(previousId, result.enrichmentId) ?? null }))
    const { resultHash: _unused, ...unsigned } = result; result.resultHash = enrichmentHash(unsigned)
    jobs.generating(binding, queued.jobId, claim.token, result.inputHash)
    const mismatched = { ...result, recipe: 'docatlas-flash-enrichment.v1' as const }, { resultHash: _old, ...wrongUnsigned } = mismatched
    mismatched.resultHash = enrichmentHash(wrongUnsigned)
    expect(() => jobs.finish(binding, queued.jobId, claim.token, 'completed', mismatched, null)).toThrow('Invalid enrichment job')
    expect(jobs.get(binding, queued.jobId).state).toBe('generating'); jobs.assertOwner(binding, queued.jobId, claim.token)
    jobs.finish(binding, queued.jobId, claim.token, 'completed', result, null)
    const before = JSON.stringify(jobs.get(binding, queued.jobId))
    jobs.close(); jobs = new EnrichmentJobs(join(root, 'jobs'))
    expect(JSON.stringify(jobs.get(binding, queued.jobId))).toBe(before); expect(jobs.accept(binding, request).result).toEqual(result)
    const { recipe: _recipe, ...legacy } = request
    expect(() => jobs.accept(binding, legacy)).toThrow('different request')
  } finally { jobs.close(); control.close(); rmSync(root, { recursive: true, force: true }) }
})
