import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot } from '@docatlas/contracts'
import { isLiveLanding, unprojectedCurrentRuns } from '../src/live/LiveApp'

const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: ConversationSnapshot[] }
function empty(): ConversationSnapshot {
  const snapshot = structuredClone(fixtures.valid.find(value => value.kind === 'conversation-snapshot')!)
  snapshot.history = { checkpoint: null, messages: [], hasEarlier: false }; snapshot.runs = []; snapshot.live = []; snapshot.activity = []; snapshot.liveIncomplete = false
  return snapshot
}

describe('live chat-first layout selection', () => {
  it('centers only a loaded empty chat without an explicitly opened Reader', () => {
    expect(isLiveLanding(null, false)).toBe(false)
    expect(isLiveLanding(empty(), false)).toBe(true)
    expect(isLiveLanding(empty(), true)).toBe(false)
  })

  it('never hides history, run receipts, live updates or recovery notices behind the landing state', () => {
    const base = fixtures.valid.find(value => value.kind === 'conversation-snapshot')!
    const mutations: Array<(snapshot: ConversationSnapshot) => void> = [
      value => { value.history.messages = [{ entryId: 'message:saved', role: 'assistant', text: 'Saved history', truncated: false }] },
      value => { value.history.hasEarlier = true },
      value => { value.runs = structuredClone(base.runs) },
      value => { value.live = structuredClone(base.live) },
      value => { value.activity = [{ submissionId: 'submission:one', toolCallId: 'tool:one', toolName: 'read', state: 'running' }] },
      value => { value.liveIncomplete = true },
    ]
    for (const mutate of mutations) { const snapshot = empty(); mutate(snapshot); expect(isLiveLanding(snapshot, false)).toBe(false) }
  })

  it('changes presentation without changing the saved conversation or its checkpoint', () => {
    const snapshot = empty(), before = structuredClone(snapshot)
    isLiveLanding(snapshot, false); isLiveLanding(snapshot, true)
    expect(snapshot).toEqual(before)
  })

  it('keeps old execution receipts out of a newly selected branch without deleting them', () => {
    const snapshot = empty(), base = fixtures.valid.find(value => value.kind === 'conversation-snapshot')!
    snapshot.runs = structuredClone(base.runs)
    snapshot.binding.generation = Math.max(...snapshot.runs.map(run => run.receipt.generation)) + 1
    const before = structuredClone(snapshot)
    expect(unprojectedCurrentRuns(snapshot, new Set())).toEqual([])
    expect(isLiveLanding(snapshot, false)).toBe(true)
    expect(snapshot).toEqual(before)
    const current = { ...snapshot.runs[0]!, receipt: { ...snapshot.runs[0]!.receipt, generation: snapshot.binding.generation } }
    snapshot.runs.push(current)
    expect(unprojectedCurrentRuns(snapshot, new Set())).toEqual([current])
    if (current.receipt.checkpoint) expect(unprojectedCurrentRuns(snapshot, new Set([current.receipt.checkpoint.userEntryId]))).toEqual([])
    expect(isLiveLanding(snapshot, false)).toBe(false)
  })
})
