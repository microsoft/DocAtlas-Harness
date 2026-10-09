import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { DocumentAccessError } from '@docatlas/core'
import type { ProductSubmission, VerifiedSelectionItem, ProductPiCheckpoint } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'
import { SelectionTickets } from '../src/storage/selection-tickets.js'
import { ProductQuestionContexts } from '../src/documents/question-context.js'
import type { ProductAnswers } from '../src/documents/answers.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-question-context-')), actor = { actorId: 'actor:one', workspaceId: 'workspace:one' }
  const control = ControlStore.open(join(root, 'control')), binding = control.createManagedConversation(actor, 'question:context-test').binding
  let now = Date.now(), revoked: string | null = null, visible = true, focusGate: Promise<void> = Promise.resolve()
  const tickets = new SelectionTickets(join(root, 'tickets'), () => now), text = 'The selected source passage.'
  const item: VerifiedSelectionItem = { text, locator: { schemaVersion: 1, locatorId: 'loc:original', documentId: 'doc:one', revisionId: 'rev:one', representationId: 'rep:text', representationContentHash: 'a'.repeat(64), physicalPage: 2,
    selectors: [{ type: 'text-quote', exact: text, normalizedHash: createHash('sha256').update(text).digest('hex') }], createdAt: '2026-09-11T00:00:00Z' } }
  const ticket = tickets.stage(binding, { schemaVersion: 1, kind: 'selection-stage', expectedGeneration: 1, idempotencyKey: 'selection:context-test', proposals: [{ documentId: 'doc:one', revisionId: 'rev:one', physicalPage: 2, quote: text }] }, [item])
  const input: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: 1, idempotencyKey: 'question:context-original', mode: 'prompt', text: 'Explain this.', sourceRefs: [{ documentId: 'doc:one', revisionId: 'rev:one' }], selectionContextIds: [ticket.selectionContextId] }
  const receipt = control.accept(actor, input).receipt
  const original = { documentId: 'doc:one', revisionId: 'rev:one', name: 'Original.pdf', contentHash: 'b'.repeat(64), byteLength: 1024, pageCount: 3 }
  const answers = { binding: (id: string) => control.binding(actor, id), receipts: { publication: () => undefined },
    originalDocument: (id: string) => { if (revoked === id) throw new DocumentAccessError('permission-denied', 'Source revoked'); return { original, source: { representationId: 'rep:text', representationContentHash: 'a'.repeat(64) } } },
    focusLocator: async (_id: string, locator: VerifiedSelectionItem['locator'], authorize: () => void) => { await focusGate; authorize(); return { status: 'resolved' as const, locator, physicalPage: 2, exactText: text, original } },
  } as unknown as ProductAnswers
  const service = new ProductQuestionContexts(control, actor, tickets, answers)
  service.enableHistoricalOrigins({ origins: (_id, entryId) => visible && ['entry:user', 'entry:answer'].includes(entryId) ? [{ binding, entryId, nativeTextHash: 'd'.repeat(64) }] : [], frames: () => [binding] })
  function complete() {
    tickets.bind(binding, input, receipt); tickets.consume(binding, input, receipt)
    const lease = control.acquireWriter(actor, binding.conversationId, 'worker:context')
    let value = control.transition(lease, receipt.submissionId, receipt.version, 'preparing')
    value = control.transition(lease, receipt.submissionId, value.version, 'ready', { prepared: { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId, requestHash: receipt.requestHash, bindingGeneration: 1, scopeVersionId: 'scope:context', sourceRefs: input.sourceRefs, selectionContextIds: input.selectionContextIds } })
    value = control.transition(lease, receipt.submissionId, value.version, 'dispatching'); value = control.transition(lease, receipt.submissionId, value.version, 'running')
    const checkpoint: ProductPiCheckpoint = { schemaVersion: 1, kind: 'pi-checkpoint', submissionId: receipt.submissionId, requestHash: receipt.requestHash, runtimeSessionId: binding.runtimeSessionId,
      userEntryId: 'entry:user', leafEntryId: 'entry:answer', transcriptHash: 'c'.repeat(64), byteLength: 1024, entryCount: 3, settledAt: value.updatedAt }
    control.transition(lease, receipt.submissionId, value.version, 'completed', { checkpoint }); control.releaseWriter(lease)
  }
  return { actor, control, binding, service, ticket, tickets, receipt, input, item, text, complete, advance: () => { now += 86400000 }, revoke: (id: string) => { revoked = id }, hide: () => { visible = false }, gate: (value: Promise<void>) => { focusGate = value },
    close: () => { tickets.close(); control.close(); rmSync(root, { recursive: true, force: true }) } }
}
it('projects accepted and completed input from the same existing ticket without creating another content store', () => {
  const f = fixture()
  try {
    expect(f.service.get(f.binding.conversationId, { kind: 'submission', id: f.receipt.submissionId })).toMatchObject({ status: 'available', selectionState: 'attached', passages: [{ text: f.text }] })
    f.complete(); f.advance()
    for (const id of ['entry:user', 'entry:answer']) expect(f.service.get(f.binding.conversationId, { kind: 'message', id })).toMatchObject({ status: 'available', selectionState: 'consumed', requestHash: f.receipt.requestHash, passages: [{ selectionContextId: f.ticket.selectionContextId, text: f.text, physicalPage: 2 }] })
    expect(f.tickets.get(f.binding, f.ticket.selectionContextId).state).toBe('consumed')
    expect(f.control.publicLeafSubmissionAt(f.actor, f.binding, 'entry:answer')).toBe(f.receipt.submissionId)
    expect(f.control.publicLeafSubmissionAt(f.actor, f.binding, 'entry:unknown')).toBeNull()
  } finally { f.close() }
})
it('keeps exact historical input after rebind but never guesses invisible native entries or revives purged text', () => {
  const f = fixture()
  try {
    f.complete(); f.control.rebind(f.actor, f.binding.conversationId, f.binding.version, 'pi:next', null)
    expect(f.service.get(f.binding.conversationId, { kind: 'message', id: 'entry:user' }).passages[0]!.text).toBe(f.text)
    expect(() => f.service.get(f.binding.conversationId, { kind: 'submission', id: f.receipt.submissionId })).toThrow('this view')
    f.control.purgeRecoveryPayload(f.actor, f.receipt.submissionId)
    expect(f.service.get(f.binding.conversationId, { kind: 'message', id: 'entry:user' })).toMatchObject({ status: 'unavailable', reason: 'purged', passages: [] })
    f.hide(); expect(f.service.get(f.binding.conversationId, { kind: 'message', id: 'entry:answer' })).toMatchObject({ status: 'unavailable', reason: 'history', passages: [] })
  } finally { f.close() }
})
it('requires original and viewing conversation source access, and rejects an unrelated ticket or locator', async () => {
  const f = fixture()
  try {
    f.complete(); const view = f.control.createManagedConversation(f.actor, 'question:inherited-view').binding
    expect(f.service.get(view.conversationId, { kind: 'message', id: 'entry:answer' }).status).toBe('available')
    await expect(f.service.focus(view.conversationId, { kind: 'message', id: 'entry:answer' }, 'selection:unrelated', f.item.locator.locatorId, () => {}, new AbortController().signal)).rejects.toThrow('not part')
    f.revoke(f.binding.conversationId)
    expect(f.service.get(view.conversationId, { kind: 'message', id: 'entry:answer' })).toMatchObject({ status: 'unavailable', reason: 'source', passages: [] })
    f.revoke(view.conversationId)
    expect(f.service.get(view.conversationId, { kind: 'message', id: 'entry:answer' }).passages).toEqual([])
  } finally { f.close() }
})
it('rechecks input and source authorization after asynchronous PDF focus', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  try {
    f.complete(); f.gate(gate.promise)
    const pending = f.service.focus(f.binding.conversationId, { kind: 'message', id: 'entry:user' }, f.ticket.selectionContextId, f.item.locator.locatorId, () => {}, new AbortController().signal)
    f.revoke(f.binding.conversationId); gate.resolve()
    await expect(pending).rejects.toThrow('changed during focus')
  } finally { gate.resolve(); f.close() }
})
