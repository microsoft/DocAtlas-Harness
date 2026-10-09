import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, LibraryDocument, LibraryJobResult, ProductContinuityAssess, ProductContinuityAssessment,
  ProductContinuityImpact, ProductContinuityImpactResult, ProductContinuityInspection, ProductRevisionHistory, ProductRevisionImport, ProductRevisionImportState } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { canonicalHash } from '../src/live/state'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.restoreAllMocks() })
const raw = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}`, import.meta.url), 'utf8')) as T
const observations = raw<{ valid: ConversationSnapshot[] }>('conversation-observations.json')
const library = raw<{ document: LibraryDocument, jobResult: LibraryJobResult }>('m2/library.json')
const continuity = raw<{ bases: { selected: ProductContinuityInspection, impact: ProductContinuityImpact, impactResult: ProductContinuityImpactResult,
  assess: ProductContinuityAssess, assessment: ProductContinuityAssessment } }>('product-continuity.json').bases
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
type Call = { path: string, method: string, body: unknown, headers: Headers, signal: AbortSignal | undefined, credentials: RequestCredentials | undefined }
type Operation = 'history' | 'import' | 'status' | 'inspect' | 'impact' | 'assess'
const operations: Operation[] = ['history', 'import', 'status', 'inspect', 'impact', 'assess']

async function setup() {
  const snapshot = structuredClone(observations.valid.find(value => value.kind === 'conversation-snapshot')!)
  snapshot.runs = []; snapshot.live = []; snapshot.activity = []; snapshot.cursor.sequence = 0
  const binding = snapshot.binding
  let actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }
  const second = { ...binding, conversationId: 'conversation:second', bindingId: 'binding:second', runtimeSessionId: 'session:second' }
  const snapshots = new Map([[binding.conversationId, snapshot], [second.conversationId, { ...structuredClone(snapshot), binding: second }]])
  const frame = { conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation }
  const document = structuredClone(library.document), revision = document.currentRevision
  const command: ProductRevisionImport = { schemaVersion: 1, kind: 'revision-import', expectedGeneration: binding.generation,
    idempotencyKey: 'revision:original-key', uploadId: 'upload:one', targetDocumentId: document.documentId, expectedCurrentRevisionId: revision.revisionId }
  const state: ProductRevisionImportState = { schemaVersion: 1, kind: 'revision-import-state', ...frame, request: structuredClone(command), requestHash: await canonicalHash(command),
    job: { ...structuredClone(library.jobResult), workspaceId: actor.workspaceId } }
  const history: ProductRevisionHistory = { schemaVersion: 1, kind: 'revision-history', ...frame, documentId: document.documentId,
    currentRevisionId: revision.revisionId, versions: [{ revision, source: null, original: null }], nextCursor: null, truncated: false }
  const inspection: ProductContinuityInspection = { ...structuredClone(continuity.selected), ...frame }
  const impact: ProductContinuityImpact = { ...structuredClone(continuity.impact), expectedGeneration: binding.generation }
  const impactResult: ProductContinuityImpactResult = { ...structuredClone(continuity.impactResult), ...frame }
  const assess: ProductContinuityAssess = { ...structuredClone(continuity.assess), expectedGeneration: binding.generation }
  const source = (value: { documentId: string, revisionId: string }) => ({ ...value, representationId: `representation:${value.revisionId}`, representationContentHash: 'a'.repeat(64) })
  const assessment: ProductContinuityAssessment = { ...structuredClone(continuity.assessment), ...frame, idempotencyKey: assess.idempotencyKey, requestHash: await canonicalHash(assess),
    result: { schemaVersion: 1, resultType: 'continuity-assessed', status: 'created', link: { ...structuredClone(continuity.assessment.result.link),
      workspaceId: actor.workspaceId, createdBy: { kind: 'user', actorId: actor.actorId }, priorRecordId: assess.priorRecordId, priorRecordVersion: assess.expectedPriorVersion,
      scopeVersionId: assess.scopeVersionId, priorSources: [source(impact.previousSource)], currentSources: assess.currentSources.map(source),
      priorEvidenceIds: [...assess.priorEvidenceIds], currentEvidenceIds: [...assess.currentEvidenceIds], state: assess.proposedState, rationale: assess.rationale, verificationStatus: 'reverified' } } }
  const expected = { history, import: state, status: state, inspect: inspection, impact: impactResult, assess: assessment }
  const calls: Call[] = [], values = new Map<string, string>()
  let responder: ((call: Call) => Response | Promise<Response>) | undefined, listing: (() => Response | Promise<Response>) | undefined
  const stream: EventStream = { onerror: null, onopen: null, addEventListener() {}, close() {} }
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } }
  const client = new LiveClient({ storage, events: () => stream, fetch: (async (input, options) => {
    const path = String(input)
    if (path === '/api/bootstrap' || path === '/api/auth/exchange') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
    if (path === '/api/conversations') return listing ? listing() : json({ schemaVersion: 1, kind: 'conversation-list', items: [binding, second], nextCursor: null })
    if (path.endsWith('/snapshot')) return json(snapshots.get(decodeURIComponent(path.split('/')[3]!)))
    if (path === '/api/auth/logout') return new Response(null, { status: 204 })
    const call: Call = { path, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) as unknown : undefined,
      headers: new Headers(options?.headers), credentials: options?.credentials, signal: options?.signal ?? undefined }
    calls.push(call)
    if (responder) return responder(call)
    const operation: Operation = path.includes('/revisions') ? 'history' : path.endsWith('/revision-import') ? 'import' : path.endsWith('/revision-status') ? 'status'
      : path.endsWith('/inspect') ? 'inspect' : path.endsWith('/impact') ? 'impact' : 'assess'
    return json(expected[operation])
  }) as typeof fetch })
  cleanup.push(() => client.dispose()); await client.start()
  const invoke = (operation: Operation) => operation === 'history' ? client.revisionHistory(binding.conversationId, document.documentId)
    : operation === 'import' ? client.revisionImport(binding.conversationId, command) : operation === 'status' ? client.revisionImportStatus(binding.conversationId, command)
      : operation === 'inspect' ? client.continuityInspect(binding.conversationId, { schemaVersion: 1, kind: 'continuity-inspect', expectedGeneration: binding.generation,
        recordId: inspection.record.recordId, scopeVersionId: inspection.scopeVersionId! })
        : operation === 'impact' ? client.continuityImpact(binding.conversationId, impact) : client.continuityAssess(binding.conversationId, assess)
  const changeActor = async () => {
    const gate = Promise.withResolvers<Response>(); actor = { ...actor, actorId: 'actor:new' }; listing = () => gate.promise
    const pairing = client.pair('a'.repeat(43))
    await vi.waitFor(() => expect(client.state().actor?.actorId).toBe(actor.actorId))
    return async () => { gate.resolve(json({ schemaVersion: 1, kind: 'conversation-list', items: [], nextCursor: null })); await pairing }
  }
  return { client, binding, second, snapshots, calls, values, command, assess, impact, expected, invoke, changeActor, respond(value: typeof responder) { responder = value } }
}

it('uses fixed authenticated routes and exact original bodies without changing Pi sources, draft or durable outboxes', async () => {
  const test = await setup(), cid = test.binding.conversationId
  test.client.setSources([{ documentId: 'doc:selected', revisionId: 'revision:selected' }]); test.client.setDraft('Keep the existing question')
  const before = structuredClone(test.client.state()), stored = [...test.values]
  for (const operation of operations) await expect(test.invoke(operation)).resolves.toEqual(test.expected[operation])
  const base = `/api/conversations/${encodeURIComponent(cid)}`
  expect(test.calls.map(call => [call.path, call.method])).toEqual([
    [`${base}/documents/${encodeURIComponent(test.command.targetDocumentId)}/revisions`, 'GET'],
    [`${base}/uploads/upload%3Aone/revision-import`, 'POST'], [`${base}/uploads/upload%3Aone/revision-status`, 'POST'],
    [`${base}/continuity/inspect`, 'POST'], [`${base}/continuity/impact`, 'POST'], [`${base}/continuity/assess`, 'POST'],
  ])
  expect(test.calls.every(call => call.credentials === 'same-origin')).toBe(true)
  expect(test.calls[0]!.headers.has('x-docatlas-csrf')).toBe(false)
  expect(test.calls.slice(1).every(call => call.headers.get('x-docatlas-csrf') === 'a'.repeat(43))).toBe(true)
  expect(test.calls[1]!.body).toEqual(test.command); expect(test.calls[2]!.body).toEqual(test.command); expect(test.calls[5]!.body).toEqual(test.assess)
  expect(test.client.state()).toEqual(before); expect([...test.values]).toEqual(stored)
})

it('rejects invalid references and stale mutations locally, but permits read-only status of an old unchanged intent', async () => {
  const test = await setup(), cid = test.binding.conversationId
  for (const invalid of ['../escape', '/private.pdf', 'https://other.example', 'id?override=1']) {
    await expect(test.client.revisionHistory(cid, invalid)).rejects.toThrow()
    await expect(test.client.revisionHistory(cid, test.command.targetDocumentId, invalid)).rejects.toThrow()
    await expect(test.client.continuityInspect(cid, { schemaVersion: 1, kind: 'continuity-inspect', expectedGeneration: 1, recordId: invalid })).rejects.toThrow()
  }
  const older = { ...test.command, expectedGeneration: test.binding.generation + 1 }
  await expect(test.client.revisionImport(cid, older)).rejects.toThrow()
  await expect(test.client.continuityAssess(cid, { ...test.assess, expectedGeneration: test.binding.generation + 1 })).rejects.toThrow()
  expect(test.calls).toEqual([])
  const state = { ...test.expected.status, request: older, requestHash: await canonicalHash(older), job: null }
  test.respond(() => json(state))
  await expect(test.client.revisionImportStatus(cid, older)).resolves.toEqual(state)
  expect(test.calls).toHaveLength(1); expect(test.calls[0]!.body).toEqual(older)
})

it('rejects valid-shaped foreign identities, scopes, revisions, hashes and altered human decisions', async () => {
  const test = await setup(), inspection = test.expected.inspect, result = test.expected.assess
  const candidates: Array<[Operation, unknown]> = [
    ['history', { ...test.expected.history, documentId: 'doc:other', versions: [] }],
    ['history', { ...test.expected.history, bindingId: 'binding:other' }],
    ['history', { ...test.expected.history, generation: 2 }],
    ['status', { ...test.expected.status, job: { ...test.expected.status.job!, workspaceId: 'workspace:other' } }],
    ['import', { ...test.expected.import, job: null }],
    ['status', { ...test.expected.status, requestHash: 'f'.repeat(64) }],
    ['status', { ...test.expected.status, request: { ...test.command, expectedCurrentRevisionId: 'revision:other' } }],
    ['inspect', { ...inspection, record: { ...inspection.record, recordId: 'note:other' } }],
    ['inspect', { ...inspection, scopeVersionId: 'scope:other', scopeOptions: [{ ...inspection.scopeOptions[0]!, scopeVersionId: 'scope:other' }] }],
    ['impact', { ...test.expected.impact, currentSource: { ...test.impact.currentSource, revisionId: 'revision:other' } }],
    ['assess', { ...result, idempotencyKey: 'continuity:other-key' }], ['assess', { ...result, requestHash: 'f'.repeat(64) }],
    ...[{ priorRecordVersion: 2 }, { priorRecordId: 'claim:other' }, { rationale: 'Different human choice' }, { scopeVersionId: 'scope:other' },
      { state: 'continuing' as const }, { currentEvidenceIds: ['evidence:other'] }, { priorEvidenceIds: ['evidence:other'] },
      { workspaceId: 'workspace:other' }, { createdBy: { kind: 'user' as const, actorId: 'actor:other' } }]
      .map(change => ['assess', { ...result, result: { ...result.result, link: { ...result.result.link, ...change } } }] as [Operation, unknown]),
  ]
  const before = structuredClone(test.client.state()), stored = [...test.values]
  for (const [operation, value] of candidates) { test.respond(() => json(value)); await expect(test.invoke(operation)).rejects.toThrow() }
  expect(test.calls).toHaveLength(candidates.length); expect(test.client.state()).toEqual(before); expect([...test.values]).toEqual(stored)
})

it.each(['import', 'status', 'assess'] as const)('freezes the %s request before transport even if the caller mutates it', async operation => {
  const test = await setup(), gate = Promise.withResolvers<Response>(), original = structuredClone(operation === 'assess' ? test.assess : test.command)
  test.respond(() => gate.promise)
  const work = test.invoke(operation)
  expect(test.calls[0]!.body).toEqual(original)
  if (operation === 'assess') { test.assess.idempotencyKey = 'changed:key'; test.assess.rationale = 'Changed after sending' }
  else { test.command.idempotencyKey = 'changed:key'; test.command.expectedCurrentRevisionId = 'revision:changed' }
  gate.resolve(json(test.expected[operation])); await expect(work).resolves.toEqual(test.expected[operation])
  expect(test.calls).toHaveLength(1); expect(test.calls[0]!.body).toEqual(original)
})

it.each(operations)('rejects a late %s response after switching conversation without replaying work', async operation => {
  const test = await setup(), gate = Promise.withResolvers<Response>()
  test.respond(() => gate.promise)
  const work = test.invoke(operation), rejected = expect(work).rejects.toThrow()
  await test.client.select(test.second.conversationId)
  expect(test.calls[0]!.signal?.aborted).toBe(true)
  const before = structuredClone(test.client.state())
  gate.resolve(json(test.expected[operation])); await rejected
  expect(test.client.state()).toEqual(before); expect(test.calls).toHaveLength(1)
})

it.each(['import', 'status', 'assess'] as const)('rechecks identity after asynchronous %s receipt hashing', async operation => {
  const test = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
  const work = test.invoke(operation), rejected = expect(work).rejects.toThrow()
  await entered.promise
  const complete = await test.changeActor(), before = structuredClone(test.client.state())
  expect(test.client.state().snapshot?.binding.bindingId).toBe(test.binding.bindingId)
  release.resolve(); await rejected
  expect(test.client.state()).toEqual(before); await complete(); expect(test.calls).toHaveLength(1)
})

it.each(['status', 'inspect'] as const)('an old %s 401 cannot expire a newly paired actor; active 401 still expires', async operation => {
  const test = await setup(), gate = Promise.withResolvers<Response>()
  test.respond(() => gate.promise)
  const work = test.invoke(operation), rejected = expect(work).rejects.toThrow(), complete = await test.changeActor(), before = structuredClone(test.client.state())
  gate.resolve(json({ error: 'expired' }, 401)); await rejected
  expect(test.client.state()).toEqual(before); await complete()
  const active = await setup(); active.respond(() => json({ error: 'expired' }, 401))
  await expect(active.invoke(operation)).rejects.toThrow(); expect(active.client.state().phase).toBe('pairing')
})
