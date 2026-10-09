import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { CitationFocus, ConversationSnapshot, M4ArtifactDraftResult, M4ClaimRecordResult, ProductReviewCommand, ProductReviewFocus, ProductReviewResult, ProductReviewWorkspace } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { canonicalHash } from '../src/live/state'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks() })
const raw = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}`, import.meta.url), 'utf8')) as T
const observations = raw<{ valid: ConversationSnapshot[] }>('conversation-observations.json')
const m4 = raw<{ claimRecordResult: M4ClaimRecordResult, artifactDraftResult: M4ArtifactDraftResult }>('m4/m4-rpc.json')
const answer = raw<{ bases: { focus: CitationFocus } }>('product-answer.json')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
type ReviewCall = { path: string, method: string, body: unknown, credentials: RequestCredentials | undefined, headers: Headers, signal: AbortSignal | undefined }
type Operation = 'workspace' | 'command' | 'focus'

async function setup(start = true) {
  const snapshot = structuredClone(observations.valid.find(value => value.kind === 'conversation-snapshot')!)
  snapshot.runs = []; snapshot.live = []; snapshot.activity = []; snapshot.cursor.sequence = 0
  const binding = snapshot.binding, scopeId = 'scope:review~history.1', evidenceId = 'evidence:review~one'
  let actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }
  const second = { ...binding, conversationId: 'conversation:review~two', bindingId: 'binding:review~two', runtimeSessionId: 'session:review~two' }
  const snapshots = new Map<string, ConversationSnapshot>([[binding.conversationId, snapshot], [second.conversationId, { ...structuredClone(snapshot), binding: second }]])
  const workspace: ProductReviewWorkspace = { schemaVersion: 1, kind: 'review-workspace', conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation,
    scope: { schemaVersion: 1, scopeVersionId: scopeId, workspaceId: actor.workspaceId, investigationId: 'investigation:review', version: 1,
      included: [{ documentId: 'document:review', revisionId: 'revision:review~one', role: 'primary' }], excluded: [], locked: true,
      createdBy: { kind: 'user', actorId: actor.actorId }, createdAt: binding.createdAt },
    scopeOptions: [{ scopeVersionId: scopeId, version: 1, sourceCount: 1, current: false }], claims: [], evidenceRelations: [], derivations: [], evidence: [], artifacts: [], reviews: [], decisions: [], truncated: false }
  const result = structuredClone(m4.claimRecordResult)
  result.workspaceId = actor.workspaceId; result.scopeVersionId = scopeId; result.investigationId = workspace.scope!.investigationId
  result.claim.workspaceId = actor.workspaceId; result.claim.investigationId = result.investigationId; result.claim.scope.sourceScopeVersionId = scopeId; result.claim.createdBy = { kind: 'user', actorId: actor.actorId }
  const command: ProductReviewCommand = { schemaVersion: 1, kind: 'review-command', expectedGeneration: binding.generation, scopeVersionId: scopeId,
    idempotencyKey: 'review:original~key', action: 'claim-save', expectedClaimVersionId: null, statement: result.claim.statement, basis: result.claim.basis,
    epistemicStatus: result.claim.epistemicStatus, reviewStatus: result.claim.reviewStatus,
    evidenceRelations: [{ evidenceId, kind: 'supports', coverage: 'full' }], derivation: { operation: 'extract', inputClaimVersionIds: [] } }
  const receipt: ProductReviewResult = { schemaVersion: 1, kind: 'review-result', conversationId: binding.conversationId, idempotencyKey: command.idempotencyKey, requestHash: await canonicalHash(command), result }
  const { messageId: _message, citationId: _citation, ...original } = structuredClone(answer.bases.focus)
  const focus: ProductReviewFocus = { ...original, kind: 'review-focus', conversationId: binding.conversationId, scopeVersionId: scopeId, evidenceId }
  const calls: ReviewCall[] = [], values = new Map<string, string>()
  let responder: ((call: ReviewCall) => Response | Promise<Response>) | undefined, conversations: (() => Response | Promise<Response>) | undefined
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } }
  const stream: EventStream = { onerror: null, onopen: null, addEventListener() {}, close() {} }
  const client = new LiveClient({ storage, events: () => stream, fetch: (async (input, options) => {
    const path = String(input)
    if (path === '/api/bootstrap' || path === '/api/auth/exchange') return json({ schemaVersion: 1, kind: 'bootstrap', actor, csrfToken: 'a'.repeat(43) })
    if (path === '/api/conversations') return conversations ? conversations() : json({ schemaVersion: 1, kind: 'conversation-list', items: [binding, second], nextCursor: null })
    if (path.endsWith('/snapshot')) {
      const id = decodeURIComponent(path.split('/')[3]!)
      return json(snapshots.get(id))
    }
    if (path === '/api/auth/logout') return new Response(null, { status: 204 })
    if (path.includes('/reviews')) {
      const call: ReviewCall = { path, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) as unknown : undefined,
        credentials: options?.credentials, headers: new Headers(options?.headers), signal: options?.signal ?? undefined }
      calls.push(call)
      return responder ? responder(call) : json(path.endsWith('/focus') ? focus : call.method === 'POST' ? receipt : workspace)
    }
    throw new Error(`Unexpected fixture route ${path}`)
  }) as typeof fetch })
  cleanup.push(() => client.dispose())
  if (start) await client.start()
  const invoke = (operation: Operation) => operation === 'workspace' ? client.reviewWorkspace(binding.conversationId, scopeId)
    : operation === 'command' ? client.reviewCommand(binding.conversationId, command) : client.reviewFocus(binding.conversationId, scopeId, evidenceId)
  return { client, binding, second, scopeId, evidenceId, workspace, command, receipt, focus, calls, values, snapshots, invoke,
    respond(value: typeof responder) { responder = value }, conversations(value: typeof conversations) { conversations = value },
    changeActor(field: 'actorId' | 'workspaceId') { actor = { ...actor, [field]: 'other:identity' }; return actor },
  }
}
type Fixture = Awaited<ReturnType<typeof setup>>
async function changeIdentity(test: Fixture, field: 'actorId' | 'workspaceId') {
  const gate = Promise.withResolvers<Response>(), next = test.changeActor(field)
  test.conversations(() => gate.promise)
  const pending = test.client.pair('a'.repeat(43))
  await vi.waitFor(() => expect(test.client.state().actor?.[field]).toBe(next[field]))
  // Deliberately retain the old snapshot during the public pairing transition. Epoch alone is insufficient.
  return async () => { gate.resolve(json({ schemaVersion: 1, kind: 'conversation-list', items: [], nextCursor: null })); await pending }
}

it('uses fixed opaque routes, GET-only scope reads and explicit POST bodies without changing native source selections', async () => {
  const test = await setup()
  test.client.setSources([{ documentId: 'document:selected', revisionId: 'revision:selected' }]); test.client.setDraft('Keep this native question')
  const before = structuredClone(test.client.state()), storage = [...test.values]
  await expect(test.client.reviewWorkspace(test.binding.conversationId)).resolves.toEqual(test.workspace)
  await expect(test.invoke('workspace')).resolves.toEqual(test.workspace)
  await expect(test.invoke('command')).resolves.toEqual(test.receipt)
  await expect(test.invoke('focus')).resolves.toEqual(test.focus)
  const base = `/api/conversations/${encodeURIComponent(test.binding.conversationId)}/reviews`
  expect(test.calls.map(value => [value.path, value.method, value.body])).toEqual([
    [base, 'GET', undefined], [`${base}?scopeVersionId=${encodeURIComponent(test.scopeId)}`, 'GET', undefined], [base, 'POST', test.command],
    [`${base}/evidence/${encodeURIComponent(test.evidenceId)}/focus`, 'POST', { scopeVersionId: test.scopeId }],
  ])
  expect(test.calls.every(value => value.credentials === 'same-origin')).toBe(true)
  expect(test.calls[0]!.headers.has('x-docatlas-csrf')).toBe(false)
  expect(test.calls[2]!.headers.get('x-docatlas-csrf')).toBe('a'.repeat(43))
  expect(test.calls[3]!.headers.get('content-type')).toBe('application/json')
  expect(test.client.state()).toEqual(before); expect([...test.values]).toEqual(storage)
})

it.each(['/private/file', 'https://other.example', '../escape', 'id%2fescape', 'scope:one?changed=true', 'a'.repeat(129), 123, null])('rejects non-opaque or non-string references locally: %s', async candidate => {
  const test = await setup(), invalid = candidate as string
  await expect(test.client.reviewWorkspace(test.binding.conversationId, invalid)).rejects.toThrow()
  await expect(test.client.reviewFocus(test.binding.conversationId, invalid, test.evidenceId)).rejects.toThrow()
  await expect(test.client.reviewFocus(test.binding.conversationId, test.scopeId, invalid)).rejects.toThrow()
  expect(test.calls).toEqual([])
})

it('requires a ready, selected, owned binding before reads or mutations and rejects stale command generations', async () => {
  const test = await setup(false)
  for (const operation of ['workspace', 'command', 'focus'] as const) await expect(test.invoke(operation)).rejects.toThrow()
  await test.client.start()
  await expect(test.client.reviewWorkspace(test.second.conversationId)).rejects.toThrow()
  await expect(test.client.reviewCommand(test.binding.conversationId, { ...test.command, expectedGeneration: test.binding.generation + 1 })).rejects.toThrow()
  const complete = await changeIdentity(test, 'actorId')
  for (const operation of ['workspace', 'command', 'focus'] as const) await expect(test.invoke(operation)).rejects.toThrow()
  await complete(); expect(test.calls).toEqual([])
})

it('rejects malformed and semantically inconsistent responses without replacing live state or retrying', async () => {
  const test = await setup(), before = structuredClone(test.client.state())
  const candidates: Array<{ operation: Operation, value: unknown }> = [
    { operation: 'workspace', value: { ...test.workspace, schemaVersion: 2 } },
    { operation: 'workspace', value: { ...test.workspace, scopeOptions: [] } },
    { operation: 'command', value: { ...test.receipt, result: { ...test.receipt.result, resultType: 'unknown' } } },
    { operation: 'focus', value: { ...test.focus, original: { ...test.focus.original, revisionId: 'revision:other' } } },
    { operation: 'focus', value: { ...test.focus, physicalPage: test.focus.original.pageCount + 1 } },
  ]
  for (const candidate of candidates) { test.respond(() => json(candidate.value)); await expect(test.invoke(candidate.operation)).rejects.toThrow() }
  expect(test.calls).toHaveLength(candidates.length); expect(test.client.state()).toEqual(before)
})

it('rejects well-shaped wrong scope, owner, generation, conversation or focus identity', async () => {
  const test = await setup()
  const candidates: Array<{ operation: Operation, value: unknown }> = [
    { operation: 'workspace', value: { ...test.workspace, conversationId: test.second.conversationId } },
    { operation: 'workspace', value: { ...test.workspace, bindingId: 'binding:other' } },
    { operation: 'workspace', value: { ...test.workspace, generation: test.binding.generation + 1 } },
    { operation: 'workspace', value: { ...test.workspace, scope: { ...test.workspace.scope!, workspaceId: 'workspace:other' } } },
    { operation: 'workspace', value: { ...test.workspace, scope: { ...test.workspace.scope!, createdBy: { kind: 'user', actorId: 'actor:other' } } } },
    { operation: 'workspace', value: { ...test.workspace, scope: { ...test.workspace.scope!, scopeVersionId: 'scope:other' }, scopeOptions: [{ ...test.workspace.scopeOptions[0]!, scopeVersionId: 'scope:other' }] } },
    { operation: 'focus', value: { ...test.focus, evidenceId: 'evidence:other' } },
    { operation: 'focus', value: { ...test.focus, scopeVersionId: 'scope:other' } },
  ]
  for (const candidate of candidates) { test.respond(() => json(candidate.value)); await expect(test.invoke(candidate.operation)).rejects.toThrow() }
  expect(test.calls).toHaveLength(candidates.length)
})

it('requires exact frozen request hash, idempotency key, scope and action result type', async () => {
  const test = await setup(), other = structuredClone(m4.artifactDraftResult)
  other.workspaceId = test.binding.workspaceId; other.investigationId = test.receipt.result.investigationId; other.scopeVersionId = test.scopeId
  other.manifest.workspaceId = other.workspaceId; other.manifest.investigationId = other.investigationId; other.manifest.sourceScopeVersionId = test.scopeId
  const foreignResult = structuredClone(test.receipt.result)
  foreignResult.workspaceId = 'workspace:other'
  if (foreignResult.resultType === 'm4-claim-record') foreignResult.claim.workspaceId = foreignResult.workspaceId
  for (const value of [{ ...test.receipt, requestHash: 'f'.repeat(64) }, { ...test.receipt, idempotencyKey: 'other:key' },
    { ...test.receipt, result: { ...test.receipt.result, scopeVersionId: 'scope:other' } }, { ...test.receipt, result: foreignResult }, { ...test.receipt, result: other }]) {
    test.respond(() => json(value)); await expect(test.invoke('command')).rejects.toThrow()
  }
  expect(test.calls).toHaveLength(5)
})

it('freezes the command before transport, preserving the original body/key/hash when the caller mutates its object', async () => {
  const test = await setup(), gate = Promise.withResolvers<Response>(), before = structuredClone(test.command)
  test.respond(() => gate.promise)
  const pending = test.invoke('command')
  expect(test.calls[0]!.body).toEqual(before)
  test.command.idempotencyKey = 'changed:caller:key'
  if (test.command.action === 'claim-save') test.command.statement = 'Changed after sending'
  gate.resolve(json(test.receipt))
  await expect(pending).resolves.toEqual(test.receipt)
  expect(test.calls[0]!.body).toEqual(before); expect(test.calls).toHaveLength(1)
})

it.each(['workspace', 'command', 'focus'] as const)('discards a late %s response after a real conversation switch even when transport ignores abort', async operation => {
  const test = await setup(), gate = Promise.withResolvers<Response>()
  test.respond(() => gate.promise)
  const work = test.invoke(operation), rejected = expect(work).rejects.toThrow()
  await test.client.select(test.second.conversationId)
  expect(test.calls[0]!.signal?.aborted).toBe(true)
  const after = structuredClone(test.client.state())
  gate.resolve(json(operation === 'workspace' ? test.workspace : operation === 'command' ? test.receipt : test.focus))
  await rejected; expect(test.client.state()).toEqual(after); expect(test.client.state().selected).toBe(test.second.conversationId)
  expect(test.calls).toHaveLength(1)
})

it.each(['actorId', 'workspaceId'] as const)('rechecks current %s after HTTP, not merely the captured owner or epoch', async field => {
  const test = await setup(), gate = Promise.withResolvers<Response>()
  test.respond(() => gate.promise)
  const work = test.invoke('workspace'), rejected = expect(work).rejects.toThrow()
  const complete = await changeIdentity(test, field), after = structuredClone(test.client.state())
  expect(test.client.state().snapshot?.binding.bindingId).toBe(test.binding.bindingId)
  gate.resolve(json(test.workspace)); await rejected
  expect(test.client.state()).toEqual(after)
  await complete(); expect(test.calls).toHaveLength(1)
})

it.each(['conversation', 'actorId', 'workspaceId', 'bindingId', 'generation', 'runtimeSessionId', 'logout', 'dispose'] as const)('fences %s changes during asynchronous receipt hashing before returning a successful command', async transition => {
  const test = await setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => {
    const hash = await original(algorithm, bytes); entered.resolve(); await release.promise; return hash
  })
  const work = test.invoke('command'), rejected = expect(work).rejects.toThrow()
  await entered.promise
  let complete: (() => Promise<void>) | undefined
  if (transition === 'conversation') await test.client.select(test.second.conversationId)
  else if (transition === 'actorId' || transition === 'workspaceId') complete = await changeIdentity(test, transition)
  else if (transition === 'logout') await test.client.logout()
  else if (transition === 'dispose') test.client.dispose()
  else {
    const changed = structuredClone(test.snapshots.get(test.binding.conversationId)!)
    changed.binding = { ...changed.binding, [transition]: transition === 'generation' ? changed.binding.generation + 1 : 'changed:binding' }
    test.snapshots.set(test.binding.conversationId, changed)
    await test.client.refresh()
    expect(test.client.state().snapshot?.binding[transition]).toBe(changed.binding[transition])
  }
  const after = structuredClone(test.client.state())
  release.resolve(); await rejected; expect(test.client.state()).toEqual(after)
  await complete?.(); expect(test.calls).toHaveLength(1)
})

it('expires only the matching active authentication context; an old 401 cannot clear a newer pairing', async () => {
  const test = await setup(), gate = Promise.withResolvers<Response>()
  test.respond(() => gate.promise)
  const work = test.invoke('focus'), rejected = expect(work).rejects.toThrow()
  const complete = await changeIdentity(test, 'actorId'), after = structuredClone(test.client.state())
  gate.resolve(json({ error: 'expired' }, 401)); await rejected
  expect(test.client.state()).toEqual(after); await complete()
  const active = await setup(); active.respond(() => json({ error: 'expired' }, 401))
  await expect(active.invoke('workspace')).rejects.toThrow()
  expect(active.client.state().phase).toBe('pairing'); expect(active.client.state().actor).toBeNull()
})
