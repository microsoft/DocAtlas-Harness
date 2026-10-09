import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import type { ProductBinding, ResearchRecallResult, ResearchRecordResult } from '@docatlas/contracts'
import { startDocAtlasApplication } from '../src/application.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('persists an actual isolated Pi research call, reopens normally and recalls it in a new conversation without replaying the model', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'docatlas-research-application-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const model = await createPiTestModel({ answers: [
    { calls: [{ name: 'docatlas_record', args: { kind: 'checkpoint', body: 'Cross-session margin assumptions remain unverified.' } }] }, 'Saved an unverified research checkpoint.',
    { calls: [{ name: 'docatlas_recall', args: { query: 'margin', recordTypes: ['research-note'] } }] }, 'Recalled the prior research lead; it is not source evidence.',
  ] })
  const options = { root: join(directory, 'app'), projectRoot: resolve('.'), webRoot: resolve('apps/web/dist'), port: 0, ...model }
  const first = await startDocAtlasApplication(options); cleanup.push(() => first.close())
  const a = first.control.conversations(first.actor).items[0]!
  const submit = async (app: typeof first, binding: ProductBinding, key: string, text: string) => {
    const runtime = await app.manager.get(app.actor, binding.conversationId)
    const accepted = runtime.coordinator.submit({ schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation,
      idempotencyKey: key, mode: 'prompt', text, sourceRefs: [], selectionContextIds: [] })
    await runtime.coordinator.waitForIdle()
    const snapshot = await runtime.worker.snapshot() as { entries: Array<{ message?: { role: string, toolName?: string, toolCallId?: string, isError?: boolean, details?: unknown } }> }
    expect(app.control.get(app.actor, accepted.receipt.submissionId), JSON.stringify(snapshot)).toMatchObject({ state: 'completed' })
    return { accepted, snapshot }
  }
  const saved = await submit(first, a, 'research:application:record', 'Save this checkpoint using docatlas_record. No document is selected.')
  const tool = saved.snapshot.entries.find(entry => entry.message?.toolName === 'docatlas_record')!.message!
  expect(tool.isError).toBe(false)
  const record = (tool.details as ResearchRecordResult).record
  const provenance = first.documents.research.journal.forRecord(first.actor, record.recordId)!
  expect(provenance).toMatchObject({ nativeToolCallId: tool.toolCallId, wireCallId: record.provenanceCallId, submissionId: saved.accepted.receipt.submissionId, conversationId: a.conversationId })
  expect(first.documents.store.get(a.conversationId).status).toBe('unbound')
  expect(model.getCallCount()).toBe(2)
  await first.close()
  const restored = await startDocAtlasApplication(options); cleanup.push(() => restored.close())
  expect(model.getCallCount()).toBe(2); expect(restored.actor).toEqual(first.actor)
  const b = restored.manager.create(restored.actor, 'research:application:second').binding
  const recalled = await submit(restored, b, 'research:application:recall', 'Recall the prior margin checkpoint using docatlas_recall, without treating it as Evidence.')
  const result = recalled.snapshot.entries.find(entry => entry.message?.toolName === 'docatlas_recall')!.message!
  expect(result.isError).toBe(false)
  expect(result.details as ResearchRecallResult).toMatchObject({ leads: [{ recordId: record.recordId, sourceSessionId: a.conversationId, verificationStatus: 'unverified-lead', sourceState: 'none' }] })
  expect(restored.documents.research.get(b.conversationId, record.recordId)).toMatchObject({ text: 'Cross-session margin assumptions remain unverified.', authoredBy: 'agent' })
  expect(restored.documents.research.journal.forRecord(restored.actor, record.recordId)).toEqual(provenance)
  expect(model.getCallCount()).toBe(4)
}, 60000)
