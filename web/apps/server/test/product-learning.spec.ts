import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { PersonalizationStore, SourceScopeStore, type DocumentInvocation } from '@docatlas/core'
import type { DocumentLocator, LibraryDocument, ProductBinding, ProductLearningCommand, ProductPiCheckpoint, ProductPreparedSubmission, ProductRunReceipt, ReadResult, SourceScopeVersion } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'
import { AnswerReceipts } from '../src/storage/answer-receipts.js'
import { ProductAnswers } from '../src/documents/answers.js'
import { ProductLearning } from '../src/personalization/learning.js'
import { workspaceProfileId } from '../src/personalization/service.js'

const fixtureDocument = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/m2/library.json', import.meta.url), 'utf8')) as { document: LibraryDocument }
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

/** Real stores, exact Read attestations and private Answer publication. The small native-shaped
 * fixture below tests the host publication gate, not native SDK execution; the live journey owns that proof.
 */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-product-learning-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const actor = { actorId: 'actor:learning-host', workspaceId: 'workspace:learning-host' }, control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const domain = await SourceScopeStore.open(join(root, 'domain')); cleanup.push(() => domain.close())
  const profile = await PersonalizationStore.open(join(root, 'profile')); cleanup.push(() => profile.close())
  const receipts = new AnswerReceipts(join(root, 'answers')); cleanup.push(() => receipts.close())
  const answers = new ProductAnswers(receipts, domain, control, actor, () => { throw new Error('Learning must not start a PDF reader') }); cleanup.push(() => answers.close())
  const profileId = workspaceProfileId(actor), document = structuredClone(fixtureDocument.document)
  document.workspaceId = actor.workspaceId; document.documentId = domain.resolveLibraryImport(actor.workspaceId, 'learning:source', document.currentRevision.contentHash).documentId
  document.currentRevision.documentId = document.documentId
  for (const rep of document.representations) rep.documentId = document.documentId
  domain.recordLibraryDocument({ workspaceId: actor.workspaceId, idempotencyKey: 'learning:library-fixture', sourceKey: 'learning:source', rootId: 'fixture', relativePath: 'source.pdf', document })
  const source = domain.getEligibleLibrarySource(actor.workspaceId, document.documentId, document.currentRevision.revisionId)!, changes: string[] = []
  const learning = new ProductLearning(profile, control, answers, domain, workspaceProfileId, (_actor, cid) => changes.push(cid), () => new Date('2026-09-10T00:00:00.000Z'), () => true)
  cleanup.push(() => learning.close())
  const create = (name: string) => {
    const binding = control.createConversation(actor, { conversationId: `conversation:learning:${name}`, runtimeSessionId: randomUUID(), investigationId: `investigation:learning:${name}` })
    const scope: SourceScopeVersion = { schemaVersion: 1, scopeVersionId: `scope:learning:${name}`, workspaceId: actor.workspaceId, investigationId: binding.investigationId!, version: 1,
      included: [{ documentId: source.documentId, revisionId: source.revisionId, role: 'primary' }], excluded: [], locked: true, createdBy: { kind: 'user', actorId: actor.actorId }, createdAt: binding.createdAt }
    domain.commit({ schemaVersion: 1, requestType: 'source-scope-commit', sessionId: binding.conversationId, idempotencyKey: `learning:scope:${name}`, scope, sources: [source] })
    return { binding, scope }
  }
  const publish = (context: ReturnType<typeof create>, name: string) => {
    const { binding, scope } = context, ids = [0, 1, 2, 3].map(index => sha(`${name}:${index}`).slice(0, 8)), text = `Revenue remained stable (${name}).`, callId = `call:learning:${name}`
    let receipt = control.accept(actor, { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation,
      idempotencyKey: `learning:submission:${name}`, mode: 'prompt', text: 'Read the original evidence.', sourceRefs: [{ documentId: source.documentId, revisionId: source.revisionId }], selectionContextIds: [] }).receipt
    const lease = control.acquireWriter(actor, binding.conversationId, `worker:learning:${name}`)
    const prepared: ProductPreparedSubmission = { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
      bindingGeneration: binding.generation, scopeVersionId: scope.scopeVersionId, sourceRefs: [{ documentId: source.documentId, revisionId: source.revisionId }], selectionContextIds: [] }
    for (const state of ['preparing', 'ready', 'dispatching', 'running'] as const) receipt = control.transition(lease, receipt.submissionId, receipt.version, state, state === 'ready' ? { prepared } : undefined)
    const running = receipt, createdAt = receipt.updatedAt
    const locator: DocumentLocator = { schemaVersion: 1, locatorId: `locator:learning:${name}`, ...source, physicalPage: 1,
      selectors: [{ type: 'text-quote', exact: text, normalizedHash: sha(text) }], createdAt }
    const read: ReadResult = { schemaVersion: 1, resultType: 'read', mode: 'page', source: { documentId: source.documentId, revisionId: source.revisionId, representationId: source.representationId }, textQuality: 'usable',
      items: [{ itemType: 'block', blockId: `block:learning:${name}`, kind: 'paragraph', physicalPage: 1, text, locator }],
      pageInfo: { schemaVersion: 1, limit: 20, returned: 1, total: 1, usedChars: text.length, completeness: 'complete', truncated: false } }
    const invocation: DocumentInvocation = { submissionId: receipt.submissionId, scope: { scope, sources: [source] }, assertCurrent() {}, source: () => source, originalHash: () => document.currentRevision.contentHash }
    receipts.recordRead(binding, invocation, callId, read)
    const entries = [
      { type: 'message', id: ids[0], parentId: null, timestamp: createdAt, message: { role: 'user', content: 'Read the original evidence.' } },
      { type: 'message', id: ids[1], parentId: ids[0], timestamp: createdAt, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name: 'docatlas_read', arguments: { documentId: source.documentId, revisionId: source.revisionId, mode: 'page', physicalPage: 1 } }] } },
      { type: 'message', id: ids[2], parentId: ids[1], timestamp: createdAt, message: { role: 'toolResult', toolCallId: callId, toolName: 'docatlas_read', isError: false,
        content: [{ type: 'text', text: JSON.stringify(read) }], details: { schemaVersion: 1, schema: 'docatlas.tool-meta.v1', operation: 'read', scopeVersionId: scope.scopeVersionId, documentIds: [source.documentId], locators: [locator], assetIds: [], uiSummary: 'Actual attested Read', truncated: false } } },
      { type: 'message', id: ids[3], parentId: ids[2], timestamp: createdAt, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `[${text}](#docatlas.v1.support.${locator.locatorId})\nThe outlook is uncertain.` }] } },
    ]
    const bytes = Buffer.from([{ type: 'session', version: 3, id: binding.runtimeSessionId, cwd: '/work' }, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const file = join(root, `${name}.jsonl`); writeFileSync(file, bytes)
    const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: receipt.submissionId, requestHash: receipt.requestHash,
      runtimeSessionId: binding.runtimeSessionId, userEntryId: ids[0]!, leafEntryId: ids[3]!, transcriptHash: sha(bytes), byteLength: bytes.length, entryCount: entries.length, settledAt: createdAt }
    answers.capture(binding.conversationId, file, checkpoint, prepared)
    receipt = control.transition(lease, receipt.submissionId, receipt.version, 'completed', { checkpoint }); control.releaseWriter(lease)
    return { context, binding, messageId: ids[3]!, running, completed: receipt }
  }
  const query = (binding: ProductBinding, messageId?: string) => learning.query(actor, binding.conversationId, { schemaVersion: 1, kind: 'learning-query',
    expectedBindingId: binding.bindingId, expectedGeneration: binding.generation, ...(messageId ? { messageId } : {}) })
  const base = (binding: ProductBinding, key: string) => ({ schemaVersion: 1 as const, kind: 'learning-command' as const,
    expectedBindingId: binding.bindingId, expectedGeneration: binding.generation, expectedProfileEpoch: profile.profileEpoch(profileId), idempotencyKey: `learning:host:${key}` })
  const commit = (binding: ProductBinding, command: ProductLearningCommand) => learning.command(actor, binding.conversationId, command)
  const policy = (binding: ProductBinding, enabled = true) => profile.command({ schemaVersion: 1, requestType: 'personalization-command', profileId, sessionId: binding.conversationId,
    actor: { kind: 'user', actorId: actor.actorId }, idempotencyKey: `learning:policy:${binding.conversationId}:${enabled}`, action: 'set-session-policy',
    expectedVersion: profile.peekProfile(profileId, binding.conversationId).sessionPolicy?.version ?? 0, policy: { useExisting: true, contributeToFuture: enabled } }, profile.profileEpoch(profileId))
  const vote = (answer: ReturnType<typeof publish>, key: string, selected = 'variant:evidence-first') => {
    policy(answer.binding)
    let view = query(answer.binding, answer.messageId)
    commit(answer.binding, { ...base(answer.binding, `prepare:${key}`), action: 'prepare', expectedPolicyVersion: view.policyVersion, messageId: answer.messageId, materialHash: view.comparison!.material!.materialHash })
    view = query(answer.binding, answer.messageId)
    const request: ProductLearningCommand = { ...base(answer.binding, `choose:${key}`), action: 'choose', expectedPolicyVersion: view.policyVersion, messageId: answer.messageId,
      materialHash: view.comparison!.material!.materialHash, probeId: view.comparison!.probe!.probeId, selected, scopeIntent: 'workspace', reasonTags: [] }
    return { request, result: commit(answer.binding, request) }
  }
  return { actor, control, domain, profile, profileId, answers, learning, changes, create, publish, query, base, commit, policy, vote }
}

it('keeps read-only state default-off, accumulates three independent original publications, and preserves earlier null receipts after explicit adoption', async () => {
  const f = await setup(), contexts = ['one', 'two', 'three'].map(f.create), answers = contexts.map((context, index) => f.publish(context, `answer-${index}`))
  expect(f.query(contexts[0]!.binding)).toMatchObject({ settings: { version: 0, enabled: false }, contributionAllowed: false, offers: [] })
  expect(existsSync(f.profile.databasePath(f.profileId))).toBe(false)
  const votes = answers.map((answer, index) => f.vote(answer, `vote-${index}`))
  expect(votes[0]!.result.receipt!.candidateId).toBeNull(); expect(votes[1]!.result.receipt!.candidateId).toBeNull()
  const group = f.query(contexts[2]!.binding).groups.find(group => group.mode === 'explore')!
  expect(group).toMatchObject({ status: 'candidate', counts: { evidenceFirst: 3, conclusionFirst: 0, independentInvestigations: 3 }, candidate: { independentLineageCount: 3, decision: 'pending' } })
  expect(f.profile.currentMemories(f.profileId)).toEqual([]); expect(f.changes).toEqual([])
  expect(f.query(contexts[0]!.binding, answers[0]!.messageId).comparison!.choiceReceipt!.candidateId).toBeNull()
  const review = f.commit(contexts[2]!.binding, { ...f.base(contexts[2]!.binding, 'accept-three'), action: 'review', groupId: group.groupId,
    candidateId: group.candidate!.candidateId, expectedCandidateVersion: group.candidate!.version, expectedGroupDigest: group.digest!, decision: 'accept' })
  expect(review.receipt!.memoryVersionId).toBeTruthy(); expect(f.profile.currentMemories(f.profileId)).toHaveLength(1); expect(f.changes).toEqual([contexts[2]!.binding.conversationId])
  expect(f.learning.operation(f.actor, contexts[0]!.binding.conversationId, votes[0]!.result.operationId)).toEqual(votes[0]!.result)
  expect(f.commit(contexts[0]!.binding, votes[0]!.request)).toEqual(votes[0]!.result)
  expect(() => f.commit(contexts[0]!.binding, { ...votes[0]!.request, reasonTags: ['easier-verification'] } as ProductLearningCommand)).toThrow('complete command')
})

it('keeps opposing original choices visible and makes the whole group unavailable if an original counterexample loses source access', async () => {
  const f = await setup(), contexts = ['one', 'two', 'three', 'counter'].map(f.create)
  const answers = contexts.map((context, index) => f.publish(context, `opposite-${index}`))
  for (const [index, answer] of answers.entries()) f.vote(answer, `opposite-${index}`, index === 3 ? 'variant:answer-first' : 'variant:evidence-first')
  const before = f.query(contexts[0]!.binding).groups.find(group => group.mode === 'explore')!
  expect(before).toMatchObject({ status: 'conflicted', counts: { evidenceFirst: 3, conclusionFirst: 1, independentInvestigations: 4 } })
  const get = f.answers.get.bind(f.answers)
  vi.spyOn(f.answers, 'get').mockImplementation((cid, message) => cid === contexts[3]!.binding.conversationId
    ? { schemaVersion: 1, kind: 'answer-response', conversationId: cid, messageId: message, status: 'unavailable', manifest: null, nativeTextHash: null } : get(cid, message))
  expect(f.query(contexts[0]!.binding).groups.find(group => group.mode === 'explore')).toMatchObject({ status: 'unavailable', counts: null, members: [], candidate: null, digest: null })
  expect(() => f.commit(contexts[0]!.binding, { ...f.base(contexts[0]!.binding, 'forbidden-after-counter'), action: 'review', groupId: before.groupId,
    candidateId: before.candidate!.candidateId, expectedCandidateVersion: before.candidate!.version, expectedGroupDigest: before.digest!, decision: 'accept' })).toThrow()
  expect(f.profile.currentMemories(f.profileId)).toEqual([])
})

it('subscribes only to new completed transitions, requires three completions, persists one invitation and isolates optional failure/close from Answer truth', async () => {
  const f = await setup(), context = f.create('cadence'), first = f.publish(context, 'cadence-one')
  let emit: (receipt: ProductRunReceipt) => void = () => {}
  const unsubscribe = vi.fn(), stop = f.learning.observe(context.binding, { subscribe(listener) { emit = listener; return unsubscribe } })
  f.policy(context.binding)
  f.commit(context.binding, { ...f.base(context.binding, 'enable-hints'), action: 'configure', expectedSettingsVersion: 0, enabled: true })
  emit(first.completed) // A replayed terminal receipt cannot manufacture an invitation.
  expect(f.query(context.binding).offers).toEqual([])
  const second = f.publish(context, 'cadence-two'); emit(second.running); emit(second.completed)
  expect(f.query(context.binding).offers).toEqual([])
  const third = f.publish(context, 'cadence-three'); emit(third.running); emit(third.completed)
  const offer = f.query(context.binding).offers[0]!
  expect(offer.original.messageId).toBe(third.messageId)
  expect(f.query(context.binding).offers).toHaveLength(1)
  const fourth = f.publish(context, 'cadence-four'); emit(fourth.running); emit(fourth.completed); emit(third.completed)
  expect(f.query(context.binding).offers).toHaveLength(1)
  const failure = vi.spyOn(f.profile, 'reserveLearningOffer').mockImplementation(() => { throw new Error('Optional capacity failure') })
  const fifth = f.publish(context, 'cadence-five'); emit(fifth.running); expect(() => emit(fifth.completed)).not.toThrow()
  expect(f.control.get(f.actor, fifth.completed.submissionId).state).toBe('completed'); expect(f.answers.get(context.binding.conversationId, fifth.messageId).status).toBe('available')
  expect(failure).toHaveBeenCalled(); stop(); expect(unsubscribe).toHaveBeenCalledTimes(1)
  f.learning.close(); emit(fifth.running); emit(fifth.completed); expect(failure).toHaveBeenCalledTimes(1)
})
