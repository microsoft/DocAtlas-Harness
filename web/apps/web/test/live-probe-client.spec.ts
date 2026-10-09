import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { AnswerManifest, ConversationSnapshot, MemoryCandidate, ProductPiCheckpoint, ProductProbeChoose, ProductProbeChoiceResult, ProductProbeInspect,
  ProductProbePrepare, ProductProbeReview, ProductProbeReviewResult, ProductProbeView } from '@docatlas/contracts'
import { controlledProbeMaterial, createControlledProbe } from '../../../packages/core/src/personalization/controlled-presentation'
import { LiveClient, type EventStream } from '../src/live/client'
import { canonicalHash } from '../src/live/state'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.restoreAllMocks() })
const raw = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}`, import.meta.url), 'utf8')) as T
const snapshotsFixture = raw<{ valid: ConversationSnapshot[] }>('conversation-observations.json')
const checkpoint = raw<{ valid: ProductPiCheckpoint[] }>('product/control.json').valid.find(value => value.kind === 'pi-checkpoint')!
const answer = raw<{ manifest: AnswerManifest }>('m2/answer-manifest.json').manifest
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
type Operation = 'inspect' | 'prepare' | 'choose' | 'review'
const operations: Operation[] = ['inspect', 'prepare', 'choose', 'review']
type Call = { path: string, body: unknown, headers: Headers, credentials: RequestCredentials | undefined }
async function setup() {
  const snapshot = structuredClone(snapshotsFixture.valid.find(value => value.kind === 'conversation-snapshot')!)
  snapshot.runs = []; snapshot.live = []; snapshot.activity = []; snapshot.cursor.sequence = 0
  const binding = snapshot.binding, manifest = { ...structuredClone(answer), sessionId: binding.conversationId, workspaceId: binding.workspaceId }
  const nativeText = 'Original native answer contains the complete citation marker.'
  snapshot.history.messages = [{ entryId: manifest.messageId, role: 'assistant', text: nativeText, truncated: false }]
  snapshot.history.checkpoint = { ...structuredClone(checkpoint), runtimeSessionId: binding.runtimeSessionId, leafEntryId: manifest.messageId }
  const second = { ...binding, conversationId: 'conversation:probe-other', bindingId: 'binding:probe-other', runtimeSessionId: 'session:probe-other' }
  const secondSnapshot = { ...structuredClone(snapshot), binding: second }; secondSnapshot.history.checkpoint!.runtimeSessionId = second.runtimeSessionId
  const snapshots = new Map([[binding.conversationId, snapshot], [second.conversationId, secondSnapshot]])
  let actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }
  const profileId = `profile:pi:${(await canonicalHash([actor.actorId, actor.workspaceId])).slice(0, 32)}`
  const material = controlledProbeMaterial(manifest, createHash('sha256').update(nativeText).digest('hex'))
  const probe = createControlledProbe({ material, profileId, profileEpoch: 0, evidenceFirstOnLeft: true, generatedAt: binding.createdAt })
  const frame = { schemaVersion: 1 as const, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation, profileEpoch: 0, messageId: manifest.messageId }
  const inspect: ProductProbeInspect = { schemaVersion: 1, kind: 'probe-inspect', expectedGeneration: binding.generation, messageId: manifest.messageId }
  const prepare: ProductProbePrepare = { ...inspect, kind: 'probe-prepare', expectedProfileEpoch: 0, expectedPolicyVersion: 1 }
  const choose: ProductProbeChoose = { ...prepare, kind: 'probe-choose', probeId: probe.probeId, idempotencyKey: 'choice:original', selected: probe.presentationOrder[0]!, scopeIntent: 'workspace', reasonTags: ['easier-verification'] }
  const review: ProductProbeReview = { ...inspect, kind: 'probe-review', expectedProfileEpoch: 0, probeId: probe.probeId, candidateId: 'candidate:original', expectedCandidateVersion: 1, decision: 'reject', idempotencyKey: 'review:original' }
  const view: ProductProbeView = { ...frame, kind: 'probe-view', reason: 'ready', contributionAllowed: true, policyVersion: 1, material, probe, choiceReceipt: null, candidate: null }
  const choiceResult: ProductProbeChoiceResult = { ...frame, kind: 'probe-choice-result', probeId: probe.probeId, status: 'created', idempotencyKey: choose.idempotencyKey, requestHash: await canonicalHash(choose), candidateId: review.candidateId,
    choice: { schemaVersion: 1, recordType: 'preference-choice-observation', choiceObservationId: 'choice:stored', probeId: probe.probeId, profileId, sessionId: binding.conversationId, turn: manifest.turn,
      selected: choose.selected, scopeIntent: choose.scopeIntent, reasonTags: choose.reasonTags, consent: { basis: 'session-policy', retention: 'eligible' }, occurredAt: binding.createdAt } }
  const candidate: MemoryCandidate = { schemaVersion: 1, recordType: 'memory-candidate', candidateId: review.candidateId, profileId, version: 2, proposedMemoryType: 'presentation-preference',
    proposedEffect: { key: 'answer-order', value: 'evidence-first' }, proposedScope: { kind: 'workspace', profileId, workspaceId: actor.workspaceId }, observationIds: ['observation:original'], independentLineageCount: 1,
    counterObservationIds: [], formation: 'preference-probe', risk: 'low', sensitivity: 'ordinary', decision: 'reject', rationaleCode: 'user-rejected', decidedBy: { kind: 'user', actorId: actor.actorId }, decidedAt: binding.createdAt, createdAt: binding.createdAt }
  const reviewResult: ProductProbeReviewResult = { ...frame, kind: 'probe-review-result', probeId: probe.probeId, idempotencyKey: review.idempotencyKey, requestHash: await canonicalHash(review),
    result: { schemaVersion: 1, resultType: 'personalization-command', profileId, action: 'review-candidate', status: 'updated', candidate } }
  const requests = { inspect, prepare, choose, review }, results = { inspect: view, prepare: view, choose: choiceResult, review: reviewResult }, calls: Call[] = [], stored = new Map<string, string>()
  let respond: ((call: Call) => Response | Promise<Response>) | undefined, listing: (() => Response | Promise<Response>) | undefined
  const stream: EventStream = { addEventListener() {}, close() {}, onopen: null, onerror: null }
  const client = new LiveClient({ storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value) }, removeItem: key => { stored.delete(key) }, key: index => [...stored.keys()][index] ?? null, get length() { return stored.size } }, events: () => stream,
    fetch: (async (input, options) => {
      const path = String(input)
      if (path === '/api/bootstrap' || path === '/api/auth/exchange') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
      if (path === '/api/conversations') return listing ? listing() : json({ schemaVersion: 1, kind: 'conversation-list', items: [binding, second], nextCursor: null })
      if (path.endsWith('/snapshot')) return json(snapshots.get(decodeURIComponent(path.split('/')[3]!)))
      if (path === '/api/auth/logout') return new Response(null, { status: 204 })
      const call = { path, body: JSON.parse(String(options?.body)) as unknown, headers: new Headers(options?.headers), credentials: options?.credentials }; calls.push(call)
      return respond ? respond(call) : json(results[path.split('/').at(-1) as Operation])
    }) as typeof fetch })
  cleanup.push(() => client.dispose()); await client.start()
  expect(client.state().phase).toBe('ready'); expect(client.state().snapshot?.binding.bindingId).toBe(binding.bindingId)
  const invoke = (operation: Operation) => operation === 'inspect' ? client.probeInspect(binding.conversationId, inspect) : operation === 'prepare' ? client.probePrepare(binding.conversationId, prepare)
    : operation === 'choose' ? client.probeChoose(binding.conversationId, choose) : client.probeReview(binding.conversationId, review)
  const changeActor = async () => {
    actor = { ...actor, actorId: 'actor:new' }; const gate = Promise.withResolvers<Response>(); listing = () => gate.promise
    const pairing = client.pair('a'.repeat(43)); await vi.waitFor(() => expect(client.state().actor?.actorId).toBe(actor.actorId))
    return async () => { gate.resolve(json({ schemaVersion: 1, kind: 'conversation-list', items: [], nextCursor: null })); await pairing }
  }
  return { client, binding, second, snapshots, requests, results, calls, stored, profileId, invoke, changeActor, respond(value: typeof respond) { respond = value } }
}

it('uses four fixed authenticated routes, binds real native text and leaves native sources/drafts/outboxes unchanged', async () => {
  const test = await setup(); test.client.setDraft('Untouched native question'); test.client.setSources([{ documentId: 'doc:chosen', revisionId: 'revision:chosen' }])
  const before = structuredClone(test.client.state()), stored = [...test.stored]
  for (const operation of operations) await expect(test.invoke(operation)).resolves.toEqual(test.results[operation])
  expect(test.calls.map(call => call.path)).toEqual(operations.map(operation => `/api/conversations/${encodeURIComponent(test.binding.conversationId)}/preferences/probes/${operation}`))
  expect(test.calls.every(call => call.credentials === 'same-origin' && call.headers.get('x-docatlas-csrf') === 'a'.repeat(43))).toBe(true)
  expect(test.client.state()).toEqual(before); expect([...test.stored]).toEqual(stored)
})

it('rejects ready-looking, self-consistently rehashed material that belongs to another native Answer or profile', async () => {
  const test = await setup(), view = test.results.inspect, original = view.material!
  for (const foreign of ['native', 'profile']) {
    const material = controlledProbeMaterial(original.manifest, foreign === 'native' ? 'f'.repeat(64) : original.nativeTextHash)
    const probe = createControlledProbe({ material, profileId: foreign === 'profile' ? 'profile:foreign' : test.profileId, profileEpoch: 0, evidenceFirstOnLeft: true, generatedAt: test.binding.createdAt })
    test.respond(() => json({ ...view, material, probe })); await expect(test.invoke('inspect')).rejects.toThrow()
  }
  expect(test.calls).toHaveLength(2)
})

it('rejects wrong operation/body hash/epoch/selection/candidate receipts without updating state or retrying', async () => {
  const test = await setup(), choice = test.results.choose, reviewed = test.results.review
  const cases: Array<[Operation, unknown]> = [
    ['prepare', { ...test.results.prepare, probe: null }], ['prepare', { ...test.results.prepare, profileEpoch: 2 }], ['inspect', { ...test.results.inspect, bindingId: 'binding:foreign' }],
    ['choose', { ...choice, requestHash: 'f'.repeat(64) }], ['choose', { ...choice, idempotencyKey: 'key:foreign' }], ['choose', { ...choice, choice: { ...choice.choice, selected: 'variant:answer-first' } }],
    ['choose', { ...choice, choice: { ...choice.choice, consent: { basis: 'user-explicit', retention: 'eligible' } } }], ['choose', { ...choice, candidateId: null }],
    ['review', { ...reviewed, requestHash: 'f'.repeat(64) }], ['review', { ...reviewed, result: { ...reviewed.result, candidate: { ...reviewed.result.candidate, version: 3 } } }],
    ['review', { ...reviewed, result: { ...reviewed.result, candidate: { ...reviewed.result.candidate, proposedScope: { kind: 'workspace', profileId: test.profileId, workspaceId: 'workspace:foreign' } } } }],
  ]
  const before = structuredClone(test.client.state())
  for (const [operation, value] of cases) { test.respond(() => json(value)); await expect(test.invoke(operation)).rejects.toThrow() }
  expect(test.calls).toHaveLength(cases.length); expect(test.client.state()).toEqual(before)
})

it('refuses unowned, incomplete, missing or stale Answer requests before transport', async () => {
  const test = await setup(), cid = test.binding.conversationId
  await expect(test.client.probeInspect(test.second.conversationId, test.requests.inspect)).rejects.toThrow()
  await expect(test.client.probeInspect(cid, { ...test.requests.inspect, messageId: '/private.pdf' })).rejects.toThrow()
  await expect(test.client.probePrepare(cid, { ...test.requests.prepare, expectedGeneration: 2 })).rejects.toThrow()
  const snapshot = test.snapshots.get(cid)!; snapshot.history.messages[0]!.truncated = true; await test.client.refresh()
  for (const operation of operations) await expect(test.invoke(operation)).rejects.toThrow()
  expect(test.calls).toEqual([])
})

it.each(['choose', 'review'] as const)('freezes %s before caller mutation and preserves the original command hash', async operation => {
  const test = await setup(), gate = Promise.withResolvers<Response>(), original = structuredClone(test.requests[operation])
  test.respond(() => gate.promise); const work = test.invoke(operation)
  test.requests[operation].idempotencyKey = 'mutated:key'
  gate.resolve(json(test.results[operation])); await expect(work).resolves.toEqual(test.results[operation])
  expect(test.calls[0]!.body).toEqual(original); expect(test.calls).toHaveLength(1)
})

it.each(operations)('fences a new paired actor during asynchronous %s response hashing', async operation => {
  const test = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), digest = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); entered.resolve(); await release.promise; return value })
  const work = test.invoke(operation), rejected = expect(work).rejects.toThrow(); await entered.promise
  const complete = await test.changeActor(), before = structuredClone(test.client.state())
  release.resolve(); await rejected; expect(test.client.state()).toEqual(before); await complete()
})

it('discards late unauthorized responses without expiring a newly paired actor', async () => {
  const test = await setup(), gate = Promise.withResolvers<Response>()
  test.respond(() => gate.promise); const work = test.invoke('inspect'), rejected = expect(work).rejects.toThrow()
  const complete = await test.changeActor(), before = structuredClone(test.client.state())
  gate.resolve(json({ error: 'expired' }, 401)); await rejected; expect(test.client.state()).toEqual(before); await complete()
})
