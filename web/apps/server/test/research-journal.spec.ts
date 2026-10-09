import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { enrichmentHash } from '@docatlas/core'
import type { ResearchCallProvenance, ResearchPolicySet } from '@docatlas/contracts'
import { ControlStore } from '../src/storage/control-store.js'
import { ResearchJournal } from '../src/storage/research-journal.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-research-journal-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const actor = { actorId: 'actor:research-journal', workspaceId: 'workspace:research-journal' }
  const binding = control.createManagedConversation(actor, 'research:journal:conversation').binding
  const other = control.createManagedConversation(actor, 'research:journal:another').binding
  let journal = new ResearchJournal(join(root, 'research')); cleanup.push(() => journal.close())
  const nativeToolCallId = 'call_native|fc_native', digest = enrichmentHash([binding.workspaceId, binding.conversationId, binding.runtimeSessionId, 'submission:research', nativeToolCallId])
  const call: ResearchCallProvenance = { schemaVersion: 1, kind: 'research-call-provenance', workspaceId: binding.workspaceId, actorId: binding.ownerActorId, conversationId: binding.conversationId,
    runtimeSessionId: binding.runtimeSessionId, submissionId: 'submission:research', bindingId: binding.bindingId, generation: binding.generation, investigationId: 'investigation:research', scopeVersionId: 'scope:research',
    nativeToolCallId, wireCallId: `call:research:${digest}`, idempotencyKey: `research:record:${digest}`, requestHash: 'a'.repeat(64), recordId: null }
  const command: ResearchPolicySet = { schemaVersion: 1, kind: 'research-policy-set', expectedGeneration: binding.generation, idempotencyKey: 'research:policy:first', expectedVersion: 0,
    recallPriorResearch: false, contributeResearchState: true }
  const tamper = (fn: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(root, 'research/research-control.sqlite3')); try { fn(db) } finally { db.close() } }
  return { root, actor, binding, other, call, command, tamper, get journal() { return journal }, reopen: () => { journal.close(); journal = new ResearchJournal(join(root, 'research')) } }
}

it('persists native-call provenance without text, resumes a pending commit and links one immutable record id', () => {
  const f = fixture(), pending = f.journal.begin(f.binding, f.call)
  expect(pending).toEqual(f.call); expect(f.journal.forRecord(f.actor, 'note:research')).toBeUndefined()
  f.reopen(); expect(f.journal.begin(f.binding, f.call)).toEqual(pending)
  f.journal.complete(f.binding, pending, 'note:research'); f.reopen()
  expect(f.journal.begin(f.binding, f.call)).toEqual({ ...pending, recordId: 'note:research' })
  expect(f.journal.forRecord(f.actor, 'note:research')).toMatchObject({ nativeToolCallId: 'call_native|fc_native', wireCallId: f.call.wireCallId, submissionId: f.call.submissionId })
  f.journal.complete(f.binding, pending, 'note:research')
  expect(() => f.journal.complete(f.binding, pending, 'note:another')).toThrow('lineage')
  expect(() => f.journal.begin(f.binding, { ...f.call, requestHash: 'b'.repeat(64) })).toThrow('different input')
  expect(() => f.journal.begin(f.binding, { ...f.call, scopeVersionId: 'scope:changed' })).toThrow('different input')
  expect(() => f.journal.begin(f.binding, { ...f.call, body: 'Research text belongs only in Core' } as ResearchCallProvenance)).toThrow()
})

it('requires the complete owner/conversation/runtime/generation binding at both begin and completion', () => {
  const f = fixture(), pending = f.journal.begin(f.binding, f.call)
  for (const binding of [f.other, { ...f.binding, ownerActorId: 'actor:foreign' }, { ...f.binding, workspaceId: 'workspace:foreign' },
    { ...f.binding, generation: f.binding.generation + 1 }, { ...f.binding, runtimeSessionId: f.other.runtimeSessionId }, { ...f.binding, bindingId: f.other.bindingId }]) {
    expect(() => f.journal.begin(binding, f.call)).toThrow('binding')
    expect(() => f.journal.complete(binding, pending, 'note:foreign')).toThrow('binding')
  }
  f.journal.complete(f.binding, pending, 'note:research')
  expect(f.journal.forRecord({ ...f.actor, actorId: 'actor:foreign' }, 'note:research')).toBeUndefined()
  expect(f.journal.forRecord({ ...f.actor, workspaceId: 'workspace:foreign' }, 'note:research')).toBeUndefined()
})

it('keeps recall and contribution as separate CAS-controlled consent switches with immutable retries', () => {
  const f = fixture()
  expect(f.journal.policy(f.binding)).toMatchObject({ version: 0, recallPriorResearch: true, contributeResearchState: true })
  const first = f.journal.setPolicy(f.binding, f.command)
  expect(first).toMatchObject({ version: 1, recallPriorResearch: false, contributeResearchState: true })
  const second = f.journal.setPolicy(f.binding, { ...f.command, idempotencyKey: 'research:policy:second', expectedVersion: 1, recallPriorResearch: true, contributeResearchState: false })
  f.reopen()
  expect(f.journal.setPolicy(f.binding, f.command)).toEqual(first); expect(f.journal.policy(f.binding)).toEqual(second)
  expect(f.journal.policy(f.other)).toMatchObject({ version: 0, recallPriorResearch: true, contributeResearchState: true })
  expect(() => f.journal.setPolicy(f.binding, { ...f.command, contributeResearchState: false })).toThrow('key')
  expect(() => f.journal.setPolicy(f.binding, { ...f.command, idempotencyKey: 'research:policy:stale' })).toThrow('refresh')
  expect(() => f.journal.setPolicy(f.binding, { ...f.command, expectedGeneration: f.binding.generation + 1 })).toThrow('generation')
})

it.each(['call-seal', 'call-owner', 'call-column', 'policy-seal', 'policy-conversation', 'command-hash'])('detects durable %s tampering', variant => {
  const f = fixture(), pending = f.journal.begin(f.binding, f.call); f.journal.complete(f.binding, pending, 'note:research'); f.journal.setPolicy(f.binding, f.command)
  f.tamper(db => {
    if (variant === 'call-seal') db.prepare('UPDATE calls SET seal=?').run('f'.repeat(64))
    if (variant === 'call-owner') { const value = { ...f.call, actorId: 'actor:forged', recordId: 'note:research' }; db.prepare('UPDATE calls SET body=?,seal=?').run(JSON.stringify(value), enrichmentHash(value)) }
    if (variant === 'call-column') db.prepare('UPDATE calls SET record=?').run('note:renamed')
    if (variant === 'policy-seal') db.prepare('UPDATE policies SET seal=?').run('f'.repeat(64))
    if (variant === 'policy-conversation') { const value = { ...f.journal.policy(f.binding), conversationId: f.other.conversationId }; db.prepare('UPDATE policies SET body=?,seal=?').run(JSON.stringify(value), enrichmentHash(value)) }
    if (variant === 'command-hash') db.prepare('UPDATE policy_commands SET request_hash=?').run('f'.repeat(64))
  })
  if (variant.startsWith('call-')) expect(() => f.journal.forRecord(f.actor, variant === 'call-column' ? 'note:renamed' : 'note:research')).toThrow()
  else if (variant === 'command-hash') expect(() => f.journal.setPolicy(f.binding, f.command)).toThrow('key')
  else expect(() => f.journal.policy(f.binding)).toThrow()
})
