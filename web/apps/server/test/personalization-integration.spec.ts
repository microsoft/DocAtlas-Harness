import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiTestModel, type PiTestContextSnapshot } from '@docatlas/runtime-pi/testing'
import { parseContract } from '@docatlas/contracts/node'
import type { ProductBinding, ProductRunReceipt } from '@docatlas/contracts'
import { startDocAtlasApplication, type DocAtlasApplicationOptions } from '../src/application.js'

const guidance = 'DocAtlas explicit response-presentation preferences for this request only.'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
type Application = Awaited<ReturnType<typeof startDocAtlasApplication>>
interface Session { app: Application, binding: ProductBinding, cookie: string, headers: Record<string, string> }

async function open(options: DocAtlasApplicationOptions): Promise<Session> {
  const app = await startDocAtlasApplication(options); cleanup.push(() => app.close())
  const paired = await fetch(`${app.origin}/api/auth/exchange`, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code: app.pairingCode }) })
  expect(paired.status).toBe(200)
  const login = parseContract('product-http', await paired.json())
  if (login.kind !== 'bootstrap') throw new Error('Expected authenticated bootstrap')
  const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
  const headers = { cookie, origin: app.origin, 'content-type': 'application/json', 'x-docatlas-csrf': login.csrfToken }
  const response = await fetch(`${app.origin}/api/conversations`, { headers })
  expect(response.status).toBe(200)
  const listing = parseContract('product-http', await response.json())
  if (listing.kind !== 'conversation-list' || listing.items.length !== 1) throw new Error('Expected the one durable initial conversation')
  return { app, cookie, headers, binding: listing.items[0]! }
}
async function configured(model: Awaited<ReturnType<typeof createPiTestModel>>) {
  const temporary = mkdtempSync(join(tmpdir(), 'docatlas-actual-personalization-'))
  cleanup.push(() => rmSync(temporary, { recursive: true, force: true }))
  const projectRoot = realpathSync(resolve('.'))
  const options: DocAtlasApplicationOptions = { root: join(temporary, 'app'), projectRoot, webRoot: join(projectRoot, 'apps/web/dist'),
    port: 0, modelRuntime: model.modelRuntime, models: model.models }
  return { options, session: await open(options) }
}
function preferenceUrl(session: Session) { return `${session.app.origin}/api/conversations/${encodeURIComponent(session.binding.conversationId)}/preferences` }
async function preferenceState(session: Session) {
  const response = await fetch(`${preferenceUrl(session)}/state`, { headers: { cookie: session.cookie } })
  expect(response.status).toBe(200)
  const value = parseContract('product-personalization-v2', await response.json())
  if (value.kind !== 'preference-inspection') throw new Error('Expected truthful v2 preference inspection')
  expect(value.modelApplication).toBe('host-ephemeral'); expect(value.useSemantics).toBe('observed-answer-generation')
  return value
}
async function state(session: Session) { return (await preferenceState(session)).result }
async function command(session: Session, fields: Record<string, unknown>, version: 1 | 2 = 2) {
  const epoch = version === 2 ? (await preferenceState(session)).profileEpoch : undefined
  const response = await fetch(preferenceUrl(session), { method: 'POST', headers: session.headers, body: JSON.stringify({
    schemaVersion: version, kind: 'preference-command', expectedGeneration: session.binding.generation, ...(version === 2 ? { expectedProfileEpoch: epoch } : {}), command: fields,
  }) })
  expect(response.status).toBe(200)
  const result = parseContract(version === 1 ? 'product-personalization' : 'product-personalization-v2', await response.json())
  if (result.kind !== 'preference-result') throw new Error('Expected profile control receipt')
  expect(result.schemaVersion).toBe(version)
  return result.result
}
async function enable(session: Session) {
  // Both wire envelopes perform the same explicit, human-authorized durable action.
  const preference = await command(session, { action: 'set-preference', idempotencyKey: 'explicit:application-preference',
    preference: { effect: { key: 'answer-order', value: 'evidence-first' }, scope: 'workspace' } }, 1)
  if (preference.action !== 'set-preference') throw new Error('Expected explicit memory')
  await command(session, { action: 'set-session-policy', idempotencyKey: 'policy:enable', expectedVersion: 0,
    policy: { useExisting: true, contributeToFuture: false } })
  return preference.memoryVersion
}
async function begin(session: Session, key: string, text: string) {
  const request = { schemaVersion: 1, kind: 'submission', conversationId: session.binding.conversationId, expectedGeneration: session.binding.generation,
    idempotencyKey: key, mode: 'prompt', text, sourceRefs: [], selectionContextIds: [] }
  const response = await fetch(`${session.app.origin}/api/submissions`, { method: 'POST', headers: session.headers, body: JSON.stringify(request) })
  expect(response.status).toBe(202)
  const receipt = parseContract('product-control', await response.json())
  if (receipt.kind !== 'run-receipt') throw new Error('Expected native submission receipt')
  return { request, receipt }
}
async function receipt(session: Session, id: string): Promise<ProductRunReceipt> {
  const response = await fetch(`${session.app.origin}/api/submissions/${encodeURIComponent(id)}`, { headers: { cookie: session.cookie } })
  expect(response.status).toBe(200)
  const value = parseContract('product-control', await response.json())
  if (value.kind !== 'run-receipt') throw new Error('Expected run receipt')
  return value
}
async function settled(session: Session, id: string) {
  await expect.poll(async () => ['completed', 'failed', 'cancelled'].includes((await receipt(session, id)).state), { timeout: 30000 }).toBe(true)
  return receipt(session, id)
}
async function ask(session: Session, key: string) {
  const run = await begin(session, key, `Explicit test question ${key}.`)
  expect((await settled(session, run.receipt.submissionId)).state).toBe('completed')
  return run
}
async function history(session: Session) {
  const response = await fetch(`${session.app.origin}/api/conversations/${encodeURIComponent(session.binding.conversationId)}/snapshot`, { headers: { cookie: session.cookie } })
  expect(response.status).toBe(200)
  const snapshot = parseContract('conversation-observation', await response.json())
  if (snapshot.kind !== 'conversation-snapshot') throw new Error('Expected restored native messages')
  return snapshot.history.messages
}
function nativeTranscript(options: DocAtlasApplicationOptions, binding: ProductBinding): string {
  const directory = join(options.root, 'runtime', binding.runtimeSessionId, 'sessions'), files = readdirSync(directory).filter(file => file.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  return readFileSync(join(directory, files[0]!), 'utf8')
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('actual isolated Pi personalization, explicit faux model only', () => {
  it('does not personalize actual SDK automatic compaction or count its summary generation as preference use', async () => {
    const contexts: PiTestContextSnapshot[] = []
    // Actual bounded message bytes exceed native keepRecentTokens; no manual compact RPC,
    // fake compaction event or mutated receipt is involved. Large chunks keep the test IPC bounded.
    const longAnswer = 'BOUNDED_NATIVE_COMPACTION_TEST_CONTENT '.repeat(2800)
    const model = await createPiTestModel({ modelLimits: { contextWindow: 40000, maxTokens: 32000 }, tokenSize: 8192,
      answers: [longAnswer, 'AUTO_COMPACTION_SUMMARY_SENTINEL', 'AUTO_COMPACTION_SUMMARY_SENTINEL'], inspectContext: context => contexts.push(context) })
    const { options, session } = await configured(model)
    await enable(session)
    await ask(session, 'question:real-auto-compaction')
    const entries = nativeTranscript(options, session.binding).trim().split('\n').map(line => JSON.parse(line) as { type: string, summary?: string, tokensBefore?: number })
    const compactions = entries.filter(entry => entry.type === 'compaction')
    expect(compactions).toHaveLength(1)
    expect(compactions[0]!.summary).toContain('AUTO_COMPACTION_SUMMARY_SENTINEL')
    expect(compactions[0]!.tokensBefore).toBeGreaterThan(20000)
    expect(contexts.length).toBeGreaterThanOrEqual(2)
    expect(contexts.length).toBeLessThanOrEqual(3)
    expect(contexts[0]!.systemPrompt).toContain(guidance)
    for (const summary of contexts.slice(1)) {
      expect(summary.systemPrompt).not.toContain(guidance)
      expect(JSON.stringify(summary.messages)).not.toContain(guidance)
    }
    expect(contexts.filter(context => context.systemPrompt?.includes(guidance))).toHaveLength(1)
    const preferences = await state(session)
    expect(preferences.counts.uses).toBe(1)
    expect(preferences.counts.decisions).toBe(1)
    expect(preferences.uses[0]).toMatchObject({ affectedActions: ['answer-render'], outcome: { status: 'unknown' } })
    expect(nativeTranscript(options, session.binding)).not.toContain(guidance)
    expect(model.getCallCount()).toBe(contexts.length)
  }, 120000)

  it('fences pre-erasure v1 and v2 outboxes while replaying the original erasure receipt without deleting fresh-epoch settings', async () => {
    const model = await createPiTestModel({ answers: [] }), { options, session } = await configured(model)
    const initial = await preferenceState(session)
    expect(initial.profileEpoch).toBe(0)
    const legacy = { schemaVersion: 1, kind: 'preference-command', expectedGeneration: session.binding.generation,
      command: { action: 'set-preference', idempotencyKey: 'outbox:legacy-before-erasure', preference: { effect: { key: 'answer-order', value: 'evidence-first' }, scope: 'workspace' } } }
    const stale = { schemaVersion: 2, kind: 'preference-command', expectedGeneration: session.binding.generation, expectedProfileEpoch: initial.profileEpoch,
      command: { action: 'set-preference', idempotencyKey: 'outbox:v2-before-erasure', preference: { effect: { key: 'explanation-depth', value: 'brief' }, scope: 'workspace' } } }
    const post = (who: Session, body: unknown) => fetch(preferenceUrl(who), { method: 'POST', headers: who.headers, body: JSON.stringify(body) })
    expect((await post(session, legacy)).status).toBe(200)
    expect((await post(session, stale)).status).toBe(200)
    const before = await preferenceState(session)
    expect(before.result.memories).toHaveLength(2)
    const erase = { schemaVersion: 2, kind: 'preference-command', expectedGeneration: session.binding.generation, expectedProfileEpoch: before.profileEpoch,
      command: { action: 'forget', idempotencyKey: 'outbox:exact-erasure-request', target: 'profile', expectedProfileRevision: before.result.profileRevision,
        mode: 'privacy-erasure', provenanceHandling: 'redact-derived-excerpts', acknowledgeExternalRetention: true } }
    const erasedResponse = await post(session, erase)
    expect(erasedResponse.status).toBe(200)
    const erased = parseContract('product-personalization-v2', await erasedResponse.json())
    if (erased.kind !== 'preference-result' || erased.result.action !== 'forget') throw new Error('Expected explicit erasure receipt')
    const after = await preferenceState(session)
    expect(after.profileEpoch).toBe(before.profileEpoch + 1)
    expect(after.result.memories).toEqual([])
    for (const old of [legacy, stale]) expect((await post(session, old)).status).toBe(409)
    expect((await state(session)).memories).toEqual([])
    const replayResponse = await post(session, erase)
    expect(replayResponse.status).toBe(200)
    expect(parseContract('product-personalization-v2', await replayResponse.json())).toMatchObject({ kind: 'preference-result', result: { action: 'forget', status: 'replayed', receipt: { receiptId: erased.result.receipt.receiptId } } })
    await command(session, { action: 'set-preference', idempotencyKey: 'outbox:fresh-epoch-setting',
      preference: { effect: { key: 'artifact-format', value: 'matrix' }, scope: 'workspace' } })
    const fresh = await state(session)
    expect(fresh.memories).toHaveLength(1)
    expect(fresh.memories[0]).toMatchObject({ status: 'active', effect: { key: 'artifact-format', value: 'matrix' } })
    expect((await post(session, erase)).status).toBe(200)
    expect((await state(session)).memories).toEqual(fresh.memories) // Receipt replay is not another erasure operation.
    await session.app.close()
    const reopened = await open(options)
    expect((await preferenceState(reopened)).profileEpoch).toBe(after.profileEpoch)
    for (const old of [legacy, stale]) expect((await post(reopened, old)).status).toBe(409)
    expect((await state(reopened)).memories).toEqual(fresh.memories)
    expect((await post(reopened, erase)).status).toBe(200)
    expect((await state(reopened)).memories).toEqual(fresh.memories)
    expect(model.getCallCount()).toBe(0)
  }, 90000)

  it('guides the real provider ephemerally only while explicit preferences are enabled, never persists guidance, and does not resurrect it after a clean restart', async () => {
    const contexts: PiTestContextSnapshot[] = []
    const model = await createPiTestModel({ answers: Array.from({ length: 4 }, () => 'A fixed test response; this is not a factual-quality evaluation.'),
      inspectContext: context => { expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.messages)).toBe(true); contexts.push(context) } })
    const { options, session } = await configured(model)
    expect(model.getCallCount()).toBe(0)
    expect((await fetch(preferenceUrl(session), { headers: { cookie: session.cookie } })).status).toBe(409) // v1 cannot claim that the now-connected host is unconnected.
    const memory = await enable(session)
    expect((await state(session)).counts.uses).toBe(0)
    await ask(session, 'question:enabled')
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.systemPrompt).toContain(guidance)
    expect(contexts[0]!.systemPrompt).toContain('Present the supporting evidence before the conclusion')
    expect(JSON.stringify(contexts[0]!.messages)).not.toContain(guidance)
    const used = await state(session)
    expect(used.uses).toHaveLength(1)
    expect(used.uses[0]).toMatchObject({ memoryVersionId: memory.memoryVersionId, affectedActions: ['answer-render'], outcome: { status: 'unknown' } })
    expect(used.decisions[0]?.factTraceGuard).toMatchObject({ evidenceSupportInvariant: true, contradictionDisclosureInvariant: true, publicationGateInvariant: true, sourceScopeInvariant: true })
    expect(nativeTranscript(options, session.binding)).not.toContain(guidance)
    expect(JSON.stringify(await history(session))).not.toContain(guidance)

    await command(session, { action: 'set-session-policy', idempotencyKey: 'policy:disable', expectedVersion: 1, policy: { useExisting: false, contributeToFuture: false } })
    await ask(session, 'question:disabled')
    expect(contexts[1]!.systemPrompt).not.toContain(guidance)
    await command(session, { action: 'set-session-policy', idempotencyKey: 'policy:reenable', expectedVersion: 2, policy: { useExisting: true, contributeToFuture: false } })
    const paused = await command(session, { action: 'pause', idempotencyKey: 'memory:pause', memoryVersionId: memory.memoryVersionId, expectedVersion: memory.version })
    if (paused.action !== 'pause') throw new Error('Expected paused preference')
    await ask(session, 'question:paused-preference')
    expect(contexts[2]!.systemPrompt).not.toContain(guidance)
    const resumed = await command(session, { action: 'resume', idempotencyKey: 'memory:resume', memoryVersionId: paused.memoryVersion.memoryVersionId, expectedVersion: paused.memoryVersion.version })
    if (resumed.action !== 'resume') throw new Error('Expected resumed preference')
    await command(session, { action: 'forget', idempotencyKey: 'memory:forget', target: 'memory-chain', memoryVersionId: resumed.memoryVersion.memoryVersionId,
      expectedVersion: resumed.memoryVersion.version, mode: 'memory-only', provenanceHandling: 'orphan', acknowledgeExternalRetention: true })
    await ask(session, 'question:forgotten')
    expect(contexts[3]!.systemPrompt).not.toContain(guidance)
    expect((await state(session)).counts.uses).toBe(1) // One actual earlier use, not four prepared requests.
    expect(model.getCallCount()).toBe(4)
    const before = await history(session)
    expect(before.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(Array.from({ length: 4 }, () => 'A fixed test response; this is not a factual-quality evaluation.'))
    await session.app.close()
    expect(nativeTranscript(options, session.binding)).not.toContain(guidance)

    const restartedContexts: PiTestContextSnapshot[] = []
    const restartedModel = await createPiTestModel({ answers: ['New user question after restart.'], inspectContext: context => restartedContexts.push(context) })
    const reopened = await open({ ...options, modelRuntime: restartedModel.modelRuntime, models: restartedModel.models })
    expect(reopened.binding.conversationId).toBe(session.binding.conversationId)
    expect(await history(reopened)).toEqual(before)
    expect(restartedModel.getCallCount()).toBe(0)
    expect((await state(reopened)).memories.filter(value => value.status !== 'deleted')).toEqual([])
    await ask(reopened, 'question:after-restart')
    expect(restartedModel.getCallCount()).toBe(1)
    expect(restartedContexts[0]!.systemPrompt).not.toContain(guidance)
    expect(JSON.stringify(restartedContexts[0]!.messages)).not.toContain(guidance)
    expect(nativeTranscript(options, reopened.binding)).not.toContain(guidance)
  }, 120000)

  it('revokes an in-flight personalized request before text is observed and forbids hidden replay under the old submission', async () => {
    const contexts: PiTestContextSnapshot[] = [], entered = Promise.withResolvers<void>()
    let calls = 0, aborted = false
    const model = await createPiTestModel({ answers: ['This revoked response must not complete.', 'Fresh unpersonalized response.'],
      inspectContext: context => contexts.push(context), beforeResponse: async signal => {
        if (++calls !== 1) return
        entered.resolve()
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { aborted = true; reject(signal?.reason ?? new Error('cancelled')) }
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
        })
      } })
    const { session } = await configured(model)
    await enable(session)
    const pending = await begin(session, 'question:will-be-revoked', 'Begin this explicitly personalized request.')
    await entered.promise
    expect(contexts[0]!.systemPrompt).toContain(guidance)
    expect((await state(session)).counts.uses).toBe(0) // Prepared context is not actual generated-text use.
    await command(session, { action: 'set-session-policy', idempotencyKey: 'policy:revoke-inflight', expectedVersion: 1, policy: { useExisting: false, contributeToFuture: false } })
    const stopped = await settled(session, pending.receipt.submissionId)
    expect(['failed', 'cancelled']).toContain(stopped.state)
    expect(aborted).toBe(true)
    expect(model.getCallCount()).toBe(1)
    expect((await state(session)).counts.uses).toBe(0)
    const retry = await fetch(`${session.app.origin}/api/submissions`, { method: 'POST', headers: session.headers, body: JSON.stringify(pending.request) })
    expect(retry.status).toBe(200)
    expect(parseContract('product-control', await retry.json())).toMatchObject({ submissionId: stopped.submissionId, state: stopped.state })
    expect(model.getCallCount()).toBe(1)
    await ask(session, 'question:fresh-after-revoke')
    expect(model.getCallCount()).toBe(2)
    expect(contexts).toHaveLength(2)
    expect(contexts[1]!.systemPrompt).not.toContain(guidance)
    expect(JSON.stringify(await history(session))).not.toContain('This revoked response must not complete.')
    expect((await state(session)).counts.uses).toBe(0)
  }, 90000)

  it('revokes a guided submission between a closed provider call and an executing real native tool without rolling back completed tool effects', async () => {
    const contexts: PiTestContextSnapshot[] = []
    let firstProviderSignal: AbortSignal | undefined, providerCalls = 0
    const nativeCommand = [
      'printf started > preference-gap-started.txt',
      'for ((attempt=0; attempt<200; attempt++)); do',
      '  if [[ -f preference-gap-release.txt ]]; then',
      '    printf completed > preference-gap-completed.txt',
      '    printf "PREFERENCE_NATIVE_SIDE_EFFECT_COMPLETED\\n"',
      '    exit 0',
      '  fi',
      '  sleep 0.05',
      'done',
      'printf "Tool-gap test release timed out\\n" >&2',
      'exit 1',
    ].join('\n')
    const model = await createPiTestModel({
      answers: [{ calls: [{ name: 'bash', args: { command: nativeCommand, timeout: 15 } }] }, 'Only a fresh user submission may produce this answer.'],
      inspectContext: context => contexts.push(context),
      beforeResponse: async signal => { if (++providerCalls === 1) firstProviderSignal = signal },
    })
    const { session } = await configured(model)
    const started = join(session.app.workspaceRoot, 'preference-gap-started.txt')
    const release = join(session.app.workspaceRoot, 'preference-gap-release.txt')
    const completed = join(session.app.workspaceRoot, 'preference-gap-completed.txt')
    try {
      await enable(session)
      const pending = await begin(session, 'question:revoke-in-tool-gap', 'Run the explicit native file operation, then answer.')
      await expect.poll(() => existsSync(started), { timeout: 15000 }).toBe(true)
      const runtime = await session.app.manager.get(session.app.actor, session.binding.conversationId)
      expect(runtime.native.activeCount).toBeGreaterThan(0)
      // The host closes and aborts the provider lifetime after its real result joins.
      // Check this before use-off: revocation must span the native-tool gap, not merely abort an active provider.
      await expect.poll(() => firstProviderSignal?.aborted ?? false).toBe(true)
      expect(model.getCallCount()).toBe(1)
      expect(contexts[0]!.systemPrompt).toContain(guidance)
      expect(existsSync(completed)).toBe(false)
      expect((await state(session)).counts.uses).toBe(0) // A tool-only provider result is not generated answer text.

      await command(session, { action: 'set-session-policy', idempotencyKey: 'policy:revoke-between-calls', expectedVersion: 1,
        policy: { useExisting: false, contributeToFuture: false } })
      expect(runtime.native.activeCount).toBeGreaterThan(0)
      expect(readFileSync(started, 'utf8')).toBe('started')
      writeFileSync(release, 'release the already-authorized native operation')
      await expect.poll(() => existsSync(completed), { timeout: 10000 }).toBe(true)
      const stopped = await settled(session, pending.receipt.submissionId)
      expect(['failed', 'cancelled']).toContain(stopped.state)
      await expect.poll(() => runtime.native.activeCount).toBe(0)
      expect(model.getCallCount()).toBe(1) // The next model request in the same submission never reaches the provider.
      expect(readFileSync(completed, 'utf8')).toBe('completed')
      expect(readFileSync(started, 'utf8')).toBe('started')

      const replay = await fetch(`${session.app.origin}/api/submissions`, { method: 'POST', headers: session.headers, body: JSON.stringify(pending.request) })
      expect(replay.status).toBe(200)
      expect(parseContract('product-control', await replay.json())).toMatchObject({ submissionId: stopped.submissionId, state: stopped.state })
      expect(model.getCallCount()).toBe(1)
      await ask(session, 'question:new-after-tool-gap')
      expect(model.getCallCount()).toBe(2)
      expect(contexts[1]!.systemPrompt).not.toContain(guidance)
      expect(readFileSync(completed, 'utf8')).toBe('completed') // No hidden rollback of a successfully completed native write.
      expect((await state(session)).counts.uses).toBe(0)
    } finally {
      // Release only this test's bounded native wait if an assertion failed before the normal release.
      if (existsSync(session.app.workspaceRoot) && !existsSync(release)) writeFileSync(release, 'test cleanup release')
    }
  }, 90000)
})
