import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { NoteSave, NoteSaved, NotebookMutation, NotebookUpdated, ProductResearchValue, ProductSelectionTicket, ResearchPolicySet, ResearchSessionPolicy } from '@docatlas/contracts'
import { currentNotebookPending, eligibleNoteTicket, notebookCommandPath, notebookContextCurrent, notebookOwnerKey, notebookReceiptMatches, notebookStorageKey, parseNotebookPending,
  type NotebookOwner, type NotebookPending } from '../src/live/notebook-state'

const { bases } = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-research.json', import.meta.url), 'utf8')) as {
  bases: { save: NoteSave, saved: NoteSaved, mutate: NotebookMutation, updated: NotebookUpdated, policySet: ResearchPolicySet, policy: ResearchSessionPolicy, lineage: ProductResearchValue },
}
const owner: NotebookOwner = { actorId: bases.saved.result.record.createdBy.actorId, workspaceId: bases.saved.result.record.workspaceId,
  conversationId: bases.saved.conversationId, bindingId: 'binding:notebook:one', generation: 1 }
const pending = (): NotebookPending => ({ version: 1, confirmed: true, owner: { ...owner }, command: structuredClone(bases.save) })
function accepts(request: NotebookPending, response: ProductResearchValue): boolean { try { return notebookReceiptMatches(request, response) } catch { return false } }

describe('Notebook confirmed-command outbox and conservative durable receipts', () => {
  it('restores exact user-confirmed commands in a logout-cleared actor/workspace/conversation namespace', () => {
    for (const command of [bases.save, bases.mutate, bases.policySet]) {
      const value: NotebookPending = { ...pending(), command: structuredClone(command) }, wire = JSON.stringify(value)
      expect(parseNotebookPending(wire, owner)).toEqual(value); expect(JSON.stringify(value)).toBe(wire)
      expect(currentNotebookPending(value, owner)).toBe(true)
    }
    expect(parseNotebookPending(null, owner)).toBeNull()
    expect(notebookStorageKey(owner)).toBe('docatlas.live.draft.v1:user%3Anorthstar:workspace%3Anorthstar:@notebook:session%3Anorthstar')
    expect(notebookStorageKey({ ...owner, conversationId: 'session:other' })).not.toBe(notebookStorageKey(owner))
  })

  it('rejects corrupt/unconfirmed/host-only drafts and retains stale generations for explicit reconciliation only', () => {
    const value = pending()
    for (const raw of ['{', JSON.stringify({ ...value, extra: true }), JSON.stringify({ ...value, confirmed: false }), JSON.stringify({ ...value, command: bases.lineage }), 'x'.repeat(65537)]) {
      expect(() => parseNotebookPending(raw, owner)).toThrow()
    }
    for (const field of ['actorId', 'workspaceId', 'conversationId'] as const) expect(() => parseNotebookPending(JSON.stringify(value), { ...owner, [field]: 'foreign:owner' })).toThrow()
    const next = { ...owner, bindingId: 'binding:new', generation: 2 }, retained = parseNotebookPending(JSON.stringify(value), next)!
    expect(retained).toEqual(value); expect(currentNotebookPending(retained, next)).toBe(false)
    const invalid = { ...value, command: { ...value.command, expectedGeneration: 2 } }
    expect(() => parseNotebookPending(JSON.stringify(invalid), owner)).toThrow()
  })

  it('derives fixed route paths from typed commands and never restores an arbitrary client path', () => {
    expect(notebookCommandPath(bases.save)).toBe('notes'); expect(notebookCommandPath(bases.policySet)).toBe('policy')
    expect(notebookCommandPath(bases.mutate)).toBe(`notes/${encodeURIComponent(bases.mutate.recordId)}`)
    const value = pending(); Object.assign(value.command, { path: '/api/private' })
    expect(() => parseNotebookPending(JSON.stringify(value), owner)).toThrow()
  })

  it('uses the shared 4000-character creation limit while preserving the distinct 8000-character edit contract', () => {
    const create = { ...pending(), command: { ...bases.save, body: '文'.repeat(4000) } }
    expect(parseNotebookPending(JSON.stringify(create), owner)).toEqual(create)
    expect(() => parseNotebookPending(JSON.stringify({ ...create, command: { ...create.command, body: '文'.repeat(4001) } }), owner)).toThrow()
    const edit = { ...pending(), command: { ...bases.mutate, action: 'edit' as const, text: '文'.repeat(8000) } }
    expect(parseNotebookPending(JSON.stringify(edit), owner)).toEqual(edit)
  })

  it('clears a saved-note command only for its exact source ticket, text, kind and authenticated author', () => {
    const request = pending()
    expect(accepts(request, bases.saved)).toBe(true)
    expect(accepts(request, { ...bases.saved, result: { ...bases.saved.result, status: 'replayed' } })).toBe(true)
    const variations: Array<(value: NoteSaved) => void> = [
      value => { value.conversationId = 'session:other' },
      value => { value.result.selectionContextId = 'selection:other' },
      value => { value.result.record.workspaceId = 'workspace:other' },
      value => { value.result.record.createdBy.actorId = 'user:other' },
      value => { if (value.result.record.recordType === 'research-note') value.result.record.body = 'Different note' },
      value => { if (value.result.record.recordType === 'research-note') value.result.record.noteKind = 'hypothesis' },
    ]
    for (const mutate of variations) { const response = structuredClone(bases.saved); mutate(response); expect(accepts(request, response)).toBe(false) }
  })

  it('validates edit CAS against canonical full text and distinguishes archive from soft-delete receipts', () => {
    const command: NotebookMutation = { ...bases.mutate, action: 'edit', text: '  Cafe\u0301 — complete body  ' }
    const request: NotebookPending = { ...pending(), command }, response = structuredClone(bases.updated)
    Object.assign(response.result.state, { recordId: command.recordId, workspaceId: owner.workspaceId, text: command.text.normalize('NFC').trim(), updatedBy: { kind: 'user', actorId: owner.actorId } })
    expect(accepts(request, response)).toBe(true)
    expect(accepts(request, { ...response, result: { ...response.result, state: { ...response.result.state, previousVersion: 2, version: 3 } } })).toBe(false)
    expect(accepts(request, { ...response, result: { ...response.result, state: { ...response.result.state, text: 'Only the preview' } } })).toBe(false)
    const { text: _text, ...baseCommand } = command
    const archived: NotebookPending = { ...request, command: { ...baseCommand, action: 'archive' } }
    response.result.state.status = 'archived'; expect(accepts(archived, response)).toBe(true)
    const deleted: NotebookPending = { ...request, command: { ...baseCommand, action: 'delete' } }
    expect(accepts(deleted, response)).toBe(false)
    response.result.state.status = 'deleted'; delete response.result.state.text
    expect(accepts(deleted, response)).toBe(true)
  })

  it('matches two independent research-policy switches and the original idempotent version receipt', () => {
    const request: NotebookPending = { ...pending(), command: structuredClone(bases.policySet) }
    const response: ResearchSessionPolicy = { ...bases.policy, version: 1, recallPriorResearch: true, contributeResearchState: false }
    expect(accepts(request, response)).toBe(true)
    expect(accepts(request, { ...response, version: 2 })).toBe(false)
    expect(accepts(request, { ...response, contributeResearchState: true })).toBe(false)
  })

  it('keeps an uncertain save unchanged across refresh and accepts only a later matching replay', async () => {
    const original = pending(), calls: NotebookPending[] = [], saved = JSON.stringify(original)
    let local: string | null = saved
    const server = async (request: NotebookPending, lost: boolean) => { calls.push(structuredClone(request)); if (lost) throw new TypeError('Response was lost after commit'); return { ...bases.saved, result: { ...bases.saved.result, status: 'replayed' as const } } }
    await expect(server(original, true)).rejects.toThrow('lost')
    const restored = parseNotebookPending(local, owner)!
    expect(local).toBe(saved); expect(calls).toHaveLength(1)
    const receipt = await server(restored, false)
    if (notebookReceiptMatches(restored, receipt)) local = null
    expect(local).toBeNull(); expect(calls).toEqual([original, original])
  })

  it('rejects stale async UI continuations after logout, binding replacement or conversation switch', async () => {
    const expected = notebookOwnerKey(owner), completed = Promise.withResolvers<NoteSaved>()
    let active: NotebookOwner | null = owner, currentEpoch = 1
    const applied = completed.promise.then(() => notebookContextCurrent(expected, active, 1, currentEpoch))
    active = null; currentEpoch++; completed.resolve(bases.saved)
    expect(await applied).toBe(false)
    expect(notebookContextCurrent(expected, { ...owner, conversationId: 'session:other' }, 1, 1)).toBe(false)
    expect(notebookContextCurrent(expected, { ...owner, bindingId: 'binding:other' }, 1, 1)).toBe(false)
    expect(notebookContextCurrent(expected, owner, 1, 1)).toBe(true)
  })

  it('offers only unbound current staged tickets without consuming or mutating the question selections', () => {
    const values = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document-http.json', import.meta.url), 'utf8')) as { valid: ProductSelectionTicket[] }
    const ticket = structuredClone(values.valid.find(value => value.kind === 'selection-ticket')!)
    Object.assign(ticket, { ...owner, state: 'staged', submissionId: null, expiresAt: '2030-01-01T00:00:00Z' })
    const before = structuredClone(ticket), now = Date.parse('2026-09-09T00:00:00Z')
    expect(eligibleNoteTicket(ticket, owner, now)).toBe(true)
    expect(eligibleNoteTicket({ ...ticket, submissionId: 'submission:bound' }, owner, now)).toBe(false)
    expect(eligibleNoteTicket({ ...ticket, state: 'consumed' }, owner, now)).toBe(false)
    expect(eligibleNoteTicket({ ...ticket, generation: 2 }, owner, now)).toBe(false)
    expect(eligibleNoteTicket({ ...ticket, expiresAt: '2020-01-01T00:00:00Z' }, owner, now)).toBe(false)
    expect(ticket).toEqual(before)
  })
})
