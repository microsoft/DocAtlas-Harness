import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import type { ConversationSnapshot, ProductPreferenceCommand, ProductPreferenceCommandV2, ProductPreferenceInspectionV2, ProductPreferenceResult } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { canonicalHash } from '../src/live/state'

const clients: LiveClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.dispose() })
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-personalization.json', import.meta.url), 'utf8')) as {
  bases: { policy: ProductPreferenceCommand, policyResult: ProductPreferenceResult }
}
async function setup() {
  const observations = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: ConversationSnapshot[] }
  const snapshot = structuredClone(observations.valid.find(value => value.kind === 'conversation-snapshot')!)
  snapshot.runs = []; snapshot.live = []; snapshot.cursor.sequence = 0
  const binding = snapshot.binding, actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }
  const profileId = `profile:pi:${(await canonicalHash([actor.actorId, actor.workspaceId])).slice(0, 32)}`
  const inspection: ProductPreferenceInspectionV2 = { schemaVersion: 2, kind: 'preference-inspection', conversationId: binding.conversationId,
    profileEpoch: 0, modelApplication: 'host-ephemeral', useSemantics: 'observed-answer-generation', result: { schemaVersion: 1, resultType: 'personalization-inspection', profileId, sessionId: binding.conversationId,
      profileRevision: 0, memories: [], decisions: [], uses: [], counts: { memories: 0, decisions: 0, uses: 0 }, truncated: { memories: false, decisions: false, uses: false } } }
  const requests: Array<{ path: string, method: string, body?: unknown }> = []
  let responseVersion: 1 | 2 | undefined, readValue: unknown = inspection, status = 200
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } }
  const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
  const stream: EventStream = { onerror: null, onopen: null, addEventListener() {}, close() {} }
  const client = new LiveClient({ storage, events: () => stream, fetch: (async (input, options) => {
    const path = String(input)
    if (path === '/api/bootstrap') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
    if (path === '/api/conversations') return json({ schemaVersion: 1, kind: 'conversation-list', items: [binding], nextCursor: null })
    if (path.endsWith('/snapshot')) return json(snapshot)
    if (path.includes('/preferences')) {
      const body = options?.body ? JSON.parse(String(options.body)) as ProductPreferenceCommand | ProductPreferenceCommandV2 : undefined
      requests.push({ path, method: options?.method ?? 'GET', ...(body ? { body } : {}) })
      if (!body) return json(readValue, status)
      const result = structuredClone(fixture.bases.policyResult)
      if (result.result.action !== 'set-session-policy') throw new Error('Expected policy fixture')
      result.conversationId = binding.conversationId; result.result.profileId = profileId
      result.result.sessionPolicy.profileId = profileId; result.result.sessionPolicy.sessionId = binding.conversationId
      result.result.sessionPolicy.updatedBy = { kind: 'user', actorId: actor.actorId }
      return json({ ...result, schemaVersion: responseVersion ?? body.schemaVersion }, status)
    }
    throw new Error('Unexpected test route')
  }) as typeof fetch })
  clients.push(client); await client.start()
  return { client, requests, binding, inspection, setVersion(value: 1 | 2) { responseVersion = value }, setRead(value: unknown) { readValue = value }, setStatus(value: number) { status = value } }
}

it('reads only v2 state and does not disguise connected mode as v1 disconnected state', async () => {
  const test = await setup()
  await expect(test.client.preferenceRequest(test.binding.conversationId)).resolves.toEqual(test.inspection)
  expect(test.requests).toEqual([{ path: `/api/conversations/${encodeURIComponent(test.binding.conversationId)}/preferences/state`, method: 'GET' }])
  test.setRead({ ...test.inspection, schemaVersion: 1, modelApplication: 'not-connected' })
  await expect(test.client.preferenceRequest(test.binding.conversationId)).rejects.toThrow()
  expect(test.requests).toHaveLength(2)
})

it.each([1, 2] as const)('sends the exact v%s command and subsequently reads v2 without a second POST', async version => {
  const test = await setup(), base = { ...structuredClone(fixture.bases.policy), expectedGeneration: test.binding.generation }
  const request = version === 2 ? { ...base, schemaVersion: 2 as const, expectedProfileEpoch: test.inspection.profileEpoch } : base
  const before = structuredClone(request)
  await expect(test.client.preferenceRequest(test.binding.conversationId, request)).resolves.toMatchObject({ schemaVersion: version, kind: 'preference-result' })
  await test.client.preferenceRequest(test.binding.conversationId)
  expect(test.requests.map(value => value.method)).toEqual(['POST', 'GET'])
  expect(test.requests[0]!.body).toEqual(before); expect(request).toEqual(before)
  expect(test.requests[1]!.path).toMatch(/\/preferences\/state$/)
})

it.each([1, 2] as const)('rejects a response that silently changes the v%s command envelope', async version => {
  const test = await setup(); test.setVersion(version === 1 ? 2 : 1)
  const base = { ...structuredClone(fixture.bases.policy), expectedGeneration: test.binding.generation }
  const request = version === 2 ? { ...base, schemaVersion: 2 as const, expectedProfileEpoch: test.inspection.profileEpoch } : base
  await expect(test.client.preferenceRequest(test.binding.conversationId, request)).rejects.toThrow()
  expect(test.requests).toHaveLength(1); expect(test.requests[0]!.body).toEqual(request)
})

it('does not retry or downgrade when state requires upgrade or preferences become unavailable', async () => {
  const test = await setup(); test.setStatus(409)
  await expect(test.client.preferenceRequest(test.binding.conversationId)).rejects.toThrow()
  expect(test.requests).toHaveLength(1); expect(test.requests[0]!.path).toMatch(/\/preferences\/state$/)
})
